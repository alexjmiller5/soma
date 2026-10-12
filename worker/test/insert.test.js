import { expect, test, spyOn } from 'bun:test';
import { D1Shim } from './d1shim.js';
import worker, { ROUTES, allowed } from '../src/index.js';

const T0 = '2025-01-01T00:00:00.000Z', T1 = '2025-01-02T00:00:00.000Z';
function fresh() {
  const db = new D1Shim();
  db.db.exec(`CREATE TABLE items(id TEXT PRIMARY KEY, name TEXT DEFAULT 'default', status TEXT, qty INTEGER DEFAULT 4, label TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT);
    CREATE TABLE catalog_properties(id TEXT PRIMARY KEY,tbl TEXT,col TEXT,type TEXT,required INTEGER,sort INTEGER,options TEXT,options_sql TEXT,ref_table TEXT,derived_by TEXT,inputs TEXT,deleted_at TEXT);
    CREATE TABLE catalog_rules(id TEXT PRIMARY KEY,tbl TEXT,col TEXT,kind TEXT,enforce INTEGER,sql TEXT,text TEXT,deleted_at TEXT);
    CREATE TABLE history(id TEXT PRIMARY KEY,tbl TEXT,row_id TEXT,col TEXT,old TEXT,new TEXT,origin TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT);
    CREATE TABLE provenance(id TEXT PRIMARY KEY,to_kind TEXT,to_ref TEXT,field TEXT,from_kind TEXT,from_ref TEXT,rel TEXT,asserted_by TEXT,inputs_hash TEXT,value_hash TEXT,produced_at TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT);
    INSERT INTO catalog_properties(id,tbl,col,type,required) VALUES ('name','items','name','text',1);
    INSERT INTO catalog_properties(id,tbl,col,type,options) VALUES ('status','items','status','select','[{"v":"saved"},{"v":"new"}]');
    INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('qty','items','qty','int');`);
  return db;
}
const body = rows => ({table:'items',columns:[...new Set(rows.flatMap(Object.keys))],rows});
const insert = (db, rows, extra={}) => ROUTES['/v1/rows/insert']({...body(rows),...extra}, db);
const rows = db => db.db.query('SELECT * FROM items ORDER BY id').all();
const history = db => db.db.query('SELECT * FROM history').all();

for (const deleted of [null,T0]) for (const stamp of [null,'invalid','2099-01-01T00:00:00.000Z']) {
  test(`existing ${deleted ? 'tombstone' : 'row'} ignores invalid initializer (${stamp})`, async () => {
    const db = fresh();
    db.db.query('INSERT INTO items(id,name,status,deleted_at,updated_at,hub_at) VALUES (?,?,?,?,?,?)').run('kept','saved','saved',deleted,T0,T0);
    db.db.exec("INSERT INTO history(id,old,new) VALUES ('prior','old','saved')");
    const before = rows(db), beforeHistory = history(db);
    const out = await insert(db,[{id:'kept',name:null,status:{invalid:true},updated_at:stamp,deleted_at:null,hub_at:'forged'}]);
    expect(out).toEqual({inserted:[],existing:['kept'],rejected:[]});
    expect(rows(db)).toEqual(before);
    expect(history(db)).toEqual(beforeHistory);
  });
}

test('new values/defaults are validated and only committed IDs are acknowledged', async () => {
  const db = fresh();
  const input = [{id:'a',updated_at:T0},{id:'bad',name:null,updated_at:T0},{id:'unstamped',name:'value'}];
  const out = await insert(db,input);
  expect(out.inserted).toEqual(['a']);
  expect(out.existing).toEqual([]);
  expect(out.rejected.map(r=>r.id).sort()).toEqual(['bad','unstamped']);
  const before = rows(db);
  expect(before).toEqual([expect.objectContaining({id:'a',name:'default',qty:4,updated_at:T0})]);
  expect(before[0].hub_at > T0).toBe(true);
  expect((await insert(db,input)).existing).toEqual(['a']);
  expect(rows(db)).toEqual(before);
  expect(history(db)).toEqual([]);
});

for (const extra of [{history:[]},{history:null},{history:[{}]}]) test('history field fails before writes: '+JSON.stringify(extra), async () => {
  const db = fresh();
  const out = await insert(db,[{id:'a',updated_at:T0}],extra);
  expect(out.status).toBe(400);
  expect(rows(db)).toEqual([]);
  expect(history(db)).toEqual([]);
});
for (const input of [
  [{id:'a',updated_at:T0},{id:'a',name:'second',updated_at:T1}],
  [{id:'a',updated_at:T0},{name:'missing ID',updated_at:T0}],
  [{id:'a',updated_at:T0},{id:'',updated_at:T0}],
  [{id:'a',updated_at:T0},{id:3,updated_at:T0}],
]) test('invalid identity batch fails before any mutation: '+JSON.stringify(input), async () => {
  const db = fresh();
  const out = await insert(db,input);
  expect(out.status).toBe(400);
  expect(rows(db)).toEqual([]);
  expect(history(db)).toEqual([]);
});

