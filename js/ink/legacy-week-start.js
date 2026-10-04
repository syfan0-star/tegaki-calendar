// Carries handwriting from the old Sunday-start week and month pages onto the Monday-start pages.
//
// Until 1.0.4 a week could start on Sunday ('w-<sunday>' pages, 'm-YYYY-MM' month grids). The week now
// always starts on Monday, which moves every date of those grids, so the old pages are no longer shown.
// Their strokes are copied — moved by whole columns / cells so they stay on the same date — into the
// Monday-start page that now shows that date. Every stroke of an old page lands on exactly one new page.
//
// Copies get deterministic ids (old id + SUFFIX): running the copy again (another visit, another device)
// adds nothing twice, and a copy erased on the new page stays erased (its id is tombstoned there).
// A stroke erased (or moved, which is erase + add) on an old page afterwards — e.g. by a device still on
// an older version — erases its copy too (mergeLegacyInk), so a copy made from an out-of-date old page
// never brings back handwriting erased elsewhere.
// Strokes are assigned by the centre of their bounding box; strokes outside the date grid (the week's
// time gutter, beyond the page) keep their position on the page that takes over most of the old one.

import { PAGE_SPECS } from '../views/page-geometry.js';
import { addDays, addMonths, daysBetween, monthGridStart, parseYMD, toYMD } from '../util/date.js';
import { strokeBBox } from './geometry.js';
import { addStrokes, liveStrokes, removeStrokes } from './model.js';

export const LEGACY_SUFFIX = '~w1';
const MAX_ID_LENGTH = 128;

/** kv key prefix of the per-page "copied" flags (account data: cleared on sign-out). */
export const LEGACY_DONE_PREFIX = 'legacyWeekStart:';

/**
 * Until this moment (local 2026-12-01 00:00) the copy runs on every visit, whatever the flag says: devices
 * still on an older version may keep writing on the old pages for a while, and re-running is idempotent.
 */
export const LEGACY_RECHECK_UNTIL = new Date(2026, 11, 1);

const WEEK = PAGE_SPECS.week;
const WEEK_COL_W = (WEEK.W - WEEK.gutter) / WEEK.cols;
const MONTH = PAGE_SPECS.month;
const MONTH_CELLS = MONTH.cols * MONTH.rows;
const CELL_W = MONTH.W / MONTH.cols;
const CELL_H = MONTH.H / MONTH.rows;

/**
 * kv key marking `pageId` as copied. 'v2': flags written by the first 1.0.4 build (which could drop or
 * resurrect strokes) do not count. Starts with LEGACY_DONE_PREFIX.
 */
export function legacyDoneKey(pageId) {
  return `${LEGACY_DONE_PREFIX}v2:${pageId}`;
}

/** Whether a stored "copied" flag may skip the copy at `now` (false until LEGACY_RECHECK_UNTIL). */
export function legacyDoneFlagCounts(now = Date.now()) {
  const t = now instanceof Date ? now.getTime() : Number(now);
  return Number.isFinite(t) && t >= LEGACY_RECHECK_UNTIL.getTime();
}

/** 'w-YYYY-MM-DD' (a Monday) → Date, else null. */
function mondayOf(pageId) {
  const m = /^w-(\d{4}-\d{2}-\d{2})$/.exec(String(pageId));
  const d = m ? parseYMD(m[1]) : null;
  return d && d.getDay() === 1 ? d : null;
}

/** 'm1-YYYY-MM' (Monday-start month) → first of the month, else null. */
function monthOf(pageId) {
  const m = /^m1-(\d{4})-(\d{2})$/.exec(String(pageId));
  return m ? parseYMD(`${m[1]}-${m[2]}-01`) : null;
}

/** 'm-YYYY-MM' (old Sunday-start month) → first of the month, else null. */
function oldMonthOf(sourceId) {
  const m = /^m-(\d{4})-(\d{2})$/.exec(String(sourceId));
  return m ? parseYMD(`${m[1]}-${m[2]}-01`) : null;
}

const oldMonthId = (first) => `m-${toYMD(first).slice(0, 7)}`;

/**
 * The old pages whose strokes belong (partly) on `pageId`.
 * Week (Monday d): the Sunday week starting d−1 gives Mon–Sat, the one starting d+6 gives the Sunday.
 * Month X: the Sunday-start grid of X, and of the months before and after (their dates that the new grid
 * of their own month no longer shows).
 * @returns {string[]}
 */
