import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '../src/index.ts';
import type { Hub } from '../src/driver.ts';
import { schema, setup, TestSql, T0, T1, T2 } from './support.ts';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

async function replica(path?: string, collation?: string) {
  const fixture = setup();
  if(collation) {
    const ddl = schema[0].replace('id TEXT PRIMARY KEY', `id TEXT PRIMARY KEY COLLATE ${collation}`);
    fixture.remote.db.exec(`DROP TABLE items; ${ddl}`);
    fixture.remote.db.query('UPDATE _schema_log SET ddl=? WHERE ddl=?').run(ddl,schema[0]);
  }
  if (path) { fixture.db.db.close(); fixture.db.db = new Database(path); }
  cleanup.push(() => fixture.db.db.close(), () => fixture.remote.db.close());
  for (const [col, type, required] of [['name', 'text', 1], ['qty', 'int', 0]]) {
    fixture.remote.db.query('INSERT INTO catalog_properties(id,tbl,col,type,required,updated_at,hub_at) VALUES (?,?,?,?,?,?,?)')
      .run(`items.${col}`, 'items', col, type, required, T0, T1);
  }
  await core.sync(fixture.db, fixture.hub);
  return fixture;
}

test('syncStatus is exported and an empty replica has no UI work or successful sync', async () => {
  const db = new TestSql(); cleanup.push(() => db.db.close());
  expect(typeof core.syncStatus).toBe('function');
  expect(await core.syncStatus(db)).toEqual({ lastSuccessfulSync: null, pendingUiEdits: 0, rejected: 0, skippedTables: [], skippedDetails: [] });
});

test('status and coalesced UI markers persist across reopening the database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-pending-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'replica.db');
  const { db } = await replica(path);
  const baseline = await core.syncStatus(db);
  const row = await core.writeRow(db, 'items', { name: 'Before' });
  const edited = await core.writeRow(db, 'items', { id: row.id, name: 'After' });
  // Other local writers have no UI marker. Their entire queue is not our count.
  await db.run('INSERT INTO items(id,name,updated_at) VALUES (?,?,?)', ['cli', 'CLI edit', T1]);
  await db.run('INSERT INTO _core_rejected(tbl,row_id,row,errors) VALUES (?,?,?,?)', ['items', 'cli', '{}', '[{},{}]']);
  db.db.close(); db.db = new Database(path);
  expect(await core.syncStatus(db)).toEqual({ ...baseline, pendingUiEdits: 1, rejected: 1 });
  expect(await db.all('SELECT * FROM _core_pending')).toEqual([{ tbl: 'items', row_id: row.id, updated_at: edited.updated_at }]);
});

test.each(['offline', 'lost receipt', 'malformed receipt', 'rejection'])('pending UI edits survive %s until an accepted retry', async failure => {
  const { db, hub, remote } = await replica();
  const before = await core.syncStatus(db);
  const row = await core.writeRow(db, 'items', { name: 'Offline edit' }, { id: () => 'a' });
  if (failure === 'rejection') {
    remote.db.query("UPDATE catalog_properties SET required=1,updated_at=?,hub_at=? WHERE col='qty'").run(T1, new Date().toISOString());
  }
  const transport: Hub = { ...hub, async post(route, body) {
    if (route === '/v1/rows/push' && body.table === 'items') {
      if (failure === 'offline') throw new Error('offline');
      if (failure === 'lost receipt') { await hub.post(route, body); throw new Error('offline'); }
      if (failure === 'malformed receipt') return { data: { upserted: 0, rejected: [] } };
    }
    return hub.post(route, body);
  } };
  const attempt = core.sync(db, transport, { now: () => new Date(Date.now() + 50) });
  if (failure === 'rejection') expect((await attempt).rejected).toMatchObject([{ id: 'a', table: 'items', rule: 'required' }]);
  else await expect(attempt).rejects.toThrow(failure === 'malformed receipt' ? 'invalid push response' : 'offline');
  // A finished round records its time even when the hub rejected an edit.
  const attempted = await core.syncStatus(db);
  expect(attempted).toEqual({ ...before, ...(failure === 'rejection' ? { lastSuccessfulSync: attempted.lastSuccessfulSync } : {}), pendingUiEdits: 1, rejected: failure === 'rejection' ? 1 : 0 });
  if (failure === 'rejection') expect(attempted.lastSuccessfulSync! > before.lastSuccessfulSync!).toBe(true);
  if (failure === 'rejection') await core.writeRow(db, 'items', { id: row.id, qty: 1 });
  const finished = new Date(Date.now() + 100);
  await core.sync(db, hub, { now: () => finished });
  expect(await core.syncStatus(db)).toEqual({ lastSuccessfulSync: finished.toISOString(), pendingUiEdits: 0, rejected: 0, skippedTables: [], skippedDetails: [] });
  expect(remote.db.query('SELECT name FROM items WHERE id=?').get(row.id)).toEqual({ name: 'Offline edit' });
});

