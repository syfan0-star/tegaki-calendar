// Tests for js/util/date.js. Run with TZ=Asia/Tokyo; other time zones are exercised in child processes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import {
  WEEKDAYS_JA,
  addDays,
  addMonths,
  atMinutes,
  clamp,
  daysBetween,
  formatDateJa,
  formatMonthJa,
  formatTimeJa,
  formatTimeRangeJa,
  formatWeekRangeJa,
  isSameDay,
  isValidDate,
  minutesOfDay,
  monthGridStart,
  parseHM,
  parseYMD,
  roundMinutes,
  startOfDay,
  startOfMonth,
  startOfWeek,
  toHM,
  toRFC3339,
  toYMD,
} from '../js/util/date.js';

const DATE_MODULE_URL = new URL('../js/util/date.js', import.meta.url).href;
const d = (y, m, day, h = 0, mi = 0, s = 0) => new Date(y, m - 1, day, h, mi, s);
const INVALID = new Date(NaN);

/** Runs `body` (an async function body with `M` = the date module) under another TZ; returns its JSON result. */
function runInTimeZone(tz, body) {
  const code = `const M = await import(${JSON.stringify(DATE_MODULE_URL)});
const result = await (async () => { ${body} })();
process.stdout.write(JSON.stringify(result));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

// Tests with +09:00 / JST literals only run in Asia/Tokyo (npm test sets TZ); other zones are covered in child processes.
const IS_JST = new Date(2026, 0, 1).getTimezoneOffset() === -540 && new Date(2026, 6, 1).getTimezoneOffset() === -540;
const jstOnly = { skip: IS_JST ? false : 'expects TZ=Asia/Tokyo' };

test('the suite runs in Asia/Tokyo', jstOnly, () => {
  assert.equal(new Date(2026, 0, 1).getTimezoneOffset(), -540);
});

test('WEEKDAYS_JA', () => {
  assert.deepEqual(WEEKDAYS_JA, ['日', '月', '火', '水', '木', '金', '土']);
});

test('startOfDay returns a new local-midnight Date and does not mutate', () => {
  const src = d(2026, 10, 4, 15, 30, 12);
  const r = startOfDay(src);
  assert.equal(r.getTime(), d(2026, 10, 4).getTime());
  assert.notEqual(r, src);
  assert.equal(src.getHours(), 15);
  assert.ok(!isValidDate(startOfDay(INVALID)));
  assert.ok(!isValidDate(startOfDay('2026-10-04')));
});

test('addDays: calendar arithmetic, keeps time, crosses months/years, no mutation', () => {
  const src = d(2026, 10, 4, 9, 15);
  assert.equal(addDays(src, 1).getTime(), d(2026, 10, 5, 9, 15).getTime());
  assert.equal(addDays(src, -4).getTime(), d(2026, 9, 30, 9, 15).getTime());
  assert.equal(addDays(d(2026, 12, 31), 1).getTime(), d(2027, 1, 1).getTime());
  assert.equal(addDays(d(2028, 2, 28), 1).getTime(), d(2028, 2, 29).getTime());
  assert.equal(addDays(d(2027, 2, 28), 1).getTime(), d(2027, 3, 1).getTime());
  assert.equal(addDays(src, 0).getTime(), src.getTime());
  assert.equal(addDays(src, 'x').getTime(), src.getTime(), 'garbage n → 0');
  assert.equal(addDays(src, 2.9).getTime(), d(2026, 10, 6, 9, 15).getTime(), 'n truncated');
  assert.equal(src.getDate(), 4);
  assert.ok(!isValidDate(addDays(INVALID, 1)));
});

test('addMonths returns the 1st of the resulting month at 00:00', () => {
  assert.equal(addMonths(d(2026, 10, 31, 13), 1).getTime(), d(2026, 11, 1).getTime());
  assert.equal(addMonths(d(2026, 1, 31), 1).getTime(), d(2026, 2, 1).getTime());
  assert.equal(addMonths(d(2026, 1, 15), -1).getTime(), d(2025, 12, 1).getTime());
  assert.equal(addMonths(d(2026, 12, 5), 1).getTime(), d(2027, 1, 1).getTime());
  assert.equal(addMonths(d(2026, 10, 4), 0).getTime(), d(2026, 10, 1).getTime());
  assert.equal(addMonths(d(2026, 10, 4), 14).getTime(), d(2027, 12, 1).getTime());
});

test('startOfWeek honors weekStart 0 (Sunday) and 1 (Monday)', () => {
  // 2026-10-04 is a Sunday.
  assert.equal(startOfWeek(d(2026, 10, 4, 12), 0).getTime(), d(2026, 10, 4).getTime());
  assert.equal(startOfWeek(d(2026, 10, 4, 12), 1).getTime(), d(2026, 9, 28).getTime());
  assert.equal(startOfWeek(d(2026, 10, 3), 0).getTime(), d(2026, 9, 27).getTime());
  assert.equal(startOfWeek(d(2026, 10, 5), 1).getTime(), d(2026, 10, 5).getTime());
  assert.equal(startOfWeek(d(2026, 10, 10), 1).getTime(), d(2026, 10, 5).getTime());
  assert.equal(startOfWeek(d(2027, 1, 2), 0).getTime(), d(2026, 12, 27).getTime());
  assert.equal(startOfWeek(d(2026, 10, 7)).getTime(), d(2026, 10, 4).getTime(), 'default Sunday');
});

test('startOfMonth and monthGridStart', () => {
  assert.equal(startOfMonth(d(2026, 10, 31, 23)).getTime(), d(2026, 10, 1).getTime());
  // 2026-10-01 is a Thursday.
  assert.equal(monthGridStart(d(2026, 10, 20), 0).getTime(), d(2026, 9, 27).getTime());
  assert.equal(monthGridStart(d(2026, 10, 20), 1).getTime(), d(2026, 9, 28).getTime());
  // 2026-02-01 is a Sunday: with Sunday start the grid starts on the 1st itself.
  assert.equal(monthGridStart(d(2026, 2, 14), 0).getTime(), d(2026, 2, 1).getTime());
  assert.equal(monthGridStart(d(2026, 2, 14), 1).getTime(), d(2026, 1, 26).getTime());
});

test('isSameDay', () => {
  assert.equal(isSameDay(d(2026, 10, 4, 0), d(2026, 10, 4, 23, 59)), true);
  assert.equal(isSameDay(d(2026, 10, 4), d(2026, 10, 5)), false);
  assert.equal(isSameDay(d(2026, 10, 4), d(2025, 10, 4)), false);
  assert.equal(isSameDay(d(2026, 10, 4), INVALID), false);
  assert.equal(isSameDay(null, d(2026, 10, 4)), false);
});

test('daysBetween counts calendar days and ignores time of day', () => {
  assert.equal(daysBetween(d(2026, 10, 4, 23, 59), d(2026, 10, 5, 0, 1)), 1);
  assert.equal(daysBetween(d(2026, 10, 5), d(2026, 10, 4, 23)), -1);
  assert.equal(daysBetween(d(2026, 1, 1), d(2027, 1, 1)), 365);
  assert.equal(daysBetween(d(2028, 1, 1), d(2029, 1, 1)), 366);
  assert.equal(daysBetween(d(2026, 10, 4, 8), d(2026, 10, 4, 20)), 0);
  assert.ok(Number.isNaN(daysBetween(INVALID, d(2026, 1, 1))));
});

test('toYMD / parseYMD', () => {
  assert.equal(toYMD(d(2026, 10, 4, 23, 59)), '2026-10-04');
  assert.equal(toYMD(d(2026, 1, 9)), '2026-01-09');
  assert.equal(toYMD(INVALID), '');
  assert.equal(toYMD(undefined), '');

  assert.equal(parseYMD('2026-10-04').getTime(), d(2026, 10, 4).getTime());
  assert.equal(parseYMD(' 2026-10-04 ').getTime(), d(2026, 10, 4).getTime());
  assert.equal(parseYMD('2028-02-29').getTime(), d(2028, 2, 29).getTime());
  for (const bad of ['2026-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '2026-10-4', '20261004',
    '2026/10/04', '2026-10-04T00:00', '', 'abc', null, undefined, 20261004, d(2026, 10, 4)]) {
    assert.equal(parseYMD(bad), null, `parseYMD(${String(bad)})`);
  }
  // Round trip across a whole year.
  for (let i = 0; i < 366; i++) {
    const day = addDays(d(2028, 1, 1), i);
    assert.equal(parseYMD(toYMD(day)).getTime(), day.getTime());
  }
});

test('toHM / parseHM / minutesOfDay', () => {
  assert.equal(toHM(d(2026, 10, 4, 9, 5)), '09:05');
  assert.equal(toHM(d(2026, 10, 4, 0, 0)), '00:00');
  assert.equal(toHM(d(2026, 10, 4, 23, 59)), '23:59');
  assert.equal(toHM(INVALID), '');

  assert.equal(parseHM('09:05'), 545);
  assert.equal(parseHM('9:05'), 545);
  assert.equal(parseHM('00:00'), 0);
  assert.equal(parseHM('23:59'), 1439);
  assert.equal(parseHM('10:30:00'), 630, 'seconds variant from <input type=time>');
  assert.equal(parseHM('24:00'), 1440);
  for (const bad of ['24:01', '25:00', '12:60', '12:5', '1230', '', 'ab:cd', null, 630, '12:30:61']) {
    assert.equal(parseHM(bad), null, `parseHM(${String(bad)})`);
  }

  assert.equal(minutesOfDay(d(2026, 10, 4, 9, 30, 59)), 570);
  assert.equal(minutesOfDay(d(2026, 10, 4)), 0);
  assert.ok(Number.isNaN(minutesOfDay(INVALID)));
});

test('atMinutes', () => {
  assert.equal(atMinutes(d(2026, 10, 4, 17), 540).getTime(), d(2026, 10, 4, 9).getTime());
  assert.equal(atMinutes(d(2026, 10, 4), 0).getTime(), d(2026, 10, 4).getTime());
  assert.equal(atMinutes(d(2026, 10, 4), 1440).getTime(), d(2026, 10, 5).getTime(), '1440 → next day 00:00');
  assert.equal(atMinutes(d(2026, 12, 31), 1440).getTime(), d(2027, 1, 1).getTime());
  assert.equal(atMinutes(d(2026, 10, 4), 90.4).getTime(), d(2026, 10, 4, 1, 30).getTime());
  assert.ok(!isValidDate(atMinutes(d(2026, 10, 4), NaN)));
  assert.ok(!isValidDate(atMinutes(INVALID, 60)));
});

test('toRFC3339 in Asia/Tokyo', jstOnly, () => {
  assert.equal(toRFC3339(d(2026, 10, 4, 9, 0)), '2026-10-04T09:00:00+09:00');
  assert.equal(toRFC3339(d(2026, 1, 1, 0, 0, 5)), '2026-01-01T00:00:05+09:00');
  assert.equal(toRFC3339(new Date(Date.UTC(2026, 9, 3, 15, 0, 0, 999))), '2026-10-04T00:00:00+09:00', 'ms dropped');
  assert.throws(() => toRFC3339(INVALID), RangeError);
  assert.throws(() => toRFC3339('2026-10-04'), RangeError);
});

test('toRFC3339 uses the local offset: negative, half-hour, 45-minute and DST offsets', () => {
  const body = `
    const out = {};
    const instant = new Date(Date.UTC(2026, 0, 15, 12, 0, 0));   // winter
    const summer = new Date(Date.UTC(2026, 6, 15, 12, 0, 0));
    out.w = M.toRFC3339(instant);
    out.s = M.toRFC3339(summer);
    out.roundTrip = new Date(out.w).getTime() === instant.getTime() && new Date(out.s).getTime() === summer.getTime();
    return out;`;
  const cases = {
    UTC: ['2026-01-15T12:00:00+00:00', '2026-07-15T12:00:00+00:00'],
    'America/New_York': ['2026-01-15T07:00:00-05:00', '2026-07-15T08:00:00-04:00'],
    'America/Los_Angeles': ['2026-01-15T04:00:00-08:00', '2026-07-15T05:00:00-07:00'],
    'Asia/Kolkata': ['2026-01-15T17:30:00+05:30', '2026-07-15T17:30:00+05:30'],
    'America/St_Johns': ['2026-01-15T08:30:00-03:30', '2026-07-15T09:30:00-02:30'],
    'Asia/Kathmandu': ['2026-01-15T17:45:00+05:45', '2026-07-15T17:45:00+05:45'],
    'Australia/Adelaide': ['2026-01-15T22:30:00+10:30', '2026-07-15T21:30:00+09:30'],
    'Pacific/Kiritimati': ['2026-01-16T02:00:00+14:00', '2026-07-16T02:00:00+14:00'],
  };
  for (const [tz, [w, s]] of Object.entries(cases)) {
    const r = runInTimeZone(tz, body);
    assert.equal(r.w, w, `${tz} winter`);
    assert.equal(r.s, s, `${tz} summer`);
    assert.equal(r.roundTrip, true, `${tz} round trip`);
  }
});

test('DST-safe arithmetic in America/New_York', () => {
  const r = runInTimeZone('America/New_York', `
    const springEve = new Date(2026, 2, 7, 12, 0);        // Sat before 2026-03-08 spring forward
    const fallEve = new Date(2026, 9, 31, 12, 0);         // Sat before 2026-11-01 fall back
    return {
      spring: M.addDays(springEve, 1).getHours(),
      fall: M.addDays(fallEve, 1).getHours(),
      springMidnight: M.addDays(new Date(2026, 2, 8), 1).getTime() === new Date(2026, 2, 9).getTime(),
      week: M.addDays(new Date(2026, 2, 5), 7).getTime() === new Date(2026, 2, 12).getTime(),
      between: M.daysBetween(new Date(2026, 2, 1), new Date(2026, 3, 1)),
      betweenFall: M.daysBetween(new Date(2026, 9, 31, 23), new Date(2026, 10, 1, 0, 30)),
      sow: M.toYMD(M.startOfWeek(new Date(2026, 2, 10, 1), 0)),
      sowMidnight: M.startOfWeek(new Date(2026, 2, 10, 1), 0).getHours(),
      endOfDay: M.atMinutes(new Date(2026, 2, 8), 1440).getTime() === new Date(2026, 2, 9).getTime(),
      rfcSpring: M.toRFC3339(M.atMinutes(new Date(2026, 2, 8), 180)),
      monthNav: M.toYMD(M.addMonths(new Date(2026, 9, 31, 23, 30), 1)),
    };`);
  assert.equal(r.spring, 12, 'wall-clock time kept across spring-forward');
  assert.equal(r.fall, 12, 'wall-clock time kept across fall-back');
  assert.equal(r.springMidnight, true);
  assert.equal(r.week, true);
  assert.equal(r.between, 31);
  assert.equal(r.betweenFall, 1);
  assert.equal(r.sow, '2026-03-08');
  assert.equal(r.sowMidnight, 0);
  assert.equal(r.endOfDay, true);
  assert.equal(r.rfcSpring, '2026-03-08T03:00:00-04:00');
  assert.equal(r.monthNav, '2026-11-01');
});

test('missing local midnight (America/Sao_Paulo 2018-11-04) does not break day math', () => {
  const r = runInTimeZone('America/Sao_Paulo', `
    const day = M.startOfDay(new Date(2018, 10, 4, 15));
    return {
      ymd: M.toYMD(day),
      next: M.toYMD(M.addDays(day, 1)),
      prev: M.toYMD(M.addDays(day, -1)),
      between: M.daysBetween(new Date(2018, 10, 3), new Date(2018, 10, 5)),
      sow: M.toYMD(M.startOfWeek(new Date(2018, 10, 6), 0)),
      parsed: M.toYMD(M.parseYMD('2018-11-04')),
    };`);
  assert.deepEqual(r, {
    ymd: '2018-11-04', next: '2018-11-05', prev: '2018-11-03', between: 2, sow: '2018-11-04', parsed: '2018-11-04',
  });
});

test('formatDateJa / formatMonthJa', () => {
  assert.equal(formatDateJa(d(2026, 10, 4)), '2026年10月4日(日)');
  assert.equal(formatDateJa(d(2026, 10, 10, 18)), '2026年10月10日(土)');
  assert.equal(formatDateJa(d(2027, 1, 1)), '2027年1月1日(金)');
  assert.equal(formatDateJa(INVALID), '');
  assert.equal(formatMonthJa(d(2026, 10, 4)), '2026年10月');
  assert.equal(formatMonthJa(d(2027, 1, 31)), '2027年1月');
  assert.equal(formatMonthJa(null), '');
});

test('formatWeekRangeJa', () => {
  assert.equal(formatWeekRangeJa(d(2026, 9, 27), d(2026, 10, 4)), '2026年9月27日〜10月3日');
  assert.equal(formatWeekRangeJa(d(2026, 12, 28), d(2027, 1, 4)), '2026年12月28日〜2027年1月3日');
  assert.equal(formatWeekRangeJa(d(2026, 10, 4), d(2026, 10, 11)), '2026年10月4日〜10月10日');
  assert.equal(formatWeekRangeJa(d(2026, 12, 27), d(2027, 1, 3)), '2026年12月27日〜2027年1月2日');
  assert.equal(formatWeekRangeJa(d(2026, 12, 25), d(2027, 1, 1)), '2026年12月25日〜12月31日', 'ends on Dec 31');
  assert.equal(formatWeekRangeJa(d(2026, 10, 4), d(2026, 10, 5)), '2026年10月4日', 'single day');
  assert.equal(formatWeekRangeJa(d(2026, 10, 4), d(2026, 10, 4)), '2026年10月4日', 'empty range');
  assert.equal(formatWeekRangeJa(d(2026, 10, 4), d(2026, 10, 10, 12)), '2026年10月4日〜10月10日', 'non-midnight end');
  assert.equal(formatWeekRangeJa(INVALID, d(2026, 10, 4)), '');
});

test('formatTimeJa / formatTimeRangeJa', () => {
  assert.equal(formatTimeJa(d(2026, 10, 4, 9, 0)), '9:00');
  assert.equal(formatTimeJa(d(2026, 10, 4, 0, 5)), '0:05');
  assert.equal(formatTimeJa(d(2026, 10, 4, 23, 45)), '23:45');
  assert.equal(formatTimeJa(INVALID), '');
  assert.equal(formatTimeRangeJa(d(2026, 10, 4, 9), d(2026, 10, 4, 10, 30)), '9:00〜10:30');
  assert.equal(formatTimeRangeJa(d(2026, 10, 4, 9), INVALID), '');
});

test('roundMinutes', () => {
  assert.equal(roundMinutes(67, 15, 'floor'), 60);
  assert.equal(roundMinutes(67, 15, 'ceil'), 75);
  assert.equal(roundMinutes(67, 15, 'round'), 60);
  assert.equal(roundMinutes(68, 15, 'round'), 75);
  assert.equal(roundMinutes(68), 75, 'defaults: step 15, round');
  assert.equal(roundMinutes(60, 15, 'ceil'), 60, 'exact multiples stay');
  assert.equal(roundMinutes(60, 15, 'floor'), 60);
  assert.equal(roundMinutes(59, 30, 'floor'), 30);
  assert.equal(roundMinutes(0.1 + 0.2 + 59.7, 15, 'ceil'), 60, 'float noise does not bump ceil');
  assert.equal(roundMinutes(-7, 15, 'floor'), -15);
  assert.equal(roundMinutes(67, 0, 'floor'), 67, 'bad step → unchanged');
  assert.ok(Number.isNaN(roundMinutes(NaN, 15, 'floor')));
});

test('clamp', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
  assert.equal(clamp(5, 10, 0), 5, 'bounds in either order');
  assert.equal(clamp(NaN, 0, 10), 0);
  assert.equal(clamp(Infinity, 0, 1440), 1440);
});
