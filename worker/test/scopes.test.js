import { expect, spyOn, test } from 'bun:test';
import worker from '../src/index.js';
import fixture from '../../tests/fixtures/hub-capabilities-contract.json';
import { D1Shim } from './d1shim.js';

async function setup(scopes, dataDb = null, extraEnv = {}) {
  const env = {HUB_TOKEN:'operator-fixture',AUTH_DB:new D1Shim(),DB:dataDb ?? {prepare(){throw new Error('unexpected data access');}},...extraEnv};
  const pending = [], ctx = {waitUntil(p){pending.push(p);}};
  const mint = await worker.fetch(new Request('https://hub.test/v1/tokens/create',{
    method:'POST',headers:{Authorization:'Bearer operator-fixture'},
    body:JSON.stringify({name:'consumer-fixture',scopes:scopes.join(',')}),
  }),env,ctx);
  const {token} = await mint.json();
  const call = (path,method='GET',body) => worker.fetch(new Request(`https://hub.test${path}`,{
    method,headers:{Authorization:`Bearer ${token}`},body:body === undefined ? undefined : JSON.stringify(body),
  }),env,ctx);
  return {call,env,pending};
}

for (const entry of fixture.sessions) test(`session capability contract: ${entry.scopes.join(',')}`,async()=>{
  const {call} = await setup(entry.scopes);
  const response = await call('/v1/session');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({name:'consumer-fixture',scopes:entry.scopes,capabilities:entry.capabilities});
  expect(response.headers.get('Cache-Control')).toBe('no-store');
});

test('restricted schema denial is explicit and touches no data D1',async()=>{
  const {call} = await setup(['tables:read:articles']);
  for (const path of ['/v1/schema/pull','/v1/schema/push']) {
    const response = await call(path,'POST',{});
    expect(response.status).toBe(fixture.scoped_replica_unsupported.status);
    expect(await response.json()).toEqual(fixture.scoped_replica_unsupported.body);
  }
});

const stamp = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const revision = '2026-10-03T00:00:00.000Z';
function rowDb() {
  const db = new D1Shim();
  db.db.exec(`
    CREATE TABLE catalog_tables(id TEXT PRIMARY KEY,kind TEXT,deleted_at TEXT);
    CREATE TABLE catalog_properties(id TEXT PRIMARY KEY,tbl TEXT,col TEXT,type TEXT,sort INTEGER,required INTEGER,options TEXT,options_sql TEXT,ref_table TEXT,default_value TEXT,derived_by TEXT,inputs TEXT,deleted_at TEXT);
    CREATE TABLE catalog_rules(id TEXT PRIMARY KEY,tbl TEXT,kind TEXT,enforce INTEGER,scope TEXT,sql TEXT,deleted_at TEXT);
    CREATE TABLE articles(id TEXT PRIMARY KEY,url TEXT,created_at TEXT DEFAULT (${stamp}),updated_at TEXT,deleted_at TEXT,hub_at TEXT);
    CREATE TABLE secrets(id TEXT PRIMARY KEY,value TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT);
    INSERT INTO articles(id,url,updated_at) VALUES ('a','https://example.test/a','${revision}');
    INSERT INTO secrets(id,value,updated_at) VALUES ('s','denied-value','${revision}');
    INSERT INTO catalog_tables VALUES ('articles','table',NULL),('secrets','table',NULL);
    INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('articles.url','articles','url','url'),('secrets.value','secrets','value','text');
  `);
  return db;
}
const pull = table => ({table,columns:['id','url'],since:'',limit:100});
const insert = (extra={}) => ({table:'articles',columns:['id','url','updated_at'],rows:[{id:'b',url:'https://example.test/b',updated_at:revision}],...extra});

test('table/body authorization precedes any data lookup and never interprets broad prefixes',async()=>{
  const {call} = await setup(['tables:read:articles','tables:write:articles']);
  for (const table of ['secrets','Articles','articles ','articles;SELECT 1','sqlite_master','history','provenance','catalog_properties','purges','_tokens',null,{}]) {
    for (const route of ['pull','insert','push','patch']) expect((await call(`/v1/rows/${route}`,'POST',{...insert(),table})).status).toBe(403);
  }
  for (const [path,method] of [['/v1/catalog','GET'],['/v1/stats','POST'],['/v1/cursor','POST'],['/v1/backup','POST'],['/v1/archive/query','POST'],['/v1/derive','POST'],['/v1/derive/resolve','POST'],['/v1/tokens/list','POST'],['/v1/streams/anything','GET'],['/v1/files/captures/a','GET']]) {
    expect((await call(path,method,method==='POST'?{}:undefined)).status).toBe(403);
  }
});

test('narrow reads return only the permitted base table and bounded rows',async()=>{
  const db=rowDb(),{call}=await setup(['tables:read:articles'],db);
  const response=await call('/v1/rows/pull','POST',pull('articles'));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({rows:[{id:'a',url:'https://example.test/a'}],next_cursor:null});
  expect((await call('/v1/rows/insert','POST',insert())).status).toBe(403);
  expect((await call('/v1/rows/pull','POST',{...pull('articles'),limit:201})).status).toBe(400);
  expect((await call('/v1/rows/pull','POST',{...pull('articles'),columns:['nonexistent']})).status).toBe(400);
});

