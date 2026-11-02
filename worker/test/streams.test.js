import {expect, test} from 'bun:test';
import worker from '../src/index.js';
import {D1Shim} from './d1shim.js';
import {validateDeviceSession} from '../../core/src/enrollment.ts';
import {enrollmentProfile} from '../src/enrollment-profile.js';

// The auth registry and route dispatcher are real; only remote storage is local.
async function setup() {
  const objects = new Map(), calls = [];
  const archive = {
    async put(key, body) {objects.set(key, new Uint8Array(await new Response(body).arrayBuffer()));},
    async get(key) {
      calls.push(key);
      const bytes = objects.get(key);
      return bytes && {body:bytes, size:bytes.length, text:async()=>new TextDecoder().decode(bytes),
        arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};
    },
    async list({prefix, cursor, limit}) {
      calls.push(prefix);
      const keys = [...objects.keys()].filter(k=>k.startsWith(prefix)).sort();
      const offset = cursor === undefined ? 0 : Number(cursor);
      const selected = keys.slice(offset, offset + limit);
      return {objects:selected.map(key=>({key, size:objects.get(key).length})),
        truncated:offset+selected.length<keys.length, cursor:String(offset+selected.length)};
    },
  };
  const env = {HUB_TOKEN:'root', DB:new D1Shim(), AUTH_DB:new D1Shim(), ARCHIVE:archive,
    EVENTS:{async send() {}}};
  const request = (token,path,method='GET',body) => worker.fetch(new Request(`https://hub.test${path}`,
    {method,headers:{Authorization:`Bearer ${token}`},body}),env,{waitUntil() {}});
  const mint = async (name,scopes) => (await (await request('root','/v1/tokens/create','POST',
    JSON.stringify({name,scopes}))).json()).token;
  const add = (name,key,body) => archive.put(`landing/${name}/${key}.json`,body);
  return {request,mint,add,objects,calls,archive,env};
}

test('exact producer append is independent from reads and forbidden mutation routes',async()=>{
  const {request,mint,objects,calls} = await setup();
  const token = await mint('producer','streams:append:sample');
  const original = ' {"person_id":"p1","tst":1} \n';
  expect((await request(token,'/v1/streams/sample/append','POST',original)).status).toBe(200);
  expect(new TextDecoder().decode(objects.get('state/sample/latest.json'))).toBe(original);
  calls.length=0;
  for (const [path,method,body] of [
    ['/v1/streams/sample/tail','GET'], ['/v1/streams/sample/records','GET'],
    ['/v1/streams/sample-other/batch','POST','[{}]'], ['/v1/streams/sample/replay','POST','[{}]'],
    ['/v1/streams/sample/batch','GET'], ['/v1/streams/%73ample/batch','POST','[{}]'],
    ['/v1/streams/sample/batch/extra','POST','[{}]'], ['/v1/streams/sample%2fother/batch','POST','[{}]'],
    ['/v1/streams/sample-other/append','POST','{}'], ['/v1/streams/sample/append','GET'],
    ['/v1/streams/sample/append/extra','POST','{}'], ['/v1/streams/%73ample/append','POST','{}'],
    ['/v1/streams/sample%2fother/append','POST','{}'], ['/v1/streams/sample/manifest','GET'],
    ['/v1/files/landing/sample/a.json','GET'], ['/v1/archive/query','POST','{}'],
    ['/v1/rows/pull','POST','{"table":"sample"}'], ['/v1/tokens/list','POST','{}'],
  ]) expect((await request(token,path,method,body)).status).toBe(403);
  expect(calls).toEqual([]);
});

test('exact producer imports bounded batches without changing the live tail',async()=>{
  const {request,mint,objects,env} = await setup();
  const token=await mint('producer','streams:append:sample');
  const sent=[];
  env.EVENTS={async send(events){sent.push(...events);}};
  const live='{"tst":999}';
  expect((await request(token,'/v1/streams/sample/append','POST',live)).status).toBe(200);
  sent.length=0;
  const records=Array.from({length:1000},(_,tst)=>({tst}));
  const response=await request(token,'/v1/streams/sample/batch','POST',JSON.stringify(records));
  expect(response.status).toBe(200);
  const result=await response.json();
  expect(result.count).toBe(1000);
  expect(result.key).toStartWith('landing/sample/');
  expect(JSON.parse(new TextDecoder().decode(objects.get(result.key)))).toEqual(records);
  expect(new TextDecoder().decode(objects.get('state/sample/latest.json'))).toBe(live);
  expect(sent.map(e=>e.record)).toEqual(records);
  expect(sent.every(e=>e.stream==='sample' && e.ingested_at===sent[0].ingested_at)).toBe(true);
  const size=objects.size;
  for(const body of ['[]','{}',JSON.stringify([...records,{}])]) {
    expect((await request(token,'/v1/streams/sample/batch','POST',body)).status).toBe(400);
    expect(objects.size).toBe(size);
    expect(sent.length).toBe(1000);
  }
  expect((await request('root','/v1/tokens/revoke','POST','{"name":"producer"}')).status).toBe(200);
  expect((await request(token,'/v1/streams/sample/batch','POST','[{}]')).status).toBe(403);
  expect(objects.size).toBe(size);
});

