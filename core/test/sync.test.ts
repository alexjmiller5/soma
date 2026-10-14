import { expect, test } from 'bun:test';
import { sync } from '../src/sync.ts';
import { setup, TestSql, T0, T1, T2 } from './support.ts';

test('a fresh replica replays schema and pages all rows from the real hub', async () => {
  const {db,remote,hub,requests} = setup();
  const insert=remote.db.query('INSERT INTO items(id,name,updated_at,hub_at) VALUES (?,?,?,?)');
  for(let i=0;i<205;i++) insert.run(String(i).padStart(3,'0'),`Item ${i}`,T0,T1);
  const result=await sync(db,hub);
  expect(result.pulled).toBe(205);
  expect(await db.all('SELECT count(*) AS n FROM items')).toEqual([{n:205}]);
  expect(requests.filter(r=>r.route==='/v1/rows/pull' && r.body.table==='items').length).toBe(2);
  expect(requests.some(r=>r.route==='/v1/rows/push')).toBe(false);
});

test('snapshot-before-pull pushes local edits without echoing downloaded rows', async () => {
  const {db,remote,hub,requests} = setup();
  await sync(db,hub);
  await db.run('INSERT INTO items(id,name,updated_at) VALUES (?,?,?)',['mine','Local',new Date(Date.now()+5).toISOString()]);
  remote.db.query('INSERT INTO items(id,name,updated_at,hub_at) VALUES (?,?,?,?)').run('theirs','Remote',T1,T2);
  requests.length=0;
  await sync(db,hub);
  expect(remote.db.query("SELECT name FROM items WHERE id='mine'").get()).toEqual({name:'Local'});
  const pushed=requests.filter(r=>r.route==='/v1/rows/push'&&r.body.table==='items').flatMap(r=>r.body.rows);
  expect(pushed.map(r=>r.id)).toEqual(['mine']);
  expect(await db.all('SELECT id FROM items ORDER BY id')).toEqual([{id:'mine'},{id:'theirs'}]);
});

test('size rule keeps the catalog, skips large tables, and backfills a later override', async () => {
  const {db,remote,hub,requests} = setup();
  for(const id of ['a','b','c']) remote.db.query('INSERT INTO items(id,name,updated_at,hub_at) VALUES (?,?,?,?)').run(id,id,T0,T1);
  const first=await sync(db,hub,{maxRows:2});
  expect(first.skipped).toContain('items');
  expect(await db.all('SELECT * FROM items')).toEqual([]);
  expect(requests.some(r=>r.route==='/v1/rows/pull'&&r.body.table==='catalog_properties')).toBe(true);
  await sync(db,hub,{maxRows:2,tables:{items:true}});
  expect(await db.all('SELECT count(*) AS n FROM items')).toEqual([{n:3}]);
});

test('hub rejection retains the original edit in an inbox and keeps it pending', async () => {
  const {db,remote,hub} = setup();
  remote.db.query('INSERT INTO catalog_properties(id,tbl,col,type,required,updated_at,hub_at) VALUES (?,?,?,?,?,?,?)').run('items.name','items','name','text',1,T0,T1);
  await sync(db,hub);
  await db.run('INSERT INTO items(id,updated_at) VALUES (?,?)',['bad',new Date().toISOString()]);
  const out=await sync(db,hub);
  expect(out.rejected).toMatchObject([{table:'items',id:'bad',rule:'required'}]);
  expect(await db.all('SELECT row_id FROM _core_rejected')).toEqual([{row_id:'bad'}]);
  await db.run('UPDATE items SET name=?,updated_at=? WHERE id=?',['Fixed',new Date(Date.now()+1).toISOString(),'bad']);
  expect((await sync(db,hub)).rejected).toEqual([]);
  expect(await db.all('SELECT * FROM _core_rejected')).toEqual([]);
  expect(remote.db.query("SELECT name FROM items WHERE id='bad'").get()).toEqual({name:'Fixed'});
});

test('a failed or nonadvancing page does not checkpoint past missing data', async () => {
  const {db,remote,hub} = setup();
  for(let i=0;i<201;i++) remote.db.query('INSERT INTO items(id,updated_at,hub_at) VALUES (?,?,?)').run(String(i).padStart(3,'0'),T0,T1);
  let pages=0;
  const broken={...hub,async post(route:string,body:any) {
    if(route==='/v1/rows/pull'&&body.table==='items'&&body.after) { if (++pages > 2) throw new Error('nonadvancing cursor loop'); return {data:{rows:[{id:'199',updated_at:T0}],next_cursor:'199'}}; }
    return hub.post(route,body);
  }};
  await expect(sync(db,broken)).rejects.toThrow('cursor');
  expect(pages).toBe(1);
  await sync(db,hub);
  expect(await db.all('SELECT count(*) AS n FROM items')).toEqual([{n:201}]);
});

