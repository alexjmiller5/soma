import type { SqlDriver, SqlReadStatement, Value } from './driver.ts';
import { READ_DEPENDENCY_LIMITS } from './driver.ts';
import { decodeProperty } from './catalog.ts';
import { initCore } from './sync.ts';
import { coverageProblem } from './coverage.ts';
import { skippedTableNames } from './status.ts';
import { supportedRuleSql } from './rule-sql.ts';
import { isSearchTrigger } from './search.ts';
import { asList, empty, qident, validEditTimestamp, validateRow, type Property, type Row, type Violation } from './validate.ts';

import type { WriteViolation, Writeability, WriteabilityArgs } from './contract.generated.ts';
export type { WriteViolation } from './contract.generated.ts';
export class ValidationError extends Error {
  constructor(public readonly violations: WriteViolation[]) {
    super(violations.map(v => `${v.tbl}[${v.row_id ?? ''}].${v.col}: ${v.message}`).join('\n'));
    this.name = 'ValidationError';
  }
}

const systemColumns = new Set(['id', 'created_at', 'updated_at', 'hub_at', 'deleted_at']);
const plain = (v: unknown): v is Row => v !== null && typeof v === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));

/** UI and write boundary share this contract: service-owned tables carry
 * catalog_tables.kind='system'. Free-form owner text is not a permission. */
export function isReadOnlyTable(table: string, catalogEntry?: Row): boolean {
  return /^(catalog_|sqlite_|_)/i.test(table) || /^(history|provenance)$/i.test(table)
    || String(catalogEntry?.kind ?? '').trim().toLowerCase() === 'system';
}

type Fail = (col: string, rule: string, message: string) => never;
const beforeTable = '_core_write_before';
function invariantSql(table: string, sql: string): string {
  return `WITH changed AS (
    SELECT * FROM main.${qident(table)} WHERE id=? EXCEPT SELECT * FROM temp._core_write_before
  ), before AS (SELECT * FROM temp._core_write_before WHERE id IN (SELECT id FROM changed)), now AS (SELECT ? AS ts)
  SELECT * FROM (${sql}) LIMIT 1`;
}
async function unusedWriteContext(db: SqlDriver, fail: Fail): Promise<void> {
  if ((await db.all('SELECT 1 FROM temp.sqlite_master WHERE name=? COLLATE NOCASE', [beforeTable])).length) {
    fail('', 'context', 'A temporary write context is already in use. Close and reopen this workspace before editing.');
  }
}

