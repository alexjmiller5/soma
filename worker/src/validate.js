// Hub-side validation: the pure row validator lives in soma-core (shared with
// every UI client); this module adds what needs D1 - resolving stored rows,
// refs and options before calling it, and the provenance hashes.
import { allowed, asList, ident, qident, same, validEditTimestamp, validateRow } from "../../core/src/validate.ts";

import {assertPublicSql} from './governance-isolation.js';

export { allowed, ident, qident, validEditTimestamp, validateRow };

// provenance is engine-created but validated like a user table: clients write edges into it.
const ENGINE_TABLES = new Set(["catalog_tables", "catalog_properties", "catalog_rules", "catalog_log", "history"]);

export async function sha256hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function tableExists(db, name) {
  return !!(await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").bind(name).first());
}

export async function propertiesFor(db, table) {
  if (ENGINE_TABLES.has(table) || !(await tableExists(db, "catalog_properties"))) return [];
  const { results } = await db
    .prepare("SELECT * FROM catalog_properties WHERE deleted_at IS NULL AND tbl = ? ORDER BY sort, col")
    .bind(table).all();
  for(const p of results ?? [])for(const field of ['options_sql','ref_table','default_value'])assertPublicSql(p[field]);
  return (results ?? []).map((p) => ({
    ...p,
    options: p.options ? JSON.parse(p.options) : null,
    inputs: p.inputs ? JSON.parse(p.inputs) : [],
  }));
}

// How a cell is rendered for hashing, typed by the catalog and identical for a
// stored column and a bound value (src/soma/catalog.py `canonical_text` mirrors
// it). D1 binds every JS number as a REAL, so a stored INTEGER 1999 read back
// and rebound arrives as 1999.0: a `number` is always REAL text (4 -> "4.0"),
// every other type renders an integral REAL as an integer ("1999"). This is why
// a derivation's inputs must themselves be cataloged columns.
export function canonicalSql(expr, type) {
  if (type === "number") return `CAST(CAST(${expr} AS REAL) AS TEXT)`;
  return `CASE WHEN typeof(${expr}) = 'real' AND ${expr} = CAST(${expr} AS INTEGER) THEN CAST(CAST(${expr} AS INTEGER) AS TEXT) ELSE CAST(${expr} AS TEXT) END`;
}

// Proofs hubs wrote before the typed rendering hashed every bound number as
// REAL text ("1999.0"), and external writers matched that. Readers accept both
// forms, so existing proofs stay fresh without re-fetching their providers.
export function legacySql(expr, type) {
  if (type === "number") return canonicalSql(expr, type);
  return `CASE WHEN typeof(${expr}) IN ('integer', 'real') THEN CAST(CAST(${expr} AS REAL) AS TEXT) ELSE CAST(${expr} AS TEXT) END`;
}

// The hashes provenance is made of, in ONE statement: the inputs and each of
// `cols`' values, each as [canonical, legacy]. `typeOf` is a {col: type}
// object from the catalog.
export async function proofHashes(db, typeOf, inputs, row, cols = []) {
  const cells = [...inputs, ...cols];
  const arg = (i) => `a${i}`;
  const array = (render) => `json_array(${inputs.map((c, i) => render(arg(i), typeOf[c])).join(", ") || "NULL"})`;
  const value = (render, c, i) => `coalesce(${render(arg(inputs.length + i), typeOf[c])}, '')`;
  const source = cells.length ? `(SELECT ${cells.map((_, i) => `? AS ${arg(i)}`).join(", ")})` : "(SELECT 1)";
  const sql = [array(canonicalSql), array(legacySql), ...cols.flatMap((c, i) => [value(canonicalSql, c, i), value(legacySql, c, i)])];
  const texts = await db.prepare(`SELECT ${sql.map((s, i) => `${s} AS h${i}`).join(", ")} FROM ${source}`)
    .bind(...cells.map((c) => row[c] ?? null)).first();
  const hashes = await Promise.all(sql.map((_, i) => sha256hex(texts[`h${i}`])));
  return { inputs: hashes.slice(0, 2), values: Object.fromEntries(cols.map((c, i) => [c, hashes.slice(2 + 2 * i, 4 + 2 * i)])) };
}


// Pre-resolve every lookup the pure validator needs (D1 is async), then validate.
export async function validatePush(db, table, rows, storageDb = null, insertOnly = false) {
  const exists = await tableExists(db, table);
  // One read for the whole push (D1 caps bind params at ~100), not one per row:
  // a push of 500 rows must not cost 500 round trips.
  const stored = new Map();
  if (exists) {
    const ids = [...new Set(rows.map((r) => r.id))];
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      const { results } = await db
        .prepare(`SELECT * FROM ${qident(table)} WHERE id IN (${chunk.map(() => "?").join(", ")})`)
        .bind(...chunk).all();
      for (const r of results ?? []) stored.set(r.id, r);
    }
  }

  const existing = [], rejected = [];
  if (insertOnly) {
    rows = rows.filter(row => {
      if (stored.has(row.id)) { existing.push(row.id); return false; }
      if (validEditTimestamp(row.updated_at)) return true;
      rejected.push({id:row.id,col:'updated_at',rule:row.updated_at == null ? 'required' : 'type',
        message:'updated_at must be a valid UTC millisecond timestamp.'});
      return false;
    });
    // Ignored content must not reach catalog lookups, validation or defaults.
    if (!rows.length) return {accepted:[],rejected,existing,expected:[],transitions:[],props:[]};
  }
  const props = await propertiesFor(db, table);
  const typeOf = Object.fromEntries(props.map((p) => [p.col, p.type]));
  const derivedCols = new Set(props.filter((p) => p.derived_by).map((p) => p.col));

  const refSet = new Set();
  for (const p of props.filter((p) => (p.type === "ref" || p.type === "multi_ref") && p.ref_table)) {
    if (!(await tableExists(db, p.ref_table))) continue;
    const ids = new Set();
    for (const r of rows) for (const x of asList(r[p.col]) ?? [r[p.col]]) if (x != null) ids.add(x);
    if (ids.size) {
      const { results } = await db.prepare(`SELECT id FROM ${qident(p.ref_table)} WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL`)
        .bind(JSON.stringify([...ids])).all();
      for (const hit of results ?? []) refSet.add(`${p.ref_table}:${hit.id}`);
    }
  }
  const extra = {};
  for (const p of props.filter((p) => p.options_sql)) {
    const { results } = await db.prepare(p.options_sql).all();
    extra[p.col] = (results ?? []).map((r) => Object.values(r)[0]);
    p.optionColumn = results?.length ? Object.keys(results[0])[0] : null;
  }

  // Resolve INSERT defaults once, then explicitly store the approved values.
  // Re-evaluating a clock/random default in a read guard would self-conflict.
  let schema = [];
  const defaults = new Map();
  if (storageDb) {
    schema = (await storageDb.prepare(`PRAGMA table_info(${qident(table)})`).all()).results;
    const fresh = [...new Set(rows.filter(r=>!stored.has(r.id)).map(r=>r.id))];
    if (fresh.length) {
      const fields = schema.filter(c=>c.dflt_value != null && !['id','updated_at','hub_at'].includes(c.name));
      const {results} = await storageDb.prepare(`SELECT value AS id${fields.map(c=>`, (${c.dflt_value}) AS ${qident(c.name)}`).join('')} FROM json_each(?)`)
        .bind(JSON.stringify(fresh)).all();
      for (const r of results) defaults.set(r.id, Object.fromEntries(schema.map(c=>[c.name,r[c.name] ?? null])));
    }
  }
  const accepted = [], expected = [], transitions = [];
  for (let row of rows) {
    // A push carries only the columns it writes. Required (and the derived
    // provenance check below) judge the row as it will BE - stored columns
    // plus this write - so a partial update need not echo the whole row.
    const before = stored.get(row.id) ?? null;
    if (before && row.updated_at <= before.updated_at) {
      accepted.push(row);
      continue;
    }
    if (storageDb) row = storageRow(schema, before ? row : {...defaults.get(row.id), ...row});
    const merged = before ? { ...before, ...row } : row;
    const approve = () => {
      accepted.push(row); stored.set(row.id, merged); expected.push(merged);
      transitions.push({before, after:merged, touched:Object.keys(row)});
    };
    if (merged.deleted_at) {
      approve();
      continue;
    }
    const viol = validateRow(storageDb ? props.map(p=>p.options_sql ? {...p,options:null,options_sql:null} : p) : props, before, merged, {
      inDerive: derivedCols,
      refOk: storageDb ? null : (t, id) => refSet.has(`${t}:${id}`),
      extraOptions: (p) => extra[p.col] ?? [],
      touched: before ? new Set(Object.keys(row)) : null,
    });
    for (const p of props.filter((p) => p.derived_by)) {
      const changed = before == null ? merged[p.col] != null : !same(merged[p.col], before[p.col]);
      if (!changed) continue;
      const prov = await db.prepare("SELECT inputs_hash, value_hash FROM provenance WHERE id = ? AND deleted_at IS NULL")
        .bind(`${table}:${row.id}:${p.col}`).first();
      const hashes = prov && await proofHashes(db, typeOf, p.inputs, merged, [p.col]);
      const ok = prov && hashes.inputs.includes(prov.inputs_hash) && hashes.values[p.col].includes(prov.value_hash);
      if (!ok) {
        viol.push({ col: p.col, rule: "provenance", message: `${p.col} changed without a matching provenance record.` });
      }
    }
    if (viol.length) rejected.push(...viol.map((v) => ({ id: row.id, ...v })));
    else approve();
  }
  return { accepted, rejected, expected, transitions, props, existing };
}

export const literal = (v) => v == null ? "NULL" : "'" + String(v).replaceAll("'", "''") + "'";

// SQLite column affinity, applied before validation and approval comparison.
// Non-numeric text in a numeric column remains text (CAST alone would turn it 0).
export function storageRow(schema, row) {
  const out = {...row};
  for (const c of schema) {
    let v = out[c.name];
    if (v == null || typeof v === 'object' || typeof v === 'boolean') continue;
    const type = c.type.toUpperCase();
    if (/INT/.test(type)) {
      if(typeof v==='string' && /^-?(0|[1-9][0-9]*)$/.test(v) && v.length<=20
        && BigInt(v)>=-9223372036854775808n && BigInt(v)<=9223372036854775807n
        && !Number.isSafeInteger(Number(v))) continue;
      if (typeof v === 'string' && /^[\t\n\r ]*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[\t\n\r ]*$/.test(v)) v = Number(v);
    } else if (/CHAR|CLOB|TEXT/.test(type)) v = String(v);
    else if (type && !/BLOB/.test(type) && typeof v === 'string' && /^[\t\n\r ]*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[\t\n\r ]*$/.test(v)) v = Number(v);
    out[c.name] = v;
  }
  return out;
}
