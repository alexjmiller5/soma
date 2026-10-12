import { afterEach, expect, test } from 'bun:test';
import * as core from '../src/index.ts';
import views from '../schema/saved-views.json';
import { schema, TestSql, T0, indexSearch } from './support.ts';

const databases: TestSql[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.db.close(); });

async function local() {
  const db = new TestSql(); databases.push(db);
  for (const ddl of schema) await db.run(ddl);
  await db.run('ALTER TABLE items ADD COLUMN body TEXT');
  await db.run('ALTER TABLE items ADD COLUMN notes TEXT');
  await db.run('ALTER TABLE catalog_properties ADD COLUMN label TEXT');
  await db.run('ALTER TABLE catalog_properties ADD COLUMN source TEXT');
  await db.run('ALTER TABLE catalog_properties ADD COLUMN source_ref TEXT');
  await db.run('CREATE TABLE catalog_tables (id TEXT PRIMARY KEY,kind TEXT,display TEXT,deleted_at TEXT)');
  await db.run('CREATE TABLE people (id TEXT PRIMARY KEY,full_name TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT)');
  await db.run("INSERT INTO catalog_tables(id,display) VALUES ('items','name'),('people','full_name')");
  await db.run(`INSERT INTO catalog_properties(id,tbl,col,type,label) VALUES ('items.name','items','name','text','Name'),
    ('items.qty','items','qty','int','Quantity'),('items.body','items','body','markdown','Body'),('items.notes','items','notes','text',NULL),
    ('people.full_name','people','full_name','text','Full name')`);
  await db.run("INSERT INTO people(id,full_name,updated_at) VALUES ('p1','Ada Lovelace',?),('p(2)','Grace Hopper',?)", [T0, T0]);
  for (const ddl of views.ddl) await db.run(ddl);
  await db.run('INSERT INTO catalog_tables(id,kind,display) VALUES (?,?,?)', [views.table.id, views.table.kind, views.table.display]);
  for (const p of views.properties) {
    const keys = Object.keys(p);
    await db.run(`INSERT INTO catalog_properties(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, Object.values(p) as core.Value[]);
  }
  await core.initCore(db);
  return db;
}
const handlers = (db: TestSql): any => core.createCoreHandlers(db, () => { throw Error('Mentions stay local'); });
const mention = (id: string, label = 'x') => `[${label}](${core.irisHref('row', 'people', id)})`;
const backlinks = async (db: TestSql, rowId: string, extra: object = {}) => {
  await indexSearch(db);
  return handlers(db).mentionedBy({ table: 'people', rowId, ...extra });
};

test('iris hrefs round-trip exact table and record identities, escaping Markdown link syntax', () => {
  for (const id of ['p1', 'p(2)', 'MiXeD-雪', 'a/b?c#d', "it's *bold*", '100%']) {
    const href = core.irisHref('row', 'people', id);
    expect(href).not.toMatch(/[()\s'*]/);
    expect(core.parseIrisHref(href)).toEqual({ kind: 'row', table: 'people', id });
  }
  expect(core.parseIrisHref(core.irisHref('view', 'items', 'v1'))).toEqual({ kind: 'view', table: 'items', id: 'v1' });
  for (const bad of ['iris://table/people/row/', 'iris://table//row/p1', 'iris://table/people/rows/p1', 'iris://table/people/row/p1/x',
    'iris://table/people/row/p1?x=1', 'iris://table/people/row/p1#x', 'iris://table/pe%20ople/row/p1', 'iris://table/people/row/%E0%A4%A',
    'iris://table/people/row/%0A', 'https://table/people/row/p1', 'IRIS://table/people/row/p1', 'iris://open/v1?table=people', 'iris://table/sqlite_master;/row/p1'])
    expect(core.parseIrisHref(bad)).toBeNull();
});

test('Markdown mentions are inline record links only, deduplicated in source order', () => {
  const href = core.irisHref('row', 'people', 'p(2)');
  const text = [`See ${mention('p1', 'Ada')} and [Grace](${href} "title") and [again](<${href}>).`,
    `[view](${core.irisHref('view', 'items', 'v1')}) [web](https://example.test) iris://table/people/row/p3 ${mention('p1', 'Ada again')}`].join('\n');
  expect(core.markdownMentions(text)).toEqual([{ table: 'people', id: 'p1' }, { table: 'people', id: 'p(2)' }]);
  expect(core.markdownMentions('')).toEqual([]);
});

test('backlinks backfill existing bodies, follow writes, edits and deletions, and skip self links', async () => {
  const db = await local();
  await db.run("INSERT INTO items(id,name,body,notes,updated_at) VALUES ('a','Alpha',?,?,?),('b','Beta','plain',?,?)",
    [`Met ${mention('p1')} and ${mention('p(2)')}`, mention('p1'), T0, mention('p1'), T0]);
  // Existing rows are indexed by the index step's one-time backfill.
  expect(await backlinks(db, 'p1')).toEqual({ rows: [{ table: 'items', id: 'a', label: 'Alpha' }], nextOffset: null, incomplete: false, indexing: false });
  expect((await backlinks(db, 'p(2)')).rows.map((r: any) => r.id)).toEqual(['a']);
  // The single write path updates the index; text (non-Markdown) columns never count.
  const row = (await db.all("SELECT updated_at FROM items WHERE id='b'"))[0];
  await handlers(db).write({ table: 'items', patch: { id: 'b', body: `Also ${mention('p1')}` }, expectedUpdatedAt: row.updated_at });
  expect((await backlinks(db, 'p1')).rows.map((r: any) => r.id)).toEqual(['a', 'b']);
  // Edits from other writers (pulls, the CLI) are queued by triggers too.
  await db.run("UPDATE items SET body='no longer' WHERE id='a'");
  expect((await backlinks(db, 'p1')).rows.map((r: any) => r.id)).toEqual(['b']);
  expect((await backlinks(db, 'p(2)')).rows).toEqual([]);
  await db.run("UPDATE items SET deleted_at=updated_at WHERE id='b'");
  expect((await backlinks(db, 'p1')).rows).toEqual([]);
  await db.run(`UPDATE people SET full_name=? WHERE id='p1'`, [`Self ${mention('p1')}`]);
  await db.run("UPDATE catalog_properties SET type='markdown' WHERE id='people.full_name'");
  expect((await backlinks(db, 'p1')).rows).toEqual([]);
  await expect(handlers(db).mentionedBy({ table: 'nope', rowId: 'p1' })).rejects.toThrow(/catalog/i);
  await expect(handlers(db).mentionedBy({ table: 'people', rowId: 'p1', limit: 0 })).rejects.toThrow(/pagination/i);
});

test('backlinks page by label and backfill an existing search cache that predates mentions', async () => {
  const db = await local();
  await db.run("INSERT INTO items(id,name,body,updated_at) VALUES ('c','Charlie',?,?),('a','Alpha',?,?),('b','Bravo',?,?)",
    [mention('p1'), T0, mention('p1'), T0, mention('p1'), T0]);
  await core.search(db, { text: 'alpha' });
  await db.run('DROP TABLE _core_search_mentions');
  const first = await backlinks(db, 'p1', { limit: 2 });
  expect(first.rows.map((r: any) => r.label)).toEqual(['Alpha', 'Bravo']);
  expect(first.nextOffset).toBe(2);
  const second = await backlinks(db, 'p1', { limit: 2, offset: 2 });
  expect(second).toEqual({ rows: [{ table: 'items', id: 'c', label: 'Charlie' }], nextOffset: null, incomplete: false, indexing: false });
  await db.run("INSERT INTO _core_state(key,value) VALUES ('skipped_tables','[\"items\"]') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  expect((await backlinks(db, 'p1')).incomplete).toBe(true);
});

test('mention labels resolve live display values, trashed targets and missing identities', async () => {
  const db = await local();
  await db.run("UPDATE people SET deleted_at='x' WHERE id='p(2)'");
  expect(await handlers(db).mentionLabels({ targets: [
    { table: 'people', id: 'p1' }, { table: 'people', id: 'p(2)' }, { table: 'people', id: 'P1' },
    { table: 'gone', id: 'p1' }, { table: 'items', id: 'missing' }] })).toEqual([
    { table: 'people', id: 'p1', label: 'Ada Lovelace', trashed: false },
    { table: 'people', id: 'p(2)', label: 'Grace Hopper', trashed: true },
    { table: 'people', id: 'P1', label: null, trashed: false },
    { table: 'gone', id: 'p1', label: null, trashed: false },
    { table: 'items', id: 'missing', label: null, trashed: false }]);
  await db.run("UPDATE people SET full_name='Countess' WHERE id='p1'");
  expect((await handlers(db).mentionLabels({ targets: [{ table: 'people', id: 'p1' }] }))[0].label).toBe('Countess');
  await expect(handlers(db).mentionLabels({ targets: Array(201).fill({ table: 'people', id: 'p1' }) })).rejects.toThrow(/at most 200/);
});

test('view embeds read a saved view through the shared compiler with only its visible columns', async () => {
  const db = await local();
  for (const [id, name, qty] of [['a', 'Alpha', 1], ['b', 'Bravo', 5], ['c', 'Charlie', 7], ['d', 'Delta', 9]])
    await db.run('INSERT INTO items(id,name,qty,body,updated_at) VALUES (?,?,?,?,?)', [id, name, qty, 'long body', T0]);
  const saved = await handlers(db).saveView({ table: 'items', name: 'Big ones', definition: {
    version: 1, columns: ['name', 'qty', 'body'], filters: [{ column: 'qty', op: 'gte', value: 5 }], sort: [{ column: 'qty', direction: 'desc' }] } });
  const embed = await handlers(db).viewEmbed({ table: 'items', viewId: saved.id, limit: 2 });
  expect(embed).toEqual({
    name: 'Big ones', more: true,
    columns: [{ column: 'name', label: 'Name', type: 'text' }, { column: 'qty', label: 'Quantity', type: 'int' }],
    rows: [{ record: { id: 'd', name: 'Delta', qty: 9 }, label: 'Delta' }, { record: { id: 'c', name: 'Charlie', qty: 7 }, label: 'Charlie' }],
  });
  expect((await handlers(db).viewEmbed({ table: 'items', viewId: saved.id })).rows.map((r: any) => r.label)).toEqual(['Delta', 'Charlie', 'Bravo']);
  expect(await handlers(db).viewEmbed({ table: 'people', viewId: saved.id })).toEqual({ name: null, columns: [], rows: [], more: false, unavailable: 'This saved view is no longer available.' });
  await handlers(db).deleteView({ id: saved.id, expectedUpdatedAt: saved.updated_at });
  expect((await handlers(db).viewEmbed({ table: 'items', viewId: saved.id })).unavailable).toMatch(/no longer available/);
});

test('relative view embeds ask the host for its calendar context before reading rows', async () => {
  const db = await local();
  await db.run('ALTER TABLE items ADD COLUMN due TEXT');
  await db.run("INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('items.due','items','due','date')");
  await db.run("INSERT INTO items(id,name,due,updated_at) VALUES ('a','Today item','2026-03-01',?),('b','Later','2026-04-01',?)", [T0, T0]);
  const saved = await handlers(db).saveView({ table: 'items', name: 'Due', definition: {
    version: 2, timeZone: 'America/New_York', dayStartMinutes: 180, filters: [{ column: 'due', op: 'lte', relative: 'today' }] } });
  expect(await handlers(db).viewEmbed({ table: 'items', viewId: saved.id })).toEqual({
    name: 'Due', columns: [], rows: [], more: false, calendar: { timeZone: 'America/New_York', dayStartMinutes: 180 } });
  const calendar = { today: '2026-03-01', start: '2026-03-01T08:00:00.000Z', end: '2026-03-02T08:00:00.000Z' };
  const embed = await handlers(db).viewEmbed({ table: 'items', viewId: saved.id, calendar });
  expect(embed.rows.map((r: any) => r.label)).toEqual(['Today item']);
  expect(embed.columns[0]).toEqual({ column: 'name', label: 'Name', type: 'text' });
});

test('a relative view embed without a timezone asks the host for its own zone', async () => {
  const db = await local();
  await db.run('ALTER TABLE items ADD COLUMN due TEXT');
  await db.run("INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('items.due','items','due','date')");
  await db.run("INSERT INTO items(id,name,due,updated_at) VALUES ('a','Today item','2026-03-01',?),('b','Later','2026-04-01',?)", [T0, T0]);
  const saved = await handlers(db).saveView({ table: 'items', name: 'Due here', definition: {
    version: 2, dayStartMinutes: 180, filters: [{ column: 'due', op: 'lte', relative: 'today' }] } });
  expect(await handlers(db).viewEmbed({ table: 'items', viewId: saved.id })).toEqual({
    name: 'Due here', columns: [], rows: [], more: false, calendar: { dayStartMinutes: 180 } });
  const calendar = { today: '2026-03-01', start: '2026-03-01T08:00:00.000Z', end: '2026-03-02T08:00:00.000Z' };
  expect((await handlers(db).viewEmbed({ table: 'items', viewId: saved.id, calendar })).rows.map((r: any) => r.label)).toEqual(['Today item']);
});

test('iris links resolve to exact live records and saved views through the source-link resolver', async () => {
  const db = await local();
  const saved = await handlers(db).saveView({ table: 'items', name: 'All', definition: { version: 1 } });
  const resolve = (url: string) => handlers(db).resolveSourceLink({ url });
  expect(await resolve(core.irisHref('row', 'people', 'p(2)'))).toEqual({ destination: { table: 'people', row: 'p(2)' } });
  expect(await resolve(core.irisHref('row', 'people', 'P1'))).toEqual({});
  expect(await resolve(core.irisHref('view', 'items', saved.id))).toEqual({ view: { table: 'items', view: saved.id } });
  expect(await resolve(core.irisHref('view', 'people', saved.id))).toEqual({});
  expect(await resolve('iris://table/people/row/p1?x')).toEqual({});
});

test('saved views list across every table when no table is named', async () => {
  const db = await local();
  await handlers(db).saveView({ table: 'people', name: 'Everyone', definition: { version: 1 } });
  await handlers(db).saveView({ table: 'items', name: 'Stuff', definition: { version: 1 } });
  expect((await handlers(db).listViews({})).views.map((v: any) => [v.tbl, v.name])).toEqual([['items', 'Stuff'], ['people', 'Everyone']]);
});

test('rows silently replaced through another unique constraint drop their mentions', async () => {
  const db = await local();
  await db.run('CREATE UNIQUE INDEX items_name ON items(name)');
  await db.run("INSERT INTO items(id,name,body,updated_at) VALUES ('x','Same',?,?)", [mention('p1'), T0]);
  expect((await backlinks(db, 'p1')).rows.map((r: any) => r.id)).toEqual(['x']);
  await db.run("INSERT OR REPLACE INTO items(id,name,body,updated_at) VALUES ('y','Same','none',?)", [T0]);
  expect((await backlinks(db, 'p1')).rows).toEqual([]);
  expect(await db.all("SELECT * FROM _core_search_mentions WHERE row_id='x'")).toEqual([]);
});

test('backlinks report a catching-up index and drop a table that left it before its entries are purged', async () => {
  const db = await local();
  await db.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<600) INSERT INTO items(id,name,body) SELECT 'm'||i,'Row',? FROM n`, [mention('p1')]);
  expect(await handlers(db).mentionedBy({ table: 'people', rowId: 'p1' })).toEqual({ rows: [], nextOffset: null, incomplete: false, indexing: true });
  expect((await backlinks(db, 'p1', { limit: 100 })).nextOffset).toBe(100);
  await db.run('INSERT INTO _core_state(key,value) VALUES (?,?)', [core.SEARCH_TABLES_KEY, '{"items":false}']);
  expect(await core.searchIndexStep(db, { budgetMs: 0 })).toMatchObject({ indexing: false, done: false });
  expect(await handlers(db).mentionedBy({ table: 'people', rowId: 'p1' })).toEqual({ rows: [], nextOffset: null, incomplete: false, indexing: false });
});
