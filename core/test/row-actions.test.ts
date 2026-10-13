import { afterEach, expect, test } from 'bun:test';
import * as core from '../src/index.ts';
import manifest from '../schema/saved-views.json';
import {schema,TestSql,T0} from './support.ts';

const dbs:TestSql[]=[];
afterEach(()=>{for(const db of dbs.splice(0))db.db.close();});
async function fixture() {
  const db=new TestSql();dbs.push(db);
  for(const ddl of schema)await db.run(ddl);
  await db.run('ALTER TABLE items ADD COLUMN state TEXT');
  await db.run('ALTER TABLE catalog_properties ADD COLUMN source TEXT');
  await db.run('ALTER TABLE catalog_properties ADD COLUMN source_ref TEXT');
  await db.run('CREATE TABLE catalog_tables(id TEXT PRIMARY KEY,kind TEXT,display TEXT,deleted_at TEXT)');
  await db.run("INSERT INTO catalog_tables(id,kind,display) VALUES ('items','table','name')");
  await db.run("INSERT INTO catalog_properties(id,tbl,col,type,options) VALUES ('items.name','items','name','text',NULL),('items.qty','items','qty','int',NULL),('items.state','items','state','select','[{\"v\":\"Open\"},{\"v\":\"Closed\"}]')");
  for(const id of ['a','b'])await db.run('INSERT INTO items(id,name,qty,state,created_at,updated_at) VALUES (?,?,?,?,?,?)',[id,'Original',3,'Open',T0,T0]);
  for(const ddl of manifest.ddl)await db.run(ddl);
  await db.run('INSERT INTO catalog_tables(id,kind,display) VALUES (?,?,?)',[manifest.table.id,manifest.table.kind,manifest.table.display]);
  for(const p of manifest.properties){const keys=Object.keys(p);await db.run(`INSERT INTO catalog_properties(${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`,Object.values(p) as core.Value[]);}
  const h=core.createCoreHandlers(db,()=>{throw Error('Actions must use local writes');},'fixture');
  const definition:core.SavedViewDefinition={version:2,columns:['state'],actions:[{id:'close',label:'Close',values:{state:'Closed'}}],layout:[{kind:'action',id:'close'},{kind:'column',id:'state'}]};
  const view=await core.saveView(db,{table:'items',name:'Review',definition});
  const run=(extra:Record<string,unknown>={})=>h.runRowAction({viewId:view.id,actionId:'close',rowId:'a',expectedUpdatedAt:T0,expectedViewUpdatedAt:view.updated_at!,...extra});
  return {db,h,view,run,definition};
}
const item=(db:TestSql,id='a')=>db.all('SELECT * FROM items WHERE id=?',[id]).then(rows=>rows[0]);
const history=(db:TestSql)=>db.all("SELECT col,old,new FROM history WHERE tbl='items' ORDER BY updated_at,id");

test('a saved action edits only its target through history and undo with a full row',async()=>{
  const {db,h,view,run}=await fixture(),other=await item(db,'b');
  expect(view.definition?.layout).toEqual([{kind:'action',id:'close'},{kind:'column',id:'state'}]);
  const result=await run();expect(result).toMatchObject({id:'a',name:'Original',qty:3,state:'Closed'});
  expect(await item(db,'b')).toEqual(other);
  expect(await history(db)).toEqual([{col:'state',old:'Open',new:'Closed'}]);
  const receipt=(await h.undoStatus({})).action!;expect(receipt).toMatchObject({table:'items',rowId:'a',kind:'edit'});
  expect(await h.undo({receiptId:receipt.receiptId})).toMatchObject({id:'a',name:'Original',qty:3,state:'Open'});
});

test('double clicks and stale actions cannot overwrite a later edit or append history',async()=>{
  const {db,run}=await fixture();
  const results=await Promise.allSettled([run(),run()]);
  expect(results.map(r=>r.status)).toEqual(['fulfilled','rejected']);
  const before=await item(db),log=await history(db);
  await expect(run()).rejects.toThrow();expect(await item(db)).toEqual(before);expect(await history(db)).toEqual(log);
});

