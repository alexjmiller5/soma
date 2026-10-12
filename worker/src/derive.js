// Hub-side derivations. A derived property declares `derived_by = "http:<name>"`;
// the name is resolved ONLY through the DERIVATIONS Worker secret, so no
// external source is ever named in this repo.
//
// Protocol: POST <url> {tbl, id, inputs:{col: value}} -> a JSON object whose
// keys are column names to write, plus an optional `_source_ref`. Keys that
// are not derived columns of that derivation are ignored; a non-2xx reply or
// bad JSON leaves the cell underived and is reported in `failed`. A 2xx reply
// is a completed lookup: a derived column it omits gets a no-data proof (the
// stored value is kept, never cleared), refreshed after `no_data_refresh_days`
// (default 7). `refresh_days` (default never) refreshes ordinary proofs too.
//
// A write is one D1 batch: the value UPDATE plus a provenance upsert per
// column, so a replica pulling the row also pulls the provenance that proves
// it and the client's `derived` rule never fires.

import { markChanged } from "./changes.js";
import { historyPlan } from "./history.js";
import { checkedReads, commitChecked, enforcedRules, queryBudget } from "./write.js";
import { canonicalSql, ident, legacySql, literal, proofHashes, propertiesFor, qident, sha256hex, validateRow, storageRow } from "./validate.js";

// A hung endpoint would otherwise stall the whole sequential sweep.
const ENDPOINT_TIMEOUT_MS = 60_000;

// Hub-only operational state: no schema log, catalog rows or replica sync.
const COOLDOWNS = `CREATE TABLE IF NOT EXISTS _derivation_cooldowns (
  endpoint TEXT PRIMARY KEY, status INTEGER NOT NULL, retry_at INTEGER NOT NULL
)`;
// Where each table's sweep resumes: the id after which it scans next.
const CURSORS = "CREATE TABLE IF NOT EXISTS _derivation_cursors (tbl TEXT PRIMARY KEY, after TEXT NOT NULL)";

function retryAfter(res) {
  if (![429, 503].includes(res.status)) return null;
  const header = res.headers.get("Retry-After")?.trim() ?? "";
  const now = Date.now();
  let seconds = NaN;
  if (/^\d+$/.test(header)) seconds = Number(header);
  else if (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(header)) {
    seconds = Math.max(0, Math.ceil((Date.parse(header) - now) / 1000));
  }
  if (Number.isSafeInteger(seconds) && Number.isSafeInteger(now + Math.max(1, seconds) * 1000)) return Math.max(1, seconds);
  return res.status === 429 ? 60 : null;
}

async function endpointError(res, target) {
  // Never echo arbitrary bodies, headers, URLs or JSON fields other than error.
  // Bound the read as well as the diagnostic; endpoints can send HTML or huge bodies.
  const reader = res.body?.getReader();
  if (!reader) return "";
  try {
    const decoder = new TextDecoder();
    let body = "", size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) return "";
      body += decoder.decode(value, { stream: true });
    }
    let detail = JSON.parse(body + decoder.decode())?.error;
    if (typeof detail !== "string" || /[<>]/.test(detail)) return "";
    const secrets = [target.url, ...Object.values(target.headers)];
    for (const [header, value] of Object.entries(target.headers)) {
      if (!/^(?:proxy-)?authorization$/i.test(header)) continue;
      const [, scheme, token] = value.match(/^\s*(\S+)\s+(.+?)\s*$/) ?? [];
      secrets.push(token);
      // An upstream can echo the decoded user or password rather than the token.
      if (/^basic$/i.test(scheme ?? "")) {
        try {
          const decoded = new TextDecoder().decode(Uint8Array.from(atob(token), (c) => c.charCodeAt(0)));
          const colon = decoded.indexOf(":");
          secrets.push(decoded, ...(colon < 0 ? [] : [decoded.slice(0, colon), decoded.slice(colon + 1)]));
        } catch { /* not base64: the raw token is already redacted */ }
      }
    }
    const url = new URL(target.url);
    secrets.push(...url.search.slice(1).split("&").map(part => part.split("=").slice(1).join("=")));
    // URL userinfo and query values may carry credentials, including escaped forms.
    for (const value of [url.username, url.password, ...url.searchParams.values()]) {
      secrets.push(value, encodeURIComponent(value));
      try { secrets.push(decodeURIComponent(value)); } catch { /* malformed escape: retain the raw value */ }
    }
    for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
      detail = detail.replaceAll(secret, "[redacted]");
    }
    return detail
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"']+|\/\/[^\s"']+/gi, "[redacted URL]")
      .replace(/\b(?:headers?|authorization|proxy-authorization|cookie|set-cookie)\s*[:=][^\r\n]*/gi, "[redacted]")
      .replace(/\b(?:bearer|basic)\s+\S+/gi, "[redacted]")
      .replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  } catch { return ""; }
  finally { await reader.cancel().catch(() => {}); }
}

