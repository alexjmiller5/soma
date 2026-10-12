import type { Catalog, SearchArgs, SearchHit, SearchIndexStatus, SearchIndexStepArgs } from './contract.generated.ts';
import type { SqlDriver } from './driver.ts';
import { catalogRevisionSQL, readCatalog } from './catalog.ts';
import { qident, type Row } from './validate.ts';
import { markdownMentions } from './mentions.ts';
import { isReadOnlyTable } from './write.ts';
import { SIZE_RULE_ROWS } from './sync.ts';

export const SEARCH_TEXT_TYPES = new Set(['text', 'markdown', 'select', 'url', 'email', 'phone', 'ref', 'date', 'datetime', 'date_or_datetime']);

/** FTS syntax is never user syntax. All words are literal prefixes, ANDed.
 * Unicode letters/numbers/marks work in JSC without Intl or a platform parser. */
export function compileSearch(text: string): string | null {
  if (typeof text !== 'string' || text.length > 4096) throw new Error('Invalid search text (maximum 4096 characters).');
  const terms = text.match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
  if (terms.length > 64) throw new Error('Invalid search text (maximum 64 words).');
  return terms.length ? terms.map(term => `"${term}"*`).join(' AND ') : null;
}

/** Queue-only triggers deliberately require no FTS module in other writers.
 * UPSERT avoids an outer OR ABORT/IGNORE/REPLACE overriding conflict handling. */
export function searchTriggers(table: string, target = table): { name: string; sql: string }[] {
  const literal = `'${table.replace(/'/g, "''")}'`;
  return ['insert', 'update', 'delete'].map(event => {
    const name = `_core_search_${table}_${event}`;
    const rows = event === 'update' ? ['OLD', 'NEW'] : [event === 'delete' ? 'OLD' : 'NEW'];
    const enqueue = rows.map(row => `INSERT INTO _core_search_dirty(tbl,row_id) SELECT ${literal},${row}.id WHERE typeof(${row}.id)='text' AND ${row}.id<>'' ON CONFLICT(tbl,row_id) DO NOTHING;`).join(' ');
    return { name, sql: `CREATE TRIGGER ${qident(name)} AFTER ${event.toUpperCase()} ON ${qident(target)} BEGIN ${enqueue} END` };
  });
}

export function isSearchTrigger(trigger: Row): boolean {
  if (trigger.temporary || typeof trigger.tbl_name !== 'string') return false;
  // ALTER TABLE RENAME rewrites ON but leaves the trigger name and queue
  // literal unchanged. Recognize that exact harmless form for reconciliation.
  const owner = /^_core_search_(.+)_(insert|update|delete)$/.exec(String(trigger.name))?.[1];
  if (!owner) return false;
  try { return searchTriggers(owner, trigger.tbl_name).some(t => t.name === trigger.name && t.sql === trigger.sql); }
  catch { return false; }
}

/** Never indexed unless opted in: provenance edges repeat other rows' identities, not text anyone looks for. */
const UNSEARCHED = new Set(['provenance']);
/** Tables the sync size rule would leave out by default (more rows than this) stay out of the index too. */
export const SEARCH_MAX_ROWS = SIZE_RULE_ROWS;
/** `_core_state` key: a JSON object of table -> true (index it) or false (leave it out), overriding the defaults. */
export const SEARCH_TABLES_KEY = 'search_tables';
const CACHE = ['_core_search_fts', '_core_search_docs', '_core_search_dirty', '_core_search_state', '_core_search_mentions'];

/** Creates the cache tables; reads call it too, so a fresh replica answers from an empty index. */
async function initSearch(db: SqlDriver) {
  const names = new Set((await db.all("SELECT name FROM main.sqlite_master WHERE type='table' AND name GLOB '_core_search_*'")).map(r => r.name));
  const complete = CACHE.every(name => names.has(name));
  // Pending work arrived after the rest; an older complete cache simply has none.
  if (complete && names.has('_core_search_work')) return;
  if (!complete) {
    // These tables form one disposable cache. Recreating just one would leave
    // apparently current fingerprints beside an empty or stale index. Dropping
    // frees a large index without reading it back row by row.
    for (const name of [...CACHE, '_core_search_work']) if (names.has(name)) await db.run(`DROP TABLE ${qident(name)}`);
  }
  try {
    await db.run("CREATE VIRTUAL TABLE IF NOT EXISTS _core_search_fts USING fts5(body, tokenize='unicode61')");
  } catch (error) {
    if (/no such module: fts5|no such tokenizer: unicode61/i.test(String(error))) {
      throw new Error('Search requires SQLite FTS5 with the unicode61 tokenizer. Use an FTS5-enabled SQLite build; search has no scan fallback.');
    }
    throw error;
  }
  await db.run('CREATE TABLE IF NOT EXISTS _core_search_docs (docid INTEGER PRIMARY KEY, tbl TEXT NOT NULL, row_id TEXT NOT NULL, label TEXT NOT NULL, trashed INTEGER NOT NULL, UNIQUE(tbl,row_id))');
  await db.run('CREATE TABLE IF NOT EXISTS _core_search_dirty (tbl TEXT NOT NULL, row_id TEXT NOT NULL, PRIMARY KEY(tbl,row_id))');
  await db.run('CREATE TABLE IF NOT EXISTS _core_search_state (tbl TEXT PRIMARY KEY, fingerprint TEXT NOT NULL)');
  // Backlinks: Markdown mentions of live rows, rebuilt from bodies like the text index.
  await db.run('CREATE TABLE IF NOT EXISTS _core_search_mentions (tbl TEXT NOT NULL, row_id TEXT NOT NULL, target_tbl TEXT NOT NULL, target_id TEXT NOT NULL, PRIMARY KEY(tbl,row_id,target_tbl,target_id)) WITHOUT ROWID');
  await db.run('CREATE INDEX IF NOT EXISTS _core_search_mentions_target ON _core_search_mentions(target_tbl,target_id)');
  // Per-table work the index step still owes: remove its entries (purge), then index
  // its rows in id order from `backfill` (NULL once complete or retired); `left` is
  // the estimated rows still to walk, so reporting progress never counts a table.
  await db.run('CREATE TABLE IF NOT EXISTS _core_search_work (tbl TEXT PRIMARY KEY, purge INTEGER NOT NULL, backfill TEXT, left INTEGER NOT NULL DEFAULT 0)');
}

