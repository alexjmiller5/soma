import { expect, test } from 'bun:test';
import { D1Shim } from './d1shim.js';
import { LimitedD1 } from './limited-d1.js';
import { ScopeDenied } from '../src/scopes.js';
import contract from '../../tests/fixtures/hub-subscriptions-contract.json';
import { createSubscription } from '../src/subscriptions.js';
import { subscriptionTriggers, trustedSubscriptionTrigger } from '../src/subscription-triggers.js';
import worker, { ROUTES, authenticate } from '../src/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const time = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
function database(path=':memory:') {
  const db=new D1Shim(path);
  db.db.exec(`CREATE TABLE catalog_tables(id TEXT PRIMARY KEY,kind TEXT,deleted_at TEXT);
    CREATE TABLE catalog_properties(id TEXT PRIMARY KEY,tbl TEXT,col TEXT,type TEXT,sort INTEGER,options TEXT,options_sql TEXT,derived_by TEXT,inputs TEXT,deleted_at TEXT);
    CREATE TABLE articles(id TEXT PRIMARY KEY,url TEXT,alternate TEXT,created_at TEXT DEFAULT (${time}),updated_at TEXT,deleted_at TEXT,hub_at TEXT);
    INSERT INTO catalog_tables VALUES ('articles','table',NULL);
    INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('articles.url','articles','url','url'),('articles.alternate','articles','alternate','url');`);
  return db;
}
const config = {label:'Capture fixture',sources:[{table:'articles',columns:['url','alternate']}],start:'now'};
const rows = (db,id) => db.db.query('SELECT CAST(seq AS TEXT) AS seq,event_id,recorded_at,payload_json FROM _change_events WHERE subscription_id=? ORDER BY seq').all(id).map(r=>({...JSON.parse(r.payload_json),id:r.event_id,seq:r.seq,recorded_at:r.recorded_at}));
const write = (db,values) => ROUTES['/v1/rows/push']({table:'articles',columns:Object.keys(values),rows:[values]},db);
const change = (id,url,second=0,extra={}) => ({id,url,updated_at:`2026-10-03T00:00:${String(second).padStart(2,'0')}.000Z`,...extra});

test('scalar subscriptions retain numeric checkbox and real values through toggles',async()=>{
  const db=database();
  db.db.exec('ALTER TABLE articles ADD COLUMN flag INTEGER; ALTER TABLE articles ADD COLUMN score REAL');
  const sub=await createSubscription(db,{...config,sources:[{table:'articles',columns:['flag','score']}]});
  db.db.exec("INSERT INTO articles(id,flag,score) VALUES ('a',0,1.5); UPDATE articles SET flag=1,score=2.25; UPDATE articles SET flag=0; UPDATE articles SET flag=0");
  expect(rows(db,sub.id).map(e=>e.changes)).toEqual([
    [{column:'flag',old_value:null,new_value:0},{column:'score',old_value:null,new_value:1.5}],
    [{column:'flag',old_value:0,new_value:1},{column:'score',old_value:1.5,new_value:2.25}],
    [{column:'flag',old_value:1,new_value:0}],
  ]);
});

test('opt-in lifecycle events include all-null rows, logical restore and physical delete',async()=>{
  const db=database(),sub=await createSubscription(db,{...config,sources:[{...config.sources[0],lifecycle:true}]});
  expect(sub.sources[0].lifecycle).toBe(true);
  db.db.exec("INSERT INTO articles(id) VALUES ('a'); UPDATE articles SET updated_at='changed'; UPDATE articles SET deleted_at='deleted'; UPDATE articles SET deleted_at=NULL; DELETE FROM articles");
  expect(rows(db,sub.id).map(e=>[e.operation,e.changes])).toEqual([
    ['insert',[]],['delete',[]],['restore',[]],['delete',[]],
  ]);
  db.db.exec("INSERT INTO articles(id,deleted_at) VALUES ('dead','deleted'); UPDATE articles SET updated_at='changed'; DELETE FROM articles");
  expect(rows(db,sub.id)).toHaveLength(4);
  const stored=JSON.parse(db.db.query('SELECT trigger_sources_json FROM _change_subscriptions WHERE id=?').get(sub.id).trigger_sources_json);
  expect(stored[0]).toMatchObject({version:3,lifecycle:true});
});

test('default and explicit false subscriptions retain legacy null and restore behavior',async()=>{
  const db=database(),legacy=await createSubscription(db,config);
  const disabled=await createSubscription(db,{...config,sources:[{...config.sources[0],lifecycle:false}]});
  db.db.exec("INSERT INTO articles(id) VALUES ('a'); UPDATE articles SET deleted_at='deleted'; UPDATE articles SET deleted_at=NULL; DELETE FROM articles");
  expect(rows(db,legacy.id)).toEqual([]);expect(rows(db,disabled.id)).toEqual([]);
  db.db.exec("INSERT INTO articles(id,url) VALUES ('a','https://example.test/a'); UPDATE articles SET deleted_at='deleted'; UPDATE articles SET deleted_at=NULL; DELETE FROM articles");
  for(const sub of [legacy,disabled])expect(rows(db,sub.id).map(e=>e.operation)).toEqual(['insert','delete','update','delete']);
});

