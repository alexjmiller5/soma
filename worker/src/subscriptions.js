import {trustedContinuityTrigger} from './governance-continuity.js';
import { checkedReads, readGuards } from './write.js';
import { scopedTable, timestampTrigger } from './scopes.js';
import { subscriptionTriggers, trustedSubscriptionTrigger } from './subscription-triggers.js';
import { qident } from './validate.js';

const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const schema = [
  `CREATE TABLE IF NOT EXISTS _change_subscriptions (
    id TEXT PRIMARY KEY,label TEXT NOT NULL,sources_json TEXT NOT NULL,trigger_sources_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('active','paused','retired')),created_at TEXT NOT NULL DEFAULT (${now}),
    last_seq INTEGER NOT NULL DEFAULT 0,acked_seq INTEGER NOT NULL DEFAULT 0,
    pending_delivery_id TEXT,pending_through_seq INTEGER,last_acked_delivery_id TEXT,
    pending_event_count INTEGER NOT NULL DEFAULT 0,pending_byte_count INTEGER NOT NULL DEFAULT 0,
    max_pending_events INTEGER NOT NULL,max_pending_bytes INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS _change_events (
    subscription_id TEXT NOT NULL,seq INTEGER NOT NULL,event_id TEXT NOT NULL,recorded_at TEXT NOT NULL,
    payload_json TEXT NOT NULL,accounted_bytes INTEGER NOT NULL,
    PRIMARY KEY(subscription_id,seq),UNIQUE(subscription_id,event_id)
  )`,
];
const ready=new WeakMap();
export async function ensureSubscriptions(db) {
  if (!ready.has(db)) ready.set(db,db.batch(schema.map(sql=>db.prepare(sql))).catch(error=>{ready.delete(db);throw error;}));
  await ready.get(db);
}

export async function createSubscription(db,input) {
  if (!input || input.start!=='now' || typeof input.label!=='string' || !input.label.trim()
    || input.label.length>100 || /[\x00-\x1f\x7f]/.test(input.label)
    || !Array.isArray(input.sources) || !input.sources.length || input.sources.length>32) throw new Error('invalid subscription');
  const maxEvents=input.max_pending_events ?? 100_000,maxBytes=input.max_pending_bytes ?? 268_435_456;
  if (!Number.isSafeInteger(maxEvents) || maxEvents<1 || maxEvents>1_000_000
    || !Number.isSafeInteger(maxBytes) || maxBytes<4096 || maxBytes>1_073_741_824) throw new Error('invalid subscription capacity');
  await ensureSubscriptions(db);
  const view=checkedReads(db),sources=[],triggerSources=[],seen=new Set();
  for(const source of input.sources) {
    if (!source || seen.has(source.table) || !Array.isArray(source.columns) || !source.columns.length
      || source.columns.length>16 || new Set(source.columns).size!==source.columns.length
      || (Object.hasOwn(source,'lifecycle') && typeof source.lifecycle!=='boolean')) throw new Error('invalid subscription source');
    const columns=await scopedTable(view,source.table);
    if (!columns.some(c=>c.name==='deleted_at')) throw new Error('invalid subscription source');
    for(const column of source.columns) {
      const info=columns.find(c=>c.name===column);
      if (!info || ['id','created_at','updated_at','deleted_at','hub_at'].includes(column)
        || !/CHAR|CLOB|TEXT|^(?:INTEGER|REAL)$/i.test(info.type)) throw new Error('invalid subscription column');
    }
    const {results:triggers}=await view.prepare("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name COLLATE NOCASE IN (?, '_change_events', '_change_subscriptions') ORDER BY name").bind(source.table).all();
    let hasClock=false;
    for(const trigger of triggers) {
      if (trigger.tbl_name!==source.table) throw new Error('invalid subscription triggers');
      if (timestampTrigger(trigger)) hasClock=true;
      else if (!trustedContinuityTrigger(trigger,columns.map(c=>c.name)) && !await trustedSubscriptionTrigger(view,trigger)) throw new Error('invalid subscription triggers');
    }
    seen.add(source.table);
    sources.push({table:source.table,columns:[...source.columns],...(source.lifecycle?{lifecycle:true}:{})});
    triggerSources.push({...sources.at(-1),version:3,hasClock,hasHubAt:columns.some(c=>c.name==='hub_at')});
  }
  const id=crypto.randomUUID();
  await db.batch([
    ...readGuards(db,view.reads),
    db.prepare("INSERT INTO _change_subscriptions(id,label,sources_json,trigger_sources_json,state,max_pending_events,max_pending_bytes) VALUES (?,?,?,?,'active',?,?)")
      .bind(id,input.label.trim(),JSON.stringify(sources),JSON.stringify(triggerSources),maxEvents,maxBytes),
    ...subscriptionTriggers(id,triggerSources).map(t=>db.prepare(t.sql)),
  ]);
  const {created_at}=await db.prepare('SELECT created_at FROM _change_subscriptions WHERE id=?').bind(id).first();
  return {id,protocol:'durable-pull-v1',state:'active',created_at,sources,acked_seq:'0',max_pending_events:maxEvents,max_pending_bytes:maxBytes};
}

