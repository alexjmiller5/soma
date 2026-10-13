import {hashToken,validLabel} from './auth.js';
import {canonicalConsumerConfig} from '../../core/src/consumer-config.ts';
import {validEnrollmentScopes} from '../../core/src/enrollment-scopes.ts';
import {creationPolicies,creationGrant} from './creation.js';

export const validProfileId = id => typeof id === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(id);

const MAX_PROFILES_TEXT=65536,ONE_SECRET=5000,PART=4096;
// Cloudflare caps one secret at 5.1 kB, so the deploy stores the profile set
// gzip-compressed and base64-encoded: `gzip:<base64>` when that fits one
// secret, else numbered parts, ENROLLMENT_PROFILES = `gzip:<count>:<part 1>`
// and ENROLLMENT_PROFILES_<n> = part n. The count makes parts left from a
// larger earlier set inert.
export function profileSecrets(text) {
  const b64=Buffer.from(Bun.gzipSync(text)).toString('base64'),parts=[];
  if (b64.length+5<=ONE_SECRET) return {ENROLLMENT_PROFILES:'gzip:'+b64};
  for (let i=0; i<b64.length; i+=PART) parts.push(b64.slice(i,i+PART));
  return Object.fromEntries(parts.map((part,i)=>i ? [`ENROLLMENT_PROFILES_${i+1}`,part] : ['ENROLLMENT_PROFILES',`gzip:${parts.length}:${part}`]));
}
// Decompression stops at the same bound as plain JSON.
async function profilesText(env) {
  const value=env.ENROLLMENT_PROFILES;
  if (typeof value !== 'string' || !value.startsWith('gzip:')) return value;
  let b64=value.slice(5);
  const numbered=/^(\d{1,2}):/.exec(b64);
  if (numbered) {
    b64=b64.slice(numbered[0].length);
    for (let n=2; n<=Number(numbered[1]); n++) {
      if (typeof env[`ENROLLMENT_PROFILES_${n}`] !== 'string') return null;
      b64+=env[`ENROLLMENT_PROFILES_${n}`];
    }
  }
  const bytes=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));
  const reader=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const decoder=new TextDecoder('utf-8',{fatal:true});let text='';
  for (;;) {
    const {done,value:chunk}=await reader.read();if(done)break;
    text+=decoder.decode(chunk,{stream:true});
    if (text.length>MAX_PROFILES_TEXT) {await reader.cancel();return null;}
  }
  return text+decoder.decode();
}

// Installation-owned column profiles. No user schema or application grants ship
// in source. An unavailable or invalid profile cannot select legacy enrollment.
export async function enrollmentProfile(env,id) {
  if (!validProfileId(id)) return null;
  let text,profiles;
  try {text=await profilesText(env);} catch {return null;}
  if (typeof text !== 'string' || text.length > MAX_PROFILES_TEXT) return null;
  try {profiles=JSON.parse(text);} catch {return null;}
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)
    || !Object.hasOwn(profiles,id)) return null;
  const p=profiles[id];
  if (!p || !validLabel(p.label) || !validEnrollmentScopes(p.scopes)
    || Object.keys(p).some(k=>!['label','scopes','config'].includes(k))) return null;
  const label=p.label.trim(),scopes=[...p.scopes].sort();
  // A creation grant must name a current policy revision, as token creation requires.
  if (scopes.some(s=>s.startsWith('rows:create:'))) {
    const current=new Set((await creationPolicies(env)).map(creationGrant));
    if (scopes.some(s=>s.startsWith('rows:create:') && !current.has(s))) return null;
  }
  let config;
  if (Object.hasOwn(p,'config')) {
    try {config=canonicalConsumerConfig(p.config);} catch {return null;}
  }
  return {id,label,scopes,...(config === undefined ? {} : {config}),
    revision:await hashToken(JSON.stringify(config === undefined ? [id,label,scopes] : [id,label,scopes,config]))};
}