test('an accepted push preserves a newer concurrent UI edit of the same row', async () => {
  const { db, hub, remote } = await replica();
  const row = await core.writeRow(db, 'items', { name: 'First' }, { id: () => 'a' });
  let newer = row;
  const transport: Hub = { ...hub, async post(route, body) {
    if (route === '/v1/rows/push' && body.table === 'items') {
      newer = await core.writeRow(db, 'items', { id: row.id, name: 'Second' });
    }
    return hub.post(route, body);
  } };
  await core.sync(db, transport);
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(1);
  expect(await db.all('SELECT * FROM _core_pending')).toEqual([{ tbl: 'items', row_id: row.id, updated_at: newer.updated_at }]);
  expect(remote.db.query('SELECT name FROM items').get()).toEqual({ name: 'First' });
  await core.sync(db, hub);
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(0);
  expect(remote.db.query('SELECT name FROM items').get()).toEqual({ name: 'Second' });
});

test('a newer remote pull cannot erase an unsent edit across failure, reopen and bounded replay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-pull-race-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'replica.db');
  const { db, hub, remote } = await replica(path);
  remote.db.query('INSERT INTO items(id,name,created_at,updated_at,hub_at) VALUES (?,?,?,?,?)').run('a', 'Before', T0, T0, T1);
  await core.sync(db, hub);
  const prior = await db.all("SELECT pull FROM _core_sync WHERE tbl='items'");
  const remoteRevision = new Date(Date.now() + 2000).toISOString();
  remote.db.query('UPDATE items SET name=?,updated_at=?,hub_at=? WHERE id=?').run('Remote', remoteRevision, remoteRevision, 'a');
  // history changed too, so this round asks for it (and fails there).
  remote.db.query('INSERT INTO history(id,tbl,row_id,col,updated_at,hub_at) VALUES (?,?,?,?,?,?)').run('h-remote', 'items', 'other', 'name', T0, remoteRevision);
  let changed = false;
  const transport: Hub = { ...hub, async post(route, body) {
    if (route === '/v1/rows/pull' && body.table === 'items' && !changed) {
      changed = true;
      await core.writeRow(db, 'items', { id: 'a', name: 'Unsent' });
    }
    if (route === '/v1/rows/pull' && body.table === 'history') throw new Error('connection lost');
    return hub.post(route, body);
  } };
  await expect(core.sync(db, transport)).rejects.toThrow('connection lost');
  db.db.close(); db.db = new Database(path);
  expect(await db.all("SELECT name FROM items WHERE id='a'")).toEqual([{ name: 'Unsent' }]);
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(1);
  expect(await db.all("SELECT pull FROM _core_sync WHERE tbl='items'")).toEqual(prior);
  const sent: string[] = [];
  await core.sync(db, { ...hub, async post(route, body) {
    if (route === '/v1/rows/push' && body.table === 'items') sent.push(...(body.rows as any[]).map(row => row.name));
    return hub.post(route, body);
  } });
  expect(sent).toContain('Unsent');
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(0);
  expect(await db.all("SELECT pull FROM _core_sync WHERE tbl='items'")).toEqual(prior);
  expect(await db.all("SELECT s.pull=c.pull AS coherent FROM _core_sync s JOIN _core_coverage c ON c.tbl=s.tbl WHERE s.tbl='items'")).toEqual([{ coherent: 1 }]);
  db.db.close(); db.db = new Database(path);
  // The deferred remote winner is replayed after our own receipt, without an endless full pull.
  await core.sync(db, hub);
  expect(await db.all("SELECT name FROM items WHERE id='a'")).toEqual([{ name: 'Remote' }]);
  expect(await db.all("SELECT s.pull=c.pull AS coherent FROM _core_sync s JOIN _core_coverage c ON c.tbl=s.tbl WHERE s.tbl='items'")).toEqual([{ coherent: 1 }]);
  expect(await db.all("SELECT pull FROM _core_sync WHERE tbl='items'")).not.toEqual(prior);
  expect(remote.db.query("SELECT new FROM history WHERE tbl='items' AND col='name'").all()).toContainEqual({ new: 'Unsent' });
});

