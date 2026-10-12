// Hub derivation engine: named HTTP endpoints named only by the DERIVATIONS
// secret, validated output, value + provenance in one batch, and the sweep
// that finds underived and stale rows.
import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { D1Shim } from "./d1shim.js";
import { deriveRows, deriveStale, loadDerivations, sweep } from "../src/derive.js";
import worker, { ROUTES } from "../src/index.js";

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

const hex = async (s) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

// Names are test fixtures only — nothing in worker/src knows them.
const ENV = {
  DERIVATIONS: JSON.stringify({
    tmdb_movie: { url: "https://derivations.example/movie", headers: { "Modal-Key": "key-1" } },
    blurb: { url: "https://derivations.example/blurb" },
  }),
};

async function seed(db) {
  for (const sql of [
    `CREATE TABLE catalog_properties (id TEXT PRIMARY KEY, tbl TEXT, col TEXT, label TEXT, sort INTEGER, type TEXT, required INTEGER, default_value TEXT, options TEXT, options_sql TEXT, min_items INTEGER, max_items INTEGER, pattern TEXT, ref_table TEXT, derived_by TEXT, inputs TEXT, immutable INTEGER, deprecated INTEGER, description TEXT, source TEXT, source_ref TEXT, created_at TEXT DEFAULT (${NOW}), updated_at TEXT DEFAULT (${NOW}), deleted_at TEXT)`,
    `CREATE TABLE provenance (id TEXT PRIMARY KEY, from_kind TEXT, from_ref TEXT, to_kind TEXT, to_ref TEXT, rel TEXT, field TEXT, detail TEXT, asserted_by TEXT, inputs_hash TEXT, value_hash TEXT, produced_at TEXT, created_at TEXT DEFAULT (${NOW}), updated_at TEXT DEFAULT (${NOW}), deleted_at TEXT, hub_at TEXT)`,
    `CREATE TABLE movies (id TEXT PRIMARY KEY, title TEXT, genres TEXT, blurb TEXT, status TEXT, created_at TEXT DEFAULT (${NOW}), updated_at TEXT DEFAULT (${NOW}), deleted_at TEXT)`,
    `INSERT INTO catalog_properties (id, tbl, col, sort, type, required, immutable) VALUES ('movies.id','movies','id',0,'text',1,1)`,
    `INSERT INTO catalog_properties (id, tbl, col, sort, type, pattern, derived_by, inputs) VALUES ('movies.title','movies','title',1,'text','[A-Za-z0-9 ]+','http:tmdb_movie','["id"]')`,
    `INSERT INTO catalog_properties (id, tbl, col, sort, type, derived_by, inputs) VALUES ('movies.genres','movies','genres',2,'json','http:tmdb_movie','["id"]')`,
    `INSERT INTO catalog_properties (id, tbl, col, sort, type, options) VALUES ('movies.status','movies','status',3,'select','[{"v":"Not Started"},{"v":"Finished"}]')`,
    `INSERT INTO movies (id, status, updated_at) VALUES ('78','Not Started','2026-09-04T00:00:00.000Z')`,
  ])
    await db.prepare(sql).run();
  return db;
}

const fresh = async () => seed(new D1Shim());

// A fetch stub that records its calls and replies with whatever it's given.
function stub(reply) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, signal: init.signal, body: JSON.parse(init.body) });
    const r = typeof reply === "function" ? reply(url) : reply;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  };
  return { calls, fetchImpl };
}

test("loadDerivations parses the secret and is empty when unset", () => {
  expect(loadDerivations({}).size).toBe(0);
  const m = loadDerivations(ENV);
  expect(m.get("tmdb_movie")).toEqual({ url: "https://derivations.example/movie", headers: { "Modal-Key": "key-1" }, refreshDays: null, noDataDays: 7 });
  expect(m.get("blurb").headers).toEqual({});
});

test("derives a row: writes values, provenance, and bumps updated_at", async () => {
  const db = await fresh();
  const { calls, fetchImpl } = stub({
    body: { title: "Blade Runner", genres: ["Sci-Fi", "Drama"], _source_ref: "tmdb:movie/78@2026-09-04" },
  });

  const out = await deriveRows(db, ENV, "movies", ["78"], { fetchImpl });
  expect(out).toEqual({ derived: 1, failed: [] });

  expect(calls.length).toBe(1);
  expect(calls[0].url).toBe("https://derivations.example/movie");
  expect(calls[0].headers["Modal-Key"]).toBe("key-1");
  expect(calls[0].signal).toBeInstanceOf(AbortSignal); // a hung endpoint can't stall the sweep
  expect(calls[0].body).toEqual({ tbl: "movies", id: "78", inputs: { id: "78" } });

  const row = await db.prepare("SELECT * FROM movies WHERE id = '78'").first();
  expect(row.title).toBe("Blade Runner");
  expect(row.genres).toBe('["Sci-Fi","Drama"]');
  expect(row.updated_at > "2026-09-04T00:00:00.000Z").toBe(true);

  const { results } = await db.prepare("SELECT * FROM provenance ORDER BY field").all();
  expect(results.map((r) => r.id)).toEqual(["movies:78:genres", "movies:78:title"]);
  for (const p of results) {
    expect(p.to_kind).toBe("movies");
    expect(p.to_ref).toBe("78");
    expect(p.from_kind).toBe("http:tmdb_movie");
    expect(p.from_ref).toBe("tmdb:movie/78@2026-09-04");
    expect(p.rel).toBe("derived_from");
    expect(p.asserted_by).toBe("hub");
    expect(p.inputs_hash).toBe(await hex('["78"]'));
    expect(p.produced_at).toBeTruthy();
    expect(p.hub_at).toBeTruthy(); // a hub write, so replicas past this row's cursor still pull it
    expect(p.deleted_at).toBe(null);
  }
  expect(results.find((r) => r.field === "title").value_hash).toBe(await hex("Blade Runner"));
  expect(results.find((r) => r.field === "genres").value_hash).toBe(await hex('["Sci-Fi","Drama"]'));
});

test("an endpoint without _source_ref leaves the inputs hash as the ref", async () => {
  const db = await fresh();
  const { fetchImpl } = stub({ body: { title: "Blade Runner" } });
  await deriveRows(db, ENV, "movies", ["78"], { fetchImpl });
  const p = await db.prepare("SELECT from_ref, inputs_hash FROM provenance WHERE id='movies:78:title'").first();
  expect(p.from_ref).toBe(p.inputs_hash);
});

test("a derivation without inputs hashes them as [null], as catalog.py does", async () => {
  const db = await fresh();
  db.db.exec(`UPDATE catalog_properties SET inputs = '[]' WHERE derived_by = 'http:tmdb_movie'`);
  await deriveRows(db, ENV, "movies", ["78"], { fetchImpl: stub({ body: { title: "Blade Runner" } }).fetchImpl });
  const p = await db.prepare("SELECT inputs_hash FROM provenance WHERE id='movies:78:title'").first();
  expect(p.inputs_hash).toBe(await hex("[null]"));
});

test("a non-2xx endpoint writes nothing and is reported in failed", async () => {
  const db = await fresh();
  const { fetchImpl } = stub({ status: 500, body: { error: "boom" } });

  const out = await deriveRows(db, ENV, "movies", ["78"], { fetchImpl });
  expect(out.derived).toBe(0);
  expect(out.failed.length).toBe(1);
  expect(out.failed[0].id).toBe("78");
  expect(out.failed[0].error).toContain("500");

  expect((await db.prepare("SELECT * FROM movies WHERE id='78'").first()).title).toBe(null);
  expect((await db.prepare("SELECT count(*) AS n FROM provenance").first()).n).toBe(0);
});

