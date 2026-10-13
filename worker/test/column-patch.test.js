import {expect,test} from 'bun:test';
import worker from '../src/index.js';
import {D1Shim} from './d1shim.js';
import {hashToken} from '../src/auth.js';
import {validateDeviceSession} from '../../core/src/enrollment.ts';

const time='2026-01-01T00:00:00.000Z';
const reads=['id','name','enabled','deleted_at','updated_at','hub_at'].map(c=>`tables:read:contacts:${c}`);
const scopes=[...reads,'tables:patch:contacts:enabled'];
const expectation={id:'contact-editor-v1',scopes};
const ctx={waitUntil(){},access:{aud:'fixture',getIdentity:async()=>({email:'owner@example.test'})}};
function db(){
 const d=new D1Shim();d.db.exec(`
 CREATE TABLE catalog_tables(id TEXT PRIMARY KEY,kind TEXT,deleted_at TEXT);
 CREATE TABLE catalog_properties(id TEXT PRIMARY KEY,tbl TEXT,col TEXT,type TEXT,sort INTEGER,required INTEGER,options TEXT,options_sql TEXT,ref_table TEXT,default_value TEXT,derived_by TEXT,inputs TEXT,deleted_at TEXT);
 CREATE TABLE catalog_rules(id TEXT PRIMARY KEY,tbl TEXT,kind TEXT,enforce INTEGER,scope TEXT,sql TEXT,deleted_at TEXT);
 CREATE TABLE contacts(id TEXT PRIMARY KEY,name TEXT,enabled INTEGER,updated_at TEXT,hub_at TEXT,deleted_at TEXT);
 INSERT INTO contacts VALUES ('a','<person-1>',0,'${time}',NULL,NULL);
 INSERT INTO catalog_tables VALUES ('contacts','table',NULL);
 INSERT INTO catalog_properties(id,tbl,col,type,required,options) VALUES
 ('contacts.name','contacts','name','text',1,NULL),
 ('contacts.enabled','contacts','enabled','int',0,'[{"v":0},{"v":1}]');
 `);return d;
}
async function setup(grants=scopes,data=db()){
 const env={HUB_TOKEN:'root-fixture',AUTH_DB:new D1Shim(),DB:data,LOGIN_ACCESS_AUD:'fixture',
 ENROLLMENT_PROFILES:JSON.stringify({[expectation.id]:{label:'Contact Editor',scopes:grants}})};
 const mint=await worker.fetch(new Request('https://hub.test/v1/tokens/create',{method:'POST',headers:{Authorization:'Bearer root-fixture'},body:JSON.stringify({name:'editor',scopes:grants.join(',')})}),env,ctx);
 const {token}=await mint.json();
 const call=(path,body,credential=token)=>worker.fetch(new Request('https://hub.test'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+credential,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}),env,ctx);
 return {env,data,call};
}
const patch=(values={enabled:1},extra={})=>({table:'contacts',id:'a',values,expected_revision:{updated_at:time,hub_at:null},...extra});

test('column patch changes only the granted field and returns a guarded revision',async()=>{
 const {call,data}=await setup();const r=await call('/v1/rows/patch',patch());expect(r.status).toBe(200);
 const receipt=await r.json();expect(receipt.id).toBe('a');expect(Object.keys(receipt).sort()).toEqual(['id','revision']);
 const row=data.db.query('SELECT * FROM contacts').get();expect(row.name).toBe('<person-1>');expect(row.enabled).toBe(1);
 expect(receipt.revision).toEqual({updated_at:row.updated_at,hub_at:row.hub_at});
 expect((await call('/v1/rows/patch',patch({enabled:0}))).status).toBe(409);
 expect(data.db.query('SELECT enabled FROM contacts').get().enabled).toBe(1);
});

test('column authorization refuses broader routes/fields before touching data',async()=>{
 const {call}=await setup(scopes,{prepare(){throw Error('unexpected data lookup');}});
 for(const path of ['push','insert'])expect((await call('/v1/rows/'+path,patch())).status).toBe(403);
 for(const values of [{name:'changed'},{enabled:1,name:'changed'},{id:'other'},{deleted_at:null},{hub_at:time},{updated_at:time},{created_at:time}])
  expect((await call('/v1/rows/patch',patch(values))).status).toBe(403);
 for(const extra of [{table:'other'},{table:'Contacts'},{history:[]}])expect((await call('/v1/rows/patch',patch({enabled:1},extra))).status).toBe(403);
});