function transportError(name, error, signal) {
  const timeout = error?.name === "TimeoutError" || signal.reason?.name === "TimeoutError";
  return new Error(`endpoint ${name} ${timeout ? "TimeoutError: request timeout" : "unreachable"}`);
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

// Reported for a row left for the next call or sweep: never fetched, so a
// budget that cannot also cover the commit never wastes an external call.
const PENDING = "derivation budget reached before this row; retry it";
const LIMITED = "derivation limit reached before this row; the sweep retries it";
const UNSCANNED = "derivation sweep budget reached before the end of this table; the next sweep resumes";
const waiting = (f) => f.error === PENDING || f.error === LIMITED || /deferred by cooldown/.test(f.error);
const NO_DATA_DAYS = 7;
const DAY_MS = 86_400_000;
// Rows judged per freshness read pair, and per sweep page.
const CHUNK = 200;

export function loadDerivations(env) {
  if (!env?.DERIVATIONS) return new Map();
  const obj = JSON.parse(env.DERIVATIONS);
  return new Map(Object.entries(obj).map(([k, v]) => [k, {
    url: v.url, headers: v.headers ?? {}, refreshDays: v.refresh_days ?? null, noDataDays: v.no_data_refresh_days ?? NO_DATA_DAYS,
  }]));
}

// Per derivation name, the produced_at before which a proof is refreshed
// (ordinary, no-data); "" never expires.
function refreshCutoffs(env, byName) {
  const derivations = loadDerivations(env), now = Date.now();
  const cutoff = (days) => (days == null ? "" : new Date(now - days * DAY_MS).toISOString());
  return new Map([...byName.keys()].map((name) => {
    const { refreshDays = null, noDataDays = NO_DATA_DAYS } = derivations.get(name) ?? {};
    return [name, { value: cutoff(refreshDays), noData: cutoff(noDataDays) }];
  }));
}
// provenance.detail of a lookup that completed without data for its column is
// {"no_data":true}, plus "raw" when it cites retained raw responses.
const isNoData = (detail) => { try { return JSON.parse(detail ?? "null")?.no_data === true; } catch { return false; } };
const NO_DATA_SQL = `CASE WHEN json_valid(p.detail) THEN json_extract(p.detail, '$.no_data') END IS 1`;
const expired = (proof, cutoff) => proof.produced_at < (isNoData(proof.detail) ? cutoff.noData : cutoff.value);

// An endpoint's complete upstream responses (`_raw`) go to the hub's own files,
// content-addressed, before any proof cites them. No bucket or a failed write
// fails the row: a proof never points at raw data that is not there.
async function retainRaw(env, name, raw) {
  if (raw === undefined) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`endpoint ${name} returned an invalid _raw`);
  if (!env?.ARCHIVE) throw new Error("no archive bucket to retain _raw responses");
  const body = JSON.stringify(raw);
  const key = `raw/derivations/${name}/${await sha256hex(body)}.json`;
  await env.ARCHIVE.put(key, body, { httpMetadata: { contentType: "application/json" } });
  return key;
}

