import {enrollmentProfile} from './enrollment-profile.js';
import {checkedReads,readGuards,queryBudget} from './write.js';
import {scopedTable,ScopeDenied,publicOptions} from './scopes.js';

// Injected by table creation: whether each is NOT NULL.
const ENGINE_COLUMNS={id:true,created_at:true,updated_at:true,hub_at:false,deleted_at:false};

const reply=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
export async function consumerConfig(request,tenant,env) {
  if(request.method!=='GET') return reply({error:'method not allowed'},405);
  if(new URL(request.url).search || !tenant.enrollmentProfile) return reply({error:'insufficient scope'},403);
  const current=await enrollmentProfile(env,tenant.enrollmentProfile.id);
  if(!current || current.revision!==tenant.enrollmentProfile.revision
    || current.scopes.length!==tenant.scopes.length || current.scopes.some(s=>!tenant.scopes.includes(s)))
    return reply({error:'profile_changed'},409);
  if(!current.config) return reply({error:'config unavailable'},404);
  return reply({profile:{id:current.id,revision:current.revision},config:current.config});
}

export async function catalogProjection(request,tenant) {
  if(request.method!=='POST') return reply({error:'method not allowed'},405);
  let body;
  try {
    const reader=request.body?.getReader();
    if(!reader) return reply({error:'invalid projection'},400);
    const parts=[];let size=0;
    while(true){
      const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;
      if(size>16384){await reader.cancel();return reply({error:'request too large'},413);}
      parts.push(value);
    }
    const bytes=new Uint8Array(size);let offset=0;
    for(const part of parts){bytes.set(part,offset);offset+=part.length;}
    body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  } catch {return reply({error:'invalid projection'},400);}
  const identifier=v=>typeof v==='string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v);
  if(!body || typeof body!=='object' || Object.keys(body).some(k=>!['table','columns'].includes(k))
    || !identifier(body.table) || !Array.isArray(body.columns) || !body.columns.length
    || body.columns.length>256 || new Set(body.columns).size!==body.columns.length || !body.columns.every(identifier))
    return reply({error:'invalid projection'},400);
  if(body.columns.some(c=>!tenant.scopes.includes(`catalog:read:${body.table}:${c}`)
    || !tenant.scopes.includes(`tables:read:${body.table}:${c}`))) return reply({error:'insufficient scope'},403);
  try {
    const db=queryBudget(tenant.db,100),view=checkedReads(db),schema=await scopedTable(view,body.table);
    if(body.columns.some(c=>!schema.some(s=>s.name===c))) throw new ScopeDenied();
    const {results:props}=await view.prepare('SELECT * FROM catalog_properties WHERE tbl=? AND col IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL ORDER BY id')
      .bind(body.table,JSON.stringify(body.columns)).all();
    const properties=body.columns.map(column=>{
      const matches=props.filter(p=>p.col===column);
      // Engine columns exist on every table; their meaning needs no user catalog row.
      if(!matches.length && Object.hasOwn(ENGINE_COLUMNS,column))
        return {column,type:column==='id'?'text':'datetime',description:null,required:ENGINE_COLUMNS[column],readOnly:true};
      if(matches.length!==1) throw new ScopeDenied();
      const p=matches[0];let options;
      if(p.options!=null) {
        options=JSON.parse(p.options);
        if(!Array.isArray(options) || options.some(o=>!o || typeof o.v!=='string'
          || (o.d!==undefined && typeof o.d!=='string') || (o.sort!==undefined && !Number.isFinite(o.sort)))) throw new ScopeDenied();
        options=publicOptions(options);
      }
      const readOnly=['id','created_at','updated_at','hub_at','deleted_at'].includes(column)
        || !!p.derived_by || !!p.immutable || !!p.options_sql || !tenant.scopes.includes(`tables:patch:${body.table}:${column}`);
      // A static default is plain catalog text; a sql: default is never disclosed.
      const fallback=typeof p.default_value==='string' && !p.default_value.startsWith('sql:') ? {default:p.default_value} : {};
      return {column,type:p.type,description:p.description??null,required:!!p.required,readOnly,...(options===undefined?{}:{options}),...fallback};
    });
    // The table's enforced rule texts, never their SQL, for any catalog reader of the table.
    const rules=await view.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalog_rules'").first()
      ? (await view.prepare("SELECT text FROM catalog_rules WHERE tbl=? AND kind='invariant' AND enforce != 0 AND deleted_at IS NULL AND text IS NOT NULL AND text != '' ORDER BY id")
        .bind(body.table).all()).results.map(r=>r.text) : [];
    await db.batch(readGuards(db,view.reads));
    return reply({table:body.table,properties,rules});
  } catch(error) {
    if(error instanceof ScopeDenied) return reply({error:'insufficient scope'},403);
    return reply({error:'metadata unavailable'},409);
  }
}