test('persisted legacy trigger SQL remains byte-for-byte compatible and trusted',async()=>{
  const db=database(),sub=await createSubscription(db,config);
  const sources=[{table:'articles',columns:['url','alternate'],hasClock:false,hasHubAt:true}];
  const fixedId='11111111-1111-4111-8111-111111111111';
  expect(subscriptionTriggers(fixedId,sources).map(t=>new Bun.CryptoHasher('sha256').update(t.sql).digest('hex'))).toEqual([
    '6faeb240a8a4848034e4ed26cbda4bb566a311a088e49ea6d3b903f3ac845066',
    '991d77b94da64c7401713d3df8cacc2b810a5fd4b6b1a07ba4253ddb29d177da',
    '646d79a2d365db0d140f4df2391c38d2085290059535d1fe243e46e65d450333',
  ]);
  db.db.query('UPDATE _change_subscriptions SET trigger_sources_json=? WHERE id=?').run(JSON.stringify(sources),sub.id);
  for(const t of subscriptionTriggers(sub.id,sources)){
    db.db.exec(`DROP TRIGGER "${t.name}"; ${t.sql}`);
    expect(await trustedSubscriptionTrigger(db,{...t,tbl_name:t.table})).toBe(true);
  }
  await write(db,change('a','https://example.test/a',1));
  expect(rows(db,sub.id)).toHaveLength(1);
});

test('unsupported scalar selectors and malformed lifecycle settings cannot activate recording',async()=>{
  for(const ddl of ['ALTER TABLE articles ADD COLUMN payload BLOB','ALTER TABLE articles ADD COLUMN payload TEXT GENERATED ALWAYS AS (url) VIRTUAL']){
    const db=database();db.db.exec(ddl);
    await expect(createSubscription(db,{...config,sources:[{table:'articles',columns:['payload']}]})).rejects.toThrow();
  }
  for(const lifecycle of ['true',1,null]){
    const db=database();
    await expect(createSubscription(db,{...config,sources:[{...config.sources[0],lifecycle}]})).rejects.toThrow();
  }
});

test('versioned lifecycle triggers allow narrow edits but changed SQL is rejected',async()=>{
  const db=database(),{call,mint}=await api(db);
  const res=await call('/v1/subscriptions',{method:'POST',body:{...config,sources:[{...config.sources[0],lifecycle:true}]}});
  expect(res.status).toBe(201);const sub=await res.json();
  const token=await mint(['tables:write:articles'],'writer');
  db.db.exec("INSERT INTO articles(id,updated_at,hub_at) VALUES ('a','2026-10-03T00:00:00.000Z','2026-10-03T00:00:00.000Z')");
  const body={table:'articles',id:'a',values:{url:'https://example.test/a'},expected_revision:{updated_at:'2026-10-03T00:00:00.000Z',hub_at:'2026-10-03T00:00:00.000Z'}};
  expect((await call('/v1/rows/patch',{method:'POST',body,token})).status).toBe(200);
  expect(rows(db,sub.id).map(e=>e.operation)).toEqual(['insert','update']);
  const trigger=db.db.query("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name=?").get(`_change_${sub.id.replaceAll('-','')}_0_update`);
  db.db.exec(`DROP TRIGGER "${trigger.name}"; ${trigger.sql.replace('last_seq=last_seq+1','last_seq=last_seq+2')}`);
  body.expected_revision=db.db.query("SELECT updated_at,hub_at FROM articles WHERE id='a'").get();
  body.values.url='https://example.test/b';
  expect((await call('/v1/rows/patch',{method:'POST',body,token})).status).toBe(403);
  expect(db.db.query("SELECT url FROM articles WHERE id='a'").get().url).toBe('https://example.test/a');
});

test('sessions advertise scalar lifecycle events separately from the delivery protocol',async()=>{
  const {call}=await api();
  const session=await call('/v1/session');
  expect((await session.json()).capabilities.subscription_features).toBe('scalar-lifecycle-v1');
});

test('activation records only subsequent accepted changes, including fast A-to-B and deletes',async()=>{
  const db=database();await write(db,change('existing','https://example.test/existing'));
  const sub=await createSubscription(db,config);
  expect(sub).toMatchObject({protocol:'durable-pull-v1',state:'active',acked_seq:'0',sources:config.sources});
  expect(rows(db,sub.id)).toEqual([]);
  await write(db,change('a','https://example.test/a',1));
  await write(db,change('a','https://example.test/b',2));
  await write(db,change('a','https://example.test/b',3,{deleted_at:'2026-10-03T00:00:03.000Z'}));
  const events=rows(db,sub.id);
  expect(events.map(e=>[e.seq,e.operation,e.changes])).toEqual([
    ['1','insert',[{column:'url',old_value:null,new_value:'https://example.test/a'}]],
    ['2','update',[{column:'url',old_value:'https://example.test/a',new_value:'https://example.test/b'}]],
    ['3','delete',[{column:'url',old_value:'https://example.test/b',new_value:null}]],
  ]);
  expect(new Set(events.map(e=>e.id)).size).toBe(3);
  expect(events[0].source.before_revision).toBeNull();
  expect(events[1].source.before_revision.updated_at).toBe('2026-10-03T00:00:01.000Z');
  expect(events[2].source.after_revision).toBeNull();
});