test('unlisted keys are not initializer values, and id must be listed', async () => {
  const db = fresh();
  const out = await insert(db,[{id:'a',name:null,updated_at:T0}],{columns:['id','updated_at']});
  expect(out.inserted).toEqual(['a']);
  expect(rows(db)[0].name).toBe('default');
  const invalid = await insert(db,[{id:'b',updated_at:T0}],{columns:['updated_at']});
  expect(invalid.status).toBe(400);
  expect(rows(db).map(r=>r.id)).toEqual(['a']);
});

for (const deleted of [null,T0]) test('competing insert is preserved, then retry reports existing: '+deleted, async () => {
  const db = fresh();
  const batch = db.batch.bind(db);
  let raced = false;
  db.batch = async statements => {
    if (!raced) {
      raced = true;
      db.db.query('INSERT INTO items(id,name,status,updated_at,deleted_at,hub_at) VALUES (?,?,?,?,?,?)').run('race','saved','saved',T0,deleted,T0);
    }
    return batch(statements);
  };
  const input = [{id:'race',name:'initializer',status:'new',updated_at:T1}];
  const out = await insert(db,input);
  expect(out.inserted).toEqual([]);
  expect(out.rejected).toEqual([expect.objectContaining({id:'race',rule:'write-conflict',retryable:true})]);
  expect(await insert(db,input)).toEqual({inserted:[],existing:['race'],rejected:[]});
  expect(rows(db)).toEqual([expect.objectContaining({id:'race',name:'saved',status:'saved',deleted_at:deleted,updated_at:T0,hub_at:T0})]);
  expect(history(db)).toEqual([]);
});

test('invariants roll back rejected insertions while committing valid receipts', async () => {
  const db = fresh();
  db.db.exec("INSERT INTO catalog_rules(id,tbl,kind,enforce,sql,text) VALUES ('positive','items','invariant',1,'SELECT id FROM changed WHERE qty < 0','positive quantity')");
  const out = await insert(db,[{id:'good',qty:1,updated_at:T0},{id:'bad',qty:-1,updated_at:T0}]);
  expect(out.inserted).toEqual(['good']);
  expect(out.rejected).toEqual([expect.objectContaining({id:'bad',rule:'positive'})]);
  expect(rows(db).map(r=>r.id)).toEqual(['good']);
  expect(history(db)).toEqual([]);
  expect(db.db.query("SELECT name FROM sqlite_master WHERE name GLOB '_life_write_*'").all()).toEqual([]);
});

test('unexpected SQL failure rolls back rows, helpers and apparent receipts', async () => {
  const db = fresh();
  db.db.exec('CREATE UNIQUE INDEX unique_name ON items(name)');
  await expect(insert(db,[{id:'a',name:'same',updated_at:T0},{id:'b',name:'same',updated_at:T0}])).rejects.toThrow();
  expect(rows(db)).toEqual([]);
  expect(history(db)).toEqual([]);
  expect(db.db.query("SELECT name FROM sqlite_master WHERE name GLOB '_life_write_*'").all()).toEqual([]);
});

test('a suppressed insert cannot become a false inserted or existing receipt', async () => {
  const db = fresh();
  db.db.exec("CREATE TRIGGER ignore_insert BEFORE INSERT ON items WHEN NEW.id='ignored' BEGIN SELECT RAISE(IGNORE); END");
  const out = await insert(db,[{id:'good',updated_at:T0},{id:'ignored',updated_at:T0}]);
  expect(out.inserted).toEqual(['good']);
  expect(out.existing).toEqual([]);
  expect(out.rejected).toEqual([expect.objectContaining({id:'ignored',rule:'write-conflict',retryable:true})]);
  expect(rows(db).map(r=>r.id)).toEqual(['good']);
  expect(history(db)).toEqual([]);
});