export async function applySubscriptionSchema(db,ddl) {
  const view=checkedReads(db);
  const exists=await view.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_change_subscriptions'").first();
  const active=exists ? (await view.prepare("SELECT id,trigger_sources_json FROM _change_subscriptions WHERE state IN ('active','paused') ORDER BY id").all()).results : [];
  const names=new Set(),watched=new Set(),expectedTriggers=[];
  if(exists) {names.add('_change_subscriptions');names.add('_change_events');watched.add('_change_subscriptions');watched.add('_change_events');}
  for(const sub of active) {
    const sources=JSON.parse(sub.trigger_sources_json);
    for(const source of sources) {names.add(source.table);watched.add(source.table);}
    for(const trigger of subscriptionTriggers(sub.id,sources)) {names.add(trigger.name);expectedTriggers.push(trigger);}
  }
  // Only a plain nullable scalar addition can change a watched table's SQL.
  // Constraints, defaults, renames and internal outbox changes keep exact guards.
  const addition=/^\s*ALTER\s+TABLE\s+(?:"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))\s+ADD\s+(?:COLUMN\s+)?(?:"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))\s+(?:TEXT|INTEGER|REAL|BLOB)\s*;?\s*$/i.exec(ddl);
  // Rowid aliases affect timestamp triggers; hub_at changes revision shape.
  const reserved=addition && ['rowid','_rowid_','oid','hub_at'].includes((addition[3]??addition[4]).toLowerCase());
  const addedTable=addition && !reserved && [...watched].find(name=>!name.startsWith('_') && name.toLowerCase()===(addition[1]??addition[2]).toLowerCase());
  if(addedTable) await view.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").bind(addedTable).first();
  // A column rename follows into the subscriptions selecting it, once each has
  // acknowledged every event recorded under the old name. Their triggers are
  // regenerated in the same batch; revision columns never move.
  const rename=/^\s*ALTER\s+TABLE\s+(?:"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))\s+RENAME\s+(?:COLUMN\s+)?(?:"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))\s+TO\s+(?:"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))\s*;?\s*$/i.exec(ddl);
  const [from,to]=rename ? [rename[3]??rename[4],rename[5]??rename[6]] : [];
  const revision=c=>['id','created_at','updated_at','deleted_at','hub_at','rowid','_rowid_','oid'].includes(c.toLowerCase());
  const renamedTable=rename && !revision(from) && !revision(to)
    && [...watched].find(name=>!name.startsWith('_') && name.toLowerCase()===(rename[1]??rename[2]).toLowerCase());
  const follows=[],replaced=new Set();
  if(renamedTable) {
    for(const sub of active) {
      const sources=JSON.parse(sub.trigger_sources_json);
      const moved=sources.map(s=>s.table===renamedTable ? {...s,columns:s.columns.map(c=>c.toLowerCase()===from.toLowerCase() ? to : c)} : s);
      if(JSON.stringify(moved)===JSON.stringify(sources)) continue;
      const state=await view.prepare('SELECT sources_json,pending_delivery_id,acked_seq=last_seq AS drained FROM _change_subscriptions WHERE id=?').bind(sub.id).first();
      if(state.pending_delivery_id!==null || !state.drained) throw Object.assign(new Error('subscription schema conflict'),{code:'subscription-schema-conflict'});
      const visible=JSON.parse(state.sources_json).map(s=>s.table===renamedTable ? {...s,columns:s.columns.map(c=>c.toLowerCase()===from.toLowerCase() ? to : c)} : s);
      for(const trigger of subscriptionTriggers(sub.id,sources)) replaced.add(trigger.name);
      follows.push({id:sub.id,sources:visible,triggerSources:moved});
    }
  }
  const stable=checkedReads(db),changing=JSON.stringify([...replaced].sort());
  if(names.size) {
    const {results:objects}=await stable.prepare("SELECT name,type,CASE WHEN type='table' AND name=? THEN NULL ELSE sql END AS sql FROM sqlite_master WHERE name IN (SELECT value FROM json_each(?)) AND name NOT IN (SELECT value FROM json_each(?)) ORDER BY name")
      .bind(addedTable||renamedTable||'',JSON.stringify([...names].sort()),changing).all();
    if(objects.length!==names.size-replaced.size || expectedTriggers.some(t=>!replaced.has(t.name) && !objects.some(o=>o.name===t.name && o.type==='trigger' && o.sql===t.sql))) {
      throw Object.assign(new Error('subscription schema conflict'),{code:'subscription-schema-conflict'});
    }
  }
  if(watched.size) await stable.prepare("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name COLLATE NOCASE IN (SELECT value FROM json_each(?)) AND name NOT IN (SELECT value FROM json_each(?)) ORDER BY name").bind(JSON.stringify([...watched].sort()),changing).all();
  const following=follows.flatMap(f=>[
    db.prepare('UPDATE _change_subscriptions SET sources_json=?,trigger_sources_json=? WHERE id=?').bind(JSON.stringify(f.sources),JSON.stringify(f.triggerSources),f.id),
    ...subscriptionTriggers(f.id,f.triggerSources).map(t=>db.prepare(t.sql)),
  ]);
  try {
    await db.batch([...readGuards(db,view.reads),...readGuards(db,stable.reads),
      ...[...replaced].map(name=>db.prepare(`DROP TRIGGER ${qident(name)}`)),db.prepare(ddl),...following,...readGuards(db,stable.reads)]);
  } catch(error) {
    if(String(error).includes('integer overflow')) throw Object.assign(new Error('subscription schema conflict'),{code:'subscription-schema-conflict'});
    throw error;
  }
}