test('stale/noop/timestamp churn and rejected mutations never enqueue events',async()=>{
  const db=database(),sub=await createSubscription(db,config);
  await write(db,change('a','https://example.test/a',1));
  await write(db,change('a','https://example.test/a',2));
  await write(db,change('a','https://example.test/stale',0));
  await write(db,change('a','not-a-url',3));
  expect(rows(db,sub.id)).toHaveLength(1);
  expect(db.db.query("SELECT url FROM articles WHERE id='a'").get().url).toBe('https://example.test/a');
});

test('transaction rollback rolls back the sequence and event, including nested timestamp triggers',async()=>{
  const db=database(),sub=await createSubscription(db,config);
  db.db.exec(`CREATE TRIGGER articles_clock AFTER UPDATE ON articles WHEN OLD.updated_at=NEW.updated_at BEGIN UPDATE articles SET updated_at=(${time}) WHERE id=NEW.id; END`);
  await write(db,change('a','https://example.test/a',1));
  await db.prepare("UPDATE articles SET url='https://example.test/b' WHERE id='a'").run();
  expect(rows(db,sub.id)).toHaveLength(2);
  await expect(db.batch([db.prepare("UPDATE articles SET url='https://example.test/c' WHERE id='a'"),db.prepare('INSERT INTO missing VALUES (1)')])).rejects.toThrow();
  expect(rows(db,sub.id)).toHaveLength(2);
  expect(db.db.query('SELECT last_seq FROM _change_subscriptions').get().last_seq).toBe(2);
  await db.prepare("DELETE FROM articles WHERE id='a'").run();
  expect(rows(db,sub.id).at(-1).operation).toBe('delete');
});

test('subscriptions have independent sequences; paused records, retired stops',async()=>{
  const db=database(),first=await createSubscription(db,config);
  await write(db,change('a','https://example.test/a',1));
  const second=await createSubscription(db,{...config,sources:[{table:'articles',columns:['alternate']}]});
  db.db.exec(`UPDATE _change_subscriptions SET state='paused' WHERE id='${first.id}'`);
  await write(db,change('a','https://example.test/b',2,{alternate:'https://example.test/alt'}));
  expect(rows(db,first.id).map(e=>e.seq)).toEqual(['1','2']);
  expect(rows(db,second.id).map(e=>e.seq)).toEqual(['1']);
  db.db.exec(`UPDATE _change_subscriptions SET state='retired' WHERE id='${first.id}'`);
  await write(db,change('a','https://example.test/c',3));
  expect(rows(db,first.id)).toHaveLength(2);
});

test('capacity and oversize events reject the mutation without sequence gaps',async()=>{
  const db=database(),sub=await createSubscription(db,{...config,max_pending_events:1});
  await write(db,change('a','https://example.test/a',1));
  const result=await write(db,change('a','https://example.test/b',2));
  expect(result.upserted).toBe(0);
  expect(result.rejected[0]).toMatchObject({rule:'outbox-capacity',retryable:true});
  expect(rows(db,sub.id)).toHaveLength(1);
  expect(db.db.query("SELECT url FROM articles WHERE id='a'").get().url).toBe('https://example.test/a');
  const other=database();await createSubscription(other,config);
  const large=await write(other,change('a','https://example.test/'+ 'x'.repeat(1_048_576),1));
  expect(large.rejected[0].rule).toBe('outbox-event-size');
  expect(other.db.query('SELECT count(*) AS n FROM articles').get().n).toBe(0);
});

test('accepted derivations record values and the exact committed source revision',async()=>{
  const {deriveRows}=await import('../src/derive.js');
  const db=database();
  db.db.exec(`CREATE TABLE provenance(id TEXT PRIMARY KEY,to_kind TEXT,to_ref TEXT,field TEXT,from_kind TEXT,from_ref TEXT,rel TEXT,detail TEXT,asserted_by TEXT,inputs_hash TEXT,value_hash TEXT,produced_at TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT);
    INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('articles.id','articles','id','text');
    UPDATE catalog_properties SET derived_by='http:fixture',inputs='["id"]' WHERE id='articles.url';
    INSERT INTO articles(id,updated_at) VALUES ('a','2026-10-03T00:00:00.000Z');`);
  const sub=await createSubscription(db,config);
  const out=await deriveRows(db,{DERIVATIONS:JSON.stringify({fixture:{url:'https://derive.example.test/'}})},'articles',['a'],{
    fetchImpl:async()=>Response.json({url:'https://example.test/derived'}),
  });
  expect(out).toEqual({derived:1,failed:[]});
  const [event]=rows(db,sub.id),actual=db.db.query("SELECT updated_at,hub_at FROM articles WHERE id='a'").get();
  expect(event.changes).toEqual([{column:'url',old_value:null,new_value:'https://example.test/derived'}]);
  expect(event.source.after_revision).toEqual(actual);
});

