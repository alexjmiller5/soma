import type { SqlDriver, Hub } from './driver.ts';
import { qident, validEditTimestamp, type Row } from './validate.ts';
import { COVERAGE_VERSION, coverageProblem, coverageSchema, incrementalProof, initCoverage } from './coverage.ts';
import type { SyncSettings, SyncResult } from './contract.generated.ts';
export type { SyncResult } from './contract.generated.ts';
export type SyncOptions = SyncSettings & { now?: () => Date; maxClockSkewMs?: number };
/** The size rule: without a host's maxRows, a round skips tables holding more rows than this. */
export const SIZE_RULE_ROWS = 50_000;

export async function initCore(db: SqlDriver): Promise<void> {
  await db.run("CREATE TABLE IF NOT EXISTS _schema_log (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), ddl TEXT NOT NULL)");
  await db.run('CREATE TABLE IF NOT EXISTS _sync_state (key TEXT PRIMARY KEY, value TEXT)');
  await db.run('CREATE TABLE IF NOT EXISTS _core_state (key TEXT PRIMARY KEY, value TEXT)');
  await db.run("CREATE TABLE IF NOT EXISTS _core_sync (tbl TEXT PRIMARY KEY, pull TEXT NOT NULL DEFAULT '', push TEXT NOT NULL DEFAULT '')");
  await db.run('CREATE TABLE IF NOT EXISTS _core_rejected (tbl TEXT, row_id TEXT, row TEXT NOT NULL, errors TEXT NOT NULL, PRIMARY KEY(tbl,row_id))');
  await db.run('CREATE TABLE IF NOT EXISTS _core_pending (tbl TEXT NOT NULL, row_id TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(tbl,row_id))');
  await db.run('CREATE TABLE IF NOT EXISTS _core_history_hold (tbl TEXT NOT NULL, row_id TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(tbl,row_id))');
  // An unfinished table pull: the first attempt's since and mark, and the last
  // applied page. Replay deletes it when the table's definition changes.
  await db.run('CREATE TABLE IF NOT EXISTS _core_pull_progress (tbl TEXT PRIMARY KEY, since TEXT NOT NULL, mark TEXT NOT NULL, after TEXT NOT NULL)');
  // How many rows a table held at its own cursor mark when last pulled: the hub
  // reports the same count with each cursor, so an unchanged table whose newest
  // arrival is that mark needs no inclusive re-read.
  await db.run('CREATE TABLE IF NOT EXISTS _core_pull_marks (tbl TEXT PRIMARY KEY, n INTEGER NOT NULL)');
  await initCoverage(db);
}

const active = new WeakSet<SqlDriver>();
const snapshotDDL='CREATE TABLE _core_sync_snapshot (sequence INTEGER PRIMARY KEY, kind TEXT NOT NULL, tbl TEXT NOT NULL, row_id TEXT NOT NULL, payload TEXT NOT NULL)';
export async function sync(db: SqlDriver, hub: Hub, options: SyncOptions = {}): Promise<SyncResult> {
  if(active.has(db)) throw new Error('sync already in progress');
  active.add(db);
  let ownsSnapshot=false;
  try {
    await db.run(snapshotDDL.replace('CREATE TABLE ','CREATE TABLE IF NOT EXISTS main.'));
    const definition=(await db.all("SELECT sql FROM main.sqlite_master WHERE type='table' AND name='_core_sync_snapshot'"))[0]?.sql;
    if(definition!==snapshotDDL) throw new Error('sync snapshot storage has an unexpected schema');
    if((await db.all("SELECT 1 FROM main.sqlite_master WHERE type='trigger' AND tbl_name='_core_sync_snapshot' UNION ALL SELECT 1 FROM temp.sqlite_master WHERE type='trigger' AND tbl_name='_core_sync_snapshot'")).length) throw new Error('sync snapshot storage has unexpected triggers');
    ownsSnapshot=true;
    await db.run('DELETE FROM main._core_sync_snapshot');
    await db.run('CREATE INDEX IF NOT EXISTS main._core_sync_snapshot_batch ON _core_sync_snapshot(kind,tbl,sequence)');
    await db.run('CREATE INDEX IF NOT EXISTS main._core_sync_snapshot_history ON _core_sync_snapshot(kind,tbl,row_id)');
    return await syncLocked(db,hub,options);
  } finally {
    try { if(ownsSnapshot) await db.run('DELETE FROM main._core_sync_snapshot'); }
    finally { active.delete(db); }
  }
}

