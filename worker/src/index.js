// soma hub: the sync service. Speaks the narrow sync protocol over HTTP,
// keeps the canonical replica in D1, and writes tiered SQL backups to R2.
//
// Auth is deliberately behind one seam (`authenticate`): today a shared bearer
// token identifies the single tenant. Swapping in real per-user accounts means
// changing that function and nothing else — no route, no query, no sync logic
// knows how the caller was authenticated.

import { pushChecked, queryBudget, checkedReads, readGuards } from "./write.js";
import {pushConfiguration,pushCapability,pushRegistrationRoute,handlePushRegistration} from './apple-push.js';
import {handleCreation,creationCapability,hasCreationScope,creationPolicies,creationGrant} from "./creation.js";
import {captureGateway,captureCapability} from './capture-gateway.js';
import {rowsQuery} from './rows-query.js';
import {consumerConfig, catalogProjection} from './consumer-config.js';
import { patchChecked } from "./patch.js";
import { PURGES, applyPurges, markersFor, purgeIndex, uncovered } from "./purge.js";
import { deriveRows, deriveStale, sweep } from "./derive.js";
import { ident, qident, sha256hex, validatePush, validEditTimestamp } from "./validate.js";
import { TOKENS_TABLE, ensureAuthReady, hashToken, authorityStatement, readGovernanceAuthority, governanceAuthorityStatement, governanceAuthority } from "./auth.js";
import { governanceOperation, governanceFailure } from './governance-protocol.js';
import { ensureEvidenceStorage } from './governance-evidence.js';
import {assertGenericBody,assertGenericDDL,assertGenericStateBatched,schemaStamp} from './governance-isolation.js';
import {handleGovernance} from './governance.js';
import {handleChangesetGovernance,canChangeset,changesetGovernanceLimits} from './changeset-governance.js';
import {ensureChangesetStorage} from './changeset-store.js';
import {configuration as governanceConfiguration,limits as governanceLimits} from './governance-preview.js';
import {ensureProposalStorage} from './governance-proposals.js';
import { putFile, deleteFile, rehomeFile, fileHeaders, listFiles } from "./files.js";
import { ensureUsage, notify } from "./usage.js";
import { changesRoute, markChanged, socketToken, withChangeSignal } from "./changes.js";
import { backup } from "./backup.js";
import { backupsAllowed, handleBackups } from "./backups.js";
import { handleLogin, loginPath } from "./login.js";
import { applySubscriptionSchema, handleSubscription } from "./subscriptions.js";
import { hasSchemaAccess, scopedReplicaUnsupported, sessionCapabilities, broadTableAccess, authorizeTable, authorizeRead, authorizeRowPatch, authorizeEdges, edgePolicy, scopedPatchTable, scopedTable, scopedQuery, prefetchTables, scopedRows, scopedOptions, scopedResult, ScopeDenied } from "./scopes.js";

// Must match the trigger in wrangler.jsonc.
const SWEEP_CRON = "*/15 * * * *";

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const RENAME_TABLE = /^\s*ALTER\s+TABLE\s+\S+\s+RENAME\s+TO\b/i;

const PLUMBING = [
  `CREATE TABLE IF NOT EXISTS _schema_log (
    id INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    ddl TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS _sync_state (key TEXT PRIMARY KEY, value TEXT)`,
  // Cached row counts behind /v1/stats.
  `CREATE TABLE IF NOT EXISTS _table_stats (tbl TEXT PRIMARY KEY, rows INTEGER NOT NULL, computed_at TEXT NOT NULL)`,
];