test('schema replay cannot silently drop or change watched tables or their recording triggers',async()=>{
  const db=database();db.db.exec('CREATE TABLE _schema_log(id INTEGER PRIMARY KEY,applied_at TEXT,ddl TEXT)');
  const sub=await createSubscription(db,config);
  const {name}=db.db.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '%_insert'").get();
  for(const ddl of ['DROP TABLE articles','ALTER TABLE articles RENAME COLUMN url TO different',`DROP TRIGGER "${name}"`]) {
    const response=await ROUTES['/v1/schema/push']({entries:[{applied_at:'2026-10-03T00:00:00.000Z',ddl}]},db);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('subscription_schema_conflict');
  }
  const out=await ROUTES['/v1/schema/push']({entries:[{applied_at:'2026-10-03T00:00:00.000Z',ddl:'CREATE TABLE unrelated(id TEXT PRIMARY KEY)'}]},db);
  expect(out.applied).toBe(1);
  await write(db,change('a','https://example.test/a',1));
  expect(rows(db,sub.id)).toHaveLength(1);
});

test.each(['active','paused'])('schema replay adds nullable fields without interrupting watched URL changes (%s)',async state=>{
  const db=database();db.db.exec('CREATE TABLE _schema_log(id INTEGER PRIMARY KEY,applied_at TEXT,ddl TEXT)');
  const sub=await createSubscription(db,config);
  db.db.query('UPDATE _change_subscriptions SET state=? WHERE id=?').run(state,sub.id);
  await write(db,change('a','https://example.test/a',1));
  const before=rows(db,sub.id);
  for(const ddl of ['ALTER TABLE articles ADD COLUMN decision TEXT','alter table "articles" add "rating" INTEGER;']) {
    const result=await ROUTES['/v1/schema/push']({entries:[{applied_at:'2026-10-03T00:00:00.000Z',ddl}]},db);
    expect(result.applied).toBe(1);
  }
  expect(db.db.query("SELECT decision,rating FROM articles WHERE id='a'").get()).toEqual({decision:null,rating:null});
  await write(db,change('a','https://example.test/a',2,{decision:'Consider'}));
  expect(rows(db,sub.id)).toEqual(before);
  await write(db,change('a','https://example.test/b',3));
  expect(rows(db,sub.id).map(e=>e.changes)).toEqual([
    [{column:'url',old_value:null,new_value:'https://example.test/a'}],
    [{column:'url',old_value:'https://example.test/a',new_value:'https://example.test/b'}],
  ]);
  for(const ddl of ['ALTER TABLE articles ADD COLUMN constrained TEXT CHECK (url IS NOT NULL)','ALTER TABLE articles ADD COLUMN required TEXT NOT NULL DEFAULT \'\'','ALTER TABLE _change_events ADD COLUMN extra TEXT']) {
    const response=await ROUTES['/v1/schema/push']({entries:[{applied_at:'2026-10-03T00:00:00.000Z',ddl}]},db);
    expect(response.status).toBe(409);
  }
});

test.each(['hub_at','rowid','_rowid_','oid'])('schema replay cannot add revision-sensitive field %s to a watched source',async column=>{
  const db=database();
  db.db.exec('ALTER TABLE articles DROP COLUMN hub_at; CREATE TABLE _schema_log(id INTEGER PRIMARY KEY,applied_at TEXT,ddl TEXT)');
  db.db.exec(canonicalClock);
  await createSubscription(db,config);
  const response=await ROUTES['/v1/schema/push']({entries:[{applied_at:'2026-10-03T00:00:00.000Z',ddl:`ALTER TABLE articles ADD COLUMN "${column.toUpperCase()}" TEXT`}]},db);
  expect(response.status).toBe(409);
  expect(db.db.query('PRAGMA table_info(articles)').all().some(c=>c.name.toLowerCase()===column)).toBe(false);
});

test('a source wider than D1 compound SELECT terms activates and records every column',async()=>{
  const db=new LimitedD1(),cols=['a','b','c','d','e','f','g'];
  try {
    for(const sql of [
      'CREATE TABLE catalog_tables(id TEXT PRIMARY KEY,kind TEXT,deleted_at TEXT)',
      'CREATE TABLE catalog_properties(id TEXT PRIMARY KEY,tbl TEXT,col TEXT,type TEXT,sort INTEGER,options TEXT,options_sql TEXT,derived_by TEXT,inputs TEXT,deleted_at TEXT)',
      `CREATE TABLE wide(id TEXT PRIMARY KEY,${cols.map(c=>c+' TEXT').join(',')},created_at TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT)`,
      "INSERT INTO catalog_tables VALUES ('wide','table',NULL)",
      ...cols.map(c=>`INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('wide.${c}','wide','${c}','text')`),
    ])await db.prepare(sql).run();
    const sub=await createSubscription(db,{label:'Wide',start:'now',sources:[{table:'wide',columns:cols,lifecycle:true}]});
    await db.prepare(`INSERT INTO wide(id,${cols.join(',')}) VALUES ('w',${cols.map((_,i)=>`'${i+1}'`).join(',')})`).run();
    await db.prepare("UPDATE wide SET g='8'").run();
    await db.prepare("UPDATE wide SET updated_at='x'").run();
    const events=(await db.prepare('SELECT payload_json FROM _change_events WHERE subscription_id=? ORDER BY seq').bind(sub.id).all()).results.map(r=>JSON.parse(r.payload_json));
    expect(events.map(e=>[e.operation,e.changes])).toEqual([
      ['insert',cols.map((column,i)=>({column,old_value:null,new_value:String(i+1)}))],
      ['update',[{column:'g',old_value:'7',new_value:'8'}]],
    ]);
  } finally {await db.close();}
});

