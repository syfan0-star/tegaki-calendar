/**
 * Ink geometry (module B): pure math on strokes, rects and polygons. Importable in Node.
 * Rects are logical { minX, minY, maxX, maxY }. Polygons are flat [x0, y0, x1, y1, ...].
 */

import { widthAt } from './render.js';

const DEFAULT_SIZES = { pen: 3.5, highlighter: 18 };

function pointsOf(stroke) {
  const pts = stroke && stroke.pts;
  return pts && typeof pts === 'object' && typeof pts.length === 'number' ? pts : null;
}

function sizeOf(stroke) {
  const s = stroke ? stroke.size : undefined;
  if (Number.isFinite(s) && s > 0) return s;
  return stroke && stroke.tool === 'highlighter' ? DEFAULT_SIZES.highlighter : DEFAULT_SIZES.pen;
}

const isFiniteRect = (r) =>
  r !== null &&
  typeof r === 'object' &&
  Number.isFinite(r.minX) &&
  Number.isFinite(r.minY) &&
  Number.isFinite(r.maxX) &&
  Number.isFinite(r.maxY);

/**
 * Bounding box of the stroke's points grown by half the maximum rendered width.
 * Rendering never exceeds it (smoothing stays inside the points' hull; widths only shrink).
 * @returns {{minX:number,minY:number,maxX:number,maxY:number}|null} null when the stroke has no valid point
 */
export function strokeBBox(stroke) {
  const pts = pointsOf(stroke);
  if (!pts) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxW = 0;
  const count = Math.floor(pts.length / 3);
  for (let i = 0; i < count; i++) {
    const x = pts[i * 3];
    const y = pts[i * 3 + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    const w = widthAt(stroke, pts[i * 3 + 2]);
    if (w > maxW) maxW = w;
  }
  if (minX === Infinity) return null;
  const h = maxW / 2;
  return { minX: minX - h, minY: minY - h, maxX: maxX + h, maxY: maxY + h };
}

/** Smallest rect containing all given rects (invalid entries ignored). null for none. */
export function unionBBox(boxes) {
  if (!boxes || typeof boxes[Symbol.iterator] !== 'function') return null;
  let out = null;
  for (const b of boxes) {
    if (!isFiniteRect(b)) continue;
    if (!out) {
      out = { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY };
      continue;
    }
    if (b.minX < out.minX) out.minX = b.minX;
    if (b.minY < out.minY) out.minY = b.minY;
    if (b.maxX > out.maxX) out.maxX = b.maxX;
    if (b.maxY > out.maxY) out.maxY = b.maxY;
  }
  return out;
}

/** True when the rects overlap or touch. */
export function bboxIntersects(a, b) {
  if (!isFiniteRect(a) || !isFiniteRect(b)) return false;
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

/** Even-odd point-in-polygon test. poly = flat [x, y, ...]; fewer than 3 vertices → false. */
export function pointInPolygon(x, y, poly) {
  if (!poly || typeof poly.length !== 'number') return false;
  const n = poly.length >> 1;
  if (n < 3) return false;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2];
    const yi = poly[i * 2 + 1];
    const xj = poly[j * 2];
    const yj = poly[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function polygonBounds(poly) {
  const n = poly.length >> 1;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = poly[i * 2];
    const y = poly[i * 2 + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * True when at least half of the stroke's points are inside the lasso polygon
 * (a 1-point stroke: when its bbox centre, i.e. the point, is inside).
 * `bounds` (extra optional parameter): the polygon's bounding rect, when the caller tests many
 * strokes against one lasso and has computed it once. Stops as soon as the answer is certain.
 */
export function strokeInLasso(stroke, poly, bounds) {
  const pts = pointsOf(stroke);
  if (!pts || !poly || typeof poly.length !== 'number' || poly.length < 6) return false;
  const lb = isFiniteRect(bounds) ? bounds : polygonBounds(poly);
  const count = Math.floor(pts.length / 3);
  let valid = 0;
  let inside = 0;
  for (let i = 0; i < count; i++) {
    const x = pts[i * 3];
    const y = pts[i * 3 + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    valid++;
    if (x >= lb.minX && x <= lb.maxX && y >= lb.minY && y <= lb.maxY && pointInPolygon(x, y, poly)) {
      inside++;
      if (inside * 2 >= count) return true; // valid ≤ count: already at least half
    } else if (inside * 2 + (count - 1 - i) < valid) {
      return false; // even if every remaining point were inside, it would stay under half
    }
  }
  if (valid === 0) return false;
  return inside * 2 >= valid;
}

/** Squared distance from P to segment AB. */
function segmentDistanceSq(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? (wx * vx + wy * vy) / len2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const dx = wx - t * vx;
  const dy = wy - t * vy;
  return dx * dx + dy * dy;
}

/** Distance from point P to segment AB (a degenerate segment is a point). */
export function segmentDistance(px, py, ax, ay, bx, by) {
  return Math.sqrt(segmentDistanceSq(px, py, ax, ay, bx, by));
}

/**
 * Eraser hit test: true when some segment of the stroke (or its only point) is within
 * r + size/2 of the circle centre.
 */
export function strokeHitsCircle(stroke, cx, cy, r) {
  const pts = pointsOf(stroke);
  if (!pts || !Number.isFinite(cx) || !Number.isFinite(cy)) return false;
  const reach = (Number.isFinite(r) && r > 0 ? r : 0) + sizeOf(stroke) / 2;
  const reach2 = reach * reach;
  const count = Math.floor(pts.length / 3);
  let hasPrev = false;
  let px = 0;
  let py = 0;
  for (let i = 0; i < count; i++) {
    const x = pts[i * 3];
    const y = pts[i * 3 + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const d2 = hasPrev ? segmentDistanceSq(cx, cy, px, py, x, y) : (cx - x) * (cx - x) + (cy - y) * (cy - y);
    if (d2 <= reach2) return true;
    px = x;
    py = y;
    hasPrev = true;
  }
  return false;
}

/** Rect moved by (dx, dy). null stays null. */
export function translateRect(rect, dx, dy) {
  if (!rect || typeof rect !== 'object') return null;
  const ox = Number.isFinite(dx) ? dx : 0;
  const oy = Number.isFinite(dy) ? dy : 0;
  return { minX: rect.minX + ox, minY: rect.minY + oy, maxX: rect.maxX + ox, maxY: rect.maxY + oy };
}