export function legacySourcesFor(pageId) {
  const monday = mondayOf(pageId);
  if (monday) return [`w-${toYMD(addDays(monday, -1))}`, `w-${toYMD(addDays(monday, 6))}`];
  const first = monthOf(pageId);
  if (first) return [oldMonthId(first), oldMonthId(addMonths(first, -1)), oldMonthId(addMonths(first, 1))];
  return [];
}

/** Week column of x on the old page: −1 in the time gutter, else 0..6 (clamped). */
function weekColumn(x) {
  if (x < WEEK.gutter) return -1;
  return Math.min(WEEK.cols - 1, Math.max(0, Math.floor((x - WEEK.gutter) / WEEK_COL_W)));
}

/**
 * Offset to apply to a stroke of the old Sunday-week page `sourceId` for the Monday page starting
 * `monday`, or null when the stroke belongs to another page.
 */
function weekOffset(sourceId, monday, center) {
  const col = weekColumn(center.x);
  if (sourceId === `w-${toYMD(addDays(monday, -1))}`) {
    if (col === -1) return { dx: 0, dy: 0 }; // gutter notes stay with the Mon–Sat part
    return col >= 1 ? { dx: -WEEK_COL_W, dy: 0 } : null; // its Sunday (col 0) is the previous week's
  }
  return col === 0 ? { dx: (WEEK.cols - 1) * WEEK_COL_W, dy: 0 } : null; // the Sunday → last column
}

/** Cell index of `date` on the Monday-start grid of the month starting `first`, or −1 when not on it. */
function newGridIndex(first, date) {
  const idx = daysBetween(monthGridStart(first, 1), date);
  return idx >= 0 && idx < MONTH_CELLS ? idx : -1;
}

/**
 * Offset for a stroke of the old Sunday-start grid of `sourceFirst` on the Monday-start grid of `first`,
 * or null when the stroke belongs to another page. A cell's date D goes to the new grid of its own old
 * month when that grid shows D, else to the neighbouring month's new grid that does (exactly one does).
 * Strokes outside the grid stay, unmoved, with the same month.
 */
function monthOffset(first, sourceFirst, center) {
  const sameMonth = daysBetween(first, sourceFirst) === 0;
  const col = Math.floor(center.x / CELL_W);
  const row = Math.floor(center.y / CELL_H);
  if (!(col >= 0 && col < MONTH.cols && row >= 0 && row < MONTH.rows)) return sameMonth ? { dx: 0, dy: 0 } : null;
  const date = addDays(monthGridStart(sourceFirst, 0), row * MONTH.cols + col);
  const idx = newGridIndex(first, date);
  if (idx < 0) return null; // not on this page's grid
  if (!sameMonth && newGridIndex(sourceFirst, date) >= 0) return null; // its own month's page shows it
  return {
    dx: ((idx % MONTH.cols) - col) * CELL_W,
    dy: (Math.floor(idx / MONTH.cols) - row) * CELL_H,
  };
}

function copyId(id) {
  const base = String(id);
  return base.length + LEGACY_SUFFIX.length <= MAX_ID_LENGTH
    ? base + LEGACY_SUFFIX
    : base.slice(0, MAX_ID_LENGTH - LEGACY_SUFFIX.length) + LEGACY_SUFFIX;
}

/**
 * Shift along one axis, limited so that a stroke lying within [0, size] stays within it (a line drawn
 * from Sunday into Monday must not be pushed off the page). A stroke already (partly) off the page is
 * moved as it is.
 */
function fitShift(shift, min, max, size) {
  if (!(min >= 0 && max <= size)) return shift;
  return Math.min(size - max, Math.max(-min, shift));
}

function moved(stroke, bbox, off, spec) {
  const dx = fitShift(off.dx, bbox.minX, bbox.maxX, spec.W);
  const dy = fitShift(off.dy, bbox.minY, bbox.maxY, spec.H);
  const pts = stroke.pts.slice();
  for (let i = 0; i + 1 < pts.length; i += 3) {
    pts[i] = Math.round((pts[i] + dx) * 10) / 10;
    pts[i + 1] = Math.round((pts[i + 1] + dy) * 10) / 10;
  }
  return { ...stroke, id: copyId(stroke.id), pts };
}