test('version 2 lifecycle trigger SQL stays byte-for-byte compatible',async()=>{
  const sources=[{table:'articles',columns:['url','alternate'],lifecycle:true,version:2,hasClock:false,hasHubAt:true}];
  expect(subscriptionTriggers('11111111-1111-4111-8111-111111111111',sources).map(t=>t.sql).join('\n')).not.toContain('json_each');
  expect(subscriptionTriggers('11111111-1111-4111-8111-111111111111',sources).map(t=>t.sql).join('\n')).toContain('UNION ALL');
});

test('multi-column changes, empty URLs and restoration preserve exact accepted values',async()=>{
  const db=database(),sub=await createSubscription(db,config);
  await write(db,change('a','https://example.test/a',1,{alternate:'https://example.test/alt'}));
  await write(db,change('a','',2,{alternate:null}));
  expect(rows(db,sub.id).at(-1).changes).toEqual([
    {column:'url',old_value:'https://example.test/a',new_value:''},
    {column:'alternate',old_value:'https://example.test/alt',new_value:null},
  ]);
  await write(db,change('a','https://example.test/restored',3,{deleted_at:'2026-10-03T00:00:03.000Z'}));
  await write(db,change('a','https://example.test/restored',4,{deleted_at:null}));
  expect(rows(db,sub.id).at(-1).changes).toEqual([{column:'url',old_value:null,new_value:'https://example.test/restored'}]);
});

test('invalid selector activation leaves no subscription or recording triggers',async()=>{
  const db=database();
  for(const bad of [{...config,start:'all'},{...config,sources:[{table:'articles',columns:['missing']}]},{...config,sources:[{table:'articles',columns:['updated_at']}]},{...config,max_pending_events:0}]) {
    await expect(createSubscription(db,bad)).rejects.toThrow();
  }
  expect(db.db.query('SELECT count(*) AS n FROM _change_subscriptions').get().n).toBe(0);
  expect(db.db.query("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger'").get().n).toBe(0);
});

function serializeBatches(db) {
  // A D1 binding serializes transactions. The in-memory shim's async statement
  // methods otherwise yield while its single SQLite connection has BEGIN open.
  const batch=db.batch.bind(db);let tail=Promise.resolve();
  db.batch=statements=>{const result=tail.then(()=>batch(statements));tail=result.catch(()=>{});return result;};
  return db;
}
async function api(db=database()) {
  const env={HUB_TOKEN:'operator-fixture',DB:serializeBatches(db),AUTH_DB:new D1Shim()};
  const ctx={waitUntil(){}};
  const call=(path,{method='GET',body,token='operator-fixture',signal}={})=>worker.fetch(new Request(`https://hub.test${path}`,{
    method,body:body===undefined?undefined:JSON.stringify(body),signal,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
  }),env,ctx);
  const created=await call('/v1/subscriptions',{method:'POST',body:config});
  expect(created.status).toBe(201);
  const sub=await created.json();
  const mint=async(scopes,name='consumer-fixture')=>{
    const response=await call('/v1/tokens/create',{method:'POST',body:{name,scopes:scopes.join(',')}});
    return (await response.json()).token;
  };
  const token=await mint([`subscriptions:consume:${sub.id}`,'tables:read:articles']);
  const tenant=()=>authenticate(new Request('https://hub.test/v1/session',{headers:{Authorization:`Bearer ${token}`}}),env,ctx);
  const path=`/v1/subscriptions/${sub.id}`;
  return {env,call,sub,token,mint,tenant,path};
}

test('offered batches survive repeated and competing GETs; ACK alone advances and repeated ACK is idempotent',async()=>{
  const {env,call,sub,token,path}=await api();
  await write(env.DB,change('a','https://example.test/a',1));
  const responses=await Promise.all([call(path+'/events?wait=0',{token}),call(path+'/events?wait=0',{token})]);
  const [first,second]=await Promise.all(responses.map(r=>r.json()));
  expect(first).toEqual(second);
  expect(first).toMatchObject({subscription_id:sub.id,through_seq:'1'});
  expect(first.events).toHaveLength(1);
  expect(responses[0].headers.get('Cache-Control')).toBe('no-store');
  await write(env.DB,change('a','https://example.test/b',2));
  expect(await (await call(path+'/events?wait=0',{token})).json()).toEqual(first);
  expect(env.DB.db.query('SELECT acked_seq FROM _change_subscriptions').get().acked_seq).toBe(0);
  for(let i=0;i<2;i++) expect(await (await call(path+'/ack',{method:'POST',body:{delivery_id:first.delivery_id},token})).json()).toEqual({acked_seq:'1'});
  expect((await call(path+'/ack',{method:'POST',body:{delivery_id:'forged'},token})).status).toBe(409);
  expect((await call(path+'/ack',{method:'POST',body:{delivery_id:first.delivery_id,through_seq:'2'},token})).status).toBe(400);
  const next=await (await call(path+'/events?wait=0',{token})).json();
  expect(next.events[0].seq).toBe('2');
  expect(next.delivery_id).not.toBe(first.delivery_id);
});