test('an old rejection never marks a newer concurrent UI revision rejected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-rejection-race-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'replica.db');
  const { db, hub, remote } = await replica(path);
  await core.writeRow(db, 'items', { name: 'Old' }, { id: () => 'a' });
  await core.writeRow(db, 'items', { id: 'a', name: 'Rejected' });
  const transport: Hub = { ...hub, async post(route, body) {
    if (route === '/v1/rows/push' && body.table === 'items') {
      await core.writeRow(db, 'items', { id: 'a', name: 'Corrected' });
      return { data: { upserted: 0, rejected: [{ id: 'a', rule: 'required', col: 'name' }] }, date: new Date().toUTCString() };
    }
    return hub.post(route, body);
  } };
  await core.sync(db, transport);
  expect(await db.all('SELECT * FROM _core_rejected')).toEqual([]);
  expect(await db.all("SELECT name FROM items WHERE id='a'")).toEqual([{ name: 'Corrected' }]);
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(1);
  db.db.close(); db.db = new Database(path);
  await core.sync(db, hub, { tables: { items: false } });
  expect(remote.db.query('SELECT * FROM history').all()).toEqual([]);
  await core.sync(db, hub);
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(0);
  expect(remote.db.query("SELECT new FROM history WHERE col='name' ORDER BY updated_at").all()).toEqual([{new:'Rejected'}, {new:'Corrected'}]);
});

test.each([['NOCASE','A','a'], ['RTRIM','a','a ']])('pending pull guards use SQLite %s identity', async (collation, localID, remoteID) => {
  const { db, hub, remote } = await replica(undefined,collation);
  remote.db.query('INSERT INTO items(id,name,created_at,updated_at,hub_at) VALUES (?,?,?,?,?)').run(localID,'Before',T0,T0,T1);
  await core.sync(db,hub);
  const stamp = new Date(Date.now()+2000).toISOString();
  remote.db.query('UPDATE items SET id=?,name=?,updated_at=?,hub_at=?').run(remoteID,'Remote',stamp,stamp);
  let edited = false;
  await core.sync(db,{...hub, async post(route,body) {
    if(route==='/v1/rows/pull' && body.table==='items' && !edited) {
      edited=true;
      await core.writeRow(db,'items',{id:localID,name:'Unsent'});
    }
    return hub.post(route,body);
  }});
  expect(await db.all('SELECT name FROM items')).toEqual([{name:'Unsent'}]);
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(1);
});

