import {expect,test} from 'bun:test';
import worker from '../src/index.js';
import {enrollmentProfile} from '../src/enrollment-profile.js';
import {ensureAuthReady,hashToken} from '../src/auth.js';
import {D1Shim} from './d1shim.js';

const scopes=['tables:read:items:id','tables:read:items:status','catalog:read:items:status'];
const config={version:1,namespace:'example.library',bindings:{item:{table:'items',status:'status'}}};
async function fixture(){
 const DB=new D1Shim(),AUTH_DB=new D1Shim();
 DB.db.exec(`CREATE TABLE items(id TEXT PRIMARY KEY,status TEXT,updated_at TEXT);
 CREATE TABLE catalog_tables(id TEXT PRIMARY KEY,kind TEXT,deleted_at TEXT);
 INSERT INTO catalog_tables VALUES ('items','table',NULL);
 CREATE TABLE catalog_properties(id TEXT PRIMARY KEY,tbl TEXT,col TEXT,type TEXT,description TEXT,required INTEGER,options TEXT,options_sql TEXT,derived_by TEXT,immutable INTEGER,deleted_at TEXT);
 INSERT INTO catalog_properties VALUES ('items.status','items','status','select','Progress',1,'[{"v":"open","private":"hidden"},{"v":"done"}]','SELECT secret FROM hidden',NULL,0,NULL);`);
 const env={HUB_TOKEN:'root',DB,AUTH_DB,ENROLLMENT_PROFILES:JSON.stringify({library:{label:'Library',scopes,config}})};
 const profile=await enrollmentProfile(env,'library');
 await ensureAuthReady(AUTH_DB);
 AUTH_DB.db.query('INSERT INTO _tokens(hash,name,scopes,enrollment_profile,enrollment_revision) VALUES (?,?,?,?,?)').run(await hashToken('device'),'device:fixture',scopes.join(','),'library',profile?.revision ?? 'missing');
 return env;
}
const call=(env,path,body,token='device')=>worker.fetch(new Request('https://hub.test'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env,{waitUntil(){}});

test('enrolled device reads only current bound configuration and cannot select another profile',async()=>{
 const env=await fixture();
 const response=await call(env,'/v1/consumer/config');
 expect(response.status).toBe(200);expect(response.headers.get('Cache-Control')).toBe('no-store');
 expect((await response.json()).config).toEqual(config);
 expect((await call(env,'/v1/consumer/config?profile=other')).status).toBe(403);
 expect((await call(env,'/v1/consumer/config',undefined,'root')).status).toBe(403);
 const profiles=JSON.parse(env.ENROLLMENT_PROFILES);profiles.library.config.bindings.item.table='other';env.ENROLLMENT_PROFILES=JSON.stringify(profiles);
 expect((await call(env,'/v1/consumer/config')).status).toBe(409);
});

test('config revision is canonical, bounded, and preserves legacy hashes',async()=>{
 const legacy={label:'Library',scopes:['tables:read:items:id']};
 const env={ENROLLMENT_PROFILES:JSON.stringify({library:legacy})};
 expect((await enrollmentProfile(env,'library')).revision).toBe(await hashToken(JSON.stringify(['library','Library',legacy.scopes])));
 env.ENROLLMENT_PROFILES=JSON.stringify({library:{...legacy,config}});
 const first=await enrollmentProfile(env,'library');expect(first).not.toBeNull();
 env.ENROLLMENT_PROFILES=JSON.stringify({library:{...legacy,config:{bindings:config.bindings,namespace:config.namespace,version:1}}});
 expect((await enrollmentProfile(env,'library')).revision).toBe(first.revision);
 for(const invalid of [null,[],{...config,version:2},{...config,bindings:[]},{...config,extra:true},{...config,bindings:{large:'x'.repeat(16384)}}]){
  env.ENROLLMENT_PROFILES=JSON.stringify({library:{...legacy,config:invalid}});
  expect(await enrollmentProfile(env,'library')).toBeNull();
 }
});

test('metadata projection requires every grant and discloses only static property metadata',async()=>{
 const env=await fixture(),request={table:'items',columns:['status']};
 const response=await call(env,'/v1/catalog/projection',request);
 expect(response.status).toBe(200);
 const data=await response.json();
 expect(data).toEqual({table:'items',properties:[{column:'status',type:'select',description:'Progress',required:true,readOnly:true,options:[{v:'open'},{v:'done'}]}],rules:[]});
 expect(JSON.stringify(data)).not.toContain('SELECT');expect(JSON.stringify(data)).not.toContain('hidden');
 expect((await call(env,'/v1/catalog/projection',{table:'items',columns:['status','id']})).status).toBe(403);
 expect((await call(env,'/v1/catalog/projection',{table:'hidden',columns:['status']})).status).toBe(403);
 env.AUTH_DB.db.exec("UPDATE _tokens SET scopes='tables:read:items:id,tables:read:items:status'");
 expect((await call(env,'/v1/catalog/projection',request)).status).toBe(403);
});

test('metadata projection carries palette option colors and drops unknown ones',async()=>{
 const env=await fixture();
 env.DB.db.exec(`UPDATE catalog_properties SET options='[{"v":"open","color":"green"},{"v":"done","color":"Teal"}]'`);
 const data=await (await call(env,'/v1/catalog/projection',{table:'items',columns:['status']})).json();
 expect(data.properties[0].options).toEqual([{v:'open',color:'green'},{v:'done'}]);
});

test('uncataloged engine columns project built-in read-only metadata; other columns still need a catalog row',async()=>{
 const env=await fixture();
 env.DB.db.exec('ALTER TABLE items ADD COLUMN extra TEXT');
 env.AUTH_DB.db.exec("UPDATE _tokens SET scopes=scopes||',catalog:read:items:id,tables:read:items:updated_at,catalog:read:items:updated_at,tables:read:items:extra,catalog:read:items:extra'");
 const response=await call(env,'/v1/catalog/projection',{table:'items',columns:['id','updated_at','status']});
 expect(response.status).toBe(200);
 expect((await response.json()).properties.slice(0,2)).toEqual([
  {column:'id',type:'text',description:null,required:true,readOnly:true},
  {column:'updated_at',type:'datetime',description:null,required:true,readOnly:true}]);
 expect((await call(env,'/v1/catalog/projection',{table:'items',columns:['extra']})).status).toBe(403);
});

test('metadata edits are enabled only for checked writable properties and never leak SQL options',async()=>{
 const env=await fixture();
 env.AUTH_DB.db.exec("UPDATE _tokens SET scopes=scopes||',tables:patch:items:status'");
 const read=async()=>await (await call(env,'/v1/catalog/projection',{table:'items',columns:['status']})).json();
 expect((await read()).properties[0].readOnly).toBe(true);
 env.DB.db.exec('UPDATE catalog_properties SET options_sql=NULL');
 expect((await read()).properties[0].readOnly).toBe(false);
 env.DB.db.exec('UPDATE catalog_properties SET immutable=1');
 expect((await read()).properties[0].readOnly).toBe(true);
 env.DB.db.exec("UPDATE catalog_properties SET immutable=0,derived_by='provider'");
 expect((await read()).properties[0].readOnly).toBe(true);
});

test('metadata changes between authorization and disclosure reject the entire response',async()=>{
 const env=await fixture(),batch=env.DB.batch.bind(env.DB);
 env.DB.batch=async statements=>{
  env.DB.db.exec("UPDATE catalog_properties SET description='changed'");
  return batch(statements);
 };
 const response=await call(env,'/v1/catalog/projection',{table:'items',columns:['status']});
 expect(response.status).toBe(409);expect(await response.json()).toEqual({error:'metadata unavailable'});
});

test('oversized chunked projection input cancels before reading the whole body',async()=>{
 const env=await fixture();let pulls=0,cancelled=false;
 const body=new ReadableStream({pull(controller){pulls++;controller.enqueue(new Uint8Array(9000).fill(32));if(pulls===10)controller.close();},cancel(){cancelled=true;}});
 const request=new Request('https://hub.test/v1/catalog/projection',{method:'POST',headers:{Authorization:'Bearer device'},body});
 const response=await worker.fetch(request,env,{waitUntil(){}});
 expect(response.status).toBe(413);expect(cancelled).toBe(true);expect(pulls).toBeLessThan(5);
});

test('metadata projection discloses static defaults and enforced rule texts, never their SQL',async()=>{
 const request={table:'items',columns:['status']};
 let env=await fixture();
 const read=async()=>await (await call(env,'/v1/catalog/projection',request)).json();
 // A hub without catalog rules or a default column projects neither.
 expect(await read()).toEqual({table:'items',properties:[{column:'status',type:'select',description:'Progress',required:true,readOnly:true,options:[{v:'open'},{v:'done'}]}],rules:[]});
 // A fresh hub: bun:sqlite keeps a cached statement's original column list.
 env=await fixture();
 env.DB.db.exec(`ALTER TABLE catalog_properties ADD COLUMN default_value TEXT;UPDATE catalog_properties SET default_value='open';
 CREATE TABLE catalog_rules(id TEXT PRIMARY KEY,tbl TEXT,scope TEXT,kind TEXT,enforce INTEGER,sql TEXT,text TEXT,deleted_at TEXT);
 INSERT INTO catalog_rules VALUES
  ('b','items','table','invariant',1,'SELECT id FROM changed WHERE secret_b','Second rule.',NULL),
  ('a','items','table','invariant',1,'SELECT id FROM changed WHERE secret_a','First rule.',NULL),
  ('advisory','items','table','invariant',0,'SELECT 1','Advisory.',NULL),
  ('doctrine','items','table','doctrine',1,NULL,'Doctrine.',NULL),
  ('gone','items','table','invariant',1,'SELECT 1','Deleted.','2026-01-01T00:00:00.000Z'),
  ('textless','items','table','invariant',1,'SELECT id FROM changed WHERE secret_c',NULL,NULL),
  ('other','hidden','table','invariant',1,'SELECT 1','Other table.',NULL);`);
 const data=await read();
 expect(data.properties[0].default).toBe('open');
 expect(data.rules).toEqual(['First rule.','Second rule.']);
 expect(JSON.stringify(data)).not.toContain('secret');
 env.DB.db.exec("UPDATE catalog_properties SET default_value='sql:SELECT secret FROM hidden'");
 expect((await read()).properties[0]).not.toHaveProperty('default');
});
