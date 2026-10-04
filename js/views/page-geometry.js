// Page geometry: the fixed logical coordinate system ("lu") of each page and the conversions between
// logical positions, columns/cells, minutes and dates. Grid, events and ink all share these
// coordinates, so ink stays aligned regardless of device or orientation. Pure; no DOM access.

import {
  addDays,
  addMonths,
  atMinutes,
  clamp,
  daysBetween,
  isValidDate,
  monthGridStart,
  roundMinutes,
  startOfDay,
  startOfMonth,
  startOfWeek,
  toYMD,
} from '../util/date.js';

export const VIEWS = ['day', 'week', 'month', 'year'];

export const PAGE_SPECS = Object.freeze({
  // day: time labels in [0, gutter); timeline column [gutter, timelineRight); free memo area [timelineRight, W)
  day: Object.freeze({ W: 1000, H: 2400, gutter: 72, hourH: 100, timelineRight: 660, fit: 'width' }),
  // week: col i spans [gutter + i*colW, gutter + (i+1)*colW), colW = (W - gutter) / 7
  week: Object.freeze({ W: 1400, H: 1920, gutter: 64, hourH: 80, cols: 7, fit: 'width' }),
  // month: cell (r, c) = x c*200, y r*175, 200 x 175 (the grid is y < gridH); y in [memoTop, H) is a
  // free memo area (メモ欄) below the grid, part of the same ink page
  month: Object.freeze({ W: 1400, H: 1750, gridH: 1050, memoTop: 1050, cols: 7, rows: 6, fit: 'grid' }),
  // year: day numbers 1..31 in [0, gutter); month m (0 = Jan) is the column [gutter + m*112, gutter + (m+1)*112),
  // day d (1..31) the row [(d-1)*rowH, d*rowH)
  year: Object.freeze({ W: 1400, H: 1860, gutter: 56, cols: 12, rows: 31, rowH: 60, fit: 'width' }),
});

const DAY_MINUTES = 1440;
/** Rects shorter than this are treated as a tap (lu). */
const TAP_MAX_HEIGHT = 12;

const MONTH_CELL_W = PAGE_SPECS.month.W / PAGE_SPECS.month.cols; // 200
// The month grid is gridH tall (NOT H: the memo area below it belongs to no cell).
const MONTH_CELL_H = PAGE_SPECS.month.gridH / PAGE_SPECS.month.rows; // 175
const WEEK_COL_W = (PAGE_SPECS.week.W - PAGE_SPECS.week.gutter) / PAGE_SPECS.week.cols;
const YEAR_COL_W = (PAGE_SPECS.year.W - PAGE_SPECS.year.gutter) / PAGE_SPECS.year.cols; // 112

// ---------------------------------------------------------------------------------------------
// Internal helpers

/** The spec of a view; throws for an unknown view (a programming error, not user input). */
function specOf(view) {
  const spec = Object.hasOwn(PAGE_SPECS, view) ? PAGE_SPECS[view] : null;
  if (!spec) throw new RangeError(`Unknown view: ${String(view)}`);
  return spec;
}

/** The spec of a timeline view (day/week); throws for month or unknown views. */
function timelineSpecOf(view) {
  const spec = specOf(view);
  if (!spec.hourH) throw new RangeError(`View has no timeline: ${String(view)}`);
  return spec;
}

