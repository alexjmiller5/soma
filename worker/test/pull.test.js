import { expect, test } from "bun:test";
import worker, { ROUTES } from "../src/index.js";
import { D1Shim } from "./d1shim.js";
import { ensureReceiptStorage } from "../src/governance-store.js";

const STAMP = "2026-01-02T00:00:00.000Z";
const OLD = "2026-01-01T00:00:00.000Z";

async function seed() {
  const db = new D1Shim();
  await db.prepare(`CREATE TABLE records (
    id TEXT PRIMARY KEY, label TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT
  )`).run();
  // Insertion order differs from id order; equal arrival times cross pages.
  for (const [id, hubAt, deletedAt] of [
    ["d", STAMP, STAMP], ["b", STAMP, null], ["0", null, null],
    ["z", OLD, null], ["c", STAMP, null], ["a", STAMP, null],
  ]) {
    await db.prepare("INSERT INTO records VALUES (?, ?, ?, ?, ?)")
      .bind(id, `record-${id}`, OLD, deletedAt, hubAt).run();
  }
  return db;
}

function pull(db, body = {}) {
  return worker.fetch(new Request("https://hub.test/v1/rows/pull", {
    method: "POST",
    headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
    body: JSON.stringify({ table: "records", columns: ["id"], since: "", ...body }),
  }), { DB: db, HUB_TOKEN: "test" }, { waitUntil() {} });
}

test("pull pages split equal hub_at boundaries without losing tombstones", async () => {
  const db = await seed();
  const body = { since: STAMP, columns: ["id", "deleted_at"], limit: 2 };
  const first = await pull(db, body);
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({
    rows: [{ id: "a", deleted_at: null }, { id: "b", deleted_at: null }], next_cursor: "b",
  });
  expect(await (await pull(db, { ...body, after: "b" })).json()).toEqual({
    rows: [{ id: "c", deleted_at: null }, { id: "d", deleted_at: STAMP }], next_cursor: "d",
  });
  expect(await (await pull(db, { ...body, after: "d" })).json()).toEqual({
    rows: [], next_cursor: null,
  });
});

test("full pull pages include null hub_at and still advance strictly by id", async () => {
  const db = await seed();
  expect(await (await pull(db, { limit: 2 })).json()).toEqual({
    rows: [{ id: "0" }, { id: "a" }], next_cursor: "a",
  });
  expect(await (await pull(db, { limit: 2, after: "a" })).json()).toEqual({
    rows: [{ id: "b" }, { id: "c" }], next_cursor: "c",
  });
  expect(await (await pull(db, { limit: 2, after: "c" })).json()).toEqual({
    rows: [{ id: "d" }, { id: "z" }], next_cursor: "z",
  });
});

test("pull cursor survives an omitted id without leaking it into projected rows", async () => {
  const db = await seed();
  const body = { since: STAMP, columns: ["label"], limit: 3 };
  expect(await (await pull(db, body)).json()).toEqual({
    rows: [{ label: "record-a" }, { label: "record-b" }, { label: "record-c" }], next_cursor: "c",
  });
  expect(await (await pull(db, { ...body, after: "c" })).json()).toEqual({
    rows: [{ label: "record-d" }], next_cursor: null,
  });
});

test("pull binds arbitrary string cursors and accepts the minimum limit", async () => {
  const db = await seed();
  const after = "b' OR 1=1 --";
  await db.prepare("INSERT INTO records (id, label, hub_at) VALUES (?, ?, ?)")
    .bind(after, "quoted-id", STAMP).run();
  expect(await (await pull(db, { limit: 1, after: "b" })).json()).toEqual({
    rows: [{ id: after }], next_cursor: after,
  });
  expect(await (await pull(db, { limit: 1, after })).json()).toEqual({
    rows: [{ id: "c" }], next_cursor: "c",
  });
  expect(await (await pull(db, { limit: 1, after: "" })).json()).toEqual({
    rows: [{ id: "0" }], next_cursor: "0",
  });
});

test("paginated pull keeps the strict updated_at fallback on legacy tables", async () => {
  const db = await seed();
  await db.prepare("ALTER TABLE records DROP COLUMN hub_at").run();
  await db.prepare("UPDATE records SET updated_at = ? WHERE id IN ('b', 'd')").bind(STAMP).run();
  expect(await (await pull(db, { since: OLD, limit: 1 })).json()).toEqual({
    rows: [{ id: "b" }], next_cursor: "b",
  });
  expect(await (await pull(db, { since: OLD, limit: 1, after: "b" })).json()).toEqual({
    rows: [{ id: "d" }], next_cursor: "d",
  });
  expect(await (await pull(db, { since: STAMP, limit: 1 })).json()).toEqual({
    rows: [], next_cursor: null,
  });
  expect(await (await pull(db, { since: OLD, after: {} })).json()).toEqual({
    rows: [{ id: "d" }, { id: "b" }],
  });
});

