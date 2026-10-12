import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as core from '../src/index.ts';
import { schema, setup, TestSql, T0, T1, T2 } from './support.ts';

const databases: Database[] = [], directories: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true });
});
async function local(file = false) {
  const db = new TestSql();
  let path = ':memory:';
  if (file) {
    const dir = mkdtempSync(join(tmpdir(), 'core-search-')); directories.push(dir);
    path = join(dir, 'fixture.sqlite'); db.db.close(); db.db = new Database(path);
    db.db.exec('PRAGMA journal_mode=WAL');
  }
  databases.push(db.db);
  for (const ddl of schema) await db.run(ddl);
  await db.run('ALTER TABLE items ADD COLUMN body TEXT');
  await db.run('ALTER TABLE items ADD COLUMN private_text TEXT');
  await db.run('CREATE TABLE catalog_tables (id TEXT PRIMARY KEY, display TEXT, deleted_at TEXT)');
  await db.run("INSERT INTO catalog_tables(id,display) VALUES ('items','name')");
  await db.run("INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('name','items','name','text'),('body','items','body','markdown'),('qty','items','qty','int')");
  await db.run('INSERT INTO items(id,name,body,qty,private_text,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    ['a', 'Café field guide', '# Offline\n\n**Searching** with [links](https://example.test) and `code`.', 42, 'invisible', T0, T0]);
  return { db, path };
}
/** Hosts run the index step after rounds and writes; reads only see what it built. */
async function drain(db: core.SqlDriver) {
  for (let steps = 0; ; steps++) {
    const status = await core.searchIndexStep(db, { budgetMs: 60_000 });
    if (status.done) return steps + 1;
  }
}
async function search(db: core.SqlDriver, args: { text: string; table?: string; limit?: number; offset?: number }) {
  await drain(db);
  return core.search(db, args);
}
async function ids(db: core.SqlDriver, text: string) { return (await search(db, { text })).map(r => r.id); }

test('mixed calendar values remain searchable at their stored precision', async () => {
  const { db } = await local();
  await db.run("UPDATE catalog_properties SET type='date_or_datetime' WHERE col='body'");
  await db.run("UPDATE items SET body='2032-02-29' WHERE id='a'");
  expect(await ids(db, '2032')).toEqual(['a']);
});

test('FTS searches raw Markdown and catalog text with accent folding and literal prefixes', async () => {
  const { db } = await local();
  expect(await ids(db, 'cafe off')).toEqual(['a']);
  expect(await ids(db, 'search')).toEqual(['a']);
  expect(await ids(db, 'arching')).toEqual([]); // word prefix, not substring
  expect(await ids(db, 'code')).toEqual(['a']);
  expect(await ids(db, 'invisible')).toEqual([]);
  expect(await ids(db, '42')).toEqual([]);
  expect(await search(db, { text: 'offline' })).toMatchObject([{ table: 'items', id: 'a', label: 'Café field guide' }]);
  expect((await search(db, { text: 'offline' }))[0].excerpt).toContain('Offline');
  expect((await db.all("SELECT sql FROM sqlite_master WHERE name='_core_search_fts'"))[0].sql).toContain('fts5');
});

test('read-only system table matches follow user records regardless of relevance', async () => {
  const { db } = await local();
  await db.run("INSERT INTO catalog_tables(id) VALUES ('history'),('audit')");
  await db.run("ALTER TABLE catalog_tables ADD COLUMN kind TEXT");
  await db.run("UPDATE catalog_tables SET kind='system' WHERE id='audit'");
  await db.run('CREATE TABLE audit (id TEXT PRIMARY KEY, note TEXT, deleted_at TEXT)');
  await db.run("INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('h.old','history','old','text'),('h.new','history','new','text'),('a.note','audit','note','text')");
  // Each system row repeats the term, so plain relevance would rank it first.
  await db.run("INSERT INTO history(id,tbl,row_id,col,old,new) VALUES ('h1','items','a','name','Field guide field','Field guide field field')");
  await db.run("INSERT INTO audit(id,note) VALUES ('s1','field field field field')");
  const hits = await search(db, { text: 'field' });
  expect(hits[0]?.table).toBe('items');
  expect(hits.slice(1).map(h => h.table).sort()).toEqual(['audit', 'history']);
  expect((await search(db, { text: 'field', table: 'history' })).map(h => h.id)).toEqual(['h1']);
});

test('MATCH operators, punctuation and SQL-shaped input are literal and bounded', async () => {
  const { db } = await local();
  await db.run("INSERT INTO items(id,name,body) VALUES ('b','quoted','alpha OR beta')");
  expect(await ids(db, 'alpha OR beta')).toEqual(['b']);
  expect(await ids(db, 'alpha OR missing')).toEqual([]);
  for (const text of ['', '   ', '***', '"', '%_\\', "'); DROP TABLE items; --"]) {
    expect(await ids(db, text)).toEqual([]);
  }
  expect(await ids(db, '"alpha"')).toEqual(['b']);
  await expect(search(db, { text: 'a'.repeat(4097) })).rejects.toThrow(/search/i);
  expect((await db.all('SELECT count(*) AS n FROM items'))[0].n).toBe(2);
});

test('table search uses FTS before filtering, sorting and paging; contains stays substring based', async () => {
  const { db } = await local();
  for (let i = 0; i < 5; i++) await db.run('INSERT INTO items(id,name,qty) VALUES (?,?,?)', [`b${i}`, 'Searching', i]);
  await drain(db);
  const rows = await core.readRows(db, { table: 'items', search: 'search', filters: [{ column: 'qty', op: 'gte', value: 2 }], sort: [{ column: 'qty', direction: 'desc' }], limit: 2, offset: 1 });
  expect(rows.map(r => r.record.id)).toEqual(['b4', 'b3']);
  expect((await core.readRows(db, { table: 'items', search: 'arching' }))).toEqual([]);
  expect((await core.readRows(db, { table: 'items', filters: [{ column: 'name', op: 'contains', value: 'arching' }] })).map(r => r.record.id)).toEqual(['b0', 'b1', 'b2', 'b3', 'b4']);
});

test('durable triggers capture external edits without timestamp movement, rollback, IDs and hard deletes', async () => {
  const { db, path } = await local(true);
  await ids(db, 'offline');
  const external = new Database(path); databases.push(external);
  external.exec("UPDATE items SET body='external durable term' WHERE id='a'");
  external.exec("BEGIN; UPDATE items SET body='rolledback'; ROLLBACK");
  const reopened = new TestSql(); reopened.db.close(); reopened.db = new Database(path); databases.push(reopened.db);
  expect(await ids(reopened, 'durable')).toEqual(['a']);
  expect(await ids(reopened, 'offline')).toEqual([]);
  expect(await ids(reopened, 'rolledback')).toEqual([]);
  external.exec("UPDATE items SET id='renamed' WHERE id='a'");
  expect(await ids(reopened, 'durable')).toEqual(['renamed']);
  external.exec("DELETE FROM items WHERE id='renamed'");
  expect(await ids(reopened, 'durable')).toEqual([]);
});

test('REPLACE on a secondary unique key removes its silent delete victim from the index', async () => {
  const { db } = await local();
  await db.run('CREATE UNIQUE INDEX item_name_unique ON items(name)');
  await ids(db, 'offline');
  await db.run("INSERT OR REPLACE INTO items(id,name,body) VALUES ('replacement','Café field guide','successor')");
  expect(await ids(db, 'offline')).toEqual([]);
  expect(await ids(db, 'successor')).toEqual(['replacement']);
  expect((await db.all('SELECT count(*) AS n FROM _core_search_fts'))[0].n).toBe(1);
});

test('core writes, tombstones and restores keep FTS current while rejected writes leave it untouched', async () => {
  const { db } = await local();
  await ids(db, 'offline');
  await core.writeRow(db, 'items', { id: 'a', body: 'approved revision' }, { now: () => new Date(T1) });
  expect(await ids(db, 'approved')).toEqual(['a']);
  await expect(core.writeRow(db, 'items', { id: 'a', body: 'rejected revision', qty: 'bad' })).rejects.toBeInstanceOf(core.ValidationError);
  expect(await ids(db, 'rejected')).toEqual([]);
  await core.writeRow(db, 'items', { id: 'a', deleted_at: true });
  expect(await ids(db, 'approved')).toEqual([]);
  expect((await core.readRows(db, { table: 'items', search: 'approved', trash: true })).map(r => r.record.id)).toEqual(['a']);
  await core.writeRow(db, 'items', { id: 'a', deleted_at: null });
  expect(await ids(db, 'approved')).toEqual(['a']);
});

test('index reconciliation follows catalog removal, column rename and table drop', async () => {
  const { db } = await local();
  await ids(db, 'offline');
  await db.run("UPDATE catalog_properties SET deleted_at=? WHERE col='body'", [T1]);
  expect(await ids(db, 'offline')).toEqual([]);
  await db.run('ALTER TABLE items RENAME COLUMN body TO content');
  await db.run("UPDATE catalog_properties SET deleted_at=NULL,col='content' WHERE id='body'");
  expect(await ids(db, 'offline')).toEqual(['a']);
  await db.run('DROP TABLE items');
  expect(await ids(db, 'offline')).toEqual([]);
  expect((await db.all('SELECT count(*) AS n FROM _core_search_fts'))[0].n).toBe(0);
});

test('a failed drain rolls back index edits and retains dirty revisions for recovery', async () => {
  const { db } = await local();
  await ids(db, 'offline');
  await db.run("UPDATE items SET body='recoverable' WHERE id='a'");
  const run = db.run.bind(db);
  db.run = async (sql, params) => {
    const changed = await run(sql, params);
    if (/DELETE FROM _core_search_dirty/.test(sql)) throw new Error('injected disk failure');
    return changed;
  };
  await expect(ids(db, 'recoverable')).rejects.toThrow('injected disk failure');
  db.run = run;
  expect(await db.all('SELECT row_id FROM _core_search_dirty')).toEqual([{ row_id: 'a' }]);
  expect(await ids(db, 'recoverable')).toEqual(['a']);
  expect(await ids(db, 'offline')).toEqual([]);
});

test('Markdown excerpts normalize formatting while raw URLs, code and table text remain searchable', async () => {
  const { db } = await local();
  await db.run('UPDATE items SET body=?', ['# Heading\n- **bold** [label](https://example.test/destination)\n`codeword`\n| column | value |']);
  const [hit] = await search(db, { text: 'heading' });
  expect(hit.excerpt).toContain('Heading');
  expect(hit.excerpt).toContain('bold label (https://example.test/destination)');
  expect(hit.excerpt).not.toContain('**');
  expect(hit.excerpt).not.toContain('# ');
  expect(hit.excerpt).toContain('codeword');
  for (const text of ['destination', 'codeword', 'column', 'value']) expect(await ids(db, text)).toEqual(['a']);
  await core.writeRow(db, 'items', { id: 'a', body: '## Replacement **heading**' });
  expect((await search(db, { text: 'replacement' }))[0].excerpt).toBe('Replacement heading\nCafé field guide');
});

test('excerpt cleanup preserves formatting characters inside code and link destinations', async () => {
  const { db } = await local();
  await db.run('UPDATE items SET body=?', ['**Heading** `__literal__` [link](https://example.test/__file__)']);
  const [hit] = await search(db, { text: 'heading' });
  expect(hit.excerpt).toContain('Heading __literal__ link (https://example.test/__file__)');
});

test('table rename reconciles SQLite-rewritten queue triggers and purges the old identity', async () => {
  const { db } = await local();
  await ids(db, 'offline');
  await db.run('ALTER TABLE items RENAME TO renamed');
  await db.run("UPDATE catalog_tables SET id='renamed' WHERE id='items'");
  await db.run("UPDATE catalog_properties SET tbl='renamed' WHERE tbl='items'");
  expect((await search(db, { text: 'offline' })).map(r => r.table)).toEqual(['renamed']);
  await core.writeRow(db, 'renamed', { id: 'a', body: 'after rename' });
  expect(await ids(db, 'after')).toEqual(['a']);
  expect(await db.all("SELECT tbl FROM _core_search_docs WHERE tbl='items'")).toEqual([]);
});

test('exact trigger recognition rejects a forged owned name and TEMP or arbitrary side effects', async () => {
  const { db } = await local();
  await ids(db, 'offline');
  await db.run('DROP TRIGGER _core_search_items_update');
  await db.run("CREATE TRIGGER _core_search_items_update AFTER UPDATE ON items BEGIN DELETE FROM history; END");
  await expect(core.writeRow(db, 'items', { id: 'a', body: 'forged' })).rejects.toBeInstanceOf(core.ValidationError);
  await expect(ids(db, 'offline')).rejects.toThrow(/trigger/i);
  expect((await db.all('SELECT body FROM items'))[0].body).toContain('Offline');
});

test('an exact queue trigger in TEMP still cannot bypass the write trigger guard', async () => {
  const { db } = await local();
  await ids(db, 'offline');
  const [trigger] = await db.all("SELECT sql FROM sqlite_master WHERE name='_core_search_items_update'");
  await db.run(String(trigger.sql).replace('CREATE TRIGGER', 'CREATE TEMP TRIGGER'));
  await expect(core.writeRow(db, 'items', { id: 'a', body: 'temporary' })).rejects.toBeInstanceOf(core.ValidationError);
  expect(await ids(db, 'temporary')).toEqual([]);
});

test('missing triggers rebuild safely after unobserved changes, without scanning on clean searches', async () => {
  const { db } = await local();
  await ids(db, 'offline');
  await db.run('DROP TRIGGER _core_search_items_update');
  await db.run("UPDATE items SET body='unobserved' WHERE id='a'");
  expect(await ids(db, 'unobserved')).toEqual(['a']);
  const statements: string[] = [];
  const all = db.all.bind(db), run = db.run.bind(db);
  db.all = async (sql, params) => { statements.push(sql); return all(sql, params); };
  db.run = async (sql, params) => { statements.push(sql); return run(sql, params); };
  expect(await ids(db, 'unobserved')).toEqual(['a']);
  expect(statements.some(sql => /\bFROM\s+"?items"?\b/i.test(sql))).toBe(false);
  expect(statements.some(sql => /^(INSERT|DELETE|UPDATE)\b/i.test(sql))).toBe(false);
  const query = core.compileView({ table: 'items', search: 'unobserved' }, (await core.readCatalog(db)).properties);
  const plan = await all('EXPLAIN QUERY PLAN ' + query.sql, query.params);
  expect(plan.some(r => /SEARCH _view_row USING INDEX.*\(id=\?\)/.test(String(r.detail)))).toBe(true);
});

test('upsert queue survives repeated OR ABORT/IGNORE/REPLACE writes and update replacement victims', async () => {
  const { db } = await local();
  await db.run('CREATE UNIQUE INDEX unique_qty ON items(qty)');
  await db.run("INSERT INTO items(id,name,body,qty) VALUES ('b','Second','victim',7)");
  await ids(db, 'offline');
  await db.run("UPDATE OR ABORT items SET body='first' WHERE id='a'");
  await db.run("UPDATE OR ABORT items SET body='second' WHERE id='a'");
  await db.run("UPDATE OR IGNORE items SET body='third' WHERE id='a'");
  await db.run("UPDATE OR REPLACE items SET qty=7,body='survivor' WHERE id='a'");
  expect(await ids(db, 'victim')).toEqual([]);
  expect(await ids(db, 'survivor')).toEqual(['a']);
  expect((await db.all('SELECT count(*) AS n FROM _core_search_fts'))[0].n).toBe(1);
});

test('drain and read hold one writer reservation; a later external revision survives to the next search', async () => {
  const { db, path } = await local(true);
  await ids(db, 'offline');
  const external = new Database(path); databases.push(external);
  const all = db.all.bind(db);
  let attempted = false;
  db.all = async (sql, params) => {
    if (sql.includes('bm25(')) {
      attempted = true;
      expect(() => external.exec("UPDATE items SET body='concurrent' WHERE id='a'")).toThrow(/locked/);
    }
    return all(sql, params);
  };
  expect(await ids(db, 'offline')).toEqual(['a']);
  expect(attempted).toBe(true);
  db.all = all;
  external.exec("UPDATE items SET body='concurrent' WHERE id='a'");
  expect(await ids(db, 'concurrent')).toEqual(['a']);
});

test('FTS capability failure is explicit and installs no queue triggers or partial state', async () => {
  const { db } = await local();
  const run = db.run.bind(db);
  db.run = async (sql, params) => {
    if (/USING fts5/.test(sql)) throw new Error('no such module: fts5');
    return run(sql, params);
  };
  await expect(core.assertSearchSupport(db)).rejects.toThrow(/FTS5.*unicode61/);
  await expect(ids(db, 'offline')).rejects.toThrow(/FTS5-enabled/);
  expect(await db.all("SELECT name FROM sqlite_master WHERE name GLOB '_core_search_*'")).toEqual([]);
});

test('real hub pulls update the index across replicas without syncing local search plumbing', async () => {
  const { db, remote, hub, requests } = setup();
  databases.push(db.db, remote.db);
  const ddl = 'CREATE TABLE catalog_tables (id TEXT PRIMARY KEY, display TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT)';
  remote.db.exec(ddl);
  remote.db.query('INSERT INTO _schema_log(applied_at,ddl) VALUES (?,?)').run(T0, ddl);
  remote.db.query("INSERT INTO catalog_tables(id,display,updated_at,hub_at) VALUES ('items','name',?,?)").run(T0, T1);
  remote.db.query("INSERT INTO catalog_properties(id,tbl,col,type,updated_at,hub_at) VALUES ('name','items','name','text',?,?)").run(T0, T1);
  remote.db.query("INSERT INTO items(id,name,updated_at,hub_at) VALUES ('a','original',?,?)").run(T0, T1);
  await core.sync(db, hub);
  expect(await ids(db, 'original')).toEqual(['a']);
  remote.db.query("UPDATE items SET name='pulled replacement',updated_at=?,hub_at=?").run(T1, T2);
  await core.sync(db, hub);
  expect(await ids(db, 'original')).toEqual([]);
  expect(await ids(db, 'replacement')).toEqual(['a']);
  await core.writeRow(db, 'items', { id: 'a', name: 'sent edit' });
  await core.sync(db, hub);
  expect(await ids(db, 'sent')).toEqual(['a']);
  expect(requests.some(r => JSON.stringify(r.body).includes('_core_search_'))).toBe(false);
  expect(await db.all("SELECT ddl FROM _schema_log WHERE ddl LIKE '%_core_search_%'")).toEqual([]);
});

test.each(['_core_search_fts', '_core_search_docs', '_core_search_dirty', '_core_search_state'])(
  'a lost %s cache component rebuilds without losing unchanged rows', async name => {
    const { db } = await local();
    await ids(db, 'offline');
    await db.run(`DROP TABLE ${name}`);
    expect(await ids(db, 'offline')).toEqual(['a']);
    await db.run("UPDATE items SET body='after recovery'");
    expect(await ids(db, 'recovery')).toEqual(['a']);
  },
);

test('nonbinary primary keys do not retain a REPLACE victim under a different spelling', async () => {
  const { db } = await local();
  await db.run('CREATE TABLE folded (id TEXT PRIMARY KEY COLLATE NOCASE, body TEXT, deleted_at TEXT)');
  await db.run("INSERT INTO catalog_tables(id) VALUES ('folded')");
  await db.run("INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('folded.body','folded','body','text')");
  await db.run("INSERT INTO folded(id,body) VALUES ('lower','oldspelling')");
  expect(await ids(db, 'oldspelling')).toEqual(['lower']);
  await db.run("INSERT OR REPLACE INTO folded(id,body) VALUES ('LOWER','newspelling')");
  expect(await ids(db, 'oldspelling')).toEqual([]);
  expect(await ids(db, 'newspelling')).toEqual(['LOWER']);
});

test('NOCASE ID aliases across drain batches replace the actual row identity exactly once', async () => {
  const { db } = await local();
  await db.run('CREATE TABLE folded (id TEXT PRIMARY KEY COLLATE NOCASE, body TEXT, deleted_at TEXT)');
  await db.run("INSERT INTO catalog_tables(id) VALUES ('folded')");
  await db.run("INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('folded.body','folded','body','markdown')");
  const original = Array.from({ length: 101 }, (_, i) => `key${String(i).padStart(3, '0')}`);
  for (const id of original) await db.run('INSERT INTO folded(id,body) VALUES (?,?)', [id, 'needle']);
  expect((await search(db, { text: 'needle', limit: 200 })).map(r => r.id)).toEqual(original);
  await db.run('UPDATE folded SET id=upper(id)');
  expect((await db.all('SELECT count(*) AS n FROM _core_search_dirty'))[0].n).toBe(202);
  const expected = original.map(id => id.toUpperCase());
  for (let attempt = 0; attempt < 2; attempt++) {
    expect((await search(db, { text: 'needle', limit: 200 })).map(r => r.id)).toEqual(expected);
    expect((await db.all('SELECT count(*) AS n FROM _core_search_dirty'))[0].n).toBe(0);
    expect((await db.all("SELECT count(*) AS n FROM _core_search_docs WHERE tbl='folded'"))[0].n).toBe(101);
    expect((await db.all("SELECT count(*) AS n FROM _core_search_fts WHERE _core_search_fts MATCH 'needle'"))[0].n).toBe(101);
  }
  await db.run('UPDATE folded SET id=lower(id)');
  await drain(db);
  expect((await core.readRows(db, { table: 'folded', search: 'needle', limit: 200 })).map(r => r.record.id)).toEqual(original);
});

test('Python can edit the shared file while the UI is closed; the next open indexes its committed text', async () => {
  const { db, path } = await local(true);
  await ids(db, 'offline');
  const result = spawnSync('python3', ['-c', `import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
    db.execute("UPDATE items SET body='python same revision' WHERE id='a'")
    db.execute("INSERT INTO items(id,name,body) VALUES ('python','Python record','independent writer')")
`, path], { encoding: 'utf8' });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(await ids(db, 'revision')).toEqual(['a']);
  expect(await ids(db, 'independent')).toEqual(['python']);
});

test('global search pages tied scores deterministically and scopes duplicate IDs by table', async () => {
  const { db } = await local();
  await db.run('DELETE FROM items');
  for (let i = 0; i < 205; i++) await db.run('INSERT INTO items(id,name) VALUES (?,?)', [String(i).padStart(3, '0'), 'needle']);
  await db.run('CREATE TABLE other (id TEXT PRIMARY KEY, name TEXT, deleted_at TEXT)');
  await db.run("INSERT INTO other(id,name) VALUES ('000','needle')");
  await db.run("INSERT INTO catalog_tables(id,display) VALUES ('other','name')");
  await db.run("INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('other.name','other','name','text')");
  expect(await search(db, { text: 'needle' })).toHaveLength(50);
  expect(await search(db, { text: 'needle', limit: 1000 })).toHaveLength(200);
  expect((await search(db, { text: 'needle', limit: 200, offset: 200 })).map(r => [r.table, r.id]))
    .toEqual([['items', '200'], ['items', '201'], ['items', '202'], ['items', '203'], ['items', '204'], ['other', '000']]);
  expect((await search(db, { text: 'needle', table: 'other' })).map(r => r.id)).toEqual(['000']);
});

test('a document containing a huge single token still returns a bounded excerpt', async () => {
  const { db } = await local();
  await db.run('UPDATE items SET body=?', ['longword' + 'x'.repeat(10_000)]);
  const hit = (await search(db, { text: 'longword' }))[0];
  expect(hit.excerpt).toContain('longword');
  expect(hit.excerpt.length).toBeLessThanOrEqual(512);
});

test('failure in a later drain batch rolls back earlier batches and preserves the whole queue', async () => {
  const { db } = await local();
  for (let i = 0; i < 204; i++) await db.run('INSERT INTO items(id,name,body) VALUES (?,?,?)', [`b${i}`, 'Original', 'previous']);
  await ids(db, 'previous');
  await db.run("UPDATE items SET body='nextrevision'");
  const run = db.run.bind(db);
  let batches = 0;
  db.run = async (sql, params) => {
    const changes = await run(sql, params);
    if (sql.startsWith('DELETE FROM _core_search_dirty') && ++batches === 2) throw new Error('second batch failed');
    return changes;
  };
  await expect(ids(db, 'nextrevision')).rejects.toThrow('second batch failed');
  db.run = run;
  expect((await db.all('SELECT count(*) AS n FROM _core_search_dirty'))[0].n).toBe(205);
  expect((await db.all("SELECT count(*) AS n FROM _core_search_fts WHERE _core_search_fts MATCH 'nextrevision'"))[0].n).toBe(0);
  expect(await search(db, { text: 'nextrevision', limit: 200 })).toHaveLength(200);
  expect(await search(db, { text: 'nextrevision', limit: 200, offset: 200 })).toHaveLength(5);
});

test.each([
  null, [], {}, { text: null }, { text: 3 }, { text: 'word', table: null },
  { text: 'word', table: 'missing' }, { text: 'word', sql: '1=1' },
  ...[0, -1, 1.5, NaN, Infinity, '4', null].map(limit => ({ text: 'word', limit })),
  ...[-1, 1.5, NaN, Infinity, '4', null].map(offset => ({ text: 'word', offset })),
  { text: Array(65).fill('word').join(' ') },
])('rejects malformed search arguments %j', async args => {
  const { db } = await local();
  await expect(core.search(db, args as core.SearchArgs)).rejects.toThrow();
});

test('draining dirty rows looks up index entries by identity instead of ranging over the table', async () => {
  const { db } = await local();
  for (let i = 0; i < 450; i++) await db.run('INSERT INTO items(id,name,body) VALUES (?,?,?)', [`r${i}`, 'Row', 'first']);
  await ids(db, 'first');
  await db.run("UPDATE items SET body='second'");
  const statements: [string, core.Value[]][] = [];
  const all = db.all.bind(db), run = db.run.bind(db);
  db.all = async (sql, params = []) => { statements.push([sql, params]); return all(sql, params); };
  db.run = async (sql, params = []) => { statements.push([sql, params]); return run(sql, params); };
  expect(await search(db, { text: 'second', limit: 200 })).toHaveLength(200);
  db.all = all; db.run = run;
  const plans: string[] = [];
  for (const [sql, params] of statements.filter(([sql]) => /_core_search_(docs|dirty)/.test(sql) && !/^CREATE|LIMIT 1$|count\(\*\)/.test(sql)))
    for (const row of await all('EXPLAIN QUERY PLAN ' + sql, params)) plans.push(`${row.detail}  <-  ${sql.slice(0, 80)}`);
  // A per-batch statement that reads every queued or indexed row of the table grows with the table.
  // (Counts are per step or bounded probes, not per batch.)
  expect(plans.filter(p => /\bSCAN (d|_core_search_docs|_core_search_dirty)\b|\(tbl=\?\)  /.test(p))).toEqual([]);
});

test('a word matching more rows than the ranking bound ranks only the most recently indexed matches', async () => {
  const { db } = await local();
  // Indexed first and most relevant; ranking every match would put it on top.
  await db.run("INSERT INTO items(id,name,body) VALUES ('old','needle needle needle','needle needle needle')");
  await ids(db, 'needle');
  db.db.query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?) INSERT INTO items(id,name) SELECT 'n'||i,'needle' FROM n").run(core.SEARCH_RANKED_MATCHES);
  const hits = await search(db, { text: 'needle', limit: 200 });
  expect(hits).toHaveLength(200);
  expect(hits.some(h => h.id === 'old')).toBe(false);
  expect(hits.every(h => h.excerpt === 'needle')).toBe(true);
  // At the bound nothing is dropped, and the most relevant match ranks first.
  await db.run("DELETE FROM items WHERE id='n1'");
  expect((await search(db, { text: 'needle', limit: 1 }))[0]).toMatchObject({ id: 'old', excerpt: 'needle needle needle\nneedle needle needle' });
});