function docGetter(sourceDocs) {
  return (id) => {
    const doc = sourceDocs instanceof Map ? sourceDocs.get(id) : sourceDocs?.[id];
    return doc && typeof doc === 'object' ? doc : null;
  };
}

/**
 * Copies of the old pages' live strokes that belong on `pageId`, moved onto the new grid.
 * @param {string} pageId  a Monday-start week ('w-<monday>') or month ('m1-YYYY-MM') page
 * @param {Map<string, object>|Record<string, object>} sourceDocs  PageDoc per legacySourcesFor() id
 * @returns {object[]} strokes with deterministic ids
 */
export function legacyStrokesFor(pageId, sourceDocs) {
  const get = docGetter(sourceDocs);
  const monday = mondayOf(pageId);
  const first = monday ? null : monthOf(pageId);
  if (!monday && !first) return [];
  const spec = monday ? WEEK : MONTH;
  const out = [];
  for (const sourceId of legacySourcesFor(pageId)) {
    const doc = get(sourceId);
    if (!doc) continue;
    const sourceFirst = monday ? null : oldMonthOf(sourceId);
    for (const stroke of liveStrokes(doc)) {
      if (!stroke || !Array.isArray(stroke.pts) || !stroke.pts.length) continue;
      const bbox = strokeBBox(stroke);
      if (!bbox) continue;
      const center = { x: (bbox.minX + bbox.maxX) / 2, y: (bbox.minY + bbox.maxY) / 2 };
      const off = monday ? weekOffset(sourceId, monday, center) : monthOffset(first, sourceFirst, center);
      if (off) out.push(moved(stroke, bbox, off, spec));
    }
  }
  return out;
}

/**
 * Copy ids of every stroke erased (tombstoned) on the old pages of `pageId` — including copies that would
 * land on another page (tombstoning those here is harmless).
 * @returns {string[]}
 */
export function legacyErasedCopyIds(pageId, sourceDocs) {
  const get = docGetter(sourceDocs);
  const ids = new Set();
  for (const sourceId of legacySourcesFor(pageId)) {
    const deleted = get(sourceId)?.deleted;
    if (!deleted || typeof deleted !== 'object') continue;
    for (const id of Object.keys(deleted)) {
      if (id) ids.add(copyId(id));
    }
  }
  return [...ids];
}

/**
 * `current` (the Monday-start page `pageId`) with the old pages' strokes copied in, and the copies of
 * strokes since erased on the old pages erased. Only copies present on the page get a tombstone, so a page
 * with nothing to change comes back with the same content (sameContent) and is not saved again.
 * Pure and idempotent; the same old pages give the same result on every device.
 */
export function mergeLegacyInk(pageId, current, sourceDocs, now = Date.now()) {
  const added = addStrokes(current, legacyStrokesFor(pageId, sourceDocs), now);
  const erased = legacyErasedCopyIds(pageId, sourceDocs)
    .filter((id) => Object.hasOwn(added.strokes, id) && !Object.hasOwn(added.deleted, id));
  return erased.length ? removeStrokes(added, erased, now) : added;
}

/**
 * Runs `runOnce(page)` one at a time per page id. A call made while that page's run is going does not
 * start a second one alongside: the run repeats once more afterwards, for the page object of the latest
 * call. The returned promise settles when the run (and its repeats) has finished; it never rejects.
 * @param {(page: { pageId: string }) => Promise<void>} runOnce
 */
export function createLegacyCarryQueue(runOnce) {
  const runs = new Map(); // pageId → { next }
  return function carry(page) {
    const key = page && typeof page.pageId === 'string' ? page.pageId : '';
    if (!key) return Promise.resolve();
    const running = runs.get(key);
    if (running) {
      running.next = page;
      return running.done;
    }
    const run = { next: page, done: null };
    runs.set(key, run);
    run.done = Promise.resolve().then(async () => {
      try {
        while (run.next) {
          const p = run.next;
          run.next = null;
          try {
            await runOnce(p);
          } catch {
            // runOnce reports its own errors; a failed run must not stop the repeat
          }
        }
      } finally {
        runs.delete(key);
      }
    });
    return run.done;
  };
}
