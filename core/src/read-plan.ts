import type { PrepareReadPlanArgs, ReadPlan, ReadPlanGuard, View } from './contract.generated.ts';
import type { SqlDriver, Value } from './driver.ts';
import { readCatalog } from './catalog.ts';
import { calendarPolicy, loadSavedView } from './saved-views.ts';
import { compileReadQuery } from './view.ts';
import { qident, validEditTimestamp } from './validate.ts';

/** Flat caller-owned input is copied before any await, without invoking accessors. */
function input(value: PrepareReadPlanArgs): PrepareReadPlanArgs {
  if (!value || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new Error('Invalid read-plan arguments');
  const result: Record<string,unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !['workspaceID','replicaID','table','kind','viewID','expectedViewUpdatedAt'].includes(key)) throw new Error('Invalid read-plan arguments');
    const field=Object.getOwnPropertyDescriptor(value,key)!;
    if (!field.enumerable || !('value' in field)) throw new Error('Invalid read-plan arguments');
    result[key]=field.value;
  }
  for (const key of ['workspaceID','replicaID','table']) if (typeof result[key]!=='string' || !result[key] || (result[key] as string).length>512) throw new Error('Invalid read-plan identity');
  qident(result.table as string);
  if (!['list','count'].includes(result.kind as string)) throw new Error('Invalid read-plan kind');
  if (result.viewID!==undefined || result.expectedViewUpdatedAt!==undefined) {
    if (typeof result.viewID!=='string' || !result.viewID || result.viewID.length>512
      || typeof result.expectedViewUpdatedAt!=='string' || !validEditTimestamp(result.expectedViewUpdatedAt)) throw new Error('Selected view requires its revision');
  }
  return result as unknown as PrepareReadPlanArgs;
}

/** Read-only preparation. The host serializes this transaction with its backup;
 * a reader must recheck every guard on that backup before executing the plan.
 * Exact ordered rows are the fingerprints: no second platform hash algorithm,
 * lossy digest or SQL/value matching is needed to recognize schema/catalog drift. */
export async function prepareReadPlan(db: SqlDriver, value: PrepareReadPlanArgs): Promise<ReadPlan> {
  const args=input(value);
  return db.transaction(async()=>{
    const catalog=await readCatalog(db),table=catalog.tables.find(t=>t.id===args.table);
    if (!table) throw new Error('Read-plan table is unavailable in the catalog');
    // Snapshot only ordinary tables. Views may read hidden dependencies and are
    // not eligible until a transferable dependency/coverage contract exists.
    const physical=(await db.all("SELECT type FROM main.sqlite_master WHERE name=? COLLATE BINARY",[args.table]))[0];
    if (physical?.type!=='table') throw new Error('Read plans require an ordinary local table');
    const columns=new Set((await db.all(`PRAGMA main.table_info(${qident(args.table)})`)).map(r=>r.name));
    if (!columns.has('id') || !columns.has('deleted_at')) throw new Error('Read-plan table schema is unavailable');
    const display=typeof table.display==='string' && table.display ? table.display : null;
    if (display && (!columns.has(display) || (display!=='id' && !catalog.properties.some(p=>p.tbl===args.table && p.col===display && !p.deprecated)))) throw new Error('Read-plan display column is unavailable');
    let view:View={table:args.table};
    let policy:ReadPlan['calendarPolicy']=null;
    let viewUpdatedAt:string|null=null;
    if (args.viewID!==undefined) {
      const selected=await loadSavedView(db,args.viewID);
      if (selected.id!==args.viewID || selected.tbl!==args.table || selected.updated_at!==args.expectedViewUpdatedAt) throw new Error('Selected view revision or target changed');
      if (!selected.view || !selected.definition || selected.unavailable) throw new Error(selected.unavailable ?? 'Saved view unavailable');
      view=selected.view; viewUpdatedAt=selected.updated_at;
      policy=calendarPolicy(selected.definition);
    }
    const projection=args.kind==='count'?['id']:[...new Set(['id',...(display?[display]:[])])];
    const query=compileReadQuery({...view,columns:projection},catalog.properties,args.kind);
    const guards:ReadPlanGuard[]=[];
    const guard=async(kind:ReadPlanGuard['kind'],sql:string,parameters:Value[]=[])=>{
      const expectedRows=await db.all(sql,parameters);
      guards.push({kind,sql,parameters,expectedRows});
    };
    await guard('schema',"SELECT type,name,tbl_name,sql FROM main.sqlite_master WHERE substr(name,1,7) != 'sqlite_' ORDER BY type COLLATE BINARY,name COLLATE BINARY");
    await guard('catalog','SELECT * FROM main.catalog_tables WHERE id=? COLLATE BINARY',[args.table]);
    await guard('catalog','SELECT * FROM main.catalog_properties WHERE tbl=? COLLATE BINARY ORDER BY id COLLATE BINARY',[args.table]);
    if (args.viewID!==undefined) await guard('view','SELECT id,tbl,definition,updated_at,deleted_at FROM main.views WHERE id=? COLLATE BINARY',[args.viewID]);
    const tables=new Set(guards[0]!.expectedRows.filter(r=>r.type==='table').map(r=>r.name));
    if (tables.has('_core_state')) await guard('identity',"SELECT key,value FROM main._core_state WHERE key='hub'");
    if (tables.has('_sync_state')) await guard('identity',"SELECT key,value FROM main._sync_state WHERE key='hub_url'");
    const plan:ReadPlan={version:1,workspaceID:args.workspaceID,replicaID:args.replicaID,table:args.table,
      viewID:args.viewID??null,viewUpdatedAt,kind:args.kind,sql:query.sql,parameters:query.parameters,
      columns:args.kind==='count'?['count']:projection,displayColumn:args.kind==='list'?display:null,
      maximumRows:args.kind==='count'?10001:20,calendarPolicy:policy,guards};
    // Bound metadata as well as returned records. A large catalog is unavailable,
    // never silently truncated into a weaker guard.
    if (JSON.stringify(plan).length>262144) throw new Error('Read-plan metadata exceeds the supported budget');
    return plan;
  });
}