test('a replica never sends its data or uses its cursors against a different hub', async () => {
  const {db,hub} = setup();
  await sync(db,hub);
  let contacted=false;
  await expect(sync(db,{endpoint:'https://other.test',async post(){contacted=true;return {data:{}};}})).rejects.toThrow('hub changed');
  expect(contacted).toBe(false);
});

test('a partial first sync remains bound to its original hub after a network failure', async () => {
  const {db,remote,hub} = setup();
  remote.db.query('INSERT INTO items(id,updated_at,hub_at) VALUES (?,?,?)').run('a',T0,T1);
  await expect(sync(db,{...hub,async post(route,body){
    if(route==='/v1/rows/pull'&&body.table==='items') throw new Error('offline');
    return hub.post(route,body);
  }})).rejects.toThrow('offline');
  let contacted=false;
  await expect(sync(db,{endpoint:'https://other.test',async post(){contacted=true;return {data:{}};}})).rejects.toThrow('hub changed');
  expect(contacted).toBe(false);
});

test('clock skew refuses to send local edits while leaving them available offline', async () => {
  const {db,hub,requests} = setup();
  await sync(db,hub);
  await db.run('INSERT INTO items(id,name,updated_at) VALUES (?,?,?)',['a','Offline edit',new Date().toISOString()]);
  requests.length=0;
  const skewed={...hub,async post(route:string,body:any){const out=await hub.post(route,body);return {...out,date:new Date(Date.now()-600_000).toUTCString()};}};
  await expect(sync(db,skewed)).rejects.toThrow('clock');
  expect(requests.some(r=>r.route==='/v1/rows/push')).toBe(false);
  expect(await db.all('SELECT name FROM items')).toEqual([{name:'Offline edit'}]);
});

test('the original edit history travels with the row and is not duplicated on the hub', async () => {
  const {db,remote,hub} = setup();
  remote.db.query('INSERT INTO items(id,name,updated_at,hub_at) VALUES (?,?,?,?)').run('a','Before',T0,T1);
  await sync(db,hub);
  const stamp=new Date(Date.now()+5).toISOString();
  await db.run('UPDATE items SET name=?,updated_at=? WHERE id=?',['After',stamp,'a']);
  await db.run('INSERT INTO history(id,tbl,row_id,col,old,new,origin,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',['edit','items','a','name','Before','After','test-device',stamp,stamp]);
  await sync(db,hub);
  expect(remote.db.query('SELECT id,old,new FROM history').all()).toEqual([{id:'edit',old:'Before',new:'After'}]);
});

test('overlapping rounds are refused before either can advance another round\'s checkpoint', async () => {
  const {db,hub} = setup();
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>release=resolve);
  let reached!:()=>void;
  const started=new Promise<void>(resolve=>reached=resolve);
  const slow={...hub,async post(route:string,body:any){reached();await gate;return hub.post(route,body);}};
  const first=sync(db,slow);
  await started;
  try { await expect(sync(db,hub)).rejects.toThrow('in progress'); }
  finally {release();await first;}
});

test('late local edits remain pending when made after the sync snapshot', async () => {
  const {db,remote,hub} = setup();
  await sync(db,hub);
  let edited=false;
  const during={...hub,async post(route:string,body:any){
    if(!edited&&route==='/v1/rows/pull'&&body.table==='items') {
      edited=true; await db.run('INSERT INTO items(id,name,updated_at) VALUES (?,?,?)',['late','Late edit',new Date(Date.now()+2).toISOString()]);
    }
    return hub.post(route,body);
  }};
  await sync(db,during);
  expect(remote.db.query("SELECT id FROM items WHERE id='late'").get()).toBeNull();
  await sync(db,hub);
  expect(remote.db.query("SELECT name FROM items WHERE id='late'").get()).toEqual({name:'Late edit'});
});

test('a database already bound by the CLI cannot be synced to another endpoint', async () => {
  const {db,hub}=setup();
  await db.run('CREATE TABLE _sync_state(key TEXT PRIMARY KEY,value TEXT)');
  await db.run("INSERT INTO _sync_state VALUES ('hub_url','https://other.test')");
  await expect(sync(db,hub)).rejects.toThrow('hub changed');
});

