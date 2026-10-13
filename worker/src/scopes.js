// Capabilities describe the protocol a credential may use; they never expand grants.
export const scopedReplicaUnsupported = Object.freeze({
  error: 'scoped_replica_unsupported',
  message: 'This credential supports direct API access only; replica synchronization requires broader table access.',
});

export function hasSchemaAccess(scopes) {
  return scopes.some(scope => ['admin', 'full', 'tables:read'].includes(scope));
}

export function sessionCapabilities(scopes) {
  return {
    row_api: 'v1',
    row_query: 'bounded-v1',
    conditional_patch: 'revision-v1',
    schema: hasSchemaAccess(scopes) ? 'full-ddl-v1' : 'none',
    replica_sync: scopes.some(scope => ['admin', 'full'].includes(scope)),
    subscriptions: 'durable-pull-v1',
    subscription_features: 'scalar-lifecycle-v1',
    files: 'opaque-key-v1',
  };
}

import { qident } from './validate.js';
import { trustedSubscriptionTrigger } from './subscription-triggers.js';
import { checkedReads, readGuards } from './write.js';
import { trustedContinuityTrigger } from './governance-continuity.js';
import { trustedEvidenceTrigger } from './governance-evidence.js';
import {supportedRuleSql} from '../../core/src/rule-sql.ts';

export class ScopeDenied extends Error {}
const deny = () => { throw new ScopeDenied('insufficient scope'); };
const identifier = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
const ordinaryName = name => identifier(name) && !/^(?:_|sqlite_|catalog_)/i.test(name)
  && !/^(?:history|provenance|purges)$/i.test(name);
export const broadTableAccess = (scopes, operation) => scopes.some(s => ['admin','full',`tables:${operation}`].includes(s));
export function authorizeTable(scopes, operation, table) {
  return ordinaryName(table) && scopes.includes(`tables:${operation}:${table}`);
}

// Projected readers must authorize both returned data and selection predicates.
// Keyset pagination exposes IDs; timestamp cursors are deliberately unavailable.
export function authorizeRowRead(scopes, body) {
  if (!body || !ordinaryName(body.table)) return false;
  if (authorizeTable(scopes,'read',body.table)) return true;
  const granted = column => identifier(column) && scopes.includes(`tables:read:${body.table}:${column}`);
  // An arrival cursor is a predicate on hub_at, so it needs that column's grant.
  return granted('id') && Array.isArray(body.columns) && body.columns.length > 0
    && body.columns.every(granted) && (body.since === undefined || body.since === '' || granted('hub_at'))
    && (body.where === undefined || (body.where !== null && typeof body.where === 'object'
      && !Array.isArray(body.where) && Object.keys(body.where).every(granted)));
}

// Marks are hub_at values: a whole-table grant or a hub_at column grant reads them.
export function authorizeCursor(scopes, body) {
  return !!body && Array.isArray(body.tables) && body.tables.length > 0 && body.tables.length <= 50
    && body.tables.every(t => ordinaryName(t) && (authorizeTable(scopes,'read',t) || scopes.includes(`tables:read:${t}:hub_at`)));
}
export function authorizeRead(scopes, path, body) {
  if (path === '/v1/cursor') return authorizeCursor(scopes,body);
  if (body?.batch !== undefined) return Array.isArray(body.batch) && body.batch.every(item => authorizeRowRead(scopes,item));
  return authorizeRowRead(scopes,body);
}

// Revision-guarded existing-row edits only, never push/insert or lifecycle edits.
export function authorizeRowPatch(scopes, body) {
  if (!body || !ordinaryName(body.table) || !body.values || typeof body.values !== 'object'
    || Array.isArray(body.values) || !Object.keys(body.values).length) return false;
  const read = c => scopes.includes(`tables:read:${body.table}:${c}`);
  return ['id','updated_at','hub_at'].every(read) && Object.keys(body.values).every(c =>
    identifier(c) && !['id','created_at','updated_at','hub_at','deleted_at'].includes(c)
    && read(c) && scopes.includes(`tables:patch:${body.table}:${c}`));
}