// Derived properties of `table`, grouped by derivation name.
async function derivationProps(db, table) {
  const props = await propertiesFor(db, table);
  const typeOf = Object.fromEntries(props.map((p) => [p.col, p.type]));
  const byName = new Map();
  for (const p of props) {
    if (!p.derived_by?.startsWith("http:")) continue;
    const name = p.derived_by.slice(5);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(p);
  }
  return { typeOf, byName };
}

// Derivation names in dependency order: one whose inputs include another's
// outputs runs after it, so a summary never reads a value its producer is about
// to replace. Members of a cycle keep catalog order.
function dependencyOrder(byName) {
  const producer = new Map([...byName].flatMap(([name, cols]) => cols.map((p) => [p.col, name])));
  const deps = new Map([...byName].map(([name, cols]) =>
    [name, new Set(cols.flatMap((p) => p.inputs ?? []).map((c) => producer.get(c)).filter((d) => d && d !== name))]));
  const order = [];
  while (order.length < byName.size) {
    const left = [...byName.keys()].filter((n) => !order.includes(n));
    order.push(left.find((n) => [...deps.get(n)].every((d) => order.includes(d))) ?? left[0]);
  }
  return { order, deps };
}

// `floor`: statements left untouched for the caller's later work.
export async function deriveRows(db, env, table, ids, { fetchImpl = fetch, names = null, col = null, expectedUpdatedAt, floor = 0 } = {}) {
  db = queryBudget(db, 900);
  const t = ident(table);
  const derivations = loadDerivations(env);
  const catalogView = checkedReads(db);
  const out = { derived: 0, failed: [] };
  let typeOf, byName;
  try {
    ({typeOf, byName} = await derivationProps(catalogView, t));
    // Create before capturing schema read guards, including on the first lookup.
    if (byName.size && ids.length) await db.prepare(COOLDOWNS).run();
  }
  catch (e) { return {derived:0,failed:ids.map(id=>({id,col,error:String(e)}))}; }

  let schema = null;
  // Statements a derivation may still need, from the costliest one so far: a
  // row starts only while its commit fits in what is left of the budget.
  let reserve = 0;
  const { order } = dependencyOrder(byName);
  for (const id of ids) {
    for (const name of order) {
      const cols = byName.get(name);
      if (names && !names.has(name)) continue;
      // `col` narrows to the derivation that produces it; its siblings come
      // back in the same response, so they are written too rather than wasted.
      if (col && !cols.some((p) => p.col === col)) continue;

      const start = db.remaining();
      if (start - floor < Math.max(reserve, 60 + 2 * cols.length)) {
        out.failed.push({ id, col: cols[0].col, error: PENDING });
        continue;
      }
      try {
        // Re-read per derivation: one derivation's output can be another's
        // input, and hashing a stale row would leave provenance that never
        // matches (an endless re-derive loop on the sweep).
        const view = checkedReads(db);
        for (const [key, read] of catalogView.reads) view.reads.set(key, read);
        await view.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table','trigger') AND name NOT LIKE '_cf_%' AND name NOT GLOB '_life_write_*' ORDER BY name").all();
        const row = await view.prepare(`SELECT * FROM ${qident(t)} WHERE id = ? AND deleted_at IS NULL`).bind(id).first();
        if (expectedUpdatedAt !== undefined && (!row || row.id !== id || row.updated_at !== expectedUpdatedAt)) {
          throw new Error("Row changed; sync and reopen it before resolving.");
        }
        if (!row) break;
        const target = derivations.get(name);
        if (!target) {
          out.failed.push({ id, col: cols[0].col, error: `no derivation configured for ${name}` });
          continue;
        }
        // Hash the full identity so URL credentials never enter stored state.
        const endpoint = await sha256hex(JSON.stringify([name, target.url]));
        const cooldown = await db.prepare("SELECT status, retry_at FROM _derivation_cooldowns WHERE endpoint = ?").bind(endpoint).first();
        const remaining = Math.ceil(((cooldown?.retry_at ?? 0) - Date.now()) / 1000);
        if (remaining > 0) {
          out.failed.push({ id, col: cols[0].col, error: `endpoint ${name} deferred by cooldown`, status: cooldown.status, retry_after: remaining });
          continue;
        }
        const inputs = cols[0].inputs ?? [];
        const body = { tbl: t, id, inputs: Object.fromEntries(inputs.map((c) => [c, row[c] ?? null])) };
        const signal = AbortSignal.timeout(ENDPOINT_TIMEOUT_MS);
        let res;
        try {
          res = await fetchImpl(target.url, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...target.headers },
            body: JSON.stringify(body),
            signal,
          });
        } catch (e) {
          throw transportError(name, e, signal);
        }
        if (!res.ok) {
          const retry_after = retryAfter(res);
          if (retry_after) await db.prepare(`INSERT INTO _derivation_cooldowns (endpoint, status, retry_at) VALUES (?, ?, ?)
            ON CONFLICT(endpoint) DO UPDATE SET status = excluded.status, retry_at = excluded.retry_at
            WHERE excluded.retry_at > _derivation_cooldowns.retry_at`)
            .bind(endpoint, res.status, Date.now() + retry_after * 1000).run();
          const detail = await endpointError(res, target);
          out.failed.push({ id, col: cols[0].col, status: res.status,
            error: (`endpoint ${name} returned ${res.status}` + (detail ? `: ${detail}` : "")).slice(0, 512),
            ...(retry_after ? { retry_after } : {}),
          });
          continue;
        }
        let result;
        try { result = await res.json(); }
        catch (e) {
          if (e instanceof SyntaxError) throw new Error(`endpoint ${name} returned invalid JSON`);
          throw transportError(name, e, signal);
        }
        if (!result || typeof result !== "object" || Array.isArray(result)) {
          throw new Error(`endpoint ${name} returned a non-object`);
        }

        let values = {};
        const missing = [];
        for (const p of cols) {
          if (!(p.col in result)) { missing.push(p.col); continue; }
          const v = result[p.col];
          values[p.col] = v !== null && typeof v === "object" ? JSON.stringify(v) : v;
        }
        schema ??= (await db.prepare(`PRAGMA table_info(${qident(t)})`).all()).results;
        values = storageRow(schema, values);
        const props = await propertiesFor(view,t);
        // A misbehaving endpoint must not corrupt a locked column: check the
        // values we are about to write, and drop the ones that fail.
        const viol = validateRow(cols.filter((p) => p.col in values).map(p=>p.options_sql ? {...p,options:null,options_sql:null} : p), row, { ...row, ...values }, {
          inDerive: new Set(Object.keys(values)),
        });
        for (const v of viol) {
          delete values[v.col];
          out.failed.push({ id, col: v.col, error: v.message });
        }

        const written = Object.entries(values);
        if (!written.length && !missing.length) continue;
        const raw = await retainRaw(env, name, result._raw);
        const cite = (detail) => (raw ? JSON.stringify({ ...detail, raw }) : detail && JSON.stringify(detail));
        // provenance is a synced table like any other: a hub write stamps hub_at
        // (when the table has it) or replicas past the cursor never pull the proof.
        const hasHubAt = await provenanceHasHubAt(db);
        // A no-data proof hashes the value it leaves in place.
        const hashes = await proofHashes(db, typeOf, inputs, { ...row, ...values }, [...written.map(([c]) => c), ...missing]);
        const ih = hashes.inputs[0];
        const stmts = [...written.map(([c]) => [c, cite(null)]), ...missing.map((c) => [c, cite({ no_data: true })])].map(([c, detail]) => db
          .prepare(
            `INSERT INTO provenance (id, to_kind, to_ref, field, from_kind, from_ref, rel, asserted_by, detail, inputs_hash, value_hash, produced_at, updated_at, deleted_at${hasHubAt ? ", hub_at" : ""})
             VALUES (?, ?, ?, ?, ?, ?, 'derived_from', 'hub', ?, ?, ?, (${NOW}), (${NOW}), NULL${hasHubAt ? `, (${NOW})` : ""})
             ON CONFLICT(id) DO UPDATE SET from_kind = excluded.from_kind, from_ref = excluded.from_ref,
               rel = excluded.rel, asserted_by = excluded.asserted_by, detail = excluded.detail, inputs_hash = excluded.inputs_hash,
               value_hash = excluded.value_hash, produced_at = excluded.produced_at,
               updated_at = excluded.updated_at, deleted_at = NULL${hasHubAt ? `, hub_at = (${NOW})` : ""}`
          )
          // the endpoint's own ref when it gives one, else the inputs the value came from
          .bind(`${t}:${id}:${c}`, t, id, c, `http:${name}`, result._source_ref ?? ih, detail, ih, hashes.values[c][0]));
        if (written.length) {
          // a derivation is a hub write, so it re-stamps arrival time - otherwise
          // replicas past this row's hub_at would never pull the derived value.
          // Guarded on the column existing: a hub table predating hub_at still derives.
          const stamp = "hub_at" in row ? `, hub_at = (${NOW})` : "";
          stmts.push(db
            .prepare(`UPDATE ${qident(t)} SET ${written.map(([c]) => `${qident(c)} = ?`).join(", ")}, updated_at = (${NOW})${stamp} WHERE id = ?`)
            .bind(...written.map(([, v]) => v), id));
          const rules = await enforcedRules(view, t);
          const log = await historyPlan(view, db, t, [row]);
          const { updated_at, hub_at, ...expected } = {...row, ...values};
          await commitChecked(db, view.reads, t, rules, stmts, new Date().toISOString(), log, [expected], props, [{touched:Object.keys(values)}]);
        } else {
          // Proofs only: the guarded reads still pin the row the inputs came from.
          await commitChecked(db, view.reads, t, [], stmts, new Date().toISOString());
          markChanged(["provenance"]);
        }
        out.derived += 1;
      } catch (e) {
        out.failed.push({id, col: cols[0].col, error: String(e)});
      } finally {
        reserve = Math.max(reserve, Math.ceil((start - db.remaining()) * 1.25));
      }
    }
  }
  return out;
}

