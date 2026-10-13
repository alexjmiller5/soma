// Floating local times (YYYY-MM-DDTHH:MM) and the relative `now` operand.
import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { calendarRows } from '../src/calendar-rows.ts';
import { compileView, validateCalendarContext, validateView, type View } from '../src/view.ts';

// New York, a 03:00 day start, read at 12:30 local on Oct 13.
const calendar = {
  today: '2032-10-13', start: '2032-10-13T07:00:00.000Z', end: '2032-10-14T07:00:00.000Z',
  now: '2032-10-13T16:30:00.000Z', localNow: '2032-10-13T12:30',
  localStart: '2032-10-13T03:00', localEnd: '2032-10-14T03:00',
};
const dbs: Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
function fixture(rows: [string, string | null][]) {
  const db = new Database(':memory:'); dbs.push(db);
  db.exec('CREATE TABLE items(id TEXT PRIMARY KEY,due TEXT,deleted_at TEXT)');
  for (const [id, due] of rows) db.query('INSERT INTO items VALUES (?,?,NULL)').run(id, due);
  return (view: Partial<View>) => {
    const q = compileView({ table: 'items', ...view } as View, [{ col: 'due', type: 'date_or_datetime' }]);
    return (db.query(q.sql).all(...q.params) as { id: string }[]).map(r => r.id);
  };
}

test('relative now: date-only counts all day, local times compare with localNow, instants with now', () => {
  const ids = fixture([
    ['yesterday', '2032-10-12'], ['today', '2032-10-13'], ['tomorrow', '2032-10-14'],
    ['noon', '2032-10-13T12:00'], ['at-now', '2032-10-13T12:30'], ['evening', '2032-10-13T18:00'],
    ['after-midnight', '2032-10-14T01:00'], ['early', '2032-10-13T01:00'],
    ['instant-past', '2032-10-13T15:00:00.000Z'], ['instant-now', calendar.now], ['instant-later', '2032-10-13T17:00:00.000Z'],
    ['naive-seconds', '2032-10-13T12:00:00'], ['impossible', '2032-02-30T12:00'], ['empty', null],
  ]);
  const now = (op: string) => ids({ calendar, filters: [{ column: 'due', op, relative: 'now' }] as View['filters'] });
  expect(now('lte')).toEqual(['at-now', 'early', 'instant-now', 'instant-past', 'noon', 'today', 'yesterday']);
  expect(now('lt')).toEqual(['early', 'instant-past', 'noon', 'yesterday']);
  expect(now('gt')).toEqual(['after-midnight', 'evening', 'instant-later', 'tomorrow']);
  expect(now('gte')).toEqual(['after-midnight', 'at-now', 'evening', 'instant-later', 'instant-now', 'today', 'tomorrow']);
});

test('relative today places a local time on its policy day: date of (time - day start)', () => {
  const ids = fixture([
    ['before-start', '2032-10-13T02:59'], ['start', '2032-10-13T03:00'],
    ['last', '2032-10-14T02:59'], ['next', '2032-10-14T03:00'], ['date', '2032-10-13'],
  ]);
  const today = (op: string, context: object = calendar) =>
    ids({ calendar: context as View['calendar'], filters: [{ column: 'due', op, relative: 'today' }] as View['filters'] });
  expect(today('eq')).toEqual(['date', 'last', 'start']);
  expect(today('ne')).toEqual(['before-start', 'next']);
  expect(today('lt')).toEqual(['before-start']);
  expect(today('lte')).toEqual(['before-start', 'date', 'last', 'start']);
  expect(today('gt')).toEqual(['next']);
  expect(today('gte')).toEqual(['date', 'last', 'next', 'start']);
  // A context without local bounds never guesses a local time's day.
  const { localStart: _s, localEnd: _e, ...legacy } = calendar;
  expect(today('lte', legacy)).toEqual(['date']);
});