/** Walk order: each table after the tables its catalog refs point at, so a new row and a
 * reference to it reach the hub in one round. Catalogs stay first; cycles keep name order. */
async function refOrder(db: SqlDriver, tables: string[]): Promise<string[]> {
  const cataloged=(await db.all("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name='catalog_properties'")).length>0;
  const refs=cataloged ? await db.all("SELECT tbl,ref_table FROM main.catalog_properties WHERE deleted_at IS NULL AND type IN ('ref','multi_ref') AND ref_table IS NOT NULL AND ref_table<>tbl") : [];
  const needs=new Map<string,Set<string>>();
  for(const {tbl,ref_table} of refs) if(tables.includes(String(tbl)) && tables.includes(String(ref_table)) && !String(ref_table).startsWith('catalog_'))
    needs.set(String(tbl),(needs.get(String(tbl)) ?? new Set()).add(String(ref_table)));
  const ordered: string[]=[], left=[...tables];
  while(left.length) {
    const next=left.findIndex(t=>[...(needs.get(t) ?? [])].every(r=>ordered.includes(r)));
    ordered.push(...left.splice(next<0 ? 0 : next,1));
  }
  return ordered;
}

function rowJSON(columns: string[]): string {
  // Stay below SQLite's argument limit, including wide user tables. json_set
  // preserves null-valued keys, unlike JSON merge-patch semantics.
  let json="'{}'";
  for(let i=0;i<columns.length;i+=40) {
    json=`json_set(${json},${columns.slice(i,i+40).map(c=>`'$.${qident(c).slice(1,-1)}',${qident(c)}`).join(',')})`;
  }
  return json;
}

async function freezeRows(db: SqlDriver, kind: 'row'|'history', table: string, columns: string[], where: string, params: string[], owner=table): Promise<void> {
  let after:string|null=null;
  while(true) {
    // Keyset comparisons/order use the real PK's collation, including WITHOUT
    // ROWID tables. The enclosing transaction freezes membership and payloads.
    const copied=await db.run(`INSERT INTO main._core_sync_snapshot(kind,tbl,row_id,payload) SELECT ?,?,${kind==='row'?'id':'row_id'},${rowJSON(columns)} FROM main.${qident(table)} WHERE (${where})${after===null?'':' AND id>?'} ORDER BY id LIMIT 1000`,[kind,owner,...params,...(after===null?[]:[after])]);
    if(copied<1000) break;
    after=String((await db.all("SELECT json_extract(payload,'$.id') AS id FROM main._core_sync_snapshot WHERE kind=? AND tbl=? ORDER BY sequence DESC LIMIT 1",[kind,owner]))[0].id);
  }
}