async function prepareInvariants(db: SqlDriver, table: string, props: Property[], rules: Row[], fail: Fail): Promise<void> {
  if (!rules.length) return;
  // Own this name only after a successful CREATE. Never drop/adopt an object
  // supplied by the caller, an imported TEMP schema, or a concurrent operation.
  await db.run(`CREATE TEMP TABLE temp._core_write_before AS SELECT * FROM main.${qident(table)} WHERE 0`);
  try {
    const statements: SqlReadStatement[] = rules.map(rule => ({ sql: invariantSql(table, String(rule.sql)), params: [null, '2000-01-01T00:00:00.000Z'] }));
    let required: string[] | undefined;
    if (db.readDependencies === undefined) {
      for (const [index, statement] of statements.entries()) {
        try { await db.all(`SELECT * FROM (${statement.sql}) LIMIT 0`, statement.params); }
        catch { fail(String(rules[index].col ?? ''), 'invariant', `Enforced invariant ${rules[index].id} cannot compile with the portable before/changed/now contexts.`); }
      }
    } else {
      for (const p of props) {
        if (p.options_sql) statements.push({ sql: `SELECT * FROM (${p.options_sql})` });
        if (typeof p.default_value === 'string' && p.default_value.startsWith('sql:')) {
          statements.push({ sql: `SELECT (${p.default_value.slice(4)}) AS value` });
        }
      }
      const unavailable = () => fail('', 'coverage', 'Validation dependencies cannot be verified on this device. Use the CLI writer.');
      // Bound adapter work, without row scans or a persistent dependency cache.
      if (statements.length > READ_DEPENDENCY_LIMITS.statements
        || statements.reduce((n, s) => n + s.sql.length, 0) > READ_DEPENDENCY_LIMITS.sqlLength) unavailable();
      let result: unknown;
      try { result = await db.readDependencies(statements, { ownedTempTables: [beforeTable] }); }
      catch { unavailable(); }
      if (!plain(result) || Object.keys(result).length !== 1 || !Array.isArray(result.tables)
        || result.tables.length > READ_DEPENDENCY_LIMITS.tables || result.tables.some(t => typeof t !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(t))) unavailable();
      required = [table, ...(result as { tables: string[] }).tables];
      for (const p of props) {
        if (['ref','multi_ref'].includes(p.type ?? '')) {
          if (typeof p.ref_table !== 'string' || !p.ref_table) fail(p.col, 'catalog', 'Reference property has no ref_table; repair the catalog.');
          required.push(p.ref_table!);
        }
      }
    }
    const problem = await coverageProblem(db, required);
    if (problem) fail('', 'coverage', problem);
  } finally {
    await db.run('DROP TABLE temp._core_write_before');
  }
}
export async function prepareWriteStorage(db: SqlDriver, table: string, fail: Fail) {
  const quote = (name: string): string => {
    try { return qident(name); } catch { return fail(name, 'identifier', 'Invalid SQL identifier.'); }
  };
  if (typeof table !== 'string') fail('', 'input', 'table must be a string.');
  quote(table);
  if (isReadOnlyTable(table)) fail('', 'read_only', 'This table is read-only.');
  const exists = async (name: string) => (await db.all("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name=?", [name])).length > 0;
  for (const name of [table, 'catalog_properties', 'catalog_rules', 'history']) {
    if (!await exists(name)) fail('', 'schema', `Missing ${name} in this replica; sync its schema before writing.`);
  }
  if (await exists('catalog_tables')) {
    const entry = (await db.all('SELECT * FROM main.catalog_tables WHERE id=? AND deleted_at IS NULL', [table]))[0];
    if (isReadOnlyTable(table, entry)) fail('', 'read_only', 'This table is read-only.');
  }
  // ponytail: no complete trigger journal yet. Inspect the whole database,
  // including history and TEMP triggers, before any mutation. Names alone
  // cannot prove safety; recognize only exact timestamp/queue-only DDL.
  const triggers = await db.all("SELECT name,tbl_name,sql,0 AS temporary FROM main.sqlite_master WHERE type='trigger' UNION ALL SELECT name,tbl_name,sql,1 AS temporary FROM temp.sqlite_master WHERE type='trigger'");
  for (const trigger of triggers) {
    if (isSearchTrigger(trigger)) continue;
    const t = String(trigger.tbl_name);
    const name = String(trigger.name);
    const canonical = (name: string, target: string) => `CREATE TRIGGER ${name} AFTER UPDATE ON ${target} FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE ${target} SET updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE rowid = NEW.rowid; END`;
    const sql = String(trigger.sql).replace(/\s+/g, ' ').trim();
    // SQLite renames the target but keeps the trigger name and its quoting.
    // Require the complete canonical body on the actual table in either form.
    const supported = [quote(name), name].some(name =>
      [quote(t), t].some(target => sql === canonical(name, target)));
    if (trigger.temporary || !supported) {
      fail('', 'trigger', `Unsupported trigger ${trigger.name} on ${t}. Use the CLI writer to validate and record all trigger effects.`);
    }
  }
  const physicalTables = await db.all("SELECT name,'main' AS db FROM main.sqlite_master WHERE type='table' UNION ALL SELECT name,'temp' AS db FROM temp.sqlite_master WHERE type='table'");
  for (const entry of physicalTables) {
    const keys = await db.all(`PRAGMA ${entry.db}.foreign_key_list(${quote(String(entry.name))})`);
    if (keys.length) {
      fail('', 'foreign_key', `SQLite foreign keys on ${entry.name} are unsupported: host enforcement can differ and cascade effects are not journaled. Use catalog references or the CLI writer.`);
    }
  }
  const info = await db.all(`PRAGMA main.table_info(${quote(table)})`);
  const cols = info.map(r => String(r.name));
  if (info.filter(c => Number(c.pk) > 0).length !== 1 || !info.some(c => c.name === 'id' && c.pk === 1)) fail('id', 'schema', 'Editing requires id as the single primary key.');
  for (const col of cols) quote(col);
  if (['id', 'created_at', 'updated_at', 'deleted_at'].some(c => !cols.includes(c))) {
    fail('', 'schema', 'This table lacks the sync columns required for editing.');
  }
  return cols;
}
async function prepareWrite(db: SqlDriver, table: string, fail: Fail) {
  const cols = await prepareWriteStorage(db, table, fail);
  // A table this device does not sync never uploads an edit; its local rows are read-only.
  let skipped: string[];
  try { skipped = await skippedTableNames(db); }
  catch (error) { return fail('', 'not_synced', (error as Error).message); }
  if (skipped.includes(table)) fail('', 'not_synced', 'Not synced on this device. Download this table to edit it.');
  const props = (await db.all('SELECT * FROM main.catalog_properties WHERE tbl=? AND deleted_at IS NULL ORDER BY sort,col', [table])).map(row => {
    try { return decodeProperty(row); }
    catch { return fail(String(row.col ?? ''), 'catalog', 'Invalid catalog property; repair options/inputs before writing.'); }
  });
  if (!props.length) fail('', 'catalog', 'Table has no active catalog properties; sync or catalog it before writing.');
  for (const p of props) {
    if (typeof p.col !== 'string' || !cols.includes(p.col)) fail('', 'catalog', 'Catalog column is absent from the local schema; sync before writing.');
    if ((p.options != null && (!Array.isArray(p.options) || p.options.some(o => !plain(o) || typeof o.v !== 'string')))
      || (p.inputs != null && (!Array.isArray(p.inputs) || p.inputs.some(i => typeof i !== 'string')))) {
      fail(p.col, 'catalog', 'Invalid catalog options or inputs.');
    }
  }
  const allRules = await db.all("SELECT * FROM main.catalog_rules WHERE kind='invariant' AND enforce != 0 AND deleted_at IS NULL ORDER BY id");
  if (allRules.some(r => r.scope === 'estate')) fail('', 'invariant', 'Estate-scoped enforcement is unsupported; use a table-scoped rule.');
  const rules = allRules.filter(r => r.tbl === table);
  for (const rule of rules) {
    if (rule.enforce !== 1 || (rule.scope != null && rule.scope !== 'table')
      || !supportedRuleSql(rule.sql)) {
      fail(String(rule.col ?? ''), 'invariant', `Enforced invariant ${rule.id} uses unsupported SQL. Use a table SELECT without clock, date/time, randomness or connection-state functions; compare or slice now.ts directly.`);
    }
  }
  // A partial catalog can omit rules entirely. Enforce its trust before authorizing a write, including for tables with no current invariant. Standalone
  // local workspaces remain editable without replication certificates.
  await assertCatalogCoverage(db, fail);
  await unusedWriteContext(db, fail);
  await prepareInvariants(db, table, props, rules, fail);
  return { cols, props, rules };
}

