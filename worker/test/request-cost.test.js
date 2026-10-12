import { expect, test } from "bun:test";
import worker from "../src/main.js";
import { hashToken, ensureAuthReady } from "../src/auth.js";
import { D1Shim } from "./d1shim.js";
import { ChangeSignal } from "../src/changes.js";

// Every D1 call from a Worker is a network round trip (~45 ms from the edge to
// the database), so a replica's read requests must not re-run idempotent setup
// each time: a cold download is hundreds of them. A batch is one round trip.
class Counting extends D1Shim {
  calls = 0;
  batching = false;
  statements = []; // every statement's SQL, batched or not
  prepare(sql) {
    const stmt = super.prepare(sql);
    for (const name of ["all", "run", "first", "raw"]) {
      const inner = stmt[name].bind(stmt);
      // Statements inside a batch travel in the batch's one round trip.
      stmt[name] = async (...args) => { if (!this.batching) this.calls++; this.statements.push(sql); return inner(...args); };
    }
    return stmt;
  }
  async batch(stmts) {
    this.calls++;
    this.batching = true;
    try { return await super.batch(stmts); } finally { this.batching = false; }
  }
}

async function hub() {
  const env = { HUB_TOKEN: "root", DB: new Counting(), AUTH_DB: new Counting() };
  env.DB.db.exec("CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT)");
  env.DB.db.exec("CREATE TABLE catalog_properties (id TEXT PRIMARY KEY, tbl TEXT, col TEXT, type TEXT, required INTEGER, sort INTEGER, options TEXT, inputs TEXT, default_value TEXT, options_sql TEXT, ref_table TEXT, derived_by TEXT, immutable INTEGER, deprecated INTEGER, created_at TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT)");
  await ensureAuthReady(env.AUTH_DB);
  await env.AUTH_DB.prepare("INSERT INTO _tokens (hash, name, scopes) VALUES (?, ?, ?)").bind(await hashToken("t-device"), "device", "full").run();
  const call = async (path, body) => {
    const pending = [];
    const response = await worker.fetch(new Request(`https://hub.test${path}`, {
      method: "POST", headers: { Authorization: "Bearer t-device", "Content-Type": "application/json" }, body: JSON.stringify(body),
    }), env, { waitUntil: (p) => pending.push(p) });
    const text = await response.text();
    expect({ status: response.status, text: response.status === 200 ? "" : text }).toEqual({ status: 200, text: "" });
    const calls = env.DB.calls + env.AUTH_DB.calls;
    while (pending.length) await pending.shift();
    return calls;
  };
  return { env, call };
}

const columns = ["id", "name", "updated_at", "deleted_at", "hub_at"];
const reads = [
  ["/v1/schema/pull", {}],
  ["/v1/rows/pull", { table: "people", columns, since: "", limit: 200 }],
  ["/v1/cursor", { tables: ["people"] }],
  ["/v1/stats", {}],
];

for (const [path, body] of reads.slice(1)) test(`a warm ${path} answers within a few D1 round trips`, async () => {
  const { env, call } = await hub();
  for (const [p, b] of reads) await call(p, b); // the isolate's first requests set up storage
  env.DB.calls = env.AUTH_DB.calls = 0;
  // Before: 30-33, from re-running every CREATE IF NOT EXISTS and the write
  // path's governance setup on each read; then 8, with the generic-state audit
  // (two batches) and the cursor's column probe on every read. Two of these
  // run after the response (the token's last-use stamp and the usage flush).
  expect(await call(path, body)).toBeLessThanOrEqual(4);
});

test("a read audits afresh as soon as the schema changes, and a write audits every time", async () => {
  const { env, call } = await hub();
  for (const [p, b] of reads) await call(p, b);
  // A tamper only a fresh audit sees: the very next read is denied...
  env.DB.db.exec("CREATE VIEW _governance_fake AS SELECT 1");
  expect((await rawCall(env, "/v1/stats", {})).status).toBe(403);
  // ...and so is a write, which never relies on an earlier verification.
  const denied = await rawCall(env, "/v1/rows/push", { table: "people", columns, rows: [] });
  expect(denied.status).toBe(403);
  env.DB.db.exec("DROP VIEW _governance_fake");
  expect((await rawCall(env, "/v1/stats", {})).status).toBe(200);
});

