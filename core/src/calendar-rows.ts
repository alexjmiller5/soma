import type { CalendarRowsArgs, CalendarRowsResult } from './contract.generated.ts';
import { validEditTimestamp, validLocalTime } from './validate.ts';
import { validateCalendarContext } from './view.ts';

// A date-only day, a floating local time (YYYY-MM-DDTHH:MM) or an exact instant.
type DateValue = { day: string; local?: never; instant?: never } | { local: string; day?: never; instant?: never } | { instant: number; day?: never; local?: never };
function dateValue(value: unknown): DateValue | null {
  if (typeof value !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) && validEditTimestamp(value+'T00:00:00.000Z')) return {day:value};
  if (validLocalTime(value)) return {local:value};
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !validEditTimestamp(value.slice(0,10)+'T00:00:00.000Z')) return null;
  const instant=Date.parse(value);
  return Number.isFinite(instant) ? {instant} : null;
}
// Wall-clock values (days and local times) compare as text, instants as numbers.
const wall = (v: DateValue) => v.day ?? v.local;
function reversed(start: DateValue, end: DateValue): boolean {
  if (start.instant !== undefined || end.instant !== undefined)
    return start.instant !== undefined && end.instant !== undefined && end.instant < start.instant;
  return wall(end)! < wall(start)!;
}

/** Rendering only. Hosts supply timezone-aware bounds and keep ordinary query
 * pagination visible. This never rewrites source dates or compiles SQL. */
export function calendarRows(args: CalendarRowsArgs): CalendarRowsResult {
  if (!args || typeof args.dateColumn !== 'string' || !args.dateColumn
    || (args.endDateColumn !== undefined && (typeof args.endDateColumn !== 'string' || !args.endDateColumn))
    || !Array.isArray(args.rows) || args.rows.length>10000 || !Array.isArray(args.days) || args.days.length>62)
    throw new Error('Invalid calendar rows');
  const dates=new Set<string>();
  let previousEnd=-Infinity;
  const bounds=args.days.map(day=>{
    if (!validateCalendarContext(day) || dates.has(day.today) || Date.parse(day.start)<previousEnd)
      throw new Error('Invalid calendar days');
    dates.add(day.today);previousEnd=Date.parse(day.end);
    return {date:day.today,start:Date.parse(day.start),end:previousEnd,localStart:day.localStart,localEnd:day.localEnd};
  });
  // Local times need the days' local bounds; without them they stay undated.
  const local=bounds.every(d=>d.localStart!==undefined);
  const result:CalendarRowsResult={days:bounds.map(d=>({date:d.date,rowIds:[]})),undated:[]};
  const ids=new Set<string>();
  for (const row of args.rows) {
    if (!row || typeof row.id!=='string' || !row.id || ids.has(row.id)) throw new Error('Invalid calendar row identity');
    ids.add(row.id);
    const start=dateValue(row[args.dateColumn]);
    const rawEnd=args.endDateColumn ? row[args.endDateColumn] : null;
    const hasEnd=rawEnd!==undefined && rawEnd!==null && rawEnd!=='';
    const end=hasEnd ? dateValue(rawEnd) : start;
    if (!start || !end || reversed(start,end) || (!local && (start.local!==undefined || end.local!==undefined))) {
      result.undated.push(row.id);continue;
    }
    const point=!hasEnd || (start.instant!==undefined && start.instant===end.instant) || (start.local!==undefined && start.local===end.local);
    // A local time belongs to the day whose local bounds hold it: date of (time - day start).
    const within=(v:DateValue,day:typeof bounds[number])=>v.day!==undefined ? v.day===day.date
      : v.local!==undefined ? v.local>=day.localStart! && v.local<day.localEnd! : v.instant>=day.start && v.instant<day.end;
    const startsBy=(v:DateValue,day:typeof bounds[number])=>v.day!==undefined ? v.day<=day.date
      : v.local!==undefined ? v.local<day.localEnd! : v.instant<day.end;
    const endsAfter=(v:DateValue,day:typeof bounds[number])=>v.day!==undefined ? v.day>=day.date
      : v.local!==undefined ? v.local>day.localStart! : v.instant>day.start;
    bounds.forEach((day,index)=>{
      if (point ? within(start,day) : startsBy(start,day) && endsAfter(end,day)) result.days[index].rowIds.push(row.id as string);
    });
  }
  return result;
}