test("keys that are not derived columns of this derivation are ignored", async () => {
  const db = await fresh();
  const { fetchImpl } = stub({ body: { status: "Nope", _source_ref: "x" } });

  const out = await deriveRows(db, ENV, "movies", ["78"], { fetchImpl });
  expect(out).toEqual({ derived: 1, failed: [] }); // a completed lookup with no data for its outputs
  const row = await db.prepare("SELECT * FROM movies WHERE id='78'").first();
  expect(row.status).toBe("Not Started");
  expect(row.title).toBe(null);
  expect(db.db.query("SELECT field, detail FROM provenance ORDER BY field").all())
    .toEqual([{ field: "genres", detail: '{"no_data":true}' }, { field: "title", detail: '{"no_data":true}' }]);
});

test("a value failing its property check is not written; siblings still are", async () => {
  const db = await fresh();
  const { fetchImpl } = stub({ body: { title: "!!!", genres: ["Sci-Fi"] } });

  const out = await deriveRows(db, ENV, "movies", ["78"], { fetchImpl });
  expect(out.derived).toBe(1);
  expect(out.failed).toEqual([
    { id: "78", col: "title", error: expect.stringContaining("expected form") },
  ]);
  const row = await db.prepare("SELECT * FROM movies WHERE id='78'").first();
  expect(row.title).toBe(null);
  expect(row.genres).toBe('["Sci-Fi"]');
  const { results } = await db.prepare("SELECT field FROM provenance").all();
  expect(results.map((r) => r.field)).toEqual(["genres"]);
});

test("an unconfigured derivation name fails softly", async () => {
  const db = await fresh();
  await db.prepare(
    `INSERT INTO catalog_properties (id, tbl, col, sort, type, derived_by, inputs) VALUES ('movies.blurb','movies','blurb',4,'text','http:nope','["status"]')`,
  ).run();
  const { calls, fetchImpl } = stub({ body: { title: "Blade Runner" } });

  const out = await deriveRows(db, ENV, "movies", ["78"], { fetchImpl });
  expect(out.derived).toBe(1); // tmdb_movie still ran
  expect(out.failed.length).toBe(1);
  expect(out.failed[0].error).toContain("no derivation configured");
  expect(calls.length).toBe(1);
});

test("sweep derives underived rows, skips fresh ones, and re-derives on changed inputs", async () => {
  const db = await fresh();
  await db.prepare(
    `INSERT INTO catalog_properties (id, tbl, col, sort, type, derived_by, inputs) VALUES ('movies.blurb','movies','blurb',4,'text','http:blurb','["status"]')`,
  ).run();
  const replies = {
    "https://derivations.example/movie": { body: { title: "Blade Runner", genres: ["Sci-Fi"] } },
    "https://derivations.example/blurb": { body: { blurb: "a blurb" } },
  };
  let s = stub((url) => replies[url]);

  expect(await sweep(db, ENV, { fetchImpl: s.fetchImpl })).toEqual({ derived: 2, failed: [] });
  const row = await db.prepare("SELECT * FROM movies WHERE id='78'").first();
  expect(row.title).toBe("Blade Runner");
  expect(row.blurb).toBe("a blurb");

  // nothing stale now
  s = stub((url) => replies[url]);
  expect(await sweep(db, ENV, { fetchImpl: s.fetchImpl })).toEqual({ derived: 0, failed: [] });
  expect(s.calls.length).toBe(0);

  // a bumped updated_at with unchanged inputs re-hashes but derives nothing
  await db.prepare("UPDATE movies SET updated_at = '2030-01-01T00:00:00.000Z' WHERE id='78'").run();
  s = stub((url) => replies[url]);
  expect(await sweep(db, ENV, { fetchImpl: s.fetchImpl })).toEqual({ derived: 0, failed: [] });
  expect(s.calls.length).toBe(0);

  // changing an input re-derives (only the derivation whose inputs changed)
  await db.prepare("UPDATE movies SET status='Finished', updated_at='2030-01-02T00:00:00.000Z' WHERE id='78'").run();
  replies["https://derivations.example/blurb"] = { body: { blurb: "another blurb" } };
  s = stub((url) => replies[url]);
  expect(await sweep(db, ENV, { fetchImpl: s.fetchImpl })).toEqual({ derived: 1, failed: [] });
  expect(s.calls.map((c) => c.url)).toEqual(["https://derivations.example/blurb"]);
  expect((await db.prepare("SELECT blurb FROM movies WHERE id='78'").first()).blurb).toBe("another blurb");
});

test("POST /v1/derive: guarded identifier, capped ids, col narrows the work", async () => {
  const db = await fresh();
  await db.prepare(
    `INSERT INTO catalog_properties (id, tbl, col, sort, type, derived_by, inputs) VALUES ('movies.blurb','movies','blurb',4,'text','http:blurb','["status"]')`,
  ).run();

  await expect(ROUTES["/v1/derive"]({ table: "movies; DROP TABLE x", ids: [] }, db, ENV)).rejects.toThrow("unsafe identifier");

  const res = await ROUTES["/v1/derive"]({ table: "movies", ids: Array(51).fill("78") }, db, ENV);
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "at most 50 ids per call" });

  // col picks the derivation that produces it; its siblings ride along
  const { calls, fetchImpl } = stub({ body: { title: "Blade Runner", genres: ["Sci-Fi"] } });
  expect(await deriveRows(db, ENV, "movies", ["78"], { fetchImpl, col: "genres" })).toEqual({ derived: 1, failed: [] });
  expect(calls.map((c) => c.url)).toEqual(["https://derivations.example/movie"]);
  const row = await db.prepare("SELECT * FROM movies WHERE id='78'").first();
  expect(row.title).toBe("Blade Runner");
  expect(row.blurb).toBe(null);
});

test("sweep on a hub with no catalog is a no-op", async () => {
  expect(await sweep(new D1Shim(), ENV)).toEqual({ derived: 0, failed: [] });
});

test("a derivation reading another's output hashes the fresh value, so it settles", async () => {
  const db = await fresh();
  await db.prepare(
    `INSERT INTO catalog_properties (id, tbl, col, sort, type, derived_by, inputs) VALUES ('movies.blurb','movies','blurb',4,'text','http:blurb','["title"]')`,
  ).run();
  const replies = {
    "https://derivations.example/movie": { body: { title: "Blade Runner", genres: ["Sci-Fi"] } },
    "https://derivations.example/blurb": { body: { blurb: "a blurb" } },
  };
  // one call, both derivations: the second must see the first's write
  let s = stub((url) => replies[url]);
  expect(await deriveRows(db, ENV, "movies", ["78"], { fetchImpl: s.fetchImpl })).toEqual({ derived: 2, failed: [] });
  // blurb's inputs_hash must be over the title this same pass wrote, not the
  // NULL it had when the row was first read
  const prov = await db.prepare("SELECT inputs_hash FROM provenance WHERE id='movies:78:blurb'").first();
  expect(prov.inputs_hash).toBe(await hex('["Blade Runner"]'));

  s = stub((url) => replies[url]);
  expect(await sweep(db, ENV, { fetchImpl: s.fetchImpl })).toEqual({ derived: 0, failed: [] });
  expect(s.calls.length).toBe(0);
});

// Nothing reads the background paths' return value, so the log is the only trace.
async function captureLog(fn) {
  const logs = [];
  const real = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.log = real;
  }
  return logs.join("\n");
}

test("scheduled(): the sweep logs its failures and never throws", async () => {
  const db = await fresh();
  const tasks = [];
  const ctx = { waitUntil: (p) => tasks.push(p) };

  // a name the secret does not configure: per-row failures, not an exception
  const out = await captureLog(async () => {
    await worker.scheduled({ cron: "*/15 * * * *" }, { DB: db, DERIVATIONS: "{}" }, ctx);
    await Promise.all(tasks);
  });
  expect(JSON.parse(out).derive_failed[0].error).toContain("no derivation configured");

  // a malformed secret throws inside the sweep: caught and logged, not unhandled
  tasks.length = 0;
  const err = await captureLog(async () => {
    await worker.scheduled({ cron: "*/15 * * * *" }, { DB: db, DERIVATIONS: "not json" }, ctx);
    await Promise.all(tasks);
  });
  expect(JSON.parse(err).derive_error).toContain("SyntaxError");
});