export { pollEvents } from './subscription-delivery.js';
import { pollEvents, acknowledgeSubscription, loadSubscription, subscriptionAdmin, subscriptionStatus, subscriptionSelect, subscriptionReply, SubscriptionError } from './subscription-delivery.js';
import { ScopeDenied } from './scopes.js';

async function boundedJson(request,maximum=1_048_576) {
  const reader=request.body?.getReader();if(!reader) throw new SubscriptionError(400,'invalid_request');
  const parts=[];let bytes=0;
  try {
    for(;;) {
      const {value,done}=await reader.read();if(done) break;
      bytes+=value.byteLength;if(bytes>maximum) throw new SubscriptionError(413,'request_too_large');
      parts.push(value);
    }
    const body=new Uint8Array(bytes);let offset=0;
    for(const part of parts){body.set(part,offset);offset+=part.byteLength;}
    try{return JSON.parse(new TextDecoder().decode(body));}catch{throw new SubscriptionError(400,'invalid_request');}
  } finally {await reader.cancel().catch(()=>{});}
}

export async function handleSubscription(request,tenant) {
  try {
    const url=new URL(request.url),match=/^\/v1\/subscriptions(?:\/([0-9a-f-]{36})(?:\/(events|ack))?)?$/.exec(url.pathname);
    if(!match) throw new ScopeDenied('insufficient scope');
    const [,id,action]=match;
    if(!id) {
      if(!subscriptionAdmin(tenant)) throw new ScopeDenied('insufficient scope');
      if(request.method==='POST') {
        const body=await boundedJson(request);
        let created;
        try{created=await createSubscription(tenant.db,body);}catch(error){
          if(error instanceof ScopeDenied || String(error).includes('invalid subscription')) throw new SubscriptionError(400,'invalid_subscription');
          throw error;
        }
        return subscriptionReply(created,201);
      }
      if(request.method==='GET') {
        await ensureSubscriptions(tenant.db);
        const after=url.searchParams.get('after') ?? '';
        const {results}=await tenant.db.prepare(`${subscriptionSelect} WHERE id>? ORDER BY id LIMIT 100`).bind(after).all();
        return subscriptionReply({subscriptions:results.map(subscriptionStatus),next_cursor:results.length===100?results.at(-1).id:null});
      }
      throw new SubscriptionError(405,'method_not_allowed');
    }
    if(action==='events' && request.method==='GET') {
      await loadSubscription(tenant,id);
      const wait=url.searchParams.get('wait') ?? '30';
      if(url.searchParams.getAll('wait').length>1 || !/^\d+$/.test(wait) || Number(wait)>30) throw new SubscriptionError(400,'invalid_wait');
      return await pollEvents(tenant,id,Number(wait),{signal:request.signal});
    }
    if(action==='ack' && request.method==='POST') {
      await loadSubscription(tenant,id);
      return await acknowledgeSubscription(tenant,id,await boundedJson(request,4096));
    }
    const sub=await loadSubscription(tenant,id);
    if(!action && request.method==='GET') return subscriptionReply(subscriptionStatus(sub));
    if(!action && request.method==='PATCH') {
      if(!subscriptionAdmin(tenant)) throw new ScopeDenied('insufficient scope');
      const body=await boundedJson(request,4096);
      if(!body || Object.keys(body).length!==1 || !['active','paused','retired'].includes(body.state)) throw new SubscriptionError(400,'invalid_subscription_state');
      const drops=[];
      if(body.state==='retired') {
        const row=await tenant.db.prepare('SELECT trigger_sources_json FROM _change_subscriptions WHERE id=?').bind(id).first();
        for(const trigger of subscriptionTriggers(id,JSON.parse(row.trigger_sources_json))) drops.push(tenant.db.prepare(`DROP TRIGGER IF EXISTS "${trigger.name}"`));
      }
      try {
        const result=await tenant.db.batch([
          tenant.db.prepare("SELECT CASE WHEN EXISTS (SELECT 1 FROM _change_subscriptions WHERE id=? AND (state!='retired' OR ?='retired')) THEN 1 ELSE abs(-9223372036854775808) END").bind(id,body.state),
          tenant.db.prepare('UPDATE _change_subscriptions SET state=? WHERE id=?').bind(body.state,id),...drops,
          tenant.db.prepare(`${subscriptionSelect} WHERE id=?`).bind(id),
        ]);
        return subscriptionReply(subscriptionStatus(result.at(-1).results[0]));
      } catch(error) {
        if(String(error).includes('integer overflow')) throw new SubscriptionError(409,'subscription_retired');
        throw error;
      }
    }
    throw new SubscriptionError(405,'method_not_allowed');
  } catch(error) {
    if(error instanceof ScopeDenied) return subscriptionReply({error:'insufficient scope'},403);
    if(error instanceof SubscriptionError) return subscriptionReply({error:error.code},error.status);
    return subscriptionReply({error:'subscription_unavailable'},500);
  }
}