type IndexedTable = { table: string; columns: string[]; markdown: string[]; display?: string; fingerprint: string; sweep: boolean; rowid: boolean };
/** sqlite_master rows by name, so describing every table stays linear: on a host whose
 * JavaScript runs without a JIT, per-table scans of the whole schema add up. */
type Schema = { tables: Map<string, Row>; indexes: Map<string, string[]>; triggers: Map<string, unknown> };
function indexSchema(rows: Row[]): Schema {
  const schema: Schema = { tables: new Map(), indexes: new Map(), triggers: new Map() };
  for (const row of rows) {
    if (row.type === 'table') schema.tables.set(String(row.name), row);
    else if (row.type === 'trigger') schema.triggers.set(String(row.name), row.sql);
    else if (row.type === 'index') {
      const list = schema.indexes.get(String(row.tbl_name));
      if (list) list.push(String(row.sql)); else schema.indexes.set(String(row.tbl_name), [String(row.sql)]);
    }
  }
  return schema;
}
/** `properties` are the table's catalog properties; `columns` its PRAGMA table_info rows. */
function describeTable(entry: Row, properties: Catalog['properties'], schema: Schema, columns: Row[]): IndexedTable | null {
  const table = String(entry.id);
  if (/^(_|sqlite_)/i.test(table)) return null;
  const physical = schema.tables.get(table);
  if (!physical || /^CREATE VIRTUAL TABLE/i.test(String(physical.sql))) return null;
  if (!columns.some(c => c.name === 'id' && c.pk === 1) || columns.filter(c => c.pk).length !== 1
    || !columns.some(c => c.name === 'deleted_at')) return null;
  const names = new Set(columns.map(c => c.name));
  const text = properties.filter(p => SEARCH_TEXT_TYPES.has(p.type ?? 'text') && names.has(p.col)).map(p => p.col).sort();
  if (!text.length) return null;
  const markdown = properties.filter(p => p.type === 'markdown' && names.has(p.col)).map(p => p.col).sort();
  const display = typeof entry.display === 'string' && names.has(entry.display) ? entry.display : undefined;
  const indexes = schema.indexes.get(table) ?? [];
  // Indexes never change what a row's entry holds, so a query index (logged DDL every
  // replica replays) re-indexes nothing.
  const fingerprint = JSON.stringify([3, physical.sql, text, display, markdown]);
  // REPLACE can silently delete a victim of another UNIQUE constraint when
  // recursive_triggers is off. Only dirty tables with such constraints need
  // an indexed ID anti-join sweep; clean searches never scan source contents.
  // Read from the current schema each step, so a unique index added later counts too.
  const sweep = /unique|collate/i.test([physical.sql, ...indexes].join(' '));
  return { table, columns: text, markdown, display, fingerprint, sweep, rowid: !/WITHOUT\s+ROWID\s*$/i.test(String(physical.sql).trim()) };
}