test("a write's failed audit makes the next read audit afresh too", async () => {
  const { env, call } = await hub();
  for (const [p, b] of reads) await call(p, b);
  // Catalog contents are data, so the schema stamp reads check does not move,
  // and reads execute no catalog SQL...
  env.DB.db.exec("INSERT INTO catalog_properties (id, tbl, col, type, options_sql) VALUES ('people.x', 'people', 'x', 'select', 'SELECT * FROM _governance_heads')");
  expect((await rawCall(env, "/v1/stats", {})).status).toBe(200);
  // ...but every write audits them, and its denial drops the isolate's verification.
  expect((await rawCall(env, "/v1/rows/push", { table: "people", columns, rows: [] })).status).toBe(403);
  expect((await rawCall(env, "/v1/stats", {})).status).toBe(403);
});

const AUDIT = "SELECT name,type,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name";
const setup = (env) => env.DB.statements.filter((sql) => /\bIF NOT EXISTS\b/.test(sql) && /_governance_/.test(sql));

test("a warm read skips the generic-state audit while the schema is unchanged", async () => {
  const { env, call } = await hub();
  for (const [p, b] of reads) await call(p, b);
  env.DB.statements = [];
  await call("/v1/cursor", { tables: ["people"] });
  await call("/v1/rows/pull", { table: "people", columns, since: "", limit: 200 });
  expect(env.DB.statements.filter((sql) => sql === AUDIT)).toEqual([]);
});

test("a warm write audits but skips governance setup while the schema is unchanged", async () => {
  const { env, call } = await hub();
  for (const [p, b] of reads) await call(p, b);
  const push = (name, at) => call("/v1/rows/push", { table: "people", columns: ["id", "name", "updated_at"], rows: [{ id: "a", name, updated_at: at }] });
  // The hub creates its history table on the first push: DDL the next write
  // sets up for, once.
  await push("A", "2026-01-01T00:00:00.000Z");
  await push("A2", "2026-01-01T00:00:00.500Z");
  env.DB.statements = [];
  env.DB.calls = env.AUTH_DB.calls = 0;
  const trips = await push("B", "2026-01-01T00:00:01.000Z");
  expect(env.DB.statements.filter((sql) => sql === AUDIT).length).toBe(1);
  expect(setup(env)).toEqual([]);
  // Before: 42, of which 19 re-ran governance setup that a fingerprint of the
  // audited schema proves unnecessary.
  expect(trips).toBeLessThanOrEqual(25);
});

// A new isolate over an already set-up database: production spreads requests
// over many isolates, so most writes land on one that has never written.
function newIsolate(env) {
  const fresh = new Counting();
  fresh.db.close();
  fresh.db = env.DB.db;
  env.DB = fresh;
}

test("a new isolate's first write runs governance setup, then one audit", async () => {
  const { env, call } = await hub();
  for (const [p, b] of reads) await call(p, b);
  const push = (name, at) => call("/v1/rows/push", { table: "people", columns: ["id", "name", "updated_at"], rows: [{ id: "a", name, updated_at: at }] });
  await push("A", "2026-01-01T00:00:00.000Z");
  await push("A2", "2026-01-01T00:00:00.500Z");
  newIsolate(env);
  env.DB.statements = [];
  await push("B", "2026-01-01T00:00:01.000Z");
  expect(env.DB.statements.filter((sql) => sql === AUDIT).length).toBe(1);
});

