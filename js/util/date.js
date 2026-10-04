// Local-time date helpers.
//
// Every function works on the device's local calendar (y/m/d from getFullYear/getMonth/getDate) and
// never mutates its arguments. Day arithmetic goes through setDate()/the Date constructor, never by
// adding 86 400 000 ms, so it stays correct across DST transitions.
//
// Bad input policy:
//   - arithmetic helpers return an Invalid Date when given one (like the Date API itself);
//   - string formatters (toYMD, toHM, format*Ja) return '' for invalid dates;
//   - toRFC3339 throws a RangeError (like Date#toISOString): a bad timestamp must never reach the API;
//   - parsers (parseYMD, parseHM) return null.

export const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'];

const pad2 = (n) => String(n).padStart(2, '0');

/** Formats a (possibly negative or > 9999) year as at least 4 digits. */
function padYear(y) {
  return y < 0 ? '-' + String(-y).padStart(6, '0') : String(y).padStart(4, '0');
}

/** True for a Date object holding a real time value. */
export function isValidDate(d) {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

/** Converts a Date or epoch-ms number into a new Date (Invalid Date for anything else). */
function toDate(d) {
  if (d instanceof Date) return new Date(d.getTime());
  if (typeof d === 'number') return new Date(d);
  return new Date(NaN);
}

/** Integer coercion for counts (n days, n months); garbage → 0. */
function toInt(n) {
  const v = Math.trunc(Number(n));
  return Number.isFinite(v) ? v : 0;
}

/** new Date(y, m, d, h, mi) that also works for years 0–99 (which the constructor maps to 19xx). */
function makeLocal(y, m, d, h = 0, mi = 0) {
  if (y >= 0 && y < 100) {
    const r = new Date(2000, 0, 1);
    r.setFullYear(y, m, d);
    r.setHours(h, mi, 0, 0);
    return r;
  }
  return new Date(y, m, d, h, mi, 0, 0);
}

/** Milliseconds of UTC midnight for (y, m, d); unlike Date.UTC it does not remap years 0–99. */
function utcMidnight(y, m, d) {
  const t = new Date(0);
  t.setUTCFullYear(y, m, d);
  return t.getTime();
}

function normalizeWeekStart(weekStart) {
  const ws = toInt(weekStart);
  return ((ws % 7) + 7) % 7;
}

/** Local midnight of the day containing d (new Date). */
export function startOfDay(d) {
  const t = toDate(d);
  if (!isValidDate(t)) return t;
  return makeLocal(t.getFullYear(), t.getMonth(), t.getDate());
}

/** d + n calendar days, keeping the wall-clock time (DST-safe). */
export function addDays(d, n) {
  const r = toDate(d);
  if (!isValidDate(r)) return r;
  r.setDate(r.getDate() + toInt(n));
  return r;
}

/** 1st of the month n months after d's month, at 00:00. */
export function addMonths(d, n) {
  const t = toDate(d);
  if (!isValidDate(t)) return t;
  return makeLocal(t.getFullYear(), t.getMonth() + toInt(n), 1);
}

/** Local midnight of the first day of d's week; weekStart 0 = Sunday, 1 = Monday. */
export function startOfWeek(d, weekStart = 0) {
  const day = startOfDay(d);
  if (!isValidDate(day)) return day;
  const back = (day.getDay() - normalizeWeekStart(weekStart) + 7) % 7;
  return addDays(day, -back);
}

/** Local midnight of the 1st of d's month. */
export function startOfMonth(d) {
  const t = toDate(d);
  if (!isValidDate(t)) return t;
  return makeLocal(t.getFullYear(), t.getMonth(), 1);
}

/** First cell of a 6-week month grid: the week start on or before the 1st. */
export function monthGridStart(d, weekStart = 0) {
  return startOfWeek(startOfMonth(d), weekStart);
}

/** Same local calendar day (false if either is not a valid date). */
export function isSameDay(a, b) {
  const x = toDate(a);
  const y = toDate(b);
  if (!isValidDate(x) || !isValidDate(y)) return false;
  return x.getFullYear() === y.getFullYear()
    && x.getMonth() === y.getMonth()
    && x.getDate() === y.getDate();
}

/** Calendar-day serial number of d's local date (days since 1970-01-01), DST-independent. */
function daySerial(d) {
  return Math.round(utcMidnight(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
}

/** Whole calendar days from a to b (b − a), ignoring time of day; NaN for invalid input. */
export function daysBetween(a, b) {
  const x = toDate(a);
  const y = toDate(b);
  if (!isValidDate(x) || !isValidDate(y)) return NaN;
  return daySerial(y) - daySerial(x);
}

/** 'YYYY-MM-DD' of the local date ('' if invalid). */
export function toYMD(d) {
  const t = toDate(d);
  if (!isValidDate(t)) return '';
  return `${padYear(t.getFullYear())}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`;
}

/** Days in month m (0-based) of year y. */
function daysInMonth(y, m) {
  return new Date(utcMidnight(y, m + 1, 0)).getUTCDate();
}

/** Strict 'YYYY-MM-DD' → local midnight Date; anything else (or an impossible date) → null. */
export function parseYMD(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  if (mo < 0 || mo > 11 || d < 1 || d > daysInMonth(y, mo)) return null;
  return makeLocal(y, mo, d);
}

/** 'HH:MM' (24h, zero-padded) for <input type="time"> ('' if invalid). */
export function toHM(d) {
  const t = toDate(d);
  if (!isValidDate(t)) return '';
  return `${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
}

/**
 * 'H:MM' / 'HH:MM' (optionally ':SS', as some <input type="time"> values have) → minutes since midnight.
 * '24:00' is accepted as 1440 (end of day). Anything else → null.
 */
export function parseHM(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const sec = m[3] === undefined ? 0 : Number(m[3]);
  if (mi > 59 || sec > 59) return null;
  if (h === 24 && mi === 0 && sec === 0) return 1440;
  if (h > 23) return null;
  return h * 60 + mi;
}

/** Wall-clock minutes since local midnight (0–1439); NaN if invalid. */
export function minutesOfDay(d) {
  const t = toDate(d);
  if (!isValidDate(t)) return NaN;
  return t.getHours() * 60 + t.getMinutes();
}

/** Local midnight of `day` + `minutes` of wall-clock time (1440 → next day 00:00). */
export function atMinutes(day, minutes) {
  const t = toDate(day);
  const mins = Number(minutes);
  if (!isValidDate(t) || !Number.isFinite(mins)) return new Date(NaN);
  return makeLocal(t.getFullYear(), t.getMonth(), t.getDate(), 0, Math.round(mins));
}

/**
 * RFC 3339 timestamp with the local UTC offset, e.g. '2026-10-04T09:00:00+09:00'.
 * Milliseconds are dropped. Throws RangeError for an invalid date.
 */
export function toRFC3339(d) {
  const t = toDate(d);
  if (!isValidDate(t)) throw new RangeError('toRFC3339: invalid date');
  const offset = -t.getTimezoneOffset(); // minutes east of UTC
  if (!Number.isInteger(offset)) {
    // Historical local-mean-time offsets have seconds, which RFC 3339 cannot express: use UTC instead.
    return t.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const date = `${padYear(t.getFullYear())}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`;
  const time = `${pad2(t.getHours())}:${pad2(t.getMinutes())}:${pad2(t.getSeconds())}`;
  return `${date}T${time}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** '2026年10月4日(日)' ('' if invalid). */
export function formatDateJa(d) {
  const t = toDate(d);
  if (!isValidDate(t)) return '';
  return `${t.getFullYear()}年${t.getMonth() + 1}月${t.getDate()}日(${WEEKDAYS_JA[t.getDay()]})`;
}

/** '2026年10月' ('' if invalid). */
export function formatMonthJa(d) {
  const t = toDate(d);
  if (!isValidDate(t)) return '';
  return `${t.getFullYear()}年${t.getMonth() + 1}月`;
}

/**
 * Title for a week range [start, endExclusive): the year is written once
 * ('2026年9月27日〜10月3日'), or on both sides when the range crosses a year
 * ('2026年12月28日〜2027年1月3日'). The month is always written on both sides.
 */
export function formatWeekRangeJa(start, endExclusive) {
  const s = toDate(start);
  const e = toDate(endExclusive);
  if (!isValidDate(s)) return '';
  // Last day = the day containing the instant just before the exclusive end.
  let last = isValidDate(e) ? new Date(e.getTime() - 1) : s;
  if (last.getTime() < s.getTime()) last = s;
  const head = `${s.getFullYear()}年${s.getMonth() + 1}月${s.getDate()}日`;
  if (isSameDay(s, last)) return head;
  const tailDay = `${last.getMonth() + 1}月${last.getDate()}日`;
  const tail = last.getFullYear() === s.getFullYear() ? tailDay : `${last.getFullYear()}年${tailDay}`;
  return `${head}〜${tail}`;
}

/** '9:00' (hour not padded; '' if invalid). */
export function formatTimeJa(d) {
  const t = toDate(d);
  if (!isValidDate(t)) return '';
  return `${t.getHours()}:${pad2(t.getMinutes())}`;
}

/** '9:00〜10:30' ('' if either end is invalid). */
export function formatTimeRangeJa(start, end) {
  const a = formatTimeJa(start);
  const b = formatTimeJa(end);
  return a && b ? `${a}〜${b}` : '';
}

/**
 * Rounds minutes to a multiple of `step` (default 15). mode: 'floor' | 'ceil' | 'round' (default).
 * Values within 1e-9 of a multiple count as that multiple, so float noise from y→minutes conversions
 * does not push 'ceil' one step too far. A non-positive or non-finite step returns m unchanged.
 */
export function roundMinutes(m, step = 15, mode = 'round') {
  const v = Number(m);
  const s = Number(step);
  if (!Number.isFinite(v) || !Number.isFinite(s) || s <= 0) return v;
  const q = v / s;
  const nearest = Math.round(q);
  if (Math.abs(q - nearest) < 1e-9) return nearest * s;
  if (mode === 'floor') return Math.floor(q) * s;
  if (mode === 'ceil') return Math.ceil(q) * s;
  return nearest * s;
}

/** Clamps v into [lo, hi] (bounds may be given in either order); NaN → lo. */
export function clamp(v, lo, hi) {
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  if (Number.isNaN(v)) return a;
  return Math.min(Math.max(v, a), b);
}
