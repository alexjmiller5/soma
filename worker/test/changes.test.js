// Instant sync: replicas long-poll the hub's change sequence instead of
// polling every 30 s. Only a commit that changes replicated state may move it,
// or a replica re-pushing no-op or rejected rows would wake every replica forever.
import { expect, test } from "bun:test";
import worker, { ROUTES } from "../src/index.js";
import { ChangeSignal, PUSH_GAP_MS, withChangeSignal } from "../src/changes.js";
import { D1Shim } from "./d1shim.js";

function storage() {
  const data = new Map();
  return { get: async (k) => data.get(k), put: async (k, v) => void data.set(k, v) };
}

// The runtime holds every request until blockConcurrencyWhile settles.
async function signal(store = storage()) {
  const { state, loaded } = socketState(store);
  const s = new ChangeSignal(state);
  await loaded();
  return s;
}

const wait = (s, query) => s.fetch(new Request(`https://change-signal/?${query}`));
const bump = (s) => s.fetch(new Request("https://change-signal/", { method: "POST" }));
const seqOf = async (response) => (await response).json().then((b) => b.seq);

test("a waiter without a known sequence gets the current one at once", async () => {
  const s = await signal();
  await bump(s);
  expect(await seqOf(wait(s, "wait=25"))).toBe(1);
});

test("a stale sequence returns at once; a current one is held until a bump", async () => {
  const s = await signal();
  expect(await seqOf(wait(s, "since=7&wait=25"))).toBe(0);
  const held = wait(s, "since=0&wait=25");
  let done = false;
  held.then(() => (done = true));
  await new Promise((r) => setTimeout(r, 50));
  expect(done).toBe(false);
  await bump(s);
  expect(await seqOf(held)).toBe(1);
});

test("a held waiter times out with the unchanged sequence", async () => {
  const s = await signal();
  const started = Date.now();
  expect(await seqOf(wait(s, "since=0&wait=1"))).toBe(0);
  expect(Date.now() - started).toBeGreaterThanOrEqual(900);
});

test("the sequence survives the object being evicted", async () => {
  const store = storage();
  await bump(await signal(store));
  await bump(await signal(store));
  expect(await seqOf(wait(await signal(store), "wait=0"))).toBe(2);
});

// A CHANGES binding that counts bumps, shaped like a Durable Object namespace.
async function changesBinding() {
  const s = await signal();
  const bumps = [];
  return {
    bumps,
    idFromName: (name) => name,
    get: () => ({
      fetch: (url, init) => {
        if (init?.method === "POST") bumps.push(url);
        return s.fetch(new Request(url, init));
      },
    }),
  };
}

async function peopleDb() {
  const db = new D1Shim();
  await db.prepare(
    "CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT)",
  ).run();
  return db;
}

function inRequest(env, fn) {
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  return withChangeSignal(env, ctx, fn).then(async (out) => {
    await Promise.all(pending);
    return out;
  });
}

const cols = ["id", "name", "updated_at"];
const T1 = "2026-10-01T00:00:00.000Z", T2 = "2026-10-02T00:00:00.000Z";
const push = (env, db, rows) =>
  inRequest(env, () => ROUTES["/v1/rows/push"]({ table: "people", columns: cols, rows }, db, env));

test("a push bumps only when it changes a row", async () => {
  const CHANGES = await changesBinding(), env = { CHANGES }, db = await peopleDb();
  await push(env, db, [{ id: "a", name: "Ada", updated_at: T2 }]);
  expect(CHANGES.bumps.length).toBe(1);
  // the same revision again, and an older one: accepted no-ops, no wake-up
  await push(env, db, [{ id: "a", name: "Ada", updated_at: T2 }]);
  await push(env, db, [{ id: "a", name: "Old", updated_at: T1 }]);
  expect(CHANGES.bumps.length).toBe(1);
  // a rejected row (malformed timestamp) changes nothing either
  const out = await push(env, db, [{ id: "b", name: "Bad", updated_at: "yesterday" }]);
  expect(out.rejected.length).toBe(1);
  expect(CHANGES.bumps.length).toBe(1);
  await push(env, db, [{ id: "a", name: "Grace", updated_at: "2026-10-03T00:00:00.000Z" }]);
  expect(CHANGES.bumps.length).toBe(2);
});

test("schema push bumps only when it applies DDL", async () => {
  const CHANGES = await changesBinding(), env = { CHANGES }, db = await peopleDb();
  for (const sql of ["CREATE TABLE IF NOT EXISTS _schema_log (id INTEGER PRIMARY KEY, applied_at TEXT, ddl TEXT)"])
    await db.prepare(sql).run();
  const entries = [{ applied_at: T1, ddl: "ALTER TABLE people ADD COLUMN bio TEXT" }];
  await inRequest(env, () => ROUTES["/v1/schema/push"]({ entries }, db, env));
  expect(CHANGES.bumps.length).toBe(1);
  await inRequest(env, () => ROUTES["/v1/schema/push"]({ entries }, db, env));
  expect(CHANGES.bumps.length).toBe(1);
});

