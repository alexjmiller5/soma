import { expect, test } from 'bun:test';
import { sync } from '../src/sync.ts';
import { syncStatus } from '../src/status.ts';
import { coverageProblem } from '../src/coverage.ts';
import { setup, schema, T0, T1, T2 } from './support.ts';

// A replica must make durable progress even when a round cannot finish in one
// go: a schema change elsewhere, a failed request or a host deadline must never
// send every later round back to a full pull of the whole estate.
const T0_5 = '2026-01-01T12:00:00.000Z';
const T1_5 = '2026-01-02T12:00:00.000Z';
const pulls = (requests: { route: string; body: any }[], table: string) =>
  requests.filter(r => r.route === '/v1/rows/pull' && r.body.table === table).map(r => r.body);
function hubDDL(remote: any, ddl: string) {
  remote.db.exec(ddl);
  remote.db.query('INSERT INTO _schema_log(applied_at,ddl) VALUES (?,?)').run(T2, ddl);
}

test('a schema change in another table keeps incremental pulls; only the changed table re-pulls in full', async () => {
  const { db, remote, hub, requests } = setup();
  remote.db.query('INSERT INTO items(id,name,updated_at,hub_at) VALUES (?,?,?,?)').run('a', 'A', T0, T1);
  remote.db.query('INSERT INTO history(id,tbl,row_id,col,updated_at,hub_at) VALUES (?,?,?,?,?,?)').run('h', 'items', 'a', 'name', T0, T1);
  await sync(db, hub);
  hubDDL(remote, 'ALTER TABLE history ADD COLUMN note TEXT');
  requests.length = 0;
  await sync(db, hub);
  expect(pulls(requests, 'items').map(b => b.since)).toEqual([]);
  expect(pulls(requests, 'history').map(b => b.since)).toEqual(['']);
  // A column the hub filled before this replica's cursor needs that table's full pull.
  hubDDL(remote, 'ALTER TABLE items ADD COLUMN color TEXT');
  remote.db.query("UPDATE items SET color='red',updated_at=?,hub_at=? WHERE id='a'").run(T1, T0_5);
  requests.length = 0;
  await sync(db, hub);
  expect(pulls(requests, 'items').map(b => b.since)).toEqual(['']);
  expect(pulls(requests, 'history').map(b => b.since)).toEqual([]);
  expect(await db.all("SELECT color FROM items WHERE id='a'")).toEqual([{ color: 'red' }]);
});

test('a replayed index keeps its table\'s incremental pull and renews coverage in the same round', async () => {
  const { db, remote, hub, requests } = setup();
  remote.db.query('INSERT INTO items(id,name,updated_at,hub_at) VALUES (?,?,?,?)').run('a', 'A', T0, T1);
  await sync(db, hub);
  hubDDL(remote, 'CREATE INDEX items_name ON items(name) WHERE deleted_at IS NULL');
  requests.length = 0;
  await sync(db, hub);
  expect(await db.all("SELECT name FROM sqlite_master WHERE type='index' AND name='items_name'")).toEqual([{ name: 'items_name' }]);
  expect(pulls(requests, 'items').map(b => b.since)).toEqual([]);
  expect(await coverageProblem(db)).toBeNull();
});

test('a replayed drop and recreate with identical physical SQL re-pulls that table in full', async () => {
  const { db, remote, hub } = setup();
  remote.db.query('INSERT INTO items(id,name,updated_at,hub_at) VALUES (?,?,?,?)').run('a', 'A', T0, T2);
  await sync(db, hub);
  hubDDL(remote, 'DROP TABLE items');
  hubDDL(remote, schema[0].replace('CREATE TABLE items', 'CREATE TABLE IF NOT EXISTS items'));
  // Arrived in the rebuilt table before this replica's cursor mark.
  remote.db.query('INSERT INTO items(id,name,updated_at,hub_at) VALUES (?,?,?,?)').run('old', 'Old', T0, T1);
  remote.db.query('INSERT INTO items(id,name,updated_at,hub_at) VALUES (?,?,?,?)').run('a', 'A', T0, T2);
  await sync(db, hub);
  expect(await db.all('SELECT id FROM items ORDER BY id')).toEqual([{ id: 'a' }, { id: 'old' }]);
});

test('a round that fails later keeps the cursors of the tables it finished', async () => {
  const { db, remote, hub, requests } = setup();
  remote.db.query('INSERT INTO items(id,name,updated_at,hub_at) VALUES (?,?,?,?)').run('a', 'A', T0, T1);
  remote.db.query('INSERT INTO history(id,tbl,row_id,col,updated_at,hub_at) VALUES (?,?,?,?,?,?)').run('h', 'items', 'a', 'name', T0, T1);
  const failing = { ...hub, async post(route: string, body: any) {
    if (route === '/v1/rows/pull' && body.table === 'history') throw new Error('offline');
    return hub.post(route, body);
  } };
  await expect(sync(db, failing)).rejects.toThrow('offline');
  expect(await db.all("SELECT pull FROM _core_sync WHERE tbl='items'")).toEqual([{ pull: T1 }]);
  expect((await syncStatus(db)).lastSuccessfulSync).toBeNull();
  requests.length = 0;
  await sync(db, hub);
  expect(pulls(requests, 'items').map(b => b.since)).toEqual([]);
  expect(await db.all('SELECT id FROM history')).toEqual([{ id: 'h' }]);
  expect((await syncStatus(db)).lastSuccessfulSync).not.toBeNull();
});