test('the ranking bound applies within the searched table and to live records only', async () => {
  const { db } = await local();
  await db.run("INSERT INTO items(id,name) VALUES ('mine','needle')");
  await db.run('CREATE TABLE other (id TEXT PRIMARY KEY, name TEXT, deleted_at TEXT)');
  await db.run("INSERT INTO catalog_tables(id,display) VALUES ('other','name')");
  await db.run("INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('other.name','other','name','text')");
  await ids(db, 'needle');
  db.db.query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?) INSERT INTO other(id,name,deleted_at) SELECT 'o'||i,'needle','2026-01-01T00:00:00.000Z' FROM n").run(core.SEARCH_RANKED_MATCHES);
  expect((await search(db, { text: 'needle' })).map(h => h.id)).toEqual(['mine']);
  db.db.query("UPDATE other SET deleted_at=NULL").run();
  expect((await search(db, { text: 'needle', table: 'items' })).map(h => h.id)).toEqual(['mine']);
});

test('excerpts center the first matching word of long text and fold accents like the index', async () => {
  const { db } = await local();
  const words = Array.from({ length: 60 }, (_, i) => `w${i}`);
  words[40] = 'Crème';
  await db.run("UPDATE items SET body=? WHERE id='a'", [words.join(' ')]);
  const [hit] = await search(db, { text: 'creme' });
  expect(hit.excerpt).toBe('...w29 w30 w31 w32 w33 w34 w35 w36 w37 w38 w39 Crème w41 w42 w43 w44 w45 w46 w47 w48 w49 w50 w51 w52...');
  words[40] = 'w40';
  words[5] = 'Crème';
  await db.run("UPDATE items SET body=? WHERE id='a'", [words.join(' ')]);
  expect((await search(db, { text: 'creme' }))[0].excerpt).toBe(`${words.slice(0, 24).join(' ')}...`);
});

