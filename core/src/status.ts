import type { SqlDriver } from './driver.ts';
import { initCore } from './sync.ts';
import { qident } from './validate.ts';

import type { SkippedTableDetail, SyncStatus } from './contract.generated.ts';
export type { SyncStatus } from './contract.generated.ts';

function parseSkipped(value: unknown): string[] {
  let skippedTables: unknown = [];
  try {
    if (value != null) skippedTables = JSON.parse(String(value));
    if (!Array.isArray(skippedTables) || skippedTables.some(t => typeof t !== 'string' || !t.length)
      || new Set(skippedTables).size !== skippedTables.length) throw new Error();
  } catch {
    throw new Error('Invalid saved skipped-table status; complete a successful sync to refresh it.');
  }
  return skippedTables as string[];
}

/** The last completed round's exclusions, for readers that need only the names. */
export async function skippedTableNames(db: SqlDriver): Promise<string[]> {
  if (!(await db.all("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name='_core_state'")).length) return [];
  return parseSkipped((await db.all("SELECT value FROM main._core_state WHERE key='skipped_tables'"))[0]?.value);
}

/** Rows sampled per skipped table to estimate its download size. */
const SAMPLE_ROWS = 100;

async function details(db: SqlDriver, tables: string[]): Promise<SkippedTableDetail[]> {
  if (!tables.length) return [];
  let counts: Record<string, unknown> = {};
  try { counts = JSON.parse(String((await db.all("SELECT value FROM _core_state WHERE key='hub_stats'"))[0]?.value ?? 'null'))?.tables ?? {}; } catch {}
  const waiting = new Map((await db.all('SELECT tbl,count(*) AS n FROM _core_pending GROUP BY tbl')).map(r => [String(r.tbl), Number(r.n)]));
  const out: SkippedTableDetail[] = [];
  for (const table of tables) {
    const rows = Number.isSafeInteger(counts[table]) && (counts[table] as number) >= 0 ? counts[table] as number : null;
    let estimatedBytes: number | null = null;
    const columns = (await db.all(`PRAGMA table_info(${qident(table)})`)).map(r => String(r.name));
    if (rows !== null && columns.length) {
      // Retained local rows stand in for the hub's: their average stored size times its count.
      const size = columns.map(c => `ifnull(length(CAST(s.${qident(c)} AS BLOB)),0)`).join('+');
      const avg = (await db.all(`SELECT avg(n) AS avg FROM (SELECT ${size} AS n FROM ${qident(table)} AS s ORDER BY s.id LIMIT ${SAMPLE_ROWS})`))[0]?.avg;
      if (avg != null) estimatedBytes = Math.round(rows * Number(avg));
    }
    out.push({ table, rows, estimatedBytes, waitingEdits: waiting.get(table) ?? 0 });
  }
  return out;
}

export async function syncStatus(db: SqlDriver): Promise<SyncStatus> {
  await initCore(db);
  // One SQLite statement gives all fields the same committed snapshot.
  const row = (await db.all(`SELECT
    (SELECT value FROM _core_state WHERE key='last_sync') AS last_sync,
    (SELECT value FROM _core_state WHERE key='skipped_tables') AS skipped_tables,
    (SELECT count(*) FROM _core_pending) AS pending,
    (SELECT count(*) FROM _core_rejected) AS rejected`))[0]!;
  const skippedTables = parseSkipped(row.skipped_tables);
  return {
    lastSuccessfulSync: row.last_sync == null ? null : String(row.last_sync),
    pendingUiEdits: Number(row.pending),
    rejected: Number(row.rejected),
    skippedTables,
    skippedDetails: await details(db, skippedTables),
  };
}