test('an action requires the displayed saved-view revision and the selected row revision',async()=>{
  const {db,h,run,view,definition}=await fixture();
  const before=await item(db),log=await history(db),undo=await h.undoStatus({});
  const changed=await core.saveView(db,{table:'items',id:view.id,name:view.name,
    expectedUpdatedAt:view.updated_at!,definition:{...definition,actions:[{id:'close',label:'Rename',values:{name:'Current definition'}}]}});
  await expect(run()).rejects.toThrow('Saved view changed');
  expect(await item(db)).toEqual(before);expect(await history(db)).toEqual(log);
  expect(await h.undoStatus({})).toEqual(undo);
  expect(await run({expectedViewUpdatedAt:changed.updated_at})).toMatchObject({name:'Current definition',state:'Open'});
});

test('a same-ID action changed while execution waits for the writer transaction cannot execute',async()=>{
  const {db,h,run,view,definition}=await fixture();
  await h.write({table:'items',patch:{id:'b',qty:9},expectedUpdatedAt:T0});
  const before=await item(db),log=await history(db),undo=await h.undoStatus({});
  const transaction=db.transaction.bind(db);
  let entered!:()=>void,release!:()=>void;
  const waiting=new Promise<void>(resolve=>{entered=resolve;}),ready=new Promise<void>(resolve=>{release=resolve;});
  db.transaction=async body=>{db.transaction=transaction;entered();await ready;return transaction(body);};
  const pending=Promise.resolve(run());
  // Attach the rejection handler before releasing the transaction gate.
  const result=pending.then(value=>({value,error:null}),error=>({value:null,error}));
  await waiting;
  try {
    await core.saveView(db,{table:'items',id:view.id,name:view.name,expectedUpdatedAt:view.updated_at!,
      definition:{...definition,actions:[{id:'close',label:'Close',values:{state:'Closed',qty:99}}]}});
  } finally { release(); }
  const outcome=await result;
  expect(outcome.value).toBeNull();expect(outcome.error?.message).toContain('Saved view changed');
  expect(await item(db)).toEqual(before);expect(await history(db)).toEqual(log);
  expect(await h.undoStatus({})).toEqual(undo);
});

test('absent targets and missing or invalid view and row revisions fail closed',async()=>{
  const {db,run}=await fixture();
  for(const args of [{actionId:'missing'},{rowId:'missing'},{viewId:'missing'},
    {expectedUpdatedAt:undefined},{expectedViewUpdatedAt:undefined},
    {expectedViewUpdatedAt:null},{expectedViewUpdatedAt:'invalid'}])await expect(run(args)).rejects.toThrow();
  expect(await item(db)).toMatchObject({name:'Original',state:'Open'});expect(await history(db)).toEqual([]);
});

test('deleted rows and deleted or invalid saved views cannot run actions',async()=>{
  const {db,run,view,definition}=await fixture();
  await db.run('UPDATE items SET deleted_at=? WHERE id=?',[T0,'a']);
  await expect(run()).rejects.toThrow();expect(await history(db)).toEqual([]);
  await db.run('UPDATE items SET deleted_at=NULL WHERE id=?',['a']);
  await db.run('UPDATE views SET deleted_at=? WHERE id=?',[T0,view.id]);await expect(run()).rejects.toThrow();
  await db.run('UPDATE views SET deleted_at=NULL,definition=? WHERE id=?',[JSON.stringify({...definition,actions:[{id:'close',label:'Invalid',values:{state:'Unknown'}}]}),view.id]);
  await expect(run()).rejects.toThrow();expect(await history(db)).toEqual([]);
  expect((await core.listViews(db,{table:'items'})).views[0].unavailable).toBeTruthy();
});

test.each(['id','created_at','updated_at','hub_at','deleted_at','missing'])('actions cannot write structural or absent column %s',async column=>{
  const {db,definition}=await fixture(),before=await db.all('SELECT * FROM views');
  await expect(core.saveView(db,{table:'items',name:'Unsafe',definition:{...definition,actions:[{id:'close',label:'Unsafe',values:{[column]:'changed'}}]}} as core.SaveViewArgs)).rejects.toThrow();
  expect(await db.all('SELECT * FROM views')).toEqual(before);expect(await history(db)).toEqual([]);
});