test('an unchanged, fully indexed database searches without re-reading catalog properties or table schemas', async () => {
  const { db } = await local();
  expect(await ids(db, 'offline')).toEqual(['a']);
  const statements: string[] = [];
  const all = db.all.bind(db), run = db.run.bind(db);
  // Native bridges build row objects whose key order can differ between calls.
  db.all = async (sql, params) => { statements.push(sql); return (await all(sql, params)).map(row => Object.fromEntries(Object.entries(row).reverse())); };
  db.run = async (sql, params) => { statements.push(sql); return run(sql, params); };
  expect(await ids(db, 'offline')).toEqual(['a']);
  expect(statements.filter(sql => /SELECT \* FROM "catalog_(properties|rules)"|PRAGMA main\.table_info/.test(sql))).toEqual([]);
  expect(statements.length).toBeLessThan(20); // a full reconciliation is a few per table
  db.all = all; db.run = run;
  // Catalog, schema and row changes each still reach the index.
  await db.run("UPDATE catalog_properties SET type='text' WHERE col='qty'");
  expect(await ids(db, '42')).toEqual(['a']);
  await db.run('ALTER TABLE items ADD COLUMN subtitle TEXT');
  await db.run("UPDATE items SET subtitle='appendix' WHERE id='a'");
  await db.run("INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('subtitle','items','subtitle','text')");
  expect(await ids(db, 'appendix')).toEqual(['a']);
  await db.run("UPDATE items SET body='rewritten' WHERE id='a'");
  expect(await ids(db, 'rewritten')).toEqual(['a']);
});

