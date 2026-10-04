// Tests for js/views/page-geometry.js (run with TZ=Asia/Tokyo).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import {
  PAGE_SPECS,
  VIEWS,
  columnRect,
  minutesToY,
  monthCellAt,
  monthCellRect,
  navigate,
  pageIdFor,
  pointToSlot,
  rangeFor,
  rectToEventRange,
  snapEventRect,
  xToColumn,
  yearCellAt,
  yearCellRect,
  yToMinutes,
} from '../js/views/page-geometry.js';
import { daysBetween, minutesOfDay, toYMD } from '../js/util/date.js';

const d = (y, m, day, h = 0, mi = 0) => new Date(y, m - 1, day, h, mi);
const COL_W = (1400 - 64) / 7;
const weekColCenter = (i) => 64 + (i + 0.5) * COL_W;
const rect = (minX, minY, maxX, maxY) => ({ minX, minY, maxX, maxY });

/** Event range as plain strings for readable assertions. */
const fmt = (r) => r && {
  start: `${toYMD(r.start)} ${String(r.start.getHours()).padStart(2, '0')}:${String(r.start.getMinutes()).padStart(2, '0')}`,
  end: `${toYMD(r.end)} ${String(r.end.getHours()).padStart(2, '0')}:${String(r.end.getMinutes()).padStart(2, '0')}`,
  allDay: r.allDay,
};

// 2026-10-04 is a Sunday.
const DAY = rangeFor('day', d(2026, 10, 4, 15));
const WEEK = rangeFor('week', d(2026, 10, 7), 0); // 10/4 – 10/10
const MONTH = rangeFor('month', d(2026, 10, 20), 0); // grid 9/27 – 11/7

test('VIEWS and PAGE_SPECS match the spec and are frozen', () => {
  assert.deepEqual(VIEWS, ['day', 'week', 'month', 'year']);
  assert.deepEqual(PAGE_SPECS.day, { W: 1000, H: 2400, gutter: 72, hourH: 100, timelineRight: 660, fit: 'width' });
  assert.deepEqual(PAGE_SPECS.week, { W: 1400, H: 1920, gutter: 64, hourH: 80, cols: 7, fit: 'width' });
  assert.deepEqual(PAGE_SPECS.month, { W: 1400, H: 1750, gridH: 1050, memoTop: 1050, cols: 7, rows: 6, fit: 'grid' });
  assert.deepEqual(PAGE_SPECS.year, { W: 1400, H: 1860, gutter: 56, cols: 12, rows: 31, rowH: 60, fit: 'width' });
  assert.ok(Object.isFrozen(PAGE_SPECS) && Object.isFrozen(PAGE_SPECS.week));
  assert.ok(Object.isFrozen(PAGE_SPECS.month) && Object.isFrozen(PAGE_SPECS.year));
  // The timelines span exactly 24 hours.
  assert.equal(PAGE_SPECS.day.H, 24 * PAGE_SPECS.day.hourH);
  assert.equal(PAGE_SPECS.week.H, 24 * PAGE_SPECS.week.hourH);
  // Month: the 200×175 cells fill the grid, the memo area the rest of the page.
  assert.equal(PAGE_SPECS.month.gridH, PAGE_SPECS.month.rows * 175);
  assert.ok(PAGE_SPECS.month.H > PAGE_SPECS.month.gridH);
  // Year: 12 columns of 112 after the gutter, 31 rows of rowH.
  const Y = PAGE_SPECS.year;
  assert.equal((Y.W - Y.gutter) / Y.cols, 112);
  assert.equal(Y.H, Y.rows * Y.rowH);
});

test('pageIdFor', () => {
  assert.equal(pageIdFor('day', d(2026, 10, 4, 23, 59)), 'd-2026-10-04');
  assert.equal(pageIdFor('week', d(2026, 10, 3), 0), 'w-2026-09-27');
  assert.equal(pageIdFor('week', d(2026, 10, 4), 0), 'w-2026-10-04');
  assert.equal(pageIdFor('week', d(2026, 10, 4), 1), 'w-2026-09-28');
  assert.equal(pageIdFor('week', d(2026, 10, 5), 1), 'w-2026-10-05');
  assert.equal(pageIdFor('week', d(2027, 1, 1), 0), 'w-2026-12-27');
  assert.equal(pageIdFor('month', d(2026, 10, 31, 23)), 'm-2026-10');
  assert.equal(pageIdFor('month', d(2027, 1, 1)), 'm-2027-01');
  assert.equal(pageIdFor('month', d(2026, 10, 31), 0), 'm-2026-10');
  // Monday start shifts every date of the month grid, so it is a different page.
  assert.equal(pageIdFor('month', d(2026, 10, 31), 1), 'm1-2026-10');
  assert.equal(pageIdFor('month', d(2026, 11, 1), 1), 'm1-2026-11');
  // weekStart is normalized exactly like rangeFor/startOfWeek.
  assert.equal(pageIdFor('month', d(2026, 10, 5), 8), 'm1-2026-10');
  assert.equal(pageIdFor('month', d(2026, 10, 5), '1'), 'm1-2026-10');
  assert.equal(pageIdFor('month', d(2026, 10, 5), 7), 'm-2026-10');
  assert.equal(pageIdFor('month', d(2026, 10, 5), undefined), 'm-2026-10');
  // year: one page per year, whatever the week start
  assert.equal(pageIdFor('year', d(2026, 10, 4)), 'y-2026');
  assert.equal(pageIdFor('year', d(2026, 1, 1)), 'y-2026');
  assert.equal(pageIdFor('year', d(2026, 12, 31, 23, 59)), 'y-2026');
  assert.equal(pageIdFor('year', d(2027, 1, 1), 1), 'y-2027');
  assert.equal(pageIdFor('year', d(2027, 1, 1), 0), 'y-2027');
  assert.throws(() => pageIdFor('quarter', d(2026, 10, 4)), RangeError);
  assert.throws(() => pageIdFor('day', new Date(NaN)), TypeError);
  assert.throws(() => pageIdFor('day', '2026-10-04'), TypeError);
});

test('pageIdFor month: same id ⇔ same grid (ink can never sit on shifted dates)', () => {
  for (let m = 1; m <= 24; m++) {
    const date = d(2026, m, 15);
    const ids = [0, 1].map((ws) => pageIdFor('month', date, ws));
    const grids = [0, 1].map((ws) => rangeFor('month', date, ws).days.map(toYMD).join());
    assert.notEqual(ids[0], ids[1], `month ${m}`);
    assert.notEqual(grids[0], grids[1], `month ${m}`);
    // Any date of the same month gives the same id and the same grid.
    for (const ws of [0, 1]) {
      assert.equal(pageIdFor('month', d(2026, m, 1), ws), pageIdFor('month', date, ws));
      assert.equal(rangeFor('month', d(2026, m, 1), ws).days.map(toYMD).join(), grids[ws]);
    }
  }
});

