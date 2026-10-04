// Japanese national holidays (国民の祝日・休日), rule-based, valid for 2000–2099.
//
// Verified against the 内閣府 syukujitsu.csv for 2000–2027 (0 mismatches) and the NAOJ equinox
// prediction table for 2020–2050. Years outside 2000–2099 return no holidays rather than guesses.
//
// Internally everything is keyed by 'YYYY-MM-DD' strings and computed with UTC arithmetic, so the
// result never depends on the device time zone. Public functions accept local Dates (their local
// y/m/d is used, matching how the calendar pages are laid out) or 'YYYY-MM-DD' strings.
//
// Labels: 第3条第2項 days are named 「振替休日」 and 第3条第3項 days 「国民の休日」 (the CSV says just 「休日」).
// Future special laws (like the 2019–2021 moves) belong in specialDays() so the 第3条 rules see them.

import { isValidDate, parseYMD, toYMD } from './date.js';

const MIN_YEAR = 2000;
const MAX_YEAR = 2099;

const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
/** Day of week (0 = Sunday) of a Gregorian date, time-zone independent. */
const dow = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
/** Day-of-month of the n-th Monday of month m. */
const nthMonday = (y, m, n) => 1 + ((8 - dow(y, m, 1)) % 7) + (n - 1) * 7;
const shiftYMD = (s, k) => {
  const t = new Date(`${s}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + k);
  return t.toISOString().slice(0, 10);
};
const isSundayYMD = (s) => new Date(`${s}T00:00:00Z`).getUTCDay() === 0;

// Equinox days (traditional formula, valid 1980–2099). Official dates are fixed each February by the
// NAOJ 暦要項 for the following year; the formula matches every published/predicted date 2000–2050.
const vernalEquinoxDay = (y) => Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
const autumnalEquinoxDay = (y) => Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));

/**
 * 国民の祝日 (祝日法 第2条, plus days a special law treats as 祝日) of year y.
 * @returns {Map<string, string>}
 */
function shukujitsu(y) {
  const h = new Map();
  const add = (m, d, name) => h.set(ymd(y, m, d), name);

  add(1, 1, '元日');
  add(1, nthMonday(y, 1, 2), '成人の日');
  add(2, 11, '建国記念の日');
  if (y >= 2020) add(2, 23, '天皇誕生日');
  add(3, vernalEquinoxDay(y), '春分の日');
  if (y >= 2007) {
    add(4, 29, '昭和の日');
    add(5, 4, 'みどりの日');
  } else {
    add(4, 29, 'みどりの日');
  }
  add(5, 3, '憲法記念日');
  add(5, 5, 'こどもの日');
  if (y >= 2003) add(7, nthMonday(y, 7, 3), '海の日');
  else add(7, 20, '海の日');
  if (y >= 2016) add(8, 11, '山の日');
  if (y >= 2003) add(9, nthMonday(y, 9, 3), '敬老の日');
  else add(9, 15, '敬老の日');
  add(9, autumnalEquinoxDay(y), '秋分の日');
  add(10, nthMonday(y, 10, 2), y >= 2020 ? 'スポーツの日' : '体育の日');
  add(11, 3, '文化の日');
  add(11, 23, '勤労感謝の日');
  if (y <= 2018) add(12, 23, '天皇誕生日');

  applySpecialDays(y, h);
  return h;
}

/**
 * One-off changes made by special laws. `move` relocates a regular holiday (by name) within the year;
 * `add` inserts a day that counts as a 祝日 for 第3条 (振替休日 / 国民の休日).
 */
function specialDays(y) {
  switch (y) {
    case 2019: // 天皇の即位の日及び即位礼正殿の儀の行われる日を休日とする法律
      return { add: [[5, 1, '即位の日'], [10, 22, '即位礼正殿の儀']] };
    case 2020: // 東京オリンピック・パラリンピック特措法（平成30年法律第55号）
      return { move: [['海の日', 7, 23], ['スポーツの日', 7, 24], ['山の日', 8, 10]] };
    case 2021: // 同改正（令和2年法律第68号）
      return { move: [['海の日', 7, 22], ['スポーツの日', 7, 23], ['山の日', 8, 8]] };
    default:
      return null;
  }
}

function applySpecialDays(y, h) {
  const special = specialDays(y);
  if (!special) return;
  for (const [name, m, d] of special.move ?? []) {
    for (const [key, n] of h) if (n === name) h.delete(key);
    h.set(ymd(y, m, d), name);
  }
  for (const [m, d, name] of special.add ?? []) h.set(ymd(y, m, d), name);
}

const yearCache = new Map();

/**
 * All 祝日・休日 of year y as a Map 'YYYY-MM-DD' → name, sorted by date (cached).
 * Empty for years outside 2000–2099.
 * @returns {Map<string, string>}
 */
function holidaysOfYear(y) {
  if (yearCache.has(y)) return yearCache.get(y);
  const out = new Map();
  if (Number.isInteger(y) && y >= MIN_YEAR && y <= MAX_YEAR) {
    const base = shukujitsu(y);
    for (const [k, v] of base) out.set(k, v);
    addSubstituteHolidays(y, base, out);
    addCitizensHolidays(y, base, out);
  }
  const sorted = new Map([...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  yearCache.set(y, sorted);
  return sorted;
}

/** 第3条第2項 振替休日: a 祝日 on Sunday makes the nearest following non-祝日 day a holiday. */
function addSubstituteHolidays(y, base, out) {
  for (const d of base.keys()) {
    if (!isSundayYMD(d)) continue;
    if (y >= 2007) {
      let n = shiftYMD(d, 1);
      while (base.has(n)) n = shiftYMD(n, 1);
      out.set(n, '振替休日');
    } else {
      // Before 2007 only the next day (Monday) qualified, and only if it was not itself a 祝日.
      const n = shiftYMD(d, 1);
      if (!base.has(n)) out.set(n, '振替休日');
    }
  }
}

/** 第3条第3項 国民の休日: a non-祝日 day sandwiched between two 祝日. */
function addCitizensHolidays(y, base, out) {
  for (const d of base.keys()) {
    const mid = shiftYMD(d, 1);
    const next = shiftYMD(d, 2);
    if (base.has(mid) || !base.has(next) || out.has(mid)) continue;
    if (y < 2007 && isSundayYMD(mid)) continue; // the pre-2007 wording excluded Sundays
    out.set(mid, '国民の休日');
  }
}

/** Normalizes a Date (local y/m/d) or 'YYYY-MM-DD' string into a key; null if unusable. */
function toKey(dateOrYMD) {
  if (typeof dateOrYMD === 'string') {
    const d = parseYMD(dateOrYMD);
    return d ? toYMD(d) : null;
  }
  if (isValidDate(dateOrYMD)) return toYMD(dateOrYMD);
  return null;
}

/** Converts a range bound (Date or 'YYYY-MM-DD') into a Date; null if unusable. */
function toBound(v) {
  if (typeof v === 'string') return parseYMD(v);
  return isValidDate(v) ? v : null;
}

/**
 * Holiday name of a date, e.g. '元日', '振替休日', '国民の休日'; null if it is not a holiday
 * (or the input is invalid / outside 2000–2099).
 * @param {Date|string} dateOrYMD  a Date (its LOCAL calendar date is used) or 'YYYY-MM-DD'
 * @returns {string|null}
 */
export function getHolidayName(dateOrYMD) {
  const key = toKey(dateOrYMD);
  if (!key) return null;
  return holidaysOfYear(Number(key.slice(0, 4))).get(key) ?? null;
}

/**
 * Holidays on the local days overlapping [start, endExclusive), sorted by date.
 * Bounds may be Dates or 'YYYY-MM-DD' strings (local midnight).
 * @returns {{ date: string, name: string }[]}
 */
export function getHolidaysInRange(start, endExclusive) {
  const s = toBound(start);
  const e = toBound(endExclusive);
  if (!s || !e || e.getTime() <= s.getTime()) return [];
  const lastDay = new Date(e.getTime() - 1); // the day containing the last instant of the range
  const y0 = Math.max(MIN_YEAR, s.getFullYear());
  const y1 = Math.min(MAX_YEAR, lastDay.getFullYear());
  // Keys outside the supported years are clamped so plain string comparison stays valid.
  const firstKey = s.getFullYear() < MIN_YEAR ? `${MIN_YEAR}-01-01` : toYMD(s);
  const lastKey = lastDay.getFullYear() > MAX_YEAR ? `${MAX_YEAR}-12-31` : toYMD(lastDay);
  const result = [];
  for (let y = y0; y <= y1; y++) {
    for (const [date, name] of holidaysOfYear(y)) {
      if (date >= firstKey && date <= lastKey) result.push({ date, name });
    }
  }
  return result;
}
