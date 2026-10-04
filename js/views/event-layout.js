// Event layout: which events fall on a day, side-by-side columns for overlapping timed events, and
// rows for all-day events in the week header. Pure; works on CalEvent objects (see SPEC §2).
//
// Conventions:
//   - an event occupies [start, end); back-to-back events (A.end === B.start) do not overlap;
//   - a zero-length (or inverted) event occupies the instant `start` and belongs to the day containing it;
//   - entries without a valid start/end are ignored instead of throwing.

import { addDays, daysBetween, isValidDate, minutesOfDay, startOfDay } from '../util/date.js';

const DAY_MINUTES = 1440;
/** Minimum visual height of a timed event box, in minutes. */
const MIN_VISUAL_MINUTES = 15;

/** Epoch ms of a Date (or a number); NaN for anything else. */
function timeOf(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  return NaN;
}

/** True if ev looks like an event with usable start/end. */
function isUsableEvent(ev) {
  return !!ev && typeof ev === 'object'
    && Number.isFinite(timeOf(ev.start)) && Number.isFinite(timeOf(ev.end));
}

/** Does ev intersect the half-open interval [a, b) (epoch ms)? */
function overlapsInterval(ev, a, b) {
  const s = timeOf(ev.start);
  const e = timeOf(ev.end);
  if (e <= s) return s >= a && s < b; // zero-length / inverted: the instant `start`
  return s < b && e > a;
}

const titleOf = (ev) => (typeof ev.title === 'string' ? ev.title : '');
const idOf = (ev) => (ev.id == null ? '' : String(ev.id));
const durationOf = (ev) => Math.max(0, timeOf(ev.end) - timeOf(ev.start));

const collator = new Intl.Collator('ja');

/** Final tie-breakers shared by all orderings: title (Japanese collation), then id for stability. */
function compareTitleThenId(a, b) {
  return collator.compare(titleOf(a), titleOf(b)) || (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0);
}

/** allDay first, then start, then longer first, then title. */
function compareEvents(a, b) {
  return (Number(!!b.allDay) - Number(!!a.allDay))
    || (timeOf(a.start) - timeOf(b.start))
    || (durationOf(b) - durationOf(a))
    || compareTitleThenId(a, b);
}

/** [dayStart, dayEnd) in epoch ms for the local day containing `day`; null if invalid. */
function dayBounds(day) {
  const start = startOfDay(day);
  if (!isValidDate(start)) return null;
  return { startMs: start.getTime(), endMs: addDays(start, 1).getTime() };
}

/**
 * Events overlapping the local day [day, day + 1), sorted: all-day first, then by start,
 * then longer first, then title.
 * @param {object[]} events  CalEvent[]
 * @param {Date} day
 * @returns {object[]}
 */
export function eventsOnDay(events, day) {
  const b = dayBounds(day);
  if (!b || !Array.isArray(events)) return [];
  return events
    .filter((ev) => isUsableEvent(ev) && overlapsInterval(ev, b.startMs, b.endMs))
    .sort(compareEvents);
}

/**
 * Visual minutes [startMin, endMin] of a timed event on the day, clipped to [0, 1440] and at least
 * MIN_VISUAL_MINUTES tall. Minutes are wall-clock (they match the hour grid, also on DST days).
 * Near midnight the 15-minute minimum is kept by moving the start up rather than overflowing 24:00.
 */
function visualMinutes(ev, b) {
  const s = timeOf(ev.start);
  const e = timeOf(ev.end);
  let startMin = s <= b.startMs ? 0 : minutesOfDay(s);
  let endMin;
  if (e >= b.endMs) endMin = DAY_MINUTES;
  else if (e <= s) endMin = startMin;
  else endMin = minutesOfDay(e);
  endMin = Math.max(endMin, startMin); // guards against wall-clock oddities on DST days
  if (endMin - startMin < MIN_VISUAL_MINUTES) {
    endMin = Math.min(DAY_MINUTES, startMin + MIN_VISUAL_MINUTES);
    startMin = Math.min(startMin, endMin - MIN_VISUAL_MINUTES);
  }
  return { startMin, endMin };
}