test('narrow write grants allow insert and push without granting reads',async()=>{
  const db=rowDb(),{call}=await setup(['tables:write:articles'],db);
  const created=await call('/v1/rows/insert','POST',insert());
  expect(created.status).toBe(200);
  expect(await created.json()).toEqual({inserted:['b'],existing:[],rejected:[]});
  const changed=await call('/v1/rows/push','POST',insert({rows:[{id:'b',url:'https://example.test/c',updated_at:'2026-10-03T00:00:01.000Z'}]}));
  expect(changed.status).toBe(200);
  expect((await changed.json()).upserted).toBe(1);
  expect((await call('/v1/rows/pull','POST',pull('articles'))).status).toBe(403);
  expect(db.db.query("SELECT url FROM articles WHERE id='b'").get().url).toBe('https://example.test/c');
});

test('catalogued views, system tables and unregistered tables remain ineligible even with exact grants',async()=>{
  const db=rowDb();
  db.db.exec("CREATE VIEW visible AS SELECT id,value AS url,updated_at FROM secrets; INSERT INTO catalog_tables VALUES ('visible','table',NULL); CREATE TABLE plain(id TEXT PRIMARY KEY,updated_at TEXT); UPDATE catalog_tables SET kind='system' WHERE id='secrets'");
  const {call}=await setup(['tables:read:visible','tables:read:secrets','tables:read:plain','tables:read:history'],db);
  for(const table of ['visible','secrets','plain','history']) expect((await call('/v1/rows/pull','POST',pull(table))).status).toBe(403);
});

for(const [name,sql] of [
  ['side-effect trigger',"CREATE TRIGGER user_trigger AFTER INSERT ON articles BEGIN UPDATE secrets SET value=NEW.url; END"],
  ['forged timestamp trigger',"CREATE TRIGGER articles_updated_at AFTER INSERT ON articles BEGIN UPDATE secrets SET value=NEW.url; END"],
  ['unsafe default',"ALTER TABLE articles RENAME TO previous_articles; CREATE TABLE articles(id TEXT PRIMARY KEY,url TEXT,updated_at TEXT,deleted_at TEXT,surprise TEXT DEFAULT (datetime('now')))"],
  ['generated expression',"ALTER TABLE articles ADD COLUMN surprise TEXT GENERATED ALWAYS AS (url || 'suffix') VIRTUAL"],
  ['SQL options',"UPDATE catalog_properties SET options_sql='SELECT value FROM secrets' WHERE tbl='articles'"],
  ['SQL catalog default',"UPDATE catalog_properties SET default_value='sql:SELECT value FROM secrets' WHERE tbl='articles'"],
  ['derived property',"UPDATE catalog_properties SET derived_by='http:fixture' WHERE tbl='articles'"],
  ['invariant',"INSERT INTO catalog_rules VALUES ('rule-secret','articles','invariant',1,'table','SELECT value FROM secrets',NULL)"],
  ['foreign key side effect',"CREATE TABLE child(id TEXT PRIMARY KEY,parent TEXT REFERENCES articles(id) ON DELETE CASCADE)"],
]) test(`narrow writes reject ${name} without leaking policy details`,async()=>{
  const db=rowDb();db.db.exec(sql);
  const {call}=await setup(['tables:write:articles'],db);
  const response=await call('/v1/rows/insert','POST',insert());
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({error:'insufficient scope'});
  expect(db.db.query("SELECT count(*) AS n FROM articles WHERE id='b'").get().n).toBe(0);
  expect(db.db.query('SELECT value FROM secrets').get().value).toBe('denied-value');
});

test('narrow history attachments are refused before reads and cannot attach denied-source events',async()=>{
  const {call}=await setup(['tables:write:articles']);
  expect((await call('/v1/rows/push','POST',insert({history:[]}))).status).toBe(403);
});

test('server validates internal references but returns only generic rejection',async()=>{
  const db=rowDb();db.db.exec("UPDATE catalog_properties SET type='ref',ref_table='secrets' WHERE tbl='articles'");
  const {call}=await setup(['tables:write:articles'],db);
  const invalid=await call('/v1/rows/insert','POST',insert({rows:[{id:'b',url:'absent',updated_at:revision}]}));
  expect(invalid.status).toBe(200);
  expect(await invalid.json()).toEqual({inserted:[],existing:[],rejected:[{id:'b',col:null,rule:'validation',message:'Row rejected.'}]});
  const valid=await call('/v1/rows/insert','POST',insert({rows:[{id:'c',url:'s',updated_at:revision}]}));
  expect((await valid.json()).inserted).toEqual(['c']);
});

test('a policy change between eligibility and commit cannot create side effects',async()=>{
  const db=rowDb(),batch=db.batch.bind(db);let changed=false;
  db.batch=async statements=>{
    if(!changed){changed=true;db.db.exec("CREATE TRIGGER concurrent_change AFTER INSERT ON articles BEGIN UPDATE secrets SET value=NEW.url; END");}
    return batch(statements);
  };
  const {call}=await setup(['tables:write:articles'],db);
  const response=await call('/v1/rows/insert','POST',insert());
  const body=await response.json();
  expect(response.status===403 || (response.status===200 && body.inserted.length===0 && body.rejected.length>0)).toBe(true);
  expect(JSON.stringify(body)).not.toContain('denied-value');
  expect(db.db.query('SELECT value FROM secrets').get().value).toBe('denied-value');
  expect(db.db.query("SELECT id FROM articles WHERE id='b'").get()).toBeNull();
});