test('invalid receipts never acknowledge a local edit', async () => {
  const {db,hub}=setup(); await sync(db,hub);
  await db.run('INSERT INTO items(id,name,updated_at) VALUES (?,?,?)',['mine','Local',new Date().toISOString()]);
  const bad={...hub,async post(route:string,body:any){
    if(route==='/v1/rows/push') return {data:{upserted:0,rejected:[{id:'someone-else',rule:'required'}]}};
    return hub.post(route,body);
  }};
  await expect(sync(db,bad)).rejects.toThrow('invalid push');
});

test('a malformed hub watermark cannot poison the next pull checkpoint', async () => {
  const {db,hub}=setup();
  const bad={...hub,async post(route:string,body:any){
    if(route==='/v1/cursor') return {data:{max_hub_at:'tomorrow',tables:{items:'tomorrow'}}};
    return hub.post(route,body);
  }};
  await expect(sync(db,bad)).rejects.toThrow('cursor response');
  expect(await db.all('SELECT * FROM _core_sync')).toEqual([]);
});

test('clock rollback rescans local rows instead of silently skipping older edits', async () => {
  const {db,hub,remote}=setup();
  await sync(db,hub);
  await db.run("UPDATE _core_sync SET push='2099-01-01T00:00:00.000Z'");
  await db.run('INSERT INTO items(id,name,updated_at) VALUES (?,?,?)',['a','Recovered',T0]);
  await sync(db,hub);
  expect(remote.db.query("SELECT name FROM items WHERE id='a'").get()).toEqual({name:'Recovered'});
});

test('a hub write between cursor and pull remains discoverable on the following round', async () => {
  const {db,hub,remote}=setup();
  remote.db.query('INSERT INTO items(id,name,updated_at,hub_at) VALUES (?,?,?,?)').run('first','First',T0,T0);
  let write=false;
  const interleaved={...hub,async post(route:string,body:any){
    const out=await hub.post(route,body);
    if(route==='/v1/rows/pull'&&body.table==='items'&&!write){write=true;remote.db.query('INSERT INTO items(id,name,updated_at,hub_at) VALUES (?,?,?,?)').run('late','Late',T1,T1);}
    return out;
  }};
  await sync(db,interleaved);
  expect(await db.all("SELECT id FROM items WHERE id='late'")).toEqual([]);
  await sync(db,hub);
  expect(await db.all("SELECT name FROM items WHERE id='late'")).toEqual([{name:'Late'}]);
});

test('local history accompanies edits even when the history table is excluded by the size rule', async () => {
  const {db,remote,hub}=setup();
  remote.db.query('INSERT INTO items(id,name,updated_at,hub_at) VALUES (?,?,?,?)').run('a','Before',T0,T1);
  await sync(db,hub,{tables:{history:false}});
  const stamp=new Date(Date.now()+2).toISOString();
  await db.run('UPDATE items SET name=?,updated_at=? WHERE id=?',['After',stamp,'a']);
  await db.run('INSERT INTO history(id,tbl,row_id,col,old,new,origin,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',['original','items','a','name','Before','After','device',stamp,stamp]);
  await sync(db,hub,{tables:{history:false}});
  expect(remote.db.query('SELECT id FROM history').all()).toEqual([{id:'original'}]);
});

test('rejected row history is withheld until the owning row is accepted', async () => {
  const {db,remote,hub}=setup();
  remote.db.query('INSERT INTO items(id,name,updated_at,hub_at) VALUES (?,?,?,?)').run('a','Before',T0,T1);
  remote.db.query('INSERT INTO catalog_properties(id,tbl,col,type,required,updated_at,hub_at) VALUES (?,?,?,?,?,?,?)').run('items.name','items','name','text',1,T0,T1);
  await sync(db,hub);
  const stamp=new Date(Date.now()+2).toISOString();
  await db.run('UPDATE items SET name=NULL,updated_at=? WHERE id=?',[stamp,'a']);
  await db.run('INSERT INTO history(id,tbl,row_id,col,old,new,origin,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',['rejected','items','a','name','Before',null,'device',stamp,stamp]);
  expect((await sync(db,hub)).rejected).toMatchObject([{table:'items',id:'a',rule:'required'}]);
  expect(remote.db.query('SELECT * FROM history').all()).toEqual([]);
});