test('delivery receipt persists after reopening the data database',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'hub-subscriptions-')),file=join(directory,'data.db');
  let env;
  try {
    const a=await api(database(file));env=a.env;
    await write(env.DB,change('a','https://example.test/a',1));
    const offered=await (await a.call(a.path+'/events?wait=0',{token:a.token})).json();
    env.DB.db.close();env.DB=serializeBatches(new D1Shim(file));
    expect(await (await a.call(a.path+'/events?wait=0',{token:a.token})).json()).toEqual(offered);
  } finally {env?.DB.db.close();env?.AUTH_DB.db.close();rmSync(directory,{recursive:true});}
});

test('subscription permission and all source grants are required; full alone cannot administer',async()=>{
  const {call,path,mint}=await api();
  for(const scopes of [['full'],['tables:read:articles'],[`subscriptions:consume:${path.split('/').at(-1)}`],['subscriptions:consume:unknown','tables:read:articles']]) {
    const token=await mint(scopes,`consumer-${scopes.join(':')}`);
    for(const target of [path,path+'/events?wait=0','/v1/subscriptions/00000000-0000-4000-8000-000000000000/events?wait=0']) {
      const response=await call(target,{token});expect(response.status).toBe(403);expect(await response.json()).toEqual({error:'insufficient scope'});
    }
    expect((await call('/v1/subscriptions',{method:'POST',body:config,token})).status).toBe(403);
  }
});

test('long poll wakes on a committed event, holds at most 30s, and rechecks revocation',async()=>{
  const {pollEvents}=await import('../src/subscriptions.js');
  const a=await api();let now=0,sleeps=0;
  const empty=await pollEvents(await a.tenant(),a.sub.id,30,{now:()=>now,sleep:async ms=>{now+=ms;sleeps++;}});
  expect(await empty.json()).toEqual({subscription_id:a.sub.id,delivery_id:null,through_seq:'0',events:[]});
  expect(now).toBe(30_000);expect(sleeps).toBe(30);
  now=0;
  const ready=await pollEvents(await a.tenant(),a.sub.id,30,{now:()=>now,sleep:async ms=>{now+=ms;await write(a.env.DB,change('a','https://example.test/a',1));}});
  expect((await ready.json()).events).toHaveLength(1);expect(now).toBe(1000);
  const b=await api();now=0;
  const tenant=await b.tenant();
  await expect(pollEvents(tenant,b.sub.id,30,{now:()=>now,sleep:async ms=>{
    now+=ms;await write(b.env.DB,change('a','https://example.test/private',1));
    await b.env.AUTH_DB.prepare("UPDATE _tokens SET revoked_at='revoked'").run();
  }})).rejects.toBeInstanceOf(ScopeDenied);
  const denied=await b.call(b.path+'/events?wait=0',{token:b.token});
  expect(denied.status).toBe(403);expect(await denied.text()).not.toContain('private');
  expect(b.env.DB.db.query('SELECT acked_seq FROM _change_subscriptions').get().acked_seq).toBe(0);
});

test('a commit between the D1 check and the change-signal wait wakes the poll at once; a failed signal falls back to polling',async()=>{
  const {pollEvents}=await import('../src/subscriptions.js');
  const {ChangeSignal,changeWaiter,withChangeSignal}=await import('../src/changes.js');
  const a=await api(),tenant=await a.tenant(),data=new Map(),loading=[];
  const signal=new ChangeSignal({storage:{get:async k=>data.get(k),put:async(k,v)=>void data.set(k,v)},blockConcurrencyWhile:fn=>loading.push(fn()),getWebSockets:()=>[]});
  await Promise.all(loading);
  let checked=false,committed=false;const prepare=a.env.DB.prepare.bind(a.env.DB);
  a.env.DB.prepare=sql=>{if(/FROM _change_events e/.test(sql))checked=true;return prepare(sql);};
  const pending=[],env={CHANGES:{idFromName:n=>n,get:()=>({fetch:(url,init)=>signal.fetch(new Request(url,init))})}};
  const started=Date.now();
  const response=await withChangeSignal(env,{waitUntil:p=>pending.push(p)},()=>{
    const real=changeWaiter();
    // The commit (and its bump) lands after the first check, before any later signal read.
    return pollEvents(tenant,a.sub.id,5,{changes:async(...args)=>{
      if(checked && !committed){committed=true;await write(a.env.DB,change('a','https://example.test/a',1));await Promise.all(pending);}
      return real(...args);
    }});
  });
  expect((await response.json()).events).toHaveLength(1);
  expect(Date.now()-started).toBeLessThan(2000);
  const b=await api();let now=0,sleeps=0;
  const fallback=await pollEvents(await b.tenant(),b.sub.id,30,{now:()=>now,sleep:async ms=>{now+=ms;sleeps++;},changes:async()=>{throw new Error('down');}});
  expect((await fallback.json()).events).toEqual([]);expect(now).toBe(30_000);expect(sleeps).toBe(30);
});