test('only actual insertions can trigger derivations', async () => {
  const db = fresh();
  db.db.exec(`UPDATE catalog_properties SET derived_by=NULL; ALTER TABLE provenance ADD COLUMN detail TEXT;
    INSERT INTO catalog_properties(id,tbl,col,type,derived_by,inputs) VALUES ('label','items','label','text','http:label','["name"]');
    INSERT INTO items(id,name,updated_at) VALUES ('existing','saved','${T0}');`);
  const calls = [], pending = [];
  const fetch = spyOn(globalThis,'fetch').mockImplementation(async (url,options) => {
    calls.push(JSON.parse(options.body).id);
    return new Response(JSON.stringify({label:'derived'}));
  });
  try {
    const input = [{id:'existing',name:'changed',updated_at:T1},{id:'new',name:'value',updated_at:T0},{id:'bad',name:null,updated_at:T0}];
    const out = await ROUTES['/v1/rows/insert'](body(input),db,{DERIVATIONS:JSON.stringify({label:{url:'https://derive.example'}})},{waitUntil:p=>pending.push(p)});
    expect(out.inserted).toEqual(['new']);
    expect(out.existing).toEqual(['existing']);
    await Promise.all(pending);
    expect(calls).toEqual(['new']);
    expect(rows(db).find(r=>r.id==='existing')).toMatchObject({name:'saved',label:null,updated_at:T0});
    expect(history(db).map(r=>r.row_id)).toEqual(['new']);
  } finally { fetch.mockRestore(); }
});

test('route uses existing tables:write authorization and the real request envelope', async () => {
  expect(allowed('/v1/rows/insert','POST',['tables:write'])).toBe(true);
  expect(allowed('/v1/rows/insert','POST',['tables:read'])).toBe(false);
  const db = fresh();
  const response = await worker.fetch(new Request('https://hub.example/v1/rows/insert',{
    method:'POST',headers:{Authorization:'Bearer fixture'},body:JSON.stringify(body([{id:'a',updated_at:T0}]))
  }),{DB:db,HUB_TOKEN:'fixture'},{waitUntil:()=>{}});
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({inserted:['a'],existing:[],rejected:[]});
});

for (const [values,rule] of [[{status:'invalid'},'options'],[{qty:'invalid'},'type']]) test('new content respects '+rule, async () => {
  const db = fresh();
  const out = await insert(db,[{id:'bad',updated_at:T0,...values}]);
  expect(out.inserted).toEqual([]);
  expect(out.existing).toEqual([]);
  expect(out.rejected[0].rule).toBe(rule);
  expect(rows(db)).toEqual([]);
  expect(history(db)).toEqual([]);
});

test('a concurrent catalog change cannot admit an invalid new row', async () => {
  const db = fresh();
  const batch = db.batch.bind(db);
  let changed = false;
  db.batch = async statements => {
    if (!changed) {
      changed = true;
      db.db.query("UPDATE catalog_properties SET options=? WHERE id='status'").run('[{"v":"saved"}]');
    }
    return batch(statements);
  };
  const input = [{id:'a',status:'new',updated_at:T0}];
  const out = await insert(db,input);
  expect(out.inserted).toEqual([]);
  expect(out.rejected).toEqual([expect.objectContaining({id:'a',rule:'write-conflict',retryable:true})]);
  expect((await insert(db,input)).rejected[0].rule).toBe('options');
  expect(rows(db)).toEqual([]);
  expect(history(db)).toEqual([]);
});

test('existing provenance retains its original creation detail', async () => {
  const db = fresh();
  db.db.exec('ALTER TABLE provenance ADD COLUMN detail TEXT');
  db.db.query('INSERT INTO provenance(id,detail,updated_at) VALUES (?,?,?)').run('edge','{"created_row":0}',T0);
  const before = db.db.query('SELECT * FROM provenance').all();
  const out = await insert(db,[{id:'edge',detail:'{"created_row":1}',updated_at:T1}],{table:'provenance'});
  expect(out).toEqual({inserted:[],existing:['edge'],rejected:[]});
  expect(db.db.query('SELECT * FROM provenance').all()).toEqual(before);
  expect(history(db)).toEqual([]);
});

test('failure isolation accounts for existing, invalid and inserted IDs together', async () => {
  const db = fresh();
  db.db.exec(`INSERT INTO items(id,name,updated_at) VALUES ('existing','saved','${T0}');
    INSERT INTO catalog_rules(id,tbl,kind,enforce,sql,text) VALUES ('positive','items','invariant',1,'SELECT id FROM changed WHERE qty < 0','positive quantity')`);
  const out = await insert(db,[{id:'existing',name:null},{id:'good',updated_at:T0},{id:'bad',qty:-1,updated_at:T0},{id:'unstamped'}]);
  expect(out.inserted).toEqual(['good']);
  expect(out.existing).toEqual(['existing']);
  expect(out.rejected.map(r=>r.id).sort()).toEqual(['bad','unstamped']);
  expect(rows(db).map(r=>r.id)).toEqual(['existing','good']);
  expect(history(db)).toEqual([]);
});
