import { expect, test } from 'bun:test';
// @ts-ignore The production Worker is JavaScript, exercised through its real HTTP interface.
import worker from '../../worker/src/index.js';
// @ts-ignore Existing D1-compatible SQLite test adapter.
import { D1Shim } from '../../worker/test/d1shim.js';
import { pullTable, pullTables } from '../src/table-pull.js';

// The consumer helper against the real hub: one cursor request per quiet
// round, incremental batched pulls otherwise, tombstones and resets as core.
const at = (n: number) => `2026-10-01T00:00:${String(n).padStart(2, '0')}.000Z`;

async function hub(scopes = ['tables:read:bookmarks', 'tables:read:notes']) {
  const db = new D1Shim(), env = { DB: db, AUTH_DB: new D1Shim(), HUB_TOKEN: 'operator' };
  db.db.exec(`
    CREATE TABLE catalog_tables(id TEXT PRIMARY KEY,kind TEXT,deleted_at TEXT);
    CREATE TABLE catalog_properties(id TEXT PRIMARY KEY,tbl TEXT,col TEXT,type TEXT,sort INTEGER,required INTEGER,options TEXT,options_sql TEXT,ref_table TEXT,default_value TEXT,derived_by TEXT,inputs TEXT,deleted_at TEXT);
    CREATE TABLE bookmarks(id TEXT PRIMARY KEY,url TEXT,title TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT);
    CREATE TABLE notes(id TEXT PRIMARY KEY,body TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT);
    INSERT INTO catalog_tables VALUES ('bookmarks','table',NULL),('notes','table',NULL);
    INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('bookmarks.url','bookmarks','url','url'),('bookmarks.title','bookmarks','title','text'),('notes.body','notes','body','text');
  `);
  const routes: string[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    routes.push(new URL(url).pathname);
    return worker.fetch(new Request(url, init), env, { waitUntil() {} });
  };
  const minted = await worker.fetch(new Request('https://hub.test/v1/tokens/create', {
    method: 'POST', headers: { Authorization: 'Bearer operator' }, body: JSON.stringify({ name: 'reader', scopes: scopes.join(',') }),
  }), env, { waitUntil() {} });
  const { token } = await minted.json() as { token: string };
  const put = (table: string, id: string, values: Record<string, unknown>, hubAt: string) => {
    const cols = Object.keys(values);
    db.db.query(`INSERT INTO ${table}(id,${cols.join(',')},updated_at,hub_at) VALUES (?,${cols.map(() => '?').join(',')},?,?)
      ON CONFLICT(id) DO UPDATE SET ${cols.map(c => `${c}=excluded.${c}`).join(',')},updated_at=excluded.updated_at,hub_at=excluded.hub_at`)
      .run(id, ...(Object.values(values) as any[]), hubAt, hubAt);
  };
  return { db, routes, put, options: { endpoint: 'https://hub.test/', token, fetch } };
}

const columns = ['id', 'url', 'title'];

test('the first round pulls the whole table in one batch; a quiet round is one cursor request', async () => {
  const { put, routes, options } = await hub();
  put('bookmarks', 'a', { url: 'https://a.test/', title: 'A' }, at(1));
  put('bookmarks', 'b', { url: 'https://b.test/', title: 'B' }, at(2));
  const first = await pullTable({ ...options, table: 'bookmarks', columns, state: null });
  expect(first.full).toBe(true);
  expect(first.rows.map(r => [r.id, r.title])).toEqual([['a', 'A'], ['b', 'B']]);
  expect(first.deleted).toEqual([]);
  expect(routes).toEqual(['/v1/cursor', '/v1/rows/pull']);
  routes.length = 0;
  const quiet = await pullTable({ ...options, table: 'bookmarks', columns, state: first.state });
  expect(quiet).toMatchObject({ full: false, rows: [], deleted: [], tombstones: [] });
  expect(routes).toEqual(['/v1/cursor']);
  // State is plain JSON, so a consumer can store it anywhere.
  expect(JSON.parse(JSON.stringify(quiet.state))).toEqual(first.state);
});

test('later rounds return only arrivals, with tombstones as deleted ids', async () => {
  const { put, db, routes, options } = await hub();
  put('bookmarks', 'a', { url: 'https://a.test/', title: 'A' }, at(1));
  put('bookmarks', 'b', { url: 'https://b.test/', title: 'B' }, at(2));
  let { state } = await pullTable({ ...options, table: 'bookmarks', columns, state: null });
  put('bookmarks', 'a', { title: 'A2' }, at(3));
  put('bookmarks', 'c', { url: 'https://c.test/', title: 'C' }, at(3));
  db.db.exec(`UPDATE bookmarks SET deleted_at='${at(4)}', hub_at='${at(4)}' WHERE id='b'`);
  routes.length = 0;
  const round = await pullTable({ ...options, table: 'bookmarks', columns, state });
  expect(round.full).toBe(false);
  expect(round.rows.map(r => [r.id, r.title])).toEqual([['a', 'A2'], ['c', 'C']]);
  expect(round.deleted).toEqual(['b']);
  // A consumer that keeps deleted rows (to recognize them later) gets their columns too.
  expect(round.tombstones.map(r => [r.id, r.title, r.deleted_at])).toEqual([['b', 'B', at(4)]]);
  expect(routes).toEqual(['/v1/cursor', '/v1/rows/pull']);
});