test("writes outside a request scope or without the binding never fail", async () => {
  const db = await peopleDb();
  const out = await ROUTES["/v1/rows/push"]({ table: "people", columns: cols, rows: [{ id: "a", name: "Ada", updated_at: T2 }] }, db);
  expect(out.upserted).toBe(1);
  await push({}, db, [{ id: "a", name: "Grace", updated_at: "2026-10-03T00:00:00.000Z" }]);
});

async function hub(scopes) {
  const CHANGES = await changesBinding();
  const env = { HUB_TOKEN: "operator", AUTH_DB: new D1Shim(), DB: await peopleDb(), CHANGES };
  const ctx = { waitUntil() {} };
  const mint = await worker.fetch(new Request("https://hub.test/v1/tokens/create", {
    method: "POST", headers: { Authorization: "Bearer operator" },
    body: JSON.stringify({ name: "replica", scopes }),
  }), env, ctx);
  const { token } = await mint.json();
  const call = (path, method = "GET", body) => worker.fetch(new Request(`https://hub.test${path}`, {
    method, headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body),
  }), env, ctx);
  return { call, CHANGES };
}

test("GET /v1/changes serves readers and wakes on a pushed change", async () => {
  const { call } = await hub("full");
  const first = await call("/v1/changes?wait=0");
  expect(first.status).toBe(200);
  const { seq } = await first.json();
  const held = call(`/v1/changes?since=${seq}&wait=25`);
  const pushed = await call("/v1/rows/push", "POST", { table: "people", columns: cols, rows: [{ id: "a", name: "Ada", updated_at: T2 }] });
  expect((await pushed.json()).upserted).toBe(1);
  expect((await (await held).json()).seq).toBe(seq + 1);
});

test("GET /v1/changes needs table read access and validates its query", async () => {
  expect((await (await hub("tables:read")).call("/v1/changes?wait=0")).status).toBe(200);
  expect((await (await hub("streams:append")).call("/v1/changes?wait=0")).status).toBe(403);
  const { call } = await hub("full");
  expect((await call("/v1/changes?since=x&wait=0")).status).toBe(400);
  expect((await call("/v1/changes?wait=-1")).status).toBe(400);
});

// A cheap quiet round: the cursor also answers for the schema log, so a replica
// skips the whole-log pull while neither side's log has moved.
test("the cursor reports the schema log mark and tolerates tables the hub lacks", async () => {
  const db = await peopleDb();
  await db.prepare("CREATE TABLE _schema_log (id INTEGER PRIMARY KEY, applied_at TEXT, ddl TEXT)").run();
  const before = await ROUTES["/v1/cursor"]({ tables: ["people", "renamed_away"] }, db);
  expect(before.schema).toBe(0);
  expect(before.tables.renamed_away).toBe("");
  await ROUTES["/v1/schema/push"]({ entries: [{ applied_at: T1, ddl: "ALTER TABLE people ADD COLUMN bio TEXT" }] }, db);
  expect((await ROUTES["/v1/cursor"]({ tables: ["people"] }, db)).schema).toBe(1);
});

// --- WebSocket wake signal ---------------------------------------------------
// Workers provide WebSocketPair and the hibernation auto-response pair; Bun does
// not. These stand-ins record what the object sends and accepts.
class FakeSocket {
  sent = [];
  closed = null;
  send(message) { this.sent.push(message); }
  close(code, reason) { this.closed = { code, reason }; }
}
globalThis.WebSocketPair ??= class { constructor() { this[0] = new FakeSocket(); this[1] = new FakeSocket(); } };
globalThis.WebSocketRequestResponsePair ??= class { constructor(request, response) { Object.assign(this, { request, response }); } };