test('a base table replaced by a view before read is denied before the view runs',async()=>{
  const db=rowDb(),batch=db.batch.bind(db),prepare=db.prepare.bind(db),guarded=new WeakSet();let changed=false;
  db.prepare=sql=>{const stmt=prepare(sql);if(sql.includes('life_write_conflict'))guarded.add(stmt);return stmt;};
  // After the table check (which may prefetch in a batch of its own), before the guarded read.
  db.batch=async statements=>{
    if(!changed && statements.some(s=>guarded.has(s))){changed=true;db.db.exec('ALTER TABLE articles RENAME TO previous_articles; CREATE VIEW articles AS SELECT id,value AS url,updated_at FROM secrets');}
    return batch(statements);
  };
  const {call}=await setup(['tables:read:articles'],db);
  const response=await call('/v1/rows/pull','POST',pull('articles'));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({error:'row request failed'});
});

test('canonical timestamp trigger is allowed, and narrow credentials revoke independently',async()=>{
  const db=rowDb();db.db.exec(`CREATE TRIGGER "articles_updated_at" AFTER UPDATE ON "articles" FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE "articles" SET updated_at = (${stamp}) WHERE rowid = NEW.rowid; END`);
  const {call,env}=await setup(['tables:write:articles'],db);
  expect((await (await call('/v1/rows/insert','POST',insert())).json()).inserted).toEqual(['b']);
  await env.AUTH_DB.prepare("UPDATE _tokens SET revoked_at='revoked' WHERE name='consumer-fixture'").run();
  expect((await call('/v1/rows/insert','POST',insert())).status).toBe(403);
  const other=await setup(['tables:read:articles'],db);
  expect((await other.call('/v1/rows/pull','POST',pull('articles'))).status).toBe(200);
});

test('narrow writes refuse a table with active purge recovery instead of running post-commit effects',async()=>{
  const db=rowDb();
  db.db.exec("CREATE TABLE purges(id TEXT PRIMARY KEY,tbl TEXT,row_id TEXT,col TEXT,purged_at TEXT,deleted_at TEXT); INSERT INTO purges VALUES ('p','articles','b',NULL,'2099-01-01T00:00:00.000Z',NULL)");
  const {call}=await setup(['tables:write:articles'],db);
  const response=await call('/v1/rows/push','POST',insert());
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({error:'insufficient scope'});
});

test('narrow writes allow exact subscription triggers but reject a forged replacement',async()=>{
  const {createSubscription}=await import('../src/subscriptions.js');
  const db=rowDb();await createSubscription(db,{label:'Fixture',sources:[{table:'articles',columns:['url']}],start:'now'});
  const {call}=await setup(['tables:write:articles'],db);
  expect((await (await call('/v1/rows/insert','POST',insert())).json()).inserted).toEqual(['b']);
  expect(db.db.query('SELECT count(*) AS n FROM _change_events').get().n).toBe(1);
  const {name}=db.db.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '%_insert'").get();
  db.db.exec(`DROP TRIGGER "${name}"; CREATE TRIGGER "${name}" AFTER INSERT ON articles BEGIN UPDATE secrets SET value=NEW.url; END`);
  expect((await call('/v1/rows/insert','POST',insert())).status).toBe(403);
  expect(db.db.query('SELECT value FROM secrets').get().value).toBe('denied-value');
});

for(const internal of ['_change_events','_change_subscriptions']) for(const concurrent of [false,true]) test(`outbox destination triggers cannot escape narrow grants: ${internal}, concurrent=${concurrent}`,async()=>{
  const {createSubscription}=await import('../src/subscriptions.js');
  const db=rowDb();await createSubscription(db,{label:'Fixture',sources:[{table:'articles',columns:['url']}],start:'now'});
  const sql=`CREATE TRIGGER escape_scope AFTER ${internal==='_change_events'?'INSERT':'UPDATE'} ON "${internal}" BEGIN UPDATE secrets SET value='escaped'; END`;
  if(concurrent) {
    const batch=db.batch.bind(db);let changed=false;
    db.batch=async statements=>{if(!changed){changed=true;db.db.exec(sql);}return batch(statements);};
  } else db.db.exec(sql);
  const {call}=await setup(['tables:write:articles'],db);
  const response=await call('/v1/rows/insert','POST',insert()),body=await response.json();
  expect(response.status===403 || (response.status===200 && body.inserted.length===0 && body.rejected.length>0)).toBe(true);
  expect(db.db.query('SELECT value FROM secrets').get().value).toBe('denied-value');
  expect(db.db.query("SELECT id FROM articles WHERE id='b'").get()).toBeNull();
});

for (const sideEffect of [false, true]) test(`legacy unquoted system timestamp trigger: side effect ${sideEffect}`, async () => {
  const db=rowDb();
  db.db.exec(`CREATE TABLE provenance(id TEXT PRIMARY KEY,updated_at TEXT);
    CREATE TRIGGER provenance_updated_at AFTER UPDATE ON provenance FOR EACH ROW
    WHEN NEW.updated_at = OLD.updated_at BEGIN
      UPDATE provenance SET updated_at = (${stamp}) WHERE rowid = NEW.rowid;
      ${sideEffect ? "UPDATE secrets SET value='changed';" : ''}
    END`);
  const {call}=await setup(['tables:write:articles'],db);
  const response=await call('/v1/rows/insert','POST',insert());
  expect(response.status).toBe(sideEffect ? 403 : 200);
  expect(db.db.query("SELECT count(*) AS n FROM articles WHERE id='b'").get().n).toBe(sideEffect ? 0 : 1);
  expect(db.db.query('SELECT value FROM secrets').get().value).toBe('denied-value');
});