test('rangeFor day', () => {
  assert.equal(DAY.start.getTime(), d(2026, 10, 4).getTime());
  assert.equal(DAY.end.getTime(), d(2026, 10, 5).getTime());
  assert.deepEqual(DAY.days.map(toYMD), ['2026-10-04']);
  assert.equal(DAY.monthStart, undefined);
});

test('rangeFor week honors weekStart 0 and 1', () => {
  assert.deepEqual(WEEK.days.map(toYMD),
    ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10']);
  assert.equal(WEEK.start.getTime(), d(2026, 10, 4).getTime());
  assert.equal(WEEK.end.getTime(), d(2026, 10, 11).getTime());

  const mon = rangeFor('week', d(2026, 10, 7), 1);
  assert.deepEqual(mon.days.map(toYMD),
    ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']);
  assert.equal(mon.end.getTime(), d(2026, 10, 12).getTime());

  // Sunday with Monday start belongs to the previous week.
  assert.equal(toYMD(rangeFor('week', d(2026, 10, 4), 1).start), '2026-09-28');
  for (const day of mon.days) assert.equal(day.getHours() + day.getMinutes(), 0);
});

test('rangeFor month: 42 days from monthGridStart plus monthStart', () => {
  assert.equal(MONTH.days.length, 42);
  assert.equal(toYMD(MONTH.start), '2026-09-27');
  assert.equal(toYMD(MONTH.days[41]), '2026-11-07');
  assert.equal(MONTH.end.getTime(), d(2026, 11, 8).getTime());
  assert.equal(MONTH.monthStart.getTime(), d(2026, 10, 1).getTime());

  const mon = rangeFor('month', d(2026, 10, 20), 1);
  assert.equal(toYMD(mon.start), '2026-09-28');
  assert.equal(toYMD(mon.end), '2026-11-09');
  // February 2026 starts on a Sunday: the grid starts on the 1st with Sunday start.
  assert.equal(toYMD(rangeFor('month', d(2026, 2, 10), 0).start), '2026-02-01');
  assert.equal(toYMD(rangeFor('month', d(2026, 2, 10), 1).start), '2026-01-26');
});

test('navigate', () => {
  assert.equal(navigate('day', d(2026, 10, 4, 15), 1).getTime(), d(2026, 10, 5).getTime());
  assert.equal(navigate('day', d(2026, 10, 1), -1).getTime(), d(2026, 9, 30).getTime());
  assert.equal(navigate('day', d(2026, 10, 4, 15), 0).getTime(), d(2026, 10, 4).getTime());
  assert.equal(navigate('week', d(2026, 10, 7, 9), 1).getTime(), d(2026, 10, 14).getTime(), 'same weekday');
  assert.equal(navigate('week', d(2026, 10, 7), -1).getTime(), d(2026, 9, 30).getTime());
  assert.equal(navigate('week', d(2026, 12, 30), 1).getTime(), d(2027, 1, 6).getTime());
  assert.equal(navigate('month', d(2026, 10, 31, 12), 1).getTime(), d(2026, 11, 1).getTime(), '1st of month');
  assert.equal(navigate('month', d(2026, 3, 31), -1).getTime(), d(2026, 2, 1).getTime());
  assert.equal(navigate('month', d(2026, 12, 15), 1).getTime(), d(2027, 1, 1).getTime());
  assert.equal(navigate('month', d(2026, 10, 15), 0).getTime(), d(2026, 10, 1).getTime());
  assert.equal(navigate('month', d(2026, 10, 15), -12).getTime(), d(2025, 10, 1).getTime());
  assert.equal(navigate('day', d(2026, 10, 4), 'x').getTime(), d(2026, 10, 4).getTime(), 'bad delta → 0');
  // year: Jan 1 of the year ± n
  assert.equal(navigate('year', d(2026, 10, 4, 15), 1).getTime(), d(2027, 1, 1).getTime());
  assert.equal(navigate('year', d(2026, 10, 4), -1).getTime(), d(2025, 1, 1).getTime());
  assert.equal(navigate('year', d(2026, 12, 31, 23), 0).getTime(), d(2026, 1, 1).getTime());
  assert.equal(navigate('year', d(2026, 1, 1), 5).getTime(), d(2031, 1, 1).getTime());
  assert.equal(navigate('year', d(2028, 2, 29), -1).getTime(), d(2027, 1, 1).getTime());
  assert.throws(() => navigate('nope', d(2026, 10, 4), 1), RangeError);
});

test('minutesToY / yToMinutes', () => {
  assert.equal(minutesToY('day', 90), 150);
  assert.equal(minutesToY('day', 1440), 2400);
  assert.equal(minutesToY('week', 60), 80);
  assert.equal(minutesToY('week', 1440), 1920);
  assert.equal(yToMinutes('day', 150), 90);
  assert.equal(yToMinutes('week', 80), 60);
  assert.equal(yToMinutes('day', -5), 0, 'clamped at 0');
  assert.equal(yToMinutes('day', 3000), 1440, 'clamped at 1440');
  assert.equal(yToMinutes('week', 1920), 1440);
  for (let m = 0; m <= 1440; m += 5) {
    assert.ok(Math.abs(yToMinutes('week', minutesToY('week', m)) - m) < 1e-9);
    assert.ok(Math.abs(yToMinutes('day', minutesToY('day', m)) - m) < 1e-9);
  }
  assert.throws(() => minutesToY('month', 60), RangeError);
  assert.throws(() => yToMinutes('month', 60), RangeError);
  assert.throws(() => minutesToY('year', 60), RangeError);
  assert.throws(() => yToMinutes('year', 60), RangeError);
});

test('columnRect', () => {
  assert.deepEqual(columnRect('day', 0), { x: 72, w: 588 });
  assert.equal(columnRect('day', 1), null);
  assert.deepEqual(columnRect('week', 0), { x: 64, w: COL_W });
  const last = columnRect('week', 6);
  assert.ok(Math.abs(last.x + last.w - 1400) < 1e-9, 'last column ends at W');
  assert.equal(columnRect('week', 7), null);
  assert.equal(columnRect('week', -1), null);
  assert.equal(columnRect('week', 1.5), null);
  assert.deepEqual(columnRect('month', 3), { x: 600, w: 200 });
  // year: month columns after the day-number gutter
  assert.deepEqual(columnRect('year', 0), { x: 56, w: 112 });
  assert.deepEqual(columnRect('year', 11), { x: 56 + 11 * 112, w: 112 });
  assert.equal(columnRect('year', 12), null);
  assert.equal(columnRect('year', -1), null);
});

test('xToColumn', () => {
  // day: gutter and memo area are -1.
  assert.equal(xToColumn('day', 0), -1);
  assert.equal(xToColumn('day', 71.9), -1);
  assert.equal(xToColumn('day', 72), 0);
  assert.equal(xToColumn('day', 659.9), 0);
  assert.equal(xToColumn('day', 660), -1);
  assert.equal(xToColumn('day', 999), -1);
  // week
  assert.equal(xToColumn('week', 63.9), -1);
  assert.equal(xToColumn('week', 64), 0);
  for (let i = 0; i < 7; i++) {
    const c = columnRect('week', i);
    assert.equal(xToColumn('week', c.x), i, `left edge of col ${i}`);
    assert.equal(xToColumn('week', c.x + c.w / 2), i, `center of col ${i}`);
    assert.equal(xToColumn('week', c.x + c.w - 0.001), i, `right edge of col ${i}`);
  }
  assert.equal(xToColumn('week', 1400), 6, 'page edge belongs to the last column');
  assert.equal(xToColumn('week', 1400.1), -1);
  assert.equal(xToColumn('week', NaN), -1);
  assert.equal(xToColumn('week', undefined), -1);
  // month
  assert.equal(xToColumn('month', 0), 0);
  assert.equal(xToColumn('month', 200), 1);
  assert.equal(xToColumn('month', 1400), 6);
  assert.equal(xToColumn('month', -1), -1);
  // year: -1 in the gutter
  assert.equal(xToColumn('year', 55.9), -1);
  assert.equal(xToColumn('year', 56), 0);
  for (let i = 0; i < 12; i++) {
    const c = columnRect('year', i);
    assert.equal(xToColumn('year', c.x), i);
    assert.equal(xToColumn('year', c.x + c.w - 0.001), i);
  }
  assert.equal(xToColumn('year', 1400), 11);
  assert.equal(xToColumn('year', 1400.1), -1);
});

test('monthCellRect / monthCellAt', () => {
  assert.deepEqual(monthCellRect(0, 0), { x: 0, y: 0, w: 200, h: 175 });
  assert.deepEqual(monthCellRect(2, 3), { x: 600, y: 350, w: 200, h: 175 });
  assert.deepEqual(monthCellRect(5, 6), { x: 1200, y: 875, w: 200, h: 175 });
  assert.equal(monthCellRect(6, 0), null);
  assert.equal(monthCellRect(0, 7), null);
  assert.equal(monthCellRect(-1, 0), null);
  assert.equal(monthCellRect(1.5, 0), null);

  assert.deepEqual(monthCellAt(0, 0), { row: 0, col: 0 });
  assert.deepEqual(monthCellAt(199.9, 174.9), { row: 0, col: 0 });
  assert.deepEqual(monthCellAt(200, 175), { row: 1, col: 1 }, 'cells are half-open');
  assert.deepEqual(monthCellAt(1399.9, 1049.9), { row: 5, col: 6 });
  assert.deepEqual(monthCellAt(1400, 1049.9), { row: 5, col: 6 }, 'the page\'s right edge belongs to the last column');
  assert.equal(monthCellAt(-0.1, 10), null);
  assert.equal(monthCellAt(10, -0.1), null);
  assert.equal(monthCellAt(1400.1, 10), null);
  // The grid ends at gridH: below it is the memo area, which belongs to no cell.
  assert.equal(monthCellAt(10, 1050), null, 'the memo area starts at gridH');
  assert.equal(monthCellAt(10, 1050.1), null);
  assert.equal(monthCellAt(700, 1400), null);
  assert.equal(monthCellAt(700, 1750), null);
  assert.equal(monthCellAt(NaN, 10), null);
  assert.equal(monthCellRect(5, 6).y + monthCellRect(5, 6).h, PAGE_SPECS.month.gridH, 'the last row ends at the grid bottom');
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 7; c++) {
      const cell = monthCellRect(r, c);
      assert.deepEqual(monthCellAt(cell.x + cell.w / 2, cell.y + cell.h / 2), { row: r, col: c });
      assert.deepEqual(monthCellAt(cell.x, cell.y), { row: r, col: c });
    }
  }
});