const stateTable = async (db: SqlDriver) => (await db.all("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name='_core_state'")).length > 0;
/** The defaults' inputs: sync's stored hub row counts and the per-table choices. Unreadable values count as absent. */
async function searchSettings(db: SqlDriver) {
  const values = await stateTable(db) ? await db.all('SELECT key,value FROM main._core_state WHERE key IN (?,?)', ['hub_stats', SEARCH_TABLES_KEY]) : [];
  const parse = (key: string): Record<string, unknown> => {
    try {
      const value = JSON.parse(String(values.find(r => r.key === key)?.value ?? 'null'));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  };
  const counts = parse('hub_stats').tables;
  return { counts: (counts && typeof counts === 'object' ? counts : {}) as Record<string, unknown>, chosen: parse(SEARCH_TABLES_KEY) };
}
const literal = (text: string) => `'${text.replace(/'/g, "''")}'`;
/** Which tables the index holds, with roughly how many rows each has (to report progress).
 * Reconciliation runs inside a host's step, so it reads every table in a few statements. */
async function sizeTables(db: SqlDriver, tables: IndexedTable[], { counts, chosen }: Awaited<ReturnType<typeof searchSettings>>) {
  const sizes = new Map<string, number>(), unknown: IndexedTable[] = [];
  for (const t of tables) {
    if (chosen[t.table] === false || (chosen[t.table] !== true && UNSEARCHED.has(t.table))) continue;
    if (Number.isSafeInteger(counts[t.table])) {
      if (chosen[t.table] === true || (counts[t.table] as number) <= SEARCH_MAX_ROWS) sizes.set(t.table, counts[t.table] as number);
    } else unknown.push(t);
  }
  // No hub count (never synced, or a local table). Rowids are unique integers, so their
  // span bounds the row count with two index lookups; only a wide span is counted.
  const spans = new Map<string, number>();
  const rowid = unknown.filter(t => t.rowid);
  for (let i = 0; i < rowid.length; i += 100) {
    // Separate subqueries: SQLite answers a lone min() or max() from the index, not both at once.
    const sql = rowid.slice(i, i + 100).map(t => `SELECT ${literal(t.table)} AS tbl,ifnull((SELECT max(rowid) FROM ${qident(t.table)})-(SELECT min(rowid) FROM ${qident(t.table)})+1,0) AS n`).join(' UNION ALL ');
    for (const row of await db.all(sql)) spans.set(String(row.tbl), Number(row.n));
  }
  for (const t of unknown) {
    const span = spans.get(t.table);
    if (chosen[t.table] !== true && span !== undefined && span <= SEARCH_MAX_ROWS) { sizes.set(t.table, span); continue; }
    // An opted-in table may be any size and is counted in full; otherwise stop just past the limit.
    const limit = chosen[t.table] === true ? '' : ` LIMIT ${SEARCH_MAX_ROWS + 1}`;
    const rows = Number((await db.all(`SELECT count(*) AS n FROM (SELECT 1 FROM ${qident(t.table)}${limit})`))[0]?.n ?? 0);
    if (chosen[t.table] === true || rows <= SEARCH_MAX_ROWS) sizes.set(t.table, rows);
  }
  return sizes;
}

/** The _core_state row recording the schema, catalog and settings of the last reconciliation. */
const READY = '';
/** The catalog revision, the size-rule inputs and every table and trigger definition, built and
 * compared inside SQLite: host bridges need not return row objects with a stable key order.
 * Indexes are left out: adding or dropping one changes nothing the index holds. */
async function searchStampSQL(db: SqlDriver): Promise<string> {
  const settings = await stateTable(db)
    ? `(SELECT ifnull(group_concat(key||'='||value,char(30)),'') FROM (SELECT key,value FROM main._core_state WHERE key IN ('hub_stats','${SEARCH_TABLES_KEY}') ORDER BY key))`
    : "''";
  return `${await catalogRevisionSQL(db)}||'|'||${settings}||'|'||(SELECT ifnull(group_concat(m,char(30)),'') FROM (SELECT type||char(31)||name||char(31)||tbl_name||char(31)||ifnull(sql,'') AS m
    FROM main.sqlite_master WHERE type IN ('table','trigger') ORDER BY type,name))`;
}
/** Neither schema, catalog nor settings moved since the last reconciliation: the
 * tracked tables, their triggers and their fingerprints are all still right. */
async function reconciled(db: SqlDriver): Promise<boolean> {
  if (!(await db.all("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name='_core_search_state'")).length) return false;
  const [ready] = await db.all(`SELECT fingerprint IS (${await searchStampSQL(db)}) AS same FROM _core_search_state WHERE tbl=?`, [READY]);
  return !!ready?.same;
}
/** Rows wait to be indexed: results may be incomplete. Call after initSearch. */
async function catchingUp(db: SqlDriver): Promise<boolean> {
  if (!(await reconciled(db))) return true;
  const [row] = await db.all('SELECT EXISTS(SELECT 1 FROM _core_search_dirty) OR EXISTS(SELECT 1 FROM _core_search_work WHERE backfill IS NOT NULL) AS behind');
  return !!row?.behind;
}

/** Brings tracked tables, triggers and fingerprints in line with the schema, catalog and
 * settings. It only records work (purges and backfills); the index step does it in chunks. */
/** Just the catalog columns describing tables needs: each value read crosses a host bridge. */
async function searchCatalog(db: SqlDriver): Promise<Catalog> {
  const names = new Set((await db.all("SELECT name FROM main.sqlite_master WHERE type='table' AND name IN ('catalog_tables','catalog_properties')")).map(r => r.name));
  return {
    tables: names.has('catalog_tables') ? await db.all('SELECT * FROM catalog_tables WHERE deleted_at IS NULL ORDER BY id') : [],
    properties: names.has('catalog_properties') ? await db.all('SELECT tbl,col,type FROM catalog_properties WHERE deleted_at IS NULL ORDER BY id') as Catalog['properties'] : [],
    rules: [],
  };
}

/** A stored fingerprint in the current format. Version 2 also listed the table's index
 * definitions; without them it describes the same rows, so an upgrade re-indexes nothing. */
function definitionOf(fingerprint: unknown): unknown {
  try {
    const parsed = JSON.parse(String(fingerprint));
    return Array.isArray(parsed) && parsed[0] === 2 && parsed.length === 6 ? JSON.stringify([3, parsed[1], ...parsed.slice(3)]) : fingerprint;
  } catch { return fingerprint; }
}

/** Every table the index could hold, described from the catalog and schema in a few statements. */
async function candidateTables(db: SqlDriver) {
  const catalog = await searchCatalog(db);
  const rows = await db.all("SELECT type,name,tbl_name,sql FROM main.sqlite_master WHERE type IN ('table','index','trigger')");
  const schema = indexSchema(rows);
  const properties = new Map<string, Catalog['properties']>();
  for (const p of catalog.properties) {
    const list = properties.get(String(p.tbl));
    if (list) list.push(p); else properties.set(String(p.tbl), [p]);
  }
  const columns = new Map<string, Row[]>();
  for (const row of await db.all(`SELECT m.name AS tbl,p.name,p.pk FROM main.sqlite_master AS m JOIN pragma_table_info(m.name) AS p
    WHERE m.type='table' AND m.name IN (SELECT value FROM json_each(?))`, [JSON.stringify(catalog.tables.map(t => t.id))])) {
    columns.set(String(row.tbl), [...columns.get(String(row.tbl)) ?? [], row]);
  }
  return { rows, schema, candidates: catalog.tables.flatMap(entry => describeTable(entry, properties.get(String(entry.id)) ?? [], schema, columns.get(String(entry.id)) ?? []) ?? []) };
}

async function reconcile(db: SqlDriver): Promise<void> {
  await initSearch(db);
  const { rows, schema, candidates } = await candidateTables(db);
  const sizes = await sizeTables(db, candidates, await searchSettings(db));
  const tables = candidates.filter(t => sizes.has(t.table));
  const expected = new Map(tables.flatMap(t => searchTriggers(t.table).map(trigger => [trigger.name, trigger.sql] as const)));
  for (const trigger of rows.filter(r => r.type === 'trigger' && String(r.name).startsWith('_core_search_'))) {
    if (expected.get(String(trigger.name)) !== trigger.sql) {
      // Never replace somebody else's trigger merely because its name matches.
      if (!isSearchTrigger(trigger)) throw new Error('Search trigger definition does not match the core contract.');
      await db.run(`DROP TRIGGER ${qident(String(trigger.name))}`);
    }
  }
  const states = await db.all('SELECT tbl,fingerprint FROM _core_search_state');
  for (const state of states) {
    if (state.tbl === READY || tables.some(t => t.table === state.tbl)) continue;
    // Retired (dropped, renamed, excluded): it stops answering now; its entries go in chunks.
    const retired = String(state.tbl);
    await db.run('DELETE FROM _core_search_dirty WHERE tbl=?', [retired]);
    await db.run('DELETE FROM _core_search_state WHERE tbl=?', [retired]);
    await db.run('INSERT INTO _core_search_work(tbl,purge,backfill) VALUES (?,1,NULL) ON CONFLICT(tbl) DO UPDATE SET purge=1,backfill=NULL', [retired]);
  }
  const fingerprints = new Map(states.map(s => [String(s.tbl), definitionOf(s.fingerprint)]));
  const changed = tables.filter(t => !(fingerprints.get(t.table) === t.fingerprint
    && searchTriggers(t.table).every(trigger => schema.triggers.get(trigger.name) === trigger.sql)));
  // The backfill walks the rows already there, after purging any entries an earlier
  // definition left; it installs the table's queue triggers as it starts (armWalk).
  const stale = new Set((await db.all('SELECT value AS tbl FROM json_each(?) WHERE EXISTS (SELECT 1 FROM _core_search_docs WHERE tbl=value)',
    [JSON.stringify(changed.map(t => t.table))])).map(r => String(r.tbl)));
  await db.run(`INSERT INTO _core_search_work(tbl,purge,backfill,left) SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),'',json_extract(value,'$[2]')
    FROM json_each(?) WHERE true ON CONFLICT(tbl) DO UPDATE SET purge=excluded.purge,backfill='',left=excluded.left`,
    [JSON.stringify(changed.map(t => [t.table, stale.has(t.table) ? 1 : 0, sizes.get(t.table) ?? 0]))]);
  await db.run(`INSERT INTO _core_search_state(tbl,fingerprint) SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?)
    WHERE true ON CONFLICT(tbl) DO UPDATE SET fingerprint=excluded.fingerprint`, [JSON.stringify(changed.map(t => [t.table, t.fingerprint]))]);
  await db.run(`INSERT INTO _core_search_state(tbl,fingerprint) SELECT ?,${await searchStampSQL(db)} WHERE true ON CONFLICT(tbl) DO UPDATE SET fingerprint=excluded.fingerprint`, [READY]);
}

/** Replaces the index entries of these queued or walked IDs with their rows' current text. */
/** SQL forms of displayName and of the indexed text: a value of a scalar type as text, else nothing.
 * Building entries in SQL keeps row text off host bridges; only Markdown with links reaches JavaScript. */
const scalarText = (col: string) => `CASE WHEN typeof(s.${qident(col)}) IN ('text','integer','real') THEN CAST(s.${qident(col)} AS TEXT) END`;
const labelText = (col: string) => `nullif(trim(${scalarText(col)},' '||char(9,10,11,12,13)),'')`;
async function indexBatch(db: SqlDriver, indexed: IndexedTable, ids: unknown[]) {
  const { table, columns, display, markdown } = indexed;
  const source = qident(table), queued = JSON.stringify(ids);
  const found = await db.all(`SELECT id FROM ${source} WHERE id IN (SELECT value FROM json_each(?))`, [queued]);
  // Source PK collation can resolve a queued spelling to a different ID.
  // Replace both identities: aliases in later batches may resolve to a row
  // already indexed by an earlier batch. Cache and queue keys are binary.
  const replacedIds = JSON.stringify([...new Set([...ids, ...found.map(r => r.id)])]);
  await db.run('DELETE FROM _core_search_fts WHERE rowid IN (SELECT docid FROM _core_search_docs WHERE tbl=? AND row_id IN (SELECT value FROM json_each(?)))', [table, replacedIds]);
  await db.run('DELETE FROM _core_search_docs WHERE tbl=? AND row_id IN (SELECT value FROM json_each(?))', [table, replacedIds]);
  await db.run('DELETE FROM _core_search_mentions WHERE tbl=? AND row_id IN (SELECT value FROM json_each(?))', [table, replacedIds]);
  const label = `coalesce(${display ? `${labelText(display)},` : ''}${labelText('id')},'Untitled')`;
  // Source columns are qualified: a table may have its own tbl, row_id or label column.
  await db.run(`INSERT INTO _core_search_docs(tbl,row_id,label,trashed) SELECT ?,s.id,${label},s.deleted_at IS NOT NULL FROM ${source} AS s
    WHERE s.id IN (SELECT value FROM json_each(?))`, [table, queued]);
  // The source batch stays outermost: one docs lookup per row, never a range over the table's docs.
  await db.run(`INSERT INTO _core_search_fts(rowid,body) SELECT d.docid,${columns.map(col => `ifnull(${scalarText(col)},'')`).join("||char(10)||")}
    FROM ${source} AS s CROSS JOIN _core_search_docs AS d ON d.tbl=? AND d.row_id=s.id WHERE s.id IN (SELECT value FROM json_each(?))`, [table, queued]);
  if (!markdown.length) return;
  const linked = await db.all(`SELECT id,${markdown.map(qident).join(',')} FROM ${source} WHERE id IN (SELECT value FROM json_each(?))
    AND deleted_at IS NULL AND (${markdown.map(col => `instr(${qident(col)},'iris://table/')>0`).join(' OR ')})`, [queued]);
  const mentions = JSON.stringify(linked.flatMap(row => markdown
    .flatMap(col => typeof row[col] === 'string' ? markdownMentions(row[col] as string) : [])
    .map(target => [row.id, target.table, target.id])));
  await db.run("INSERT OR IGNORE INTO _core_search_mentions(tbl,row_id,target_tbl,target_id) SELECT ?,json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]') FROM json_each(?)", [table, mentions]);
}

const BATCH = 200, PURGE_BATCH = 500;
/** Rows per indexing chunk, per database: halved after a chunk overruns its time target and
 * grown back after quick ones, so wide rows or a host without a JIT keep chunks short. */
const batches = new WeakMap<SqlDriver, number>();
async function timedBatch(db: SqlDriver, indexed: IndexedTable, ids: unknown[], targetMs: number) {
  const started = Date.now(), size = batches.get(db) ?? BATCH;
  await indexBatch(db, indexed, ids);
  const elapsed = Date.now() - started;
  batches.set(db, elapsed > targetMs ? Math.max(10, size >> 1) : elapsed * 4 < targetMs ? Math.min(BATCH, size * 2) : size);
}
/** Tracked tables' index metadata, read once per transaction. Call only while reconciliation
 * is current, so a tracked table's description still matches its fingerprint. */
function describer(db: SqlDriver) {
  const described = new Map<string, Promise<IndexedTable | null>>();
  return (table: string) => {
    if (!described.has(table)) described.set(table, (async () => {
      if (!(await db.all('SELECT 1 FROM _core_search_state WHERE tbl=? AND tbl<>?', [table, READY])).length) return null;
      const catalog = await readCatalog(db, [table]);
      const schema = indexSchema(await db.all("SELECT type,name,tbl_name,sql FROM main.sqlite_master WHERE type IN ('table','index') AND tbl_name=?", [table]));
      return catalog.tables[0] ? describeTable(catalog.tables[0], catalog.properties, schema, await db.all(`PRAGMA main.table_info(${qident(table)})`)) : null;
    })());
    return described.get(table)!;
  };
}

/** One unit of owed work, in order: purges, queued changes, backfills. False when none is left. */
type ChunkContext = { describe: (table: string) => Promise<IndexedTable | null>; swept: Set<string>; targetMs: number; armed: boolean };
function chunkContext(db: SqlDriver, targetMs: number): ChunkContext {
  return { describe: describer(db), swept: new Set(), targetMs, armed: false };
}
/** Indexed text per chunk: one wide row (a long note, a raw payload) makes a chunk of its own. */
const CHUNK_BYTES = 262_144;
async function fitBytes(db: SqlDriver, indexed: IndexedTable, ids: unknown[]): Promise<unknown[]> {
  if (ids.length < 2) return ids;
  const size = indexed.columns.map(col => `ifnull(length(CAST(s.${qident(col)} AS BLOB)),0)`).join('+');
  const sizes = await db.all(`SELECT ifnull((SELECT ${size} FROM ${qident(indexed.table)} AS s WHERE s.id=j.value),0) AS n
    FROM json_each(?) AS j ORDER BY j.key`, [JSON.stringify(ids)]);
  let total = 0, keep = 0;
  for (const row of sizes) {
    total += Number(row.n);
    if (keep && total > CHUNK_BYTES) break;
    keep++;
  }
  return ids.slice(0, keep);
}
/** A walk installs its table's queue triggers as it starts: until then the walk itself still
 * reads every row, and reconciliation stays a few statements on hosts where each costs. */
async function armWalk(db: SqlDriver, table: string, context: ChunkContext) {
  const existing = new Map((await db.all("SELECT name,sql FROM main.sqlite_master WHERE type='trigger' AND tbl_name=?", [table])).map(r => [r.name, r.sql]));
  for (const trigger of searchTriggers(table)) {
    if (existing.get(trigger.name) === trigger.sql) continue;
    await db.run(trigger.sql);
    context.armed = true;
  }
}

async function indexChunk(db: SqlDriver, context: ChunkContext): Promise<boolean> {
  const { describe, swept, targetMs } = context;
  const [purge] = await db.all('SELECT tbl FROM _core_search_work WHERE purge=1 LIMIT 1');
  if (purge) {
    const table = String(purge.tbl);
    const doomed = await db.all('SELECT docid,row_id FROM _core_search_docs WHERE tbl=? LIMIT ?', [table, PURGE_BATCH]);
    if (!doomed.length) {
      await db.run('DELETE FROM _core_search_mentions WHERE tbl=?', [table]);
      await db.run('UPDATE _core_search_work SET purge=0 WHERE tbl=?', [table]);
      await db.run('DELETE FROM _core_search_work WHERE tbl=? AND backfill IS NULL', [table]);
      return true;
    }
    const docids = JSON.stringify(doomed.map(r => r.docid));
    await db.run('DELETE FROM _core_search_fts WHERE rowid IN (SELECT value FROM json_each(?))', [docids]);
    await db.run('DELETE FROM _core_search_docs WHERE docid IN (SELECT value FROM json_each(?))', [docids]);
    await db.run('DELETE FROM _core_search_mentions WHERE tbl=? AND row_id IN (SELECT value FROM json_each(?))', [table, JSON.stringify(doomed.map(r => r.row_id))]);
    return true;
  }
  const [dirty] = await db.all('SELECT tbl FROM _core_search_dirty LIMIT 1');
  if (dirty) {
    const table = String(dirty.tbl), indexed = await describe(table);
    if (!indexed) {
      await db.run('DELETE FROM _core_search_dirty WHERE tbl=?', [table]);
      return true;
    }
    if (indexed.sweep && !swept.has(table)) {
      swept.add(table);
      const orphan = `SELECT docid FROM _core_search_docs AS d WHERE tbl=? AND NOT EXISTS (SELECT 1 FROM ${qident(table)} AS s WHERE s.id=d.row_id AND s.id COLLATE BINARY=d.row_id COLLATE BINARY)`;
      await db.run(`DELETE FROM _core_search_mentions WHERE tbl=? AND row_id IN (SELECT row_id FROM _core_search_docs WHERE docid IN (${orphan}))`, [table, table]);
      await db.run(`DELETE FROM _core_search_fts WHERE rowid IN (${orphan})`, [table]);
      await db.run(`DELETE FROM _core_search_docs WHERE docid IN (${orphan})`, [table]);
    }
    // Queued IDs are never empty, so the batch is a keyset range seek like the backfill's.
    const ids = await fitBytes(db, indexed, (await db.all("SELECT row_id FROM _core_search_dirty WHERE tbl=? AND row_id>'' ORDER BY row_id LIMIT ?", [table, batches.get(db) ?? BATCH])).map(r => r.row_id));
    await timedBatch(db, indexed, ids, targetMs);
    await db.run('DELETE FROM _core_search_dirty WHERE tbl=? AND row_id IN (SELECT value FROM json_each(?))', [table, JSON.stringify(ids)]);
    return true;
  }
  const [walk] = await db.all('SELECT tbl,backfill FROM _core_search_work WHERE backfill IS NOT NULL LIMIT 1');
  if (!walk) return false;
  const table = String(walk.tbl), indexed = await describe(table);
  if (indexed && walk.backfill === '') await armWalk(db, table, context);
  // The primary key index keeps each page a range seek, whatever the table's size.
  const ids = indexed ? await fitBytes(db, indexed, (await db.all(`SELECT id FROM ${qident(table)} WHERE typeof(id)='text' AND id>? ORDER BY id LIMIT ?`, [String(walk.backfill), batches.get(db) ?? BATCH])).map(r => String(r.id))) : [];
  if (!ids.length) await db.run('DELETE FROM _core_search_work WHERE tbl=?', [table]);
  else {
    await timedBatch(db, indexed!, ids, targetMs);
    await db.run('UPDATE _core_search_work SET backfill=?,left=max(left-?,0) WHERE tbl=?', [String(ids[ids.length - 1]), ids.length, table]);
  }
  return true;
}

/** Queued rows plus each walking table's estimate; a walk past its estimate still counts one. */
async function indexStatus(db: SqlDriver): Promise<SearchIndexStatus> {
  const [row] = await db.all(`SELECT (SELECT count(*) FROM _core_search_dirty) AS queued,
    (SELECT ifnull(sum(max(left,1)),0) FROM _core_search_work WHERE backfill IS NOT NULL) AS walking,
    EXISTS(SELECT 1 FROM _core_search_work) AS owed`);
  const pending = Number(row?.queued ?? 0) + Number(row?.walking ?? 0);
  return { indexing: pending > 0, pending, done: pending === 0 && !row?.owed };
}

/** The only operation that builds the search index. Hosts call it after each sync round,
 * after local writes and while idle, until `done`. Each call is one transaction: it
 * reconciles if the schema, catalog or settings moved, then indexes or removes chunks of
 * rows until `budgetMs` passes (always at least one chunk), so requests between calls
 * never wait long. Searches and backlinks read whatever it has built so far. */
export async function searchIndexStep(db: SqlDriver, args: SearchIndexStepArgs = {}): Promise<SearchIndexStatus> {
  if (!args || typeof args !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(args))
    || Object.keys(args).some(k => k !== 'budgetMs')) throw new Error('Invalid search index arguments.');
  const { budgetMs = 50 } = args;
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 0) throw new Error('Invalid search index budget.');
  return db.transaction(async () => {
    const started = Date.now();
    // Every call makes progress: a reconciliation, or else at least one chunk.
    let progressed = false;
    if (!(await reconciled(db))) { await reconcile(db); progressed = true; }
    const context = chunkContext(db, Math.max(budgetMs, 25));
    while ((!progressed || Date.now() - started < budgetMs) && await indexChunk(db, context)) progressed = true;
    // Triggers a walk installed are the index's own schema change: record them as reconciled.
    if (context.armed) await db.run(`UPDATE _core_search_state SET fingerprint=${await searchStampSQL(db)} WHERE tbl=?`, [READY]);
    return indexStatus(db);
  });
}