test("a new isolate's governance setup costs a handful of round trips", async () => {
  const { env, call } = await hub();
  for (const [p, b] of reads) await call(p, b);
  const push = (name, at) => call("/v1/rows/push", { table: "people", columns: ["id", "name", "updated_at"], rows: [{ id: "a", name, updated_at: at }] });
  await push("A", "2026-01-01T00:00:00.000Z");
  await push("A2", "2026-01-01T00:00:00.500Z");
  newIsolate(env);
  env.DB.calls = 0;
  await push("B", "2026-01-01T00:00:01.000Z");
  const first = env.DB.calls;
  env.DB.calls = 0;
  await push("C", "2026-01-01T00:00:02.000Z");
  // Before: 21 more than a warm write - each idempotent CREATE and continuity
  // read was its own round trip, plus a second audit.
  expect(first - env.DB.calls).toBeLessThanOrEqual(8);
});

test("a write after out-of-band DDL runs governance setup again", async () => {
  const { env, call } = await hub();
  for (const [p, b] of reads) await call(p, b);
  const push = (table, at) => call("/v1/rows/push", { table, columns: ["id", "name", "updated_at"], rows: [{ id: "a", name: "A", updated_at: at }] });
  await push("people", "2026-01-01T00:00:00.000Z");
  const guards = (t) => env.DB.db.query(`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='${t}' AND name GLOB '_governance_rows_*'`).all().length;
  expect(guards("people")).toBe(3);
  // A guard removed behind the hub's back is back after the next write.
  const guard = env.DB.db.query("SELECT name FROM sqlite_master WHERE name GLOB '_governance_rows_*_update' AND tbl_name='people'").get().name;
  env.DB.db.exec(`DROP TRIGGER "${guard}"`);
  await push("people", "2026-01-01T00:00:01.000Z");
  expect(guards("people")).toBe(3);
  // So is a guard for a table another isolate's replay created.
  env.DB.db.exec("CREATE TABLE later2 (id TEXT PRIMARY KEY, name TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT)");
  await push("people", "2026-01-01T00:00:02.000Z");
  expect(guards("later2")).toBe(3);
});

test("a cursor read after a schema replay still sees the new table", async () => {
  const { env, call } = await hub();
  for (const [p, b] of reads) await call(p, b);
  // Asked before it exists: the isolate now remembers 'later' as missing.
  expect((await (await rawCall(env, "/v1/cursor", { tables: ["people", "later"] })).json()).tables).toEqual({ people: "", later: "" });
  await call("/v1/schema/push", { entries: [{ applied_at: "2026-01-01T00:00:00.000Z", ddl: "CREATE TABLE later (id TEXT PRIMARY KEY, name TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT)" }] });
  env.DB.db.exec("INSERT INTO later VALUES ('a','A','2026-01-02T00:00:00.000Z',NULL,'2026-01-02T00:00:00.000Z')");
  const marks = await (await rawCall(env, "/v1/cursor", { tables: ["people", "later"] })).json();
  expect(marks.tables).toEqual({ people: "", later: "2026-01-02T00:00:00.000Z" });
});