test('an insert after the sync snapshot keeps its payload and history for the next round', async () => {
  const { db, hub, remote } = await replica();
  remote.db.query('INSERT INTO items(id,name,updated_at,hub_at) VALUES (?,?,?,?)').run('remote', 'Remote', T0, T2);
  let inserted = false;
  await core.sync(db, { ...hub, async post(route, body) {
    if (route === '/v1/rows/pull' && body.table === 'items' && !inserted) {
      inserted = true;
      await core.writeRow(db, 'items', { name: 'Created while pulling' }, { id: () => 'late' });
      await core.writeRow(db, 'items', { id: 'late', name: 'Edited while pulling' });
    }
    return hub.post(route, body);
  } });
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(1);
  expect(remote.db.query("SELECT id FROM items WHERE id='late'").get()).toBeNull();
  const history = await db.all("SELECT id,col,old,new FROM history WHERE row_id='late'");
  expect(history.length).toBeGreaterThan(0);
  await core.sync(db, hub);
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(0);
  expect(remote.db.query("SELECT name FROM items WHERE id='late'").get()).toEqual({ name: 'Edited while pulling' });
  expect(remote.db.query("SELECT id,col,old,new FROM history WHERE row_id='late'").all()).toEqual(history);
});

test('other clients acknowledgments and downloaded rows never imply a UI receipt', async () => {
  const { db, hub } = await replica();
  const row = await core.writeRow(db, 'items', { name: 'Shared replica' });
  // Same HTTP operation the Python daemon performs, without core sync handling its receipt.
  await hub.post('/v1/rows/push', { table: 'items', columns: Object.keys(row), rows: [row] });
  await db.run("INSERT OR REPLACE INTO _sync_state(key,value) VALUES ('last_push',?),('last_pull',?)", [row.updated_at as string, row.updated_at as string]);
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(1);
  const other = new TestSql(); cleanup.push(() => other.db.close());
  await core.sync(other, hub);
  expect((await core.syncStatus(other)).pendingUiEdits).toBe(0);
  expect(await other.all('SELECT name FROM items')).toEqual([{ name: 'Shared replica' }]);
  await core.sync(db, hub);
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(0);
});

test('an accepted newer non-UI revision resolves an older UI marker for the same row', async () => {
  const { db, hub, remote } = await replica();
  const row = await core.writeRow(db, 'items', { name: 'UI edit' });
  const newer = new Date(Date.parse(String(row.updated_at)) + 1).toISOString();
  await db.run('UPDATE items SET name=?,updated_at=? WHERE id=?', ['CLI edit', newer, String(row.id)]);
  expect(await db.all('SELECT updated_at FROM _core_pending')).toEqual([{ updated_at: row.updated_at }]);
  await core.sync(db, hub);
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(0);
  expect(remote.db.query('SELECT name FROM items').get()).toEqual({ name: 'CLI edit' });
});

test('skipped tables keep UI markers until an explicit backfill accepts them', async () => {
  const { db, hub, remote } = await replica();
  await core.writeRow(db, 'items', { name: 'Skipped' });
  await core.sync(db, hub, { tables: { items: false } });
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(1);
  expect(remote.db.query('SELECT * FROM items').all()).toEqual([]);
  await core.sync(db, hub, { tables: { items: true } });
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(0);
});

test('accepted batches clear only their UI markers even if a later batch fails', async () => {
  const { db, hub } = await replica();
  const before = await core.syncStatus(db);
  for (let i = 0; i < 201; i++) await core.writeRow(db, 'items', { name: 'Pending' }, { id: () => String(i).padStart(3, '0') });
  let batches = 0;
  const transport: Hub = { ...hub, async post(route, body) {
    if (route === '/v1/rows/push' && body.table === 'items' && ++batches === 2) throw new Error('offline');
    return hub.post(route, body);
  } };
  await expect(core.sync(db, transport)).rejects.toThrow('offline');
  expect(await core.syncStatus(db)).toEqual({ ...before, pendingUiEdits: 1 });
  expect(await db.all('SELECT row_id FROM _core_pending')).toEqual([{ row_id: '200' }]);
  await core.sync(db, hub);
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(0);
});

test('a pending UI revision below the checkpoint still sends its state and original history', async () => {
  const { db, hub, remote } = await replica();
  remote.db.query('INSERT INTO items(id,name,created_at,updated_at,hub_at) VALUES (?,?,?,?,?)').run('a', 'Before', T0, T0, T1);
  await core.sync(db, hub);
  await core.writeRow(db, 'items', { id: 'a', name: 'After' }, { now: () => new Date(T1) });
  const originals = await db.all('SELECT id,col,old,new FROM history');
  await core.sync(db, hub);
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(0);
  expect(remote.db.query('SELECT name FROM items').get()).toEqual({ name: 'After' });
  expect(remote.db.query('SELECT id,col,old,new FROM history').all()).toEqual(originals);
});