test('a long table resumes at its failed page and keeps the first attempt\'s cursor mark', async () => {
  const { db, remote, hub, requests } = setup();
  const insert = remote.db.query('INSERT INTO items(id,name,updated_at,hub_at) VALUES (?,?,?,?)');
  for (let i = 0; i < 450; i++) insert.run(String(i).padStart(3, '0'), `Item ${i}`, T0, T1);
  let failed = false;
  const failing = { ...hub, async post(route: string, body: any) {
    if (route === '/v1/rows/pull' && body.table === 'items' && body.after === '399' && !failed) { failed = true; throw new Error('offline'); }
    return hub.post(route, body);
  } };
  await expect(sync(db, failing)).rejects.toThrow('offline');
  // Lands in an already-read page after the first mark; a later mark would hide it.
  insert.run('0000', 'Between', T0, T1_5);
  insert.run('zzz', 'Latest', T0, T2);
  requests.length = 0;
  await sync(db, hub);
  expect(pulls(requests, 'items')[0]).toMatchObject({ since: '', after: '399' });
  expect(await db.all("SELECT pull FROM _core_sync WHERE tbl='items'")).toEqual([{ pull: T1 }]);
  expect(await db.all("SELECT id FROM items WHERE id='0000'")).toEqual([]);
  await sync(db, hub);
  expect(await db.all('SELECT count(*) AS n FROM items')).toEqual([{ n: 452 }]);
  expect(await db.all('SELECT * FROM _core_pull_progress')).toEqual([]);
});

test('page progress restarts when the table gained a column between attempts', async () => {
  const { db, remote, hub, requests } = setup();
  const insert = remote.db.query('INSERT INTO items(id,name,updated_at,hub_at) VALUES (?,?,?,?)');
  for (let i = 0; i < 450; i++) insert.run(String(i).padStart(3, '0'), `Item ${i}`, T0, T1);
  const failing = { ...hub, async post(route: string, body: any) {
    if (route === '/v1/rows/pull' && body.table === 'items' && body.after === '399') throw new Error('offline');
    return hub.post(route, body);
  } };
  await expect(sync(db, failing)).rejects.toThrow('offline');
  hubDDL(remote, 'ALTER TABLE items ADD COLUMN color TEXT');
  remote.db.query("UPDATE items SET color='red',updated_at=? WHERE id='000'").run(T1);
  requests.length = 0;
  await sync(db, hub);
  expect(pulls(requests, 'items')[0].after).toBeUndefined();
  expect(await db.all("SELECT color FROM items WHERE id='000'")).toEqual([{ color: 'red' }]);
});

test('a completed round with rejected rows still records its completion time', async () => {
  const { db, remote, hub } = setup();
  remote.db.query('INSERT INTO catalog_properties(id,tbl,col,type,required,updated_at,hub_at) VALUES (?,?,?,?,?,?,?)').run('items.name', 'items', 'name', 'text', 1, T0, T1);
  await sync(db, hub);
  const before = (await syncStatus(db)).lastSuccessfulSync;
  await db.run('INSERT INTO items(id,updated_at) VALUES (?,?)', ['bad', new Date().toISOString()]);
  await new Promise(resolve => setTimeout(resolve, 5));
  const out = await sync(db, hub);
  expect(out.rejected.length).toBe(1);
  const status = await syncStatus(db);
  expect(status.rejected).toBe(1);
  expect(status.lastSuccessfulSync! > before!).toBe(true);
});

test('rows the hub could not fit in one request are pushed again in smaller batches', async () => {
  const { db, remote, hub } = setup();
  await sync(db, hub);
  const stamp = new Date(Date.now() + 5).toISOString();
  for (let i = 0; i < 120; i++) await db.run('INSERT INTO items(id,name,updated_at) VALUES (?,?,?)', [`r${String(i).padStart(3, '0')}`, 'Local', stamp]);
  // The hub's answer when one request exhausts its statement budget: earlier
  // rows commit, the rest come back retryable in a smaller batch.
  const budgeted = { ...hub, async post(route: string, body: any) {
    if (route === '/v1/rows/push' && body.rows.length > 30) {
      const fit = body.rows.slice(0, 10);
      const reply = await hub.post(route, { ...body, rows: fit });
      const rejected = body.rows.slice(10).map((r: any) => ({ id: r.id, col: null, rule: 'write-budget', message: 'Write budget reached; retry this row in a smaller batch.' }));
      return { ...reply, data: { ...(reply.data as any), rejected } };
    }
    return hub.post(route, body);
  } };
  const out = await sync(db, budgeted);
  expect(out.rejected).toEqual([]);
  expect(out.pushed).toBe(120);
  expect(remote.db.query("SELECT count(*) AS n FROM items WHERE name='Local'").get()).toEqual({ n: 120 });
  expect(await db.all('SELECT * FROM _core_rejected')).toEqual([]);
  expect((await syncStatus(db)).rejected).toBe(0);
});
