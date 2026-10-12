import { authorizeTable, broadTableAccess, ScopeDenied } from './scopes.js';
import { MAX_DELIVERY_BYTES } from './subscription-triggers.js';
import { changeWaiter } from './changes.js';

export const subscriptionReply = (body,status=200) => Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
export class SubscriptionError extends Error {
  constructor(status,code){super(code);this.status=status;this.code=code;}
}
export const subscriptionAdmin = tenant => tenant.admin || tenant.scopes.includes('admin');
const denied = () => {throw new ScopeDenied('insufficient scope');};
export const subscriptionSelect = `SELECT id,label,sources_json,state,created_at,
  CAST(last_seq AS TEXT) AS last_seq,CAST(acked_seq AS TEXT) AS acked_seq,
  pending_delivery_id,CAST(pending_through_seq AS TEXT) AS pending_through_seq,last_acked_delivery_id,
  pending_event_count,pending_byte_count,max_pending_events,max_pending_bytes
  FROM _change_subscriptions`;

export function subscriptionStatus(sub) {
  return {id:sub.id,protocol:'durable-pull-v1',label:sub.label,state:sub.state,created_at:sub.created_at,
    sources:JSON.parse(sub.sources_json),last_seq:sub.last_seq,acked_seq:sub.acked_seq,
    pending_event_count:sub.pending_event_count,pending_byte_count:sub.pending_byte_count,
    max_pending_events:sub.max_pending_events,max_pending_bytes:sub.max_pending_bytes};
}
export function authorizeSubscription(tenant,sub) {
  if(subscriptionAdmin(tenant)) return;
  if(!tenant.scopes.includes(`subscriptions:consume:${sub.id}`)
    || !JSON.parse(sub.sources_json).every(source=>broadTableAccess(tenant.scopes,'read') || authorizeTable(tenant.scopes,'read',source.table))) denied();
}
export async function loadSubscription(tenant,id) {
  if(!subscriptionAdmin(tenant) && !tenant.scopes.includes(`subscriptions:consume:${id}`)) denied();
  if(!await tenant.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_change_subscriptions'").first()) denied();
  const sub=await tenant.db.prepare(`${subscriptionSelect} WHERE id=?`).bind(id).first();
  if(!sub) denied();
  authorizeSubscription(tenant,sub);
  return sub;
}
async function currentTenant(tenant) {
  if(tenant.admin) return tenant;
  const row=await tenant.authDb.prepare('SELECT name,scopes FROM _tokens WHERE hash=? AND revoked_at IS NULL').bind(tenant.hash).first();
  if(!row) denied();
  return {...tenant,name:row.name,scopes:row.scopes.split(',')};
}
const eventColumns = 'CAST(e.seq AS TEXT) AS seq,e.event_id,e.recorded_at,e.payload_json';
const event = row => ({...JSON.parse(row.payload_json),id:row.event_id,seq:row.seq,recorded_at:row.recorded_at});
const empty = sub => ({subscription_id:sub.id,delivery_id:null,through_seq:sub.acked_seq,events:[]});

async function offeredSnapshot(db,id) {
  const result=await db.batch([
    db.prepare(`${subscriptionSelect} WHERE id=?`).bind(id),
    db.prepare(`SELECT ${eventColumns} FROM _change_events e JOIN _change_subscriptions s ON s.id=e.subscription_id
      WHERE s.id=? AND s.state != 'paused' AND s.pending_delivery_id IS NOT NULL
      AND e.seq>s.acked_seq AND e.seq<=s.pending_through_seq ORDER BY e.seq`).bind(id),
  ]);
  const sub=result[0].results[0];
  if(!sub) denied();
  const rows=result[1].results;
  const body=sub.state==='paused' || !sub.pending_delivery_id ? empty(sub)
    : {subscription_id:id,delivery_id:sub.pending_delivery_id,through_seq:sub.pending_through_seq,events:rows.map(event)};
  if(body.delivery_id && !body.events.length) throw new SubscriptionError(500,'delivery_unavailable');
  return {sub,body};
}
async function offer(db,sub) {
  if(sub.state==='paused' || sub.pending_delivery_id) return offeredSnapshot(db,sub.id);
  const {results:candidates}=await db.prepare(`SELECT ${eventColumns} FROM _change_events e
    WHERE e.subscription_id=? AND e.seq>CAST(? AS INTEGER) ORDER BY e.seq LIMIT 100`).bind(sub.id,sub.acked_seq).all();
  if(!candidates.length) return {sub,body:empty(sub)};
  const delivery=crypto.randomUUID(),events=[];let bytes=0,through=sub.acked_seq;
  for(const row of candidates) {
    const item=event(row),length=new TextEncoder().encode(JSON.stringify(item)).length;
    const envelope=new TextEncoder().encode(JSON.stringify({subscription_id:sub.id,delivery_id:delivery,through_seq:row.seq,events:[]})).length;
    if(envelope+bytes+length+events.length>MAX_DELIVERY_BYTES) break;
    bytes+=length;events.push(item);through=row.seq;
  }
  if(!events.length) throw new SubscriptionError(500,'delivery_unavailable');
  // Another poll may have offered first, or an ACK may have advanced the cursor.
  // The snapshot always reads the actual persisted receipt in one transaction.
  await db.prepare(`UPDATE _change_subscriptions SET pending_delivery_id=?,pending_through_seq=CAST(? AS INTEGER)
    WHERE id=? AND pending_delivery_id IS NULL AND acked_seq=CAST(? AS INTEGER) AND state != 'paused'`)
    .bind(delivery,through,sub.id,sub.acked_seq).run();
  return offeredSnapshot(db,sub.id);
}
function sleep(ms,signal) {
  return new Promise(resolve=>{
    const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',finish);resolve();};
    const timer=setTimeout(finish,ms);
    if(signal?.aborted) finish(); else signal?.addEventListener('abort',finish,{once:true});
  });
}
// Settles undefined when the wait fails or the caller disconnects; a held
// signal wait then times out on its own.
function waited(promise,signal) {
  const failed=promise.catch(error=>{console.log(JSON.stringify({subscription_wait_error:String(error)}));});
  return signal ? Promise.race([failed,new Promise(resolve=>{
    if(signal.aborted) resolve(); else signal.addEventListener('abort',()=>resolve(),{once:true});
  })]) : failed;
}
// D1 is read at the start, when the change signal reports a commit naming a
// source table, every MAX_WAIT seconds (covering a lost bump) and at the
// deadline. The seq is read BEFORE each check, so a commit the check misses
// bumps past it and the wait returns at once. Without the signal (or once it
// fails) the poll re-reads every second.
export async function pollEvents(tenant,id,seconds,{now=Date.now,sleep:pause=sleep,signal,changes=changeWaiter()}={}) {
  const deadline=now()+seconds*1000;
  let seq=changes && seconds>0 ? await waited(changes(null,[],0),signal) : undefined;
  for(;;) {
    if(signal?.aborted) throw new SubscriptionError(499,'request_cancelled');
    const snapshot=await offer(tenant.db,await loadSubscription(tenant,id));
    if(snapshot.body.events.length || now()>=deadline) {
      // Uncached status read, with no repeated last_used write or auth memo reset.
      authorizeSubscription(await currentTenant(tenant),snapshot.sub);
      if(signal?.aborted) throw new SubscriptionError(499,'request_cancelled');
      return subscriptionReply(snapshot.body);
    }
    const left=Math.max(0,deadline-now());
    if(seq!==undefined) seq=await waited(changes(seq,JSON.parse(snapshot.sub.sources_json).map(s=>s.table),left/1000),signal);
    if(seq===undefined) await pause(Math.min(1000,left),signal);
  }
}

export async function acknowledgeSubscription(tenant,id,body) {
  const sub=await loadSubscription(tenant,id);
  authorizeSubscription(await currentTenant(tenant),sub);
  if(!body || Object.keys(body).length!==1 || typeof body.delivery_id!=='string' || !body.delivery_id || body.delivery_id.length>128) {
    throw new SubscriptionError(400,'invalid_acknowledgment');
  }
  const receipt=body.delivery_id;
  try {
    const result=await tenant.db.batch([
      tenant.db.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM _change_subscriptions WHERE id=?
        AND (pending_delivery_id=? OR last_acked_delivery_id=?)) THEN 1 ELSE abs(-9223372036854775808) END`).bind(id,receipt,receipt),
      tenant.db.prepare(`UPDATE _change_subscriptions SET
        pending_event_count=pending_event_count-(SELECT count(*) FROM _change_events WHERE subscription_id=? AND seq>acked_seq AND seq<=pending_through_seq),
        pending_byte_count=pending_byte_count-coalesce((SELECT sum(accounted_bytes) FROM _change_events WHERE subscription_id=? AND seq>acked_seq AND seq<=pending_through_seq),0),
        acked_seq=pending_through_seq,last_acked_delivery_id=pending_delivery_id,pending_delivery_id=NULL,pending_through_seq=NULL
        WHERE id=? AND pending_delivery_id=?`).bind(id,id,id,receipt),
      tenant.db.prepare('DELETE FROM _change_events WHERE subscription_id=? AND seq<=(SELECT acked_seq FROM _change_subscriptions WHERE id=?)').bind(id,id),
      tenant.db.prepare('SELECT CAST(acked_seq AS TEXT) AS acked_seq FROM _change_subscriptions WHERE id=?').bind(id),
    ]);
    return subscriptionReply(result.at(-1).results[0]);
  } catch(error) {
    if(String(error).includes('integer overflow')) throw new SubscriptionError(409,'delivery_conflict');
    throw error;
  }
}