function captureDb() {
  const db=rowDb();
  db.db.exec(`ALTER TABLE articles ADD COLUMN description TEXT;
    ALTER TABLE articles ADD COLUMN tags TEXT;
    ALTER TABLE articles ADD COLUMN related TEXT;
    INSERT INTO catalog_properties(id,tbl,col,type,required,options,ref_table) VALUES
    ('articles.description','articles','description','text',1,NULL,NULL),
    ('articles.tags','articles','tags','multi_select',0,'[{"v":"Source","d":"Source material","sort":2},{"v":"Other"}]',NULL),
    ('articles.related','articles','related','multi_ref',0,NULL,'articles');`);
  return db;
}
const templates = [
  "SELECT id FROM changed WHERE deleted_at IS NULL AND description LIKE '%.'",
  "SELECT id FROM changed WHERE deleted_at IS NULL AND url LIKE '%source.test/%' AND NOT EXISTS (SELECT 1 FROM json_each(coalesce(tags,'[]')) WHERE value = 'Source')",
  'SELECT c.id FROM changed c JOIN articles b ON b.url = c.url AND b.id != c.id AND b.deleted_at IS NULL WHERE c.deleted_at IS NULL AND c.url IS NOT NULL',
];
function rule(db,sql,scope='table',tbl='articles') {
  db.db.query('INSERT INTO catalog_rules VALUES (?,?,?,?,?,?,NULL)').run(`rule-${db.db.query('SELECT count(*) AS n FROM catalog_rules').get().n}`,tbl,'invariant',1,scope,sql);
}
const capture = (values={}) => ({table:'articles',columns:['id','url','description','tags','related','updated_at'],rows:[{id:'b',url:'https://source.test/b',description:'A resource',tags:'["Source"]',related:'["a"]',updated_at:revision,...values}]});
const optionsPath='/v1/catalog/options?table=articles&column=tags';

test('exact read grant exposes only static option metadata',async()=>{
  const db=captureDb(),{call}=await setup(['tables:read:articles'],db);
  const response=await call(optionsPath);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({options:[{v:'Source',d:'Source material',sort:2},{v:'Other'}]});
  db.db.exec(`UPDATE catalog_properties SET options='[]' WHERE col='tags'`);
  expect(await (await call(optionsPath)).json()).toEqual({options:[]});
});

test('option metadata carries palette colors and drops unknown ones',async()=>{
  const db=captureDb(),{call}=await setup(['tables:read:articles'],db);
  db.db.exec(`UPDATE catalog_properties SET options='[{"v":"Source","color":"blue"},{"v":"Other","color":"teal"},{"v":"Plain"}]' WHERE col='tags'`);
  expect(await (await call(optionsPath)).json()).toEqual({options:[{v:'Source',color:'blue'},{v:'Other'},{v:'Plain'}]});
});

test('options authorization rejects wrong grants and malformed targets before data reads',async()=>{
  for(const scopes of [['streams:append'],['tables:write:articles'],['tables:read:secrets']]) {
    const {call}=await setup(scopes);
    expect((await call(optionsPath)).status).toBe(403);
  }
  const {call}=await setup(['tables:read:articles']);
  for(const path of [optionsPath.replace('articles','secrets'),optionsPath.replace('articles','catalog_properties'),'/v1/catalog/options?table=articles','/v1/catalog/options?table=articles&column=tags%3B','/v1/catalog/options?table=articles&column=tags&column=url']) {
    expect((await call(path)).status).toBe(403);
  }
});

for(const mutation of [
  "UPDATE catalog_properties SET options_sql='SELECT value FROM secrets' WHERE col='tags'",
  "UPDATE catalog_properties SET deleted_at='gone' WHERE col='tags'",
  "DELETE FROM catalog_properties WHERE col='tags'",
  "UPDATE catalog_properties SET col='missing' WHERE col='tags'",
  "UPDATE catalog_properties SET type='text' WHERE col='tags'",
  "UPDATE catalog_tables SET kind='view' WHERE id='articles'",
]) test(`options fail closed: ${mutation}`,async()=>{
  const db=captureDb();db.db.exec(mutation);
  const {call}=await setup(['tables:read:articles'],db);
  const response=await call(optionsPath);
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({error:'insufficient scope'});
});

test('options projection is guarded against concurrent catalog changes',async()=>{
  const db=captureDb(),batch=db.batch.bind(db);
  db.batch=async statements=>{
    db.db.exec("UPDATE catalog_properties SET options_sql='SELECT value FROM secrets' WHERE col='tags'");
    return batch(statements);
  };
  const {call}=await setup(['tables:read:articles'],db);
  const response=await call(optionsPath);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({error:'row request failed'});
});

for(const route of ['insert','push']) test(`exact invariant templates enforce ${route} and permit same-table references`,async()=>{
  const db=captureDb();templates.forEach(sql=>rule(db,sql));
  const {call}=await setup(['tables:write:articles'],db);
  const good=await call(`/v1/rows/${route}`,'POST',capture());
  expect(good.status).toBe(200);
  expect((await good.json()).rejected).toEqual([]);
  expect(db.db.query("SELECT id FROM articles WHERE id='b'").get()).toEqual({id:'b'});
  for(const values of [{description:'Bad.'},{tags:'[]'},{url:'https://example.test/a'},{tags:'["Invalid"]'},{description:null},{related:'["missing"]'}]) {
    const response=await call(`/v1/rows/${route}`,'POST',capture({id:'c',...values}));
    expect(response.status).toBe(200);
    expect((await response.json()).rejected).toEqual([{id:'c',col:null,rule:'validation',message:'Row rejected.'}]);
    expect(db.db.query("SELECT id FROM articles WHERE id='c'").get()).toBeNull();
  }
});