/** Date argument → valid Date (copy); throws a TypeError for anything unusable. */
function requireDate(date) {
  const d = date instanceof Date ? new Date(date.getTime()) : new Date(typeof date === 'number' ? date : NaN);
  if (!isValidDate(d)) throw new TypeError('A valid Date is required');
  return d;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Normalizes a rect so min ≤ max; null if any coordinate is missing or not finite. */
function normalizeRect(rect) {
  if (!rect || typeof rect !== 'object') return null;
  const { minX, minY, maxX, maxY } = rect;
  if (![minX, minY, maxX, maxY].every(isNum)) return null;
  return {
    minX: Math.min(minX, maxX),
    maxX: Math.max(minX, maxX),
    minY: Math.min(minY, maxY),
    maxY: Math.max(minY, maxY),
  };
}

/** The i-th day of a range (range.days[i], or range.start + i days as a fallback); null if unusable. */
function dayOfRange(range, index) {
  if (!range || typeof range !== 'object') return null;
  const fromList = Array.isArray(range.days) ? range.days[index] : undefined;
  if (isValidDate(fromList)) return startOfDay(fromList);
  if (isValidDate(range.start)) return addDays(startOfDay(range.start), index);
  return null;
}

/** Week column for x, falling back to the nearest column (gutter → 0, beyond the page → 6). */
function nearestWeekColumn(x) {
  const { gutter, cols } = PAGE_SPECS.week;
  return clamp(Math.floor((x - gutter) / WEEK_COL_W + 1e-9), 0, cols - 1);
}

/**
 * Core of rectToEventRange/snapEventRect for day/week: which column and which minutes the rect means.
 * @returns {{ col: number, startMin: number, endMin: number }}
 */
function timelineSlotForRect(view, r) {
  const cx = (r.minX + r.maxX) / 2;
  const cy = (r.minY + r.maxY) / 2;

  let col = xToColumn(view, cx);
  if (col === -1) col = view === 'week' ? nearestWeekColumn(cx) : 0;

  let startMin;
  let endMin;
  if (r.maxY - r.minY < TAP_MAX_HEIGHT) {
    // A tap (or a tiny scribble): the half hour under the point, one hour long.
    startMin = roundMinutes(yToMinutes(view, cy), 30, 'floor');
    endMin = startMin + 60;
  } else {
    // Both edges snap to the nearest 15 minutes, so a drag that ends a few lu past (or short of) a line
    // still means that line (e.g. 14:00 → 15:02 is 14:00–15:00, not 15:15).
    startMin = roundMinutes(yToMinutes(view, r.minY), 15, 'round');
    endMin = roundMinutes(yToMinutes(view, r.maxY), 15, 'round');
    if (endMin - startMin < 30) endMin = startMin + 60;
  }
  endMin = Math.min(endMin, DAY_MINUTES);
  // Only possible when the whole rect lies at/below 24:00: keep a one-hour event ending at midnight.
  if (endMin <= startMin) startMin = Math.max(0, endMin - 60);
  return { col, startMin, endMin };
}

/** First of the month a month page shows (range.monthStart, else derived from the grid); null if unusable. */
function monthStartOfRange(range) {
  if (!range || typeof range !== 'object') return null;
  if (isValidDate(range.monthStart)) return startOfMonth(range.monthStart);
  // The grid's first week contains the 1st, so its 7th day always lies in the month.
  const d = dayOfRange(range, 6);
  return d ? startOfMonth(d) : null;
}

/**
 * Grid cell of the day the month page's memo area (メモ欄) stands for: today when today is in that month,
 * else the 1st of the month. null when the range is unusable or that day is not on the grid.
 */
function monthMemoCell(range, now) {
  const first = monthStartOfRange(range);
  const gridStart = dayOfRange(range, 0);
  if (!first || !gridStart) return null;
  const n = isValidDate(now) ? now : new Date();
  const sameMonth = n.getFullYear() === first.getFullYear() && n.getMonth() === first.getMonth();
  const index = daysBetween(gridStart, sameMonth ? n : first);
  const { cols, rows } = PAGE_SPECS.month;
  if (!(index >= 0 && index < cols * rows)) return null;
  return { row: Math.floor(index / cols), col: index % cols };
}

/**
 * Month cell for a rect: the cell under its center, clamped onto the page. A center in the memo area
 * (y ≥ gridH, or below the page) means the memo day's cell (monthMemoCell). null if that is unusable.
 */
function monthCellForRect(r, range, now) {
  const { W, H, gridH } = PAGE_SPECS.month;
  const cx = clamp((r.minX + r.maxX) / 2, 0, W);
  const cy = clamp((r.minY + r.maxY) / 2, 0, H);
  if (cy >= gridH) return monthMemoCell(range, now);
  return monthCellAt(cx, cy);
}

/** Days per month in a leap year: the lengths used when the year is unknown. */
const MAX_MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Number of days of month `month` (0..11) in `year`; without an integer year the leap-year length. */
function monthLength(year, month) {
  if (!Number.isInteger(year)) return MAX_MONTH_DAYS[month];
  const d = new Date(2000, 0, 1);
  d.setFullYear(year, month + 1, 0); // day 0 of the next month = last day of this one (any year)
  return d.getDate();
}

/** Jan 1 (local midnight) of the year a year page shows: range.yearStart, else its first day; null if unusable. */
function yearStartOfRange(range) {
  if (!range || typeof range !== 'object') return null;
  const d = isValidDate(range.yearStart) ? range.yearStart : dayOfRange(range, 0);
  return d ? addMonths(d, -d.getMonth()) : null;
}

/** Local midnight of (month 0..11, day) in the year starting `yearStart`. */
function yearDate(yearStart, month, day) {
  return addDays(addMonths(yearStart, month), day - 1);
}

/**
 * Year cell { month, day } for a rect: the cell under its center, clamped onto the date columns (the gutter
 * → January, below the page → day 31). A date that does not exist (2/30, 4/31…) becomes the month's last
 * day. `year` unknown (null) → February has 29 days.
 */
function yearCellForRect(r, year) {
  const { W, H, gutter } = PAGE_SPECS.year;
  const cx = clamp((r.minX + r.maxX) / 2, gutter, W);
  const cy = clamp((r.minY + r.maxY) / 2, 0, H);
  const cell = yearCellAt(cx, cy);
  return { month: cell.month, day: Math.min(cell.day, monthLength(year, cell.month)) };
}

// ---------------------------------------------------------------------------------------------
// Pages and ranges

/**
 * Stable id of the page showing `date`: 'd-2026-10-04' | 'w-2026-09-27' (week start date) |
 * 'm-2026-10' (Sunday start) / 'm1-2026-10' (Monday start) | 'y-2026'.
 * Week and month ids depend on weekStart because it moves every date of their grid (switching it gives
 * different week/month pages, by design: ink is positioned by grid cell, so it must never be shown on a
 * grid with shifted dates). The year grid (months × days 1..31) does not depend on it.
 */
export function pageIdFor(view, date, weekStart = 0) {
  specOf(view);
  const d = requireDate(date);
  if (view === 'day') return `d-${toYMD(d)}`;
  if (view === 'week') return `w-${toYMD(startOfWeek(d, weekStart))}`;
  if (view === 'year') return `y-${toYMD(d).slice(0, 4)}`;
  // The grid's first weekday, normalized exactly as rangeFor does (0 keeps the original 'm-' ids).
  const gridWeekday = monthGridStart(d, weekStart).getDay();
  return `m${gridWeekday === 0 ? '' : gridWeekday}-${toYMD(startOfMonth(d)).slice(0, -3)}`;
}

/**
 * Dates shown on the page containing `date`.
 * day: 1 day; week: 7 days from startOfWeek; month: 42 days from monthGridStart (+ monthStart);
 * year: every day from Jan 1 to Dec 31 (+ yearStart = Jan 1).
 * @returns {{ start: Date, end: Date, days: Date[], monthStart?: Date, yearStart?: Date }}  end is exclusive
 */
export function rangeFor(view, date, weekStart = 0) {
  specOf(view);
  const d = requireDate(date);
  let start;
  let count;
  if (view === 'year') {
    start = addMonths(d, -d.getMonth());
    const end = addMonths(start, 12);
    const days = Array.from({ length: daysBetween(start, end) }, (_, i) => addDays(start, i));
    return { start, end, days, yearStart: new Date(start.getTime()) };
  }
  if (view === 'day') {
    start = startOfDay(d);
    count = 1;
  } else if (view === 'week') {
    start = startOfWeek(d, weekStart);
    count = 7;
  } else {
    start = monthGridStart(d, weekStart);
    count = PAGE_SPECS.month.cols * PAGE_SPECS.month.rows;
  }
  const days = Array.from({ length: count }, (_, i) => addDays(start, i));
  const range = { start, end: addDays(start, count), days };
  if (view === 'month') range.monthStart = startOfMonth(d);
  return range;
}

/**
 * The date `delta` pages away: day ±1 day, week ±7 days (same weekday), month ±1 month (the 1st),
 * year ±1 year (Jan 1). Results are local midnight.
 */
export function navigate(view, date, delta) {
  specOf(view);
  const d = requireDate(date);
  const n = Number.isFinite(Number(delta)) ? Math.trunc(Number(delta)) : 0;
  if (view === 'day') return addDays(startOfDay(d), n);
  if (view === 'week') return addDays(startOfDay(d), 7 * n);
  if (view === 'year') return addMonths(d, 12 * n - d.getMonth());
  return addMonths(d, n);
}

// ---------------------------------------------------------------------------------------------
// Timeline (day/week)

/** Minutes since midnight → logical y (day/week only; not clamped). */
export function minutesToY(view, minutes) {
  return (Number(minutes) * timelineSpecOf(view).hourH) / 60;
}

/** Logical y → minutes since midnight, clamped to [0, 1440] (day/week only). NaN y → 0. */
export function yToMinutes(view, y) {
  return clamp((Number(y) * 60) / timelineSpecOf(view).hourH, 0, DAY_MINUTES);
}

/**
 * Horizontal extent of a column: { x, w }, or null for a column that does not exist.
 * day: col 0 = the timeline column; week: day columns 0..6; month: grid columns 0..6;
 * year: month columns 0..11.
 */
export function columnRect(view, col) {
  const spec = specOf(view);
  if (!Number.isInteger(col) || col < 0) return null;
  if (view === 'day') {
    return col === 0 ? { x: spec.gutter, w: spec.timelineRight - spec.gutter } : null;
  }
  if (col >= spec.cols) return null;
  if (view === 'week') return { x: spec.gutter + col * WEEK_COL_W, w: WEEK_COL_W };
  if (view === 'year') return { x: spec.gutter + col * YEAR_COL_W, w: YEAR_COL_W };
  return { x: col * MONTH_CELL_W, w: MONTH_CELL_W };
}

/**
 * Column under logical x, or -1.
 * day: 0 inside the timeline [gutter, timelineRight), -1 in the gutter or the memo area.
 * week / year: 0..6 / 0..11, -1 in the gutter or outside the page (x === W counts as the last column).
 * month: 0..6 or -1 outside the page.
 */
export function xToColumn(view, x) {
  const spec = specOf(view);
  if (!isNum(x)) return -1;
  if (view === 'day') return x >= spec.gutter && x < spec.timelineRight ? 0 : -1;
  if (view === 'week' || view === 'year') {
    if (x < spec.gutter || x > spec.W) return -1;
    // The epsilon makes columnRect(view, i).x map back to i despite float rounding of colW.
    const colW = view === 'week' ? WEEK_COL_W : YEAR_COL_W;
    return Math.min(spec.cols - 1, Math.floor((x - spec.gutter) / colW + 1e-9));
  }
  if (x < 0 || x > spec.W) return -1;
  return Math.min(spec.cols - 1, Math.floor(x / MONTH_CELL_W));
}

// ---------------------------------------------------------------------------------------------
// Month grid (y < gridH; the memo area below it belongs to no cell)

/** Logical rect { x, y, w, h } of month cell (row 0..5, col 0..6); null if out of range. */
export function monthCellRect(row, col) {
  const { rows, cols } = PAGE_SPECS.month;
  if (!Number.isInteger(row) || !Number.isInteger(col)) return null;
  if (row < 0 || row >= rows || col < 0 || col >= cols) return null;
  return { x: col * MONTH_CELL_W, y: row * MONTH_CELL_H, w: MONTH_CELL_W, h: MONTH_CELL_H };
}

/**
 * Month cell { row, col } containing the logical point, or null outside the grid (outside the page, or in
 * the memo area y ≥ gridH). Cells are half-open; the page's right edge belongs to the last column.
 */
export function monthCellAt(x, y) {
  const { W, gridH, rows, cols } = PAGE_SPECS.month;
  if (!isNum(x) || !isNum(y) || x < 0 || y < 0 || x > W || y >= gridH) return null;
  return {
    row: Math.min(rows - 1, Math.floor(y / MONTH_CELL_H)),
    col: Math.min(cols - 1, Math.floor(x / MONTH_CELL_W)),
  };
}

// ---------------------------------------------------------------------------------------------
// Year grid (12 month columns × day rows 1..31)

/**
 * Logical rect { x, y, w, h } of the year cell of month `monthIndex` (0 = January .. 11) and day 1..31;
 * null if out of range. Geometry only: dates that do not exist (2/30, 4/31…) have a (hatched) cell too.
 */
export function yearCellRect(monthIndex, day) {
  const { gutter, cols, rows, rowH } = PAGE_SPECS.year;
  if (!Number.isInteger(monthIndex) || !Number.isInteger(day)) return null;
  if (monthIndex < 0 || monthIndex >= cols || day < 1 || day > rows) return null;
  return { x: gutter + monthIndex * YEAR_COL_W, y: (day - 1) * rowH, w: YEAR_COL_W, h: rowH };
}

/**
 * Year cell { month (0..11), day (1..31), valid } containing the logical point, or null in the day-number
 * gutter or outside the page. Cells are half-open; the page's right/bottom edges belong to the last
 * column/row. valid: the date exists — false for 2/30, 4/31…; 2/29 depends on `year` (an integer year;
 * without one it counts as valid, as in leap years).
 * @returns {{ month: number, day: number, valid: boolean } | null}
 */
export function yearCellAt(x, y, year = null) {
  const { W, H, gutter, cols, rows, rowH } = PAGE_SPECS.year;
  if (!isNum(x) || !isNum(y) || x < gutter || y < 0 || x > W || y > H) return null;
  const month = Math.min(cols - 1, Math.floor((x - gutter) / YEAR_COL_W + 1e-9));
  const day = Math.min(rows, Math.floor(y / rowH) + 1);
  return { month, day, valid: day <= monthLength(year, month) };
}

// ---------------------------------------------------------------------------------------------
// Rect / point → event time

/**
 * Converts a logical rect (lasso bbox or 予定-tool drag rect) into { start, end, allDay }.
 * day/week: column under the rect's center (day: timeline even when outside it; week: nearest column
 *   when in the gutter); start = round15(minY), end = round15(maxY) (nearest 15 min, so a drag that
 *   overshoots a line slightly still ends on it); shorter than 30 min → 1 hour;
 *   rect height < 12 lu (a tap) → the half hour under the center, 1 hour long; end ≤ 24:00.
 * month: an all-day event on the cell under the rect's center; a center in the memo area (y ≥ gridH)
 *   means today when today is in that month, else the 1st of the month.
 * year: an all-day event on the cell under the rect's center (gutter → January); a date that does not
 *   exist (2/30, 4/31…) becomes the month's last day.
 * `now` (default: the current time) only decides the month memo area's day.
 * Returns null for a malformed rect or range.
 * @returns {{ start: Date, end: Date, allDay: boolean } | null}
 */
export function rectToEventRange(view, range, rect, now = new Date()) {
  specOf(view);
  const r = normalizeRect(rect);
  if (!r) return null;

  if (view === 'month') {
    const cell = monthCellForRect(r, range, now);
    const day = cell && dayOfRange(range, cell.row * PAGE_SPECS.month.cols + cell.col);
    if (!day) return null;
    return { start: day, end: addDays(day, 1), allDay: true };
  }

  if (view === 'year') {
    const yearStart = yearStartOfRange(range);
    if (!yearStart) return null;
    const cell = yearCellForRect(r, yearStart.getFullYear());
    const day = yearDate(yearStart, cell.month, cell.day);
    return { start: day, end: addDays(day, 1), allDay: true };
  }

  const { col, startMin, endMin } = timelineSlotForRect(view, r);
  const day = dayOfRange(range, view === 'day' ? 0 : col);
  if (!day) return null;
  return { start: atMinutes(day, startMin), end: atMinutes(day, endMin), allDay: false };
}

/**
 * The logical rect the event from rectToEventRange(view, range, rect) would occupy (live preview of
 * the 予定 tool). day/week: the column × the snapped minutes; month: the cell (for the memo area: the memo
 * day's cell); year: the cell of the event's date. null if malformed (or, for the month memo area, when
 * the range is unusable). Otherwise the geometry does not depend on `range` (year: only for 2/29).
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number } | null}
 */
export function snapEventRect(view, range, rect, now = new Date()) {
  specOf(view);
  const r = normalizeRect(rect);
  if (!r) return null;

  if (view === 'month') {
    const cell = monthCellForRect(r, range, now);
    const c = cell && monthCellRect(cell.row, cell.col);
    if (!c) return null;
    return { minX: c.x, minY: c.y, maxX: c.x + c.w, maxY: c.y + c.h };
  }

  if (view === 'year') {
    const yearStart = yearStartOfRange(range);
    const cell = yearCellForRect(r, yearStart ? yearStart.getFullYear() : null);
    const c = yearCellRect(cell.month, cell.day);
    return { minX: c.x, minY: c.y, maxX: c.x + c.w, maxY: c.y + c.h };
  }

  const { col, startMin, endMin } = timelineSlotForRect(view, r);
  const c = columnRect(view, col);
  return {
    minX: c.x,
    maxX: c.x + c.w,
    minY: minutesToY(view, startMin),
    maxY: minutesToY(view, endMin),
  };
}

/**
 * The slot under a logical point: { date, minutes } for day/week (minutes floored to 15),
 * { date, minutes: null } for month (memo area: the memo day, see rectToEventRange) and year (a date that
 * does not exist → the month's last day); null outside the timeline / grid (year: in the day-number
 * gutter) or for bad input.
 * @returns {{ date: Date, minutes: number|null } | null}
 */
export function pointToSlot(view, range, x, y, now = new Date()) {
  const spec = specOf(view);
  if (!isNum(x) || !isNum(y) || y < 0 || y > spec.H) return null;

  if (view === 'month') {
    if (x < 0 || x > spec.W) return null;
    const cell = y >= spec.gridH ? monthMemoCell(range, now) : monthCellAt(x, y);
    const date = cell && dayOfRange(range, cell.row * spec.cols + cell.col);
    return date ? { date, minutes: null } : null;
  }

  if (view === 'year') {
    const yearStart = yearStartOfRange(range);
    const cell = yearStart && yearCellAt(x, y);
    if (!cell) return null;
    const day = Math.min(cell.day, monthLength(yearStart.getFullYear(), cell.month));
    return { date: yearDate(yearStart, cell.month, day), minutes: null };
  }

  const col = xToColumn(view, x);
  if (col === -1) return null;
  const date = dayOfRange(range, col);
  if (!date) return null;
  const minutes = Math.min(roundMinutes(yToMinutes(view, y), 15, 'floor'), DAY_MINUTES - 15);
  return { date, minutes };
}
