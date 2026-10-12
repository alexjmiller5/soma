import type { MentionLabel, MentionLabelsArgs, MentionedByArgs, MentionedByPage, ViewEmbed, ViewEmbedArgs, ViewEmbedColumn } from './contract.generated.ts';
import type { SqlDriver } from './driver.ts';
import { readCatalog } from './catalog.ts';
import { openSearchIndex, searchIndexing } from './search.ts';
import { calendarPolicy, loadSavedView } from './saved-views.ts';
import { skippedTableNames } from './status.ts';
import { qident } from './validate.ts';
import { compileView, displayName } from './view.ts';

export type IrisLink = { kind: 'row' | 'view'; table: string; id: string };

// encodeURIComponent leaves ( ) ' * ! intact; parentheses would end a Markdown link.
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** The stored, future-proof form of a mention or view embed: a plain Markdown link destination. */
export function irisHref(kind: IrisLink['kind'], table: string, id: string): string {
  return `iris://table/${encode(table)}/${kind}/${encode(id)}`;
}

export function parseIrisHref(href: string): IrisLink | null {
  const match = typeof href === 'string' && href.length <= 4096
    ? /^iris:\/\/table\/([^/?#]+)\/(row|view)\/([^/?#]+)$/.exec(href) : null;
  if (!match) return null;
  try {
    const table = decodeURIComponent(match[1]), id = decodeURIComponent(match[3]);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table) || /[\u0000-\u001f\u007f]/.test(id)) return null;
    return { kind: match[2] as IrisLink['kind'], table, id };
  } catch { return null; }
}

/** Inline-link destinations only. Bare URLs and reference definitions are not mentions. */
export function markdownMentions(markdown: string): { table: string; id: string }[] {
  const found = new Map<string, { table: string; id: string }>();
  for (const [, href] of String(markdown).matchAll(/\]\(\s*<?(iris:\/\/table\/[^\s<>()]+?)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)) {
    const link = parseIrisHref(href);
    if (link?.kind === 'row') found.set(JSON.stringify([link.table, link.id]), { table: link.table, id: link.id });
  }
  return [...found.values()];
}

function page(args: { limit?: number; offset?: number }, fallback: number, maximum: number) {
  const limit = args.limit ?? fallback, offset = args.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum || !Number.isSafeInteger(offset) || offset < 0)
    throw Error('Invalid mention pagination');
  return { limit, offset };
}
const text = (value: unknown) => typeof value === 'string' && value.length > 0;

/** Backlinks come from the derived `_core_search_mentions` index that the search index
 * step maintains from Markdown properties; nothing new is stored or synced. A lookup never
 * builds it: `indexing` says rows still wait for the step, so the list may be incomplete. */
export async function mentionedBy(db: SqlDriver, args: MentionedByArgs): Promise<MentionedByPage> {
  if (!args || typeof args !== 'object' || !text(args.table) || !text(args.rowId)) throw Error('Invalid mention arguments');
  const { limit, offset } = page(args, 20, 100);
  return db.transaction(async () => {
    const catalog = await readCatalog(db, [args.table]);
    if (!catalog.tables.some(t => t.id === args.table)) throw Error('Table is not in the catalog');
    await openSearchIndex(db);
    // ponytail: exact binary target identity; mention links are written from exact IDs.
    const rows = await db.all(`SELECT DISTINCT m.tbl AS "table", m.row_id AS id, d.label FROM _core_search_mentions AS m
      JOIN _core_search_docs AS d ON d.tbl=m.tbl AND d.row_id=m.row_id
      WHERE m.target_tbl=? AND m.target_id=? AND NOT (m.tbl=? AND m.row_id=?) AND m.tbl IN (SELECT tbl FROM _core_search_state)
      ORDER BY m.tbl, d.label, m.row_id LIMIT ? OFFSET ?`, [args.table, args.rowId, args.table, args.rowId, limit + 1, offset]);
    return {
      rows: rows.slice(0, limit) as MentionedByPage['rows'],
      nextOffset: rows.length > limit ? offset + limit : null,
      incomplete: (await skippedTableNames(db)).length > 0,
      indexing: await searchIndexing(db),
    };
  });
}

