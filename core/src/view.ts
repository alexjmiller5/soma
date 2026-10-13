import { qident, validEditTimestamp, validLocalTime, type Property, type Row } from "./validate.ts";
import { compileSearch } from './search.ts';

import type { View, Filter, CalendarContext, CalendarSlot, ReadPlanKind, ReadPlanParameter } from './contract.generated.ts';
export type { Filter, View } from './contract.generated.ts';

const SYSTEM_COLUMNS = new Set(["id", "created_at", "updated_at", "deleted_at", "hub_at"]);

function checkObject(value: unknown, keys: string[], label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error(`Invalid ${label}`);
  }
}

/** Compile a catalog-scoped view. Equality is null-safe; contains is literal
 * (ASCII case-insensitive text, exact JSON array membership). Empty includes
 * NULL, empty strings and, for multi-value properties, empty JSON arrays.
 * Nonempty search requires the prepared local FTS index. Prefer readRows(),
 * which drains its queue and queries in the same transaction.
 */
export function compileView(view: View, properties: Property[]): { sql: string; params: (string | number | null)[] } {
  const result = compile(view, properties, true);
  return {sql: result.sql, params: result.parameters.map(p => {
    if (p.kind !== 'literal') throw new Error('Unbound calendar parameter');
    return p.value;
  })};
}

type IncomingReference = {table:string; rowId:string; column:string; type:'ref'|'multi_ref'};
/** The same view compiler with a catalog-checked incoming relation predicate. */
export function compileReferenceView(view:View,properties:Property[],reference:IncomingReference) {
  const result=compile(view,properties,true,101,reference);
  return {sql:result.sql,params:result.parameters.map(p=>{
    if(p.kind!=='literal')throw Error('Unbound calendar parameter');
    return p.value;
  })};
}

/** Same compiler, tagged at binding sites. The caller supplies explicit title/id
 * projection and validates the saved definition before count drops its ordering. */
export function compileReadQuery(view: View, properties: Property[], kind: ReadPlanKind): {sql:string; parameters:ReadPlanParameter[]} {
  if (!['list','count'].includes(kind)) throw new Error('Invalid read-plan kind');
  if (view.search) throw new Error('Read-only plans do not support nonempty FTS search');
  if (!view.columns?.length) throw new Error('Read plans require explicit columns');
  const count = kind === 'count';
  const query = compile({...view, ...(count ? {sort:[],columns:['id']} : {}),limit:count?10001:20,offset:0},properties,'plan',count?10001:20);
  return count ? {...query,sql:`SELECT count(*) AS count FROM (${query.sql}) AS _read_count`} : query;
}

/** Saved definitions validate without a host clock; executing a relative query requires one. */
export function validateView(view: View, properties: Property[]): void { compile(view, properties, false); }

export function validateCalendarContext(value: CalendarContext | undefined): CalendarContext | undefined {
  if (value === undefined) return undefined;
  checkObject(value, ['today','start','end','now','localNow','localStart','localEnd'], 'calendar');
  const start=Date.parse(value.start),end=Date.parse(value.end);
  if (typeof value.today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.today)
    || !validEditTimestamp(value.today+'T00:00:00.000Z') || !validEditTimestamp(value.start) || !validEditTimestamp(value.end)
    || end<=start || end-start>27*3600000
    // The clock reading lies inside the interval; local slots are floating local times.
    || (value.now!==undefined && (!validEditTimestamp(value.now) || Date.parse(value.now)<start || Date.parse(value.now)>=end))
    || [value.localNow,value.localStart,value.localEnd].some(v=>v!==undefined && !validLocalTime(v))
    || (value.localStart===undefined)!==(value.localEnd===undefined)
    || (value.localStart!==undefined && value.localEnd!<=value.localStart)) throw new Error('Invalid calendar context');
  return value;
}