test('acknowledging one table never clears another table marker with the same row id', async () => {
  const { db, hub, remote } = await replica();
  const ddl = schema[0]!.replace('CREATE TABLE items', 'CREATE TABLE peers');
  remote.db.exec(ddl);
  remote.db.query('INSERT INTO _schema_log(applied_at,ddl) VALUES (?,?)').run(T0, ddl);
  remote.db.query('INSERT INTO catalog_properties(id,tbl,col,type,updated_at,hub_at) VALUES (?,?,?,?,?,?)')
    .run('peers.name', 'peers', 'name', 'text', T0, new Date().toISOString());
  await core.sync(db, hub, { tables: { peers: true } });
  const stamp = new Date();
  await core.writeRow(db, 'items', { name: 'First table' }, { id: () => 'same', now: () => stamp });
  const other = await core.writeRow(db, 'peers', { name: 'Second table' }, { id: () => 'same', now: () => stamp });
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(2);
  await core.sync(db, hub, { tables: { peers: false } });
  expect(await db.all('SELECT * FROM _core_pending')).toEqual([{ tbl: 'peers', row_id: 'same', updated_at: other.updated_at }]);
  await core.sync(db, hub, { tables: { peers: true } });
  expect((await core.syncStatus(db)).pendingUiEdits).toBe(0);
});

test('last completed round skipped tables survive reopening and clear after a complete backfill', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-skips-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'replica.db');
  const { db, hub } = await replica(path);
  const result = await core.sync(db, hub, { tables: { items: false, history: false } });
  expect(result.skipped).toEqual(['history', 'items']);
  const before = await core.syncStatus(db);
  expect(before.skippedTables).toEqual(['history', 'items']);
  expect(await db.all("SELECT value FROM _core_state WHERE key='skipped_tables'")).toEqual([{ value: '["history","items"]' }]);
  db.db.close(); db.db = new Database(path);
  expect(await core.syncStatus(db)).toEqual(before);
  await core.sync(db, hub, { tables: { items: true, history: true } });
  expect((await core.syncStatus(db)).skippedTables).toEqual([]);
});

test.each(['schema', 'rows', 'commit'])('failed next %s round retains previous skips and time', async failure => {
  const { db, hub, remote } = await replica();
  await core.sync(db, hub, { tables: { history: false } });
  const before = await core.syncStatus(db);
  remote.db.query('INSERT INTO items(id,name,updated_at,hub_at) VALUES (?,?,?,?)').run('remote', 'Remote', T0, T2);
  const transport: Hub = { ...hub, async post(route, body) {
    if (failure === 'schema' && route === '/v1/cursor') throw new Error('schema offline');
    if (failure === 'rows' && route === '/v1/rows/pull' && body.table === 'items') throw new Error('rows offline');
    return hub.post(route, body);
  } };
  const transaction = db.transaction.bind(db);
  if (failure === 'commit') db.transaction = body => transaction(async () => {
    const result = await body();
    const current = await db.all("SELECT value FROM _core_state WHERE key='coverage_phase'");
    if (current[0]?.value === 'ready') throw new Error('commit failed');
    return result;
  });
  const attempt = core.sync(db, transport);
  await expect(attempt).rejects.toThrow();
  const after = await core.syncStatus(db);
  expect(after.lastSuccessfulSync).toBe(before.lastSuccessfulSync);
  expect(after.skippedTables).toEqual(['history']);
});