async function table(db: core.SqlDriver, name: string, rows: number, text = 'needle') {
  await db.run(`CREATE TABLE ${name} (id TEXT PRIMARY KEY, note TEXT, deleted_at TEXT)`);
  await db.run('INSERT INTO catalog_tables(id) VALUES (?)', [name]);
  await db.run('INSERT INTO catalog_properties(id,tbl,col,type) VALUES (?,?,?,?)', [`${name}.note`, name, 'note', 'text']);
  await db.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?) INSERT INTO ${name}(id,note) SELECT '${name}'||printf('%07d',i),? FROM n`, [rows, text]);
}
const docs = async (db: core.SqlDriver, tbl: string) => Number((await db.all('SELECT count(*) AS n FROM _core_search_docs WHERE tbl=?', [tbl]))[0].n);

test('search, backlinks and view search read only what the index step built; they never build it', async () => {
  const { db } = await local();
  for (let i = 0; i < 450; i++) await db.run('INSERT INTO items(id,name,body) VALUES (?,?,?)', [`r${i}`, 'Row', 'offline copy']);
  const statements: string[] = [];
  const all = db.all.bind(db), run = db.run.bind(db);
  db.all = async (sql, params) => { statements.push(sql); return all(sql, params); };
  db.run = async (sql, params) => { statements.push(sql); return run(sql, params); };
  expect(await core.search(db, { text: 'offline' })).toEqual([]);
  expect(await core.readRows(db, { table: 'items', search: 'offline' })).toEqual([]);
  expect((await core.mentionedBy(db, { table: 'items', rowId: 'a' }))).toMatchObject({ rows: [], indexing: true });
  db.all = all; db.run = run;
  expect(statements.filter(sql => /^CREATE TRIGGER|INSERT INTO _core_search_(docs|fts|dirty)|PRAGMA main\.table_info/.test(sql))).toEqual([]);
  expect(await drain(db)).toBe(1);
  expect((await core.search(db, { text: 'offline', limit: 200 })).length).toBe(200);
  expect((await core.mentionedBy(db, { table: 'items', rowId: 'a' })).indexing).toBe(false);
});

test('the index step works in bounded chunks, resumes across calls and reports what is left', async () => {
  const { db } = await local();
  for (let i = 0; i < 450; i++) await db.run('INSERT INTO items(id,name,body) VALUES (?,?,?)', [`r${String(i).padStart(3, '0')}`, 'Row', 'offline copy']);
  // Every call makes progress: the first reconciles (installing triggers, recording work)...
  expect(await core.searchIndexStep(db, { budgetMs: 0 })).toEqual({ indexing: true, pending: 451, done: false });
  expect(await docs(db, 'items')).toBe(0);
  // ...and a zero budget still does one chunk after that; search sees that much.
  const first = await core.searchIndexStep(db, { budgetMs: 0 });
  expect(first).toEqual({ indexing: true, pending: 251, done: false });
  expect(await docs(db, 'items')).toBe(200);
  expect(await core.search(db, { text: 'offline', limit: 200, offset: 199 })).toHaveLength(1);
  let last = first, steps = 1;
  const statements: string[] = [];
  const all = db.all.bind(db);
  db.all = async (sql, params) => { statements.push(sql); return all(sql, params); };
  while (!last.done) {
    const next = await core.searchIndexStep(db, { budgetMs: 0 });
    expect(next.pending).toBeLessThanOrEqual(last.pending);
    last = next; steps++;
  }
  db.all = all;
  // Progress comes from stored estimates: a step never counts a source table.
  expect(statements.filter(sql => /count\(\*\)[^;]*"items"/.test(sql))).toEqual([]);
  expect(steps).toBeGreaterThan(2);
  expect(last).toEqual({ indexing: false, pending: 0, done: true });
  expect(await search(db, { text: 'offline', limit: 200, offset: 400 })).toHaveLength(51);
  // A clean step is idle: no reconciliation and no writes.
  expect(await core.searchIndexStep(db, {})).toEqual({ indexing: false, pending: 0, done: true });
  await db.run("UPDATE items SET body='changed' WHERE id='r001'");
  expect(await core.searchIndexStep(db, { budgetMs: 0 })).toEqual({ indexing: false, pending: 0, done: true });
  expect(await ids(db, 'changed')).toEqual(['r001']);
  await expect(core.searchIndexStep(db, { budgetMs: -1 })).rejects.toThrow(/budget/i);
  await expect(core.searchIndexStep(db, { budgetMs: 1.5 } as never)).rejects.toThrow(/budget/i);
});

test('provenance and tables over the size rule stay out of the index unless opted in per table', async () => {
  const { db } = await local();
  await core.initCore(db);
  await db.run("UPDATE items SET name='needle'");
  await table(db, 'provenance', 3);
  await table(db, 'big', 4);
  await table(db, 'unstated', core.SEARCH_MAX_ROWS + 300);
  // The size rule reads the hub's counts when sync stored them, else the local table.
  await db.run("INSERT INTO _core_state(key,value) VALUES ('hub_stats',?)", [JSON.stringify({ at: T0, tables: { items: 1, provenance: 3, big: core.SEARCH_MAX_ROWS + 1 } })]);
  const tables = async () => [...new Set((await search(db, { text: 'needle', limit: 200 })).map(h => h.table))].sort();
  expect(await tables()).toEqual(['items']);
  expect((await db.all("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB '_core_search_*'")).map(r => r.name).sort())
    .toEqual(['_core_search_items_delete', '_core_search_items_insert', '_core_search_items_update']);
  await db.run("INSERT INTO _core_state(key,value) VALUES (?,?)", [core.SEARCH_TABLES_KEY, JSON.stringify({ provenance: true, big: true, items: false })]);
  expect(await tables()).toEqual(['big', 'provenance']);
  expect(await docs(db, 'items')).toBe(0);
  await db.run("UPDATE _core_state SET value=? WHERE key=?", [JSON.stringify({ unstated: true }), core.SEARCH_TABLES_KEY]);
  // An opted-in table is sized in full: its progress estimate is not capped at the limit.
  expect((await core.searchIndexStep(db, { budgetMs: 0 })).pending).toBe(1 + core.SEARCH_MAX_ROWS + 300);
  await drain(db);
  // Ranking covers the newest matches only, so count entries: 50,001 new ones outnumber it.
  expect([await docs(db, 'items'), await docs(db, 'unstated'), await docs(db, 'provenance')]).toEqual([1, core.SEARCH_MAX_ROWS + 300, 0]);
  // An unreadable setting falls back to the defaults instead of stopping the index.
  await db.run("UPDATE _core_state SET value='not json' WHERE key=?", [core.SEARCH_TABLES_KEY]);
  expect(await tables()).toEqual(['items']);
}, 30_000);

test('an index built before an exclusion is purged in bounded chunks while the rest stays searchable', async () => {
  const { db } = await local();
  await core.initCore(db);
  await db.run("UPDATE items SET name='needle'");
  await table(db, 'provenance', 1200);
  await db.run("INSERT INTO _core_state(key,value) VALUES (?,?)", [core.SEARCH_TABLES_KEY, '{"provenance":true}']);
  await drain(db);
  expect(await docs(db, 'provenance')).toBe(1200);
  await db.run('DELETE FROM _core_state WHERE key=?', [core.SEARCH_TABLES_KEY]);
  expect(await core.searchIndexStep(db, { budgetMs: 0 })).toMatchObject({ indexing: false, done: false });
  expect(await docs(db, 'provenance')).toBe(1200);
  const first = await core.searchIndexStep(db, { budgetMs: 0 });
  expect(first).toMatchObject({ indexing: false, done: false });
  const left = await docs(db, 'provenance');
  expect(left).toBeGreaterThan(0);
  expect(left).toBeLessThan(1200);
  // A table leaving the index stops answering at once; its entries go in later chunks.
  expect((await core.search(db, { text: 'needle', limit: 200 })).map(h => h.table)).toEqual(['items']);
  expect(await docs(db, 'items')).toBe(1);
  await drain(db);
  expect(await docs(db, 'provenance')).toBe(0);
  expect(await db.all('SELECT * FROM _core_search_work')).toEqual([]);
});

test('a fresh large replica answers search, backlinks and a table open quickly while the index catches up', async () => {
  const { db } = await local();
  await core.initCore(db);
  await table(db, 'provenance', 600_000, 'origin edge');
  await table(db, 'notes', 40_000, 'everyday note');
  const timed = async <T>(body: () => Promise<T>) => { const started = performance.now(); await body(); return performance.now() - started; };
  const budget = 300;
  expect(await timed(() => core.search(db, { text: 'note' }))).toBeLessThan(budget);
  expect(await timed(() => core.mentionedBy(db, { table: 'notes', rowId: 'notes0000001' }))).toBeLessThan(budget);
  expect(await timed(() => core.readRows(db, { table: 'notes', limit: 50 }))).toBeLessThan(budget);
  // Each step is bounded (the first one also reconciles the schema), so requests never wait long behind it.
  let status: core.SearchIndexStatus | undefined;
  expect(await timed(async () => { status = await core.searchIndexStep(db, { budgetMs: 50 }); })).toBeLessThan(budget);
  expect(status).toMatchObject({ indexing: true, done: false });
  expect(await timed(() => core.search(db, { text: 'note' }))).toBeLessThan(budget);
  expect((await core.search(db, { text: 'note' })).length).toBeGreaterThan(0);
  expect(await timed(() => core.searchIndexStep(db, { budgetMs: 50 }))).toBeLessThan(budget);
  await drain(db);
  expect(await docs(db, 'provenance')).toBe(0);
  expect(await docs(db, 'notes')).toBe(40_000);
}, 120_000);

test('reads index a small queue of edits themselves once the index is current; larger queues wait for the step', async () => {
  const { db } = await local();
  await core.initCore(db); // as on any replica: the first write would otherwise create these
  await drain(db);
  await core.writeRow(db, 'items', { id: 'a', body: 'freshly edited' });
  // One write: the search sees it without a step, and so do searched views.
  expect((await core.search(db, { text: 'freshly' })).map(h => h.id)).toEqual(['a']);
  await db.run("UPDATE items SET body='view edit' WHERE id='a'");
  expect((await core.readRows(db, { table: 'items', search: 'view' })).map(r => r.record.id)).toEqual(['a']);
  // More than a batch queued (a pulled page, say) is the step's job.
  await db.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<201) INSERT INTO items(id,name) SELECT 'p'||i,'pulled' FROM n`);
  expect(await core.search(db, { text: 'pulled' })).toEqual([]);
  expect((await core.mentionedBy(db, { table: 'items', rowId: 'a' })).indexing).toBe(true);
  expect((await search(db, { text: 'pulled', limit: 200 })).length).toBe(200);
  // Nor does a read index anything while the step still owes a backfill.
  await table(db, 'later', 3);
  await core.searchIndexStep(db, { budgetMs: 0 });
  await db.run("INSERT INTO later(id,note) VALUES ('x','queued while owed')");
  await db.run("UPDATE _core_search_work SET backfill='later9' WHERE tbl='later'");
  expect(await core.search(db, { text: 'queued' })).toEqual([]);
});

