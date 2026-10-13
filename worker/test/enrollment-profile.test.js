import {expect,test} from 'bun:test';
import worker from '../src/index.js';
import {hashToken} from '../src/auth.js';
import {D1Shim} from './d1shim.js';

const scopes=['tables:read:contacts:id','tables:read:contacts:name'];
const profiles={'contact-reader-v1':{label:'Contact Reader',scopes}};
const context={access:{aud:'fixture',getIdentity:async()=>({email:'owner@example.test'})},waitUntil(){}};
const env=()=>({HUB_TOKEN:'root',AUTH_DB:new D1Shim(),DB:{prepare(){throw Error('unexpected data access');}},LOGIN_ACCESS_AUD:'fixture',ENROLLMENT_PROFILES:JSON.stringify(profiles)});
const call=(e,path,method='GET',body,token)=>worker.fetch(new Request('https://hub.test'+path,{method,headers:{Origin:'https://hub.test','Content-Type':'application/x-www-form-urlencoded',...(token?{Authorization:'Bearer '+token}:{})},body}),e,context);
async function approval(e,token='candidate',profile='contact-reader-v1'){
 const key=await hashToken(token);
 const r=await call(e,`/login?key=${key}&name=Phone&profile=${profile}`);
 const html=await r.text();
 expect(r.status).toBe(200);
 expect(html).toContain('Contact Reader');
 expect(html).toContain('tables:read:contacts:name');
 const revision=html.match(/name="profileRevision" value="([0-9a-f]{64})"/)?.[1];
 expect(revision).toHaveLength(64);
 return new URLSearchParams({key,name:'Phone',profile,profileRevision:revision}).toString();
}