test("limit 200 bounds pages while requests without limit keep complete legacy responses", async () => {
  const db = await seed();
  for (let i = 0; i < 201; i++) {
    await db.prepare("INSERT INTO records (id, hub_at) VALUES (?, ?)")
      .bind(`r${String(i).padStart(3, "0")}`, STAMP).run();
  }
  const first = await (await pull(db, { limit: 200 })).json();
  expect(first.rows).toHaveLength(200);
  expect(first.rows[0]).toEqual({ id: "0" });
  expect(first.next_cursor).toBe("r194");
  expect(await (await pull(db, { limit: 200, after: first.next_cursor })).json()).toEqual({
    rows: ["r195", "r196", "r197", "r198", "r199", "r200", "z"].map(id => ({ id })),
    next_cursor: null,
  });
  for (const after of [undefined, "z", null, {}]) {
    const legacy = await pull(db, { after });
    expect(legacy.status).toBe(200);
    const out = await legacy.json();
    expect(Object.keys(out)).toEqual(["rows"]);
    expect(out.rows).toHaveLength(207);
  }
});

for (const limit of [0, -1, 201, 1.5, "2", null, true, [], {}]) {
  test(`pull rejects invalid limit ${JSON.stringify(limit)} with JSON 400`, async () => {
    const response = await pull(await seed(), { limit });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toEqual(expect.any(String));
  });
}

for (const after of [null, 1, true, [], {}]) {
  test(`paginated pull rejects non-string after ${JSON.stringify(after)} with JSON 400`, async () => {
    const response = await pull(await seed(), { limit: 2, after });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toEqual(expect.any(String));
  });
}

test("where narrows a pull to matching rows and rejects non-scalar filters", async () => {
  const db = await seed();
  const rows = await (await pull(db, { columns: ["id", "label"], where: { label: "record-b" } })).json();
  expect(rows).toEqual({ rows: [{ id: "b", label: "record-b" }] });
  const paged = await (await pull(db, { limit: 5, where: { deleted_at: STAMP } })).json();
  expect(paged).toEqual({ rows: [{ id: "d" }], next_cursor: null });
  expect((await pull(db, { where: { label: ["record-b"] } })).status).toBe(400);
  expect((await pull(db, { where: { "label; drop": "x" } })).status).not.toBe(200);
});

// Every sync round runs a cursor read and a pull per table. Without an index
// on hub_at both scan every row of every table on every poll, and D1 bills
// rows read - so the hub owns a hub_at index per table (unlogged, like the
// engine indexes) and the incremental pull must actually use it.
function capturing(db) {
  const seen = [];
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const stmt = prepare(sql);
    const bind = stmt.bind.bind(stmt);
    stmt.bind = (...args) => { seen.push({ sql, args }); return bind(...args); };
    return stmt;
  };
  return seen;
}

async function plan(db, { sql, args }) {
  const { results } = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all();
  return results.map((r) => r.detail).join("; ");
}

test("cursor creates a hub_at index on every user table with the column", async () => {
  const db = await seed();
  await db.prepare("CREATE TABLE legacy (id TEXT PRIMARY KEY, updated_at TEXT)").run();
  const indexes = async () => (await db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' AND tbl_name NOT GLOB '_*' ORDER BY name"
  ).all()).results.map((r) => r.name);
  expect(await indexes()).toEqual([]);
  await ROUTES["/v1/cursor"]({ tables: ["records", "legacy"] }, db);
  expect(await indexes()).toEqual(["records_hub_at"]);
  expect(await plan(db, { sql: "SELECT max(hub_at) FROM records", args: [] })).toContain("COVERING INDEX records_hub_at");
  // a table that arrives later through schema replay is indexed on the next round
  const replay = await worker.fetch(new Request("https://hub.test/v1/schema/push", {
    method: "POST",
    headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
    body: JSON.stringify({ entries: [{ applied_at: STAMP, ddl: "CREATE TABLE later (id TEXT PRIMARY KEY, hub_at TEXT)" }] }),
  }), { DB: db, HUB_TOKEN: "test" }, { waitUntil() {} });
  expect(await replay.json()).toEqual({ applied: 1 });
  await ROUTES["/v1/cursor"]({ tables: ["later"] }, db);
  expect(await indexes()).toEqual(["later_hub_at", "records_hub_at"]);
});