test('a commit landing on the cursor mark after the read is fetched next round, not skipped', async () => {
  const { put, options } = await hub();
  put('bookmarks', 'a', { url: 'https://a.test/', title: 'A' }, at(5));
  const { state } = await pullTable({ ...options, table: 'bookmarks', columns, state: null });
  // Same millisecond as the mark we hold: only the count at the mark moved.
  put('bookmarks', 'late', { url: 'https://late.test/', title: 'Late' }, at(5));
  const round = await pullTable({ ...options, table: 'bookmarks', columns, state });
  expect(round.rows.map(r => r.id)).toEqual(['a', 'late']);
  const settled = await pullTable({ ...options, table: 'bookmarks', columns, state: round.state });
  expect(settled.rows).toEqual([]);
});

test('a mark behind the held cursor, other columns or another hub start a full pull', async () => {
  const { put, db, options } = await hub();
  put('bookmarks', 'a', { url: 'https://a.test/', title: 'A' }, at(1));
  put('bookmarks', 'b', { url: 'https://b.test/', title: 'B' }, at(2));
  const { state } = await pullTable({ ...options, table: 'bookmarks', columns, state: null });
  // The newest row purged (hard-deleted): the table's mark moves backwards.
  db.db.exec("DELETE FROM bookmarks WHERE id='b'");
  const restarted = await pullTable({ ...options, table: 'bookmarks', columns, state });
  expect(restarted.full).toBe(true);
  expect(restarted.rows.map(r => r.id)).toEqual(['a']);
  const widened = await pullTable({ ...options, table: 'bookmarks', columns: ['id', 'url'], state: restarted.state });
  expect(widened.full).toBe(true);
  const moved = await pullTable({ ...options, endpoint: 'https://other.test', table: 'bookmarks', columns: ['id', 'url'], state: widened.state, fetch: (url: string, init: RequestInit) => options.fetch(url.replace('other.test', 'hub.test'), init) });
  expect(moved.full).toBe(true);
});

test('many tables share one cursor request and one batch; an empty table stays quiet', async () => {
  const { put, routes, options } = await hub();
  put('bookmarks', 'a', { url: 'https://a.test/', title: 'A' }, at(1));
  const tables = { bookmarks: columns, notes: ['id', 'body'] };
  const first = await pullTables({ ...options, tables, state: null });
  expect(Object.keys(first.changes)).toEqual(['bookmarks', 'notes']);
  expect(first.changes.notes).toEqual({ full: true, rows: [], deleted: [], tombstones: [] });
  expect(routes).toEqual(['/v1/cursor', '/v1/rows/pull']);
  routes.length = 0;
  put('notes', 'n', { body: 'hello' }, at(9));
  const next = await pullTables({ ...options, tables, state: first.state });
  expect(next.changes.bookmarks.rows).toEqual([]);
  expect(next.changes.notes).toMatchObject({ full: true, rows: [{ id: 'n', body: 'hello' }] });
  expect(routes).toEqual(['/v1/cursor', '/v1/rows/pull']);
});

test('a table larger than one batch walks its pages', async () => {
  const { db, routes, options } = await hub();
  const insert = db.db.query("INSERT INTO bookmarks(id,url,title,updated_at,hub_at) VALUES (?,?,?,?,?)");
  db.db.transaction(() => { for (let i = 0; i < 5003; i++) insert.run(`r${String(i).padStart(5, '0')}`, `https://${i}.test/`, `T${i}`, at(1), at(1)); })();
  const first = await pullTable({ ...options, table: 'bookmarks', columns, state: null });
  expect(first.rows.length).toBe(5003);
  expect(new Set(first.rows.map(r => r.id)).size).toBe(5003);
  expect(routes).toEqual(['/v1/cursor', '/v1/rows/pull', '/v1/rows/pull']);
});

test('hub refusals and malformed answers fail the round and keep the caller state', async () => {
  const { put, options } = await hub(['tables:read:notes']);
  put('bookmarks', 'a', { url: 'https://a.test/', title: 'A' }, at(1));
  await expect(pullTable({ ...options, table: 'bookmarks', columns, state: null })).rejects.toMatchObject({ status: 403 });
  const answer = (body: unknown) => async () => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  const call = (fetch: any) => pullTable({ ...options, fetch, table: 'notes', columns: ['id'], state: null });
  await expect(call(answer({ tables: {} }))).rejects.toThrow('invalid cursor response');
  await expect(call(answer({ tables: { notes: 'yesterday' }, pull_batch: { items: 50, rows: 5000 } }))).rejects.toThrow('invalid cursor response');
  let n = 0;
  const looping = async (url: string) => new Response(JSON.stringify(url.endsWith('/v1/cursor')
    ? { tables: { notes: at(1) }, at_mark: { notes: 1 }, pull_batch: { items: 50, rows: 5000 } }
    : { batch: [{ rows: [{ id: 'x', hub_at: at(1), deleted_at: null }], next_cursor: n++ ? 'a' : 'x' }] }));
  await expect(call(looping)).rejects.toThrow('invalid pull response');
});