test('pause retains recording and offered delivery; retirement preserves pending work and releases schema guard',async()=>{
  const a=await api();await write(a.env.DB,change('a','https://example.test/a',1));
  const offered=await (await a.call(a.path+'/events?wait=0',{token:a.token})).json();
  expect((await a.call(a.path,{method:'PATCH',body:{state:'paused'}})).status).toBe(200);
  await write(a.env.DB,change('a','https://example.test/b',2));
  expect((await (await a.call(a.path+'/events?wait=0',{token:a.token})).json()).events).toEqual([]);
  await a.call(a.path,{method:'PATCH',body:{state:'active'}});
  expect(await (await a.call(a.path+'/events?wait=0',{token:a.token})).json()).toEqual(offered);
  await a.call(a.path,{method:'PATCH',body:{state:'retired'}});
  await write(a.env.DB,change('a','https://example.test/c',3));
  expect(rows(a.env.DB,a.sub.id)).toHaveLength(2);
  expect((await (await a.call(a.path+'/events?wait=0',{token:a.token})).json()).delivery_id).toBe(offered.delivery_id);
  expect((await a.call(a.path,{method:'PATCH',body:{state:'active'}})).status).toBe(409);
});

test('delivery obeys event count and byte bounds, and preserves sequences beyond JS precision',async()=>{
  const a=await api();
  a.env.DB.db.exec("UPDATE _change_subscriptions SET last_seq=9007199254740992,acked_seq=9007199254740992");
  for(let i=0;i<102;i++) await write(a.env.DB,change(`r${i}`,'https://example.test/'+ 'x'.repeat(14000),1));
  const response=await a.call(a.path+'/events?wait=0',{token:a.token}),text=await response.text(),data=JSON.parse(text);
  expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(1_048_576);
  expect(data.events.length).toBeGreaterThan(0);expect(data.events.length).toBeLessThan(100);
  expect(data.events[0].seq).toBe('9007199254740993');
  expect((await a.call(a.path+'/events?wait=31',{token:a.token})).status).toBe(400);
  expect((await a.call(a.path+'/events?wait=1.2',{token:a.token})).status).toBe(400);
});


test('a removed source grant and a disconnected caller cannot release or ACK events',async()=>{
  const {pollEvents}=await import('../src/subscriptions.js');
  for(const disconnect of [false,true]) {
    const a=await api(),tenant=await a.tenant(),controller=new AbortController();let now=0;
    await expect(pollEvents(tenant,a.sub.id,30,{now:()=>now,signal:controller.signal,sleep:async ms=>{
      now+=ms;await write(a.env.DB,change('a','https://example.test/private',1));
      if(disconnect) controller.abort();
      else await a.env.AUTH_DB.prepare('UPDATE _tokens SET scopes=?').bind(`subscriptions:consume:${a.sub.id}`).run();
    }})).rejects.toThrow(disconnect?'request_cancelled':'insufficient scope');
    expect(a.env.DB.db.query('SELECT acked_seq,pending_event_count FROM _change_subscriptions').get()).toEqual({acked_seq:0,pending_event_count:1});
  }
});

test('100-event boundary, ACK capacity recovery and old receipts never skip the next batch',async()=>{
  const a=await api();a.env.DB.db.exec('UPDATE _change_subscriptions SET max_pending_events=101');
  for(let i=0;i<101;i++) await write(a.env.DB,change(`r${i}`,`https://example.test/${i}`,1));
  const first=await (await a.call(a.path+'/events?wait=0',{token:a.token})).json();
  expect(first.events).toHaveLength(contract.limits.events_per_delivery);
  expect(first.through_seq).toBe('100');
  const ack=delivery_id=>a.call(a.path+'/ack',{method:'POST',body:{delivery_id},token:a.token});
  expect(await (await ack(first.delivery_id)).json()).toEqual({acked_seq:'100'});
  expect(a.env.DB.db.query('SELECT pending_event_count FROM _change_subscriptions').get().pending_event_count).toBe(1);
  const second=await (await a.call(a.path+'/events?wait=0',{token:a.token})).json();
  expect(await (await ack(first.delivery_id)).json()).toEqual({acked_seq:'100'});
  expect(await (await a.call(a.path+'/events?wait=0',{token:a.token})).json()).toEqual(second);
  expect(await (await ack(second.delivery_id)).json()).toEqual({acked_seq:'101'});
  expect((await ack(first.delivery_id)).status).toBe(409);
  expect(a.env.DB.db.query('SELECT pending_event_count,pending_byte_count FROM _change_subscriptions').get()).toEqual({pending_event_count:0,pending_byte_count:0});
  expect((await write(a.env.DB,change('new','https://example.test/new',1))).upserted).toBe(1);
});

test('retired empty polls retain the requested wait and do not cause a hot retry loop',async()=>{
  const a=await api();await a.call(a.path,{method:'PATCH',body:{state:'retired'}});
  const {pollEvents}=await import('../src/subscriptions.js');let now=0;
  const response=await pollEvents(await a.tenant(),a.sub.id,30,{now:()=>now,sleep:async ms=>{now+=ms;}});
  expect(now).toBe(30000);expect((await response.json()).events).toEqual([]);
});