test('reader walks only its stream and preserves exact bodies including batches',async()=>{
  const {request,mint,add} = await setup();
  const token = await mint('reader','streams:read:sample');
  await add('sample','a',' {"person_id":"p1"} \n');
  await add('sample','b','[{"person_id":"p2"}]');
  await add('other','a','{"private":true}');
  const first = await request(token,'/v1/streams/sample/records?limit=1');
  expect(first.status).toBe(200);
  const page = await first.json();
  expect(page.entries.map(e=>e.body)).toEqual([' {"person_id":"p1"} \n']);
  expect(page.entries[0].id).toMatch(/^[0-9a-f]{64}$/);
  expect(page.next_cursor).toBeString();
  expect(first.headers.get('Cache-Control')).toBe('no-store');
  const second = await (await request(token,`/v1/streams/sample/records?limit=1&cursor=${encodeURIComponent(page.next_cursor)}`)).json();
  expect(second.entries.map(e=>e.body)).toEqual(['[{"person_id":"p2"}]']);
  expect(second.next_cursor).toBeNull();
  expect((await (await request(token,'/v1/streams/sample/records?limit=1')).json()).entries[0].id).toBe(page.entries[0].id);
  for (const [path,method,body] of [
    ['/v1/streams/other/records','GET'], ['/v1/streams/sample-other/tail','GET'],
    ['/v1/streams/sample/append','POST','{}'], ['/v1/streams/sample/batch','POST','[{}]'],
    ['/v1/streams/sample/replay','POST','[{}]'],
    ['/v1/streams/sample/manifest','GET'], ['/v1/files/landing/sample/a.json','GET'],
    ['/v1/streams/sample/records','POST','{}'],
  ]) expect((await request(token,path,method,body)).status).toBe(403);
  expect((await request('root','/v1/tokens/revoke','POST','{"name":"reader"}')).status).toBe(200);
  expect((await request(token,'/v1/streams/sample/records')).status).toBe(403);
});

test('invalid page requests and cross-stream cursors fail before storage',async()=>{
  const {request,mint,add,calls} = await setup();
  const token = await mint('reader','streams:read:sample,streams:read:other');
  await add('sample','a','{}'); await add('sample','b','{}');
  const page = await (await request(token,'/v1/streams/sample/records?limit=1')).json();
  calls.length=0;
  for(const query of ['limit=0','limit=21','limit=1.5','limit=NaN','limit=1&limit=2','cursor=bad','unknown=1']) {
    expect((await request(token,`/v1/streams/sample/records?${query}`)).status).toBe(400);
  }
  expect((await request(token,`/v1/streams/other/records?cursor=${encodeURIComponent(page.next_cursor)}`)).status).toBe(400);
  expect(calls).toEqual([]);
});

test('oversized and missing landing objects fail the whole page without a cursor',async()=>{
  const {request,mint,add,archive} = await setup();
  const token = await mint('reader','streams:read:sample');
  await add('sample','a','a'.repeat(1_000_000)); await add('sample','b','b'.repeat(1_000_000));
  await add('sample','c','c'.repeat(1_000_000));
  const tooLarge=await request(token,'/v1/streams/sample/records?limit=3');
  expect(tooLarge.status).toBe(413);
  expect((await tooLarge.json()).next_cursor).toBeUndefined();
  expect((await request(token,'/v1/streams/sample/records?limit=1')).status).toBe(200);
  archive.get=async()=>null;
  const missing=await request(token,'/v1/streams/sample/records?limit=1');
  expect(missing.status).toBe(503);
  expect((await missing.json()).next_cursor).toBeUndefined();
});