export async function assertCatalogCoverage(db: SqlDriver, fail: Fail): Promise<void> {
  const exists = async (name: string) => (await db.all("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name=?", [name])).length > 0;
  const bound=await exists('_core_state') && (await db.all("SELECT value FROM main._core_state WHERE key='hub'"))[0]?.value
    || await exists('_sync_state') && (await db.all("SELECT value FROM main._sync_state WHERE key='hub_url'"))[0]?.value;
  if(bound) {
    const problem=await coverageProblem(db,[]);
    if(problem) fail('', 'coverage', problem);
  }
}

const storageViolation = (table: string, rowId: string | null): WriteViolation => ({ tbl: table, row_id: rowId, col: '', rule: 'storage', message: 'Local write failed; transaction rolled back. Check the schema, catalog SQL and database constraints.' });

/** Advisory table guards only; writeRow rechecks in its own transaction and
 * still validates the actual patch, selected revision and stored values. */
export async function writeability(db: SqlDriver, args: WriteabilityArgs): Promise<Writeability> {
  let table = '';
  try {
    const field = plain(args) ? Object.getOwnPropertyDescriptor(args, 'table') : undefined;
    if (!field?.enumerable || !('value' in field) || typeof field.value !== 'string' || Reflect.ownKeys(args).some(k => k !== 'table')) {
      throw new ValidationError([{ tbl: '', row_id: null, col: '', rule: 'input', message: 'Invalid writeability arguments.' }]);
    }
    table = field.value;
    await db.transaction(() => prepareWrite(db, table, (col, rule, message) => { throw new ValidationError([{ tbl: table, row_id: null, col, rule, message }]); }));
    return { writable: true, reason: null };
  } catch (error) {
    return { writable: false, reason: error instanceof ValidationError ? error.violations[0]! : storageViolation(table, null) };
  }
}