/** Hosts may call at database open to fail early on incompatible SQLite.
 * No triggers, user rows or sync schema are changed by this capability probe. */
export async function assertSearchSupport(db: SqlDriver): Promise<void> {
  await db.transaction(async () => { await initSearch(db); });
}

/** Reads that use the index call this inside their transaction. A replica the step has not
 * reached answers from an empty index instead of failing. Once the index is otherwise current,
 * a queue of at most one batch (a few local edits) is indexed here, so a read never misses an
 * edit that a host's next step would only catch after it; anything larger waits for the step. */
export async function openSearchIndex(db: SqlDriver): Promise<void> {
  await initSearch(db);
  const [queue] = await db.all('SELECT (SELECT count(*) FROM (SELECT 1 FROM _core_search_dirty LIMIT ?)) AS queued, EXISTS(SELECT 1 FROM _core_search_work) AS owed', [BATCH + 1]);
  if (!queue?.queued || Number(queue.queued) > BATCH || queue.owed || !(await reconciled(db))) return;
  const context = chunkContext(db, 25);
  while (await indexChunk(db, context));
}
/** Whether rows still wait for the index step, for reads that report it. */
export async function searchIndexing(db: SqlDriver): Promise<boolean> {
  await initSearch(db);
  return catchingUp(db);
}