test('a table outgrowing its size estimate still reads as indexing until its walk ends', async () => {
  const { db } = await local();
  await core.initCore(db);
  for (let i = 0; i < 450; i++) await db.run('INSERT INTO items(id,name) VALUES (?,?)', [`r${String(i).padStart(3, '0')}`, 'Row']);
  // The hub counted 1 row when sync last asked; the replica holds 451 now.
  await db.run("INSERT INTO _core_state(key,value) VALUES ('hub_stats',?)", [JSON.stringify({ at: T0, tables: { items: 1 } })]);
  expect(await core.searchIndexStep(db, { budgetMs: 0 })).toEqual({ indexing: true, pending: 1, done: false });
  await drain(db);
  expect(await docs(db, 'items')).toBe(451);
});

test('without a hub count, a rowid span bounds small tables; wide spans and WITHOUT ROWID tables are counted', async () => {
  const { db } = await local();
  await core.initCore(db);
  await table(db, 'sparse', 1, 'needle');
  await db.run(`INSERT INTO sparse(rowid,id,note) VALUES (?,?,?)`, [core.SEARCH_MAX_ROWS * 3, 'far', 'needle']);
  await db.run('CREATE TABLE clustered (id TEXT PRIMARY KEY, note TEXT, deleted_at TEXT) WITHOUT ROWID');
  await db.run("INSERT INTO catalog_tables(id) VALUES ('clustered')");
  await db.run("INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('clustered.note','clustered','note','text')");
  await db.run("INSERT INTO clustered(id,note) VALUES ('c1','needle'),('c2','needle')");
  await core.searchIndexStep(db, { budgetMs: 0 });
  // Two rows 150,000 rowids apart: counted, not estimated from the span.
  expect(await db.all("SELECT left FROM _core_search_work WHERE tbl='sparse'")).toEqual([{ left: 2 }]);
  await drain(db);
  expect([await docs(db, 'sparse'), await docs(db, 'clustered')]).toEqual([2, 2]);
});