function compile(view: View, properties: Property[], requireCalendar: boolean | 'plan', maximum=200, reference?:IncomingReference): { sql: string; parameters: ReadPlanParameter[] } {
  checkObject(view, ["table", "columns", "filters", "sort", "limit", "offset", "trash", "search", "groups", "calendar"], "view");
  if (typeof view.table !== "string") throw new Error("Invalid table");
  const table = qident(view.table);
  const props = new Map(properties.filter((p) => p.tbl === undefined || p.tbl === view.table).map((p) => [p.col, p]));
  // Qualify every column: json_each has its own id/value columns.
  const row = qident("_view_row");
  const column = (name: unknown): string => {
    if (typeof name !== "string") throw new Error("Invalid column");
    const quoted = qident(name);
    if (!SYSTEM_COLUMNS.has(name) && !props.has(name)) throw new Error(`Unknown column: ${name}`);
    return `${row}.${quoted}`;
  };
  for (const key of ["columns", "filters", "sort", "groups"] as const) {
    if (view[key] !== undefined && !Array.isArray(view[key])) throw new Error(`Invalid ${key}`);
  }
  if (view.columns?.length === 0) throw new Error("columns must not be empty");
  if (view.trash !== undefined && typeof view.trash !== "boolean") throw new Error("Invalid trash flag");
  if (view.search !== undefined && typeof view.search !== "string") throw new Error("Invalid search");
  const limit = view.limit === undefined ? 50 : view.limit;
  const offset = view.offset === undefined ? 0 : view.offset;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("limit must be a positive safe integer");
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a nonnegative safe integer");

  const selected: string[] = [];
  for (const name of view.columns ?? []) selected.push(column(name));
  const parameters: ReadPlanParameter[] = [];
  const bind = (value: unknown): string => {
    if (value !== null && typeof value !== "string" && typeof value !== "boolean"
      && !(typeof value === "number" && Number.isFinite(value))) throw new Error("Invalid filter value");
    parameters.push({kind:'literal',value:typeof value === "boolean" ? Number(value) : value as string | number | null});
    return "?";
  };
  const calendar=validateCalendarContext(view.calendar);
  const bindCalendar = (slot: CalendarSlot): string => {
    if (requireCalendar !== 'plan') return bind(calendar![slot]);
    parameters.push({kind:'calendar',slot});
    return '?';
  };
  if ((view.groups?.length ?? 0)>16 || (view.sort?.length ?? 0)>16) throw new Error('View exceeds group or sort limit');
  let filterCount=0;
  const where = [`${column("deleted_at")} IS ${view.trash ? "NOT " : ""}NULL`];
  if(reference){
    const target=qident('_reference_target'),value=qident('_reference_value'),col=column(reference.column),id=`${target}."id"`;
    const array=`CASE WHEN json_valid(${col}) THEN CASE WHEN json_type(${col})='array' THEN ${col} END END`;
    const matches=reference.type==='ref'?`${id} IS +${col}`:`EXISTS (SELECT 1 FROM json_each(${array}) AS ${value} WHERE ${id} IS +${value}."value")`;
    where.push(`EXISTS (SELECT 1 FROM ${qident(reference.table)} AS ${target} WHERE ${id} IS ${bind(reference.rowId)} AND ${matches})`);
  }
  const filterSQL = (filter: Filter): string => {
    if (++filterCount>128) throw new Error('View exceeds filter limit');
    checkObject(filter, ["column", "op", "value", "relative"], "filter");
    const conditions: string[]=[];
    const col = column(filter.column);
    const type = SYSTEM_COLUMNS.has(filter.column) && filter.column!=="id" ? "datetime" : props.get(filter.column)?.type;
    const multi = type === "multi_select" || type === "multi_ref";
    // CASE guards both JSON functions, including against legacy malformed cells.
    const array = `CASE WHEN json_valid(${col}) THEN CASE WHEN json_type(${col}) = 'array' THEN ${col} END END`;
    if (filter.relative !== undefined) {
      const now=filter.relative==='now';
      if ((filter.relative!=='today' && !now) || Object.hasOwn(filter,'value') || !['date','datetime','date_or_datetime'].includes(type ?? '')
        || !(now ? ['gt','gte','lt','lte'] : ['eq','ne','gt','gte','lt','lte']).includes(filter.op)) throw new Error('Invalid relative date filter');
      if (!calendar && requireCalendar !== 'plan') {
        if (requireCalendar) throw new Error('Relative query requires a calendar context');
        return '0';
      }
      if (now && calendar && (calendar.now===undefined || calendar.localNow===undefined)) throw new Error('Relative now query requires the host clock');
      const op={eq:'=',ne:'!=',gt:'>',gte:'>=',lt:'<',lte:'<='}[filter.op as 'eq'|'ne'|'gt'|'gte'|'lt'|'lte'];
      const dateOnly=`(length(${col})=10 AND ${col} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(${col},'+0 days')=${col})`;
      // A floating local time (YYYY-MM-DDTHH:MM) compares as text with local slots.
      // Only functions read-only plan hosts allow (length, glob, substr, date).
      const local=`(length(${col})=16 AND ${col} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-2][0-9]:[0-5][0-9]' AND substr(${col},12,2)<'24' AND date(substr(${col},1,10),'+0 days')=substr(${col},1,10))`;
      const dateComparison=`${col} ${op} ${bindCalendar('today')}`;
      const instant=`julianday(${col})`;
      // The same interval test over instants or, with local bounds, floating local times.
      const interval=(value:string,bound:(slot:'start'|'end')=>string)=>{
        switch(filter.op) {
          case 'eq':return `${value} >= ${bound('start')} AND ${value} < ${bound('end')}`;
          case 'ne':return `${value} < ${bound('start')} OR ${value} >= ${bound('end')}`;
          case 'gt':return `${value} >= ${bound('end')}`;
          case 'gte':return `${value} >= ${bound('start')}`;
          case 'lt':return `${value} < ${bound('start')}`;
          default:return `${value} < ${bound('end')}`;
        }
      };
      // Without local bounds (an older host) a local time matches no relative today.
      const floating=now ? `${col} ${op} ${bindCalendar('localNow')}`
        : requireCalendar==='plan' || calendar?.localStart!==undefined ? interval(col,slot=>bindCalendar(slot==='start'?'localStart':'localEnd')) : '0';
      // Bind in SQL text order: today, the local slots, then the instant slots.
      const timed=now ? `${instant} ${op} julianday(${bindCalendar('now')})` : interval(instant,slot=>`julianday(${bindCalendar(slot)})`);
      const zoned=`(${col} GLOB '????-??-??T??:??*' AND (substr(${col},-1)='Z' OR (substr(${col},-6,1) IN ('+','-') AND substr(${col},-3,1)=':')))`;
      return `(CASE WHEN ${dateOnly} THEN ${dateComparison} WHEN ${local} THEN (${floating}) WHEN ${zoned} THEN (${timed}) ELSE 0 END)`;
    }
    switch (filter.op) {
      case "empty":
      case "not_empty": {
        if (filter.value !== undefined) throw new Error(`${filter.op} takes no value`);
        const empty = `(${col} IS NULL OR ${col} = ${bind("")}${multi ? ` OR json_array_length(${array}) IS ${bind(0)}` : ""})`;
        conditions.push(filter.op === "empty" ? empty : `NOT ${empty}`);
        break;
      }
      case "contains":
        if (multi) {
          const item = qident("_view_item");
          conditions.push(`EXISTS (SELECT 1 FROM json_each(${array}) AS ${item} WHERE ${item}.${qident("value")} IS ${bind(filter.value)})`);
        } else {
          if (typeof filter.value !== "string") throw new Error("Text contains requires a string");
          conditions.push(`instr(lower(${col}), lower(${bind(filter.value)})) > 0`);
        }
        break;
      case "eq":
      case "ne":
        conditions.push(`${col} IS ${filter.op === "ne" ? "NOT " : ""}${bind(filter.value)}`);
        break;
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        if (filter.value === null) throw new Error("Ordered comparisons require a non-null value");
        const op = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[filter.op];
        conditions.push(`${col} ${op} ${bind(filter.value)}`);
        break;
      }
      default:
        throw new Error("Invalid filter operator");
    }
    return conditions[0]!;
  };
  for (const filter of view.filters ?? []) where.push(filterSQL(filter));
  for (const group of view.groups ?? []) {
    checkObject(group,['match','filters'],'filter group');
    if (!['all','any'].includes(group.match) || !Array.isArray(group.filters) || !group.filters.length || group.filters.length>64) throw new Error('Invalid filter group');
    where.push(`(${group.filters.map(filterSQL).join(group.match==='all'?' AND ':' OR ')})`);
  }

  if (view.search) {
    const query = compileSearch(view.search);
    where.push(query ? `${column('id')} IN (SELECT d.row_id FROM _core_search_fts JOIN _core_search_docs AS d ON d.docid=_core_search_fts.rowid WHERE _core_search_fts MATCH ${bind(query)} AND d.tbl=${bind(view.table)})` : '0');
  }
  const order: string[] = [];
  let sortedById = false;
  for (const sort of view.sort ?? []) {
    checkObject(sort, ["column", "direction", "mode"], "sort");
    if (sort.direction !== "asc" && sort.direction !== "desc") throw new Error("Invalid sort direction");
    if (sort.mode!==undefined && !['value','options'].includes(sort.mode)) throw new Error('Invalid sort mode');
    const col=column(sort.column);
    if (sort.mode==='options') {
      const prop=props.get(sort.column);
      if (!prop || !['select','multi_select'].includes(prop.type ?? '')) throw new Error('Option sort requires a select property');
      const options=(prop.options ?? []).map(o=>o.v);
      // Multi-select order follows the first stored selection. Later selections
      // do not break ties; the remaining sort clauses and stable id do.
      const key=prop.type==='multi_select'
        ? `CASE WHEN json_valid(${col}) THEN CASE WHEN json_type(${col})='array' THEN json_extract(${col},'$[0]') END END` : col;
      const rank=()=>`(SELECT opt.key FROM json_each(${bind(JSON.stringify(options))}) AS opt WHERE opt.value IS (${key}) LIMIT 1)`;
      order.push(`CASE WHEN (${key}) IS NULL OR (${key})='' THEN 2 WHEN ${rank()} IS NULL THEN 1 ELSE 0 END ASC`);
      order.push(`${rank()} ${sort.direction.toUpperCase()}`,`(${key}) ASC`);
    } else order.push(`${col} ${sort.direction.toUpperCase()}`);
    if (sort.column === "id") sortedById = true;
  }
  if (!sortedById) order.push(`${column("id")} ASC`);
  const sql = `SELECT ${selected.length ? selected.join(", ") : `${row}.*`} FROM ${table} AS ${row} WHERE ${where.join(" AND ")} ORDER BY ${order.join(", ")} LIMIT ${bind(Math.min(limit, maximum))} OFFSET ${bind(offset)}`;
  return { sql, parameters };
}

/** Use only the configured scalar label, then id; never infer a schema. */
export function displayName(row: Row, displayColumn?: string | null): string {
  const label = (value: unknown): string => {
    if (typeof value === "string") return value.trim();
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return String(value);
    return "";
  };
  return (displayColumn ? label(row[displayColumn]) : "") || label(row.id) || "Untitled";
}
