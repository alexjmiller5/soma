// Hub-side derivations. A derived property declares `derived_by = "http:<name>"`;
// the name is resolved ONLY through the DERIVATIONS Worker secret, so no
// external source is ever named in this repo.
//
// Protocol: POST <url> {tbl, id, inputs:{col: value}} -> a JSON object whose
// keys are column names to write, plus an optional `_source_ref`. Keys that
// are not derived columns of that derivation are ignored; a non-2xx reply or
// bad JSON leaves the cell underived and is reported in `failed`.
//
// A write is one D1 batch: the value UPDATE plus a provenance upsert per
// column, so a replica pulling the row also pulls the provenance that proves
// it and the client's `derived` rule never fires.

import { historyPlan } from "./history.js";
import { checkedReads, commitChecked, enforcedRules, queryBudget } from "./write.js";
import { ident, proofHashes, propertiesFor, qident, sha256hex, validateRow, storageRow } from "./validate.js";

// A hung endpoint would otherwise stall the whole sequential sweep.
const ENDPOINT_TIMEOUT_MS = 60_000;

// Hub-only operational state: no schema log, catalog rows or replica sync.
const COOLDOWNS = `CREATE TABLE IF NOT EXISTS _derivation_cooldowns (
  endpoint TEXT PRIMARY KEY, status INTEGER NOT NULL, retry_at INTEGER NOT NULL
)`;

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