/** Missing id creates; supplied id edits an existing row (never upserts).
 * deleted_at:true requests deletion at the new revision; null restores.
 * now/id are host/test seams; id generates row IDs only. History IDs always
 * come from SQLite. No caller may supply created_at, updated_at or hub_at.
 * Table invariants require verified dependency coverage (global without a
 * compiler metadata adapter). The one-row
 * before/changed contexts preserve SQLite values; custom effects stay closed.
 * Custom triggers anywhere in main/temp block writes. Exact main timestamp
 * triggers and queue-only search triggers are supported.
 * Forms should pass expectedUpdatedAt from their selected row. A stale edit
 * fails with rule='conflict'; omit it for unconditional merges into current data.
 */
export async function writeRow(
  db: SqlDriver, table: string, patch: Row,
  options: WriteOptions = {},
): Promise<Row> {
  return (await commitWrite(db, table, patch, options)).row;
}

type WriteOptions = { now?: () => Date; id?: () => string; origin?: string; expectedUpdatedAt?: string };
/** Internal transaction result, never a client-supplied inverse or a wire DTO. */
export type WriteCapture = { before: Row | null; after: Row; columns: string[]; shape: string; receiptId: string };
/** One write implementation. Capture is returned only after transaction commit;
 * the session publishes it afterwards, never via a callback inside the transaction. */