test("incremental paginated pull reads through the hub_at index, full pull pages by id", async () => {
  const db = await seed();
  await ROUTES["/v1/cursor"]({ tables: ["records"] }, db);
  const seen = capturing(db);
  expect(await (await pull(db, { since: STAMP, limit: 2, after: "b" })).json()).toEqual({
    rows: [{ id: "c" }, { id: "d" }], next_cursor: "d",
  });
  const incremental = await plan(db, seen.at(-1));
  expect(incremental).toContain("USING INDEX records_hub_at");
  expect(incremental).not.toContain("sqlite_autoindex");
  expect(await (await pull(db, { limit: 2, after: "a" })).json()).toEqual({
    rows: [{ id: "b" }, { id: "c" }], next_cursor: "c",
  });
  expect(await plan(db, seen.at(-1))).toContain("sqlite_autoindex_records_1 (id>?)");
});

// A cold replica is mostly many small tables, and every request pays the hub's
// fixed cost, so one request may carry many table pages (`batch`). Each page
// is exactly what its own paginated pull returns.
async function batchSeed() {
  const db = await seed();
  await db.prepare("CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT)").run();
  for (const id of ["n1", "n2", "n3"]) {
    await db.prepare("INSERT INTO notes VALUES (?, ?, ?, NULL, ?)").bind(id, `body-${id}`, OLD, STAMP).run();
  }
  return db;
}
const batchPull = (db, batch) => pull(db, { table: undefined, columns: undefined, since: undefined, batch });

test("a batch answers several table pages in one request, each as its own pull would", async () => {
  const db = await batchSeed();
  const items = [
    { table: "records", columns: ["id", "label"], since: "", limit: 2 },
    { table: "records", columns: ["label"], since: STAMP, limit: 2, after: "b" },
    { table: "notes", columns: ["id", "body"], since: "", limit: 5 },
    { table: "notes", columns: ["id"], since: STAMP, limit: 3 },
  ];
  const response = await batchPull(db, items);
  expect(response.status).toBe(200);
  const singles = [];
  for (const item of items) singles.push(await (await pull(db, item)).json());
  expect(await response.json()).toEqual({ batch: singles });
  expect(singles[3]).toEqual({ rows: [{ id: "n1" }, { id: "n2" }, { id: "n3" }], next_cursor: "n3" });
});

test("cursor advertises the batch limits", async () => {
  const out = await ROUTES["/v1/cursor"]({ tables: ["records"] }, await seed());
  expect(out.pull_batch).toEqual({ items: 50, rows: 5000, bytes: 4 * 1024 * 1024 });
});

for (const [name, batch] of [
  ["an empty batch", []],
  ["a batch that is not a list", { table: "records" }],
  ["more than 50 pulls", Array.from({ length: 51 }, () => ({ table: "records", columns: ["id"], since: "", limit: 1 }))],
  ["more than 5000 rows in total", [{ table: "records", columns: ["id"], since: "", limit: 4000 }, { table: "notes", columns: ["id"], since: "", limit: 1001 }]],
  ["a pull without a limit", [{ table: "records", columns: ["id"], since: "" }]],
  ["a zero limit", [{ table: "records", columns: ["id"], since: "", limit: 0 }]],
  ["a non-string after", [{ table: "records", columns: ["id"], since: "", limit: 1, after: 1 }]],
  ["a missing table", [{ columns: ["id"], since: "", limit: 1 }]],
  ["a non-string since", [{ table: "records", columns: ["id"], since: null, limit: 1 }]],
  ["a non-list of columns", [{ table: "records", columns: "id", since: "", limit: 1 }]],
]) test(`a batch rejects ${name} with JSON 400`, async () => {
  const response = await batchPull(await batchSeed(), batch);
  expect(response.status).toBe(400);
  expect((await response.json()).error).toEqual(expect.any(String));
});

for (const table of ["_governance_receipts", "sqlite_master"]) test(`a batch cannot address private state: ${table}`, async () => {
  const db = await batchSeed();
  await ensureReceiptStorage(db); // genuine service-owned storage
  const response = await batchPull(db, [
    { table: "records", columns: ["id"], since: "", limit: 1 },
    { table, columns: ["receipt_key"], since: "", limit: 1 },
  ]);
  expect(response.status).toBe(403);
});