test('read-only and incomplete patch grants never write',async()=>{
 for(const grants of [reads,scopes.filter(s=>s!=='tables:read:contacts:enabled'),scopes.filter(s=>s!=='tables:read:contacts:hub_at'),scopes.filter(s=>s!=='tables:read:contacts:updated_at')]){
  const {call,data}=await setup(grants);expect((await call('/v1/rows/patch',patch())).status).toBe(403);
  expect(data.db.query('SELECT enabled FROM contacts').get().enabled).toBe(0);
 }
});

test('missing and deleted targets cannot be recreated or resurrected',async()=>{
 const {call,data}=await setup();expect((await call('/v1/rows/patch',patch({enabled:1},{id:'missing'}))).status).toBe(409);
 data.db.query('UPDATE contacts SET deleted_at=?').run(time);
 expect((await call('/v1/rows/patch',patch())).status).toBe(409);
 expect(data.db.query('SELECT enabled,deleted_at FROM contacts').get()).toEqual({enabled:0,deleted_at:time});
});

test('live-row patch preserves an incoming-reference deletion invariant',async()=>{
 const {call,data}=await setup();
 data.db.exec(`CREATE TABLE mentions(id TEXT PRIMARY KEY,contact_ids TEXT,deleted_at TEXT);
 INSERT INTO mentions VALUES ('m','["a"]',NULL);
 INSERT INTO catalog_rules VALUES ('incoming','contacts','invariant',1,'table',
 'SELECT p.id FROM changed p WHERE p.deleted_at IS NOT NULL AND EXISTS (SELECT 1 FROM mentions q, json_each(q.contact_ids) j WHERE q.deleted_at IS NULL AND j.value = p.id)',NULL);`);
 expect((await call('/v1/rows/patch',patch())).status).toBe(200);
 expect(data.db.query('SELECT contact_ids FROM mentions').get().contact_ids).toBe('["a"]');
 expect((await call('/v1/rows/patch',patch({deleted_at:time}))).status).toBe(403);
});

test('a lookalike deletion rule with an extra condition cannot leak ungranted data',async()=>{
 const {call,data}=await setup();
 data.db.exec(`CREATE TABLE mentions(id TEXT PRIMARY KEY,contact_ids TEXT,deleted_at TEXT);
 INSERT INTO catalog_rules VALUES ('incoming','contacts','invariant',1,'table',
 'SELECT p.id FROM changed p WHERE p.deleted_at IS NOT NULL AND EXISTS (SELECT 1 FROM mentions q, json_each(q.contact_ids) j WHERE q.deleted_at IS NULL AND j.value = p.id) OR p.enabled=1',NULL);`);
 expect((await call('/v1/rows/patch',patch())).status).toBe(403);
 expect(data.db.query('SELECT enabled FROM contacts').get().enabled).toBe(0);
});

test('live-row patch preserves a single-reference deletion invariant',async()=>{
 const {call,data}=await setup();
 data.db.exec(`CREATE TABLE quotes(id TEXT PRIMARY KEY,contact_id TEXT,deleted_at TEXT);
 INSERT INTO quotes VALUES ('q','a',NULL);
 INSERT INTO catalog_rules VALUES ('incoming','contacts','invariant',1,'table',
 'SELECT p.id FROM changed p WHERE p.deleted_at IS NOT NULL AND EXISTS (SELECT 1 FROM quotes q WHERE q.deleted_at IS NULL AND q.contact_id = p.id)',NULL);`);
 expect((await call('/v1/rows/patch',patch())).status).toBe(200);
 data.db.exec(`UPDATE catalog_rules SET sql=sql||' OR p.enabled=0'`);
 expect((await call('/v1/rows/patch',patch({enabled:0},{expected_revision:data.db.query('SELECT updated_at,hub_at FROM contacts').get()}))).status).toBe(403);
});