test('rectToEventRange day: drags snap to 15 minutes', () => {
  // y = minutes * 100 / 60 on the day page.
  assert.deepEqual(fmt(rectToEventRange('day', DAY, rect(100, 900, 300, 1050))),
    { start: '2026-10-04 09:00', end: '2026-10-04 10:30', allDay: false });
  // Both edges snap to the nearest 15 minutes: 9:06 → 9:00, 10:36 → 10:30; 9:09 → 9:15, 10:39 → 10:45.
  assert.deepEqual(fmt(rectToEventRange('day', DAY, rect(100, 910, 300, 1060))),
    { start: '2026-10-04 09:00', end: '2026-10-04 10:30', allDay: false }, 'nearest 15 (down)');
  assert.deepEqual(fmt(rectToEventRange('day', DAY, rect(100, 915, 300, 1065))),
    { start: '2026-10-04 09:15', end: '2026-10-04 10:45', allDay: false }, 'nearest 15 (up)');
  assert.deepEqual(fmt(rectToEventRange('day', DAY, rect(100, 900, 300, 950))),
    { start: '2026-10-04 09:00', end: '2026-10-04 09:30', allDay: false }, 'exactly 30 min stays');
  assert.deepEqual(fmt(rectToEventRange('day', DAY, rect(100, 905, 300, 925))),
    { start: '2026-10-04 09:00', end: '2026-10-04 10:00', allDay: false }, 'shorter than 30 min → 1 hour');
  // Inverted rects are normalized.
  assert.deepEqual(fmt(rectToEventRange('day', DAY, rect(300, 1050, 100, 900))),
    { start: '2026-10-04 09:00', end: '2026-10-04 10:30', allDay: false });
});