test.each(['immutable=1',"derived_by='http:fixture'"])('catalog write restrictions apply to actions: %s',async change=>{
  const {db,run}=await fixture();await db.run(`UPDATE catalog_properties SET ${change} WHERE col='state'`);
  await expect(run()).rejects.toThrow();expect(await item(db)).toMatchObject({state:'Open'});expect(await history(db)).toEqual([]);
  expect((await core.listViews(db,{table:'items'})).views[0].unavailable).toBeTruthy();
});

test('a failed action preserves the preceding edit and its undo receipt',async()=>{
  const {db,h,run}=await fixture();
  await h.write({table:'items',patch:{id:'a',qty:9},expectedUpdatedAt:T0});
  const previous=await h.undoStatus({});
  await expect(run()).rejects.toThrow();expect(await h.undoStatus({})).toEqual(previous);
  expect(await h.undo({receiptId:previous.action!.receiptId})).toMatchObject({qty:3,state:'Open'});
  expect(await item(db,'b')).toMatchObject({qty:3,state:'Open',updated_at:T0});
});

test('unknown layout references affect only that view, preserving other definitions',async()=>{
  const {db,definition}=await fixture();
  await core.saveView(db,{table:'items',name:'Plain',definition:{version:1}});
  for(const layout of [[{kind:'action',id:'absent'}],[{kind:'column',id:'absent'}],[{kind:'script',id:'close'}],[{kind:'action',id:'close'},{kind:'action',id:'close'}]]){
    await expect(core.saveView(db,{table:'items',name:'Invalid',definition:{...definition,layout}} as core.SaveViewArgs)).rejects.toThrow();
  }
  expect((await core.listViews(db,{table:'items'})).views).toHaveLength(2);
});

test('null action lists and service-owned targets are unavailable without writes',async()=>{
  const {db,run}=await fixture();
  await expect(core.saveView(db,{table:'items',name:'Invalid',definition:{version:2,actions:null}} as unknown as core.SaveViewArgs)).rejects.toThrow();
  await db.run("UPDATE catalog_tables SET kind='system' WHERE id='items'");
  await expect(run()).rejects.toThrow();
  expect((await core.listViews(db,{table:'items'})).views[0].unavailable).toBeTruthy();
  expect(await history(db)).toEqual([]);
});

test('failed outer commit does not publish an action undo receipt',async()=>{
  const {db,h,run}=await fixture();
  const transaction=db.transaction.bind(db);db.transaction=body=>transaction(async()=>{await body();throw Error('commit failed');});
  await expect(run()).rejects.toThrow('commit failed');
  db.transaction=transaction;
  expect(await h.undoStatus({})).toEqual({action:null});expect(await item(db)).toMatchObject({state:'Open'});
});

test('action layout widths survive save and reload and reject invalid values', async () => {
  const {db, view, definition} = await fixture();
  const saved = await core.saveView(db, {table:'items', id:view.id, name:view.name,
    expectedUpdatedAt:view.updated_at!, definition:{...definition,
      layout:[{kind:'action',id:'close',width:312},{kind:'column',id:'state'}]}});
  expect((await core.listViews(db,{table:'items'})).views[0].definition?.layout?.[0]).toEqual({kind:'action',id:'close',width:312});
  for (const width of [0,-1,NaN,Infinity,'312',null]) {
    await expect(core.saveView(db,{table:'items',id:view.id,name:view.name,
      expectedUpdatedAt:saved.updated_at!,definition:{...definition,
        layout:[{kind:'action',id:'close',width},{kind:'column',id:'state'}]}} as unknown as core.SaveViewArgs)).rejects.toThrow();
  }
});

test('hidden catalog columns retain their layout position without changing the projection', async () => {
  const {db,view,definition} = await fixture();
  const saved = await core.saveView(db,{table:'items',id:view.id,name:view.name,
    expectedUpdatedAt:view.updated_at!,definition:{...definition,
      layout:[{kind:'column',id:'qty'},{kind:'column',id:'state'},{kind:'action',id:'close'}]}});
  expect(saved.definition?.columns).toEqual(['state']);
  expect(saved.definition?.layout?.[0]).toEqual({kind:'column',id:'qty'});
});