test('binding a core replica invalidates unbound Python checkpoints without advancing them', async () => {
  const {db,hub}=setup();
  await db.run('CREATE TABLE _sync_state(key TEXT PRIMARY KEY,value TEXT)');
  await db.run("INSERT INTO _sync_state VALUES ('last_push',?),('last_pull',?),('checkpoint_version','2')",[T2,T2]);
  await sync(db,hub);
  expect(await db.all("SELECT value FROM _sync_state WHERE key='hub_url'")).toEqual([{value:hub.endpoint}]);
  expect(await db.all("SELECT value FROM _sync_state WHERE key='checkpoint_version'")).toEqual([{value:''}]);
  expect(await db.all("SELECT value FROM _sync_state WHERE key='last_push'")).toEqual([{value:T2}]);
  await db.run("UPDATE _sync_state SET value='2' WHERE key='checkpoint_version'");
  await sync(db,hub);
  expect(await db.all("SELECT value FROM _sync_state WHERE key='checkpoint_version'")).toEqual([{value:'2'}]);
});

test.each(['missing','overlap'])('a %s receipt leaves edits pending', async mode => {
  const {db,hub,remote}=setup(); await sync(db,hub);
  await db.run("UPDATE _core_sync SET push='' WHERE tbl='items'");
  await db.run('INSERT INTO items(id,name,updated_at) VALUES (?,?,?)',['mine','Local',T0]);
  const broken={...hub,async post(route:string,body:any){
    if(route==='/v1/rows/push'&&body.table==='items') return {data:{upserted:mode==='missing'?0:1,rejected:mode==='missing'?[]:[{id:'mine',rule:'required'}],hub_at:''}};
    return hub.post(route,body);
  }};
  await expect(sync(db,broken)).rejects.toThrow('invalid push response');
  await sync(db,hub);
  expect(remote.db.query("SELECT name FROM items WHERE id='mine'").get()).toEqual({name:'Local'});
});

test('multiple violations for one rejected row count once and cannot override its table', async () => {
  const {db,hub}=setup(); await sync(db,hub);
  await db.run("UPDATE _core_sync SET push='' WHERE tbl='items'");
  await db.run('INSERT INTO items(id,name,updated_at) VALUES (?,?,?)',['mine','Local',T0]);
  const reject={...hub,async post(route:string,body:any){
    if(route==='/v1/rows/push'&&body.table==='items') return {data:{upserted:0,rejected:[
      {id:'mine',col:'name',rule:'required',table:'other'}, {id:'mine',col:'qty',rule:'required'},
    ],hub_at:''}};
    return hub.post(route,body);
  }};
  expect((await sync(db,reject)).rejected.map(r=>r.table)).toEqual(['items','items']);
  expect(await db.all("SELECT push FROM _core_sync WHERE tbl='items'")).toEqual([{push:''}]);
});

test.each(['early failure','failure','rejection','midflight rejection','skipped'])('clock rollback recovery survives %s until a full push succeeds', async mode => {
  const {db,hub,remote}=setup(); await sync(db,hub);
  await db.run('UPDATE _core_sync SET push=?',[T2]);
  await db.run('INSERT INTO items(id,name,updated_at) VALUES (?,?,?)',['lost','Offline',T1]);
  let clock=mode==='midflight rejection'?new Date().toISOString():T1;
  const interrupted={...hub,async post(route:string,body:any){
    if(mode==='early failure'&&route==='/v1/cursor') throw new Error('offline');
    if(mode==='midflight rejection'&&route==='/v1/cursor') clock=T1;
    if(mode==='failure'&&route==='/v1/rows/pull'&&body.table==='items') throw new Error('offline');
    if(mode.endsWith('rejection')&&route==='/v1/rows/push'&&body.table==='items') return {data:{upserted:0,rejected:[{id:'lost',rule:'write-budget'}]},date:new Date(clock).toUTCString()};
    return {...await hub.post(route,body),date:new Date(clock).toUTCString()};
  }};
  const attempt=sync(db,interrupted,{now:()=>new Date(clock),...(mode==='skipped'?{tables:{items:false}}:{})});
  if(mode.endsWith('failure')) await expect(attempt).rejects.toThrow('offline');
  else await attempt;
  await sync(db,hub);
  expect(remote.db.query("SELECT name FROM items WHERE id='lost'").get()).toEqual({name:'Offline'});
});