test("push logs the derivation failures it can no longer return", async () => {
  const db = await fresh();
  const tasks = [];
  const ctx = { waitUntil: (p) => tasks.push(p) };
  const out = await captureLog(async () => {
    await ROUTES["/v1/rows/push"](
      { table: "movies", columns: ["id", "status", "updated_at"], rows: [{ id: "78", status: "Finished", updated_at: "2030-01-01T00:00:00.000Z" }] },
      db,
      { DERIVATIONS: "{}" },
      ctx
    );
    await Promise.all(tasks);
  });
  expect(JSON.parse(out).derive_failed[0]).toMatchObject({ id: "78", error: expect.stringContaining("no derivation configured") });
});

test('conditional edits schedule ordinary background derivations only after acceptance', async () => {
  const db=await fresh(), tasks=[];
  const body={table:'movies',id:'78',values:{status:'Finished'},expected_revision:{updated_at:'2026-09-04T00:00:00.000Z',hub_at:null}};
  const out=await captureLog(async()=>{
    const receipt=await ROUTES['/v1/rows/patch'](body,db,{DERIVATIONS:'{}'},{waitUntil:p=>tasks.push(p)});
    expect(receipt.id).toBe('78');
    await Promise.all(tasks);
  });
  expect(tasks).toHaveLength(1);
  expect(JSON.parse(out).derive_failed[0]).toMatchObject({id:'78',error:expect.stringContaining('no derivation configured')});
  tasks.length=0;
  expect((await ROUTES['/v1/rows/patch'](body,db,{}, {waitUntil:p=>tasks.push(p)})).status).toBe(409);
  expect(tasks).toHaveLength(0);
});

test('an edit during the external call cannot receive a derivation for stale inputs', async () => {
  const db = await fresh();
  const fetchImpl = async () => {
    db.db.exec("UPDATE movies SET status='Finished', updated_at='2026-10-01T00:00:00.000Z' WHERE id='78'");
    return new Response(JSON.stringify({title:'Outdated'}));
  };
  const out = await deriveRows(db, ENV, 'movies', ['78'], {fetchImpl});
  expect(out.derived).toBe(0);
  expect(out.failed.length).toBeGreaterThan(0);
  expect(db.db.query("SELECT title FROM movies WHERE id='78'").get().title).toBeNull();
  expect(db.db.query('SELECT * FROM provenance').all()).toEqual([]);
});

test('derived invariant failure rolls back the value and proof', async () => {
  const db = await fresh();
  db.db.exec("CREATE TABLE catalog_rules (id TEXT, tbl TEXT, col TEXT, kind TEXT, enforce INTEGER, sql TEXT, text TEXT, deleted_at TEXT); INSERT INTO catalog_rules VALUES ('blocked','movies','title','invariant',1,\"SELECT id FROM changed WHERE title='Blocked'\",'blocked title',NULL)");
  const { fetchImpl } = stub({body:{title:'Blocked'}});
  const out = await deriveRows(db, ENV, 'movies', ['78'], {fetchImpl});
  expect(out.derived).toBe(0);
  expect(out.failed.length).toBe(1);
  expect(db.db.query("SELECT title FROM movies WHERE id='78'").get().title).toBeNull();
  expect(db.db.query('SELECT * FROM provenance').all()).toEqual([]);
});

test('a derivation records real cell changes and repeated identical output adds no history', async () => {
  const db = await fresh();
  const { fetchImpl } = stub({body:{title:'Derived Title'}});
  expect((await deriveRows(db, ENV, 'movies', ['78'], {fetchImpl})).derived).toBe(1);
  expect(db.db.query('SELECT col,old,new,origin FROM history').all()).toEqual([{col:'title',old:null,new:'Derived Title',origin:'hub'}]);
  await deriveRows(db, ENV, 'movies', ['78'], {fetchImpl});
  expect(db.db.query('SELECT * FROM history').all().length).toBe(1);
});

for (const caller of ['direct','stale','sweep']) test(`I6: ${caller} derivations account for 50 IDs and resume within one invocation budget`, async () => {
  const {deriveStale} = await import('../src/derive.js');
  const db = await fresh();
  const ids = ['78',...Array.from({length:49},(_,i)=>String(i))];
  for (const id of ids.slice(1)) db.db.query("INSERT INTO movies (id,status,updated_at) VALUES (?,'Not Started','2025-01-01T00:00:00.000Z')").run(id);
  const prepare = db.prepare.bind(db);
  let queries = 0;
  db.prepare = sql => {
    const stmt = prepare(sql);
    for (const method of ['all','first','run','raw']) {
      const original = stmt[method].bind(stmt);
      stmt[method] = (...args) => { if (++queries > 1000) throw new Error('simulated D1 invocation limit'); return original(...args); };
    }
    return stmt;
  };
  const {fetchImpl} = stub({body:{title:'Budgeted',genres:[]}});
  const run = async pending => caller === 'direct' ? deriveRows(db,ENV,'movies',pending,{fetchImpl})
    : caller === 'stale' ? deriveStale(db,ENV,'movies',db.db.query('SELECT * FROM movies').all(),{fetchImpl})
    : sweep(db,ENV,{fetchImpl});
  let out = await run(ids);
  console.info(`${caller} derive: derived=${out.derived} remaining=${new Set(out.failed.map(r=>r.id)).size} statements=${queries}`);
  expect(queries).toBeLessThan(1000);
  expect(out.derived).toBeGreaterThan(0);
  expect(out.derived + new Set(out.failed.map(r=>r.id)).size).toBe(50);
  for (let attempt=0; out.failed.length && attempt<4; attempt++) {
    queries = 0;
    out = await run([...new Set(out.failed.map(r=>r.id))]);
    expect(queries).toBeLessThan(1000);
    expect(out.derived).toBeGreaterThan(0);
  }
  expect(out.failed).toEqual([]);
  expect(db.db.query("SELECT count(*) AS n FROM movies WHERE title='Budgeted'").get().n).toBe(50);
});

test("POST /v1/derive preserves endpoint errors and retry metadata without changing existing cells or proof", async () => {
  const db = await fresh();
  await deriveRows(db, ENV, "movies", ["78"], { fetchImpl: stub({ body: { title: "Existing", genres: [] } }).fetchImpl });
  const snapshot = () => ["movies", "provenance", "history"].map(t => db.db.query(`SELECT * FROM ${t}`).all());
  const before = snapshot();
  const upstream = spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(
    { error: "Lookup temporarily rate limited", title: "Must not land", _source_ref: "must-not-land" },
    { status: 429, headers: { "Retry-After": "120" } },
  ));
  try {
    const res = await worker.fetch(new Request("https://hub.example/v1/derive", {
      method: "POST", headers: { Authorization: "Bearer test-token" },
      body: JSON.stringify({ table: "movies", ids: ["78"] }),
    }), { ...ENV, DB: db, HUB_TOKEN: "test-token" }, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ derived: 0, failed: [{
      id: "78", col: "title", status: 429, retry_after: 120,
      error: "endpoint tmdb_movie returned 429: Lookup temporarily rate limited",
    }] });
    expect(snapshot()).toEqual(before);
  } finally { upstream.mockRestore(); }
});