test('chunks shrink after one overruns its time target and grow back when quick', async () => {
  const { db } = await local();
  for (let i = 0; i < 600; i++) await db.run('INSERT INTO items(id,name) VALUES (?,?)', [`r${String(i).padStart(3, '0')}`, 'Row']);
  await core.searchIndexStep(db, { budgetMs: 0 }); // reconcile
  const run = db.run.bind(db), clock = Date.now;
  let slow = true, now = clock();
  // A host whose chunks are slow (no JIT, wide rows): 60 ms for every chunk's index write, then 1 ms.
  // The clock only moves there, so a loaded test machine cannot change the outcome.
  Date.now = () => now;
  db.run = async (sql, params) => { if (sql.startsWith('INSERT INTO _core_search_fts')) now += slow ? 60 : 1; return run(sql, params); };
  try {
    const indexed = async () => { await core.searchIndexStep(db, { budgetMs: 0 }); return docs(db, 'items'); };
    expect(await indexed()).toBe(200);
    expect(await indexed()).toBe(300);
    expect(await indexed()).toBe(350);
    slow = false;
    expect(await indexed()).toBe(375);
    expect(await indexed()).toBe(425);
  } finally { Date.now = clock; db.run = run; }
});

test('index labels follow the display rules: trimmed display text, else the id', async () => {
  const { db } = await local();
  await db.run("INSERT INTO items(id,name,body) VALUES ('blank','   ','labelword'),('spaced','  Padded  ','labelword'),('numeric',NULL,'labelword')");
  await db.run("UPDATE catalog_tables SET display='qty' WHERE id='items'");
  await db.run("UPDATE items SET qty=7 WHERE id='numeric'");
  expect((await search(db, { text: 'labelword' })).map(h => [h.id, h.label]).sort()).toEqual([['blank', 'blank'], ['numeric', '7'], ['spaced', 'spaced']]);
  await db.run("UPDATE catalog_tables SET display='name' WHERE id='items'");
  expect((await search(db, { text: 'labelword' })).map(h => [h.id, h.label]).sort()).toEqual([['blank', 'blank'], ['numeric', 'numeric'], ['spaced', 'Padded']]);
});