// Same-table invariants outside the templates run exactly as for full writers.
const confined = [
  ['SELECT c.id FROM changed c WHERE c.deleted_at IS NULL AND c.url IS NOT NULL AND EXISTS (SELECT 1 FROM articles w WHERE w.deleted_at IS NULL AND w.url=c.url AND w.id<>c.id)',
    [{url:'https://example.test/a'}]],
  ["SELECT id FROM changed WHERE deleted_at IS NULL AND ((description IS NOT NULL AND length(description) < 3) OR (substr(url,1,8) <> 'https://'))",
    [{description:'ab'},{url:'http://source.test/c'}]],
  ['SELECT c.id FROM changed c WHERE c.deleted_at IS NULL AND EXISTS (SELECT 1 FROM "Articles" w WHERE w.deleted_at IS NULL AND w.description = c.description AND w.id <> c.id)',
    [{description:'A resource'}]],
  [templates[0]+' AND 1=1', [{description:'Bad.'}]],
  [templates[0].replace("'%.'","'%.' OR 1=1"), [{description:'Fine'}]],
];
for(const route of ['insert','push']) for(const [sql,bad] of confined) test(`same-table invariant enforced on ${route}: ${sql}`,async()=>{
  const db=captureDb();rule(db,sql);
  const {call}=await setup(['tables:write:articles'],db);
  const always=sql.includes('OR 1=1');
  const first=await (await call(`/v1/rows/${route}`,'POST',capture())).json();
  expect(first.rejected).toEqual(always?[{id:'b',col:null,rule:'validation',message:'Row rejected.'}]:[]);
  expect(db.db.query("SELECT count(*) AS n FROM articles WHERE id='b'").get().n).toBe(always?0:1);
  for(const values of bad) {
    const response=await call(`/v1/rows/${route}`,'POST',capture({id:'c',url:'https://source.test/c',...values}));
    expect(response.status).toBe(200);
    expect((await response.json()).rejected).toEqual([{id:'c',col:null,rule:'validation',message:'Row rejected.'}]);
    expect(db.db.query("SELECT id FROM articles WHERE id='c'").get()).toBeNull();
  }
});

for(const sql of [
  templates[0].replace('description','missing'),
  templates[2].replace('c.id','cXid'),
]) test(`broken same-table invariant fails closed: ${sql}`,async()=>{
  const db=captureDb();rule(db,sql);
  const {call}=await setup(['tables:write:articles'],db);
  const response=await call('/v1/rows/insert','POST',capture());
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({error:'row request failed'});
  expect(db.db.query("SELECT id FROM articles WHERE id='b'").get()).toBeNull();
});

const join = target => `SELECT c.id FROM changed c JOIN ${target} s ON s.id = c.id WHERE c.deleted_at IS NULL`;
for(const [sql,setupSql] of [
  [templates[2].replace('JOIN articles','JOIN secrets')],
  [templates[0]+' UNION SELECT id FROM secrets'],
  ['SELECT id FROM secrets'],
  ...['"secrets"','[secrets]','`secrets`',"'secrets'",'main.secrets','SECRETS','"Secrets"','main."secrets"'].map(t=>[join(t)]),
  [join('shadow'),'CREATE VIEW shadow AS SELECT id,value FROM secrets'],
  ["SELECT id FROM changed WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE name = 'x')"],
  ['SELECT id FROM changed WHERE EXISTS (SELECT 1 FROM sqlite_schema)'],
  ['SELECT id FROM changed WHERE (SELECT count(*) FROM pragma_table_list) > 9'],
  ['SELECT id FROM changed WHERE (SELECT count(*) FROM dbstat) > 9'],
  // A single-quoted name is an identifier where SQLite expects a table, so a
  // literal equal to another table's name is denied too (fail closed).
  ["SELECT id FROM changed WHERE deleted_at IS NULL AND description = 'secrets'"],
  ...[';',' -- comment',' /* comment */'].map(s=>[templates[0]+s]),
  [templates[0].replace("'%.'","'bad\\' OR 1=1 --'")],
  ["SELECT id FROM changed WHERE description = 'open"],
  ['DELETE FROM articles RETURNING id'],
]) test(`invariant reading outside the granted table denied: ${sql}`,async()=>{
  const db=captureDb();if(setupSql)db.db.exec(setupSql);rule(db,sql);
  const {call}=await setup(['tables:write:articles'],db);
  const response=await call('/v1/rows/insert','POST',capture());
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({error:'insufficient scope'});
  expect(db.db.query("SELECT id FROM articles WHERE id='b'").get()).toBeNull();
});

for(const [scope,tbl] of [['estate','articles'],['estate','secrets'],[null,'articles'],['other','articles']]) test(`rule ownership denied: ${scope}/${tbl}`,async()=>{
  const db=captureDb();rule(db,templates[0],scope,tbl);
  const {call}=await setup(['tables:write:articles'],db);
  expect((await call('/v1/rows/insert','POST',capture())).status).toBe(403);
});

test('SQL literal escaping treats punctuation and SQL-looking text only as values',async()=>{
  const db=captureDb();
  const value="it's \\ text; -- SELECT id FROM secrets /* */";
  rule(db,`SELECT id FROM changed WHERE deleted_at IS NULL AND description LIKE '${value.replaceAll("'","''")}'`);
  const {call}=await setup(['tables:write:articles'],db);
  const good=await call('/v1/rows/insert','POST',capture());
  expect(good.status).toBe(200);
  expect((await good.json()).inserted).toEqual(['b']);
  const bad=await call('/v1/rows/insert','POST',capture({id:'c',description:value}));
  expect((await bad.json()).rejected).toEqual([{id:'c',col:null,rule:'validation',message:'Row rejected.'}]);
});