test('legacy web skipped_tables state is read without host certification or mutation', async () => {
  const db = new TestSql(); cleanup.push(() => db.db.close());
  await core.initCore(db);
  await db.run("INSERT INTO _core_state(key,value) VALUES ('last_sync',?),('skipped_tables',?)", [T0, '["items"]']);
  const before = await db.all('SELECT * FROM _core_state ORDER BY key');
  expect(await core.syncStatus(db)).toEqual({ lastSuccessfulSync: T0, pendingUiEdits: 0, rejected: 0, skippedTables: ['items'],
    skippedDetails: [{ table: 'items', rows: null, estimatedBytes: null, waitingEdits: 0 }] });
  expect(await db.all('SELECT * FROM _core_state ORDER BY key')).toEqual(before);
  expect(await db.all('SELECT * FROM _core_coverage')).toEqual([]);
});

test.each(['{bad', '{}', 'null', '[1]', '[""]', '["items","items"]'])('malformed skipped status is explicit, never silently complete: %s', async value => {
  const db = new TestSql(); cleanup.push(() => db.db.close());
  await core.initCore(db);
  await db.run("INSERT INTO _core_state(key,value) VALUES ('skipped_tables',?)", [value]);
  await expect(core.syncStatus(db)).rejects.toThrow('Invalid saved skipped-table status');
});

test.each([false, true])('completed pulls publish changed skips and completion time despite a rejected push; prior success=%s', async previousSuccess => {
  const fixture = setup();
  const { db, remote, hub } = fixture;
  cleanup.push(() => db.db.close(), () => remote.db.close());
  for (const ddl of schema) await db.run(ddl);
  await db.run("INSERT INTO catalog_properties(id,tbl,col,type,required) VALUES ('items.name','items','name','text',1),('items.qty','items','qty','int',0)");
  // The hub already requires qty; a skipped initial pull must not make the UI
  // marker disappear. The next round receives this rule and rejects the edit.
  for (const [col, type] of [['name','text'],['qty','int']]) {
    remote.db.query('INSERT INTO catalog_properties(id,tbl,col,type,required,updated_at,hub_at) VALUES (?,?,?,?,?,?,?)').run(`items.${col}`,'items',col,type,1,T0,T1);
  }
  await db.run("UPDATE catalog_properties SET required=0 WHERE col='qty'");
  await core.writeRow(db, 'items', { name: 'Missing qty' });
  // A skipped table refuses new edits, so the edit is queued before its skipped round.
  if (previousSuccess) await core.sync(db, hub, { tables: { items: false } });
  // A round's completion time is its start checkpoint: two rounds in one
  // millisecond would publish the same value, so this one starts strictly later.
  const checkpoint = new Date(Date.now() + 1);
  const result = await core.sync(db, hub, { tables: { history: false }, now: () => checkpoint });
  expect(result.rejected.length).toBeGreaterThan(0);
  expect(result.skipped).toEqual(['history']);
  const after = await core.syncStatus(db);
  expect(after.lastSuccessfulSync).toBe(checkpoint.toISOString());
  expect(after.skippedTables).toEqual(['history']);
  expect(await db.all("SELECT value FROM _core_state WHERE key='skipped_tables'")).toEqual([{ value: '["history"]' }]);
});

test('a resumed page walk never skips a remote revision deferred behind an unsent edit', async () => {
  const { db, hub, remote } = await replica();
  const insert = remote.db.query('INSERT INTO items(id,name,created_at,updated_at,hub_at) VALUES (?,?,?,?,?)');
  for (let i = 0; i < 450; i++) insert.run(String(i).padStart(3, '0'), `Item ${i}`, T0, T0, T1);
  await core.sync(db, hub);
  await core.writeRow(db, 'items', { id: '001', name: 'Unsent' });
  const remoteRevision = new Date(Date.now() + 2000).toISOString();
  remote.db.query('UPDATE items SET name=?,updated_at=?,hub_at=? WHERE id=?').run('Remote', remoteRevision, remoteRevision, '001');
  // A later arrival moves the mark past the deferred row's hub_at.
  insert.run('zzz', 'Later', T0, remoteRevision, new Date(Date.now() + 3000).toISOString());
  const failing: Hub = { ...hub, async post(route, body) {
    if (route === '/v1/rows/pull' && body.table === 'items' && body.after === '399') throw new Error('connection lost');
    return hub.post(route, body);
  } };
  await expect(core.sync(db, failing)).rejects.toThrow('connection lost');
  await core.sync(db, hub);
  await core.sync(db, hub);
  expect(await db.all("SELECT name FROM items WHERE id='001'")).toEqual([{ name: 'Remote' }]);
});

