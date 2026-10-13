import type { Catalog, RunRowActionArgs, WriteArgs } from './contract.generated.ts';
import type { SqlDriver } from './driver.ts';
import { qident, validEditTimestamp, validateRow, type Row } from './validate.ts';
import { isReadOnlyTable } from './write.ts';
import { loadSavedView } from './saved-views.ts';

const managed=new Set(['id','created_at','updated_at','hub_at','deleted_at']);
function object(value: unknown, keys?: string[]): asserts value is Row {
  if (!value || typeof value!=='object' || ![Object.prototype,null].includes(Object.getPrototypeOf(value))
    || (keys && Object.keys(value).some(k=>!keys.includes(k)))) throw new Error('Invalid row action definition.');
}

/** Validate saved literal edits and presentation references. Dynamic options,
 * references, invariants and coverage are checked by the ordinary writer. */
export function validateRowActions(value: Row, catalog: Catalog, table: string): string[] {
  const props=catalog.properties.filter(p=>p.tbl===table),byColumn=new Map(props.map(p=>[p.col,p]));
  const actions=value.actions===undefined?[]:value.actions,layout=value.layout;
  if (!Array.isArray(actions) || actions.length>32) throw new Error('Invalid saved actions.');
  if (actions.length && isReadOnlyTable(table,catalog.tables.find(t=>t.id===table))) throw new Error('Action target is read-only.');
  const ids=new Set<string>(),referenced:string[]=[];
  for(const action of actions) {
    object(action,['id','label','values']);object(action.values);
    if (typeof action.id!=='string' || !/^[A-Za-z0-9_-]{1,64}$/.test(action.id) || ids.has(action.id)
      || typeof action.label!=='string' || !action.label.trim() || action.label.length>100
      || !Object.keys(action.values).length) throw new Error('Invalid saved action identity or values.');
    ids.add(action.id);
    const targets=Object.keys(action.values).map(col=>{
      const prop=byColumn.get(col);
      if (managed.has(col) || !prop || prop.derived_by || prop.immutable || prop.deprecated) throw new Error('Action target column is unavailable or read-only.');
      referenced.push(col);
      return prop.options_sql?{...prop,options:[]}:prop;
    });
    if (validateRow(targets,null,action.values).length) throw new Error('Invalid saved action values.');
  }
  if (layout!==undefined) {
    if (!Array.isArray(layout) || !layout.length || layout.length>128) throw new Error('Invalid saved layout.');
    const seen=new Set<string>();
    const columns=new Set([...byColumn.keys(),'id','created_at','updated_at','deleted_at']);
    for(const item of layout) {
      object(item,['kind','id','width']);
      if (item.width!==undefined && (item.kind!=='action' || typeof item.width!=='number' || !Number.isFinite(item.width) || item.width<=0)) throw new Error('Invalid saved action column width.');
      if (typeof item.id!=='string' || !['column','action'].includes(String(item.kind))
        || seen.has(`${item.kind}:${item.id}`) || !(item.kind==='action'?ids:columns).has(item.id)) throw new Error('Unknown or repeated saved layout reference.');
      seen.add(`${item.kind}:${item.id}`);
      if(item.kind==='column')referenced.push(item.id);
    }
  }
  return referenced;
}

/** Called within the mutation session's writer transaction. Both the saved
 * definition and the complete row are resolved under the same reservation. */
export async function resolveRowAction(db: SqlDriver, args: RunRowActionArgs): Promise<WriteArgs> {
  object(args,['viewId','actionId','rowId','expectedUpdatedAt','expectedViewUpdatedAt']);
  if (![args.viewId,args.actionId,args.rowId].every(v=>typeof v==='string' && v.trim())
    || !validEditTimestamp(args.expectedUpdatedAt) || !validEditTimestamp(args.expectedViewUpdatedAt))
    throw new Error('Row actions require a target and selected row and saved-view revisions.');
  const view=await loadSavedView(db,args.viewId);
  if (view.unavailable || !view.definition) throw new Error(view.unavailable ?? 'Saved view is unavailable.');
  if (view.updated_at!==args.expectedViewUpdatedAt) throw new Error('Saved view changed. Reload it before running this action.');
  const action=view.definition.actions?.find(a=>a.id===args.actionId);
  if (!action) throw new Error('Saved action is unavailable.');
  const row=(await db.all(`SELECT * FROM main.${qident(view.tbl)} WHERE id=? AND deleted_at IS NULL`,[args.rowId]))[0];
  if (!row) throw new Error('Action target is unavailable.');
  return {table:view.tbl,patch:{...action.values,id:args.rowId},expectedUpdatedAt:args.expectedUpdatedAt};
}