test('relative now takes only ordered operators and requires the host clock to execute', () => {
  const ids = fixture([['a', '2032-10-13T12:00']]);
  for (const op of ['eq', 'ne', 'empty']) expect(() => ids({ calendar, filters: [{ column: 'due', op, relative: 'now' }] as View['filters'] })).toThrow('Invalid relative date filter');
  const { now: _n, localNow: _l, ...clockless } = calendar;
  expect(() => ids({ calendar: clockless, filters: [{ column: 'due', op: 'lte', relative: 'now' }] })).toThrow('Relative now query requires the host clock');
  expect(() => ids({ filters: [{ column: 'due', op: 'lte', relative: 'now' }] })).toThrow('Relative query requires a calendar context');
  // Saved definitions still validate without a clock.
  expect(() => validateView({ table: 'items', filters: [{ column: 'due', op: 'lte', relative: 'now' }] }, [{ col: 'due', type: 'date_or_datetime' }])).not.toThrow();
});

test.each([
  { now: '2032-10-13T16:30:00Z' }, { now: '2032-10-13T06:59:59.999Z' }, { now: calendar.end },
  { localNow: '2032-10-13T24:00' }, { localNow: '2032-10-13T12:30:00' }, { localNow: '2032-02-30T12:30' },
  { localStart: '2032-10-13 03:00' }, { localEnd: calendar.localStart }, { localEnd: '2032-10-13T02:00' },
])('a malformed clock or local bound rejects the calendar %#', patch => {
  expect(() => validateCalendarContext({ ...calendar, ...patch })).toThrow('Invalid calendar context');
});

test('the full calendar validates, and its optional slots stay optional', () => {
  expect(validateCalendarContext(calendar)).toEqual(calendar);
  expect(validateCalendarContext({ today: calendar.today, start: calendar.start, end: calendar.end })).toBeDefined();
});

test('sorting by due puts a date-only value before timed values on the same day', () => {
  const ids = fixture([
    ['next-day', '2032-10-14'], ['noon', '2032-10-13T12:00'], ['anytime', '2032-10-13'], ['morning', '2032-10-13T09:00'], ['before', '2032-10-12T23:00'],
  ]);
  expect(ids({ sort: [{ column: 'due', direction: 'asc' }] })).toEqual(['before', 'anytime', 'morning', 'noon', 'next-day']);
  expect(ids({ sort: [{ column: 'due', direction: 'desc' }] })).toEqual(['next-day', 'noon', 'morning', 'anytime', 'before']);
});

test('calendar layout puts a local time on the day whose local bounds hold it', () => {
  const days = [
    { today: '2032-10-12', start: '2032-10-12T07:00:00.000Z', end: '2032-10-13T07:00:00.000Z', localStart: '2032-10-12T03:00', localEnd: '2032-10-13T03:00' },
    { today: '2032-10-13', start: '2032-10-13T07:00:00.000Z', end: '2032-10-14T07:00:00.000Z', localStart: '2032-10-13T03:00', localEnd: '2032-10-14T03:00' },
  ];
  const rows = [
    { id: 'late', start: '2032-10-13T01:00' }, { id: 'noon', start: '2032-10-13T12:00' },
    { id: 'span', start: '2032-10-12T20:00', end: '2032-10-13T10:00' }, { id: 'mixed', start: '2032-10-12', end: '2032-10-13T10:00' },
    { id: 'reverse', start: '2032-10-13T10:00', end: '2032-10-13T09:00' }, { id: 'bad', start: '2032-10-13T25:00' },
  ];
  expect(calendarRows({ rows, dateColumn: 'start', endDateColumn: 'end', days })).toEqual({
    days: [{ date: '2032-10-12', rowIds: ['late', 'span', 'mixed'] }, { date: '2032-10-13', rowIds: ['noon', 'span', 'mixed'] }],
    undated: ['reverse', 'bad'],
  });
  // Without local bounds a local time stays visible as undated rather than guessed.
  const legacy = days.map(({ localStart: _s, localEnd: _e, ...day }) => day);
  expect(calendarRows({ rows: [rows[1]!], dateColumn: 'start', days: legacy }).undated).toEqual(['noon']);
});