test("endpoint diagnostics accept only bounded safe JSON error text", async () => {
  const cases = [
    [JSON.stringify({ error: "Lookup failed", detail: "private-detail", headers: { Authorization: "private-token" } }), "Lookup failed"],
    [JSON.stringify({ error: "spotify: search HTTP 429" }), "spotify: search HTTP 429"],
    [JSON.stringify({ error: "musicbrainz: HTTP503" }), "musicbrainz: HTTP503"],
    [JSON.stringify({ error: "x".repeat(2000) }), "x".repeat(100)],
    [JSON.stringify({ error: "Lookup failed at https://user:private-password@upstream.example/path?token=private-token using key-1" }), "Lookup failed at"],
    [JSON.stringify({ error: "Lookup failed\nAuthorization: Bearer private-token\nCookie: private-cookie" }), "Lookup failed"],
    [JSON.stringify({ error: 'Lookup failed; headers: {"X-Key":"private-key"}' }), "Lookup failed"],
    [JSON.stringify({ error: "Lookup failed with Bearer private-token" }), "Lookup failed"],
    [JSON.stringify({ error: "<html>private-page</html>" }), null],
    ["<html>private-page</html>", null],
    ['{"error":"private-fragment",', null],
    [JSON.stringify({ error: { token: "private-token" } }), null],
    [JSON.stringify({ error: "too big", unused: "x".repeat(20_000) }), null],
  ];
  for (const [body, useful] of cases) {
    const db = await fresh();
    const out = await deriveRows(db, ENV, "movies", ["78"], {
      fetchImpl: async () => new Response(body, { status: 502, headers: { "X-Secret": "private-header" } }),
    });
    expect(out.derived).toBe(0);
    expect(out.failed[0]).toMatchObject({ id: "78", col: "title", status: 502 });
    const error = out.failed[0].error;
    if (useful) expect(error).toContain(useful);
    else expect(error).toBe("endpoint tmdb_movie returned 502");
    expect(error.length).toBeLessThanOrEqual(512);
    expect(error).not.toMatch(/private-|https?:|Authorization|Cookie|key-1|<html>/);
    expect(out.failed[0]).not.toHaveProperty("retry_after");
    expect(db.db.query("SELECT * FROM provenance").all()).toEqual([]);
  }
});

for (const [label, echo] of [
  ["bearer component", "fixture-token-123"],
  ["proxy auth component", "Zml4dHVyZS11c2VyOmZpeHR1cmUtcGFzcw=="],
  ["decoded URL credentials", "fixture-user fixture-password fixture+query"],
  ["encoded URL credentials", "fixture%2Duser fixture%2Dpassword fixture%2Bquery"],
  ["raw URL query escapes", "fixture%2dquery2"],
]) test(`endpoint diagnostics redact configured ${label}`, async () => {
  const db = await fresh();
  const target = {
    url: "https://fixture%2Duser:fixture%2Dpassword@derivations.example/movie?token=fixture%2Bquery&key=fixture%2dquery2",
    headers: { Authorization: "Bearer fixture-token-123", "Proxy-Authorization": "Basic Zml4dHVyZS11c2VyOmZpeHR1cmUtcGFzcw==" },
  };
  const out = await deriveRows(db, { DERIVATIONS: JSON.stringify({ tmdb_movie: target }) }, "movies", ["78"], {
    fetchImpl: async () => Response.json({ error: `source: Rejected credential ${echo}` }, { status: 401 }),
  });
  expect(out.derived).toBe(0);
  expect(out.failed[0]).toMatchObject({ id: "78", col: "title", status: 401 });
  expect(out.failed[0].error).toContain("source: Rejected credential");
  expect(out.failed[0].error).not.toMatch(/fixture|Zml4dHVyZS/);
  expect(db.db.query("SELECT * FROM provenance").all()).toEqual([]);
});

for (const [status, header, seconds] of [
  [429, null, 60], [429, "nonsense", 60], [429, "-5", 60], [429, "1.5", 60],
  [429, "1e3", 60], [429, "999999999999999999999", 60], [429, "9007199254740991", 60],
  [429, "0", 1], [429, " 12 ", 12], [429, "Thu, 01 Jan 2026 00:01:30 GMT", 90],
  [429, "Wed, 31 Dec 2025 23:59:00 GMT", 1], [503, "45", 45],
  [503, "Thu, 01 Jan 2026 00:01:30 GMT", 90], [503, null, null], [503, "bad", null], [500, "45", null],
]) test(`endpoint ${status} Retry-After ${header} yields ${seconds}`, async () => {
  const db = await fresh();
  const clock = spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 0, 1));
  try {
    const out = await deriveRows(db, ENV, "movies", ["78"], {
      fetchImpl: async () => Response.json({ error: "Unavailable" }, {
        status, headers: header === null ? {} : { "Retry-After": header },
      }),
    });
    expect(out.failed[0].status).toBe(status);
    if (seconds === null) expect(out.failed[0]).not.toHaveProperty("retry_after");
    else expect(out.failed[0].retry_after).toBe(seconds);
  } finally { clock.mockRestore(); }
});

test("cooldown persists across fresh database handles, defers every caller, and expires", async () => {
  const dir = mkdtempSync(join(tmpdir(), "derive-cooldown-"));
  const path = join(dir, "hub.db");
  let db = await seed(new D1Shim(path));
  const clock = spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 0, 1));
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return calls === 1 ? Response.json({ error: "Slow down" }, { status: 429, headers: { "Retry-After": "120" } })
      : Response.json({ title: "Recovered", genres: [] });
  };
  try {
    db.db.exec("INSERT INTO movies (id) VALUES ('79')");
    const first = await deriveRows(db, ENV, "movies", ["78", "79"], { fetchImpl });
    expect(first.failed.map(f => [f.id, f.status, f.retry_after])).toEqual([["78", 429, 120], ["79", 429, 120]]);
    expect(calls).toBe(1);
    clock.mockReturnValue(Date.UTC(2026, 0, 1, 0, 0, 30, 100));
    for (const caller of ["direct", "stale", "sweep"]) {
      db.db.close();
      db = new D1Shim(path);
      const out = caller === "direct" ? await deriveRows(db, ENV, "movies", ["78"], { fetchImpl })
        : caller === "stale" ? await deriveStale(db, ENV, "movies", db.db.query("SELECT * FROM movies").all(), { fetchImpl })
        : await sweep(db, ENV, { fetchImpl });
      expect(out.derived).toBe(0);
      expect(out.failed.length).toBeGreaterThan(0);
      for (const f of out.failed) {
        expect(f).toMatchObject({ col: "title", status: 429, retry_after: 90 });
        expect(f.error).toContain("deferred");
      }
      expect(calls).toBe(1);
      expect(db.db.query("SELECT * FROM provenance").all()).toEqual([]);
    }
    clock.mockReturnValue(Date.UTC(2026, 0, 1, 0, 2));
    db.db.close();
    db = new D1Shim(path);
    expect(await sweep(db, ENV, { fetchImpl })).toEqual({ derived: 2, failed: [] });
    expect(calls).toBe(3);
  } finally {
    clock.mockRestore();
    db.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cooldowns use endpoint name and URL, survive header rotation, and remain internal", async () => {
  const db = await fresh();
  const clock = spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 0, 1));
  const upstream = spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(
    { error: "Service busy" }, { status: 503, headers: { "Retry-After": "90" } },
  ));
  const env = { ...ENV, DB: db, HUB_TOKEN: "test-token" };
  const request = (path, body) => worker.fetch(new Request(`https://hub.example${path}`, {
    method: body ? "POST" : "GET", headers: { Authorization: "Bearer test-token" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), env, {});
  try {
    await request("/v1/derive", { table: "movies", ids: ["78"] });
    const endpoints = JSON.parse(env.DERIVATIONS);
    endpoints.tmdb_movie.headers = { Authorization: "Bearer rotated-test-secret" };
    env.DERIVATIONS = JSON.stringify(endpoints);
    const deferred = await (await request("/v1/derive", { table: "movies", ids: ["78"] })).json();
    expect(deferred.failed[0]).toMatchObject({ status: 503, retry_after: 90 });
    expect(upstream).toHaveBeenCalledTimes(1);

    endpoints.tmdb_movie.url = "https://derivations.example/another?token=private-url-token";
    env.DERIVATIONS = JSON.stringify(endpoints);
    await request("/v1/derive", { table: "movies", ids: ["78"] });
    expect(upstream).toHaveBeenCalledTimes(2);
    db.db.exec("UPDATE catalog_properties SET derived_by='http:renamed' WHERE derived_by='http:tmdb_movie'");
    endpoints.renamed = endpoints.tmdb_movie;
    env.DERIVATIONS = JSON.stringify(endpoints);
    await request("/v1/derive", { table: "movies", ids: ["78"] });
    expect(upstream).toHaveBeenCalledTimes(3);

    const schema = await (await request("/v1/schema/pull", {})).json();
    expect(schema.entries).toEqual([]);
    const catalog = await (await request("/v1/catalog")).json();
    expect(catalog.properties.every(p => p.tbl === "movies")).toBe(true);
    expect(JSON.stringify(db.db.query("SELECT * FROM _derivation_cooldowns").all())).not.toMatch(/https:|private-|rotated-/);
    expect(db.db.query("SELECT * FROM provenance").all()).toEqual([]);
    expect(db.db.query("SELECT name FROM sqlite_master WHERE name GLOB '_life_write_*'").all()).toEqual([]);

  } finally { clock.mockRestore(); upstream.mockRestore(); }
});