// Constant-time compare so a token can't be recovered by timing the response.
function tokensMatch(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// THE AUTH SEAM. Returns a tenant handle {db, authDb, archive, scopes} or null.
// Accepts Bearer (the CLI, dashboards) and HTTP Basic with the token as the
// password (clients that only speak Basic, e.g. OwnTracks).
//
// Two tiers: the HUB_TOKEN Worker secret is the ADMIN/root credential (full
// access + token management; lives only in 1Password and on the owner's
// machines). Everything else authenticates against the _tokens table in AUTH_DB -
// scoped, individually revocable, minted via /v1/tokens/* with the admin
// token. Tokens are stored as SHA-256 hashes; a lost D1 leaks no secrets.
// Resolved once per request: the usage meter (src/usage.js) authenticates to
// attribute a request before the hub routes it, and both get the same tenant.
const tenants = new WeakMap();
const lastUseStamped = new Map();
const LAST_USE_STAMP_MS = 60_000;
function authenticate(request, env, ctx) {
  if (!tenants.has(request)) tenants.set(request, resolveTenant(request, env, ctx));
  return tenants.get(request);
}

async function resolveTenant(request, env, ctx) {
  const header = request.headers.get("Authorization") || "";
  let token = "";
  if (header.startsWith("Bearer ")) {
    token = header.slice(7);
  } else if (header.startsWith("Basic ")) {
    try {
      token = atob(header.slice(6)).split(":").slice(1).join(":");
    } catch {
      return null;
    }
  } else if (new URL(request.url).pathname === "/v1/changes") {
    token = socketToken(request);
  }
  if (!token || !env.HUB_TOKEN) return null;
  if (tokensMatch(token, env.HUB_TOKEN)) {
    return { db: env.DB, authDb: env.AUTH_DB, archive: env.ARCHIVE, scopes: ["admin"], name: "admin", admin: true, governance:null };
  }
  if (!env.AUTH_DB) return null;
  const preview=governanceOperation(request)?.preview;
  if (preview) {
    if (!await env.AUTH_DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_tokens'").first()) return null;
  } else await ensureAuthReady(env.AUTH_DB);
  const hash = await hashToken(token);
  const lookup = env.AUTH_DB.prepare("SELECT * FROM _tokens WHERE hash = ? AND revoked_at IS NULL").bind(hash);
  // An initialized registry answers the token and its governance authority in
  // one round trip; a preview may not initialize it, so it reads them apart.
  const [row, authority] = preview
    ? [await lookup.first(), undefined]
    : (await env.AUTH_DB.batch([lookup, governanceAuthorityStatement(env.AUTH_DB, hash)])).map((r) => r.results?.[0] ?? null);
  if (!row) return null;
  // One D1 write per request for a timestamp nobody reads to the second: a
  // replica polls every few seconds, so stamp a token at most once a minute.
  if (!preview && Date.now() - (lastUseStamped.get(hash) ?? 0) >= LAST_USE_STAMP_MS) {
    lastUseStamped.set(hash, Date.now());
    ctx.waitUntil(
      env.AUTH_DB.prepare(
        "UPDATE _tokens SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE hash = ?"
      )
        .bind(hash)
        .run()
    );
  }
  const governance=row.enrollment_profile || hasCreationScope(row.scopes.split(",")) ? null
    : authority === undefined ? await readGovernanceAuthority(env.AUTH_DB,hash) : governanceAuthority(authority);
  const enrollmentProfile=row.enrollment_profile ? {id:row.enrollment_profile,revision:row.enrollment_revision} : null;
  return { db: env.DB, authDb: env.AUTH_DB, archive: env.ARCHIVE, scopes: row.scopes.split(","), name: row.name, hash, admin: false, governance, enrollmentProfile };
}

// Decode exactly once and reject ambiguous separators/escape sequences. The same
// canonical key is used for authorization and storage, including legacy URLs.
function fileKey(pathname) {
  const encoded = pathname.replace(/^\/v1\/(files|archive)\//, "");
  if (/%2f|%5c/i.test(encoded)) throw new Error("bad key");
  const key = decodeURIComponent(encoded);
  if (!canonicalKey(key)) throw new Error("bad key");
  return key;
}

function canonicalKey(key) {
  return typeof key === "string" && !!key && !/[%\\\x00-\x1f\x7f]/.test(key) &&
    key.split("/").every((part) => part && part !== "." && part !== "..");
}

// Prefixes are literal object-key namespaces, with a mandatory boundary.
function filePrefixes(scopes, operation) {
  const grant = `files:${operation}:`;
  return scopes.filter((scope) => scope.startsWith(grant)).map((scope) => scope.slice(grant.length))
    .filter((prefix) => prefix.endsWith("/") && prefix.length > 1 &&
      !/[%\\\x00-\x1f\x7f]/.test(prefix) &&
      prefix.slice(0, -1).split("/").every((p) => p && p !== "." && p !== ".."));
}

function fileAllowed(pathname, method, scopes) {
  let key;
  try { key = fileKey(pathname); } catch { return false; }
  const operation = method === "PUT" && pathname.startsWith("/v1/files/") ? "write"
    : ["GET", "HEAD"].includes(method) ? "read" : null;
  if (!operation) return false;
  return filePrefixes(scopes, operation).some((prefix) => key.startsWith(prefix));
}

// Route family → scopes that may use it. "admin" implies everything;
// "full" implies everything except token management.
function allowed(pathname, method, scopes) {
  if (scopes.includes("admin")) return true;
  if (pathname.startsWith("/v1/tokens/")) return false; // admin only
  if (pathname.startsWith("/v1/files/") ||
      (pathname.startsWith("/v1/archive/") && !(pathname === "/v1/archive/query" && method === "POST"))) {
    return scopes.includes("full") || fileAllowed(pathname, method, scopes);
  }
  if (pathname === "/v1/backup") return scopes.includes("full");
  if (pathname === "/v1/backups" || pathname.startsWith("/v1/backups/")) return backupsAllowed(pathname, method, scopes);
  if (pathname.startsWith('/v1/streams/')) {
    const route = /^\/v1\/streams\/([A-Za-z0-9_-]{1,64})\/(append|tail|records)$/.exec(pathname);
    if (route) {
      const [, stream, op] = route;
      if (method === 'POST' && op === 'append' && scopes.includes(`streams:append:${stream}`)) return true;
      if (method === 'GET' && ['tail','records'].includes(op) && scopes.includes(`streams:read:${stream}`)) return true;
    }
  }
  if (pathname.match(/^\/v1\/streams\/[^/]+\/append$/)) {
    return scopes.includes("full") || scopes.includes("streams:append");
  }
  if (pathname === "/v1/rows/push" || pathname === "/v1/rows/insert" || pathname === "/v1/rows/patch" || pathname === "/v1/derive" || pathname === "/v1/derive/resolve") {
    return scopes.includes("full") || scopes.includes("tables:write");
  }
  const readOnly =
    pathname === "/v1/schema/pull" ||
    pathname === "/v1/rows/pull" ||
    pathname === "/v1/cursor" ||
    (method === "GET" && pathname === "/v1/changes") ||
    pathname === "/v1/catalog" ||
    pathname === "/v1/stats" ||
    ((method === "GET" || method === "HEAD") &&
      (pathname.startsWith("/v1/streams/") || pathname.startsWith("/v1/archive/")));
  if (readOnly) return scopes.includes("full") || scopes.includes("tables:read");
  return scopes.includes("full"); // schema/push, archive/query
}

const TOKEN_ROUTES = {
  "/v1/tokens/create": async (body, tenant, env) => {
    const scopes=typeof body.scopes==='string'?body.scopes.split(','):['full'];
    const creation=hasCreationScope(scopes);
    if(creation){
      const valid=new Set((await creationPolicies(env)).map(creationGrant));
      if(scopes.some(s=>s.startsWith('rows:create:')&&!valid.has(s)))return json({error:'invalid creation policy'},400);
    }
    const value =
      "lt_" + [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
    await ensureAuthReady(tenant.authDb);
    const hash=await hashToken(value);
    await tenant.authDb.batch([
      tenant.authDb.prepare("INSERT INTO _tokens (hash, name, scopes) VALUES (?, ?, ?)").bind(hash,body.name,body.scopes || 'full'),
      ...(creation?[]:[authorityStatement(tenant.authDb,hash,'agent')]),
    ]);
    return { name: body.name, scopes: body.scopes || "full", token: value }; // value shown ONCE
  },
  "/v1/tokens/revoke": async (body, tenant) => {
    await ensureAuthReady(tenant.authDb);
    await tenant.authDb
      .prepare(
        "UPDATE _tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE name = ?"
      )
      .bind(body.name)
      .run();
    return { revoked: body.name };
  },
  "/v1/tokens/list": async (_body, tenant) => {
    await ensureAuthReady(tenant.authDb);
    const { results } = await tenant.authDb
      .prepare("SELECT name, scopes, created_at, revoked_at, last_used_at, label FROM _tokens ORDER BY created_at")
      .all();
    return results ?? [];
  },
};

// Background derivation reports nothing to a caller, so its per-row failures
// and any thrown error are the only trace it leaves. Structured, one line.
const logDerive = (p) =>
  p
    .then((r) => {
      if (r.failed.length) console.log(JSON.stringify({ derive_failed: r.failed }));
      return r;
    })
    .catch((e) => console.log(JSON.stringify({ derive_error: String(e) })));

// Plumbing tables are never dropped, so one isolate creates them once.
const plumbed = new WeakSet();
async function ensurePlumbing(db) {
  if (plumbed.has(db)) return;
  await db.batch(PLUMBING.map((stmt) => db.prepare(stmt))); // one round trip per isolate, not one per table
  plumbed.add(db);
}

// Governance storage guards writes (continuity triggers on tables created by
// any replay, by a DDL route or by DDL from outside the hub).
async function ensureReady(db) {
  await ensurePlumbing(db);
  await ensureEvidenceStorage(db);
  await ensureProposalStorage(db);
  await ensureChangesetStorage(db);
}

// What this isolate last verified per database (assertGenericStateBatched's
// exact schema and its stamp), and the exact schema governance setup last ran
// against. A failed audit drops the verification.
const verified = new WeakMap();
const prepared = new WeakMap();
async function audit(db) {
  verified.delete(db);
  const state = await assertGenericStateBatched(db);
  verified.set(db, state);
  return state;
}

// Every non-read route audits the generic state afresh. Governance setup is a
// function of the schema, so an isolate that has run it skips it while the
// audited schema is the one it ran against. A new isolate (most writes: the
// platform spreads requests over many) and a changed or failing audit run
// setup, then the audit, the order every request used to run them in.
async function ready(db) {
  let reason = "new isolate";
  if (prepared.has(db)) {
    let state = null;
    try { state = await audit(db); } catch (e) { if (!(e instanceof ScopeDenied)) throw e; }
    if (state && state.objects === prepared.get(db)) return;
    reason = state ? "schema changed" : "audit failed";
  }
  console.log(JSON.stringify({ governance_setup: reason }));
  await ensureReady(db);
  prepared.set(db, (await audit(db)).objects);
}

// A replica read re-audits only when the schema stamp moved since this
// isolate's last passing audit: reads execute no catalog SQL, and every write
// re-checks the catalog contents.
async function readReady(db) {
  await ensurePlumbing(db);
  if ((await schemaStamp(db)) !== verified.get(db)?.stamp) await audit(db);
}

// Does the HUB's own schema have hub_at? Never ask the pushed column list:
// an un-upgraded client omits it and its rows would land unstamped, invisible
// to every replica whose cursor has moved on.
async function hasHubAt(db, table) {
  return (await arrivalColumns(db, [table])).get(table) === "hub_at";
}

// Each table's arrival column ("hub_at", the legacy "updated_at", or null for
// a table the hub lacks), probed once per isolate: every cursor read and every
// page of a download asked PRAGMA table_info for its tables in a round trip of
// its own. A schema replay in this isolate clears it; one in another isolate
// surfaces as a failed statement, and the caller probes again.
const arrivalKinds = new WeakMap();
async function arrivalColumns(db, tables) {
  if (!arrivalKinds.has(db)) arrivalKinds.set(db, new Map());
  const known = arrivalKinds.get(db);
  const missing = [...new Set(tables.filter((t) => !known.has(t)))];
  if (missing.length) {
    // One table is one statement; a batch is for the many-table reads.
    const infos = missing.length === 1
      ? [await db.prepare(`PRAGMA table_info(${qident(missing[0])})`).all()]
      : await db.batch(missing.map((t) => db.prepare(`PRAGMA table_info(${qident(t)})`)));
    missing.forEach((t, i) => {
      const info = infos[i].results ?? [];
      known.set(t, !info.length ? null : info.some((c) => c.name === "hub_at") ? "hub_at" : "updated_at");
    });
  }
  return known;
}

// Every sync round reads max(hub_at) and pulls `hub_at >= since` on EVERY
// table; unindexed, each is a full scan of the table and D1 bills every row
// read (a 400k-row provenance table polled every 30s cost real money). The hub
// owns one hub_at index per user table - unlogged, like the engine indexes -
// ensured once per isolate and again after schema replay adds tables.
const indexed = new WeakSet();
async function ensureHubAtIndexes(db) {
  if (indexed.has(db)) return;
  const { results } = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_%' ESCAPE '\\'")
    .all();
  const names = (results ?? []).map((r) => r.name);
  // Batched: a fresh isolate runs this before its first cursor or pull, and
  // one round trip per table made that first request take ten seconds.
  if (names.length) {
    const infos = await db.batch(names.map((n) => db.prepare(`PRAGMA table_info(${qident(n)})`)));
    const stamped = names.filter((_, i) => (infos[i].results ?? []).some((c) => c.name === "hub_at"));
    if (stamped.length) {
      await db.batch(
        stamped.map((n) =>
          db.prepare(`CREATE INDEX IF NOT EXISTS ${qident(`${n}_hub_at`)} ON ${qident(n)} (hub_at)`),
        ),
      );
    }
  }
  indexed.add(db);
}

// One table page: `limit` makes it paginated (`after` row-id cursor);
// without it a legacy caller gets every matching row.
function pullError(body, maxLimit) {
  if (body.limit !== undefined && (!Number.isInteger(body.limit) || body.limit < 1 || body.limit > maxLimit)) {
    return `limit must be an integer from 1 to ${maxLimit}`;
  }
  if (body.limit !== undefined && body.after !== undefined && typeof body.after !== "string") return "after must be a string";
  // Optional equality filter so a client can pull one slice of a large table
  // instead of every row (Music Sync needs the songs slice of provenance).
  const where = body.where ?? {};
  if (typeof where !== "object" || where === null || Array.isArray(where)
      || !Object.values(where).every((v) => typeof v === "string" || typeof v === "number")) {
    return "where must map column names to string or number values";
  }
  return null;
}

function pullQuery(body, hubAt) {
  const paginated = body.limit !== undefined;
  const columns = body.columns ?? [];
  const includeId = paginated && !columns.includes("id");
  const cols = (includeId ? [...columns, "id"] : columns).map(qident).join(", ");
  const t = qident(body.table);
  const since = body.since ?? "";
  // arrival-time cursor, INCLUSIVE: a push stamped in the same millisecond as
  // a cursor read must not be lost. A NULL hub_at is older than everything,
  // so `since = ''` — a fresh or just-upgraded replica — pulls the lot.
  // A table predating the migration falls back to the old client stamp.
  const incremental = since !== "" && hubAt;
  let [sql, args] = incremental
    ? [`SELECT ${cols} FROM ${t} WHERE hub_at >= ?`, [since]]
    : hubAt
      ? [`SELECT ${cols} FROM ${t} WHERE true`, []]
      : [`SELECT ${cols} FROM ${t} WHERE updated_at > ?`, [since]];
  for (const [col, value] of Object.entries(body.where ?? {})) {
    sql += ` AND ${qident(col)} = ?`;
    args.push(value);
  }
  if (paginated) {
    // A full pull walks the primary key page by page. An incremental pull
    // must range-scan the hub_at index instead: the unary `+` hides `id` from
    // the planner, which otherwise walks the whole PK and filters hub_at row
    // by row - a full table scan per page (SQLite's EXPLAIN QUERY PLAN proves
    // it; the pull test asserts the plan).
    const id = incremental ? "+id" : "id";
    if (body.after !== undefined) {
      sql += ` AND ${id} > ?`;
      args.push(body.after);
    }
    sql += ` ORDER BY ${id} ASC LIMIT ?`;
    args.push(body.limit);
  }
  return { sql, args, includeId };
}

function pullPage(body, rows, includeId, nextCursor = rows.length === body.limit ? rows.at(-1).id : null) {
  if (body.limit === undefined) return { rows };
  if (includeId) for (const row of rows) delete row.id;
  return { rows, next_cursor: nextCursor };
}

// Many table pages in one request: a cold replica is mostly small tables, and
// every request pays the hub's fixed cost. The reads travel as one D1 batch.
// Rows past the byte budget wait for the next request (the first row always
// goes, so a walk never stalls); `batch` answers a prefix of the pulls asked.
const PULL_BATCH = { items: 50, rows: 5000, bytes: 4 * 1024 * 1024 };
const COMPOUND_TERMS = 5; // D1: "too many terms in compound SELECT" past five

async function pullBatch(items, db, narrow = false) {
  if (!Array.isArray(items) || !items.length || items.length > PULL_BATCH.items) {
    return json({ error: `batch must list 1 to ${PULL_BATCH.items} pulls` }, 400);
  }
  for (const item of items) {
    const invalid = !item || typeof item !== "object" || typeof item.table !== "string" || typeof item.since !== "string"
      || !Array.isArray(item.columns) || !item.columns.every((c) => typeof c === "string") || item.limit === undefined
      ? "each pull needs table, columns, since and limit" : pullError(item, PULL_BATCH.rows);
    if (invalid) return json({ error: invalid }, 400);
    assertGenericBody(item);
  }
  if (items.reduce((n, item) => n + item.limit, 0) > PULL_BATCH.rows) {
    return json({ error: `a batch reads at most ${PULL_BATCH.rows} rows` }, 400);
  }
  let queries, guards = [];
  if (narrow) {
    // Each item passes the narrow table check; its guards ride the same batch.
    const view = checkedReads(db);
    await prefetchTables(view, items.map((item) => item.table));
    queries = [];
    for (const item of items) {
      const query = await scopedQuery(view, item, PULL_BATCH.rows);
      if (!query) return json({ error: "invalid row request" }, 400);
      queries.push(query);
    }
    guards = readGuards(db, view.reads);
  } else {
    await ensureHubAtIndexes(db);
    const kinds = await arrivalColumns(db, items.map((item) => item.table));
    queries = items.map((item) => pullQuery(item, kinds.get(item.table) === "hub_at"));
  }
  const pages = (await db.batch([...guards, ...queries.map(({ sql, args }) => db.prepare(sql).bind(...args))])).slice(guards.length);
  const batch = [];
  let bytes = 0;
  for (const [i, item] of items.entries()) {
    const rows = pages[i].results ?? [];
    let kept = 0;
    for (const row of rows) {
      bytes += JSON.stringify(row).length;
      if (bytes > PULL_BATCH.bytes && (kept || batch.length)) break;
      kept++;
    }
    if (kept < rows.length) {
      if (kept) batch.push(pullPage(item, rows.slice(0, kept), queries[i].includeId, rows[kept - 1].id));
      break;
    }
    batch.push(pullPage(item, rows, queries[i].includeId));
  }
  return { batch };
}

// A table the hub lacks (renamed or dropped by a replay the caller has not
// run yet) has no arrivals. With the newest arrival comes how many rows share
// that stamp (index-only): a reader whose cursor sits on it can tell a
// same-millisecond late commit from nothing new.
function markTerms(tables, kinds) {
  return tables.map((t, i) => {
    const col = kinds.get(t);
    if (!col) return `SELECT ${i} AS i, '' AS m, NULL AS n`;
    if (col !== "hub_at") return `SELECT ${i} AS i, max(${col}) AS m, NULL AS n FROM ${qident(t)}`;
    return `SELECT ${i} AS i, (SELECT max(hub_at) FROM ${qident(t)}) AS m, (SELECT count(*) FROM ${qident(t)} WHERE hub_at = (SELECT max(hub_at) FROM ${qident(t)})) AS n`;
  });
}
// D1 spends a few milliseconds per statement of a batch, whatever the
// statement reads, and refuses a compound SELECT of more than five terms:
// five tables per statement is the floor for an estate's cursor.
function compound(db, terms) {
  const statements = [];
  for (let i = 0; i < terms.length; i += COMPOUND_TERMS) statements.push(db.prepare(terms.slice(i, i + COMPOUND_TERMS).join(" UNION ALL ")));
  return statements;
}
function markRows(results) {
  const rows = [];
  for (const { results: part } of results) for (const row of part ?? []) rows[row.i] = row;
  return rows;
}
// `tables` is each table's own newest arrival: a reader pulls only the tables
// whose mark reached its cursor. `at_mark`: rows stamped with that arrival.
function cursorMarks(tables, rows) {
  let top = "";
  const marks = {};
  const at_mark = {};
  tables.forEach((t, i) => {
    const m = rows[i]?.m ?? "";
    marks[t] = m;
    const n = rows[i]?.n;
    if (m && Number.isSafeInteger(n)) at_mark[t] = n;
    if (m > top) top = m;
  });
  return { max_hub_at: top, max_updated_at: top, tables: marks, at_mark };
}

// A narrow reader's marks: only its granted tables (authorizeCursor), each
// past the narrow table check, read under that check's guards. No estate
// schema mark: a narrow reader replays no schema.
async function scopedCursor(tables, db) {
  await ensureHubAtIndexes(db);
  const view = checkedReads(db);
  await prefetchTables(view, tables);
  for (const t of tables) await scopedTable(view, t);
  const guards = readGuards(db, view.reads);
  const results = await db.batch([...guards, ...compound(db, markTerms(tables, new Map(tables.map((t) => [t, "hub_at"]))))]);
  return { ...cursorMarks(tables, markRows(results.slice(guards.length))), pull_batch: PULL_BATCH };
}

// `stampHubAt` is the hub's role: hub_at is dropped from whatever the client
// sent and re-added using the database clock in the committing batch, so
// arrival order is one clock's order and no replica skips a delayed push.
function upsertSql(table, cols, stampHubAt = false, insertOnly = false) {
  const t = qident(table);
  if (stampHubAt) cols = [...cols.filter((x) => x !== "hub_at"), "hub_at"];
  // the json path uses the RAW column name (it is a JSON key, not SQL)
  const extracts = cols
    .map((x) => (stampHubAt && x === "hub_at" ? NOW : `json_extract(value, '$.${ident(x)}')`))
    .join(", ");
  const sets = cols.filter((x) => x !== "id").map((x) => `${qident(x)} = excluded.${qident(x)}`).join(", ");
  return (
    `INSERT INTO ${t} (${cols.map(qident).join(", ")}) SELECT ${extracts} FROM json_each(?) WHERE true ` +
    (insertOnly ? 'ON CONFLICT(id) DO NOTHING RETURNING id' :
      `ON CONFLICT(id) DO UPDATE SET ${sets} WHERE excluded.updated_at > ${t}.updated_at`)
  );
}

const ROUTES = {
  "/v1/schema/pull": async (_body, db) => {
    const { results } = await db
      .prepare("SELECT applied_at, ddl FROM _schema_log ORDER BY applied_at, id")
      .all();
    return { entries: results ?? [] };
  },

  "/v1/schema/push": async (body, db) => {
    const { results } = await db.prepare("SELECT ddl FROM _schema_log").all();
    const known = new Set((results ?? []).map((r) => r.ddl));
    let applied = 0;
    for (const entry of body.entries ?? []) {
      assertGenericDDL(entry.ddl);
      if (known.has(entry.ddl)) continue;
      try {
        await applySubscriptionSchema(db,entry.ddl);
      } catch (e) {
        if (e.code === 'subscription-schema-conflict') return json({error:'subscription_schema_conflict',message:'Retire affected subscriptions before changing watched schema.'},409);
        const msg = String(e).toLowerCase();
        // replay is idempotent-by-skip for DDL the hub already has: a CREATE that
        // exists, an ADD of a column it has, a RENAME of a column already gone, a
        // table RENAME whose source is already gone
        const renamedAway = msg.includes("no such table") && RENAME_TABLE.test(entry.ddl);
        if (!msg.includes("already exists") && !msg.includes("duplicate column") && !msg.includes("no such column") && !renamedAway) throw e;
      }
      await db
        .prepare("INSERT INTO _schema_log (applied_at, ddl) VALUES (?, ?)")
        .bind(entry.applied_at, entry.ddl)
        .run();
      applied++;
    }
    if (applied) {
      indexed.delete(db); // a replayed CREATE TABLE needs its index
      arrivalKinds.delete(db);
      markChanged(["_schema_log"]);
    }
    return { applied };
  },

  "/v1/rows/pull": async (body, db) => {
    if (body.batch !== undefined) return pullBatch(body.batch, db);
    const invalid = pullError(body, 200);
    if (invalid) return json({ error: invalid }, 400);
    await ensureHubAtIndexes(db);
    const { sql, args, includeId } = pullQuery(body, await hasHubAt(db, body.table));
    const { results } = await db.prepare(sql).bind(...args).all();
    return pullPage(body, results ?? [], includeId);
  },

  "/v1/rows/push": async (body, db, env, ctx, policy) => {
    const table = ident(body.table); // before any SQL is built from it
    const columns = body.columns.map(ident);
    // The same sparse payload must reach validation and SQL: unlisted keys
    // are not writes, and an omitted listed key is not an explicit NULL.
    const purged = policy ? new Map() : await purgeIndex(db);
    const rows = uncovered(purged, table, (body.rows ?? []).map((row) => Object.fromEntries(
      columns.filter((col) => Object.hasOwn(row, col)).map((col) => [col, row[col]])
    )));
    const stamping = await hasHubAt(db, table);
    const { accepted, rejected } = await pushChecked(db, table,
      rows.filter(row => validEditTimestamp(row.updated_at)), upsertSql, stamping,
      uncovered(purged, "history", body.history ?? []), false, policy);
    // The hub logs its own event for an accepted edit; a marker that covers
    // the row removes it again, old value included.
    if (!policy && table !== PURGES && accepted.length) {
      await applyPurges(db, markersFor(purged, table, accepted.map((row) => row.id)));
    }
    if (table === PURGES && accepted.length) {
      const { results } = await db
        .prepare(`SELECT * FROM ${PURGES} WHERE id IN (SELECT value FROM json_each(?))`)
        .bind(JSON.stringify(accepted.map((row) => row.id))).all();
      await applyPurges(db, results ?? []);
    }
    // Ambiguous history rolls back the entire request, including rows filtered
    // by the timestamp gate, and supplies no committed arrival cursor.
    const ambiguity = rejected.find(r=>r.rule === "history-ambiguity");
    if (ambiguity) return {upserted:0, rejected:rows.map(row=>({...ambiguity,id:row.id})), hub_at:""};
    rejected.push(...rows.filter(row => !validEditTimestamp(row.updated_at)).map(row => ({
      id: row.id, col: "updated_at", rule: row.updated_at == null ? "required" : "type",
      message: "updated_at must be a valid UTC millisecond timestamp.",
    })));
    // Derivation happens in the background: the push response never waits on
    // an external endpoint, and a failure here is retried by the cron sweep.
    if (!policy && accepted.length && ctx && env) ctx.waitUntil(logDerive(deriveStale(queryBudget(db, 200), env, table, accepted)));
    // Report stored arrivals, never a timestamp captured before the write.
    // This diagnostic is not a pull checkpoint (another write may follow).
    const hubAt = stamping && accepted.length
      ? (await db.prepare(`SELECT max(hub_at) AS t FROM ${qident(table)} WHERE id IN (SELECT value FROM json_each(?))`)
        .bind(JSON.stringify(accepted.map(row => row.id))).first()).t ?? "" : "";
    return { upserted: accepted.length, rejected, hub_at: hubAt };
  },

  "/v1/rows/patch": async (body, db, env, ctx, policy) => {
    const receipt=await patchChecked(db,body,policy);
    if (!(receipt instanceof Response) && !policy && ctx && env) {
      ctx.waitUntil(logDerive(deriveStale(queryBudget(db,200),env,body.table,[{id:body.id}])));
    }
    return receipt;
  },

  "/v1/rows/insert": async (body, db, env, ctx, policy) => {
    if (!body || Object.hasOwn(body, "history")) return json({error:"history attachments are not supported by rows/insert"},400);
    if (!Array.isArray(body.columns) || !body.columns.includes("id") || !Array.isArray(body.rows)) {
      return json({error:"rows/insert requires columns including id and a rows list"},400);
    }
    const ids = body.rows.map(row=>row?.id);
    if (ids.some(id=>typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length) {
      return json({error:"rows/insert requires unique nonempty row IDs"},400);
    }
    const table = ident(body.table), columns = body.columns.map(ident);
    const rows = body.rows.map(row=>Object.fromEntries(columns.filter(col=>Object.hasOwn(row,col)).map(col=>[col,row[col]])));
    const stamping = await hasHubAt(db,table);
    const out = await pushChecked(db,table,rows,(t,c,s)=>upsertSql(t,c,s,true),stamping,[],true,policy);
    if (!policy && out.accepted.length && ctx && env) ctx.waitUntil(logDerive(deriveStale(queryBudget(db,200),env,table,out.accepted)));
    return {inserted:out.accepted.map(row=>row.id),existing:out.existing ?? [],rejected:out.rejected};
  },

  // A separate route makes older hubs fail closed instead of ignoring the
  // displayed revision. Existing bulk derive/cron behavior stays unchanged.
  "/v1/derive/resolve": async (body, db, env) => {
    if (!body || Object.keys(body).some(key => !['table','ids','col','expectedUpdatedAt'].includes(key))
      || !Array.isArray(body.ids) || body.ids.length !== 1
      || typeof body.ids[0] !== 'string' || !body.ids[0]
      || typeof body.col !== 'string' || !body.col
      || !validEditTimestamp(body.expectedUpdatedAt)) return json({error:'invalid Resolve request'},400);
    const table = ident(body.table), col = ident(body.col);
    return deriveRows(db,env,table,body.ids,{col,expectedUpdatedAt:body.expectedUpdatedAt});
  },

  // Synchronous derivation for a named set of rows: `soma derive` and the
  // migration backfill. Capped so one call stays inside a request's budget.
  "/v1/derive": async (body, db, env) => {
    const table = ident(body.table);
    const ids = body.ids ?? [];
    if (ids.length > 50) return json({ error: "at most 50 ids per call" }, 400);
    return deriveRows(db, env, table, ids, { col: body.col ?? null });
  },

  // Backups normally run on the cron; this makes the path triggerable and
  // therefore testable. Handled specially in fetch() (needs env, not just db).
  "/v1/backup": null,

  // Row counts per table, so a client can apply a size rule (skip syncing the
  // biggest tables) without counting anything itself. count(*) reads every row
  // on D1, so the answer is cached in plumbing and recounted at most daily.
  "/v1/stats": async (_body, db) => {
    // Counts and the current table list in one round trip: a table created
    // since the daily count is counted now, or no replica's size rule would
    // admit it until tomorrow; a dropped table leaves the answer.
    const read = async () => {
      const [stats, master] = await db.batch([
        db.prepare("SELECT tbl, rows, computed_at FROM _table_stats ORDER BY tbl"),
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_%' ESCAPE '\\'"),
      ]);
      return { rows: stats.results ?? [], names: (master.results ?? []).map((r) => r.name) };
    };
    let { rows, names } = await read();
    const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
    const stale = !rows.some((r) => r.computed_at > dayAgo);
    const count = stale ? names : names.filter((n) => !rows.some((r) => r.tbl === n));
    if (count.length) {
      const counts = await db.batch(count.map((n) => db.prepare(`SELECT count(*) AS n FROM ${qident(n)}`)));
      await db.batch([
        ...(stale ? [db.prepare("DELETE FROM _table_stats")] : []),
        ...count.map((n, i) =>
          db.prepare(`INSERT OR REPLACE INTO _table_stats (tbl, rows, computed_at) VALUES (?, ?, ${NOW})`).bind(n, counts[i].results?.[0]?.n ?? 0),
        ),
      ]);
      ({ rows } = await read());
    }
    rows = rows.filter((r) => names.includes(r.tbl));
    return {
      computed_at: rows.reduce((m, r) => (r.computed_at > m ? r.computed_at : m), ""),
      tables: Object.fromEntries(rows.map((r) => [r.tbl, r.rows])),
    };
  },
  "/v1/cursor": async (body, db) => {
    await ensureHubAtIndexes(db);
    const tables = body.tables ?? [];
    // Two batches, whatever the table count: a replica reads this every round,
    // and one round trip per table made the read cost seconds on a large estate.
    // The last entry is the schema log itself: its newest id lets a replica
    // whose own log has not moved skip the whole-log pull while this has not
    // moved either.
    const read = async () => {
      const kinds = await arrivalColumns(db, [...tables, "_schema_log"]);
      const terms = markTerms(tables, kinds);
      terms.push(kinds.get("_schema_log") ? `SELECT ${tables.length} AS i, coalesce(max(id), 0) AS m, NULL AS n FROM _schema_log` : `SELECT ${tables.length} AS i, 0 AS m, NULL AS n`);
      return markRows(await db.batch(compound(db, terms)));
    };
    let rows;
    try { rows = await read(); } catch (e) {
      if (!arrivalKinds.has(db)) throw e;
      arrivalKinds.delete(db);
      rows = await read();
    }
    // max_updated_at kept for clients from before the hub_at cursor: same value, so an
    // old client keeps syncing (full-pull semantics) until it is upgraded.
    // pull_batch: this hub answers `/v1/rows/pull` with many pages per request.
    return { ...cursorMarks(tables, rows), schema: rows[tables.length]?.m ?? 0, pull_batch: PULL_BATCH };
  },
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function handleSession(request, tenant, env) {
  if (request.method === "GET") {
    const capabilities=sessionCapabilities(tenant.scopes);
    const captures=captureCapability(env,tenant.scopes);
    if(captures)capabilities.captures=captures;
    const profiles=!tenant.admin && pushConfiguration(env)?.profiles;
    if(profiles)capabilities.push_profiles=profiles.map(({id,platform})=>({id,platform}));
    const push=await pushCapability(env,tenant);
    if(push)capabilities.push_registration=push;
    const rowCreation=await creationCapability(env,tenant.scopes);
    if(rowCreation)capabilities.rowCreation=rowCreation;
    if(governanceConfiguration(env) && tenant.governance && (tenant.governance.propose||tenant.governance.approve)){
      capabilities.governance={protocol:'selected-inverse-proposals-v1',principal:tenant.governance.actor,
        deploymentId:env.GOVERNANCE_DEPLOYMENT_ID,sessionId:tenant.governance.actor.principalId,
        authority:{propose:tenant.governance.propose,approve:tenant.governance.approve},limits:governanceLimits};
    }
    if(governanceConfiguration(env) && canChangeset(tenant)){
      capabilities.changesets={protocol:'bounded-changeset-proposals-v1',principal:tenant.governance.actor,
        deploymentId:env.GOVERNANCE_DEPLOYMENT_ID,sessionId:tenant.governance.actor.principalId,
        authority:{propose:tenant.governance.propose,approve:!!canChangeset(tenant,true)},limits:changesetGovernanceLimits};
    }
    const response = json({ name: tenant.name, scopes: tenant.scopes, capabilities,
      ...(tenant.enrollmentProfile ? {enrollmentProfile:tenant.enrollmentProfile} : {}) });
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (tenant.admin) return json({ error: "admin token cannot self-revoke" }, 403);
  await ensureAuthReady(tenant.authDb);
  await tenant.authDb.prepare(
    "UPDATE _tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE hash = ? AND revoked_at IS NULL"
  ).bind(tenant.hash).run();
  return json({ logged_out: true });
}

// --- streams: verbatim JSON landing + manifest + tail ------------------------
//
// Streams are append-only: the hub stores whatever JSON body arrives, byte for
// byte, as a landing object (raw is sacred; landing is never deleted). Keys
// are time-prefixed so lexicographic order == chronological order. The
// compactor reads landing via the S3 API and writes year=YYYY Parquet
// partitions; nothing here knows about any particular source.

const STREAM_NAME = /^[A-Za-z0-9_-]{1,64}$/;

const MAX_APPEND_BYTES = 1_000_000;

function landingKey(stream, now) {
  const ts = now.toISOString().replace(/[:]/g, "-");
  return `landing/${stream}/${ts}-${crypto.randomUUID().slice(0, 8)}.json`;
}

async function streamAppend(env, stream, body, now) {
  const key = landingKey(stream, now);
  await env.ARCHIVE.put(key, body, { httpMetadata: { contentType: "application/json" } });
  // small "latest" pointer so tail is O(1) instead of a full listing
  await env.ARCHIVE.put(`state/${stream}/latest.json`, body, {
    httpMetadata: { contentType: "application/json" },
  });
  // tee into the managed pipeline (→ Iceberg table soma.events in the data
  // catalog). Landing is the source of truth; the pipeline is the queryable
  // projection, so its failure must never fail an append — everything is
  // rebuildable from landing.
  let piped = false;
  try {
    const record = JSON.parse(new TextDecoder().decode(body));
    await env.EVENTS.send([{ stream, ingested_at: now.toISOString(), record }]);
    piped = true;
  } catch (e) {
    console.log(`pipeline tee failed for ${key}: ${e}`);
  }
  return { key, piped };
}

async function listAll(bucket, prefix) {
  const keys = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const obj of page.objects) keys.push(obj.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

async function streamManifest(env, stream, origin) {
  // parquet partitions + only the landing objects NOT yet covered by them
  // (the compactor records its high-water landing key per stream)
  const toUrl = (k) => `${origin}/v1/archive/${k.split("/").map(encodeURIComponent).join("/")}`;
  const parquet = (await listAll(env.ARCHIVE, `parquet/${stream}/`)).filter((k) =>
    k.endsWith(".parquet")
  );
  const watermarkObj = await env.ARCHIVE.get(`state/${stream}/compacted_through`);
  const watermark = watermarkObj ? await watermarkObj.text() : "";
  const landing = (await listAll(env.ARCHIVE, `landing/${stream}/`)).filter((k) => k > watermark);
  return { parquet: parquet.map(toUrl), landing: landing.map(toUrl) };
}

async function streamRecords(env, stream, params) {
  const bad = () => json({error:'invalid stream page'},400);
  if ([...params.keys()].some(key=>!['limit','cursor'].includes(key))
    || params.getAll('limit').length > 1 || params.getAll('cursor').length > 1) return bad();
  const limit = params.has('limit') ? Number(params.get('limit')) : 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) return bad();
  let cursor;
  if (params.has('cursor')) {
    try {
      const encoded = params.get('cursor');
      if (encoded.length > 8192) return bad();
      const value = JSON.parse(atob(encoded));
      if (!Array.isArray(value) || value.length !== 3 || value[0] !== 'stream-records-v1'
        || value[1] !== stream || typeof value[2] !== 'string' || !value[2]) return bad();
      cursor = value[2];
    } catch { return bad(); }
  }
  try {
    const prefix = `landing/${stream}/`;
    const page = await env.ARCHIVE.list({prefix, cursor, limit});
    if (!Array.isArray(page.objects) || page.objects.length > limit || typeof page.truncated !== 'boolean'
      || (page.truncated && (typeof page.cursor !== 'string' || !page.cursor || page.cursor === cursor))) {
      return json({error:'stream page unavailable'},503);
    }
    const entries = [];
    let bytes = 0;
    for (const item of page.objects) {
      if (typeof item.key !== 'string' || !item.key.startsWith(prefix)) return json({error:'stream page unavailable'},503);
      if (item.size > 2_000_000) return json({error:'stream page too large'},413);
      const object = await env.ARCHIVE.get(item.key);
      if (!object) return json({error:'stream page unavailable'},503);
      if (object.size > 2_000_000) return json({error:'stream page too large'},413);
      const raw = await object.arrayBuffer();
      if (raw.byteLength > 2_000_000) return json({error:'stream page too large'},413);
      const entry = {id:await sha256hex(item.key), body:new TextDecoder('utf-8',{fatal:true}).decode(raw)};
      bytes += new TextEncoder().encode(JSON.stringify(entry)).byteLength;
      if (bytes > 2_000_000) return json({error:'stream page too large'},413);
      entries.push(entry);
    }
    const result = {entries, next_cursor:page.truncated ? btoa(JSON.stringify(['stream-records-v1',stream,page.cursor])) : null};
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 2_000_000) return json({error:'stream page too large'},413);
    return Response.json(result,{headers:{'Cache-Control':'no-store'}});
  } catch { return json({error:'stream page unavailable'},503); }
}

async function handleStreams(request, env, url) {
  const parts = url.pathname.split("/").filter(Boolean); // v1 streams <name> <op>
  const [, , stream, op] = parts;
  if (parts.length !== 4 || !STREAM_NAME.test(stream ?? "")) return json({ error: "bad stream name" }, 400);

  if (op === 'records' && request.method === 'GET') return streamRecords(env,stream,url.searchParams);

  if (op === "append" && request.method === "POST") {
    const body = await request.arrayBuffer();
    if (body.byteLength === 0 || body.byteLength > MAX_APPEND_BYTES) {
      return json({ error: "body must be 1..1MB of JSON" }, 400);
    }
    return json(await streamAppend(env, stream, body, new Date()));
  }
  if (op === "replay" && request.method === "POST") {
    // Projection rebuild: tee records into the pipeline WITHOUT writing
    // landing — for replaying existing landing objects into a recreated
    // table. Same enrichment as batch. Landing is never duplicated.
    // ?ingested_at= keeps the landing object's own ingest time in the rebuilt table.
    const at = url.searchParams.get("ingested_at");
    if (at !== null && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at)) {
      return json({ error: "ingested_at must be an ISO-8601 UTC timestamp with milliseconds" }, 400);
    }
    const records = await request.json();
    if (!Array.isArray(records) || records.length === 0 || records.length > 1000) {
      return json({ error: "body must be a JSON array of 1..1000 records" }, 400);
    }
    const ingested = at ?? new Date().toISOString();
    for (let i = 0; i < records.length; i += 100) {
      await env.EVENTS.send(
        records.slice(i, i + 100).map((record) => ({ stream, ingested_at: ingested, record }))
      );
    }
    return json({ replayed: records.length });
  }
  if (op === "batch" && request.method === "POST") {
    // Bulk import: ONE landing object holding the whole batch, pipeline sends
    // in chunks, and — unlike append — the latest.json pointer is left alone,
    // so historical imports never masquerade as the current position.
    const records = await request.json();
    if (!Array.isArray(records) || records.length === 0 || records.length > 1000) {
      return json({ error: "body must be a JSON array of 1..1000 records" }, 400);
    }
    const now = new Date();
    const key = `landing/${stream}/${now.toISOString().replace(/[:]/g, "-")}-batch-${crypto.randomUUID().slice(0, 8)}.json`;
    await env.ARCHIVE.put(key, JSON.stringify(records), {
      httpMetadata: { contentType: "application/json" },
    });
    const ingested = now.toISOString();
    for (let i = 0; i < records.length; i += 100) {
      await env.EVENTS.send(
        records.slice(i, i + 100).map((record) => ({ stream, ingested_at: ingested, record }))
      );
    }
    return json({ count: records.length, key });
  }
  if (op === "tail" && request.method === "GET") {
    const latest = await env.ARCHIVE.get(`state/${stream}/latest.json`);
    return latest
      ? new Response(latest.body, { headers: { "Content-Type": "application/json" } })
      : json(null);
  }
  if (op === "manifest" && request.method === "GET") {
    return json(await streamManifest(env, stream, url.origin));
  }
  return json({ error: "not found" }, 404);
}

async function handleArchiveGet(request, env, url) {
  let key;
  try { key = fileKey(url.pathname); } catch { return json({ error: "bad key" }, 400); }
  // HEAD: DuckDB's httpfs sizes files with HEAD before ranged GETs
  if (request.method === "HEAD") {
    const head = await env.ARCHIVE.head(key);
    if (!head) return new Response(null, { status: 404 });
    const headers = fileHeaders(head);
    return new Response(null, { headers });
  }
  // range: pass the Headers object only when a Range header exists — R2
  // parses it natively. No onlyIf: conditional requests aren't needed and
  // passing arbitrary headers there caused 500s.
  const rangeHeader = request.headers.get("Range");
  const obj = rangeHeader
    ? await env.ARCHIVE.get(key, { range: request.headers })
    : await env.ARCHIVE.get(key);
  if (!obj) return json({ error: "not found" }, 404);
  const headers = fileHeaders(obj);
  if (rangeHeader && obj.range) {
    const start = obj.range.offset ?? Math.max(0, obj.size - (obj.range.suffix ?? 0));
    const length = obj.range.length ?? obj.size - start;
    headers.set("Content-Length", String(length));
    headers.set("Content-Range", `bytes ${start}-${start + length - 1}/${obj.size}`);
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(obj.size));
  return new Response(obj.body, { headers });
}

// --- CORS: browser clients on the origins the owner lists in CORS_ORIGINS -----
//
// The API authenticates with a bearer token, never cookies, so CORS only has to
// let a listed app origin read responses. Unlisted origins get nothing; the
// Access-protected /login pages are same-origin forms and never get CORS.
function corsOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  const listed = (env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return listed.includes(origin) ? origin : null;
}

function withCors(response, origin) {
  const out = new Response(response.body, response);
  out.headers.set("Access-Control-Allow-Origin", origin);
  out.headers.append("Vary", "Origin");
  out.headers.set("Access-Control-Expose-Headers", "ETag, Content-Range, Date, Retry-After, X-Content-SHA256");
  return out;
}

function preflight(request, env) {
  const origin = corsOrigin(request, env);
  if (!origin) return json({ error: "origin not allowed" }, 403);
  return withCors(new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, PATCH",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, If-None-Match, Range, X-Content-SHA256",
      "Access-Control-Max-Age": "86400",
    },
  }), origin);
}

export default {
  // Every commit inside a request or cron run wakes the replicas (changes.js).
  fetch(request, env, ctx) {
    return withChangeSignal(env, ctx, async () => {
      const url = new URL(request.url);
      if (loginPath(url.pathname)) return handle(request, env, ctx, url);
      if (request.method === "OPTIONS") return preflight(request, env);
      const response = await handle(request, env, ctx, url);
      const origin = corsOrigin(request, env);
      // A copied 101 loses its WebSocket, and CORS does not apply to one.
      return origin && response.status !== 101 ? withCors(response, origin) : response;
    });
  },

  scheduled(event, env, ctx) {
    return withChangeSignal(env, ctx, async () => {
      // One Worker, two schedules — dispatch on which trigger fired.
      if (event.cron === SWEEP_CRON) ctx.waitUntil(logDerive(sweep(env.DB, env)));
      // Awaited, not waitUntil: a failed backup fails the cron run, so the
      // provider's cron history shows it (backup.js also notifies).
      else await backup(env, new Date(event.scheduledTime));
    });
  },
};

// Called every round or page. schema/pull (once per schema change) keeps the
// full setup: it is what initializes governance storage on a fresh hub.
const REPLICA_READS = new Set(["/v1/rows/pull", "/v1/cursor", "/v1/stats"]);

async function handle(request, env, ctx, url) {
  if (url.pathname === "/health") return json({ ok: true });

  if (loginPath(url.pathname)) {
    try {
      return await handleLogin(request, env, ctx, url);
    } catch {
      return json({ error: "login unavailable" }, 500);
    }
  }

  const tenant = await authenticate(request, env, ctx);
  if(pushRegistrationRoute(request))return handlePushRegistration(request,tenant,env);
  const governance=governanceOperation(request);
  if (governance) {
    if (!tenant) return governanceFailure(governance,401,'permission_denied');
    if (!tenant.governance || (governance.name==='approveProposal'||governance.approve ? !tenant.governance.approve : governance.read ? !tenant.governance.propose&&!tenant.governance.approve : !tenant.governance.propose))
      return governanceFailure(governance,governance.read?200:403,'permission_denied');
    if(governance.changeset)return handleChangesetGovernance(request,tenant,env,governance);
    return handleGovernance(request,tenant,env,governance);
  }
  if (!tenant) {
    const session = url.pathname.startsWith("/v1/session");
    return json({ error: session ? "unauthorized" : "forbidden" }, session ? 401 : 403);
  }
  if (url.pathname === "/v1/session") return handleSession(request, tenant, env);
  if (url.pathname === "/v1/files") {
    const broad = ["admin", "full"].some((scope) => tenant.scopes.includes(scope));
    return listFiles(request, tenant.archive, url, broad ? [""] : filePrefixes(tenant.scopes, "read"));
  }
  if (url.pathname.startsWith('/v1/captures/')) return captureGateway(request,tenant,env);
  if (url.pathname === '/v1/rows/query') return rowsQuery(request,tenant,env);
  if (url.pathname === '/v1/consumer/config') return consumerConfig(request,tenant,env);
  if (url.pathname === '/v1/catalog/projection') return catalogProjection(request,tenant);
  if (url.pathname === "/v1/rows/create") return handleCreation(request,tenant,env);
  if (url.pathname === "/v1/subscriptions" || url.pathname.startsWith("/v1/subscriptions/")) return handleSubscription(request,tenant);
  if (["/v1/schema/pull", "/v1/schema/push"].includes(url.pathname) && !hasSchemaAccess(tenant.scopes)) {
    return json(scopedReplicaUnsupported, 403);
  }
  const rowOperation = request.method === "POST"
    ? ({"/v1/rows/pull":"read","/v1/cursor":"read","/v1/rows/push":"write","/v1/rows/insert":"write","/v1/rows/patch":"write"})[url.pathname] : null;
  const narrowRows = rowOperation && !broadTableAccess(tenant.scopes,rowOperation);
  const optionsRequest = url.pathname === '/v1/catalog/options' && request.method === 'GET';
  if (!narrowRows && !optionsRequest && !allowed(url.pathname, request.method, tenant.scopes)) {
    return json({ error: "insufficient scope" }, 403);
  }

  try {
    if (optionsRequest) return json(await scopedOptions(url.searchParams,tenant.db,tenant.scopes));
    if (narrowRows) {
      const body = await request.json();
      if (!body || !(rowOperation === 'read' ? authorizeRead(tenant.scopes,url.pathname,body)
        : authorizeTable(tenant.scopes,rowOperation,body.table)
          || (url.pathname === '/v1/rows/patch' && authorizeRowPatch(tenant.scopes,body))
          || (url.pathname === '/v1/rows/insert' && authorizeEdges(tenant.scopes,body))) || Object.hasOwn(body,"history")) {
        return json({error:"insufficient scope"},403);
      }
      if (rowOperation === "read") {
        const out = url.pathname === "/v1/cursor" ? await scopedCursor(body.tables,tenant.db)
          : body.batch !== undefined ? await pullBatch(body.batch,tenant.db,true) : await scopedRows(body,tenant.db);
        return out instanceof Response ? out : json(out);
      }
      if (url.pathname === '/v1/rows/patch') {
        const out=await patchChecked(tenant.db,body,scopedPatchTable);
        return out instanceof Response ? out : json(out);
      }
      if (!Array.isArray(body.columns) || !body.columns.includes('id') || !Array.isArray(body.rows)) {
        return json({error:"insufficient scope"},403);
      }
      // Only authorizeEdges admits provenance here (never an ordinary table grant).
      const policy = body.table === 'provenance' ? edgePolicy(body.rows) : scopedTable;
      await policy(tenant.db,body.table,true,body.rows.map(row=>row?.id));
      const out = await ROUTES[url.pathname](body,tenant.db,env,ctx,policy);
      return out instanceof Response ? out : json(scopedResult(out));
    }
    if (url.pathname.startsWith("/v1/files/")) {
      if (url.pathname === "/v1/files/rehome" && request.method === "POST") {
        if (!tenant.admin) return json({ error: "insufficient scope" }, 403);
        await ensureUsage(tenant.authDb);
        return await rehomeFile(request, tenant.archive, canonicalKey, (n) => notify(tenant.authDb, n), tenant.name);
      }
      if (["GET", "HEAD"].includes(request.method)) return await handleArchiveGet(request, env, url);
      if (!["PUT", "DELETE"].includes(request.method)) return json({ error: "method not allowed" }, 405);
      let key;
      try { key = fileKey(url.pathname); } catch { return json({ error: "bad key" }, 400); }
      if (request.method === "PUT") return await putFile(request, tenant.archive, key);
      await ensureUsage(tenant.authDb);
      return await deleteFile(url, tenant.archive, key, (n) => notify(tenant.authDb, n), tenant.name);
    }
    if (url.pathname.startsWith("/v1/tokens/") && request.method === "POST") {
      const route = TOKEN_ROUTES[url.pathname];
      if (!route) return json({ error: "not found" }, 404);
      const out=await route(await request.json(), tenant, env);
      return out instanceof Response?out:json(out);
    }
    if (url.pathname === "/v1/archive/query" && request.method === "POST") {
      // proxy to R2 SQL with the hub's own service credential, so clients
      // never hold a provider token. Table: soma.events (stream, ingested_at, record.*)
      const { sql } = await request.json();
      const resp = await fetch(
        `https://api.sql.cloudflarestorage.com/api/v1/accounts/${env.ACCOUNT_ID}/r2-sql/query/${env.ARCHIVE_BUCKET}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.R2_SQL_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query: sql }),
        }
      );
      return new Response(resp.body, {
        status: resp.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/v1/catalog" && request.method === "GET") {
      await ready(tenant.db);
      const out = {};
      for (const t of ["catalog_tables", "catalog_properties", "catalog_rules"]) {
        const exists = await tenant.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").bind(t).first();
        const { results } = exists ? await tenant.db.prepare(`SELECT * FROM ${qident(t)} WHERE deleted_at IS NULL ORDER BY id`).all() : { results: [] };
        out[t.replace("catalog_", "")] = results ?? [];
      }
      const text = JSON.stringify(out);
      const etag = `"${(await sha256hex(text)).slice(0, 32)}"`;
      if (request.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
      return new Response(text, { headers: { "Content-Type": "application/json", ETag: etag } });
    }
    if (url.pathname === "/v1/backups" || url.pathname.startsWith("/v1/backups/")) return await handleBackups(request, env, url);
    if (url.pathname.startsWith("/v1/streams/")) return await handleStreams(request, env, url);
    if (url.pathname === "/v1/changes" && request.method === "GET") return await changesRoute(env, url, request);
    if (
      url.pathname.startsWith("/v1/archive/") &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      return await handleArchiveGet(request, env, url);
    }
    if (!(url.pathname in ROUTES) || request.method !== "POST") {
      return json({ error: "not found" }, 404);
    }
    if (url.pathname === "/v1/backup") {
      return json({ keys: await backup(env, new Date()) });
    }
    // Replica reads (each page of a cold download is one) skip the write path's
    // governance setup and the audit while the schema is unchanged.
    await (REPLICA_READS.has(url.pathname) ? readReady(tenant.db) : ready(tenant.db));
    const body=await request.json();
    assertGenericBody(body);
    const out = await ROUTES[url.pathname](body, tenant.db, env, ctx);
    return out instanceof Response ? out : json(out);
  } catch (e) {
    if (e instanceof ScopeDenied) return json({error:"insufficient scope"},403);
    if (narrowRows || optionsRequest) return json({error:"row request failed"},400);
    return json({ error: String(e) }, 500);
  }
}

export { ROUTES, SWEEP_CRON, allowed, authenticate, validatePush, TOKENS_TABLE };