export function loadDerivations(env) {
  if (!env?.DERIVATIONS) return new Map();
  const obj = JSON.parse(env.DERIVATIONS);
  return new Map(Object.entries(obj).map(([k, v]) => [k, { url: v.url, headers: v.headers ?? {} }]));
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

export async function deriveRows(db, env, table, ids, { fetchImpl = fetch, names = null, col = null, expectedUpdatedAt } = {}) {
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

  for (const id of ids) {
    for (const [name, cols] of byName) {
      if (names && !names.has(name)) continue;
      // `col` narrows to the derivation that produces it; its siblings come
      // back in the same response, so they are written too rather than wasted.
      if (col && !cols.some((p) => p.col === col)) continue;

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
        for (const p of cols) {
          if (!(p.col in result)) continue;
          const v = result[p.col];
          values[p.col] = v !== null && typeof v === "object" ? JSON.stringify(v) : v;
        }
        const schema = (await db.prepare(`PRAGMA table_info(${qident(t)})`).all()).results;
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
        if (!written.length) continue;
        const sets = written.map(([c]) => `${qident(c)} = ?`).join(", ");
        // a derivation is a hub write, so it re-stamps arrival time — otherwise
        // replicas past this row's hub_at would never pull the derived value.
        // Guarded on the column existing: a hub table predating hub_at still derives.
        const stamp = "hub_at" in row ? `, hub_at = (${NOW})` : "";
        const stmts = [
          db
            .prepare(`UPDATE ${qident(t)} SET ${sets}, updated_at = (${NOW})${stamp} WHERE id = ?`)
            .bind(...written.map(([, v]) => v), id),
        ];
        // provenance is a synced table like any other: a hub write stamps hub_at
        // (when the table has it) or replicas past the cursor never pull the proof.
        const hasHubAt = await provenanceHasHubAt(db);
        const hashes = await proofHashes(db, typeOf, inputs, { ...row, ...values }, written.map(([c]) => c));
        const ih = hashes.inputs[0];
        for (const [c, v] of written) {
          stmts.push(
            db
              .prepare(
                `INSERT INTO provenance (id, to_kind, to_ref, field, from_kind, from_ref, rel, asserted_by, inputs_hash, value_hash, produced_at, updated_at, deleted_at${hasHubAt ? ", hub_at" : ""})
                 VALUES (?, ?, ?, ?, ?, ?, 'derived_from', 'hub', ?, ?, (${NOW}), (${NOW}), NULL${hasHubAt ? `, (${NOW})` : ""})
                 ON CONFLICT(id) DO UPDATE SET from_kind = excluded.from_kind, from_ref = excluded.from_ref,
                   rel = excluded.rel, asserted_by = excluded.asserted_by, inputs_hash = excluded.inputs_hash,
                   value_hash = excluded.value_hash, produced_at = excluded.produced_at,
                   updated_at = excluded.updated_at, deleted_at = NULL${hasHubAt ? `, hub_at = (${NOW})` : ""}`
              )
              .bind(
                `${t}:${id}:${c}`,
                t,
                id,
                c,
                `http:${name}`,
                // the endpoint's own ref when it gives one, else the inputs the value came from
                result._source_ref ?? ih,
                ih,
                hashes.values[c][0]
              )
          );
        }
        const rules = await enforcedRules(view, t);
        const log = await historyPlan(view, db, t, [row]);
        const { updated_at, hub_at, ...expected } = {...row, ...values};
        await commitChecked(db, view.reads, t, rules, [...stmts.slice(1), stmts[0]], new Date().toISOString(), log, [expected], props, [{touched:Object.keys(values)}]);
        out.derived += 1;
      } catch (e) {
        out.failed.push({id, col: cols[0].col, error: String(e)});
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
async function staleWork(db, table, typeOf, byName, rows) {
  const work = new Map();
  for (const row of rows) {
    for (const [name, cols] of byName) {
      for (const p of cols) {
        const prov = await db
          .prepare("SELECT inputs_hash FROM provenance WHERE id = ? AND deleted_at IS NULL")
          .bind(`${table}:${row.id}:${p.col}`)
          .first();
        if (prov && (await proofHashes(db, typeOf, p.inputs ?? [], row)).inputs.includes(prov.inputs_hash)) continue;
        if (!work.has(name)) work.set(name, new Set());
        work.get(name).add(row.id);
        break;
      }
    }
  }
  return work;
}

// Derive only what needs it, for rows already in hand (the on-push path).
export async function deriveStale(db, env, table, rows, { fetchImpl = fetch, limit = 50 } = {}) {
  db = queryBudget(db,900);
  const t = ident(table);
  const out = { derived: 0, failed: [] };
  try {
    const { typeOf, byName } = await derivationProps(db, t);
    if (!byName.size) return out;
    for (const [name, ids] of await staleWork(db, t, typeOf, byName, rows)) {
      const r = await deriveRows(db, env, t, [...ids].slice(0, limit), { fetchImpl, names: new Set([name]) });
      out.derived += r.derived;
      out.failed.push(...r.failed);
    }
  } catch (e) {
    if (!String(e).includes('life_write_budget')) throw e;
    out.failed.push(...rows.map(row=>({id:row.id,col:null,error:String(e)})));
  }
  return out;
}

// Cheap SQL prefilter: rows with no provenance for this column, or whose
// updated_at moved past it. staleWork then re-hashes to decide for real.
async function candidates(db, table, col, limit) {
  const { results } = await db
    .prepare(
      `SELECT t.* FROM ${qident(table)} t
       LEFT JOIN provenance p ON p.id = ? || ':' || t.id || ':' || ? AND p.deleted_at IS NULL
       WHERE t.deleted_at IS NULL AND (p.id IS NULL OR t.updated_at > p.produced_at)
       LIMIT ?`
    )
    .bind(table, col, limit)
    .all();
  return results ?? [];
}

export async function sweep(db, env, { limit = 50, fetchImpl = fetch } = {}) {
  db = queryBudget(db,900);
  const out = { derived: 0, failed: [] };
  const catalog = await db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalog_properties'")
    .first();
  if (!catalog) return out; // a hub with no catalog yet
  const { results: tables } = await db
    .prepare("SELECT DISTINCT tbl FROM catalog_properties WHERE deleted_at IS NULL AND derived_by LIKE 'http:%'")
    .all();
  for (const { tbl } of tables ?? []) {
    try {
      const t = ident(tbl);
      const { byName } = await derivationProps(db, t);
      const rows = new Map();
      for (const cols of byName.values()) {
        for (const p of cols) for (const row of await candidates(db, t, p.col, limit)) rows.set(row.id, row);
      }
      if (!rows.size) continue;
      const r = await deriveStale(db, env, t, [...rows.values()], { fetchImpl, limit });
      out.derived += r.derived;
      out.failed.push(...r.failed);
    } catch (e) {
      if (!String(e).includes('life_write_budget')) throw e;
      out.failed.push({table:tbl,id:null,col:null,error:String(e)});
    }
  }
  return out;
}