const _provHubAt = new WeakMap(); // per database: tests seed many, a hub has one
async function provenanceHasHubAt(db) {
  if (!_provHubAt.has(db)) {
    const { results } = await db.prepare("PRAGMA table_info(provenance)").all();
    _provHubAt.set(db, (results ?? []).some((c) => c.name === "hub_at"));
  }
  return _provHubAt.get(db);
}

// Which (row, derivation) pairs are underived or stale: no live provenance, or
// provenance whose inputs_hash no longer matches the row's current inputs.
// Judged on the stored rows in two reads per chunk, never one per cell: each
// row's inputs rendered once per distinct input list (columns listing the same
// inputs share it) in both accepted renderings, and every live proof.
// Returns [id, names] for each stale row, in id order.
async function staleWork(db, t, typeOf, byName, ids, cutoffs) {
  const props = [...byName.values()].flat();
  const lists = [...new Set(props.map((p) => JSON.stringify(p.inputs ?? [])))];
  const array = (render, list) => `json_array(${JSON.parse(list).map((c) => render(`t.${qident(c)}`, typeOf[c])).join(", ") || "NULL"})`;
  const work = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { results: rows } = await db.prepare(`SELECT t.id, ${lists.map((list, j) => `${array(canonicalSql, list)} AS "c${j}", ${array(legacySql, list)} AS "l${j}"`).join(", ")}
      FROM ${qident(t)} t WHERE t.deleted_at IS NULL AND t.id IN (SELECT value FROM json_each(?)) ORDER BY t.id`)
      .bind(JSON.stringify(ids.slice(i, i + CHUNK))).all();
    const { results: proofs } = await db.prepare("SELECT id, inputs_hash, produced_at, detail FROM provenance WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(rows.flatMap((row) => props.map((p) => `${t}:${row.id}:${p.col}`)))).all();
    const proven = new Map(proofs.map((p) => [p.id, p]));
    for (const row of rows) {
      const hashes = await Promise.all(lists.map((_, j) => Promise.all([sha256hex(row[`c${j}`]), sha256hex(row[`l${j}`])])));
      const fresh = (name) => (p) => {
        const proof = proven.get(`${t}:${row.id}:${p.col}`);
        return !!proof && hashes[lists.indexOf(JSON.stringify(p.inputs ?? []))].includes(proof.inputs_hash) && !expired(proof, cutoffs.get(name));
      };
      const names = [...byName].filter(([name, cols]) => !cols.every(fresh(name))).map(([name]) => name);
      if (names.length) work.push([row.id, names]);
    }
  }
  return work;
}