/** Conservative display cleanup, not a Markdown parser or stored projection.
 * The index retains raw text, including URLs and syntax this does not recognize.
 * Hosts render the result as plain text, never HTML. */
function excerptText(text: string): string {
  // Protect inline code and link destinations from emphasis cleanup. Unknown
  // or truncated syntax remains text rather than being erased by a parser.
  return text.split(/(`+[^`\n]+`+|!?\[[^\]\n]*\]\([^()\n]*\)|https?:\/\/[^\s]+)/g)
    .map((part, index) => index % 2
      ? part.replace(/^(`+)([^`\n]+)\1$/, '$2').replace(/^!?\[([^\]\n]*)\]\(([^()\n]*)\)$/, '$1 ($2)')
      : part.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
        .replace(/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/gm, '')
        .replace(/^[ \t]*>[ \t]?/gm, '')
        .replace(/(\*\*|__|~~)(?=\S)([^\n]*?\S)\1/g, '$2')
        .replace(/(^|[\s(])([*_])(?=\S)([^\n]*?\S)\2(?=$|[\s.,!?;)])/g, '$1$3'))
    .join('').trim();
}

async function readCatalogTables(db: SqlDriver): Promise<Catalog> {
  const exists = (await db.all("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name='catalog_tables'")).length;
  return { tables: exists ? await db.all('SELECT * FROM catalog_tables WHERE deleted_at IS NULL ORDER BY id') : [], properties: [], rules: [] };
}

/** Search only the local replica, as far as the index step has indexed it. Missing/skipped
 * remote tables are not queried; this never builds or drains the index. */
export async function search(db: SqlDriver, args: SearchArgs): Promise<SearchHit[]> {
  if (!args || typeof args !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(args))
    || Object.keys(args).some(k => !['text', 'table', 'limit', 'offset'].includes(k))) throw new Error('Invalid search arguments.');
  const query = compileSearch(args.text);
  const { table, limit = 50, offset = 0 } = args;
  if (table !== undefined && typeof table !== 'string') throw new Error('Invalid search table.');
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid search pagination.');
  return db.transaction(async () => {
    // Searching reads the index as the step left it; only the table entries are needed.
    const catalog = await readCatalogTables(db);
    if (table !== undefined && !catalog.tables.some(t => t.id === table)) throw new Error('Table is not in the catalog');
    await openSearchIndex(db);
    if (!query) return [];
    // Read-only system rows (history, provenance, catalog) repeat user text; list them after records.
    const system = catalog.tables.filter(t => isReadOnlyTable(String(t.id), t)).map(t => String(t.id));
    // A retired table stops answering at once, before the step has purged its entries.
    const scope = `d.trashed=0 AND d.tbl IN (SELECT tbl FROM _core_search_state)${table === undefined ? '' : ' AND d.tbl=?'}`, scoped = table === undefined ? [] : [table];
    // Relevance and excerpts cost work per match; a one-letter prefix matches most of a large
    // estate. Rank the newest SEARCH_RANKED_MATCHES live matches in scope (all of them below it).
    const hits = await db.all(`SELECT d.docid,d.tbl AS "table",d.row_id AS id,d.label
      FROM _core_search_fts JOIN _core_search_docs AS d ON d.docid=_core_search_fts.rowid
      WHERE _core_search_fts MATCH ? AND ${scope} AND _core_search_fts.rowid>=ifnull((SELECT f.rowid FROM _core_search_fts AS f
        JOIN _core_search_docs AS d ON d.docid=f.rowid WHERE f._core_search_fts MATCH ? AND ${scope}
        ORDER BY f.rowid DESC LIMIT 1 OFFSET ${SEARCH_RANKED_MATCHES - 1}),0)
      ORDER BY d.tbl IN (${system.map(() => '?').join(',')}),bm25(_core_search_fts),d.tbl,d.row_id LIMIT ? OFFSET ?`,
      [query, ...scoped, query, ...scoped, ...system, Math.min(limit, 200), offset]);
    // Excerpts read stored bodies by rowid; re-running MATCH per hit expands every prefix again.
    const bodies = new Map((await db.all('SELECT rowid,body FROM _core_search_fts WHERE rowid IN (SELECT value FROM json_each(?))',
      [JSON.stringify(hits.map(h => h.docid))])).map(r => [r.rowid, String(r.body ?? '')]));
    const terms = (args.text.match(/[\p{L}\p{N}\p{M}]+/gu) ?? []).map(fold);
    return hits.map(({ docid, ...hit }) => ({ ...hit, excerpt: excerptText(excerpt(bodies.get(docid) ?? '', terms)) }) as SearchHit);
  });
}

/** Ranked matches per search; more matches than this rank only the most recently indexed. */
export const SEARCH_RANKED_MATCHES = 2000;
const EXCERPT_WORDS = 24;
const fold = (word: string) => word.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** snippet()'s window: up to EXCERPT_WORDS words centred on the first word starting with a
 * search term (diacritics folded like the unicode61 tokenizer), '...' where text is cut.
 * Without such a word (another folding rule), the window starts at the beginning. */
function excerpt(body: string, terms: string[]): string {
  const word = /[\p{L}\p{N}\p{M}]+/gu, words: [number, number][] = [];
  let hit = -1, cutBefore = false, cutAfter = false;
  for (let match; (match = word.exec(body));) {
    if (hit >= 0 && words.length >= EXCERPT_WORDS && words.length - hit > EXCERPT_WORDS / 2) { cutAfter = true; break; }
    words.push([match.index, match.index + match[0].length]);
    if (hit < 0 && terms.some(term => fold(match[0]).startsWith(term))) hit = words.length - 1;
    else if (hit < 0 && words.length > EXCERPT_WORDS) { words.shift(); cutBefore = true; }
  }
  if (hit < 0) return terms.length === 1 && terms[0] === '' ? body.slice(0, 512) : excerpt(body, ['']);
  // Collection stops half a window past the hit, so the last EXCERPT_WORDS words centre it.
  const first = Math.max(0, words.length - EXCERPT_WORDS);
  const last = Math.min(words.length, first + EXCERPT_WORDS) - 1;
  cutBefore ||= first > 0;
  cutAfter ||= last < words.length - 1;
  const text = body.slice(cutBefore ? words[first]![0] : 0, cutAfter ? words[last]![1] : body.length);
  return `${cutBefore ? '...' : ''}${text}${cutAfter ? '...' : ''}`.slice(0, 512);
}

