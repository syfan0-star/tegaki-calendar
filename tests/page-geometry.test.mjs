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
  assert.deepEqual(VIEWS, ['day', 'week', 'month']);
  assert.deepEqual(PAGE_SPECS.day, { W: 1000, H: 2400, gutter: 72, hourH: 100, timelineRight: 660, fit: 'width' });
  assert.deepEqual(PAGE_SPECS.week, { W: 1400, H: 1920, gutter: 64, hourH: 80, cols: 7, fit: 'width' });
  assert.deepEqual(PAGE_SPECS.month, { W: 1400, H: 1050, cols: 7, rows: 6, fit: 'contain' });
  assert.ok(Object.isFrozen(PAGE_SPECS) && Object.isFrozen(PAGE_SPECS.week));
  // The timelines span exactly 24 hours.
  assert.equal(PAGE_SPECS.day.H, 24 * PAGE_SPECS.day.hourH);
  assert.equal(PAGE_SPECS.week.H, 24 * PAGE_SPECS.week.hourH);
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
  assert.throws(() => pageIdFor('year', d(2026, 10, 4)), RangeError);
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
  assert.deepEqual(monthCellAt(1400, 1050), { row: 5, col: 6 }, 'page edge belongs to the last cell');
  assert.equal(monthCellAt(-0.1, 10), null);
  assert.equal(monthCellAt(10, -0.1), null);
  assert.equal(monthCellAt(1400.1, 10), null);
  assert.equal(monthCellAt(10, 1050.1), null);
  assert.equal(monthCellAt(NaN, 10), null);
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
  assert.equal(toYMD(rectToEventRange('month', MONTH, rect(1450, 1100, 1500, 1200)).start), '2026-11-07');
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
  assert.throws(() => rectToEventRange('year', DAY, rect(0, 0, 1, 1)), RangeError);
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
  assert.deepEqual(snapEventRect('month', MONTH, rect(-50, 2000, -40, 2001)), { minX: 0, minY: 875, maxX: 200, maxY: 1050 });
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
  const cases = [['day', DAY], ['week', WEEK], ['week', rangeFor('week', d(2026, 10, 7), 1)], ['month', MONTH]];
  for (const [view, range] of cases) {
    const { W, H } = PAGE_SPECS[view];
    for (let i = 0; i < 2000; i++) {
      // Coordinates slightly beyond the page, many tiny rects (taps) and some tall ones.
      const x0 = rand() * (W + 200) - 100;
      const y0 = rand() * (H + 200) - 100;
      const tall = rand() < 0.3 ? rand() * 20 : rand() * H * 0.4;
      const r = rect(x0, y0, x0 + rand() * 300 - 150, y0 + (rand() < 0.5 ? tall : -tall));
      const ev = rectToEventRange(view, range, r);
      const snap = snapEventRect(view, range, r);
      assert.ok(ev && snap, `${view} ${JSON.stringify(r)}`);
      const dayIndex = daysBetween(range.start, ev.start);

      if (view === 'month') {
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
      assert.deepEqual(fmt(rectToEventRange(view, range, snap)), fmt(ev), `${view} idempotent ${JSON.stringify(r)}`);
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
  assert.deepEqual(fmt2(pointToSlot('month', MONTH, 1400, 1050)), { date: '2026-11-07', minutes: null });
  assert.equal(pointToSlot('month', MONTH, 1401, 10), null);
  assert.equal(pointToSlot('month', MONTH, NaN, 10), null);
  assert.equal(pointToSlot('week', null, 700, 100), null);
});

function fmt2(slot) {
  return slot && { date: toYMD(slot.date), minutes: slot.minutes };
}

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
});