function socketState(store = storage()) {
  const accepted = [], loading = [];
  const state = {
    storage: store,
    autoResponse: null,
    blockConcurrencyWhile: (fn) => loading.push(fn()),
    acceptWebSocket: (ws) => accepted.push(ws),
    getWebSockets: () => accepted,
    setWebSocketAutoResponse: (pair) => (state.autoResponse = pair),
  };
  return { state, accepted, loaded: () => Promise.all(loading) };
}
const upgrade = (s, protocols) => s.fetch(new Request("https://change-signal/", {
  headers: { Upgrade: "websocket", ...(protocols ? { "Sec-WebSocket-Protocol": protocols } : {}) },
}));
const bumpTables = (s, tables) =>
  s.fetch(new Request("https://change-signal/", { method: "POST", body: JSON.stringify({ tables }) }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("a socket gets one coalesced message per burst naming every changed table", async () => {
  const { state, accepted, loaded } = socketState();
  const s = new ChangeSignal(state);
  await loaded();
  const response = await upgrade(s, "soma-changes-v1, soma-token.secret");
  expect(response.status).toBe(101);
  // The selected protocol is echoed; the token never is.
  expect(response.headers.get("Sec-WebSocket-Protocol")).toBe("soma-changes-v1");
  expect(accepted).toHaveLength(1);
  await bumpTables(s, ["people"]);
  await bumpTables(s, ["notes"]);
  await bumpTables(s, ["people"]);
  expect(accepted[0].sent).toEqual([]);
  await sleep(150);
  expect(accepted[0].sent.map((m) => JSON.parse(m))).toEqual([{ seq: 3, tables: ["notes", "people"] }]);
  await bumpTables(s, ["tasks"]);
  await sleep(150);
  expect(accepted[0].sent.map((m) => JSON.parse(m)).at(-1)).toEqual({ seq: 4, tables: ["tasks"] });
});

test("keepalive pings are answered without waking the object", async () => {
  const { state } = socketState();
  new ChangeSignal(state);
  expect(state.autoResponse).toMatchObject({ request: "ping", response: "pong" });
});

test("a socket that offered no protocol gets none back, and long polls still wake", async () => {
  const { state, loaded } = socketState();
  const s = new ChangeSignal(state);
  await loaded();
  expect((await upgrade(s)).headers.get("Sec-WebSocket-Protocol")).toBeNull();
  const held = wait(s, "since=0&wait=25");
  await bumpTables(s, ["people"]);
  expect(await seqOf(held)).toBe(1);
});

// A CHANGES binding backed by a real signal that records each bump's tables.
async function tablesBinding() {
  const { state, accepted, loaded } = socketState();
  const s = new ChangeSignal(state);
  await loaded();
  const bodies = [];
  return {
    bodies, accepted,
    idFromName: (name) => name,
    get: () => ({
      fetch: async (url, init) => {
        const request = url instanceof Request ? url : new Request(url, init);
        if (request.method === "POST") bodies.push(await request.clone().json());
        return s.fetch(request);
      },
    }),
  };
}

test("writers name the tables they committed", async () => {
  const CHANGES = await tablesBinding(), env = { CHANGES }, db = await peopleDb();
  await push(env, db, [{ id: "a", name: "Ada", updated_at: T2 }]);
  await db.prepare("CREATE TABLE IF NOT EXISTS _schema_log (id INTEGER PRIMARY KEY, applied_at TEXT, ddl TEXT)").run();
  await inRequest(env, () => ROUTES["/v1/schema/push"]({ entries: [{ applied_at: T1, ddl: "ALTER TABLE people ADD COLUMN bio TEXT" }] }, db, env));
  expect(CHANGES.bodies).toEqual([{ tables: ["people"] }, { tables: ["_schema_log"] }]);
});

async function socketHub(scopes) {
  const CHANGES = await tablesBinding();
  const env = { HUB_TOKEN: "operator", AUTH_DB: new D1Shim(), DB: await peopleDb(), CHANGES, CORS_ORIGINS: "https://app.test" };
  const ctx = { waitUntil() {} };
  const mint = await worker.fetch(new Request("https://hub.test/v1/tokens/create", {
    method: "POST", headers: { Authorization: "Bearer operator" },
    body: JSON.stringify({ name: "replica", scopes }),
  }), env, ctx);
  const { token } = await mint.json();
  const open = (headers) => worker.fetch(new Request("https://hub.test/v1/changes", {
    headers: { Upgrade: "websocket", ...headers },
  }), env, ctx);
  return { token, open, CHANGES };
}

test("GET /v1/changes upgrades a reader to a socket; browsers authenticate with the token subprotocol", async () => {
  const { token, open, CHANGES } = await socketHub("full");
  const native = await open({ Authorization: `Bearer ${token}` });
  expect(native.status).toBe(101);
  // A browser cannot set headers on a WebSocket: the token rides as a subprotocol.
  const browser = await open({ Origin: "https://app.test", "Sec-WebSocket-Protocol": `soma-changes-v1, soma-token.${token}` });
  expect(browser.status).toBe(101);
  expect(browser.headers.get("Sec-WebSocket-Protocol")).toBe("soma-changes-v1");
  // CORS never rewraps the upgrade: a copied 101 would lose its socket.
  expect(browser.headers.get("Access-Control-Allow-Origin")).toBeNull();
  expect(CHANGES.accepted).toHaveLength(2);
  expect((await open({ "Sec-WebSocket-Protocol": "soma-changes-v1, soma-token.wrong" })).status).toBe(403);
  expect((await open({})).status).toBe(403);
});

test("the socket needs table read access, like the long poll", async () => {
  const { token, open } = await socketHub("streams:append");
  expect((await open({ Authorization: `Bearer ${token}` })).status).toBe(403);
});

function alarmStorage() {
  const s = storage();
  let alarm = null;
  return { ...s, getAlarm: async () => alarm, setAlarm: async (t) => void (alarm = t), get alarm() { return alarm; } };
}

test("a change sends a background push at once, then one trailing push per gap", async () => {
  const store = alarmStorage();
  const { state, loaded } = socketState(store);
  const s = new ChangeSignal(state, { APNS_CONFIG: JSON.stringify({ deploymentIdentity: "d", teamId: "TEAMTEST01", keyId: "KEYTEST001",
    profiles: [{ id: "phone", platform: "ios", topic: "org.example.phone", environment: "production" }] }), APNS_PRIVATE_KEY: "k" });
  await loaded();
  let pushes = 0;
  s.deliver = async () => void pushes++;
  await bumpTables(s, ["people"]);
  await sleep(150);
  expect(pushes).toBe(1);
  expect(store.alarm).toBeNull();
  await bumpTables(s, ["people"]);
  await sleep(150);
  expect(pushes).toBe(1);
  expect(store.alarm).toBeGreaterThan(Date.now() + PUSH_GAP_MS - 5_000);
  await s.alarm();
  expect(pushes).toBe(2);
});

test("without push configuration a change never schedules a push", async () => {
  const store = alarmStorage();
  const { state, loaded } = socketState(store);
  const s = new ChangeSignal(state, {});
  await loaded();
  let pushes = 0;
  s.deliver = async () => void pushes++;
  await bumpTables(s, ["people"]);
  await sleep(150);
  expect(pushes).toBe(0);
  expect(await store.get("nextPush")).toBeUndefined();
});

// --- table-filtered waits ----------------------------------------------------
// Subscription long polls wait for commits naming their source tables only, so
// every other commit on the hub costs them nothing.

// The seq a wait answers within half a second, or "held".
const soon = (seq) => Promise.race([seq, sleep(500).then(() => "held")]);

test("a waiter for named tables sleeps through other tables' commits", async () => {
  const s = await signal();
  const held = seqOf(wait(s, "since=0&wait=25&table=articles"));
  await bumpTables(s, ["notes"]);
  expect(await soon(held)).toBe("held");
  await bumpTables(s, ["Articles"]); // SQLite table names ignore case
  expect(await soon(held)).toBe(2);
});

test("a waiter for named tables returns at once for a change it could have missed", async () => {
  const store = storage();
  const s = await signal(store);
  await bumpTables(s, ["articles"]);
  await bumpTables(s, ["notes"]);
  // Committed after the caller read its sequence, before it waited.
  expect(await soon(seqOf(wait(s, "since=0&wait=25&table=articles")))).toBe(2);
  // Only an unrelated change since: held until the wait runs out.
  const started = Date.now();
  expect(await seqOf(wait(s, "since=1&wait=0.3&table=articles"))).toBe(2);
  expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  // An evicted object lost which tables earlier commits named, and a commit
  // that names none may have touched any: both count as a change.
  const reloaded = await signal(store);
  expect(await soon(seqOf(wait(reloaded, "since=1&wait=25&table=articles")))).toBe(2);
  const held = seqOf(wait(reloaded, "since=2&wait=25&table=articles"));
  await bump(reloaded);
  expect(await soon(held)).toBe(3);
});

test("a purge names the tables it hard-deleted from", async () => {
  const CHANGES = await tablesBinding(), env = { CHANGES }, db = await peopleDb();
  await db.prepare("CREATE TABLE purges (id TEXT PRIMARY KEY, tbl TEXT, row_id TEXT, col TEXT, purged_at TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT)").run();
  await push(env, db, [{ id: "a", name: "Ada", updated_at: T1 }]);
  await inRequest(env, () => ROUTES["/v1/rows/push"]({ table: "purges", columns: ["id", "tbl", "row_id", "col", "purged_at", "updated_at"],
    rows: [{ id: "m", tbl: "people", row_id: "a", col: null, purged_at: T2, updated_at: T2 }] }, db, env));
  expect((await db.prepare("SELECT id FROM people").all()).results).toEqual([]);
  expect(CHANGES.bodies.map((b) => b.tables)).toEqual([["people"], ["purges"], ["people"]]);
});