// Derive stale rows ([id, names] from staleWork) in dependency order, at most
// `limit` per derivation; the rest is reported pending, never dropped silently.
// After a derivation commits, the rows it touched are judged afresh for every
// derivation reading its outputs: their proofs may have just gone stale.
async function deriveWork(db, env, t, typeOf, byName, stale, { fetchImpl, limit, cutoffs, floor = 0 }) {
  const out = { derived: 0, failed: [] };
  const { order, deps } = dependencyOrder(byName);
  const work = new Map(stale);
  for (const [i, name] of order.entries()) {
    const cols = byName.get(name);
    const ids = [...work].filter(([, names]) => names.includes(name)).map(([id]) => id);
    for (const id of ids.slice(limit)) out.failed.push({ id, col: cols[0].col, error: LIMITED });
    if (!ids.length) continue;
    const taken = ids.slice(0, limit);
    const r = await deriveRows(db, env, t, taken, { fetchImpl, names: new Set([name]), floor });
    out.derived += r.derived;
    out.failed.push(...r.failed);
    const readers = order.slice(i + 1).filter((later) => deps.get(later).has(name));
    if (!readers.length) continue;
    try {
      const again = new Map(await staleWork(db, t, typeOf, byName, taken, cutoffs));
      for (const id of taken) work.set(id, again.get(id) ?? []);
    } catch (e) {
      if (!String(e).includes("life_write_budget")) throw e;
      // Unjudged readers count as stale: attempted or reported pending, never skipped.
      for (const id of taken) work.set(id, [...new Set([...work.get(id), ...readers])]);
    }
  }
  return out;
}