test('concurrent invariant replacement cannot escape the checked transaction',async()=>{
  const db=captureDb();rule(db,templates[0]);
  const batch=db.batch.bind(db);let changed=false;
  db.batch=async statements=>{
    if(!changed){changed=true;db.db.exec("UPDATE catalog_rules SET sql='SELECT id FROM secrets'");}
    return batch(statements);
  };
  const {call}=await setup(['tables:write:articles'],db);
  const response=await call('/v1/rows/insert','POST',capture());
  const body=await response.json();
  expect(response.status===403 || (response.status===200 && body.inserted.length===0 && body.rejected.length>0)).toBe(true);
  expect(JSON.stringify(body)).not.toContain('secrets');
  expect(db.db.query("SELECT id FROM articles WHERE id='b'").get()).toBeNull();
});

for(const options of ['not json','{}','[null]','[{"v":1}]','[{"v":"x","d":3}]','[{"v":"x","sort":"1"}]']) test(`malformed static options denied: ${options}`,async()=>{
  const db=captureDb();db.db.query("UPDATE catalog_properties SET options=? WHERE col='tags'").run(options);
  const {call}=await setup(['tables:read:articles'],db);
  const response=await call(optionsPath);
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({error:'insufficient scope'});
});

test('option projection strips unrelated metadata',async()=>{
  const db=captureDb();db.db.query("UPDATE catalog_properties SET options=? WHERE col='tags'").run('[{"v":"Option","private":"hidden"}]');
  const {call}=await setup(['tables:read:articles'],db);
  expect(await (await call(optionsPath)).json()).toEqual({options:[{v:'Option'}]});
});

test('JSON membership template accepts doubled quotes in both literals',async()=>{
  const db=captureDb();
  db.db.query("UPDATE catalog_properties SET options=? WHERE col='tags'").run(JSON.stringify([{v:"Reader's choice"}]));
  rule(db,"SELECT id FROM changed WHERE deleted_at IS NULL AND description LIKE 'reader''s %' AND NOT EXISTS (SELECT 1 FROM json_each(coalesce(tags,'[]')) WHERE value = 'Reader''s choice')");
  const {call}=await setup(['tables:write:articles'],db);
  const good=await call('/v1/rows/insert','POST',capture({description:"reader's guide",tags:JSON.stringify(["Reader's choice"])}));
  expect(good.status).toBe(200);
  expect((await good.json()).inserted).toEqual(['b']);
  const bad=await call('/v1/rows/insert','POST',capture({id:'c',description:"reader's guide",tags:'[]'}));
  expect((await bad.json()).rejected).toEqual([{id:'c',col:null,rule:'validation',message:'Row rejected.'}]);
});

test('existing write-pipeline SQL restriction still rejects an ambient-clock-looking literal',async()=>{
  const db=captureDb();rule(db,"SELECT id FROM changed WHERE deleted_at IS NULL AND description LIKE 'now'");
  const {call}=await setup(['tables:write:articles'],db);
  const response=await call('/v1/rows/insert','POST',capture());
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({error:'row request failed'});
  expect(db.db.query("SELECT id FROM articles WHERE id='b'").get()).toBeNull();
});

function purgeDb(column=null, target='a') {
  const db=captureDb();templates.forEach(sql=>rule(db,sql));
  db.db.exec("CREATE TABLE purges(id TEXT PRIMARY KEY,tbl TEXT,row_id TEXT,col TEXT,purged_at TEXT,deleted_at TEXT)");
  db.db.query('INSERT INTO purges VALUES (?,?,?,?,?,NULL)').run('marker','articles',target,column,'2099-01-01T00:00:00.000Z');
  return db;
}

for(const route of ['insert','push']) for(const column of [null,'description']) test(`unrelated purge markers permit ${route} without cleanup: ${column ?? 'row'}`,async()=>{
  const db=purgeDb(column),before=db.db.query('SELECT * FROM purges').all();
  const {call}=await setup(['tables:read:articles','tables:write:articles'],db);
  expect((await call('/v1/rows/pull','POST',{...pull('articles'),where:{url:'https://example.test/a'}})).status).toBe(200);
  expect((await call(optionsPath)).status).toBe(200);
  const response=await call(`/v1/rows/${route}`,'POST',capture());
  expect(response.status).toBe(200);
  const body=await response.json();
  expect(body.rejected).toEqual([]);
  expect(route==='push'?body.upserted:body.inserted).toEqual(route==='push'?1:['b']);
  expect(db.db.query("SELECT id FROM articles WHERE id='a'").get()).toEqual({id:'a'});
  expect(db.db.query('SELECT * FROM purges').all()).toEqual(before);
});

for(const route of ['insert','push']) for(const column of [null,'description']) for(const mixed of [false,true]) test(`marked row denied on ${route}: ${column ?? 'row'}, mixed=${mixed}`,async()=>{
  const db=purgeDb(column,'b'),before=db.db.query('SELECT * FROM purges').all();
  const {call}=await setup(['tables:write:articles'],db);
  const body=capture();
  if(mixed) body.rows.unshift({...body.rows[0],id:'c',url:'https://source.test/c'});
  const response=await call(`/v1/rows/${route}`,'POST',body);
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({error:'insufficient scope'});
  expect(db.db.query("SELECT id FROM articles WHERE id IN ('b','c')").all()).toEqual([]);
  expect(db.db.query('SELECT * FROM purges').all()).toEqual(before);
});