export async function mentionLabels(db: SqlDriver, args: MentionLabelsArgs): Promise<MentionLabel[]> {
  const targets = args?.targets;
  if (!Array.isArray(targets) || targets.some(t => !t || !text(t.table) || !text(t.id))) throw Error('Invalid mention targets');
  if (targets.length > 200) throw Error('Resolve at most 200 mentions per request');
  return db.transaction(async () => {
    const catalog = await readCatalog(db, targets.map(t => t.table));
    const found = new Map<string, { label: string; trashed: boolean }>();
    for (const table of new Set(targets.map(t => t.table))) {
      const entry = catalog.tables.find(t => t.id === table);
      if (!entry) continue;
      const display = typeof entry.display === 'string' ? entry.display : undefined;
      const ids = JSON.stringify(targets.filter(t => t.table === table).map(t => t.id));
      const rows = await db.all(`SELECT * FROM ${qident(table)} WHERE id COLLATE BINARY IN (SELECT value FROM json_each(?))`, [ids]);
      for (const row of rows) found.set(JSON.stringify([table, row.id]), { label: displayName(row, display), trashed: row.deleted_at != null });
    }
    return targets.map(({ table, id }) => {
      const hit = found.get(JSON.stringify([table, id]));
      return { table, id, label: hit?.label ?? null, trashed: hit?.trashed ?? false };
    });
  });
}

const PREVIEW_TYPES = new Set(['text', 'number', 'int', 'bool', 'select', 'multi_select', 'url', 'email', 'phone', 'date', 'datetime', 'date_or_datetime']);

export async function viewEmbed(db: SqlDriver, args: ViewEmbedArgs): Promise<ViewEmbed> {
  if (!args || typeof args !== 'object' || !text(args.table) || !text(args.viewId)) throw Error('Invalid view embed arguments');
  const { limit } = page({ limit: args.limit }, 10, 50);
  const unavailable = (message: string): ViewEmbed => ({ name: null, columns: [], rows: [], more: false, unavailable: message });
  return db.transaction(async () => {
    let saved;
    try { saved = await loadSavedView(db, args.viewId); }
    catch { return unavailable('This saved view is no longer available.'); }
    if (saved.tbl !== args.table) return unavailable('This saved view is no longer available.');
    if (!saved.view || !saved.definition) return unavailable(saved.unavailable ?? 'This saved view cannot be read.');
    const definition = saved.definition;
    const policy = calendarPolicy(definition);
    if (policy && !args.calendar) return { name: saved.name, columns: [], rows: [], more: false, calendar: policy };
    const catalog = await readCatalog(db);
    const display = catalog.tables.find(t => t.id === args.table)?.display;
    const properties = catalog.properties.filter(p => p.tbl === args.table);
    const visible = (saved.view.columns ?? [...properties].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0)).map(p => p.col));
    const columns: ViewEmbedColumn[] = [];
    for (const column of typeof display === 'string' ? [display, ...visible] : visible) {
      const property = properties.find(p => p.col === column);
      if (!property || !PREVIEW_TYPES.has(property.type ?? 'text') || columns.some(c => c.column === column) || columns.length >= 5) continue;
      columns.push({ column, label: property.label?.trim() || column, type: property.type ?? 'text' });
    }
    const query = compileView({ ...saved.view, columns: undefined, limit: limit + 1, offset: 0, calendar: args.calendar }, catalog.properties);
    if (saved.view.search) await openSearchIndex(db);
    const rows = await db.all(query.sql, query.params);
    return {
      name: saved.name, columns, more: rows.length > limit,
      rows: rows.slice(0, limit).map(row => ({
        record: Object.fromEntries([['id', row.id], ...columns.map(c => [c.column, row[c.column]])]),
        label: displayName(row, typeof display === 'string' ? display : undefined),
      })),
    };
  });
}