async function rawCall(env, path, body) {
  return worker.fetch(new Request(`https://hub.test${path}`, {
    method: "POST", headers: { Authorization: "Bearer t-device", "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), env, { waitUntil() {} });
}

test("write routes still install governance storage for tables created after the isolate warmed up", async () => {
  const { env, call } = await hub();
  for (const [p, b] of reads) await call(p, b);
  env.DB.db.exec("CREATE TABLE later (id TEXT PRIMARY KEY, name TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT)");
  await call("/v1/rows/push", { table: "later", columns: ["id", "name", "updated_at"], rows: [{ id: "a", name: "A", updated_at: "2026-01-01T00:00:00.000Z" }] });
  const triggers = env.DB.db.query("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='later' AND name GLOB '_governance_rows_*'").all();
  expect(triggers.length).toBeGreaterThan(0);
});

// --- subscription long polls -------------------------------------------------
// Page Archiver and Media Center's offline job each hold ~120 polls an hour.
// Re-reading the subscription and its events every second cost three D1
// statements per held second; a held poll waits on the change signal instead.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function changeSignal() {
  const data = new Map(), loading = [];
  const signal = new ChangeSignal({
    storage: { get: async (k) => data.get(k), put: async (k, v) => void data.set(k, v) },
    blockConcurrencyWhile: (fn) => loading.push(fn()),
    getWebSockets: () => [],
  });
  await Promise.all(loading);
  return { idFromName: (name) => name, get: () => ({ fetch: (url, init) => signal.fetch(new Request(url, init)) }) };
}

async function subscribed() {
  const { env, call } = await hub();
  env.CHANGES = await changeSignal();
  env.DB.db.exec("CREATE TABLE catalog_tables (id TEXT PRIMARY KEY, kind TEXT, deleted_at TEXT); INSERT INTO catalog_tables VALUES ('people', 'table', NULL)");
  const created = await worker.fetch(new Request("https://hub.test/v1/subscriptions", {
    method: "POST", headers: { Authorization: "Bearer root" },
    body: JSON.stringify({ label: "Cost", start: "now", sources: [{ table: "people", columns: ["name"] }] }),
  }), env, { waitUntil() {} });
  const { id } = await created.json();
  await env.AUTH_DB.prepare("INSERT INTO _tokens (hash, name, scopes) VALUES (?, ?, ?)")
    .bind(await hashToken("t-consumer"), "consumer", `subscriptions:consume:${id},tables:read:people`).run();
  const poll = (wait, signal) => worker.fetch(new Request(`https://hub.test/v1/subscriptions/${id}/events?wait=${wait}`, {
    headers: { Authorization: "Bearer t-consumer" }, signal,
  }), env, { waitUntil() {} });
  const bump = (tables) => env.CHANGES.get().fetch("https://change-signal/", { method: "POST", body: JSON.stringify({ tables }) });
  expect((await poll(0)).status).toBe(200); // the isolate's first poll
  return { env, id, poll, bump, call };
}

test("an idle subscription long poll reads D1 a constant number of times, not three a second", async () => {
  const { env, id, poll } = await subscribed();
  env.DB.statements = [];
  const started = Date.now();
  const response = await poll(3);
  expect(await response.json()).toEqual({ subscription_id: id, delivery_id: null, through_seq: "0", events: [] });
  expect(Date.now() - started).toBeGreaterThanOrEqual(2900);
  console.log(`idle 3 s subscription poll: statements=${env.DB.statements.length}`);
  // Before: 14 - the route's own load, then the subscription and its events
  // re-read at 0, 1, 2 and 3 s. Now: the load, a check at the start and one at
  // the deadline.
  expect(env.DB.statements.length).toBeLessThanOrEqual(8);
});

test("commits to unwatched tables do not wake a held subscription poll", async () => {
  const { env, poll, bump } = await subscribed();
  env.DB.statements = [];
  const held = poll(2);
  for (let i = 0; i < 5; i++) { await sleep(200); await bump(["notes"]); }
  expect((await (await held).json()).events).toEqual([]);
  expect(env.DB.statements.length).toBeLessThanOrEqual(8);
});

test("a commit to a watched table wakes a held subscription poll at once", async () => {
  const { poll, call } = await subscribed();
  const started = Date.now();
  const held = poll(5);
  await sleep(200);
  await call("/v1/rows/push", { table: "people", columns: ["id", "name", "updated_at"], rows: [{ id: "a", name: "Ada", updated_at: "2026-01-01T00:00:00.000Z" }] });
  const body = await (await held).json();
  expect(body.events.map((e) => e.changes)).toEqual([[{ column: "name", old_value: null, new_value: "Ada" }]]);
  // Before: the next once-a-second re-read found it, about 1 s in.
  expect(Date.now() - started).toBeLessThan(800);
});

test("a cancelled subscription poll stops waiting and answers 499", async () => {
  const { poll } = await subscribed();
  const controller = new AbortController(), started = Date.now();
  const held = poll(5, controller.signal);
  await sleep(100);
  controller.abort();
  const response = await held;
  expect(response.status).toBe(499);
  expect(await response.json()).toEqual({ error: "request_cancelled" });
  expect(Date.now() - started).toBeLessThan(1000);
});