test('a skipped table is read-only on this device until a round downloads it', async () => {
  const { db, hub, remote } = await replica();
  await core.writeRow(db, 'items', { name: 'Waiting' }, { id: () => 'a' });
  await core.sync(db, hub, { tables: { items: false } });
  const refused = { tbl: 'items', row_id: null, col: '', rule: 'not_synced', message: 'Not synced on this device. Download this table to edit it.' };
  expect(await core.writeability(db, { table: 'items' })).toEqual({ writable: false, reason: refused });
  // The writer rechecks inside its own transaction: nothing is written or queued.
  const before = await db.all('SELECT * FROM items');
  await expect(core.writeRow(db, 'items', { id: 'a', name: 'Refused' })).rejects.toMatchObject({ violations: [{ ...refused, row_id: 'a' }] });
  await expect(core.writeRow(db, 'items', { name: 'Refused' })).rejects.toMatchObject({ violations: [refused] });
  expect(await db.all('SELECT * FROM items')).toEqual(before);
  // The earlier edit waits for the table instead of reading as an upload in progress.
  expect(await core.syncStatus(db)).toMatchObject({ pendingUiEdits: 1, skippedTables: ['items'],
    skippedDetails: [{ table: 'items', rows: 0, estimatedBytes: expect.any(Number), waitingEdits: 1 }] });
  expect(remote.db.query('SELECT * FROM items').all()).toEqual([]);
  await core.sync(db, hub, { tables: { items: true } });
  expect(await core.writeability(db, { table: 'items' })).toEqual({ writable: true, reason: null });
  expect(await core.syncStatus(db)).toMatchObject({ pendingUiEdits: 0, skippedTables: [], skippedDetails: [] });
  expect(remote.db.query('SELECT name FROM items').all()).toEqual([{ name: 'Waiting' }]);
  await core.writeRow(db, 'items', { id: 'a', name: 'Editable' });
});

test('skipped details carry the hub row count and a size estimate from local rows', async () => {
  const { db, hub, remote } = await replica();
  const insert = remote.db.query('INSERT INTO items(id,name,qty,created_at,updated_at,hub_at) VALUES (?,?,?,?,?,?)');
  insert.run('a', 'Ä short', 7, T0, T0, T1);
  insert.run('b', 'A longer name', null, T0, T0, T1);
  await core.sync(db, hub);
  insert.run('c', 'Third', 3, T0, T0, T2);
  // Both sides cache counts for a day; recount now.
  remote.db.exec('DELETE FROM _table_stats');
  await db.run("DELETE FROM _core_state WHERE key='hub_stats'");
  // The size rule: three rows on the hub, a limit of two.
  expect((await core.sync(db, hub, { maxRows: 2 })).skipped).toEqual(['items']);
  const local = await db.all('SELECT * FROM items');
  const bytes = local.reduce((n, row) => n + Object.values(row).reduce((m: number, v) => m + (v == null ? 0 : Buffer.byteLength(String(v))), 0), 0);
  expect((await core.syncStatus(db)).skippedDetails).toEqual([{ table: 'items', rows: 3, estimatedBytes: Math.round(3 * bytes / local.length), waitingEdits: 0 }]);
  // No local rows: the size stays unknown rather than guessed.
  await db.run('DELETE FROM items');
  expect((await core.syncStatus(db)).skippedDetails).toEqual([{ table: 'items', rows: 3, estimatedBytes: null, waitingEdits: 0 }]);
  // No stored hub count: the row count is unknown too.
  await db.run("DELETE FROM _core_state WHERE key='hub_stats'");
  expect((await core.syncStatus(db)).skippedDetails).toEqual([{ table: 'items', rows: null, estimatedBytes: null, waitingEdits: 0 }]);
});