test("endpoint fetch uses a 60 second abort signal and sanitizes transport failures", async () => {
  const db = await fresh();
  const controller = new AbortController();
  const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  let received;
  try {
    const out = await deriveRows(db, ENV, "movies", ["78"], { fetchImpl: async (_url, { signal }) => {
      received = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        queueMicrotask(() => controller.abort(new DOMException("private-url https://user:secret@example.test", "TimeoutError")));
      });
    } });
    expect(timeout).toHaveBeenCalledWith(60_000);
    expect(received.aborted).toBe(true);
    expect(out.failed[0].error).toContain("TimeoutError");
    expect(out.failed[0].error.toLowerCase()).toContain("timeout");
    expect(out.failed[0].error).not.toMatch(/private-|https:|secret/);
    expect(db.db.query("SELECT * FROM provenance").all()).toEqual([]);
  } finally { timeout.mockRestore(); }
});

test("an overlapping shorter response cannot shorten the persisted endpoint cooldown", async () => {
  const db = await fresh();
  const clock = spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 0, 1));
  let started, release;
  const ready = new Promise(resolve => { started = resolve; });
  const response = new Promise(resolve => { release = resolve; });
  try {
    const first = deriveRows(db, ENV, "movies", ["78"], { fetchImpl: async () => { started(); return response; } });
    await ready;
    const second = await deriveRows(db, ENV, "movies", ["78"], {
      fetchImpl: async () => Response.json({}, { status: 429, headers: { "Retry-After": "120" } }),
    });
    expect(second.failed[0].retry_after).toBe(120);
    release(Response.json({}, { status: 503, headers: { "Retry-After": "10" } }));
    await first;
    clock.mockReturnValue(Date.UTC(2026, 0, 1, 0, 1));
    const success = stub({ body: { title: "Recovered" } });
    const deferred = await deriveRows(db, ENV, "movies", ["78"], { fetchImpl: success.fetchImpl });
    expect(deferred.failed[0]).toMatchObject({ status: 429, retry_after: 60 });
    expect(success.calls).toEqual([]);
    clock.mockReturnValue(Date.UTC(2026, 0, 1, 0, 2));
    await deriveRows(db, ENV, "movies", ["78"], {
      fetchImpl: async () => Response.json({}, { status: 503, headers: { "Retry-After": "15" } }),
    });
    expect((await deriveRows(db, ENV, "movies", ["78"], { fetchImpl: success.fetchImpl })).failed[0])
      .toMatchObject({ status: 503, retry_after: 15 });
    expect(db.db.query("SELECT count(*) AS n FROM _derivation_cooldowns").get().n).toBe(1);
    expect(success.calls).toEqual([]);
  } finally { clock.mockRestore(); }
});

test("transport and malformed success responses preserve existing values, proof and history", async () => {
  const db = await fresh();
  await deriveRows(db, ENV, "movies", ["78"], { fetchImpl: stub({ body: { title: "Existing" } }).fetchImpl });
  const snapshot = () => ["movies", "provenance", "history"].map(t => db.db.query(`SELECT * FROM ${t}`).all());
  const before = snapshot();
  for (const [fetchImpl, diagnostic] of [
    [async () => { throw new Error("request https://user:private-token@upstream.test with key-1 failed"); }, "unreachable"],
    [async () => new Response('{"error":"private-token",'), "invalid JSON"],
    [async () => Response.json(["private-token"]), "non-object"],
  ]) {
    const out = await deriveRows(db, ENV, "movies", ["78"], { fetchImpl });
    expect(out.derived).toBe(0);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0].error).toContain(diagnostic);
    expect(out.failed[0].error).not.toMatch(/private-|https:|key-1/);
    expect(snapshot()).toEqual(before);
  }
});

for (const [failure, abortTimeout, marker] of [
  ["TimeoutError", false, "timeout"],
  ["TypeError", false, "unreachable"],
  ["AbortError", true, "timeout"],
]) test(`response body ${failure} retains the ${marker} outage classification`, async () => {
  const db = await fresh();
  await deriveRows(db, ENV, "movies", ["78"], { fetchImpl: stub({ body: { title: "Existing" } }).fetchImpl });
  const snapshot = () => ["movies", "provenance", "history"].map(t => db.db.query(`SELECT * FROM ${t}`).all());
  const before = snapshot();
  const request = new AbortController();
  const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(request.signal);
  try {
    const out = await deriveRows(db, ENV, "movies", ["78"], { fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ title: "Must not land", _source_ref: "must-not-land" })));
      },
      pull(controller) {
        const message = "private-body https://user:private-token@upstream.test";
        if (abortTimeout) request.abort(new DOMException(message, "TimeoutError"));
        controller.error(failure === "TypeError" ? new TypeError(message) : new DOMException(message, failure));
      },
    })) });
    expect(out.derived).toBe(0);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0].error.toLowerCase()).toContain(marker);
    expect(out.failed[0].error).not.toMatch(/invalid JSON|private-|https:/);
    expect(snapshot()).toEqual(before);
  } finally { timeout.mockRestore(); }
});

test('manual Resolve refuses a stale displayed revision before invoking its provider', async () => {
  const db = await fresh();
  const {calls,fetchImpl} = stub({body:{title:'Fresh Title',genres:[]}});
  const before = await db.prepare("SELECT * FROM movies WHERE id='78'").first();
  const result = await deriveRows(db,ENV,'movies',['78'],{col:'title',expectedUpdatedAt:'2026-01-01T00:00:00.000Z',fetchImpl});
  expect(calls).toHaveLength(0);
  expect(result.derived).toBe(0);
  expect(result.failed[0].error).toContain('changed');
  expect(await db.prepare("SELECT * FROM movies WHERE id='78'").first()).toEqual(before);
  expect((await db.prepare('SELECT * FROM provenance').all()).results).toHaveLength(0);
});

test('manual Resolve accepts the displayed revision and records derived provenance', async () => {
  const db = await fresh();
  const {calls,fetchImpl} = stub({body:{title:'Fresh Title',genres:[]}});
  const result=await deriveRows(db,ENV,'movies',['78'],{col:'title',expectedUpdatedAt:'2026-09-04T00:00:00.000Z',fetchImpl});
  expect(result).toEqual({derived:1,failed:[]});
  expect(calls).toHaveLength(1);
  expect((await db.prepare("SELECT title FROM movies WHERE id='78'").first()).title).toBe('Fresh Title');
  expect((await db.prepare("SELECT * FROM provenance WHERE to_ref='78' AND rel='derived_from'").all()).results.length).toBeGreaterThan(0);
});

