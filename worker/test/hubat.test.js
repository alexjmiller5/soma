// The pull cursor is HUB arrival time, not a client stamp: the hub assigns
// hub_at on every write it makes, and pulls/cursors read it.
import { expect, test } from "bun:test";
import { D1Shim } from "./d1shim.js";
import { LimitedD1 } from "./limited-d1.js";
import { deriveRows } from "../src/derive.js";
import { ROUTES } from "../src/index.js";

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const ENV = { DERIVATIONS: JSON.stringify({ blurb: { url: "https://derivations.example/blurb" } }) };

async function seed(db) {
  for (const sql of [
    `CREATE TABLE catalog_properties (id TEXT PRIMARY KEY, tbl TEXT, col TEXT, label TEXT, sort INTEGER, type TEXT, required INTEGER, default_value TEXT, options TEXT, options_sql TEXT, min_items INTEGER, max_items INTEGER, pattern TEXT, ref_table TEXT, derived_by TEXT, inputs TEXT, immutable INTEGER, deprecated INTEGER, description TEXT, source TEXT, source_ref TEXT, created_at TEXT DEFAULT (${NOW}), updated_at TEXT DEFAULT (${NOW}), deleted_at TEXT, hub_at TEXT)`,
    `CREATE TABLE provenance (id TEXT PRIMARY KEY, from_kind TEXT, from_ref TEXT, to_kind TEXT, to_ref TEXT, rel TEXT, field TEXT, detail TEXT, asserted_by TEXT, inputs_hash TEXT, value_hash TEXT, produced_at TEXT, created_at TEXT DEFAULT (${NOW}), updated_at TEXT DEFAULT (${NOW}), deleted_at TEXT, hub_at TEXT)`,
    `CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT, blurb TEXT, created_at TEXT DEFAULT (${NOW}), updated_at TEXT DEFAULT (${NOW}), deleted_at TEXT, hub_at TEXT)`,
    `INSERT INTO catalog_properties (id, tbl, col, sort, type) VALUES ('people.name','people','name',1,'text')`,
    `INSERT INTO catalog_properties (id, tbl, col, sort, type, derived_by, inputs) VALUES ('people.blurb','people','blurb',2,'text','http:blurb','["name"]')`,
  ])
    await db.prepare(sql).run();
  return db;
}

const cols = ["id", "name", "blurb", "updated_at", "hub_at"];
const row = (o) => ({ id: "a", name: "Ada", blurb: null, updated_at: "2026-09-04T00:00:00.000Z", hub_at: null, ...o });