test('source columns named like the cache columns index without ambiguity', async () => {
  const { db } = await local();
  await db.run('CREATE TABLE ledger (id TEXT PRIMARY KEY, tbl TEXT, row_id TEXT, label TEXT, docid TEXT, trashed TEXT, body TEXT, deleted_at TEXT)');
  await db.run("INSERT INTO catalog_tables(id,display) VALUES ('ledger','label')");
  for (const col of ['tbl', 'row_id', 'label', 'docid', 'trashed', 'body'])
    await db.run('INSERT INTO catalog_properties(id,tbl,col,type) VALUES (?,?,?,?)', [`ledger.${col}`, 'ledger', col, col === 'body' ? 'markdown' : 'text']);
  await db.run(`INSERT INTO ledger(id,tbl,row_id,label,docid,trashed,body) VALUES ('l1','tblword','rowword','Ledger label','docword','trashword',?)`, [`See [x](${core.irisHref('row', 'items', 'a')})`]);
  for (const word of ['tblword', 'rowword', 'docword', 'trashword']) expect((await search(db, { text: word })).map(h => [h.id, h.label])).toEqual([['l1', 'Ledger label']]);
  expect((await core.mentionedBy(db, { table: 'items', rowId: 'a' })).rows.map(r => r.id)).toEqual(['l1']);
});