test('live-row patch preserves a deletion invariant grouping several tables in one parenthesized term',async()=>{
 const {call,data}=await setup();
 data.db.exec(`CREATE TABLE quotes(id TEXT PRIMARY KEY,contact_id TEXT,note TEXT,deleted_at TEXT);
 CREATE TABLE mentions(id TEXT PRIMARY KEY,contact_ids TEXT,deleted_at TEXT);
 INSERT INTO quotes VALUES ('q','a',')',NULL);INSERT INTO mentions VALUES ('m','["a"]',NULL);
 INSERT INTO catalog_rules VALUES ('incoming','contacts','invariant',1,'table',
 'SELECT p.id FROM changed p WHERE p.deleted_at IS NOT NULL AND (EXISTS (SELECT 1 FROM quotes q WHERE q.deleted_at IS NULL AND q.note != '')'' AND q.contact_id = p.id) OR EXISTS (SELECT 1 FROM mentions r, json_each(coalesce(r.contact_ids,''[]'')) j WHERE r.deleted_at IS NULL AND j.value = p.id))',NULL);`);
 expect((await call('/v1/rows/patch',patch())).status).toBe(200);
 const revision=()=>({expected_revision:data.db.query('SELECT updated_at,hub_at FROM contacts').get()});
 // A term after the group, or a group closing before the end, is not a deletion guard.
 const guard=data.db.query('SELECT sql FROM catalog_rules').get().sql;
 // A comment hiding a parenthesis is not a deletion guard either.
 for(const sql of [guard+' OR p.enabled=1',guard.replace('AND (EXISTS','AND (1) OR (EXISTS'),guard.replace(/p\.id\)\)$/,'p.id) /* ( */) OR p.enabled=1 --)')]){
  data.db.query('UPDATE catalog_rules SET sql=?').run(sql);
  expect((await call('/v1/rows/patch',patch({enabled:0},revision()))).status).toBe(403);
 }
 expect(data.db.query('SELECT enabled FROM contacts').get().enabled).toBe(1);
});

test('derived tables accept patches that touch neither derived values nor their inputs',async()=>{
 const derived=`INSERT INTO catalog_properties(id,tbl,col,type,required,derived_by,inputs) VALUES ('contacts.name','contacts','name','text',0,'http:lookup','["id"]')`;
 const {call,data}=await setup([...scopes,'tables:patch:contacts:name']);
 data.db.exec(`DELETE FROM catalog_properties WHERE id='contacts.name';${derived}`);
 expect((await call('/v1/rows/patch',patch())).status).toBe(200);
 const revision=data.db.query('SELECT updated_at,hub_at FROM contacts').get();
 expect((await call('/v1/rows/patch',patch({name:'changed'},{expected_revision:revision}))).status).toBe(403);
 data.db.exec(`UPDATE catalog_properties SET inputs='["id","enabled"]' WHERE id='contacts.name'`);
 expect((await call('/v1/rows/patch',patch({enabled:0},{expected_revision:revision}))).status).toBe(403);
 expect(data.db.query('SELECT name,enabled FROM contacts').get()).toEqual({name:'<person-1>',enabled:1});
});

test('browser approval gives exact patch authority and canonical enrollment validates it',async()=>{
 const {env}=await setup();const candidate='phone-candidate',key=await hashToken(candidate);
 const url=`https://hub.test/login?key=${key}&name=Phone&profile=${expectation.id}`;
 const r=await worker.fetch(new Request(url),env,ctx);expect(r.status).toBe(200);const html=await r.text();
 expect(html).not.toContain('Read-only access:');expect(html).toContain('tables:patch:contacts:enabled');
 const revision=html.match(/name="profileRevision" value="([0-9a-f]{64})"/)[1];
 const approval=await worker.fetch(new Request('https://hub.test/login',{method:'POST',headers:{Origin:'https://hub.test','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({key,name:'Phone',profile:expectation.id,profileRevision:revision})}),env,ctx);
 expect(approval.status).toBe(200);
 const session=await worker.fetch(new Request('https://hub.test/v1/session',{headers:{Authorization:'Bearer '+candidate}}),env,ctx);
 const info=await session.json();expect(validateDeviceSession(info,expectation).scopes.sort()).toEqual([...scopes].sort());
 expect(info.capabilities.replica_sync).toBe(false);expect(info.capabilities.governance).toBeUndefined();
 expect(()=>validateDeviceSession({...info,capabilities:{...info.capabilities,conditional_patch:undefined}},expectation)).toThrow();
});

test('writable enrollment rejects structural, missing-read and full grants',async()=>{
 for(const grants of [[...reads,'full'],[...reads,'tables:patch:contacts:deleted_at'],scopes.filter(s=>s!=='tables:read:contacts:hub_at'),[...reads,'tables:patch:contacts:name','tables:patch:other:flag']]){
  const {env}=await setup(grants);const key=await hashToken('candidate');
  const r=await worker.fetch(new Request(`https://hub.test/login?key=${key}&name=Phone&profile=${expectation.id}`),env,ctx);
  expect(r.status).toBe(403);
  expect(()=>validateDeviceSession({}, {...expectation,scopes:grants})).toThrow();
 }
});