test.each(['missing','extra','object','undefined','nonfinite'])('a %s pull cell cannot overwrite a complete local row', async shape => {
  const {db,hub,remote}=setup();
  remote.db.query('INSERT INTO items(id,name,created_at,updated_at,hub_at) VALUES (?,?,?,?,?)').run('a','Before',T0,T0,T1);
  await sync(db,hub);
  remote.db.query('UPDATE items SET name=?,updated_at=?,hub_at=?').run('After',T1,T2);
  const before=await db.all('SELECT * FROM items');
  const state=await db.all("SELECT * FROM _core_sync WHERE tbl='items'");
  const broken={...hub,async post(route:string,body:any){
    const reply=await hub.post(route,body);
    if(route==='/v1/rows/pull'&&body.table==='items') {
      const row=(reply.data as any).rows[0];
      if(shape==='missing') delete row.name;
      if(shape==='extra') row.extra='unexpected';
      if(shape==='object') row.name={nested:'not a SQLite cell'};
      if(shape==='undefined') row.name=undefined;
      if(shape==='nonfinite') row.qty=Infinity;
    }
    return reply;
  }};
  await expect(sync(db,broken)).rejects.toThrow('invalid pulled row');
  expect(await db.all('SELECT * FROM items')).toEqual(before);
  expect(await db.all("SELECT * FROM _core_sync WHERE tbl='items'")).toEqual(state);
  await sync(db,hub);
  expect(await db.all('SELECT name FROM items')).toEqual([{name:'After'}]);
});

test('Python-style schema log inserts replay after their CREATE on a fresh replica', async () => {
  const {db,hub}=setup(); await sync(db,hub);
  const ddl='ALTER TABLE items ADD COLUMN note TEXT';
  await db.run(ddl);
  await db.run('INSERT INTO _schema_log(ddl) VALUES (?)',[ddl]);
  await sync(db,hub);
  const fresh=new TestSql();
  try {
    await sync(fresh,hub);
    expect((await fresh.all('PRAGMA table_info(items)')).some(r=>r.name==='note')).toBe(true);
  } finally {fresh.db.close();}
});

test.each([false,true])('rejected history stays held when its table is skipped (later batch fails: %s)', async failLater => {
  const {db,hub,remote}=setup();
  remote.db.query('INSERT INTO catalog_properties(id,tbl,col,type,required,updated_at,hub_at) VALUES (?,?,?,?,?,?,?)').run('items.name','items','name','text',1,T0,T1);
  remote.db.query('INSERT INTO items(id,name,updated_at,hub_at) VALUES (?,?,?,?)').run('a','Before',T0,T1);
  await sync(db,hub);
  const stamp=new Date(Date.now()+2).toISOString();
  await db.run('UPDATE items SET name=NULL,updated_at=? WHERE id=?',[stamp,'a']);
  await db.run('INSERT INTO history(id,tbl,row_id,col,old,new,origin,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',['held','items','a','name','Before',null,'device',stamp,stamp]);
  if(failLater) for(let i=0;i<200;i++) await db.run('INSERT INTO items(id,name,updated_at) VALUES (?,?,?)',[`z${i}`,'Valid',stamp]);
  let batches=0;
  const interrupted={...hub,async post(route:string,body:any){
    if(route==='/v1/rows/push'&&body.table==='items'&&++batches===2) throw new Error('offline');
    return hub.post(route,body);
  }};
  if(failLater) await expect(sync(db,interrupted)).rejects.toThrow('offline');
  else expect((await sync(db,hub)).rejected).toMatchObject([{table:'items',id:'a'}]);
  const historyState=await db.all("SELECT push FROM _core_sync WHERE tbl='history'");
  await sync(db,hub,{tables:{items:false}});
  expect(remote.db.query('SELECT id FROM history').all()).toEqual([]);
  expect(await db.all("SELECT push FROM _core_sync WHERE tbl='history'")).toEqual(historyState);
  await db.run("UPDATE items SET name='Accepted',updated_at=? WHERE id='a'",[new Date(Date.now()+10).toISOString()]);
  await sync(db,hub);
  await sync(db,hub);
  expect(await db.all('SELECT * FROM _core_rejected')).toEqual([]);
  expect(remote.db.query("SELECT id FROM history WHERE id='held'").all()).toEqual([{id:'held'}]);
});

test('a quiet round asks the hub for its cursor and nothing else', async () => {
  const {db,remote,hub,requests}=setup();
  remote.db.query('INSERT INTO items(id,name,updated_at,hub_at) VALUES (?,?,?,?)').run('a','Hub row',T0,T1);
  await sync(db,hub);
  requests.length=0;
  await sync(db,hub);
  expect(requests.map(r=>r.route)).toEqual(['/v1/cursor']);
});