test('manual Resolve route requires an explicit single-row revision and rejects draft values', async () => {
  const untouched={prepare(){throw Error('Invalid requests must not touch the database');}};
  for(const body of [null,{}, {table:'movies',ids:['78'],col:'title'}, {table:'movies',ids:['78','79'],col:'title',expectedUpdatedAt:'2026-09-04T00:00:00.000Z'}, {table:'movies',ids:['78'],col:'title',expectedUpdatedAt:'2026-09-04T00:00:00.000Z',values:{title:'draft'}}]) {
    const response=await ROUTES['/v1/derive/resolve'](body,untouched,ENV);
    expect(response.status).toBe(400);
  }
  const db=await fresh();
  const result=await ROUTES['/v1/derive/resolve']({table:'movies',ids:['78'],col:'title',expectedUpdatedAt:'2026-01-01T00:00:00.000Z'},db,ENV);
  expect(result.derived).toBe(0);
  expect(result.failed[0].error).toContain('changed');
});

test("endpoint diagnostics redact the decoded components of a configured Basic credential", async () => {
  const db = await fresh();
  // No URL userinfo here, so only decoding the header can find these values.
  const target = { url: "https://derivations.example/movie", headers: { Authorization: `Basic ${btoa("basic-user:basic-secret-77")}` } };
  for (const echo of ["basic-secret-77", "basic-user", "basic-user:basic-secret-77"]) {
    const out = await deriveRows(db, { DERIVATIONS: JSON.stringify({ tmdb_movie: target }) }, "movies", ["78"], {
      fetchImpl: async () => Response.json({ error: `source: Rejected ${echo} here` }, { status: 401 }),
    });
    expect(out.failed[0].error).toContain("source: Rejected");
    expect(out.failed[0].error).not.toMatch(/basic-user|basic-secret/);
  }
});

// An INTEGER input (year) and an INTEGER output (decade): a replica renders a
// stored 1999 as "1999", so the hub must too, however D1 binds the number.
async function withYears(db) {
  await seed(db);
  for (const sql of [
    "ALTER TABLE movies ADD COLUMN year INTEGER",
    "ALTER TABLE movies ADD COLUMN decade INTEGER",
    "INSERT INTO catalog_properties (id, tbl, col, sort, type) VALUES ('movies.year','movies','year',5,'int')",
    `INSERT INTO catalog_properties (id, tbl, col, sort, type, derived_by, inputs) VALUES ('movies.decade','movies','decade',6,'int','http:blurb','["year"]')`,
    "UPDATE movies SET year = 1999 WHERE id = '78'",
  ]) await db.prepare(sql).run();
  return db;
}
const LEGACY = { inputs: '["1999.0"]', value: "1990.0" }; // what hubs hashed before the typed rendering

test("hub proofs over INTEGER cells match the replica's rendering under D1's REAL binding", async () => {
  const { LimitedD1 } = await import("./limited-d1.js");
  const db = new LimitedD1({ realNumbers: true });
  try {
    await withYears(db);
    const out = await deriveRows(db, ENV, "movies", ["78"], { names: new Set(["blurb"]), fetchImpl: stub({ body: { decade: 1990 } }).fetchImpl });
    expect(out).toEqual({ derived: 1, failed: [] });
    const p = await db.prepare("SELECT inputs_hash, value_hash FROM provenance WHERE id = 'movies:78:decade'").first();
    expect(p).toEqual({ inputs_hash: await hex('["1999"]'), value_hash: await hex("1990") });
  } finally { await db.close(); }
});

test("proofs hashed in the earlier REAL rendering stay fresh: no re-derive, and a pushed proven value is accepted", async () => {
  const db = await withYears(new D1Shim());
  const proof = async (value) => {
    db.db.exec(`UPDATE movies SET decade = ${value} WHERE id = '78'`);
    db.db.query(`INSERT OR REPLACE INTO provenance (id, to_kind, to_ref, field, from_kind, from_ref, rel, asserted_by, inputs_hash, value_hash, produced_at)
      VALUES ('movies:78:decade','movies','78','decade','http:blurb','x','derived_from','hub',?,?,'2026-09-05T00:00:00.000Z')`)
      .run(await hex(LEGACY.inputs), await hex(LEGACY.value));
  };
  await proof(1990);
  const s = stub({ body: { decade: 2000 } });
  await deriveStale(db, ENV, "movies", db.db.query("SELECT * FROM movies").all(), { fetchImpl: s.fetchImpl });
  expect(s.calls.map((c) => c.url)).not.toContain("https://derivations.example/blurb");

  // An external writer that matched the old rendering pushes value and proof.
  db.db.exec("UPDATE movies SET decade = NULL WHERE id = '78'");
  const push = await ROUTES["/v1/rows/push"]({ table: "movies", columns: ["id", "decade", "updated_at"],
    rows: [{ id: "78", decade: 1990, updated_at: "2030-01-01T00:00:00.000Z" }] }, db);
  expect(push.rejected).toEqual([]);
  expect(db.db.query("SELECT decade FROM movies WHERE id = '78'").get().decade).toBe(1990);
});

test("a sparse push of an unrelated column does not re-derive from inputs it omitted", async () => {
  const db = await fresh();
  await db.prepare(`INSERT INTO catalog_properties (id, tbl, col, sort, type, derived_by, inputs) VALUES ('movies.blurb','movies','blurb',4,'text','http:blurb','["title"]')`).run();
  const replies = {
    "https://derivations.example/movie": { body: { title: "Blade Runner", genres: [] } },
    "https://derivations.example/blurb": { body: { blurb: "a blurb" } },
  };
  expect(await deriveRows(db, ENV, "movies", ["78"], { fetchImpl: stub((url) => replies[url]).fetchImpl })).toEqual({ derived: 2, failed: [] });
  const upstream = spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ blurb: "must not be asked" }));
  const tasks = [];
  try {
    const out = await ROUTES["/v1/rows/push"]({ table: "movies", columns: ["id", "status", "updated_at"],
      rows: [{ id: "78", status: "Finished", updated_at: "2030-01-01T00:00:00.000Z" }] }, db, ENV, { waitUntil: (p) => tasks.push(p) });
    expect(out.rejected).toEqual([]);
    await Promise.all(tasks);
    expect(upstream).not.toHaveBeenCalled();
    expect(db.db.query("SELECT blurb FROM movies WHERE id = '78'").get().blurb).toBe("a blurb");
  } finally { upstream.mockRestore(); }
});

// A wide derivation: one ISRC lookup producing `outputs` columns, 50 rows.
async function tracks(outputs) {
  const db = new D1Shim(), cols = Array.from({ length: outputs }, (_, i) => `o${i}`);
  db.db.exec(`CREATE TABLE catalog_properties (id TEXT PRIMARY KEY, tbl TEXT, col TEXT, label TEXT, sort INTEGER, type TEXT, required INTEGER, default_value TEXT, options TEXT, options_sql TEXT, min_items INTEGER, max_items INTEGER, pattern TEXT, ref_table TEXT, derived_by TEXT, inputs TEXT, immutable INTEGER, deprecated INTEGER, description TEXT, source TEXT, source_ref TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT)`);
  db.db.exec(`CREATE TABLE provenance (id TEXT PRIMARY KEY, from_kind TEXT, from_ref TEXT, to_kind TEXT, to_ref TEXT, rel TEXT, field TEXT, detail TEXT, asserted_by TEXT, inputs_hash TEXT, value_hash TEXT, produced_at TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT)`);
  db.db.exec(`CREATE TABLE tracks (id TEXT PRIMARY KEY, isrc TEXT, ${cols.map((c) => `${c} TEXT`).join(", ")}, created_at TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT)`);
  db.db.exec("INSERT INTO catalog_properties (id, tbl, col, sort, type) VALUES ('tracks.isrc','tracks','isrc',0,'text')");
  cols.forEach((c, i) => db.db.exec(`INSERT INTO catalog_properties (id, tbl, col, sort, type, derived_by, inputs) VALUES ('tracks.${c}','tracks','${c}',${i + 1},'text','http:isrc','["isrc"]')`));
  const ids = Array.from({ length: 50 }, (_, i) => `t${String(i).padStart(2, "0")}`);
  for (const id of ids) db.db.query("INSERT INTO tracks (id, isrc, updated_at) VALUES (?, ?, '2026-01-01T00:00:00.000Z')").run(id, `ISRC${id}`);
  const fetchImpl = async () => Response.json(Object.fromEntries(cols.map((c) => [c, "v"])));
  return { db, cols, ids, env: { DERIVATIONS: JSON.stringify({ isrc: { url: "https://derivations.example/isrc" } }) }, fetchImpl };
}
const counted = (fetchImpl) => { const calls = []; return { calls, fetchImpl: async (url, init) => { calls.push(JSON.parse(init.body).id); return fetchImpl(url, init); } }; };