// Exact server-owned DDL only. A familiar trigger name does not establish trust.
export function timestampTrigger(trigger) {
  const table=trigger.tbl_name;
  if (!identifier(table)) return false;
  const canonical=quote=>`CREATE TRIGGER ${quote(`${table}_updated_at`)} AFTER UPDATE ON ${quote(table)} FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE ${quote(table)} SET updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE rowid = NEW.rowid; END`;
  const sql=String(trigger.sql).replace(/\s+/g,' ').trim();
  // Both forms were emitted by the CLI. Identifiers remain validated above;
  // recognize the complete statement, never a trigger name or SQL fragment.
  return sql === canonical(qident) || sql === canonical(name=>name);
}
function safeDefault(value) {
  if (value == null) return true;
  let text=String(value).trim();
  while (text.startsWith('(') && text.endsWith(')')) text=text.slice(1,-1).trim();
  return /^(?:NULL|TRUE|FALSE|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|'(?:[^']|'')*'|x'(?:[0-9a-f]{2})*')$/i.test(text)
    || text === "strftime('%Y-%m-%dT%H:%M:%fZ','now')" || text === 'lower(hex(randomblob(16)))';
}

// These are complete SQL templates, not a general SQL safety checker. SQL
// strings escape quotes only by doubling them; backslashes are plain data.
const ruleColumn = '([A-Za-z_][A-Za-z0-9_]*)';
const ruleLiteral = "'(?:[^']|'')*'";
const rowRule = `SELECT id FROM changed WHERE deleted_at IS NULL AND ${ruleColumn} LIKE ${ruleLiteral}`;
const localRules = [
  new RegExp(`^${rowRule}(?![\\s\\S])`),
  new RegExp(`^${rowRule} AND NOT EXISTS \\(SELECT 1 FROM json_each\\(coalesce\\(${ruleColumn},'\\[\\]'\\)\\) WHERE value = ${ruleLiteral}\\)(?![\\s\\S])`),
];
const uniqueRule = new RegExp(String.raw`^SELECT c\.id FROM changed c JOIN ${ruleColumn} b ON b\.${ruleColumn} = c\.\2 AND b\.id != c\.id AND b\.deleted_at IS NULL WHERE c\.deleted_at IS NULL AND c\.\2 IS NOT NULL(?![\s\S])`);
// A deletion guard, `SELECT a.id FROM changed a WHERE a.deleted_at IS NOT NULL
// AND <term>` whose single EXISTS (...) or parenthesized term ends the statement,
// is false for every live changed row whatever the term reads. A live-row patch
// cannot change deleted_at and a live insert never sets it, so either admits it.
const deletionGuard = /^SELECT ([A-Za-z_][A-Za-z0-9_]*)\.id FROM changed \1 WHERE \1\.deleted_at IS NOT NULL AND (?:EXISTS )?\(/;
function closesAtEnd(sql, open) {
  let depth=0;
  for (let i=open; i<sql.length; i++) {
    const c=sql[i];
    if (`'"\`[`.includes(c)) {
      // A doubled quote closes and reopens: the same span for paren counting.
      i=sql.indexOf(c==='['?']':c,i+1);
      if (i<0) return false;
    } else if (c==='(') depth++;
    else if (c===')' && --depth===0) return i===sql.length-1;
  }
  return false;
}
function scopedInvariant(rule, table, columns, liveRows) {
  if (rule.scope !== 'table' || rule.tbl !== table || rule.enforce !== 1 || typeof rule.sql !== 'string') return false;
  const names = new Set(columns.map(c => c.name));
  if (!names.has('id') || !names.has('deleted_at')) return false;
  const guard = liveRows && deletionGuard.exec(rule.sql);
  if (guard && sqlWords(rule.sql) && closesAtEnd(rule.sql, guard[0].length-1)) return true;
  for (const pattern of localRules) {
    const match = pattern.exec(rule.sql);
    if (match) return match.slice(1).every(col => names.has(col));
  }
  const match = uniqueRule.exec(rule.sql);
  return !!match && match[1] === table && names.has(match[2]);
}

// Any other enforced invariant of the table runs exactly as for full writers
// when its SQL can read nothing else, so a rejection reveals nothing outside
// the grant: no other table or view may be named in any quoting (SQLite also
// takes a single-quoted string as a table name, so a literal equal to one
// fails closed), and no ';' or comment may hide part of the statement.
// ponytail: word screen, not a parser; a rule naming a column that shares a
// name with another table stays ineligible.
const schemaWord = /^(?:sqlite_|pragma_)|^dbstat$/i;
function sqlWords(sql) {
  const words=[],word=/[A-Za-z0-9_$\u0080-￿]+/y;
  for (let i=0; i<sql.length;) {
    const open=sql[i];
    if (`'"\`[`.includes(open)) {
      const close=open==='['?']':open;
      let text='',j=i+1;
      for (;;) {
        if (j>=sql.length) return null;
        if (sql[j]===close) { if (close!==']' && sql[j+1]===close) { text+=close;j+=2;continue; } break; }
        text+=sql[j++];
      }
      words.push(text);i=j+1;continue;
    }
    if (open===';' || sql.startsWith('--',i) || sql.startsWith('/*',i)) return null;
    word.lastIndex=i;
    const match=word.exec(sql);
    if (match) { words.push(match[0]);i+=match[0].length; } else i++;
  }
  return words;
}
async function confinedInvariant(view, rule, table) {
  if (rule.scope !== 'table' || rule.tbl !== table || rule.enforce !== 1 || !supportedRuleSql(rule.sql)) return false;
  const words=sqlWords(rule.sql);
  if (!words) return false;
  const {results}=await view.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all();
  const others=new Set(results.map(r=>r.name.toLowerCase()).filter(name=>name!==table.toLowerCase()));
  return !words.some(w=>schemaWord.test(w) || others.has(w.toLowerCase()));
}

// provenance:create:<table>, beside tables:write:<table>, inserts origin edges
// onto live rows of that table through rows/insert, never changing an existing
// edge. The id is canonical, so only edges onto the granted table are addressable.
const edgeRequired=['id','from_kind','from_ref','to_kind','to_ref','rel','asserted_by'];
const edgeColumns=new Set([...edgeRequired,'field','detail','updated_at']);
export function authorizeEdges(scopes, body) {
  if (!body || body.table !== 'provenance' || !Array.isArray(body.columns) || !Array.isArray(body.rows) || !body.rows.length
    || new Set(body.columns).size !== body.columns.length || body.columns.some(c=>!edgeColumns.has(c))) return false;
  return body.rows.every(row=>{
    if (!row || typeof row !== 'object') return false;
    const e=Object.fromEntries(body.columns.filter(c=>Object.hasOwn(row,c)).map(c=>[c,row[c]]));
    return edgeRequired.every(c=>typeof e[c] === 'string' && e[c])
      && ['imported_from','evidence_of'].includes(e.rel) && (e.field == null || identifier(e.field))
      && authorizeTable(scopes,'write',e.to_kind) && scopes.includes(`provenance:create:${e.to_kind}`)
      && e.id === [e.from_kind,e.from_ref,e.to_kind,e.to_ref].join(':');
  });
}
export function edgePolicy(rows) {
  const edges=new Map(rows.map(row=>[row.id,row]));
  return async (view,table,write,ids) => {
    const columns=await scopedOrigin(view,ids),targets=new Map();
    for (const id of ids) {
      const edge=edges.get(id);
      if (!edge) deny();
      targets.set(edge.to_kind,[...(targets.get(edge.to_kind) ?? []),edge]);
    }
    for (const [kind,list] of targets) {
      const names=new Set((await scopedTable(view,kind)).map(c=>c.name));
      if (!names.has('deleted_at') || list.some(e=>e.field != null && !names.has(e.field))) deny();
      const refs=[...new Set(list.map(e=>e.to_ref))];
      const {results:live}=await view.prepare(`SELECT id FROM ${qident(kind)} WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL`).bind(JSON.stringify(refs)).all();
      const found=new Set(live.map(r=>r.id));
      if (refs.some(ref=>!found.has(ref))) deny();
    }
    return columns;
  };
}

// Internal origin construction has no caller-supplied SQL or edge fields.
// Admit only these complete metadata SELECT shapes; ordinary narrow writes
// still reject all SQL options and cannot address provenance.
const originOptions = new Map([
  ['from_kind', "SELECT DISTINCT derived_by FROM catalog_properties WHERE derived_by IS NOT NULL AND deleted_at IS NULL"],
  ['to_kind', "SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 1) != '_' AND name NOT LIKE 'catalog!_%' ESCAPE '!' AND name NOT LIKE 'sqlite%' AND name != 'provenance'"],
]);
const originEvidenceRule = new RegExp(`^SELECT p\\.id FROM ${ruleColumn} p WHERE p\\.deleted_at IS NULL AND p\\.${ruleColumn}=${ruleLiteral} AND NOT EXISTS \\(SELECT 1 FROM provenance v WHERE v\\.deleted_at IS NULL AND v\\.to_kind=(${ruleLiteral}) AND v\\.to_ref=p\\.id AND v\\.rel=${ruleLiteral}\\)(?![\\s\\S])`);
async function originInvariant(view, rule) {
  if (rule.scope !== 'table' || rule.tbl !== 'provenance' || rule.enforce !== 1) return false;
  const match=typeof rule.sql === 'string' && originEvidenceRule.exec(rule.sql);
  if (!match || match[3].slice(1,-1).replaceAll("''", "'") !== match[1]) return false;
  const columns=await scopedTable(view,match[1]);
  return ['id','deleted_at',match[2]].every(name=>columns.some(c=>c.name===name));
}
export function scopedOrigin(view,rowIds) {
  return inspectTable(view,'provenance',true,rowIds,true);
}
export function scopedTable(view,table,write=false,rowIds=null) {
  return inspectTable(view,table,write,rowIds,false);
}
export function scopedPatchTable(view,table,write,rowIds,patched=[]) {
  return inspectTable(view,table,write,rowIds,false,true,false,patched);
}
// rows/insert never changes an existing row, so a derived column it does not
// list stays the hub's to fill; listing one keeps the write denied.
export function scopedInsertTable(inserted) {
  return (view,table,write,rowIds)=>inspectTable(view,table,write,rowIds,false,false,false,null,inserted);
}
// A live patch leaves a derivation intact when it writes neither the derived
// column nor any of its inputs; unreadable inputs count as touched.
function derivationUntouched(prop,patched) {
  let inputs;
  try { inputs=JSON.parse(prop.inputs ?? '[]'); } catch { return false; }
  return Array.isArray(inputs) && ![prop.col,...inputs].some(c=>patched.includes(c));
}
// Only a caller with broad read authority may inspect arbitrary runtime rules
// and options. This verifies table mechanics; it does not grant that authority.
export function changesetTable(view,table,write=false,rowIds=null){
  return inspectTable(view,table,write,rowIds,table==='provenance',false,true);
}
// The table check's first reads, for any number of tables, in one round trip.
export function prefetchTables(view, tables) {
  return view.prefetch?.(tables.flatMap(table => [
    ["SELECT name,type,sql FROM sqlite_master WHERE name=?", [table], true],
    ["SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalog_tables'", [], true],
    ['SELECT * FROM catalog_tables WHERE id=? AND deleted_at IS NULL', [table], true],
    ['SELECT * FROM pragma_table_xinfo(?) ORDER BY cid', [table], false],
  ]));
}
async function inspectTable(view, table, write, rowIds, origin, livePatch=false, changeset=false, patched=null, inserted=null) {
  if (!ordinaryName(table) && !(origin && table === 'provenance')) deny();
  if (write && (!Array.isArray(rowIds) || rowIds.some(id=>typeof id !== 'string' || !id.trim()))) deny();
  const schema=await view.prepare("SELECT name,type,sql FROM sqlite_master WHERE name=?").bind(table).first();
  if (!schema || schema.type !== 'table' || !/^CREATE\s+TABLE\b/i.test(schema.sql)) deny();
  if (!await view.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalog_tables'").first()) deny();
  const catalog=await view.prepare('SELECT * FROM catalog_tables WHERE id=? AND deleted_at IS NULL').bind(table).first();
  if (!catalog || ![null,undefined,'','table'].includes(catalog.kind)) deny();
  const {results:columns}=await view.prepare('SELECT * FROM pragma_table_xinfo(?) ORDER BY cid').bind(table).all();
  if (columns.some(c=>c.hidden || !identifier(c.name)) || !columns.some(c=>c.name==='id' && c.pk===1)
    || columns.filter(c=>c.pk).length!==1 || !columns.some(c=>c.name==='updated_at')) deny();
  if (!write) return columns;
  // Narrow writes never run broad post-commit purge recovery. Any marker on a
  // submitted row (including a column marker) denies the write. Guard the empty
  // result in the mutation's transaction so concurrent new markers also block it.
  if (await view.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='purges'").first()) {
    if (await view.prepare('SELECT 1 FROM purges WHERE tbl=? AND deleted_at IS NULL').bind(table).first()) {
      // String marker identities must equal SQLite's primary-key identities.
      // Otherwise retain table-wide denial: e.g. B aliases b under NOCASE,
      // and '01' aliases 1 under INTEGER affinity, even after a row is purged.
      const {results:keys}=await view.prepare("SELECT x.name,x.coll FROM pragma_index_list(?) i JOIN pragma_index_xinfo(i.name) x WHERE i.origin='pk' AND x.key=1 ORDER BY x.seqno").bind(table).all();
      if (columns.find(c=>c.name==='id').type.toUpperCase() !== 'TEXT'
        || keys.length !== 1 || keys[0].name !== 'id' || keys[0].coll !== 'BINARY') deny();
    }
    const {results:purges}=await view.prepare('SELECT * FROM purges WHERE tbl=? AND row_id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL ORDER BY id').bind(table,JSON.stringify(rowIds)).all();
    if (purges.length) deny();
  }
  if (columns.some(c=>!safeDefault(c.dflt_value))) deny();
  const {results:triggers}=await view.prepare("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name COLLATE NOCASE IN (?, 'history', 'provenance', '_change_events', '_change_subscriptions') ORDER BY name").bind(table).all();
  for (const trigger of triggers) {
    if (['_change_events','_change_subscriptions'].includes(trigger.tbl_name.toLowerCase())) deny();
    if (!timestampTrigger(trigger) && !trustedEvidenceTrigger(trigger) && !trustedContinuityTrigger(trigger,columns.map(c=>c.name)) && !await trustedSubscriptionTrigger(view,trigger)) deny();
  }
  const {results:foreignKeys}=await view.prepare("SELECT m.name,f.id,f.seq FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f WHERE m.type='table' AND m.name NOT LIKE '_cf_%' ORDER BY m.name,f.id,f.seq").all();
  if (foreignKeys.length) deny();
  if (!await view.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalog_properties'").first()) deny();
  const {results:props}=await view.prepare('SELECT * FROM catalog_properties WHERE tbl=? AND deleted_at IS NULL ORDER BY id').bind(table).all();
  if (!props.length || props.some(p=>(p.options_sql && !(changeset && supportedRuleSql(p.options_sql)) && !(origin && originOptions.get(p.col) === p.options_sql)) || (p.derived_by && !(livePatch && Array.isArray(patched) && derivationUntouched(p,patched)) && !(Array.isArray(inserted) && !inserted.includes(p.col))) || String(p.default_value ?? '').startsWith('sql:'))) deny();
  if(changeset && columns.some(c=>!['id','created_at','updated_at','hub_at'].includes(c.name) && /\b(?:strftime|randomblob)\s*\(/i.test(c.dflt_value ?? '')))deny();
  for (const prop of props) if (prop.ref_table) await scopedTable(view,prop.ref_table);
  if (await view.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalog_rules'").first()) {
    const {results:rules}=await view.prepare("SELECT * FROM catalog_rules WHERE deleted_at IS NULL AND kind='invariant' AND enforce != 0 AND (tbl=? OR scope='estate') ORDER BY id").bind(table).all();
    // Inserted rows are live when deleted_at is neither listed nor defaulted.
    const liveRows=livePatch || (Array.isArray(inserted) && !inserted.includes('deleted_at')
      && columns.some(c=>c.name==='deleted_at' && c.dflt_value==null));
    for (const rule of rules) if (!(changeset && rule.tbl===table && rule.scope==='table' && supportedRuleSql(rule.sql)) && !scopedInvariant(rule,table,columns,liveRows)
      && !(origin ? await originInvariant(view,rule) : await confinedInvariant(view,rule,table))) deny();
  }
  return columns;
}

export async function scopedOptions(params, db, scopes) {
  const table=params.get('table'),column=params.get('column');
  if (params.getAll('table').length !== 1 || params.getAll('column').length !== 1
    || !identifier(column) || !ordinaryName(table)
    || !(authorizeTable(scopes,'read',table) || broadTableAccess(scopes,'read'))) deny();
  const view=checkedReads(db),columns=await scopedTable(view,table);
  if (!columns.some(c=>c.name===column)) deny();
  if (!await view.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalog_properties'").first()) deny();
  const {results:props}=await view.prepare('SELECT * FROM catalog_properties WHERE tbl=? AND col=? AND deleted_at IS NULL ORDER BY id').bind(table,column).all();
  if (props.length !== 1 || !['select','multi_select'].includes(props[0].type) || props[0].options_sql) deny();
  let options;
  try { options=JSON.parse(props[0].options ?? '[]'); } catch { deny(); }
  if (!Array.isArray(options) || options.some(o=>!o || typeof o.v !== 'string'
    || (o.d !== undefined && typeof o.d !== 'string')
    || (o.sort !== undefined && (typeof o.sort !== 'number' || !Number.isFinite(o.sort))))) deny();
  await db.batch(readGuards(db,view.reads));
  return {options:publicOptions(options)};
}

const OPTION_COLORS=new Set(['default','gray','brown','orange','yellow','green','blue','purple','pink','red']);
// Static option metadata for consumers; a color outside the palette is dropped, not fatal.
export function publicOptions(options) {
  return options.map(({v,d,sort,color})=>({v,...(d===undefined?{}:{d}),...(sort===undefined?{}:{sort}),
    ...(OPTION_COLORS.has(color)?{color}:{})}));
}

// One page's SQL once its table passes the read check; `view` records the
// reads the caller's guards replay. A table without hub_at has no narrow cursor.
export async function scopedQuery(view,body,maxLimit=200) {
  const schema=await scopedTable(view,body.table);
  const names=new Set(schema.map(c=>c.name)),limit=body.limit ?? 100;
  const columns=body.columns ?? [...names],where=body.where ?? {},since=body.since ?? '';
  if (!Number.isInteger(limit) || limit<1 || limit>maxLimit || !Array.isArray(columns) || !columns.length
    || columns.some(c=>!names.has(c)) || typeof since!=='string' || (body.after!==undefined && typeof body.after!=='string')
    || !where || typeof where!=='object' || Array.isArray(where)
    || Object.entries(where).some(([c,v])=>!names.has(c) || !['string','number'].includes(typeof v))) return null;
  const selected=[...new Set([...columns,'id'])],args=[],conditions=[];
  if(since) {conditions.push('hub_at >= ?');args.push(since);}
  for(const [c,v] of Object.entries(where)){conditions.push(`${qident(c)} = ?`);args.push(v);}
  const id=since?'+id':'id';
  if(body.after!==undefined){conditions.push(`${id} > ?`);args.push(body.after);}
  const sql=`SELECT ${selected.map(qident).join(',')} FROM ${qident(body.table)} ${conditions.length?'WHERE '+conditions.join(' AND '):''} ORDER BY ${id} LIMIT ?`;
  return {sql,args:[...args,limit],limit,includeId:!columns.includes('id')};
}

export async function scopedRows(body,db) {
  const view=checkedReads(db);
  await prefetchTables(view,[body.table]);
  const query=await scopedQuery(view,body);
  if (!query) return new Response(JSON.stringify({error:'invalid row request'}),{status:400,headers:{'Content-Type':'application/json'}});
  const result=await db.batch([...readGuards(db,view.reads),db.prepare(query.sql).bind(...query.args)]);
  const rows=result.at(-1).results ?? [],next_cursor=rows.length===query.limit?rows.at(-1).id:null;
  if(query.includeId) for(const row of rows) delete row.id;
  return {rows,next_cursor};
}

export function scopedResult(result) {
  if (!result || !Array.isArray(result.rejected)) return result;
  return {...result,rejected:result.rejected.map(r=>({id:r.id,col:null,rule:'validation',message:'Row rejected.',...(r.retryable?{retryable:true}:{})}))};
}