test('profile approval binds exact grants and receipt without governance authority or data access',async()=>{
 const e=env(),form=await approval(e);
 expect(e.AUTH_DB.db.query("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]);
 expect((await call(e,'/login','POST',form)).status).toBe(200);
 const r=await call(e,'/v1/session','GET',undefined,'candidate'),data=await r.json();
 expect(r.status).toBe(200);expect(data.scopes).toEqual(scopes);
 expect(data.enrollmentProfile).toEqual({id:'contact-reader-v1',revision:new URLSearchParams(form).get('profileRevision')});
 expect(data.capabilities.replica_sync).toBe(false);expect(data.capabilities.governance).toBeUndefined();
 expect(e.AUTH_DB.db.query('SELECT * FROM _governance_authorities').all()).toEqual([]);
 expect((await call(e,'/login','POST',form)).status).toBe(200);
 expect((await call(e,'/v1/session','POST',undefined,'candidate')).status).toBe(200);
 expect((await call(e,'/v1/session','GET',undefined,'candidate')).status).toBe(401);
 expect((await call(e,'/login','POST',form)).status).toBe(409);
});

test('profile failures never fall back to full or write auth state',async()=>{
 for(const config of [undefined,'invalid','{}',JSON.stringify({'contact-reader-v1':{label:'Contact Reader',scopes:['full']}}),JSON.stringify({'contact-reader-v1':{label:'Contact Reader',scopes:['tables:read:contacts:name']}})]){
  const e=env();e.ENROLLMENT_PROFILES=config;
  const key=await hashToken('candidate');
  const get=await call(e,`/login?key=${key}&name=Phone&profile=contact-reader-v1`);
  expect(get.status).not.toBe(200);
  const post=await call(e,'/login','POST',new URLSearchParams({key,name:'Phone',profile:'contact-reader-v1',profileRevision:'a'.repeat(64)}).toString());
  expect(post.status).not.toBe(200);
  expect(e.AUTH_DB.db.query("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]);
 }
});

test('approval rejects policy changes after display and requires revision',async()=>{
 const e=env(),form=await approval(e);
 e.ENROLLMENT_PROFILES=JSON.stringify({'contact-reader-v1':{label:'Contact Reader',scopes:[...scopes,'tables:read:contacts:private']}});
 expect((await call(e,'/login','POST',form)).status).toBe(409);
 const p=new URLSearchParams(form);p.delete('profileRevision');
 expect((await call(e,'/login','POST',p.toString())).status).toBe(400);
 expect(e.AUTH_DB.db.query("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]);
});

for(const first of ['profile','legacy'])test(`same fingerprint cannot cross profile/legacy boundary (${first} first)`,async()=>{
 const e=env(),form=await approval(e),p=new URLSearchParams(form);
 const legacy=new URLSearchParams({key:p.get('key'),name:'Phone'}).toString();
 const forms=first==='profile'?[form,legacy]:[legacy,form];
 expect((await call(e,'/login','POST',forms[0])).status).toBe(200);
 expect((await call(e,'/login','POST',forms[1])).status).toBe(409);
 const session=await (await call(e,'/v1/session','GET',undefined,'candidate')).json();
 expect(session.scopes).toEqual(first==='profile'?scopes:['full']);
 expect(e.AUTH_DB.db.query('SELECT count(*) AS n FROM _governance_authorities').get().n).toBe(first==='profile'?0:1);
});

test('registration binding is checked inside the committing batch against a competing approval',async()=>{
 const e=env(),form=await approval(e),p=new URLSearchParams(form),original=e.AUTH_DB.batch.bind(e.AUTH_DB);
 e.AUTH_DB.batch=async stmts=>{
  e.AUTH_DB.batch=original;
  expect((await call(e,'/login','POST',new URLSearchParams({key:p.get('key'),name:'Other'}).toString())).status).toBe(200);
  return original(stmts);
 };
 expect((await call(e,'/login','POST',form)).status).toBe(409);
 const session=await (await call(e,'/v1/session','GET',undefined,'candidate')).json();
 expect(session.scopes).toEqual(['full']);expect(session.enrollmentProfile).toBeUndefined();
});

test('rejected legacy approval cannot promote an existing non-device credential',async()=>{
 const e=env(),key=await hashToken('candidate');
 const {ensureAuthReady}=await import('../src/auth.js');await ensureAuthReady(e.AUTH_DB);
 e.AUTH_DB.db.query("INSERT INTO _tokens(hash,name,scopes) VALUES (?,'service-reader','full')").run(key);
 const before=e.AUTH_DB.db.query('SELECT * FROM _tokens').all();
 const form=new URLSearchParams({key,name:'Phone'}).toString();
 expect((await call(e,'/login','POST',form)).status).toBe(409);
 expect(e.AUTH_DB.db.query('SELECT * FROM _tokens').all()).toEqual(before);
 expect(e.AUTH_DB.db.query('SELECT * FROM _governance_authorities').all()).toEqual([]);
});

import scopeFixture from '../../tests/fixtures/enrollment-scopes.json';
import {enrollmentProfile} from '../src/enrollment-profile.js';
import {creationPolicies,creationGrant} from '../src/creation.js';
import {validateDeviceSession} from '../../core/src/enrollment.ts';

for(const c of scopeFixture.cases.filter(c=>!JSON.stringify(c.scopes).includes('rows:create:')))
 test(`hub profile grammar matches the shared contract: ${c.name}`,async()=>{
  const e={ENROLLMENT_PROFILES:JSON.stringify({p:{label:'Fixture',scopes:c.scopes}})};
  expect(await enrollmentProfile(e,'p')!==null).toBe(c.valid);
 });

const creationConfig={namespace:'11111111-2222-4333-8444-555555555555',sourceKind:'fixture-event',
 occurrenceType:'integer',table:'items',columns:['title'],origin:{kind:'fixture-source',table:'sources',relation:'imported_from'}};

test('creation grants in a profile must name a configured policy revision',async()=>{
 const e={ROW_CREATION_POLICIES:JSON.stringify({fixture:creationConfig})};
 const [policy]=await creationPolicies(e);
 e.ENROLLMENT_PROFILES=JSON.stringify({good:{label:'Creator',scopes:[creationGrant(policy)]},
  stale:{label:'Creator',scopes:[`rows:create:fixture:${'a'.repeat(64)}`]}});
 expect((await enrollmentProfile(e,'good')).scopes).toEqual([creationGrant(policy)]);
 expect(await enrollmentProfile(e,'stale')).toBeNull();
});

async function approve(e,id,token){
 const key=await hashToken(token);
 const page=await call(e,`/login?key=${key}&name=Server&profile=${id}`),html=await page.text();
 expect(page.status).toBe(200);
 const revision=html.match(/name="profileRevision" value="([0-9a-f]{64})"/)[1];
 expect((await call(e,'/login','POST',new URLSearchParams({key,name:'Server',profile:id,profileRevision:revision}).toString())).status).toBe(200);
 return {html,session:await (await call(e,'/v1/session','GET',undefined,token)).json()};
}

test('server profiles carry whole-table, file, subscription and stream grants without full authority',async()=>{
 const grants=['tables:read:flights','tables:write:flights','files:read:raw/flighty/','files:write:raw/flighty/',
  'subscriptions:consume:11111111-1111-4111-8111-111111111111','streams:append:location'];
 const e=env();e.ENROLLMENT_PROFILES=JSON.stringify({'flight-sync-v1':{label:'Flight Sync',scopes:grants}});
 const {html,session}=await approve(e,'flight-sync-v1','server-candidate');
 expect(html).toContain('Read and write access');
 expect(session.scopes).toEqual([...grants].sort());
 expect(session.capabilities.schema).toBe('none');expect(session.capabilities.replica_sync).toBe(false);
 const native=validateDeviceSession(session,{id:'flight-sync-v1',scopes:grants});
 expect(native.replica.allowed).toBe(false);expect(native.governance).toBeUndefined();
 expect(e.AUTH_DB.db.query('SELECT count(*) AS n FROM _governance_authorities').get().n).toBe(0);
});

test('broad table and stream profiles get schema access but never replica sync or governance',async()=>{
 const grants=['tables:read','tables:write','streams:append'];
 const e=env();e.ENROLLMENT_PROFILES=JSON.stringify({'estate-reader-v1':{label:'Estate Reader',scopes:grants}});
 const {session}=await approve(e,'estate-reader-v1','broad-candidate');
 expect(session.capabilities.schema).toBe('full-ddl-v1');expect(session.capabilities.replica_sync).toBe(false);
 const native=validateDeviceSession(session,{id:'estate-reader-v1',scopes:grants});
 expect(native.replica.allowed).toBe(false);expect(native.governance).toBeUndefined();
 expect(e.AUTH_DB.db.query('SELECT count(*) AS n FROM _governance_authorities').get().n).toBe(0);
});

test('read-only profiles are labelled read-only',async()=>{
 const e=env(),{html}=await approve(e,'contact-reader-v1','reader-candidate');
 expect(html).toContain('Read-only access:');expect(html).not.toContain('Read and write access');
});

test('a gzip-compressed profile set resolves exactly like its JSON and stays bounded',async()=>{
 const {enrollmentProfile}=await import('../src/enrollment-profile.js');
 const gzip=text=>'gzip:'+Buffer.from(Bun.gzipSync(text)).toString('base64');
 const plain=await enrollmentProfile({ENROLLMENT_PROFILES:JSON.stringify(profiles)},'contact-reader-v1');
 expect(plain).not.toBeNull();
 expect(await enrollmentProfile({ENROLLMENT_PROFILES:gzip(JSON.stringify(profiles))},'contact-reader-v1')).toEqual(plain);
 const e=env();e.ENROLLMENT_PROFILES=gzip(JSON.stringify(profiles));await approval(e);
 const huge=JSON.stringify({...profiles,pad:{label:'x'.repeat(70000)}});
 for(const value of [gzip(huge),'gzip:not-base64!','gzip:'+Buffer.from('plain').toString('base64')])
  expect(await enrollmentProfile({ENROLLMENT_PROFILES:value},'contact-reader-v1')).toBeNull();
});

test('a profile set past one secret travels as numbered gzip parts that resolve exactly like its JSON',async()=>{
 const {enrollmentProfile,profileSecrets}=await import('../src/enrollment-profile.js');
 const big=JSON.stringify({...profiles,...Object.fromEntries(Array.from({length:150},(_,i)=>[`pad-${i}`,{label:`Pad ${i} ${crypto.randomUUID()}`,scopes:[`tables:read:t${crypto.randomUUID().replaceAll('-','')}`]}]))});
 const secrets=profileSecrets(big);
 expect(Object.keys(secrets).length).toBeGreaterThan(1);
 for(const value of Object.values(secrets)) expect(value.length).toBeLessThan(5000);
 const plain=await enrollmentProfile({ENROLLMENT_PROFILES:big},'contact-reader-v1');
 expect(plain).not.toBeNull();
 expect(await enrollmentProfile(secrets,'contact-reader-v1')).toEqual(plain);
 // Parts left over from a larger earlier set are never read.
 expect(await enrollmentProfile({...secrets,ENROLLMENT_PROFILES_9:'stale'},'contact-reader-v1')).toEqual(plain);
 // A set that fits one secret keeps the single-part form a running older hub reads.
 const small=profileSecrets(JSON.stringify(profiles));
 expect(small).toEqual({ENROLLMENT_PROFILES:'gzip:'+Buffer.from(Bun.gzipSync(JSON.stringify(profiles))).toString('base64')});
 expect(await enrollmentProfile({...small,ENROLLMENT_PROFILES_2:'stale'},'contact-reader-v1')).toEqual(plain);
 const {ENROLLMENT_PROFILES_2:_,...missing}=secrets;
 expect(await enrollmentProfile(missing,'contact-reader-v1')).toBeNull();
});