test("freshness checks over many fresh proofs leave budget for the source calls", async () => {
  const { db, cols, ids, env, fetchImpl } = await tracks(12);
  // every output proven but the last: a per-cell scan reads 23 statements a row
  for (const id of ids) for (const c of cols.slice(0, -1)) {
    db.db.query(`INSERT INTO provenance (id, to_kind, to_ref, field, from_kind, from_ref, rel, asserted_by, inputs_hash, value_hash, produced_at)
      VALUES (?, 'tracks', ?, ?, 'http:isrc', 'x', 'derived_from', 'hub', ?, ?, '2026-01-02T00:00:00.000Z')`)
      .run(`tracks:${id}:${c}`, id, c, await hex(`["ISRC${id}"]`), await hex(""));
  }
  let statements = 0, beforeFirstCall = null;
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => { statements++; return prepare(sql); };
  const s = counted(async (url, init) => { beforeFirstCall ??= statements; return fetchImpl(url, init); });
  let out = await sweep(db, env, { fetchImpl: s.fetchImpl });
  expect(beforeFirstCall).toBeLessThan(30); // freshness is read in bulk, not per row or cell
  expect(out.derived).toBeGreaterThan(0);
  expect(s.calls.length).toBe(out.derived); // no fetched row lost its commit
  expect(out.derived + new Set(out.failed.map((f) => f.id)).size).toBe(50);
  for (let i = 0; out.failed.length && i < 5; i++) out = await sweep(db, env, { fetchImpl: s.fetchImpl });
  expect(out.failed).toEqual([]);
  expect(db.db.query(`SELECT count(*) AS n FROM tracks WHERE ${cols.at(-1)} = 'v'`).get().n).toBe(50);
});

test("a direct batch derives what its budget can commit and defers the rest before calling out", async () => {
  const { db, ids, env, fetchImpl } = await tracks(7);
  const s = counted(fetchImpl);
  const out = await deriveRows(db, env, "tracks", ids, { fetchImpl: s.fetchImpl });
  expect(out.derived).toBeGreaterThanOrEqual(21);
  expect(s.calls.length).toBe(out.derived);
  const pending = out.failed.map((f) => f.id);
  expect(new Set([...s.calls, ...pending]).size).toBe(50);
  for (const f of out.failed) expect(f).toMatchObject({ col: "o0", error: expect.stringContaining("budget") });
  const again = await deriveRows(db, env, "tracks", pending, { fetchImpl: s.fetchImpl });
  expect(s.calls.length).toBe(out.derived + again.derived);
});

// Prove every output of `ids` as of produced_at, then move the rows' clocks past it.
async function proveAll(db, cols, ids, producedAt = "2026-01-02T00:00:00.000Z", bumped = "2026-02-01T00:00:00.000Z") {
  for (const id of ids) {
    const isrc = db.db.query("SELECT isrc FROM tracks WHERE id = ?").get(id).isrc;
    for (const c of cols) db.db.query(`INSERT OR REPLACE INTO provenance (id, to_kind, to_ref, field, from_kind, from_ref, rel, asserted_by, inputs_hash, value_hash, produced_at)
      VALUES (?, 'tracks', ?, ?, 'http:isrc', 'x', 'derived_from', 'hub', ?, ?, ?)`).run(`tracks:${id}:${c}`, id, c, await hex(JSON.stringify([isrc])), await hex(""), producedAt);
  }
  db.db.query("UPDATE tracks SET updated_at = ?").run(bumped);
}

test("the sweep passes fresh timestamp-bumped candidates to reach a stale row, and never reports success short of it", async () => {
  const { db, cols, ids, env, fetchImpl } = await tracks(2);
  for (let i = 50; i < 60; i++) db.db.query("INSERT INTO tracks (id, isrc, updated_at) VALUES (?, ?, '2026-01-01T00:00:00.000Z')").run(`t${i}`, `ISRCt${i}`);
  await proveAll(db, cols, [...ids, ...Array.from({ length: 10 }, (_, i) => `t${50 + i}`)]);
  db.db.exec("UPDATE tracks SET isrc = 'CHANGED' WHERE id = 't59'"); // the 60th row's input changed
  const s = counted(fetchImpl);
  for (let i = 0; i < 3 && !s.calls.length; i++) {
    const out = await sweep(db, env, { fetchImpl: s.fetchImpl });
    if (!s.calls.length) expect(out.failed.length).toBeGreaterThan(0);
  }
  expect(s.calls).toEqual(["t59"]);
  expect(db.db.query("SELECT o0 FROM tracks WHERE id = 't59'").get().o0).toBe("v");
});

test("rows past the per-call limit are reported pending, never dropped silently", async () => {
  const { db, ids, env, fetchImpl } = await tracks(2);
  for (let i = 50; i < 60; i++) db.db.query("INSERT INTO tracks (id, isrc, updated_at) VALUES (?, ?, '2026-01-01T00:00:00.000Z')").run(`t${i}`, `ISRCt${i}`);
  const all = [...ids, ...Array.from({ length: 10 }, (_, i) => `t${50 + i}`)];
  const s = counted(fetchImpl);
  const out = await deriveStale(db, env, "tracks", all.map((id) => ({ id })), { fetchImpl: s.fetchImpl });
  expect(out.derived + new Set(out.failed.map((f) => f.id)).size).toBe(60);
});

test("a sweep whose scan share runs out says so and the next one resumes after it", async () => {
  const { queryBudget } = await import("../src/write.js");
  const { db, cols, ids, env, fetchImpl } = await tracks(2);
  for (let i = 50; i < 60; i++) db.db.query("INSERT INTO tracks (id, isrc, updated_at) VALUES (?, ?, '2026-01-01T00:00:00.000Z')").run(`t${i}`, `ISRCt${i}`);
  await proveAll(db, cols, [...ids, ...Array.from({ length: 10 }, (_, i) => `t${50 + i}`)]);
  db.db.exec("UPDATE tracks SET isrc = 'CHANGED' WHERE id = 't59'");
  const s = counted(fetchImpl);
  const first = await sweep(queryBudget(db, 120), env, { fetchImpl: s.fetchImpl, page: 3 });
  expect(s.calls).toEqual([]);
  expect(first.failed).toEqual([{ table: "tracks", id: null, col: null, error: expect.stringContaining("resumes") }]);
  const second = await sweep(queryBudget(db, 120), env, { fetchImpl: s.fetchImpl, page: 3 });
  expect(s.calls).toEqual(["t59"]);
  expect(second).toEqual({ derived: 1, failed: [] });
});

