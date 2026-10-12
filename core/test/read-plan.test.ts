import { afterEach, expect, test } from 'bun:test';
import * as core from '../src/index.ts';
import { TestSql, schema, T0 } from './support.ts';
import views from '../schema/saved-views.json';
import { Database } from 'bun:sqlite';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const open: TestSql[] = [];
afterEach(() => { for (const db of open.splice(0)) db.db.close(); });
async function fixture() {
  const db = new TestSql(); open.push(db);
  for (const sql of schema) await db.run(sql);
  await db.run('CREATE TABLE catalog_tables(id TEXT PRIMARY KEY,kind TEXT,display TEXT,deleted_at TEXT)');
  await db.run("INSERT INTO catalog_tables VALUES ('items','table','name',NULL)");
  await db.run('ALTER TABLE items ADD COLUMN due TEXT');
  await db.run('ALTER TABLE items ADD COLUMN status TEXT');
  await db.run('ALTER TABLE catalog_properties ADD COLUMN source TEXT');
  await db.run('ALTER TABLE catalog_properties ADD COLUMN source_ref TEXT');
  for (const [col,type,options] of [['name','text',null],['due','date_or_datetime',null],['status','select','[{"v":"later"},{"v":"first"}]']]) {
    await db.run('INSERT INTO catalog_properties(id,tbl,col,type,options) VALUES (?,?,?,?,?)',[`items.${col}`,'items',col,type,options]);
  }
  for (const sql of views.ddl) await db.run(sql);
  for (const [table,rows] of [['catalog_tables',[views.table]],['catalog_properties',views.properties]] as const) for (const row of rows) {
    const keys=Object.keys(row);
    await db.run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`,Object.values(row));
  }
  return db;
}
const context = (today:string,start=today+'T03:00:00.000Z',end=new Date(Date.parse(start)+86400000).toISOString()) => ({today,start,end});
const args = {workspaceID:'workspace-fixture',replicaID:'replica-fixture',table:'items',kind:'list' as const};
async function saved(db:TestSql,filters:any[], extra:object={}) {
  const definition={version:2,timeZone:'UTC',dayStartMinutes:180,filters,...extra};
  await db.run('INSERT INTO views(id,name,tbl,definition,updated_at) VALUES (?,?,?,?,?)',['today-view','Today fixture','items',JSON.stringify(definition),T0]);
  return {...args,viewID:'today-view',expectedViewUpdatedAt:T0};
}
const bind = (plan:any,calendar:any) => plan.parameters.map((p:any)=>p.kind==='calendar'?calendar[p.slot]:p.value);
async function execute(db:TestSql,plan:any,calendar:any,identity={workspaceID:args.workspaceID,replicaID:args.replicaID}) {
  if(plan.version!==1 || plan.workspaceID!==identity.workspaceID || plan.replicaID!==identity.replicaID) throw new Error('identity/version drift');
  return db.transaction(async()=>{
    for(const guard of plan.guards) expect(await db.all(guard.sql,guard.parameters)).toEqual(guard.expectedRows);
    return db.all(plan.sql,bind(plan,calendar));
  });
}

test('real plan rebinds relative operands while an equal literal stays literal across 03:00', async()=>{
  const db=await fixture();
  for(const [id,due,name] of [['a','2026-10-07','2026-10-07'],['b','2026-10-08','2026-10-07'],['c','2026-10-08','2026-10-08'],['n',null,'2026-10-07']]) await db.run('INSERT INTO items(id,due,name) VALUES (?,?,?)',[id,due,name]);
  const input=await saved(db,[{column:'due',op:'eq',relative:'today'},{column:'name',op:'eq',value:'2026-10-07'}]);
  const plan=await core.prepareReadPlan(db,input);
  expect(plan.parameters.filter(p=>p.kind==='calendar').map(p=>p.slot)).toEqual(['today','start','end']);
  expect(plan.parameters).toContainEqual({kind:'literal',value:'2026-10-07'});
  for(const day of ['2026-10-07','2026-10-08']) {
    const calendar=context(day), view=(await core.loadSavedView(db,'today-view')).view!;
    const eager=core.compileView({...view,calendar,columns:plan.columns,limit:20},(await core.readCatalog(db)).properties);
    expect(await execute(db,plan,calendar)).toEqual(await db.all(eager.sql,eager.params));
  }
  expect((await execute(db,plan,context('2026-10-08'))).map(r=>r.id)).toEqual(['b']);
});

test.each([
  ['2026-03-08','2026-03-08T07:00:00.000Z','2026-03-09T06:30:00.000Z'],
  ['2026-11-01','2026-11-01T05:30:00.000Z','2026-11-02T06:30:00.000Z'],
  ['2011-12-31','2011-12-30T10:00:00.000Z','2011-12-31T10:00:00.000Z'],
])('plan preserves eager semantics for gap/fold/skipped date %s',async(today,start,end)=>{
  const db=await fixture(), input=await saved(db,[{column:'due',op:'eq',relative:'today'}]);
  for(const [id,due] of [['date',today],['start',start],['end',end],['before',new Date(Date.parse(start)-1).toISOString()],['invalid','unknown'],['null',null]]) await db.run('INSERT INTO items(id,due,name) VALUES (?,?,?)',[id,due,id]);
  const plan=await core.prepareReadPlan(db,input), calendar={today,start,end};
  expect((await execute(db,plan,calendar)).map(r=>r.id)).toEqual(['date','start']);
});

test('list projection and count have independent bounded limits and option ordering',async()=>{
  const db=await fixture();
  db.db.exec("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10050) INSERT INTO items(id,name,status) SELECT printf('%06d',x),'title',CASE WHEN x%2=0 THEN 'later' ELSE 'first' END FROM n");
  const input=await saved(db,[],{sort:[{column:'status',direction:'asc',mode:'options'}]});
  const list=await core.prepareReadPlan(db,input),count=await core.prepareReadPlan(db,{...input,kind:'count'});
  expect(list.columns).toEqual(['id','name']);
  const rows=await execute(db,list,context('2026-10-07'));
  expect(rows).toHaveLength(20); expect(rows[0].id).toBe('000002'); expect(Object.keys(rows[0])).toEqual(['id','name']);
  expect(await execute(db,count,context('2026-10-07'))).toEqual([{count:10001}]);
  expect(count.maximumRows).toBe(10001);
});

test.each(['schema','catalog','view'] as const)('guards reject %s drift before returning records',async kind=>{
  const db=await fixture(),input=await saved(db,[]),plan=await core.prepareReadPlan(db,input);
  if(kind==='schema')await db.run('ALTER TABLE items ADD COLUMN extra TEXT');
  if(kind==='catalog')await db.run("UPDATE catalog_properties SET options='[{\"v\":\"first\"},{\"v\":\"later\"}]' WHERE col='status'");
  if(kind==='view')await db.run("UPDATE views SET definition=json_set(definition,'$.dayStartMinutes',181) WHERE id='today-view'");
  await expect(execute(db,plan,context('2026-10-07'))).rejects.toThrow();
});

test('an index added or dropped after preparation keeps a published plan current',async()=>{
  const db=await fixture(),input=await saved(db,[]),plan=await core.prepareReadPlan(db,input);
  await db.run("INSERT INTO items(id,name,status,updated_at) VALUES ('a','A','first',?)",[T0]);
  await db.run('CREATE INDEX items_status ON items(status, due) WHERE deleted_at IS NULL');
  expect(await execute(db,plan,context('2026-10-07'))).toEqual([{id:'a',name:'A'}]);
  await db.run('DROP INDEX items_status');
  expect(await execute(db,plan,context('2026-10-07'))).toEqual([{id:'a',name:'A'}]);
});

test('workspace/replica identity and calendar policy are explicit, selected view revision is checked',async()=>{
  const db=await fixture(),input=await saved(db,[]),plan=await core.prepareReadPlan(db,input);
  expect(plan.calendarPolicy).toEqual({timeZone:'UTC',dayStartMinutes:180});
  expect(plan.viewID).toBe('today-view'); expect(plan.viewUpdatedAt).toBe(T0);
  await expect(execute(db,plan,context('2026-10-07'),{workspaceID:'other',replicaID:args.replicaID})).rejects.toThrow(/identity/);
  await expect(core.prepareReadPlan(db,{...input,expectedViewUpdatedAt:'2026-01-02T00:00:00.000Z'})).rejects.toThrow(/changed|revision/i);
});

test('a relative view without a timezone publishes a device-zone calendar policy',async()=>{
  const db=await fixture();
  await db.run('INSERT INTO views(id,name,tbl,definition,updated_at) VALUES (?,?,?,?,?)',['device-view','Device fixture','items',JSON.stringify({version:2,dayStartMinutes:180,filters:[{column:'due',op:'lte',relative:'today'}]}),T0]);
  const plan=await core.prepareReadPlan(db,{...args,viewID:'device-view',expectedViewUpdatedAt:T0});
  expect(plan.calendarPolicy).toEqual({dayStartMinutes:180});
});

test('a view with no timezone and no relative filter needs no calendar policy',async()=>{
  const db=await fixture();
  await db.run('INSERT INTO views(id,name,tbl,definition,updated_at) VALUES (?,?,?,?,?)',['plain-view','Plain fixture','items',JSON.stringify({version:2,dayStartMinutes:180}),T0]);
  expect((await core.prepareReadPlan(db,{...args,viewID:'plain-view',expectedViewUpdatedAt:T0})).calendarPolicy).toBeNull();
});

test('nonempty FTS is rejected without draining any queue or changing the database',async()=>{
  const db=await fixture(),input=await saved(db,[],{search:'title'});
  const before=await db.all('SELECT name,sql FROM sqlite_master ORDER BY name');
  await expect(core.prepareReadPlan(db,input)).rejects.toThrow(/search|FTS/i);
  expect(await db.all('SELECT name,sql FROM sqlite_master ORDER BY name')).toEqual(before);
});

test('direct table plans reject missing/uncatalogued targets and malformed input without writes',async()=>{
  const db=await fixture();
  const plan=await core.prepareReadPlan(db,args);
  expect(plan.calendarPolicy).toBeNull(); expect(plan.viewID).toBeNull();
  await expect(core.prepareReadPlan(db,{...args,table:'absent'})).rejects.toThrow();
  await expect(core.prepareReadPlan(db,{...args,kind:'anything'} as any)).rejects.toThrow();
  await expect(core.prepareReadPlan(db,{...args,workspaceID:''})).rejects.toThrow();
  expect(await db.all('SELECT * FROM history')).toEqual([]);
});

test.each(['eq','ne','gt','gte','lt','lte'] as const)('all relative operators preserve eager SQL membership: %s',async op=>{
  const db=await fixture(),input=await saved(db,[{column:'due',op,relative:'today'}]);
  for(const [index,due] of ['2026-10-06','2026-10-07','2026-10-08','2026-10-07T02:59:59.999Z','2026-10-07T03:00:00.000Z','2026-10-08T03:00:00.000Z',null].entries()) await db.run('INSERT INTO items(id,due,name) VALUES (?,?,?)',[String(index),due,'title']);
  const plan=await core.prepareReadPlan(db,input),view=(await core.loadSavedView(db,'today-view')).view!,props=(await core.readCatalog(db)).properties;
  for(const today of ['2026-10-06','2026-10-07']) {
    const calendar=context(today),eager=core.compileView({...view,columns:plan.columns,calendar,limit:20},props);
    expect(await execute(db,plan,calendar)).toEqual(await db.all(eager.sql,eager.params));
  }
});

test('serialized plan reads a reopened snapshot at a later day with the host gone',async()=>{
  const db=await fixture(),input=await saved(db,[{column:'due',op:'eq',relative:'today'}]);
  await db.run("INSERT INTO items(id,name,due) VALUES ('tomorrow','future title','2026-10-08')");
  const plan=JSON.parse(JSON.stringify(await core.prepareReadPlan(db,input)));
  const dir=mkdtempSync(join(tmpdir(),'core-read-plan-'));
  try {
    const path=join(dir,'snapshot.sqlite');writeFileSync(path,db.db.serialize());db.db.close();
    db.db=new Database(path,{readonly:true});
    // A real read transaction on the reopened immutable replica; no compiler,
    // initCore, FTS drain, or live host call occurs during extension execution.
    db.transaction=async body=>{db.db.exec('BEGIN');try {const value=await body();db.db.exec('COMMIT');return value;}catch(error){db.db.exec('ROLLBACK');throw error;}};
    expect(await execute(db,plan,context('2026-10-08'))).toEqual([{id:'tomorrow',name:'future title'}]);
    await expect(db.run("UPDATE items SET name='cannot write'")).rejects.toThrow();
  }finally{db.db.close();rmSync(dir,{recursive:true});}
});

test('hub identity drift, catalog deletion and unknown versions fail closed',async()=>{
  const db=await fixture();
  await db.run('CREATE TABLE _core_state(key TEXT PRIMARY KEY,value TEXT)');
  await db.run("INSERT INTO _core_state VALUES ('hub','https://fixture.invalid')");
  const plan=await core.prepareReadPlan(db,args);
  await expect(execute(db,{...plan,version:2},context('2026-10-07'))).rejects.toThrow(/version/);
  await db.run("UPDATE _core_state SET value='https://other.invalid'");
  await expect(execute(db,plan,context('2026-10-07'))).rejects.toThrow();
  await db.run("UPDATE _core_state SET value='https://fixture.invalid'");
  await db.run("UPDATE catalog_tables SET deleted_at=? WHERE id='items'",[T0]);
  await expect(execute(db,plan,context('2026-10-07'))).rejects.toThrow();
});

test('preparation snapshots input before awaiting and never invokes argument getters',async()=>{
  const db=await fixture(),original=db.transaction.bind(db);
  let release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve});
  db.transaction=async body=>{await hold;return original(body)};
  const input={...args}; const preparing=core.prepareReadPlan(db,input);input.table='absent';release();
  expect((await preparing).table).toBe('items');
  let called=false;
  await expect(core.prepareReadPlan(db,{...args,get table(){called=true;return 'items'}})).rejects.toThrow(/arguments/);
  expect(called).toBe(false);
});

test('oversized metadata is unavailable instead of weakening or truncating guards',async()=>{
  const db=await fixture();
  await db.run('ALTER TABLE catalog_tables ADD COLUMN purpose TEXT');
  await db.run("UPDATE catalog_tables SET purpose=? WHERE id='items'",['x'.repeat(270000)]);
  await expect(core.prepareReadPlan(db,args)).rejects.toThrow(/budget/);
});