// Derive only what needs it, for the rows with these ids (the on-push path).
// Callers may hold sparse rows (a push carries only the columns it writes), so
// freshness is judged on the complete stored rows, never on what was passed.
export async function deriveStale(db, env, table, rows, { fetchImpl = fetch, limit = 50 } = {}) {
  db = queryBudget(db,900);
  const t = ident(table);
  try {
    const { typeOf, byName } = await derivationProps(db, t);
    if (!byName.size) return { derived: 0, failed: [] };
    const cutoffs = refreshCutoffs(env, byName);
    const stale = await staleWork(db, t, typeOf, byName, [...new Set(rows.map((row) => row.id))], cutoffs);
    return await deriveWork(db, env, t, typeOf, byName, stale, { fetchImpl, limit, cutoffs });
  } catch (e) {
    // Only setup and freshness reads run outside deriveRows: nothing derived yet.
    if (!String(e).includes('life_write_budget')) throw e;
    return { derived: 0, failed: rows.map(row=>({id:row.id,col:null,error:String(e)})) };
  }
}

// One page of candidates in id order after `after`: rows with a derived column
// lacking an unexpired live proof strictly newer than the row. The boundary is
// inclusive: an edit in the proof's own millisecond is a candidate. A cheap
// prefilter only; staleWork re-hashes to decide, and the continuation passes
// rows it found fresh.
async function candidates(db, t, byName, cutoffs, after, limit) {
  const unproven = [...byName].flatMap(([name, cols]) => cols.map((p) => `NOT EXISTS (SELECT 1 FROM provenance p
    WHERE p.id = ${literal(`${t}:`)} || t.id || ${literal(`:${p.col}`)} AND p.deleted_at IS NULL AND p.produced_at > t.updated_at
    AND p.produced_at >= CASE WHEN ${NO_DATA_SQL} THEN ${literal(cutoffs.get(name).noData)} ELSE ${literal(cutoffs.get(name).value)} END)`)).join(" OR ");
  const { results } = await db.prepare(`SELECT t.id FROM ${qident(t)} t WHERE t.deleted_at IS NULL AND t.id > ? AND (${unproven}) ORDER BY t.id LIMIT ?`)
    .bind(after, limit).all();
  return (results ?? []).map((row) => row.id);
}