/**
 * Lays out the timed (non-all-day) events overlapping `day`:
 * → [{ event, startMin, endMin, col, cols }] in display order.
 * Overlap is judged on the visual minutes, so boxes never collide on screen. Each cluster of
 * transitively overlapping events is packed greedily into columns (by start, then longer first);
 * `cols` is the number of columns used by that event's cluster.
 * @param {object[]} events  CalEvent[]
 * @param {Date} day
 */
export function layoutTimedEvents(events, day) {
  const b = dayBounds(day);
  if (!b || !Array.isArray(events)) return [];

  const items = events
    .filter((ev) => isUsableEvent(ev) && !ev.allDay && overlapsInterval(ev, b.startMs, b.endMs))
    .map((event) => ({ event, ...visualMinutes(event, b), col: 0, cols: 1 }))
    .sort((p, q) => (p.startMin - q.startMin)
      || (q.endMin - p.endMin)
      || (timeOf(p.event.start) - timeOf(q.event.start))
      || compareTitleThenId(p.event, q.event));

  let cluster = [];
  let columnEnds = []; // per column: endMin of the last item placed in it
  let clusterEnd = -Infinity; // max endMin within the current cluster
  const closeCluster = () => {
    for (const it of cluster) it.cols = columnEnds.length;
    cluster = [];
    columnEnds = [];
    clusterEnd = -Infinity;
  };

  for (const it of items) {
    // Items are sorted by start, so one that starts after everything so far ends a cluster.
    if (cluster.length && it.startMin >= clusterEnd) closeCluster();
    let col = columnEnds.findIndex((end) => end <= it.startMin);
    if (col === -1) {
      col = columnEnds.length;
      columnEnds.push(it.endMin);
    } else {
      columnEnds[col] = it.endMin;
    }
    it.col = col;
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.endMin);
  }
  if (cluster.length) closeCluster();
  return items;
}

/**
 * Splits events into all-day and timed lists, keeping their order. Unusable entries are dropped.
 * @returns {{ allDay: object[], timed: object[] }}
 */
export function splitAllDay(events) {
  const allDay = [];
  const timed = [];
  if (Array.isArray(events)) {
    for (const ev of events) {
      if (!isUsableEvent(ev)) continue;
      (ev.allDay ? allDay : timed).push(ev);
    }
  }
  return { allDay, timed };
}

/**
 * Lays out all-day events (only allDay ones; long timed events stay in the timeline) over the
 * consecutive `days` of a week header: → [{ event, startCol, endCol, row }], endCol inclusive,
 * columns clipped to the range. Events are placed longest-first within the same start column, each in
 * the lowest row free over its whole span. Sorted by row, then startCol.
 * @param {object[]} events  CalEvent[]
 * @param {Date[]} days  consecutive local days (e.g. the 7 days of a week)
 */
export function allDayRowsForRange(events, days) {
  if (!Array.isArray(events) || !Array.isArray(days) || days.length === 0) return [];
  const first = startOfDay(days[0]);
  if (!isValidDate(first)) return [];
  const lastCol = days.length - 1;
  const rangeStartMs = first.getTime();
  const rangeEndMs = addDays(first, days.length).getTime();

  const spans = [];
  for (const event of events) {
    if (!isUsableEvent(event) || !event.allDay) continue;
    if (!overlapsInterval(event, rangeStartMs, rangeEndMs)) continue;
    const s = timeOf(event.start);
    const e = timeOf(event.end);
    const startCol = Math.max(0, daysBetween(first, new Date(s)));
    // The last day is the one containing the instant just before the exclusive end.
    const endCol = e <= s ? startCol : Math.min(lastCol, daysBetween(first, new Date(e - 1)));
    spans.push({ event, startCol, endCol: Math.max(startCol, endCol), row: 0 });
  }

  spans.sort((p, q) => (p.startCol - q.startCol)
    || ((q.endCol - q.startCol) - (p.endCol - p.startCol))
    || compareEvents(p.event, q.event));

  const rowEnds = []; // per row: endCol of the last span placed in it
  for (const sp of spans) {
    let row = rowEnds.findIndex((end) => end < sp.startCol);
    if (row === -1) row = rowEnds.length;
    rowEnds[row] = sp.endCol;
    sp.row = row;
  }
  return spans.sort((p, q) => (p.row - q.row) || (p.startCol - q.startCol));
}