// A summary listed before its producer: first_year reads the year deezer derives.
async function songs() {
  const db = new D1Shim();
  db.db.exec(`CREATE TABLE catalog_properties (id TEXT PRIMARY KEY, tbl TEXT, col TEXT, label TEXT, sort INTEGER, type TEXT, required INTEGER, default_value TEXT, options TEXT, options_sql TEXT, min_items INTEGER, max_items INTEGER, pattern TEXT, ref_table TEXT, derived_by TEXT, inputs TEXT, immutable INTEGER, deprecated INTEGER, description TEXT, source TEXT, source_ref TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT)`);
  db.db.exec(`CREATE TABLE provenance (id TEXT PRIMARY KEY, from_kind TEXT, from_ref TEXT, to_kind TEXT, to_ref TEXT, rel TEXT, field TEXT, detail TEXT, asserted_by TEXT, inputs_hash TEXT, value_hash TEXT, produced_at TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT)`);
  db.db.exec("CREATE TABLE songs (id TEXT PRIMARY KEY, isrc TEXT, first_year INTEGER, year INTEGER, created_at TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT)");
  db.db.exec(`INSERT INTO catalog_properties (id, tbl, col, sort, type) VALUES ('songs.isrc','songs','isrc',0,'text')`);
  db.db.exec(`INSERT INTO catalog_properties (id, tbl, col, sort, type, derived_by, inputs) VALUES ('songs.first_year','songs','first_year',1,'int','http:first_year','["year"]')`);
  db.db.exec(`INSERT INTO catalog_properties (id, tbl, col, sort, type, derived_by, inputs) VALUES ('songs.year','songs','year',2,'int','http:deezer','["isrc"]')`);
  db.db.exec("INSERT INTO songs (id, isrc, updated_at) VALUES ('s1', 'ISRC1', '2026-01-01T00:00:00.000Z')");
  const env = { DERIVATIONS: JSON.stringify({ deezer: { url: "https://derivations.example/deezer" }, first_year: { url: "https://derivations.example/first_year" } }) };
  const source = { year: 1999 };
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push([url.split("/").at(-1), body.inputs]);
    return Response.json(url.endsWith("/deezer") ? { year: source.year } : { first_year: body.inputs.year });
  };
  return { db, env, source, calls, fetchImpl };
}

test("a derivation reading another's output runs after it, whatever the catalog order", async () => {
  const { db, env, calls, fetchImpl } = await songs();
  expect(await deriveRows(db, env, "songs", ["s1"], { fetchImpl })).toEqual({ derived: 2, failed: [] });
  expect(calls).toEqual([["deezer", { isrc: "ISRC1" }], ["first_year", { year: 1999 }]]);
  expect(db.db.query("SELECT first_year FROM songs").get().first_year).toBe(1999);
});

test("a summary is re-evaluated after its producer commits in the same pass", async () => {
  const { db, env, source, calls, fetchImpl } = await songs();
  await deriveRows(db, env, "songs", ["s1"], { fetchImpl });
  db.db.exec("UPDATE songs SET isrc = 'ISRC2', updated_at = '2030-01-01T00:00:00.000Z'");
  source.year = 2001;
  calls.length = 0;
  expect(await sweep(db, env, { fetchImpl })).toEqual({ derived: 2, failed: [] });
  expect(calls.map(([name]) => name)).toEqual(["deezer", "first_year"]);
  expect(db.db.query("SELECT first_year FROM songs").get().first_year).toBe(2001);
});

test("an input change in the same millisecond as the proof still re-derives", async () => {
  const { db, env, source, calls, fetchImpl } = await songs();
  await deriveRows(db, env, "songs", ["s1"], { fetchImpl });
  db.db.exec("UPDATE provenance SET produced_at = '2030-01-01T00:00:00.000Z'");
  db.db.exec("UPDATE songs SET isrc = 'ISRC2', updated_at = '2030-01-01T00:00:00.000Z'");
  source.year = 2001;
  calls.length = 0;
  await sweep(db, env, { fetchImpl });
  expect(calls.map(([name]) => name)).toContain("deezer");
  expect(db.db.query("SELECT year FROM songs").get().year).toBe(2001);
});

const NO_DATA = '{"no_data":true}';

test("a completed lookup without an output records a no-data proof, keeps the observed value and is not retried", async () => {
  const db = await fresh();
  db.db.exec("UPDATE movies SET genres = '[\"Observed\"]' WHERE id = '78'");
  const s = stub({ body: { _source_ref: "tmdb:movie/78@2026-09-04" } }); // a 200 no-match
  expect(await deriveRows(db, ENV, "movies", ["78"], { fetchImpl: s.fetchImpl })).toEqual({ derived: 1, failed: [] });
  const row = db.db.query("SELECT title, genres, updated_at FROM movies WHERE id = '78'").get();
  expect(row).toEqual({ title: null, genres: '["Observed"]', updated_at: "2026-09-04T00:00:00.000Z" });
  const proofs = db.db.query("SELECT field, from_ref, detail, inputs_hash, value_hash FROM provenance ORDER BY field").all();
  expect(proofs).toEqual([
    { field: "genres", from_ref: "tmdb:movie/78@2026-09-04", detail: NO_DATA, inputs_hash: await hex('["78"]'), value_hash: await hex('["Observed"]') },
    { field: "title", from_ref: "tmdb:movie/78@2026-09-04", detail: NO_DATA, inputs_hash: await hex('["78"]'), value_hash: await hex("") },
  ]);
  for (let i = 0; i < 2; i++) expect(await sweep(db, ENV, { fetchImpl: s.fetchImpl })).toEqual({ derived: 0, failed: [] });
  expect(s.calls).toHaveLength(1);
  // A later match replaces the no-data proof with an ordinary one.
  await deriveRows(db, ENV, "movies", ["78"], { fetchImpl: stub({ body: { title: "Blade Runner", genres: [] } }).fetchImpl });
  expect(db.db.query("SELECT detail FROM provenance WHERE field = 'title'").get().detail).toBe(null);
});

test("refresh is bounded: no-data proofs after no_data_refresh_days, value proofs only with refresh_days", async () => {
  const db = await fresh();
  const age = () => db.db.exec("UPDATE provenance SET produced_at = '2020-01-01T00:00:00.000Z'");
  let s = stub({ body: {} });
  await deriveRows(db, ENV, "movies", ["78"], { fetchImpl: s.fetchImpl });
  age();
  s = stub({ body: { title: "Blade Runner", genres: [] } });
  expect(await sweep(db, ENV, { fetchImpl: s.fetchImpl })).toEqual({ derived: 1, failed: [] });
  expect(s.calls).toHaveLength(1);
  age();
  expect(await sweep(db, ENV, { fetchImpl: s.fetchImpl })).toEqual({ derived: 0, failed: [] });
  expect(s.calls).toHaveLength(1);
  const endpoints = JSON.parse(ENV.DERIVATIONS);
  endpoints.tmdb_movie.refresh_days = 30;
  expect(await sweep(db, { DERIVATIONS: JSON.stringify(endpoints) }, { fetchImpl: s.fetchImpl })).toEqual({ derived: 1, failed: [] });
  expect(s.calls).toHaveLength(2);
  endpoints.tmdb_movie.no_data_refresh_days = 4000; // a no-data proof younger than this stays fresh
  await deriveRows(db, ENV, "movies", ["78"], { fetchImpl: stub({ body: {} }).fetchImpl });
  age();
  expect(await sweep(db, { DERIVATIONS: JSON.stringify(endpoints) }, { fetchImpl: s.fetchImpl })).toEqual({ derived: 0, failed: [] });
});

test("one table's backlog cannot take every later table's share of a sweep", async () => {
  const { db, env, fetchImpl } = await tracks(2);
  db.db.exec("CREATE TABLE zz (id TEXT PRIMARY KEY, isrc TEXT, label TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT)");
  db.db.exec(`INSERT INTO catalog_properties (id, tbl, col, sort, type, derived_by, inputs) VALUES ('zz.label','zz','label',1,'text','http:isrc','["isrc"]')`);
  db.db.exec("INSERT INTO zz (id, isrc, updated_at) VALUES ('z1', 'ISRCz', '2026-01-01T00:00:00.000Z')");
  const out = await sweep(db, env, { fetchImpl: async (url, init) => JSON.parse(init.body).tbl === "zz" ? Response.json({ label: "v" }) : fetchImpl(url, init) });
  expect(out.failed.some((f) => f.id && f.id.startsWith("t"))).toBe(true); // tracks still has a backlog
  expect(db.db.query("SELECT label FROM zz").get().label).toBe("v");
});