test('rectToEventRange: a drag that slightly overshoots an hour line ends on that line', () => {
  // Day page: 14:00 = 1400 lu, 15:00 = 1500 lu. Drag 13:58.8 → 15:02.4.
  assert.deepEqual(fmt(rectToEventRange('day', DAY, rect(100, 1398, 300, 1504))),
    { start: '2026-10-04 14:00', end: '2026-10-04 15:00', allDay: false });
  // ...and one that stops slightly short of it.
  assert.deepEqual(fmt(rectToEventRange('day', DAY, rect(100, 1403, 300, 1495))),
    { start: '2026-10-04 14:00', end: '2026-10-04 15:00', allDay: false });
  // Week page: 14:00 = 1120 lu, 15:00 = 1200 lu. Drag 13:57.75 → 15:04.5.
  assert.deepEqual(fmt(rectToEventRange('week', WEEK, rect(weekColCenter(3), 1117, weekColCenter(3), 1206))),
    { start: '2026-10-07 14:00', end: '2026-10-07 15:00', allDay: false });
  assert.deepEqual(snapEventRect('week', WEEK, rect(weekColCenter(3), 1117, weekColCenter(3), 1206)),
    { minX: columnRect('week', 3).x, maxX: columnRect('week', 3).x + COL_W, minY: 1120, maxY: 1200 },
    'the live preview shows the same 14:00–15:00');
  // Past the half-way point (7.5 min) the next line wins.
  assert.deepEqual(fmt(rectToEventRange('day', DAY, rect(100, 1400, 300, 1513))),
    { start: '2026-10-04 14:00', end: '2026-10-04 15:15', allDay: false }, '15:07.8 → 15:15');
});

test('rectToEventRange day: column outside the timeline still uses the day', () => {
  const inMemo = rectToEventRange('day', DAY, rect(700, 900, 950, 1050));
  const inGutter = rectToEventRange('day', DAY, rect(0, 900, 40, 1050));
  assert.deepEqual(fmt(inMemo), { start: '2026-10-04 09:00', end: '2026-10-04 10:30', allDay: false });
  assert.deepEqual(fmt(inGutter), fmt(inMemo));
});

test('rectToEventRange: taps (height < 12 lu) → the half hour under the center, 1 hour', () => {
  assert.deepEqual(fmt(rectToEventRange('day', DAY, rect(200, 1275, 200, 1275))),
    { start: '2026-10-04 12:30', end: '2026-10-04 13:30', allDay: false });
  assert.deepEqual(fmt(rectToEventRange('day', DAY, rect(200, 1270, 205, 1281.9))),
    { start: '2026-10-04 12:30', end: '2026-10-04 13:30', allDay: false }, 'height 11.9 is a tap');
  // Height exactly 12 is a drag: round15(12:42) = 12:45, round15(12:49.2) = 12:45 → < 30 min → 1 hour.
  assert.deepEqual(fmt(rectToEventRange('day', DAY, rect(200, 1270, 205, 1282))),
    { start: '2026-10-04 12:45', end: '2026-10-04 13:45', allDay: false });
  assert.deepEqual(fmt(rectToEventRange('week', WEEK, rect(weekColCenter(2), 1000, weekColCenter(2), 1000))),
    { start: '2026-10-06 12:30', end: '2026-10-06 13:30', allDay: false }, 'week tap at 12:30');
});

test('rectToEventRange: clamping at 24:00', () => {
  assert.deepEqual(fmt(rectToEventRange('day', DAY, rect(200, 2300, 300, 2500))),
    { start: '2026-10-04 23:00', end: '2026-10-05 00:00', allDay: false }, 'end clamped to 24:00 = next day 00:00');
  assert.deepEqual(fmt(rectToEventRange('day', DAY, rect(200, 2390, 200, 2390))),
    { start: '2026-10-04 23:30', end: '2026-10-05 00:00', allDay: false }, 'tap at 23:54');
  assert.deepEqual(fmt(rectToEventRange('day', DAY, rect(200, 2380, 300, 2400))),
    { start: '2026-10-04 23:45', end: '2026-10-05 00:00', allDay: false }, 'short drag at the bottom: +1h then clamp');
  assert.deepEqual(fmt(rectToEventRange('day', DAY, rect(200, 2400, 200, 2400))),
    { start: '2026-10-04 23:00', end: '2026-10-05 00:00', allDay: false }, 'tap exactly at 24:00 never yields 0 min');
  assert.deepEqual(fmt(rectToEventRange('day', DAY, rect(200, 2500, 300, 2600))),
    { start: '2026-10-04 23:00', end: '2026-10-05 00:00', allDay: false }, 'rect entirely below the page');
  assert.deepEqual(fmt(rectToEventRange('week', WEEK, rect(700, 1800, 760, 2000))),
    { start: '2026-10-07 22:30', end: '2026-10-08 00:00', allDay: false });
  assert.deepEqual(fmt(rectToEventRange('day', DAY, rect(200, -100, 300, -50))),
    { start: '2026-10-04 00:00', end: '2026-10-04 01:00', allDay: false }, 'above the page clamps to 0:00');
});

test('rectToEventRange week: column under the center, nearest column from the gutter', () => {
  // y = minutes * 80 / 60 on the week page; 720 = 9:00, 840 = 10:30.
  assert.deepEqual(fmt(rectToEventRange('week', WEEK, rect(700, 720, 760, 840))),
    { start: '2026-10-07 09:00', end: '2026-10-07 10:30', allDay: false });
  for (let i = 0; i < 7; i++) {
    const r = rectToEventRange('week', WEEK, rect(weekColCenter(i) - 20, 720, weekColCenter(i) + 20, 840));
    assert.equal(toYMD(r.start), toYMD(WEEK.days[i]), `col ${i}`);
  }
  // A rect spanning two columns goes to the column under its center.
  const c1 = columnRect('week', 1);
  assert.equal(toYMD(rectToEventRange('week', WEEK, rect(c1.x - 10, 720, c1.x + 30, 840)).start), '2026-10-05');
  assert.equal(toYMD(rectToEventRange('week', WEEK, rect(c1.x - 30, 720, c1.x + 10, 840)).start), '2026-10-04');
  // Gutter → nearest column (0); beyond the right edge → column 6.
  assert.equal(toYMD(rectToEventRange('week', WEEK, rect(0, 720, 60, 840)).start), '2026-10-04');
  assert.equal(toYMD(rectToEventRange('week', WEEK, rect(1450, 720, 1500, 840)).start), '2026-10-10');
  // Monday-start weeks map column 6 to Sunday.
  const monWeek = rangeFor('week', d(2026, 10, 7), 1);
  assert.equal(toYMD(rectToEventRange('week', monWeek, rect(1300, 720, 1390, 840)).start), '2026-10-11');
});