for(const route of ['insert','push']) for(const column of [null,'description']) for(const createTable of [false,true]) test(`new purge marker rolls back ${route}: ${column ?? 'row'}, new table=${createTable}`,async()=>{
  const db=purgeDb(column),batch=db.batch.bind(db);let changed=false;
  if(createTable) db.db.exec('DROP TABLE purges');
  db.batch=async statements=>{
    if(!changed){
      changed=true;
      if(createTable) db.db.exec("CREATE TABLE purges(id TEXT PRIMARY KEY,tbl TEXT,row_id TEXT,col TEXT,purged_at TEXT,deleted_at TEXT)");
      db.db.query('INSERT INTO purges VALUES (?,?,?,?,?,NULL)').run('new-marker','articles','b',column,'2099-01-01T00:00:00.000Z');
    }
    return batch(statements);
  };
  const {call}=await setup(['tables:write:articles'],db);
  const response=await call(`/v1/rows/${route}`,'POST',capture());
  const body=await response.json();
  expect(response.status===403 || (response.status===200 && body.rejected.length>0 && (body.upserted===0 || body.inserted.length===0))).toBe(true);
  expect(db.db.query("SELECT id FROM articles WHERE id='b'").get()).toBeNull();
  expect(db.db.query("SELECT id FROM purges WHERE id='new-marker'").get()).toEqual({id:'new-marker'});
  expect(JSON.stringify(body)).not.toContain('new-marker');
});

for(const id of [undefined,null,1,{},[], '', ' ']) test(`narrow writes require an explicit string row ID: ${JSON.stringify(id)}`,async()=>{
  const db=purgeDb(),{call}=await setup(['tables:write:articles'],db);
  for(const route of ['insert','push']) {
    const response=await call(`/v1/rows/${route}`,'POST',capture({id}));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({error:'insufficient scope'});
  }
});

test('narrow writes cannot omit id from the write column list',async()=>{
  const db=purgeDb(),{call}=await setup(['tables:write:articles'],db);
  const body=capture();body.columns=body.columns.filter(c=>c!=='id');
  expect((await call('/v1/rows/push','POST',body)).status).toBe(403);
});

for(const route of ['insert','push']) test(`inactive or other-table marker does not block ${route}`,async()=>{
  const db=purgeDb(null,'b');
  db.db.exec("UPDATE purges SET deleted_at='2026-01-01T00:00:00.000Z'; INSERT INTO purges VALUES ('other','secrets','b',NULL,'2099-01-01T00:00:00.000Z',NULL)");
  const {call}=await setup(['tables:write:articles'],db);
  const response=await call(`/v1/rows/${route}`,'POST',capture());
  expect(response.status).toBe(200);
  expect((await response.json()).rejected).toEqual([]);
});

for(const [definition,stored,submitted] of [['TEXT COLLATE NOCASE','b','B'],['TEXT COLLATE RTRIM','b','b '],['INTEGER',1,'01']]) test(`purge eligibility cannot alias protected IDs through ${definition}`,async()=>{
  const db=rowDb();
  db.db.exec(`DROP TABLE articles; CREATE TABLE articles(id ${definition} PRIMARY KEY,url TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT);
    CREATE TABLE purges(id TEXT PRIMARY KEY,tbl TEXT,row_id TEXT,col TEXT,purged_at TEXT,deleted_at TEXT);`);
  db.db.query('INSERT INTO articles(id,url,updated_at) VALUES (?,?,?)').run(stored,'https://example.test/original',revision);
  db.db.query('INSERT INTO purges VALUES (?,?,?,?,?,NULL)').run('marker','articles',String(stored),null,revision);
  const {call}=await setup(['tables:write:articles'],db);
  const response=await call('/v1/rows/push','POST',insert({rows:[{id:submitted,url:'https://example.test/changed',updated_at:'2026-10-04T00:00:00.000Z'}]}));
  expect(response.status).toBe(403);
  expect(db.db.query('SELECT url FROM articles').get().url).toBe('https://example.test/original');
});

const projected = ['tables:read:articles:id','tables:read:articles:url','tables:read:articles:deleted_at'];
test('column reader gets only declared projection with bounded ID pagination',async()=>{
  const db=rowDb(),{call}=await setup(projected,db);
  db.db.exec(`INSERT INTO articles(id,url,updated_at,deleted_at) VALUES ('b','second','${revision}','${revision}')`);
  const first=await call('/v1/rows/pull','POST',{table:'articles',columns:['id','url','deleted_at'],limit:1});
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({rows:[{id:'a',url:'https://example.test/a',deleted_at:null}],next_cursor:'a'});
  const second=await call('/v1/rows/pull','POST',{table:'articles',columns:['id','deleted_at'],after:'a',limit:1});
  expect(second.status).toBe(200);
  expect(await second.json()).toEqual({rows:[{id:'b',deleted_at:revision}],next_cursor:'b'});
  const filtered=await call('/v1/rows/pull','POST',{table:'articles',columns:['url'],where:{id:'a'}});
  expect(await filtered.json()).toEqual({rows:[{url:'https://example.test/a'}],next_cursor:null});
});