test("a batch stops at the byte budget after at least one row and resumes from the last row sent", async () => {
  const db = await batchSeed();
  await db.prepare("CREATE TABLE blobs (id TEXT PRIMARY KEY, body TEXT, hub_at TEXT)").run();
  const big = "x".repeat(1_500_000);
  for (const id of ["b1", "b2", "b3", "b4"]) await db.prepare("INSERT INTO blobs VALUES (?, ?, ?)").bind(id, big, STAMP).run();
  const items = [
    { table: "notes", columns: ["id"], since: "", limit: 5 },
    { table: "blobs", columns: ["body"], since: "", limit: 10 },
    { table: "records", columns: ["id"], since: "", limit: 10 },
  ];
  const first = await (await batchPull(db, items)).json();
  expect(first.batch).toHaveLength(2); // records waits for the next request
  expect(first.batch[1].rows).toHaveLength(2);
  expect(first.batch[1].next_cursor).toBe("b2");
  const second = await (await batchPull(db, [{ ...items[1], after: "b2" }, items[2]])).json();
  expect(second.batch[0]).toEqual({ rows: [{ body: big }, { body: big }], next_cursor: null });
  expect(second.batch[1].next_cursor).toBeNull();
  // A single row over the budget still makes progress.
  await db.prepare("INSERT INTO blobs VALUES ('b0', ?, ?)").bind("y".repeat(5_000_000), STAMP).run();
  const alone = await (await batchPull(db, [{ table: "blobs", columns: ["id"], since: "", limit: 1 }, items[2]])).json();
  expect(alone.batch).toEqual([{ rows: [{ id: "b0" }], next_cursor: "b0" }, { rows: expect.any(Array), next_cursor: null }]);
  const huge = await (await batchPull(db, [{ table: "blobs", columns: ["body"], since: "", limit: 1 }, items[2]])).json();
  expect(huge.batch).toHaveLength(1);
  expect(huge.batch[0].next_cursor).toBe("b0");
});

test("provenance slice pages use filter and cursor indexes without sorting full slices", async () => {
  const db = await seed();
  await db.prepare("CREATE TABLE provenance (id TEXT PRIMARY KEY,to_kind TEXT,to_ref TEXT,field TEXT,rel TEXT,asserted_by TEXT,updated_at TEXT,hub_at TEXT)").run();
  await db.prepare("CREATE INDEX provenance_to ON provenance(to_kind,to_ref,field)").run();
  for (const id of ["b", "a", "c"]) {
    await db.prepare("INSERT INTO provenance (id,to_kind,rel,asserted_by,updated_at,hub_at) VALUES (?,'songs','evidence_of','reader',?,?)")
      .bind(id, OLD, STAMP).run();
  }
  const seen = capturing(db);
  const body = {
    table: "provenance", columns: ["id"],
    where: { to_kind: "songs", rel: "evidence_of", asserted_by: "reader" }, limit: 2,
  };
  expect(await ROUTES["/v1/rows/pull"](body, db)).toEqual({
    rows: [{ id: "a" }, { id: "b" }], next_cursor: "b",
  });
  let query = seen.find(r => /^SELECT .* FROM "provenance" WHERE/.test(r.sql));
  const full = await plan(db, query);
  expect(full).toContain("provenance_slice_id");
  expect(full).not.toContain("TEMP B-TREE");
  seen.length = 0;
  await ROUTES["/v1/rows/pull"]({ ...body, since: STAMP, after: "a" }, db);
  query = seen.find(r => /^SELECT .* FROM "provenance" WHERE/.test(r.sql));
  expect(await plan(db, query)).toContain("provenance_slice_hub_at");
});

test("record-specific provenance pulls seek the target and retain ID paging", async () => {
  const db = await seed();
  await db.prepare("CREATE TABLE provenance (id TEXT PRIMARY KEY,to_kind TEXT,to_ref TEXT,rel TEXT,asserted_by TEXT,hub_at TEXT)").run();
  const seen = capturing(db);
  await ROUTES["/v1/rows/pull"]({
    table:"provenance",columns:["id"],
    where:{to_kind:"songs",to_ref:"recording",rel:"evidence_of",asserted_by:"reader"},
    limit:200,
  },db);
  const query=seen.find(r=>/^SELECT .* FROM "provenance" WHERE/.test(r.sql));
  const detail=await plan(db,query);
  expect(detail).toContain("provenance_target_id (to_kind=? AND to_ref=? AND rel=? AND asserted_by=?)");
  expect(detail).not.toContain("TEMP B-TREE");
});