export async function commitWrite(
  db: SqlDriver, table: string, patch: Row, options: WriteOptions = {},
  capture = false, expected?: Pick<WriteCapture, 'shape' | 'after'>,
): Promise<{ row: Row; capture: WriteCapture | null }> {
  let rowId: string | null = null;
  const fail = (col: string, rule: string, message: string): never => {
    throw new ValidationError([{ tbl: table, row_id: rowId, col, rule, message }]);
  };
  const quote = (name: string): string => {
    try { return qident(name); } catch { return fail(name, 'identifier', 'Invalid SQL identifier.'); }
  };
  try {
    if (typeof table !== 'string') fail('', 'input', 'table must be a string.');
    const target = `main.${quote(table)}`;
    if (isReadOnlyTable(table)) {
      fail('', 'read_only', 'This table is read-only.');
    }
    if (!plain(patch) || Reflect.ownKeys(patch).some(k => typeof k !== 'string'
      || !Object.getOwnPropertyDescriptor(patch, k)?.enumerable
      || !('value' in Object.getOwnPropertyDescriptor(patch, k)!))) {
      fail('', 'input', 'patch must be a plain data object.');
    }
    // Snapshot the caller's data before the first await.
    patch = { ...patch };
    if (!plain(options) || Object.keys(options).some(k => !['now', 'id', 'origin', 'expectedUpdatedAt'].includes(k))
      || (options.now !== undefined && typeof options.now !== 'function')
      || (options.id !== undefined && typeof options.id !== 'function')
      || (options.expectedUpdatedAt !== undefined && !validEditTimestamp(options.expectedUpdatedAt))
      || (options.origin !== undefined && (typeof options.origin !== 'string' || !options.origin.trim()))) {
      fail('', 'input', 'Invalid write options.');
    }
    const { now = () => new Date(), id: makeId, origin = 'local', expectedUpdatedAt } = options;
    const editing = Object.hasOwn(patch, 'id');
    if (!editing && expectedUpdatedAt !== undefined) fail('updated_at', 'input', 'expectedUpdatedAt is only valid for edits.');
    if (editing) {
      if (typeof patch.id !== 'string' || !patch.id) fail('id', 'input', 'id must be a nonempty string.');
      rowId = patch.id as string;
    }
    return await db.transaction(async () => {
      const { cols, props, rules } = await prepareWrite(db, table, fail);
      const shape = capture || expected
        ? String((await db.all("SELECT sql FROM main.sqlite_master WHERE type='table' AND name=?", [table]))[0]?.sql)
        : '';
      if (expected && shape !== expected.shape) fail('', 'conflict', 'Table shape changed since this edit; undo is unavailable.');
      const exists = async (name: string) => (await db.all("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name=?", [name])).length > 0;
      const byCol = new Map(props.map(p => [p.col, p]));
      const values: Record<string, Value> = Object.create(null);
      const encode = (col: string, value: unknown): Value => {
        const type = byCol.get(col)?.type;
        if (value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return value;
        if (typeof value === 'boolean' && type === 'bool') return Number(value);
        if (['json', 'multi_select', 'multi_ref'].includes(type ?? '') && (Array.isArray(value) || (type === 'json' && plain(value)))) {
          try {
            return JSON.stringify(value, (_key, v) => {
              if (v === undefined || typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint'
                || (typeof v === 'number' && !Number.isFinite(v))) throw new Error('Not JSON data');
              return v;
            });
          } catch { fail(col, 'input', 'Value must contain only finite JSON data.'); }
        }
        return fail(col, 'input', 'Value must be a supported finite scalar or cataloged JSON value.');
      };
      for (const [col, value] of Object.entries(patch)) {
        quote(col);
        if (col === 'id') continue;
        if (['created_at', 'updated_at', 'hub_at'].includes(col)) fail(col, 'read_only', `${col} is managed by the write path.`);
        if (!cols.includes(col) || (!systemColumns.has(col) && !byCol.has(col))) fail(col, 'column', 'Unknown or uncataloged column.');
        if (col === 'deleted_at') {
          if (value !== true && value !== null) fail(col, 'input', 'Use deleted_at:true to delete or null to restore.');
        } else values[col] = encode(col, value);
      }
      const instant = now();
      if (!(instant instanceof Date) || !Number.isFinite(instant.getTime()) || !validEditTimestamp(instant.toISOString())) {
        fail('updated_at', 'clock', 'Device time must be a valid UTC millisecond timestamp.');
      }
      const before = editing ? (await db.all(`SELECT * FROM ${target} WHERE id=?`, [rowId]))[0] ?? null : null;
      if (editing && !before) fail('id', 'not_found', 'Row is absent from this replica; sync before editing. Omit id to create.');
      if (before && expectedUpdatedAt !== undefined && before.updated_at !== expectedUpdatedAt) {
        fail('updated_at', 'conflict', 'Row changed since it was selected; reload it and review your edit before retrying.');
      }
      // hub_at is receipt bookkeeping, not a new user revision. Other changes,
      // including external writes without a revision bump, must never be undone.
      if (expected && (!before || Object.keys(expected.after).some(c => c !== 'hub_at' && before[c] !== expected.after[c]))) {
        fail('', 'conflict', 'Stored row changed since this edit; undo is unavailable.');
      }
      if (before && (!validEditTimestamp(before.updated_at) || Date.parse(String(before.updated_at)) - instant.getTime() > 300_000)) {
        fail('updated_at', 'clock', 'Stored revision is invalid or over five minutes ahead; sync and check device time.');
      }
      const stamp = new Date(before ? Math.max(instant.getTime(), Date.parse(String(before.updated_at)) + 1) : instant.getTime()).toISOString();
      if (!validEditTimestamp(stamp)) fail('updated_at', 'clock', 'Next revision is outside the supported timestamp range.');
      if (!editing) {
        rowId = makeId ? makeId() : (await db.all('SELECT lower(hex(randomblob(16))) AS id'))[0]!.id as string;
        if (typeof rowId !== 'string' || !rowId) fail('id', 'input', 'Generated id must be a nonempty string.');
        for (const p of props) {
          if (systemColumns.has(p.col) || Object.hasOwn(patch, p.col) || p.default_value == null) continue;
          if (typeof p.default_value !== 'string') fail(p.col, 'catalog', 'Catalog defaults must be strings.');
          const value = p.default_value.startsWith('sql:')
            ? (await db.all(`SELECT (${p.default_value.slice(4)}) AS value`))[0]!.value : p.default_value;
          values[p.col] = encode(p.col, value);
        }
        values.id = rowId;
        values.created_at = stamp;
        if (cols.includes('hub_at')) values.hub_at = null;
      }
      values.updated_at = stamp;
      if (Object.hasOwn(patch, 'deleted_at')) values.deleted_at = patch.deleted_at === true ? stamp : null;
      if (before || rules.length) {
        // OR ABORT and the effect guards restrict this writer to one identity.
        // SQLite snapshots/EXCEPT preserve types without exposing bookkeeping.
        await db.run(`CREATE TEMP TABLE temp._core_write_before AS SELECT * FROM ${target} WHERE ${before ? 'id=?' : '0'}`, before ? [rowId] : []);
      }
      if (before) {
        const keys = Object.keys(values);
        await db.run(`UPDATE OR ABORT ${target} SET ${keys.map(c => `${quote(c)}=?`).join(',')} WHERE id=?`, [...keys.map(c => values[c]!), rowId]);
      } else {
        const keys = Object.keys(values);
        await db.run(`INSERT OR ABORT INTO ${target} (${keys.map(quote).join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(c => values[c]!));
      }
      const after = (await db.all(`SELECT * FROM ${target} WHERE id=?`, [rowId]))[0];
      if (!after || after.id !== rowId || after.updated_at !== stamp
        || after.created_at !== (before ? before.created_at : stamp)
        || after.deleted_at !== (Object.hasOwn(patch, 'deleted_at') ? values.deleted_at : before?.deleted_at ?? null)
        || (!before && cols.includes('hub_at') && after.hub_at !== null)
        || (before && after.hub_at !== before.hub_at)) {
        fail('', 'storage', 'Stored identity or system timestamps changed unexpectedly; transaction rolled back.');
      }
      if (!after.deleted_at) {
        const references = new Map<string, Set<unknown>>();
        const extra = new Map<Property, string[]>();
        for (const p of props) {
          if (empty(after[p.col])) continue;
          if (p.options_sql) {
            extra.set(p, (await db.all(`SELECT * FROM (${p.options_sql})`)).map(r => Object.values(r)[0] as string));
          }
          if (!['ref', 'multi_ref'].includes(p.type ?? '')) continue;
          if (!p.ref_table) fail(p.col, 'catalog', 'Reference property has no ref_table; repair the catalog.');
          const refTable = quote(p.ref_table!);
          if (!await exists(p.ref_table!)) fail(p.col, 'ref', `Reference table ${p.ref_table} is absent from this replica; sync it before writing.`);
          const refCols = (await db.all(`PRAGMA main.table_info(${refTable})`)).map(r => r.name);
          if (!refCols.includes('id') || !refCols.includes('deleted_at')) fail(p.col, 'ref', 'Reference schema is incomplete in this replica; sync it before writing.');
          const found = references.get(p.ref_table!) ?? new Set();
          for (const value of p.type === 'multi_ref' ? asList(after[p.col]) ?? [] : [after[p.col]]) {
            if (typeof value !== 'string' && typeof value !== 'number') continue;
            if ((await db.all(`SELECT 1 FROM main.${refTable} WHERE id=? AND deleted_at IS NULL`, [value])).length) found.add(value);
          }
          references.set(p.ref_table!, found);
        }
        const violations = validateRow(props, before, after, {
          // Like the hub and Python writers, an edit only claims the cells it carries.
          touched: before ? new Set(Object.keys(patch)) : null,
          refOk: (t, id) => references.get(t)?.has(id) ?? false,
          extraOptions: p => extra.get(p) ?? [],
        }).map(v => ({ ...v, tbl: table, row_id: rowId,
          message: v.rule === 'ref' ? 'Reference is not live in the local replica; sync the reference table and retry (it may be incomplete).' : v.message }));
        if (violations.length) throw new ValidationError(violations);
      }
      for (const rule of rules) {
        const hits = await db.all(invariantSql(table, String(rule.sql)), [rowId, instant.toISOString()]);
        if (hits.length) throw new ValidationError([{ tbl: table, row_id: typeof hits[0]!.id === 'string' ? hits[0]!.id : null,
          col: String(rule.col ?? ''), rule: String(rule.id), message: String(rule.text ?? 'Enforced invariant rejected the write.') }]);
      }
      if (before) {
        const historyHasHubAt = (await db.all('PRAGMA main.table_info(history)')).some(c => c.name === 'hub_at');
        for (const col of cols.filter(c => !['updated_at', 'hub_at'].includes(c))) {
          const c = quote(col);
          await db.run(`INSERT INTO main.history (id,tbl,row_id,col,old,new,origin,created_at,updated_at${historyHasHubAt ? ',hub_at' : ''})
            SELECT lower(hex(randomblob(16))),?,a.id,?,CAST(b.${c} AS TEXT),CAST(a.${c} AS TEXT),?,?,?${historyHasHubAt ? ',?' : ''}
            FROM ${target} AS a JOIN temp._core_write_before AS b ON a.id=b.id WHERE b.${c} IS NOT a.${c}`,
          [table, col, origin, stamp, stamp, ...(historyHasHubAt ? [null] : [])]);
        }
      }
      if (before || rules.length) await db.run('DROP TABLE temp._core_write_before');
      await initCore(db);
      await db.run('INSERT OR REPLACE INTO _core_pending(tbl,row_id,updated_at) VALUES (?,?,?)', [table, rowId, stamp]);
      return { row: after, capture: capture ? {
        before: before ? { ...before } : null, after: { ...after }, columns: cols, shape,
        receiptId: String((await db.all('SELECT lower(hex(randomblob(16))) AS id'))[0]!.id),
      } : null };
    });
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    // SQL constraints, malformed catalog SQL and driver failures all abort the
    // transaction. Keep the structured boundary without leaking row values.
    throw new ValidationError([storageViolation(table, rowId)]);
  }
}