test('request limits and immutable selectors fail without changing delivery state',async()=>{
  const a=await api();
  expect((await a.call(a.path,{method:'PATCH',body:{sources:[]}})).status).toBe(400);
  expect((await a.call(a.path+'/ack',{method:'POST',body:{delivery_id:'x'.repeat(5000)},token:a.token})).status).toBe(413);
  expect((await a.call('/v1/subscriptions',{method:'POST',body:{...config,label:'x'.repeat(1_048_576)}})).status).toBe(413);
  expect((await a.call(a.path+'/events?wait=0&wait=1',{token:a.token})).status).toBe(400);
  expect((await a.call(a.path,{method:'PATCH',body:{state:'paused'},token:a.token})).status).toBe(403);
});


test('held polls stay within D1 query budget and do not repeatedly write token activity',async()=>{
  const a=await api();let queries=0,activityWrites=0,now=0;
  for(const db of [a.env.DB,a.env.AUTH_DB]) {
    const prepare=db.prepare.bind(db);db.prepare=sql=>{
      queries++;if(/UPDATE _tokens SET last_used/.test(sql)) activityWrites++;
      return prepare(sql);
    };
  }
  const {pollEvents}=await import('../src/subscriptions.js');
  await pollEvents(await a.tenant(),a.sub.id,30,{now:()=>now,sleep:async ms=>{now+=ms;}});
  expect(queries).toBeLessThan(1000);expect(activityWrites).toBeLessThanOrEqual(1);
});

const canonicalClock = `CREATE TRIGGER "articles_updated_at" AFTER UPDATE ON "articles" FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE "articles" SET updated_at = (${time}) WHERE rowid = NEW.rowid; END`;
for(const clockLast of [false,true]) test(`canonical clock revisions agree with the committed row in either trigger order: ${clockLast}`,async()=>{
  const db=database();db.db.exec(canonicalClock);
  const sub=await createSubscription(db,config);
  if(clockLast) db.db.exec('DROP TRIGGER articles_updated_at;'+canonicalClock);
  await write(db,change('a','https://example.test/a',1));
  await db.prepare("UPDATE articles SET url='https://example.test/b' WHERE id='a'").run();
  const events=rows(db,sub.id),actual=db.db.query("SELECT updated_at,hub_at FROM articles WHERE id='a'").get();
  expect(events).toHaveLength(2);expect(events[1].source.after_revision).toEqual(actual);
  expect(events[1].source.before_revision.updated_at).toBe('2026-10-03T00:00:01.000Z');
});

test('activation refuses custom source triggers and schema replay cannot add them later',async()=>{
  const {applySubscriptionSchema}=await import('../src/subscriptions.js');
  const custom="CREATE TRIGGER normalize_url AFTER UPDATE ON articles WHEN NEW.url='https://example.test/b' BEGIN UPDATE articles SET url='https://example.test/c' WHERE id=NEW.id; END";
  const before=database();before.db.exec(custom);
  await expect(createSubscription(before,config)).rejects.toThrow('invalid subscription');
  const after=database();await createSubscription(after,config);
  for(const ddl of [custom,canonicalClock,"CREATE TRIGGER outbox_override AFTER INSERT ON _change_events BEGIN DELETE FROM _change_events; END"]) {
    await expect(applySubscriptionSchema(after,ddl)).rejects.toMatchObject({code:'subscription-schema-conflict'});
  }
  expect(after.db.query("SELECT name FROM sqlite_master WHERE name IN ('normalize_url','articles_updated_at','outbox_override')").all()).toEqual([]);
});

for(const ackFirst of [false,true]) test(`physical tombstone cleanup does not repeat a logical deletion, ACK first=${ackFirst}`,async()=>{
  const a=await api();await write(a.env.DB,change('a','https://example.test/a',1));
  await write(a.env.DB,change('a','https://example.test/a',2,{deleted_at:'2026-10-03T00:00:02.000Z'}));
  expect(rows(a.env.DB,a.sub.id)).toHaveLength(2);
  if(ackFirst) {
    const batch=await (await a.call(a.path+'/events?wait=0',{token:a.token})).json();
    await a.call(a.path+'/ack',{method:'POST',body:{delivery_id:batch.delivery_id},token:a.token});
  }
  await a.env.DB.prepare("DELETE FROM articles WHERE id='a'").run();
  expect(rows(a.env.DB,a.sub.id)).toHaveLength(ackFirst?0:2);
  expect(a.env.DB.db.query('SELECT last_seq FROM _change_subscriptions').get().last_seq).toBe(2);
});

test('governance continuity guards coexist with subscription creation and exact trigger trust',async()=>{
  const {ensureEvidenceStorage}=await import('../src/governance-evidence.js');
  const db=database();await ensureEvidenceStorage(db);
  const sub=await createSubscription(db,config);
  db.db.exec("INSERT INTO articles(id,url,updated_at) VALUES ('a','https://example.test/a','2025-01-01'); UPDATE articles SET url='https://example.test/b'");
  expect(rows(db,sub.id).map(e=>e.operation)).toEqual(['insert','update']);
  const guard=db.db.query("SELECT name,sql FROM sqlite_master WHERE name GLOB '_governance_rows_*_update'").get();
  db.db.exec(`DROP TRIGGER "${guard.name}"; ${guard.sql.replace('event_id=NULL',"event_id='forged'")}`);
  await expect(createSubscription(db,config)).rejects.toThrow('invalid subscription triggers');
  db.db.close();
});