test('rectToEventRange month: all-day event on the cell under the center', () => {
  // Grid starts 9/27; (row 0, col 4) = 10/1.
  assert.deepEqual(fmt(rectToEventRange('month', MONTH, rect(850, 20, 950, 140))),
    { start: '2026-10-01 00:00', end: '2026-10-02 00:00', allDay: true });
  assert.deepEqual(fmt(rectToEventRange('month', MONTH, rect(410, 360, 490, 380))),
    { start: '2026-10-13 00:00', end: '2026-10-14 00:00', allDay: true }, 'row 2, col 2');
  // Center exactly on a boundary belongs to the next cell.
  assert.equal(toYMD(rectToEventRange('month', MONTH, rect(150, 150, 250, 200)).start), '2026-10-05', 'center (200,175) → (1,1)');
  // Outside the page: clamped to the nearest cell.
  assert.equal(toYMD(rectToEventRange('month', MONTH, rect(-100, -100, -50, -50)).start), '2026-09-27');
  assert.equal(toYMD(rectToEventRange('month', MONTH, rect(1450, 1000, 1500, 1040)).start), '2026-11-07');
  // Below the grid is the memo area (see the memo test).
  assert.equal(toYMD(rectToEventRange('month', MONTH, rect(1450, 1100, 1500, 1200), d(2026, 12, 5)).start), '2026-10-01');
  // Taps work the same.
  assert.equal(toYMD(rectToEventRange('month', MONTH, rect(1250, 900, 1250, 900)).start), '2026-11-07');
  // Year boundary: Dec 2026 grid ends in January 2027.
  const dec = rangeFor('month', d(2026, 12, 1), 0);
  const r = rectToEventRange('month', dec, rect(1300, 950, 1310, 960));
  assert.deepEqual(fmt(r), { start: '2027-01-09 00:00', end: '2027-01-10 00:00', allDay: true });
});

test('rectToEventRange: bad input → null', () => {
  assert.equal(rectToEventRange('day', DAY, null), null);
  assert.equal(rectToEventRange('day', DAY, { minX: 0, minY: 0, maxX: 10 }), null);
  assert.equal(rectToEventRange('day', DAY, rect(0, NaN, 10, 10)), null);
  assert.equal(rectToEventRange('week', null, rect(700, 720, 760, 840)), null);
  assert.equal(rectToEventRange('month', {}, rect(10, 10, 20, 20)), null);
  assert.equal(rectToEventRange('month', {}, rect(10, 1200, 20, 1210)), null, 'memo area without a usable range');
  assert.equal(rectToEventRange('year', {}, rect(100, 10, 120, 20)), null);
  assert.equal(rectToEventRange('year', null, rect(100, 10, 120, 20)), null);
  assert.equal(rectToEventRange('year', rangeFor('year', d(2026, 1, 1)), { minX: 1 }), null);
  assert.throws(() => rectToEventRange('quarter', DAY, rect(0, 0, 1, 1)), RangeError);
  // A range without `days` falls back to `start`.
  const r = rectToEventRange('week', { start: d(2026, 10, 4) }, rect(700, 720, 760, 840));
  assert.equal(toYMD(r.start), '2026-10-07');
});

test('snapEventRect: day/week column × snapped minutes, month cell', () => {
  assert.deepEqual(snapEventRect('day', DAY, rect(700, 910, 950, 1060)),
    { minX: 72, maxX: 660, minY: 900, maxY: 1050 }, '9:00–10:30 in the timeline column');
  // 9:03.75 → 9:00, 10:33.75 → 10:30.
  const w = snapEventRect('week', WEEK, rect(700, 725, 760, 845));
  const c3 = columnRect('week', 3);
  assert.deepEqual(w, { minX: c3.x, maxX: c3.x + c3.w, minY: 720, maxY: 840 });
  assert.deepEqual(snapEventRect('week', WEEK, rect(10, 1900, 20, 1900)),
    { minX: 64, maxX: 64 + COL_W, minY: 1880, maxY: 1920 }, 'gutter tap at 23:45 → col 0, 23:30–24:00');
  assert.deepEqual(snapEventRect('month', MONTH, rect(850, 20, 950, 140)), { minX: 800, minY: 0, maxX: 1000, maxY: 175 });
  assert.deepEqual(snapEventRect('month', MONTH, rect(-50, 1000, -40, 1001)), { minX: 0, minY: 875, maxX: 200, maxY: 1050 });
  // Below the page: the memo area's day (here the 1st, 10/1 = row 0, col 4).
  assert.deepEqual(snapEventRect('month', MONTH, rect(-50, 2000, -40, 2001), d(2027, 3, 1)),
    { minX: 800, minY: 0, maxX: 1000, maxY: 175 });
  assert.equal(snapEventRect('week', WEEK, null), null);
});