test('short truncated storage pages preserve their continuation',async()=>{
  const {request,mint,add,archive} = await setup();
  const token = await mint('reader','streams:read:sample');
  await add('sample','a','{}'); await add('sample','b','{}');
  const list=archive.list.bind(archive);
  archive.list=options=>list({...options,limit:1});
  const page=await (await request(token,'/v1/streams/sample/records?limit=20')).json();
  expect(page.entries.length).toBe(1); expect(page.next_cursor).toBeString();
});

test('broken storage pages fail closed without partial entries or a payload-bearing error',async()=>{
  const {request,mint,archive,calls} = await setup();
  const token=await mint('reader','streams:read:sample');
  for(const page of [
    {objects:[{key:'landing/other/a.json',size:2}],truncated:false},
    {objects:[],truncated:true},
    {objects:[],truncated:true,cursor:''},
  ]) {
    archive.list=async()=>page;
    const reply=await request(token,'/v1/streams/sample/records');
    expect(reply.status).toBe(503);
    expect(await reply.json()).toEqual({error:'stream page unavailable'});
  }
  expect(calls).toEqual([]);
  archive.list=async()=>{throw Error('private storage diagnostic');};
  expect(await (await request(token,'/v1/streams/sample/records')).json()).toEqual({error:'stream page unavailable'});
});

test('invalid UTF-8 cannot silently change the original record',async()=>{
  const {request,mint,objects,add} = await setup();
  const token=await mint('reader','streams:read:sample');
  await add('sample','a',' {"city":"München"} \n');
  const valid=await request(token,'/v1/streams/sample/records');
  expect(valid.status).toBe(200);
  expect((await valid.json()).entries[0].body).toBe(' {"city":"München"} \n');
  objects.set('landing/sample/b.json',new Uint8Array([255]));
  const invalid=await request(token,'/v1/streams/sample/records');
  expect(invalid.status).toBe(503);
  expect(await invalid.json()).toEqual({error:'stream page unavailable'});
});

test('browser enrollment and native policy keep exact stream profiles narrow',async()=>{
  for(const operation of ['read','append']) {
    const {env,request}=await setup();
    const expected={id:`stream-${operation}`,scopes:[`streams:${operation}:sample`]};
    env.LOGIN_ACCESS_AUD='aud';
    env.ENROLLMENT_PROFILES=JSON.stringify({[expected.id]:{label:'Scoped Stream',scopes:expected.scopes}});
    const token=`synthetic-${operation}-device`;
    const fingerprint=new Bun.CryptoHasher('sha256').update(token).digest('hex');
    const ctx={access:{aud:'aud',getIdentity:async()=>({email:'owner@example.test'})},waitUntil(){}};
    const profile=await enrollmentProfile(env,expected.id);
    expect(profile).not.toBeNull();
    const form=new URLSearchParams({key:fingerprint,name:'Device',profile:expected.id,profileRevision:profile.revision});
    const approved=await worker.fetch(new Request('https://hub.test/login',{method:'POST',headers:{Origin:'https://hub.test','Content-Type':'application/x-www-form-urlencoded'},body:form}),env,ctx);
    expect(approved.status).toBe(200);
    const session=await (await request(token,'/v1/session')).json();
    const native=validateDeviceSession(session,expected);
    expect(native.scopes).toEqual(expected.scopes);
    expect(native.replica.allowed).toBe(false);
    expect(native.governance).toBeUndefined();
    if(operation==='read') expect((await request(token,'/v1/streams/sample/records')).status).toBe(200);
    else expect((await request(token,'/v1/streams/sample/append','POST','{}')).status).toBe(200);
    for(const invalid of ['streams:read','full','streams:read:*','streams:read:sample/other','streams:read:sample:extra']) {
      env.ENROLLMENT_PROFILES=JSON.stringify({bad:{label:'Invalid',scopes:[invalid]}});
      expect(await enrollmentProfile(env,'bad')).toBeNull();
    }
  }
});

test('replay keeps the ingest time of the landing object it rebuilds',async()=>{
  const {request,env} = await setup();
  const sent = [];
  env.EVENTS = {async send(events) {sent.push(...events);}};
  const at = '2026-09-03T04:05:06.789Z';
  const res = await request('root',`/v1/streams/sample/replay?ingested_at=${at}`,'POST','[{"tst":1}]');
  expect(res.status).toBe(200);
  expect(sent).toEqual([{stream:'sample', ingested_at:at, record:{tst:1}}]);
  const bad = await request('root','/v1/streams/sample/replay?ingested_at=yesterday','POST','[{"tst":1}]');
  expect(bad.status).toBe(400);
});