async function syncLocked(db: SqlDriver, hub: Hub, options: SyncOptions): Promise<SyncResult> {
  const result: SyncResult = { pulled: 0, pushed: 0, skipped: [], rejected: [] };
  await initCore(db);
  const endpoint=(await db.all("SELECT value FROM _core_state WHERE key='hub'"))[0]?.value;
  const cliState=(await db.all("SELECT value FROM _sync_state WHERE key='hub_url'"))[0]?.value;
  if ([endpoint,cliState].some(value=>value && value!==hub.endpoint)) throw new Error('hub changed; use a fresh replica');
  // Exclusions are known before the first HTTP yield. Never let foreground
  // validation borrow a certificate the caller has already withdrawn.
  await db.transaction(async()=>{
    for(const [table, included] of Object.entries(options.tables??{})) {
      if(!included && !table.startsWith('catalog_')) await db.run('DELETE FROM _core_coverage WHERE tbl=?',[table]);
    }
  });
  const priorMetadataReady=endpoint===hub.endpoint && cliState===hub.endpoint && await coverageProblem(db,[])===null;
  const now=options.now ?? (()=>new Date());
  // Observe rollback even when the first network request fails. Check again
  // under the snapshot transaction in case the clock changes during I/O.
  await db.run("UPDATE _core_sync SET push='' WHERE push > ?",[now().toISOString()]);
  let clockSkew: number | null=null;
  const post = async (route: string, body: Row = {}) => {
    if(route.endsWith('/push') && (clockSkew===null || clockSkew > (options.maxClockSkewMs ?? 300_000))) throw new Error('device clock cannot be verified against hub; check date and time');
    const started=now().getTime();
    const reply=await hub.post(route,body);
    const ended=now().getTime(), server=Date.parse(reply.date??'');
    // HTTP dates have one-second precision; request duration bounds transit delay.
    if(Number.isFinite(server)) clockSkew=Math.max(0,server-ended,started-server-1000);
    return reply.data as any;
  };
  const userTables=async()=>(await db.all("SELECT name FROM sqlite_master WHERE type='table'")).map(r=>String(r.name)).filter(t=>!t.startsWith('_')&&!t.startsWith('sqlite_')).sort((a,b)=>Number(!a.startsWith('catalog_'))-Number(!b.startsWith('catalog_'))||a.localeCompare(b));
  const validMark=(value:unknown)=>value===''||validEditTimestamp(value);
  const readCursor=async(tables:string[])=>{
    const marks=await post('/v1/cursor',{tables}); // BEFORE pull; remote writes after this land next round.
    if(!marks || !validMark(marks.max_hub_at) || !marks.tables || tables.some(t=>!validMark(marks.tables[t]))) throw new Error('invalid cursor response');
    return marks;
  };
  const stateValue=async(key:string)=>(await db.all('SELECT value FROM _core_state WHERE key=?',[key]))[0]?.value;
  // A quiet round is one request. The cursor carries the hub's newest schema
  // entry id; with it and our own log unchanged since the last exchange there
  // is nothing to pull or push, so the schema round trip is skipped.
  let allTables=await userTables();
  // A replica without tables yet has nothing to ask the cursor about before
  // the schema exchange; its one cursor read comes after it.
  let marks=allTables.length ? await readCursor(allTables) : null;
  const logMax=async()=>Number((await db.all('SELECT coalesce(max(id),0) AS m FROM _schema_log'))[0]?.m ?? 0);
  const exchanged=String(await stateValue('schema_exchange') ?? '');
  const localMax=await logMax();
  if(!marks || exchanged!==JSON.stringify({hub:marks.schema ?? null,local:localMax})) {
  const local = await db.all('SELECT applied_at,ddl FROM _schema_log ORDER BY applied_at,id');
  const known = new Set(local.map(r=>r.ddl));
  const {entries} = await post('/v1/schema/pull');
  if (!Array.isArray(entries)) throw new Error('invalid schema response');
  const remoteKnown = new Set(entries.map(e=>e.ddl));
  const unsent = local.filter(e=>!remoteKnown.has(e.ddl));
  if (unsent.length) await post('/v1/schema/push',{entries:unsent});
  const tableDefinitions=async()=>new Map((await db.all("SELECT name,sql FROM main.sqlite_master WHERE type='table'")).map(r=>[String(r.name),String(r.sql)]));
  for (const entry of entries) {
    if (known.has(entry.ddl)) continue;
    await db.transaction(async () => {
      await db.run("INSERT OR REPLACE INTO _core_state(key,value) VALUES ('coverage_phase','refreshing')");
      const before=await tableDefinitions();
      try { await db.run(entry.ddl); }
      catch (error) {
        const message=String(error).toLowerCase();
        const droppedView=message.includes('no such view') && /^\s*DROP\s+VIEW\b/i.test(entry.ddl);
        if (!['already exists','duplicate column','no such column'].some(s=>message.includes(s)) && !(message.includes('no such table')&&/^\s*ALTER\s+TABLE\s+\S+\s+RENAME\s+TO\b/i.test(entry.ddl)) && !droppedView) throw error;
      }
      await db.run('INSERT INTO _schema_log(applied_at,ddl) VALUES (?,?)',[entry.applied_at,entry.ddl]);
      // A table this entry created, dropped, renamed or altered needs its next
      // pull in full (a rebuild can keep identical SQL); every other cursor stays.
      const after=await tableDefinitions();
      for(const name of new Set([...before.keys(),...after.keys()])) if(before.get(name)!==after.get(name)) {
        await db.run('DELETE FROM _core_coverage WHERE tbl=?',[name]);
        await db.run('DELETE FROM _core_pull_progress WHERE tbl=?',[name]);
      }
    });
    known.add(entry.ddl);
  }
  // Our push moved the hub's log; its id is only known after the next cursor
  // read, which this round takes anyway when the table list changed.
  const before=allTables;
  allTables=await userTables();
  if(!marks || unsent.length || allTables.join('\n')!==before.join('\n')) marks=await readCursor(allTables);
  await db.run("INSERT OR REPLACE INTO _core_state(key,value) VALUES ('schema_exchange',?)",[JSON.stringify({hub:marks.schema ?? null,local:await logMax()})]);
  }
  if(!marks) throw new Error('invalid cursor response');
  // Pin both clients before importing any data, including on a partial round.
  // Binding an unbound CLI must not legitimize its unknown global cursors.
  await db.transaction(async()=>{
    await db.run("INSERT OR REPLACE INTO _core_state(key,value) VALUES ('hub',?)",[hub.endpoint]);
    await db.run("INSERT OR REPLACE INTO _core_state(key,value) VALUES ('coverage_phase',?)",[priorMetadataReady ? 'ready' : 'refreshing']);
    if(!cliState) {
      await db.run("INSERT OR REPLACE INTO _sync_state(key,value) VALUES ('hub_url',?),('checkpoint_version','')",[hub.endpoint]);
    }
  });
  // Table sizes drive the size rule only; the hub recounts daily, so a day-old
  // answer that names every table is reused instead of asked for each round.
  const counts:Record<string,number>=await (async()=>{
    try {
      const cached=JSON.parse(String(await stateValue('hub_stats') ?? 'null'));
      if(cached && typeof cached.at==='string' && now().getTime()-Date.parse(cached.at)<86_400_000 && allTables.every(t=>Number.isFinite(cached.tables?.[t]))) return cached.tables;
    } catch {}
    const fresh=(await post('/v1/stats')).tables;
    await db.run("INSERT OR REPLACE INTO _core_state(key,value) VALUES ('hub_stats',?)",[JSON.stringify({at:now().toISOString(),tables:fresh})]);
    return fresh;
  })();
  const tables=await refOrder(db,allTables.filter(t=>t.startsWith('catalog_') || (options.tables?.[t] ?? (Number.isFinite(counts?.[t]) && counts[t] <= (options.maxRows ?? SIZE_RULE_ROWS)))));
  tables.sort((a,b)=>Number(a==='history')-Number(b==='history'));
  result.skipped=allTables.filter(t=>!tables.includes(t));
  await db.transaction(async()=>{
    for(const table of result.skipped) await db.run('DELETE FROM _core_coverage WHERE tbl=?',[table]);
  });
  // A hub that advertises pull_batch answers many table pages per request.
  const batch=marks.pull_batch, batching=[batch?.items,batch?.rows].every(n=>Number.isSafeInteger(n)&&n>0) ? {items:Number(batch.items),rows:Number(batch.rows)} : null;
  const states=new Map((await db.all('SELECT * FROM _core_sync')).map(r=>[String(r.tbl),r]));
  const proofs=new Map((await db.all('SELECT * FROM _core_coverage')).map(r=>[String(r.tbl),r]));
  const pullSince=new Map<string,string>();
  let coverageSignature='';
  const columns=new Map<string,string[]>();
  let checkpoint='';
  await db.transaction(async()=>{
    coverageSignature=(await coverageSchema(db)).signature;
    // Persist exclusions and invalidated cursors even if this round fails. A
    // schema change elsewhere leaves a table's cursor valid; validation trust
    // still needs this round's signature (coverageProblem).
    for(const proof of proofs.values()) if(!tables.includes(String(proof.tbl)) || !incrementalProof(proof,hub.endpoint,coverageSignature,states.get(String(proof.tbl))?.pull)) {
      await db.run('DELETE FROM _core_coverage WHERE tbl=?',[String(proof.tbl)]);
    }
    checkpoint=(options.now?.() ?? new Date()).toISOString();
    // Persist recovery even if this round fails, rejects, or skips a table.
    await db.run("UPDATE _core_sync SET push='' WHERE push > ?",[checkpoint]);
    for(const state of states.values()) if(String(state.push)>checkpoint) state.push='';
    for(const table of tables) {
      pullSince.set(table,endpoint && incrementalProof(proofs.get(table),hub.endpoint,coverageSignature,states.get(table)?.pull) ? String(states.get(table)!.pull) : '');
      columns.set(table,(await db.all(`PRAGMA table_info(${qident(table)})`)).map(r=>String(r.name)));
      const push=String(states.get(table)?.push??'');
      const since=endpoint && push<=checkpoint ? push : '';
      // Pending UI rows need our own receipt even when another writer/clock
      // has moved their state behind this client's timestamp checkpoint.
      await freezeRows(db,'row',table,columns.get(table)!, 'updated_at >= ? OR id IN (SELECT row_id FROM _core_pending WHERE tbl=?)',[since,table]);
      if(allTables.includes('history') && table!=='history') {
        const historyColumns=(await db.all('PRAGMA table_info(history)')).map(r=>String(r.name));
        await freezeRows(db,'history','history',historyColumns,"tbl=? AND (updated_at>=? OR row_id IN (SELECT row_id FROM _core_pending WHERE tbl=?)) AND row_id IN (SELECT row_id FROM main._core_sync_snapshot WHERE kind='row' AND tbl=?)",[table,since,table,table],table);
      }
    }
  });
  const withheld=new Set<unknown>();
  const deferred=new Set<string>();
  // Each table's walk: its first page (after a resumed one's last applied page)
  // and mark. Resuming keeps the first attempt's mark: rows changed since then
  // in pages already applied carry a later hub_at and arrive next round.
  const resumed=new Map((await db.all('SELECT tbl,since,mark,after FROM _core_pull_progress')).map(r=>[String(r.tbl),r]));
  const held=new Map((await db.all('SELECT tbl,n FROM _core_pull_marks')).map(r=>[String(r.tbl),Number(r.n)]));
  const walks=new Map(tables.map(table=>{
    const since=pullSince.get(table)!, progress=resumed.get(table);
    const resume=progress && progress.since===since && validMark(progress.mark) && typeof progress.after==='string' && progress.after;
    // A table whose newest arrival never reached our cursor has nothing new
    // (the pull is inclusive, so is this test): no request for it at all. The
    // cursor is the round's newest arrival over every table, so only tables
    // written since then are asked again. A table whose newest arrival IS our
    // cursor is quiet too while the hub holds as many rows at that mark as we
    // pulled; a commit stamped in that millisecond after the cursor read adds one.
    const mark=String(marks.tables[table]);
    const quiet=since!=='' && (mark<since || (mark===since && !resume && Number.isSafeInteger(marks.at_mark?.[table]) && held.get(table)===marks.at_mark[table]));
    return [table,{since,mark:resume ? String(progress.mark) : quiet ? since : String(marks.max_hub_at),after:resume ? String(progress.after) : undefined,quiet}];
  }));
  const fullRows=tables.filter(t=>walks.get(t)!.since===''&&!walks.get(t)!.quiet);
  const progress={tablesDone:tables.filter(t=>walks.get(t)!.quiet).length,tablesTotal:tables.length,rowsReceived:0,rowsExpected:fullRows.length ? fullRows.reduce((n,t)=>n+(Number.isSafeInteger(counts?.[t]) ? counts[t] : 0),0) : null,table:null as string|null};
  const report=()=>hub.progress?.({...progress});
  // Pages fetched ahead with an earlier table's request, by table and cursor.
  const ahead=new Map<string,{after:string|undefined,page:any}>();
  const want=(table:string,received:number)=>walks.get(table)!.since==='' && Number.isSafeInteger(counts?.[table]) ? Math.max(counts[table]-received,0)+1 : 1000;
  const fetchPage=async(table:string,after:string|undefined,received:number)=>{
    const item=(t:string,a:string|undefined,limit:number)=>({table:t,columns:columns.get(t)!,since:walks.get(t)!.since,limit,...(a ? {after:a} : {})});
    if(!batching) return post('/v1/rows/pull',item(table,after,200));
    const cached=ahead.get(table);
    ahead.delete(table);
    if(cached && cached.after===after) return cached.page;
    // This table's page, then the first pages of the tables after it while
    // the request has room: a cold start is mostly small tables.
    const limit=Math.min(Math.max(want(table,received),200),batching.rows);
    const items=[item(table,after,limit)];
    let room=batching.rows-limit;
    for(const next of tables.slice(tables.indexOf(table)+1)) {
      if(items.length>=batching.items || room<1) break;
      const walk=walks.get(next)!;
      if(walk.quiet || ahead.has(next)) continue;
      const nextLimit=Math.min(want(next,0),room);
      items.push(item(next,walk.after,nextLimit));
      room-=nextLimit;
    }
    const reply=await post('/v1/rows/pull',{batch:items});
    // A hub over its byte budget answers a prefix of the pulls asked.
    if(!Array.isArray(reply?.batch) || reply.batch.length<1 || reply.batch.length>items.length) throw new Error('invalid pull response');
    reply.batch.slice(1).forEach((page:unknown,i:number)=>ahead.set(items[i+1].table,{after:items[i+1].after,page}));
    return reply.batch[0];
  };
  report();
  for (const table of tables) {
    const cols=columns.get(table)!;
    const {since,quiet}=walks.get(table)!;
    let {mark,after}=walks.get(table)!;
    let received=0;
    progress.table=table;
    if(!quiet) do {
      const page=await fetchPage(table,after,received);
      if (!Array.isArray(page.rows)) throw new Error('invalid pull response');
      if(page.next_cursor!=null && (typeof page.next_cursor!=='string' || page.next_cursor<=(after??'') || !page.rows.length)) throw new Error('invalid pull cursor');
      if(page.rows.some((r:Row)=>!r||typeof r!=='object'||Array.isArray(r)
        ||Object.keys(r).length!==cols.length
        ||cols.some(c=>!Object.hasOwn(r,c)||(r[c]!==null&&typeof r[c]!=='string'&&!(typeof r[c]==='number'&&Number.isFinite(r[c]))))
        ||typeof r.id!=='string'||!validEditTimestamp(r.updated_at))) throw new Error('invalid pulled row');
      if (page.rows.length) await db.transaction(async()=>{
        if(table.startsWith('catalog_')) {
          const current=new Map((await db.all(`SELECT id,updated_at FROM ${qident(table)} WHERE id IN (SELECT value FROM json_each(?))`,[JSON.stringify(page.rows.map((r:Row)=>r.id))])).map(r=>[r.id,String(r.updated_at)]));
          if(page.rows.some((row:Row)=>!current.has(row.id)||String(row.updated_at)>current.get(row.id)!)) {
            // A paginated metadata replacement is not atomic. Revoke trust
            // before the first applicable row; only final certification restores it.
            await db.run("INSERT OR REPLACE INTO _core_state(key,value) VALUES ('coverage_phase','refreshing')");
          }
        }
        // A UI revision must reach its own push receipt before LWW can replace
        // its payload. Keep the old pull checkpoint so deferred rows replay
        // after acknowledgment, including after process restart.
        // Compare in SQLite with the actual primary-key collation, then return
        // the remote spelling for the JS filter (NOCASE/RTRIM IDs need not match).
        const pending=new Set((await db.all(`SELECT json_extract(r.value,'$.id') AS id FROM json_each(?) r JOIN ${qident(table)} t ON t.id=json_extract(r.value,'$.id') JOIN _core_pending p ON p.tbl=? AND t.id=p.row_id WHERE json_extract(r.value,'$.updated_at')>t.updated_at`,[JSON.stringify(page.rows),table])).map(r=>r.id));
        const applicable=page.rows.filter((row:Row)=>{
          if(pending.has(row.id)) { deferred.add(table); return false; }
          return true;
        });
        if(applicable.length) result.pulled+=await db.run(upsertSql(table,cols),[JSON.stringify(applicable)]);
        // A deferral keeps the old cursor, so no resumable page progress either.
        if(deferred.has(table) || !page.next_cursor) await db.run('DELETE FROM _core_pull_progress WHERE tbl=?',[table]);
        else await db.run('INSERT OR REPLACE INTO _core_pull_progress(tbl,since,mark,after) VALUES (?,?,?,?)',[table,since,mark,page.next_cursor]);
      });
      received+=page.rows.length;
      progress.rowsReceived+=page.rows.length;
      report();
      after=page.next_cursor;
    } while (after);
    const held=table==='history' ? new Set((await db.all('SELECT tbl,row_id FROM _core_rejected UNION SELECT tbl,row_id FROM _core_history_hold')).map(r=>JSON.stringify([r.tbl,r.row_id]))) : new Set();
    const bad: Row[]=[];
    let sequence=0;
    while(true) {
      const batch=await db.all("SELECT sequence,payload FROM main._core_sync_snapshot WHERE kind='row' AND tbl=? AND sequence>? ORDER BY sequence LIMIT 200",[table,sequence]);
      if(!batch.length) break;
      sequence=Number(batch.at(-1)!.sequence);
      const rows=batch.map(r=>JSON.parse(String(r.payload)) as Row).filter(row=>{
        if(table==='history' && held.has(JSON.stringify([row.tbl,row.row_id]))) { withheld.add(row.id);return false; }
        return true;
      });
      if(!rows.length) continue;
      const ids=new Set(rows.map(r=>r.id));
      const history=(await db.all("SELECT payload FROM main._core_sync_snapshot WHERE kind='history' AND tbl=? AND row_id IN (SELECT value FROM json_each(?)) ORDER BY sequence",[table,JSON.stringify([...ids])])).map(r=>JSON.parse(String(r.payload)) as Row);
      const push=async(part: Row[]): Promise<{upserted: number, rejected: Row[]}>=>{
        const partIds=new Set(part.map(r=>r.id));
        const events=history.filter(e=>partIds.has(e.row_id));
        const out=await post('/v1/rows/push',{table,columns:cols,rows:part,...(events.length ? {history:events} : {})});
        if(!out||!Number.isInteger(out.upserted)||out.upserted<0||out.upserted>part.length||!Array.isArray(out.rejected)||out.rejected.some((r:Row)=>!r||!partIds.has(r.id))) throw new Error('invalid push response');
        if(out.upserted+new Set(out.rejected.map((r:Row)=>r.id)).size!==part.length) throw new Error('invalid push response');
        // The hub asks for a smaller batch when one request runs out of budget
        // or history search; halve those rows until a single row still fails.
        const retry=new Set(out.rejected.filter((r:Row)=>r.retryable===true||r.rule==='write-budget').map((r:Row)=>r.id));
        if(part.length<2||!retry.size) return out;
        const again=part.filter(r=>retry.has(r.id)), mid=Math.ceil(again.length/2);
        const halves=[await push(again.slice(0,mid)),...(again.length>1 ? [await push(again.slice(mid))] : [])];
        return {upserted:out.upserted+halves.reduce((n,h)=>n+h.upserted,0),rejected:[...out.rejected.filter((r:Row)=>!retry.has(r.id)),...halves.flatMap(h=>h.rejected)]};
      };
      const out=await push(rows);
      const rejectedIds=new Set(out.rejected.map((r:Row)=>r.id));
      result.pushed+=out.upserted;
      bad.push(...out.rejected);
      for(const event of history) if(rejectedIds.has(event.row_id)) withheld.add(event.id);
      // Persist each receipt before another request can fail. History fallback
      // consults this inbox even when its owning table is excluded next round.
      await db.transaction(async()=>{
        for(const row of rows) {
          const errors=out.rejected.filter((e:Row)=>e.id===row.id);
          if(errors.length) {
            // Superseded rejection receipts must still withhold their history
            // across restart/exclusion, without labeling the newer edit rejected.
            await db.run('INSERT INTO _core_history_hold(tbl,row_id,updated_at) VALUES (?,?,?) ON CONFLICT(tbl,row_id) DO UPDATE SET updated_at=max(updated_at,excluded.updated_at)',[table,String(row.id),String(row.updated_at)]);
            const current=(await db.all(`SELECT updated_at FROM ${qident(table)} WHERE id=?`,[String(row.id)]))[0];
            if(current?.updated_at===row.updated_at) await db.run('INSERT OR REPLACE INTO _core_rejected(tbl,row_id,row,errors) VALUES (?,?,?,?)',[table,String(row.id),JSON.stringify(row),JSON.stringify(errors)]);
          }
          else {
            await db.run('DELETE FROM _core_rejected WHERE tbl=? AND row_id=?',[table,String(row.id)]);
            await db.run('DELETE FROM _core_pending WHERE tbl=? AND row_id=? AND updated_at<=?',[table,String(row.id),String(row.updated_at)]);
            await db.run('DELETE FROM _core_history_hold WHERE tbl=? AND row_id=? AND updated_at<=?',[table,String(row.id),String(row.updated_at)]);
          }
        }
      });
    }
    result.rejected.push(...bad.map(r=>({...r,table})));
    // Each finished table keeps its cursors, so a later failure or host deadline
    // never sends the next round back through tables already done.
    await db.transaction(async()=>{
      const rejected=bad.length>0||(table==='history'&&withheld.size>0);
      const pull=deferred.has(table) ? String(states.get(table)?.pull??'') : mark;
      await db.run('INSERT OR REPLACE INTO _core_sync(tbl,pull,push) VALUES (?,?,?)',[table,pull,rejected ? String(states.get(table)?.push??'') : checkpoint]);
      // A deferred bootstrap has no complete proof. An incremental deferral
      // retains only the already validated proof at its unchanged checkpoint.
      if(!deferred.has(table)) await db.run('INSERT OR REPLACE INTO _core_coverage(tbl,endpoint,schema,pull,version) VALUES (?,?,?,?,?)',[table,hub.endpoint,coverageSignature,pull,COVERAGE_VERSION]);
      await db.run('DELETE FROM _core_pull_progress WHERE tbl=?',[table]);
      // Only a table whose newest arrival is the cursor it just took can be
      // asked again by the inclusive pull; remember how much of that mark it holds.
      if(!quiet) {
        if(!deferred.has(table) && pull!=='' && String(marks.tables[table])===pull) await db.run('INSERT OR REPLACE INTO _core_pull_marks(tbl,n) VALUES (?,?)',[table,Number((await db.all(`SELECT count(*) AS n FROM ${qident(table)} WHERE hub_at=?`,[pull]))[0]?.n ?? 0)]);
        else await db.run('DELETE FROM _core_pull_marks WHERE tbl=?',[table]);
      }
    });
    if(!quiet) { progress.tablesDone++; report(); }
  }
  // Certification and completion commit only after every request succeeds.
  // Rejected rows wait in the inbox; they do not make a finished round unsuccessful.
  await db.transaction(async()=>{
    if((await coverageSchema(db)).signature!==coverageSignature) throw new Error('schema changed during sync; retry before certifying coverage');
    await db.run("INSERT OR REPLACE INTO _core_state(key,value) VALUES ('hub',?)",[hub.endpoint]);
    await db.run("INSERT OR REPLACE INTO _core_state(key,value) VALUES ('coverage_phase','ready')");
    await db.run("INSERT OR REPLACE INTO _core_state(key,value) VALUES ('skipped_tables',?)",[JSON.stringify(result.skipped)]);
    await db.run("INSERT OR REPLACE INTO _core_state(key,value) VALUES ('last_sync',?)",[checkpoint]);
  });
  return result;
}

export function upsertSql(table: string, columns: string[]): string {
  const t=qident(table);
  return `INSERT INTO ${t} (${columns.map(qident).join(',')}) SELECT ${columns.map(c=>`json_extract(value,'$.${qident(c).slice(1,-1)}')`).join(',')} FROM json_each(?) WHERE true ON CONFLICT(id) DO UPDATE SET ${columns.filter(c=>c!=='id').map(c=>`${qident(c)}=excluded.${qident(c)}`).join(',')} WHERE excluded.updated_at > ${t}.updated_at`;
}