/** Small deterministic PRNG (mulberry32) for property tests. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('snapEventRect is consistent with rectToEventRange (randomized)', () => {
  const rand = prng(20261004);
  const now = d(2026, 10, 14, 9); // the October month page's memo area means 10/14
  const cases = [
    ['day', DAY], ['week', WEEK], ['week', rangeFor('week', d(2026, 10, 7), 1)], ['month', MONTH],
    ['month', rangeFor('month', d(2026, 10, 20), 1)], ['month', rangeFor('month', d(2027, 2, 3), 1)],
    ['year', rangeFor('year', d(2026, 5, 5))], ['year', rangeFor('year', d(2028, 5, 5))],
  ];
  for (const [view, range] of cases) {
    const { W, H } = PAGE_SPECS[view];
    for (let i = 0; i < 2000; i++) {
      // Coordinates slightly beyond the page, many tiny rects (taps) and some tall ones.
      const x0 = rand() * (W + 200) - 100;
      const y0 = rand() * (H + 200) - 100;
      const tall = rand() < 0.3 ? rand() * 20 : rand() * H * 0.4;
      const r = rect(x0, y0, x0 + rand() * 300 - 150, y0 + (rand() < 0.5 ? tall : -tall));
      const ev = rectToEventRange(view, range, r, now);
      const snap = snapEventRect(view, range, r, now);
      assert.ok(ev && snap, `${view} ${JSON.stringify(r)}`);
      const dayIndex = daysBetween(range.start, ev.start);

      if (view === 'year') {
        assert.equal(ev.allDay, true);
        assert.equal(daysBetween(ev.start, ev.end), 1);
        assert.equal(ev.start.getFullYear(), range.start.getFullYear());
        const cell = yearCellAt((snap.minX + snap.maxX) / 2, (snap.minY + snap.maxY) / 2, ev.start.getFullYear());
        assert.deepEqual(cell, { month: ev.start.getMonth(), day: ev.start.getDate(), valid: true });
      } else if (view === 'month') {
        // A centre in the memo area means 10/14 on the October page (today), the 1st on the others.
        const cy = Math.min(H, Math.max(0, (r.minY + r.maxY) / 2));
        if (cy >= PAGE_SPECS.month.gridH) {
          const memoDay = range.monthStart.getMonth() === 9 ? '2026-10-14' : toYMD(range.monthStart);
          assert.equal(toYMD(ev.start), memoDay, `memo ${JSON.stringify(r)}`);
        }
        assert.equal(ev.allDay, true);
        assert.equal(daysBetween(ev.start, ev.end), 1);
        assert.deepEqual(monthCellAt((snap.minX + snap.maxX) / 2, (snap.minY + snap.maxY) / 2),
          { row: Math.floor(dayIndex / 7), col: dayIndex % 7 });
      } else {
        assert.equal(ev.allDay, false);
        const startMin = minutesOfDay(ev.start);
        const endMin = daysBetween(ev.start, ev.end) === 1 ? 1440 : minutesOfDay(ev.end);
        assert.equal(daysBetween(ev.start, ev.end) <= 1, true);
        assert.ok(endMin > startMin, 'never zero-length');
        assert.ok(endMin - startMin >= 15);
        assert.ok(startMin >= 0 && endMin <= 1440);
        assert.equal(startMin % 15, 0);
        assert.equal(endMin % 15, 0);
        assert.equal(snap.minY, minutesToY(view, startMin));
        assert.equal(snap.maxY, minutesToY(view, endMin));
        const col = columnRect(view, view === 'day' ? 0 : dayIndex);
        assert.equal(snap.minX, col.x);
        assert.equal(snap.maxX, col.x + col.w);
        if (view === 'day') assert.equal(dayIndex, 0);
      }
      // Feeding the snapped rect back in yields the same event (stable live preview).
      assert.deepEqual(fmt(rectToEventRange(view, range, snap, now)), fmt(ev), `${view} idempotent ${JSON.stringify(r)}`);
    }
  }
});

test('pointToSlot', () => {
  assert.deepEqual(fmt2(pointToSlot('day', DAY, 100, 905)), { date: '2026-10-04', minutes: 540 });
  assert.equal(pointToSlot('day', DAY, 700, 905), null, 'memo area');
  assert.equal(pointToSlot('day', DAY, 30, 905), null, 'gutter');
  assert.equal(pointToSlot('day', DAY, 100, -1), null);
  assert.equal(pointToSlot('day', DAY, 100, 2400.5), null);
  assert.deepEqual(fmt2(pointToSlot('day', DAY, 100, 2400)), { date: '2026-10-04', minutes: 1425 }, 'bottom edge');
  assert.deepEqual(fmt2(pointToSlot('day', DAY, 100, 0)), { date: '2026-10-04', minutes: 0 });
  assert.deepEqual(fmt2(pointToSlot('week', WEEK, weekColCenter(2), 1090)), { date: '2026-10-06', minutes: 810 });
  assert.equal(pointToSlot('week', WEEK, 30, 1090), null, 'gutter');
  assert.deepEqual(fmt2(pointToSlot('month', MONTH, 450, 400)), { date: '2026-10-13', minutes: null });
  assert.deepEqual(fmt2(pointToSlot('month', MONTH, 1400, 1049.9)), { date: '2026-11-07', minutes: null });
  // memo area: today when it is in the month, else the 1st
  assert.deepEqual(fmt2(pointToSlot('month', MONTH, 1400, 1050, d(2026, 10, 30, 8))), { date: '2026-10-30', minutes: null });
  assert.deepEqual(fmt2(pointToSlot('month', MONTH, 700, 1750, d(2026, 11, 2))), { date: '2026-10-01', minutes: null });
  assert.equal(pointToSlot('month', MONTH, 700, 1750.1), null);
  assert.equal(pointToSlot('month', MONTH, -1, 1200), null);
  assert.equal(pointToSlot('month', MONTH, 1401, 10), null);
  assert.equal(pointToSlot('month', MONTH, NaN, 10), null);
  assert.equal(pointToSlot('week', null, 700, 100), null);
});

function fmt2(slot) {
  return slot && { date: toYMD(slot.date), minutes: slot.minutes };
}

// ---------------------------------------------------------------------------------------------
// Year page

const YEAR = rangeFor('year', d(2026, 10, 4)); // 2026: not a leap year
const LEAP = rangeFor('year', d(2028, 6, 1));
const daysIn = (y, m) => new Date(y, m + 1, 0).getDate(); // m 0..11
const yearCellCenter = (m, day) => {
  const c = yearCellRect(m, day);
  return [c.x + c.w / 2, c.y + c.h / 2];
};

test('rangeFor year: every day of the year, from Jan 1 to the next Jan 1, plus yearStart', () => {
  assert.equal(YEAR.days.length, 365);
  assert.equal(LEAP.days.length, 366);
  assert.equal(toYMD(YEAR.start), '2026-01-01');
  assert.equal(toYMD(YEAR.end), '2027-01-01');
  assert.equal(toYMD(YEAR.days[0]), '2026-01-01');
  assert.equal(toYMD(YEAR.days[364]), '2026-12-31');
  assert.equal(YEAR.yearStart.getTime(), d(2026, 1, 1).getTime());
  assert.notEqual(YEAR.yearStart, YEAR.start, 'yearStart is its own Date');
  assert.equal(toYMD(LEAP.days[59]), '2028-02-29');
  YEAR.days.forEach((day, i) => {
    assert.equal(day.getHours() + day.getMinutes(), 0);
    assert.equal(daysBetween(YEAR.start, day), i);
  });
  // any date of the year (and any week start) gives the same range
  for (const date of [d(2026, 1, 1), d(2026, 7, 15, 13), d(2026, 12, 31, 23, 59)]) {
    for (const ws of [0, 1]) assert.equal(rangeFor('year', date, ws).days.map(toYMD).join(), YEAR.days.map(toYMD).join());
  }
  assert.equal(YEAR.monthStart, undefined);
});

test('yearCellRect / yearCellAt: every month × day round-trips; 31 rows of 12 columns after the gutter', () => {
  for (let m = 0; m < 12; m++) {
    for (let day = 1; day <= 31; day++) {
      const c = yearCellRect(m, day);
      assert.deepEqual(c, { x: 56 + m * 112, y: (day - 1) * 60, w: 112, h: 60 });
      for (const year of [2026, 2028]) {
        const valid = day <= daysIn(year, m);
        assert.deepEqual(yearCellAt(...yearCellCenter(m, day), year), { month: m, day, valid }, `${year}-${m + 1}-${day}`);
        assert.deepEqual(yearCellAt(c.x, c.y, year), { month: m, day, valid }, 'top-left corner belongs to the cell');
        assert.deepEqual(yearCellAt(c.x + c.w - 0.01, c.y + c.h - 0.01, year), { month: m, day, valid });
      }
    }
  }
  assert.equal(yearCellRect(12, 1), null);
  assert.equal(yearCellRect(-1, 1), null);
  assert.equal(yearCellRect(0, 0), null);
  assert.equal(yearCellRect(0, 32), null);
  assert.equal(yearCellRect(1.5, 3), null);
  assert.equal(yearCellRect('1', 3), null);
});

test('yearCellAt: invalid dates, 2/29, edges, the gutter and bad input', () => {
  // the dates that never exist
  for (const [m, day] of [[1, 30], [1, 31], [3, 31], [5, 31], [8, 31], [10, 31]]) {
    assert.equal(yearCellAt(...yearCellCenter(m, day), 2026).valid, false);
    assert.equal(yearCellAt(...yearCellCenter(m, day), 2028).valid, false);
    assert.equal(yearCellAt(...yearCellCenter(m, day)).valid, false, 'without a year too');
  }
  // 2/29 depends on the year; without one it counts as valid
  assert.equal(yearCellAt(...yearCellCenter(1, 29), 2026).valid, false);
  assert.equal(yearCellAt(...yearCellCenter(1, 29), 2028).valid, true);
  assert.equal(yearCellAt(...yearCellCenter(1, 29), 2100).valid, false);
  assert.equal(yearCellAt(...yearCellCenter(1, 29), 2000).valid, true);
  assert.equal(yearCellAt(...yearCellCenter(1, 29)).valid, true);
  // the page's right/bottom edges belong to the last column/row (12/31)
  assert.deepEqual(yearCellAt(1400, 1860, 2026), { month: 11, day: 31, valid: true });
  // the day-number gutter and the outside are no cell
  assert.equal(yearCellAt(55.9, 100), null);
  assert.deepEqual(yearCellAt(56, 100), { month: 0, day: 2, valid: true });
  assert.equal(yearCellAt(1400.1, 100), null);
  assert.equal(yearCellAt(100, -0.1), null);
  assert.equal(yearCellAt(100, 1860.1), null);
  assert.equal(yearCellAt(NaN, 100), null);
  assert.equal(yearCellAt(100, undefined), null);
});

test('rectToEventRange year: all-day event on the date under the centre, every day of the year', () => {
  for (const range of [YEAR, LEAP]) {
    for (const day of range.days) {
      const [cx, cy] = yearCellCenter(day.getMonth(), day.getDate());
      // a drag over the cell (lasso bbox or 予定 tool) and a tap
      for (const r of [rect(cx - 40, cy - 20, cx + 30, cy + 25), rect(cx, cy, cx, cy)]) {
        const ev = rectToEventRange('year', range, r);
        assert.deepEqual(fmt(ev), { start: `${toYMD(day)} 00:00`, end: `${toYMD(new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1))} 00:00`, allDay: true });
        const c = yearCellRect(day.getMonth(), day.getDate());
        assert.deepEqual(snapEventRect('year', range, r), { minX: c.x, minY: c.y, maxX: c.x + c.w, maxY: c.y + c.h });
        assert.deepEqual(fmt2(pointToSlot('year', range, cx, cy)), { date: toYMD(day), minutes: null });
      }
    }
  }
});

test('rectToEventRange year: dates that do not exist become the month\'s last day; outside the grid clamps', () => {
  const at = (range, m, day) => toYMD(rectToEventRange('year', range, rect(...yearCellCenter(m, day), ...yearCellCenter(m, day))).start);
  assert.equal(at(YEAR, 1, 29), '2026-02-28');
  assert.equal(at(YEAR, 1, 30), '2026-02-28');
  assert.equal(at(YEAR, 1, 31), '2026-02-28');
  assert.equal(at(LEAP, 1, 29), '2028-02-29');
  assert.equal(at(LEAP, 1, 31), '2028-02-29');
  assert.equal(at(YEAR, 3, 31), '2026-04-30');
  assert.equal(at(YEAR, 5, 31), '2026-06-30');
  assert.equal(at(YEAR, 8, 31), '2026-09-30');
  assert.equal(at(YEAR, 10, 31), '2026-11-30');
  // the preview shows the cell of the date the event gets
  assert.deepEqual(snapEventRect('year', YEAR, rect(...yearCellCenter(1, 31), ...yearCellCenter(1, 31))),
    { minX: 56 + 112, minY: 27 * 60, maxX: 56 + 224, maxY: 28 * 60 });
  assert.deepEqual(snapEventRect('year', LEAP, rect(...yearCellCenter(1, 31), ...yearCellCenter(1, 31))),
    { minX: 56 + 112, minY: 28 * 60, maxX: 56 + 224, maxY: 29 * 60 });
  // without a usable range the preview still snaps (2/29 allowed), the event is null
  assert.deepEqual(snapEventRect('year', null, rect(...yearCellCenter(1, 31), ...yearCellCenter(1, 31))),
    { minX: 56 + 112, minY: 28 * 60, maxX: 56 + 224, maxY: 29 * 60 });
  // the gutter → January; beyond the right edge → December; above / below the page → day 1 / 31
  assert.equal(toYMD(rectToEventRange('year', YEAR, rect(0, 130, 40, 150)).start), '2026-01-03');
  assert.equal(toYMD(rectToEventRange('year', YEAR, rect(1450, 130, 1500, 150)).start), '2026-12-03');
  assert.equal(toYMD(rectToEventRange('year', YEAR, rect(300, -100, 320, -50)).start), '2026-03-01');
  assert.equal(toYMD(rectToEventRange('year', YEAR, rect(300, 1900, 320, 2000)).start), '2026-03-31');
  // a rect spanning two cells goes to the one under its centre
  assert.equal(toYMD(rectToEventRange('year', YEAR, rect(56 + 112 * 4 - 30, 300, 56 + 112 * 4 + 50, 380)).start), '2026-05-06');
  // a range given only by its days (no yearStart) works the same
  assert.equal(toYMD(rectToEventRange('year', { days: YEAR.days }, rect(...yearCellCenter(6, 7), ...yearCellCenter(6, 7))).start), '2026-07-07');
  assert.equal(toYMD(rectToEventRange('year', { start: d(2026, 1, 1) }, rect(...yearCellCenter(6, 7), ...yearCellCenter(6, 7))).start), '2026-07-07');
});

test('pointToSlot year: date under the point; gutter and outside → null', () => {
  assert.deepEqual(fmt2(pointToSlot('year', YEAR, ...yearCellCenter(9, 4))), { date: '2026-10-04', minutes: null });
  assert.deepEqual(fmt2(pointToSlot('year', YEAR, ...yearCellCenter(1, 30))), { date: '2026-02-28', minutes: null });
  assert.deepEqual(fmt2(pointToSlot('year', LEAP, ...yearCellCenter(1, 30))), { date: '2028-02-29', minutes: null });
  assert.deepEqual(fmt2(pointToSlot('year', YEAR, 1400, 1860)), { date: '2026-12-31', minutes: null });
  assert.equal(pointToSlot('year', YEAR, 30, 100), null, 'day-number gutter');
  assert.equal(pointToSlot('year', YEAR, 300, 1860.5), null);
  assert.equal(pointToSlot('year', YEAR, 300, -1), null);
  assert.equal(pointToSlot('year', null, 300, 100), null);
});

// ---------------------------------------------------------------------------------------------
// Month memo area (y ≥ gridH)

test('month memo area: means today when today is in that month, else the 1st', () => {
  const memo = rect(300, 1300, 700, 1420); // a lasso around writing in the memo area
  // Monday-start October 2026 (grid 9/28 .. 11/8)
  const oct = rangeFor('month', d(2026, 10, 20), 1);
  assert.deepEqual(fmt(rectToEventRange('month', oct, memo, d(2026, 10, 14, 22, 30))),
    { start: '2026-10-14 00:00', end: '2026-10-15 00:00', allDay: true });
  assert.deepEqual(snapEventRect('month', oct, memo, d(2026, 10, 14, 22, 30)), { minX: 400, minY: 350, maxX: 600, maxY: 525 },
    '10/14 = row 2, col 2');
  // today in a neighbouring month shown on the grid (11/3) still means the page's month: the 1st
  assert.equal(toYMD(rectToEventRange('month', oct, memo, d(2026, 11, 3)).start), '2026-10-01');
  assert.equal(toYMD(rectToEventRange('month', oct, memo, d(2026, 9, 29)).start), '2026-10-01');
  assert.equal(toYMD(rectToEventRange('month', oct, memo, d(2025, 10, 14)).start), '2026-10-01', 'same month of another year');
  assert.deepEqual(snapEventRect('month', oct, memo, d(2027, 1, 1)), { minX: 600, minY: 0, maxX: 800, maxY: 175 }, '10/1 = row 0, col 3');
  // the last day of the month, and the 1st on a Sunday-start grid
  assert.equal(toYMD(rectToEventRange('month', oct, memo, d(2026, 10, 31, 23, 59)).start), '2026-10-31');
  assert.equal(toYMD(rectToEventRange('month', MONTH, memo, d(2027, 5, 1)).start), '2026-10-01');
  // the memo area starts exactly at gridH: a centre at gridH is memo, just above it is the last row
  assert.equal(toYMD(rectToEventRange('month', oct, rect(100, 1040, 100, 1060), d(2026, 10, 14)).start), '2026-10-14');
  assert.equal(toYMD(rectToEventRange('month', oct, rect(100, 1040, 100, 1059.8), d(2026, 10, 14)).start), '2026-11-02');
  // taps, the page bottom and below the page all mean the memo day
  for (const r of [rect(50, 1100, 50, 1100), rect(1390, 1749, 1395, 1750), rect(700, 1800, 720, 1900)]) {
    assert.equal(toYMD(rectToEventRange('month', oct, r, d(2026, 10, 6)).start), '2026-10-06');
  }
  // a range without monthStart: derived from its grid
  const bare = { start: oct.start, end: oct.end, days: oct.days };
  assert.equal(toYMD(rectToEventRange('month', bare, memo, d(2026, 10, 9)).start), '2026-10-09');
  assert.equal(toYMD(rectToEventRange('month', bare, memo, d(2026, 12, 9)).start), '2026-10-01');
  // a range whose month is not on its own grid (garbage) → null instead of a wrong cell
  assert.equal(rectToEventRange('month', { ...oct, monthStart: d(2027, 6, 1) }, memo, d(2027, 6, 9)), null);
  assert.equal(snapEventRect('month', { ...oct, monthStart: d(2027, 6, 1) }, memo, d(2027, 6, 9)), null);
  // default `now` is the current time
  const real = new Date();
  const cur = rangeFor('month', real, 1);
  assert.equal(toYMD(rectToEventRange('month', cur, memo).start), toYMD(real));
});

test('ranges and event times stay on local midnights across DST (America/New_York)', () => {
  const url = new URL('../js/views/page-geometry.js', import.meta.url).href;
  const code = `const G = await import(${JSON.stringify(url)});
    const week = G.rangeFor('week', new Date(2026, 2, 10), 0);          // contains 2026-03-08 (spring forward)
    const month = G.rangeFor('month', new Date(2026, 10, 15), 0);       // contains 2026-11-01 (fall back)
    const ev = G.rectToEventRange('week', week, { minX: 100, maxX: 120, minY: 1800, maxY: 1920 });
    process.stdout.write(JSON.stringify({
      weekHours: week.days.map((x) => x.getHours()),
      weekDates: week.days.map((x) => x.getDate()),
      monthHours: [...new Set(month.days.map((x) => x.getHours()))],
      monthLen: month.days.length,
      endIsNextMidnight: ev.end.getTime() === new Date(2026, 2, 9).getTime(),
      startHour: ev.start.getHours(),
      nav: G.navigate('week', new Date(2026, 2, 5), 1).getDate(),
      yearLen: G.rangeFor('year', new Date(2026, 5, 1)).days.length,
      yearHours: [...new Set(G.rangeFor('year', new Date(2026, 5, 1)).days.map((x) => x.getHours()))],
      yearNav: G.navigate('year', new Date(2026, 10, 1, 1, 30), 1).getTime() === new Date(2027, 0, 1).getTime(),
      yearEv: (() => {
        const r = G.rectToEventRange('year', G.rangeFor('year', new Date(2026, 2, 8)),
          { minX: 56 + 2 * 112 + 10, maxX: 56 + 2 * 112 + 20, minY: 7 * 60 + 10, maxY: 7 * 60 + 20 });
        return [r.start.getDate(), r.start.getHours(), r.end.getDate(), r.end.getHours()];
      })(),
    }));`;
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8',
  }));
  assert.deepEqual(out.weekHours, [0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(out.weekDates, [8, 9, 10, 11, 12, 13, 14]);
  assert.deepEqual(out.monthHours, [0]);
  assert.equal(out.monthLen, 42);
  assert.equal(out.endIsNextMidnight, true);
  assert.equal(out.startHour, 22);
  assert.equal(out.nav, 12);
  assert.equal(out.yearLen, 365);
  assert.deepEqual(out.yearHours, [0]);
  assert.equal(out.yearNav, true);
  assert.deepEqual(out.yearEv, [8, 0, 9, 0], '2026-03-08 (spring forward) is a whole local day');
});