// Each table resumes where its last sweep stopped, so rows found fresh (or
// failing on every attempt) never hide the rows after them. Each table gets an
// equal share of what is left of the budget, at most half of it for scanning;
// what it does not use passes to the tables after it.
export async function sweep(db, env, { limit = 50, fetchImpl = fetch, page = CHUNK } = {}) {
  db = queryBudget(db,900);
  const out = { derived: 0, failed: [] };
  const catalog = await db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalog_properties'")
    .first();
  if (!catalog) return out; // a hub with no catalog yet
  const { results: tables } = await db
    .prepare("SELECT DISTINCT tbl FROM catalog_properties WHERE deleted_at IS NULL AND derived_by LIKE 'http:%' ORDER BY tbl")
    .all();
  if (!tables?.length) return out;
  await db.prepare(CURSORS).run();
  const cursors = new Map(((await db.prepare("SELECT tbl, after FROM _derivation_cursors").all()).results ?? []).map((r) => [r.tbl, r.after]));
  for (const [i, { tbl }] of tables.entries()) {
    try {
      const t = ident(tbl);
      const { typeOf, byName } = await derivationProps(db, t);
      const cutoffs = refreshCutoffs(env, byName);
      const share = db.remaining() / (tables.length - i), floor = db.remaining() - share, stopAt = floor + share / 2;
      const start = cursors.get(t) ?? "", seen = [start], stale = [];
      let after = start, end = false;
      while (stale.length < limit && db.remaining() - 3 >= stopAt) {
        const ids = await candidates(db, t, byName, cutoffs, after, page);
        end = ids.length < page;
        const names = new Map(await staleWork(db, t, typeOf, byName, ids, cutoffs));
        for (const id of ids) {
          seen.push(id);
          after = id;
          if (names.has(id)) stale.push([id, names.get(id)]);
          if (stale.length >= limit) { end = false; break; }
        }
        if (end) break;
      }
      if (!end && stale.length < limit) out.failed.push({ table: t, id: null, col: null, error: UNSCANNED });
      const r = await deriveWork(db, env, t, typeOf, byName, stale, { fetchImpl, limit, cutoffs, floor });
      out.derived += r.derived;
      out.failed.push(...r.failed);
      // Resume at the first row left unattempted, else past every row handled.
      const held = r.failed.filter(waiting).map((f) => seen.indexOf(f.id)).filter((at) => at > 0);
      const next = held.length ? seen[Math.min(...held) - 1] : end ? "" : after;
      if (next !== start) {
        await db.prepare("INSERT INTO _derivation_cursors (tbl, after) VALUES (?, ?) ON CONFLICT(tbl) DO UPDATE SET after = excluded.after").bind(t, next).run();
      }
    } catch (e) {
      if (!String(e).includes('life_write_budget')) throw e;
      out.failed.push({table:tbl,id:null,col:null,error:String(e)});
    }
  }
  return out;
}