test('schema entries that appear on the hub or locally between rounds are still exchanged', async () => {
  const {db,remote,hub,requests}=setup();
  await sync(db,hub);
  remote.db.exec("CREATE TABLE later (id TEXT PRIMARY KEY, name TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT)");
  remote.db.query('INSERT INTO _schema_log(applied_at,ddl) VALUES (?,?)').run(T1,'CREATE TABLE later (id TEXT PRIMARY KEY, name TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT)');
  requests.length=0;
  await sync(db,hub);
  expect(requests.map(r=>r.route)).toContain('/v1/schema/pull');
  expect(await db.all("SELECT name FROM sqlite_master WHERE name='later'")).toEqual([{name:'later'}]);
  await db.run('ALTER TABLE items ADD COLUMN note TEXT');
  await db.run('INSERT INTO _schema_log(applied_at,ddl) VALUES (?,?)',[T2,'ALTER TABLE items ADD COLUMN note TEXT']);
  await sync(db,hub);
  expect(remote.db.query("SELECT count(*) AS n FROM _schema_log WHERE ddl LIKE 'ALTER TABLE items ADD COLUMN note%'").get()).toEqual({n:1});
  expect(remote.db.query("PRAGMA table_info(items)").all().some((c:any)=>c.name==='note')).toBe(true);
});

test('table sizes are asked again only daily or for a table the counts never saw', async () => {
  let clock=new Date(T0).getTime();
  const now=()=>new Date(clock);
  const {db,remote,hub,requests}=setup();
  await sync(db,hub,{now});
  clock+=3_600_000;
  requests.length=0;
  await sync(db,hub,{now});
  expect(requests.map(r=>r.route)).not.toContain('/v1/stats');
  clock+=86_400_000;
  await sync(db,hub,{now});
  expect(requests.map(r=>r.route)).toContain('/v1/stats');
  requests.length=0;
  remote.db.exec("CREATE TABLE later (id TEXT PRIMARY KEY, name TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT)");
  remote.db.query('INSERT INTO _schema_log(applied_at,ddl) VALUES (?,?)').run(T1,'CREATE TABLE later (id TEXT PRIMARY KEY, name TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT)');
  await sync(db,hub,{now});
  expect(requests.map(r=>r.route)).toContain('/v1/stats');
});

test('a commit stamped with the same millisecond as the cursor after its read is still pulled', async () => {
  const {db,remote,hub,requests}=setup();
  remote.db.query('INSERT INTO items(id,name,updated_at,hub_at) VALUES (?,?,?,?)').run('a','First',T0,T1);
  await sync(db,hub);
  remote.db.query('INSERT INTO items(id,name,updated_at,hub_at) VALUES (?,?,?,?)').run('b','Same stamp',T0,T1);
  requests.length=0;
  await sync(db,hub);
  expect(requests.map(r=>r.route)).toEqual(['/v1/cursor','/v1/rows/pull']);
  expect(await db.all('SELECT id FROM items ORDER BY id')).toEqual([{id:'a'},{id:'b'}]);
  requests.length=0;
  await sync(db,hub);
  expect(requests.map(r=>r.route)).toEqual(['/v1/cursor']);
});

test('a fresh replica reads the cursor once, after its schema exchange', async () => {
  const {db,hub,requests}=setup();
  await sync(db,hub);
  expect(requests.filter(r=>r.route==='/v1/cursor').length).toBe(1);
  expect(requests.map(r=>r.route).slice(0,2)).toEqual(['/v1/schema/pull','/v1/cursor']);
});


test('fresh replica replays an absent view drop before its replacement', async () => {
  const {db,remote,hub} = setup();
  for (const ddl of ['DROP VIEW "rollup"','CREATE VIEW "rollup" AS SELECT 42 AS total']) {
    remote.db.query('INSERT INTO _schema_log(applied_at,ddl) VALUES (?,?)').run(T1,ddl);
  }
  remote.db.exec('CREATE VIEW "rollup" AS SELECT 42 AS total');
  await sync(db,hub);
  expect(await db.all('SELECT * FROM rollup')).toEqual([{total:42}]);
  await sync(db,hub);
  expect(await db.all("SELECT count(*) AS n FROM _schema_log WHERE ddl LIKE '%rollup%'")).toEqual([{n:2}]);
});