test('column grants reject hidden projection, predicates and cursor timestamps before data lookup',async()=>{
  const {call}=await setup(projected);
  for(const body of [
    {table:'articles'}, {table:'articles',columns:[]},
    {table:'articles',columns:['id','created_at']},
    {table:'articles',columns:['id'],where:{created_at:'x'}},
    {table:'articles',columns:['id'],since:revision},
    {table:'secrets',columns:['id']},
    {table:'Articles',columns:['id']},
  ]) expect((await call('/v1/rows/pull','POST',body)).status).toBe(403);
  for(const [path,method] of [['/v1/catalog','GET'],['/v1/catalog/options?table=articles&column=url','GET'],['/v1/rows/push','POST'],['/v1/rows/insert','POST'],['/v1/rows/patch','POST']])
    expect((await call(path,method,method==='POST'?insert():undefined)).status).toBe(403);
});

test('projected keyset requires ID access and never accepts malformed grant suffixes',async()=>{
  for(const scopes of [['tables:read:articles:url'],['tables:read:articles:*'],['tables:read:articles:id:extra'],['tables:read:Articles:id']]){
    const {call}=await setup(scopes);
    expect((await call('/v1/rows/pull','POST',{table:'articles',columns:['url']})).status).toBe(403);
  }
});

test('manual Resolve keeps broad table-write authorization and denies read-only consumers',async()=>{
  for(const scopes of [['tables:read'],['tables:read:articles'],['tables:write:articles']]) {
    const {call}=await setup(scopes);
    expect((await call('/v1/derive/resolve','POST',{})).status).toBe(403);
  }
  const {call}=await setup(['tables:write'],rowDb());
  expect((await call('/v1/derive/resolve','POST',{})).status).toBe(400);
});

const provenanceTable = `CREATE TABLE provenance(id TEXT PRIMARY KEY,from_kind TEXT,from_ref TEXT,to_kind TEXT,to_ref TEXT,rel TEXT,field TEXT,detail TEXT,asserted_by TEXT,inputs_hash TEXT,value_hash TEXT,produced_at TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT)`;
test('narrow inserts leave derived columns to the hub, which derives them as for a full writer',async()=>{
  const db=rowDb();
  db.db.exec(`ALTER TABLE articles ADD COLUMN title TEXT;${provenanceTable};
    INSERT INTO catalog_properties(id,tbl,col,type,derived_by,inputs) VALUES ('articles.title','articles','title','text','http:title','["url"]')`);
  const fetch=spyOn(globalThis,'fetch').mockImplementation(async()=>new Response(JSON.stringify({title:'Derived'})));
  try {
    const {call,pending}=await setup(['tables:write:articles'],db,{DERIVATIONS:JSON.stringify({title:{url:'https://derive.example'}})});
    const created=await call('/v1/rows/insert','POST',insert());
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({inserted:['b'],existing:[],rejected:[]});
    await Promise.all(pending);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(db.db.query("SELECT title FROM articles WHERE id='b'").get().title).toBe('Derived');
    // Supplying a derived column, or an upsert of the table, stays denied.
    expect((await call('/v1/rows/insert','POST',insert({columns:['id','url','title','updated_at'],rows:[{id:'c',url:'https://example.test/c',updated_at:revision}]}))).status).toBe(403);
    expect((await call('/v1/rows/push','POST',insert({rows:[{id:'b',url:'https://example.test/d',updated_at:'2026-10-03T00:00:01.000Z'}]}))).status).toBe(403);
    expect(db.db.query("SELECT count(*) AS n FROM articles WHERE id IN ('c','d')").get().n).toBe(0);
  } finally { fetch.mockRestore(); }
});

// The guard reads another table, but only for a tombstoned changed row.
const deletionGuard = "SELECT a.id FROM changed a WHERE a.deleted_at IS NOT NULL AND (EXISTS (SELECT 1 FROM secrets s WHERE s.deleted_at IS NULL AND s.value = a.id) OR EXISTS (SELECT 1 FROM secrets s WHERE s.id = a.id))";
test('narrow inserts of live rows keep a deletion invariant that reads another table',async()=>{
  const db=rowDb();
  db.db.exec(`INSERT INTO articles(id,url,updated_at,deleted_at) VALUES ('s','https://example.test/s','${revision}','${revision}')`);
  db.db.query("INSERT INTO catalog_rules VALUES ('guard','articles','invariant',1,'table',?,NULL)").run(deletionGuard);
  const {call}=await setup(['tables:write:articles'],db);
  const created=await call('/v1/rows/insert','POST',insert({rows:[{id:'b',url:'https://example.test/b',updated_at:revision},{id:'s',url:'https://example.test/x',updated_at:revision}]}));
  expect(created.status).toBe(200);
  // The existing tombstone is reported unchanged; the guard never evaluates it.
  expect(await created.json()).toEqual({inserted:['b'],existing:['s'],rejected:[]});
  // A write that can tombstone a row would evaluate the guard, so it is denied.
  expect((await call('/v1/rows/insert','POST',insert({columns:['id','url','updated_at','deleted_at'],rows:[{id:'c',url:'u',updated_at:revision,deleted_at:null}]}))).status).toBe(403);
  expect((await call('/v1/rows/push','POST',insert())).status).toBe(403);
  db.db.exec("ALTER TABLE articles RENAME TO old_articles; CREATE TABLE articles(id TEXT PRIMARY KEY,url TEXT,updated_at TEXT,deleted_at TEXT DEFAULT 'x',hub_at TEXT)");
  expect((await call('/v1/rows/insert','POST',insert({rows:[{id:'e',url:'u',updated_at:revision}]}))).status).toBe(403);
});
