// Carries handwriting from the old Sunday-start week and month pages onto the Monday-start pages.
//
// Until 1.0.4 a week could start on Sunday ('w-<sunday>' pages, 'm-YYYY-MM' month grids). The week now
// always starts on Monday, which moves every date of those grids, so the old pages are no longer shown.
// Their strokes are copied — moved by whole columns / cells so they stay on the same date — into the
// Monday-start page that now shows that date.
//
// Copies get deterministic ids (old id + SUFFIX): running the copy again (another visit, another device)
// adds nothing twice, and a copy erased on the new page stays erased (its id is tombstoned there).
// Strokes are assigned by the centre of their bounding box; strokes outside the date grid (the week's
// time gutter, beyond the page) keep their position on the page that takes over most of the old one.

import { PAGE_SPECS } from '../views/page-geometry.js';
import { addDays, daysBetween, monthGridStart, parseYMD, toYMD } from '../util/date.js';
import { strokeBBox } from './geometry.js';
import { liveStrokes } from './model.js';

export const LEGACY_SUFFIX = '~w1';
const MAX_ID_LENGTH = 128;

const WEEK = PAGE_SPECS.week;
const WEEK_COL_W = (WEEK.W - WEEK.gutter) / WEEK.cols;
const MONTH = PAGE_SPECS.month;
const CELL_W = MONTH.W / MONTH.cols;
const CELL_H = MONTH.H / MONTH.rows;

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

/**
 * The old pages whose strokes belong (partly) on `pageId`.
 * Week (Monday d): the Sunday week starting d−1 gives Mon–Sat, the one starting d+6 gives the Sunday.
 * Month: the Sunday-start grid of the same month.
 * @returns {string[]}
 */
export function legacySourcesFor(pageId) {
  const monday = mondayOf(pageId);
  if (monday) return [`w-${toYMD(addDays(monday, -1))}`, `w-${toYMD(addDays(monday, 6))}`];
  const first = monthOf(pageId);
  if (first) return [`m-${toYMD(first).slice(0, 7)}`];
  return [];
}

function centerOf(stroke) {
  const b = strokeBBox(stroke);
  if (!b) return null;
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
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

/** Offset for a stroke of the old Sunday-start month grid on the Monday-start grid of `first`. */
function monthOffset(first, center) {
  const col = Math.floor(center.x / CELL_W);
  const row = Math.floor(center.y / CELL_H);
  if (col < 0 || col >= MONTH.cols || row < 0 || row >= MONTH.rows) return { dx: 0, dy: 0 };
  const shift = daysBetween(monthGridStart(first, 1), monthGridStart(first, 0)); // +6 or −1 days
  const idx = row * MONTH.cols + col + shift;
  if (idx < 0 || idx >= MONTH.cols * MONTH.rows) return null; // that date is not on the new grid
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

function moved(stroke, { dx, dy }) {
  const pts = stroke.pts.slice();
  for (let i = 0; i + 1 < pts.length; i += 3) {
    pts[i] = Math.round((pts[i] + dx) * 10) / 10;
    pts[i + 1] = Math.round((pts[i + 1] + dy) * 10) / 10;
  }
  return { ...stroke, id: copyId(stroke.id), pts };
}

/**
 * Copies of the old pages' live strokes that belong on `pageId`, moved onto the new grid.
 * @param {string} pageId  a Monday-start week ('w-<monday>') or month ('m1-YYYY-MM') page
 * @param {Map<string, object>|Record<string, object>} sourceDocs  PageDoc per legacySourcesFor() id
 * @returns {object[]} strokes with deterministic ids
 */
export function legacyStrokesFor(pageId, sourceDocs) {
  const get = (id) => (sourceDocs instanceof Map ? sourceDocs.get(id) : sourceDocs?.[id]);
  const monday = mondayOf(pageId);
  const first = monday ? null : monthOf(pageId);
  if (!monday && !first) return [];
  const out = [];
  for (const sourceId of legacySourcesFor(pageId)) {
    const doc = get(sourceId);
    if (!doc || typeof doc !== 'object') continue;
    for (const stroke of liveStrokes(doc)) {
      if (!stroke || !Array.isArray(stroke.pts) || !stroke.pts.length) continue;
      const center = centerOf(stroke);
      if (!center) continue;
      const off = monday ? weekOffset(sourceId, monday, center) : monthOffset(first, center);
      if (off) out.push(moved(stroke, off));
    }
  }
  return out;
}