test('a chunk holds about 256 KB of text, so one wide row makes a chunk of its own', async () => {
  const { db } = await local();
  await db.run('DELETE FROM items');
  for (const id of ['w1', 'w2', 'w3']) await db.run('INSERT INTO items(id,name,body) VALUES (?,?,?)', [id, 'Wide', 'widetext ' + 'x'.repeat(200_000)]);
  await core.searchIndexStep(db, { budgetMs: 0 }); // reconcile
  await core.searchIndexStep(db, { budgetMs: 0 });
  expect(await docs(db, 'items')).toBe(1);
  await drain(db);
  expect((await search(db, { text: 'widetext' })).map(h => h.id)).toEqual(['w1', 'w2', 'w3']);
});

test('a walk installs its queue triggers as it starts and leaves the index reconciled', async () => {
  const { db } = await local();
  await core.initCore(db);
  for (let i = 0; i < 450; i++) await db.run('INSERT INTO items(id,name) VALUES (?,?)', [`r${String(i).padStart(3, '0')}`, 'Row']);
  const triggers = async () => (await db.all("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB '_core_search_*'")).length;
  await core.searchIndexStep(db, { budgetMs: 0 }); // reconcile records the walk, installs nothing
  expect(await triggers()).toBe(0);
  // An edit before the walk starts needs no trigger: the walk reads the row as it is.
  await db.run("UPDATE items SET name='before walk' WHERE id='r400'");
  const statements: string[] = [];
  const all = db.all.bind(db);
  db.all = async (sql, params) => { statements.push(sql); return all(sql, params); };
  await core.searchIndexStep(db, { budgetMs: 0 });
  expect(await triggers()).toBe(3);
  statements.length = 0;
  await core.searchIndexStep(db, { budgetMs: 0 });
  db.all = all;
  expect(statements.some(sql => sql.includes('p.name,p.pk'))).toBe(false); // not reconciled again
  // An edit to a row the walk already passed is queued by the trigger.
  await db.run("UPDATE items SET name='after walk' WHERE id='a'");
  expect((await search(db, { text: 'walk', limit: 10 })).map(h => h.id).sort()).toEqual(['a', 'r400']);
});

test('index-only schema changes keep the search index, catalog revision and writeability', async () => {
  const { db } = await local();
  await core.initCore(db);
  for (let i = 0; i < 450; i++) await db.run('INSERT INTO items(id,name) VALUES (?,?)', [`r${String(i).padStart(3, '0')}`, 'Row']);
  await drain(db);
  const revision = (await core.catalogRevision(db)).revision;
  const writeable = await core.writeability(db, { table: 'items' });
  const entries = async () => await db.all("SELECT docid,row_id FROM _core_search_docs WHERE tbl='items' ORDER BY docid");
  const indexed = await entries();
  // A user index (logged DDL a replica replays), a unique one and their removal: none touches indexed text.
  const statements: string[] = [];
  const all = db.all.bind(db);
  db.all = async (sql, params) => { statements.push(sql); return all(sql, params); };
  for (const ddl of ['CREATE INDEX items_qty ON items(qty, name) WHERE deleted_at IS NULL', 'CREATE UNIQUE INDEX items_name ON items(name, id)', 'DROP INDEX items_qty']) {
    await db.run(ddl);
    expect(await core.searchIndexStep(db, { budgetMs: 0 })).toEqual({ indexing: false, pending: 0, done: true });
    expect(await db.all('SELECT * FROM _core_search_work')).toEqual([]);
  }
  db.all = all;
  expect(statements.some(sql => sql.includes('p.name,p.pk'))).toBe(false); // not even reconciled
  expect((await core.catalogRevision(db)).revision).toBe(revision);
  expect(await core.writeability(db, { table: 'items' })).toEqual(writeable);
  // A later reconciliation (another table joins the catalog) still leaves this table's entries alone.
  await table(db, 'other', 3);
  expect(await core.searchIndexStep(db, { budgetMs: 0 })).toMatchObject({ indexing: true, done: false });
  expect(await db.all('SELECT tbl FROM _core_search_work')).toEqual([{ tbl: 'other' }]);
  await drain(db);
  expect(await entries()).toEqual(indexed);
  // Edits still reach the index.
  await db.run("UPDATE items SET name='indexed later' WHERE id='r001'");
  expect(await ids(db, 'later')).toEqual(['r001']);
  // A REPLACE victim of a unique index added after indexing still leaves the index.
  await db.run('CREATE UNIQUE INDEX items_qty_once ON items(qty)');
  await db.run("INSERT OR REPLACE INTO items(id,name,qty) VALUES ('victor','indexed later',42)");
  expect((await ids(db, 'later')).sort()).toEqual(['r001', 'victor']);
  expect(await ids(db, 'offline')).toEqual([]);
});

test('fingerprints written before indexes were ignored keep a table indexed after an upgrade', async () => {
  const { db } = await local();
  await drain(db);
  // The earlier format listed the table's index definitions; with them unchanged the table stays indexed.
  const [table] = await db.all("SELECT sql FROM sqlite_master WHERE type='table' AND name='items'");
  const indexes = (await db.all("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='items'")).map(r => String(r.sql)).sort();
  await db.run("UPDATE _core_search_state SET fingerprint=? WHERE tbl='items'", [JSON.stringify([2, table.sql, indexes, ['body', 'name'], 'name', ['body']])]);
  await db.run("UPDATE _core_search_state SET fingerprint='earlier format' WHERE tbl=''");
  expect(await core.searchIndexStep(db, { budgetMs: 0 })).toEqual({ indexing: false, pending: 0, done: true });
  expect(await db.all('SELECT * FROM _core_search_work')).toEqual([]);
  // A definition that did change (a new text column) still re-indexes the table.
  await db.run("UPDATE catalog_properties SET type='text' WHERE col='qty'");
  expect(await ids(db, '42')).toEqual(['a']);
});