test("push stamps hub_at on its own clock and reports it", async () => {
  const db = await seed(new D1Shim());
  const out = await ROUTES["/v1/rows/push"]({ table: "people", columns: cols, rows: [row({ hub_at: "1970" })] }, db);
  expect(out.upserted).toBe(1);
  expect(out.hub_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  const stored = await db.prepare("SELECT hub_at FROM people WHERE id = 'a'").first();
  expect(stored.hub_at).toBe(out.hub_at); // the client's "1970" was overwritten

  // an UPDATE through the LWW guard re-stamps too
  const later = await ROUTES["/v1/rows/push"](
    { table: "people", columns: cols, rows: [row({ name: "Grace", updated_at: "2026-09-05T00:00:00.000Z" })] },
    db
  );
  const after = await db.prepare("SELECT name, hub_at FROM people WHERE id = 'a'").first();
  expect(after.name).toBe("Grace");
  expect(after.hub_at).toBe(later.hub_at);
  expect(later.hub_at >= out.hub_at).toBe(true);
});

test("pull filters by hub_at, and since='' includes NULL hub_at rows", async () => {
  const db = await seed(new D1Shim());
  await db.prepare("INSERT INTO people (id, name, updated_at) VALUES ('old','Legacy','2026-01-01T00:00:00.000Z')").run();
  const push = await ROUTES["/v1/rows/push"]({ table: "people", columns: cols, rows: [row()] }, db);

  const all = await ROUTES["/v1/rows/pull"]({ table: "people", columns: cols, since: "" }, db);
  expect(all.rows.map((r) => r.id).sort()).toEqual(["a", "old"]);

  // the boundary is INCLUSIVE: a row stamped in the same millisecond as a
  // cursor read comes back rather than being lost
  const boundary = await ROUTES["/v1/rows/pull"]({ table: "people", columns: cols, since: push.hub_at }, db);
  expect(boundary.rows.map((r) => r.id)).toEqual(["a"]);
  const past = await ROUTES["/v1/rows/pull"]({ table: "people", columns: cols, since: "2099" }, db);
  expect(past.rows).toEqual([]);

  const earlier = await ROUTES["/v1/rows/pull"]({ table: "people", columns: cols, since: "2020" }, db);
  expect(earlier.rows.map((r) => r.id)).toEqual(["a"]); // NULL hub_at is older than everything
});

test("cursor is max(hub_at)", async () => {
  const db = await seed(new D1Shim());
  expect((await ROUTES["/v1/cursor"]({ tables: ["people"] }, db)).max_hub_at).toBe("");
  const push = await ROUTES["/v1/rows/push"]({ table: "people", columns: cols, rows: [row()] }, db);
  expect((await ROUTES["/v1/cursor"]({ tables: ["people", "provenance"] }, db)).max_hub_at).toBe(push.hub_at);
});

test("a hub-side derivation stamps hub_at so replicas pull it", async () => {
  const db = await seed(new D1Shim());
  const push = await ROUTES["/v1/rows/push"]({ table: "people", columns: cols, rows: [row()] }, db);
  const fetchImpl = async () => new Response(JSON.stringify({ blurb: "about Ada" }));
  const out = await deriveRows(db, ENV, "people", ["a"], { fetchImpl });
  expect(out.derived).toBe(1);
  const after = await db.prepare("SELECT blurb, hub_at FROM people WHERE id = 'a'").first();
  expect(after.blurb).toBe("about Ada");
  expect(after.hub_at >= push.hub_at).toBe(true);
  const seen = await ROUTES["/v1/rows/pull"]({ table: "people", columns: cols, since: push.hub_at }, db);
  expect(seen.rows.map((r) => r.id)).toEqual(["a"]);
});

test("the hub stamps from its own schema, not the pushed column list", async () => {
  const db = await seed(new D1Shim());
  // an un-upgraded client: hub_at is nowhere in `columns`
  const old = ["id", "name", "blurb", "updated_at"];
  const out = await ROUTES["/v1/rows/push"]({ table: "people", columns: old, rows: [row()] }, db);
  expect(out.upserted).toBe(1);
  expect(out.hub_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  const stored = await db.prepare("SELECT hub_at FROM people WHERE id = 'a'").first();
  expect(stored.hub_at).toBe(out.hub_at);
  // ... so a replica whose cursor has moved on still sees the row
  const seen = await ROUTES["/v1/rows/pull"]({ table: "people", columns: cols, since: out.hub_at }, db);
  expect(seen.rows.map((r) => r.id)).toEqual(["a"]);
});

test("cursor and pull fall back to updated_at on a table without hub_at", async () => {
  const db = await seed(new D1Shim());
  await db.prepare(`CREATE TABLE legacy (id TEXT PRIMARY KEY, name TEXT, updated_at TEXT)`).run();
  await db.prepare("INSERT INTO legacy VALUES ('a','Ada','2026-01-01T00:00:00.000Z')").run();
  await db.prepare("INSERT INTO legacy VALUES ('g','Grace','2026-02-01T00:00:00.000Z')").run();
  const lcols = ["id", "name", "updated_at"];
  expect((await ROUTES["/v1/cursor"]({ tables: ["legacy"] }, db)).max_hub_at).toBe("2026-02-01T00:00:00.000Z");
  expect((await ROUTES["/v1/rows/pull"]({ table: "legacy", columns: lcols, since: "" }, db)).rows.length).toBe(2);
  const some = await ROUTES["/v1/rows/pull"]({ table: "legacy", columns: lcols, since: "2026-01-15T00:00:00.000Z" }, db);
  expect(some.rows.map((r) => r.id)).toEqual(["g"]);
  // and a push into it still works, unstamped
  const out = await ROUTES["/v1/rows/push"](
    { table: "legacy", columns: lcols, rows: [{ id: "n", name: "New", updated_at: "2026-03-01T00:00:00.000Z" }] },
    db
  );
  expect(out.upserted).toBe(1);
  expect(out.hub_at).toBe("");
});

test("cursor keeps the legacy max_updated_at key equal to max_hub_at for pre-hub_at clients", async () => {
  const db = new D1Shim();
  await seed(db);
  const push = await ROUTES["/v1/rows/push"]({ table: "people", columns: cols, rows: [row({ id: "a" })] }, db);
  const c = await ROUTES["/v1/cursor"]({ tables: ["people"] }, db);
  expect(c.max_updated_at).toBe(c.max_hub_at);
  expect(c.max_hub_at).toBe(push.hub_at);
});

// Drive the SQL clock at statement execution, including SQL prepared before
// an awaited batch. No elapsed-time sleeps determine these interleavings.
class ClockDB extends D1Shim {
  now = '2026-01-01T00:00:00.000Z';
  prepare(sql) {
    let args = [];
    const stmt = () => super.prepare(sql.replaceAll(NOW, `'${this.now}'`)).bind(...args);
    return {
      sql,
      bind(...a) { args = a; return this; },
      all: () => stmt().all(), first: () => stmt().first(),
      run: () => stmt().run(), raw: options => stmt().raw(options),
    };
  }
}

for (const attached of [false, true]) {
  test(`delayed committing batch cannot land below a consumed cursor (attached=${attached})`, async () => {
    const db = new ClockDB();
    db.db.exec(`CREATE TABLE items(id TEXT PRIMARY KEY, name TEXT, qty INTEGER, updated_at TEXT, deleted_at TEXT, hub_at TEXT);
      CREATE TABLE history(id TEXT PRIMARY KEY, tbl TEXT, row_id TEXT, col TEXT, old TEXT, new TEXT, origin TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT);
      INSERT INTO items VALUES ('a','old',1,'2025-01-01T00:00:00.000Z',NULL,'2025-01-01T00:00:00.000Z');`);
    const columns = ['id','name','qty','updated_at','hub_at'];
    const event = {id:'original',tbl:'items',row_id:'a',col:'name',old:'old',new:'new',origin:'replica',
      created_at:'2025-01-02T00:00:00.000Z',updated_at:'2025-01-02T00:00:00.000Z'};
    const batch = db.batch.bind(db);
    let resume, queued;
    const gate = new Promise(resolve => { resume = resolve; });
    const waiting = new Promise(resolve => { queued = resolve; });
    let suspended = false;
    db.batch = async statements => {
      if (!suspended && statements.some(s => s.sql.startsWith('INSERT INTO "items"'))) {
        suspended = true;
        queued();
        await gate;
      }
      return batch(statements);
    };
    const delayed = ROUTES['/v1/rows/push']({table:'items',columns,
      rows:[{id:'a',name:'new',qty:2,updated_at:event.updated_at}], history:attached?[event]:[]}, db);
    await waiting;
    db.now = '2026-01-01T00:00:01.000Z';
    const fast = await ROUTES['/v1/rows/push']({table:'items',columns,
      rows:[{id:'b',name:'fast',qty:1,updated_at:event.updated_at}]}, db);
    expect(fast.rejected).toEqual([]);
    const since = (await ROUTES['/v1/cursor']({tables:['items','history']}, db)).max_hub_at;
    expect((await ROUTES['/v1/rows/pull']({table:'items',columns,since}, db)).rows.map(r=>r.id)).toEqual(['b']);
    db.now = '2026-01-01T00:00:02.000Z';
    resume();
    const committed = await delayed;
    expect(committed.rejected).toEqual([]);
    expect(committed.hub_at).toBe(db.now);
    expect((await ROUTES['/v1/rows/pull']({table:'items',columns,since}, db)).rows.map(r=>r.id).sort()).toEqual(['a','b']);
    const history = (await ROUTES['/v1/rows/pull']({table:'history',columns:['id','col','created_at','updated_at','hub_at'],since}, db)).rows;
    expect(history.map(r=>r.col).sort()).toEqual(['name','qty']);
    expect(history.every(r=>r.hub_at === db.now)).toBe(true);
    if (attached) {
      const original = history.find(r=>r.id === event.id);
      expect(original.created_at).toBe(event.created_at);
      expect(original.updated_at).toBe(event.updated_at);
    }
  });
}

for (const attached of [false, true]) {
  test(`failure isolation stamps actual retry arrival (attached=${attached})`, async () => {
    const db = new ClockDB();
    db.db.exec(`CREATE TABLE items(id TEXT PRIMARY KEY, name TEXT, qty INTEGER, updated_at TEXT, deleted_at TEXT, hub_at TEXT);
      CREATE TABLE history(id TEXT PRIMARY KEY, tbl TEXT, row_id TEXT, col TEXT, old TEXT, new TEXT, origin TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT);
      CREATE TABLE catalog_rules(id TEXT PRIMARY KEY, tbl TEXT, kind TEXT, enforce INTEGER, sql TEXT, text TEXT, col TEXT, deleted_at TEXT);
      INSERT INTO catalog_rules VALUES ('positive','items','invariant',1,'SELECT id FROM changed WHERE qty < 0','quantity must be positive',NULL,NULL);
      INSERT INTO items VALUES ('a','old',1,'2025-01-01T00:00:00.000Z',NULL,'2025-01-01T00:00:00.000Z');`);
    const columns = ['id','name','qty','updated_at','hub_at'];
    const event = {id:'original',tbl:'items',row_id:'a',col:'name',old:'old',new:'new',origin:'replica',
      created_at:'2025-01-02T00:00:00.000Z',updated_at:'2025-01-02T00:00:00.000Z'};
    const batch = db.batch.bind(db);
    let since;
    db.batch = async statements => {
      try { return await batch(statements); }
      catch (e) {
        if (!since && String(e).includes('life_invariant_0')) {
          db.now = '2026-01-01T00:00:01.000Z';
          const other = await ROUTES['/v1/rows/push']({table:'items',columns,
            rows:[{id:'c',name:'fast',qty:1,updated_at:event.updated_at}]}, db);
          expect(other.rejected).toEqual([]);
          since = (await ROUTES['/v1/cursor']({tables:['items','history']}, db)).max_hub_at;
          expect((await ROUTES['/v1/rows/pull']({table:'items',columns,since}, db)).rows.map(r=>r.id)).toEqual(['c']);
          db.now = '2026-01-01T00:00:02.000Z';
        }
        throw e;
      }
    };
    const out = await ROUTES['/v1/rows/push']({table:'items',columns,rows:[
      {id:'a',name:'new',qty:1,updated_at:event.updated_at},
      {id:'bad',name:'bad',qty:-1,updated_at:event.updated_at},
    ],history:attached?[event]:[]}, db);
    expect(out.rejected.map(r=>r.id)).toEqual(['bad']);
    expect(out.upserted).toBe(1);
    expect(since).toBe('2026-01-01T00:00:01.000Z');
    expect((await ROUTES['/v1/rows/pull']({table:'items',columns,since}, db)).rows.map(r=>r.id).sort()).toEqual(['a','c']);
    const history = (await ROUTES['/v1/rows/pull']({table:'history',columns:['id','col','hub_at'],since}, db)).rows;
    expect(history.length).toBe(1);
    expect(history[0].hub_at).toBe(db.now);
    if (attached) expect(history[0].id).toBe(event.id);
    expect(db.db.query("SELECT name FROM sqlite_master WHERE name GLOB '_life_write_*'").all()).toEqual([]);
  });
}

test('delayed derivation history uses the committing database clock', async () => {
  const db = await seed(new ClockDB());
  await ROUTES['/v1/rows/push']({table:'people',columns:cols,rows:[row()]}, db);
  const batch = db.batch.bind(db);
  let since;
  db.batch = async statements => {
    if (!since && statements.some(s=>s.sql.startsWith('UPDATE "people"'))) {
      db.now = '2026-01-01T00:00:01.000Z';
      const fast = await ROUTES['/v1/rows/push']({table:'people',columns:cols,rows:[row({id:'b'})]}, db);
      expect(fast.rejected).toEqual([]);
      since = (await ROUTES['/v1/cursor']({tables:['people','history']}, db)).max_hub_at;
      await ROUTES['/v1/rows/pull']({table:'history',columns:['id'],since}, db);
      db.now = '2026-01-01T00:00:02.000Z';
    }
    return batch(statements);
  };
  const out = await deriveRows(db, ENV, 'people', ['a'], {
    fetchImpl: async () => new Response(JSON.stringify({blurb:'derived value'})),
  });
  expect(out.failed).toEqual([]);
  expect(out.derived).toBe(1);
  const history = (await ROUTES['/v1/rows/pull']({table:'history',columns:['col','updated_at','hub_at'],since}, db)).rows;
  expect(history).toEqual([{col:'blurb',updated_at:db.now,hub_at:db.now}]);
});

test('stale row attachment gets a fresh arrival even when the row itself is unchanged', async () => {
  const db = new ClockDB();
  db.db.exec(`CREATE TABLE items(id TEXT PRIMARY KEY, name TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT);
    CREATE TABLE history(id TEXT PRIMARY KEY, tbl TEXT, row_id TEXT, col TEXT, old TEXT, new TEXT, origin TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT);
    INSERT INTO items VALUES ('a','new','2025-01-03T00:00:00.000Z',NULL,'2025-01-03T00:00:00.000Z');`);
  const event = {id:'original',tbl:'items',row_id:'a',col:'name',old:'old',new:'new',origin:'replica',
    created_at:'2025-01-02T00:00:00.000Z',updated_at:'2025-01-02T00:00:00.000Z'};
  const batch = db.batch.bind(db);
  const columns = ['id','name','updated_at','hub_at'];
  let since, interleaved = false;
  db.batch = async statements => {
    if (!interleaved && statements.some(s=>s.sql.startsWith('INSERT INTO "items"'))) {
      interleaved = true;
      db.now = '2026-01-01T00:00:01.000Z';
      await ROUTES['/v1/rows/push']({table:'items',columns,
        rows:[{id:'b',name:'fast',updated_at:event.updated_at}]}, db);
      since = (await ROUTES['/v1/cursor']({tables:['items','history']}, db)).max_hub_at;
      expect((await ROUTES['/v1/rows/pull']({table:'history',columns:['id'],since}, db)).rows).toEqual([]);
      db.now = '2026-01-01T00:00:02.000Z';
    }
    return batch(statements);
  };
  const out = await ROUTES['/v1/rows/push']({table:'items',columns,
    rows:[{id:'a',name:'new',updated_at:event.updated_at}],history:[event]}, db);
  expect(out.rejected).toEqual([]);
  expect(db.db.query("SELECT hub_at FROM items WHERE id='a'").get().hub_at).toBe('2025-01-03T00:00:00.000Z');
  const imported = (await ROUTES['/v1/rows/pull']({table:'history',columns:['id','updated_at','hub_at'],since}, db)).rows;
  expect(imported).toEqual([{id:event.id,updated_at:event.updated_at,hub_at:db.now}]);
});

test("cursor reports each table's own newest arrival so a replica pulls only what changed", async () => {
  const db = await seed(new D1Shim());
  const before = await ROUTES["/v1/cursor"]({ tables: ["people", "provenance"] }, db);
  expect(before.tables).toEqual({ people: "", provenance: "" });
  const push = await ROUTES["/v1/rows/push"]({ table: "people", columns: cols, rows: [row()] }, db);
  const after = await ROUTES["/v1/cursor"]({ tables: ["people", "provenance"] }, db);
  expect(after.tables.people).toBe(push.hub_at);
  expect(after.tables.provenance).toBe("");
  expect(after.max_hub_at).toBe(push.hub_at);
});

test("cursor asks the database in batches, not once per table", async () => {
  const db = await seed(new D1Shim());
  let batches = 0, singles = 0, batching = false;
  const batch = db.batch.bind(db), prepare = db.prepare.bind(db);
  db.batch = async (stmts) => {
    batches += 1;
    batching = true;
    try { return await batch(stmts); } finally { batching = false; }
  };
  db.prepare = (sql) => {
    const stmt = prepare(sql);
    for (const verb of ["all", "first", "run"]) {
      const inner = stmt[verb]?.bind(stmt);
      // a statement the shim runs INSIDE a batch is not a round trip of its own
      if (inner) stmt[verb] = (...a) => { if (!batching) singles += 1; return inner(...a); };
    }
    return stmt;
  };
  await ROUTES["/v1/cursor"]({ tables: ["people", "provenance", "catalog_properties"] }, db);
  await ROUTES["/v1/cursor"]({ tables: ["people", "provenance", "catalog_properties"] }, db);
  // after the one-time index and column passes, a cursor read is one batch and no per-table round trips
  expect(batches).toBeGreaterThanOrEqual(2);
  const warm = { batches, singles };
  await ROUTES["/v1/cursor"]({ tables: ["people", "provenance", "catalog_properties"] }, db);
  expect(batches - warm.batches).toBe(1);
  expect(singles - warm.singles).toBe(0);
});

test("cursor answers an estate wider than D1's compound SELECT limit", async () => {
  // D1 refuses a compound SELECT of more than five terms; a cursor naming every
  // table of a real estate (100+) must still be one request that D1 accepts.
  const db = new LimitedD1();
  try {
    const tables = Array.from({ length: 7 }, (_, i) => `t${i}`);
    for (const t of tables) await db.prepare(`CREATE TABLE ${t} (id TEXT PRIMARY KEY, updated_at TEXT, deleted_at TEXT, hub_at TEXT)`).run();
    await db.prepare("INSERT INTO t6 VALUES ('a','2026-01-01T00:00:00.000Z',NULL,'2026-01-02T00:00:00.000Z')").run();
    const out = await ROUTES["/v1/cursor"]({ tables }, db);
    expect(out.tables.t6).toBe("2026-01-02T00:00:00.000Z");
    expect(out.at_mark).toEqual({ t6: 1 });
  } finally {
    await db.close();
  }
});

test("a fresh isolate ensures every hub_at index in batches", async () => {
  const db = await seed(new D1Shim());
  let batches = 0, singles = 0, batching = false;
  const batch = db.batch.bind(db), prepare = db.prepare.bind(db);
  db.batch = async (stmts) => {
    batches += 1;
    batching = true;
    try { return await batch(stmts); } finally { batching = false; }
  };
  db.prepare = (sql) => {
    const stmt = prepare(sql);
    for (const verb of ["all", "first", "run"]) {
      const inner = stmt[verb]?.bind(stmt);
      if (inner) stmt[verb] = (...a) => { if (!batching) singles += 1; return inner(...a); };
    }
    return stmt;
  };
  await ROUTES["/v1/cursor"]({ tables: ["people", "provenance", "catalog_properties"] }, db);
  expect(singles).toBe(1); // the table list; everything per-table is batched
  expect(batches).toBe(4); // table_info + create index, the arrival-column probe, then the cursor
  const made = await prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%_hub_at'").all();
  expect(made.results.map((r) => r.name).sort()).toEqual(["catalog_properties_hub_at", "people_hub_at", "provenance_hub_at", "provenance_slice_hub_at"]);
});
