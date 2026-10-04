/**
 * js/ink/surface.js — module E: the ink layer of one calendar page.
 *
 * Creates inside pageEl (the "ink host"):
 *   canvas.ink-base   z3  committed strokes
 *   svg.ink-overlay   z4  lasso path and dashed selection box
 *   canvas.ink-live   z5  in-progress stroke, eraser cursor, move preview, 予定 preview
 * and turns Pointer Events into ink operations (SPEC §4 E, iPad recipe §7).
 *
 * Everything is stored and drawn in the page's logical units (lu). Both canvases are stretched over
 * the whole page box (CSS 100%) and their context transform maps [0,W]×[0,H] onto the backing store,
 * so drawing code never deals with CSS or device pixels.
 *
 * Pen and highlighter samples go through InkStabilizer before they are stored or drawn: whole-pixel
 * coordinates (WebKit before iPadOS 26.2) are reconstructed, a One Euro filter removes jitter without
 * visible lag, and points are kept ≥ 0.75 CSS px apart (render.js then smooths the outline).
 *
 * This module is importable in Node (no top-level DOM access); the DOM is reached through pageEl.
 */
import { emptyPage, makeStroke, applyOp, invertOp, cloneStrokes, liveStrokes } from './model.js';
import { strokeInLasso, strokeHitsCircle, strokeBBox, unionBBox, translateRect } from './geometry.js';
import { drawStroke, drawStrokes, drawLiveStroke, widthAt, PEN_SIZES, HIGHLIGHTER_SIZE } from './render.js';

/** @typedef {{ minX: number, minY: number, maxX: number, maxY: number }} Rect */
/** @typedef {{ x: number, y: number, left: number, top: number, right: number, bottom: number, width: number, height: number }} ScreenRect */
/** @typedef {{ ids: string[], bbox: Rect, screenRect: ScreenRect }} InkSelection */

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** Per-canvas backing-store cap: 4096² device px, the iPadOS 17 limit (iPadOS 18 allows 8192²). */
export const MAX_CANVAS_PIXELS = 16777216;
/** Maximum number of undo steps kept per page. */
export const UNDO_LIMIT = 200;
/** Eraser radius in lu. */
export const ERASER_RADIUS = 10;
/** Stored ink points are never closer than this (lu), whatever the page scale (see STABILIZER.minSpacing). */
export const MIN_POINT_DISTANCE = 0.3;
/**
 * Pencil input stabilizer (InkStabilizer). Distances in CSS px, so it behaves the same at every page scale.
 * - Whole-pixel coordinates (WebKit ≤ iPadOS 26.1 reports Pencil clientX/clientY as integers, bug 133180;
 *   the mouse too) are reconstructed between the moments the pixel value changes, which removes the
 *   1-px staircase; fractional coordinates are used as they are.
 * - One Euro filter: cutoff = minCutoff + beta × speed. A still or very slow pen is smoothed strongly,
 *   a moving pen lags by at most 1 / (2π × beta) ≈ 0.3 px.
 * - Stored points are at least minSpacing apart; the first and last real points are kept (with whole-pixel
 *   input: where in its pixel the pen was, estimated from the neighbouring pixel crossings).
 * - Pressure: exponential moving average (time constant pressureTau).
 */
export const STABILIZER = Object.freeze({
  minCutoff: 1, // Hz
  beta: 0.5, // per (CSS px / s)
  dCutoff: 20, // Hz, low-pass of the speed estimate
  minSpacing: 0.75, // CSS px between stored points
  pressureTau: 12, // ms
  nominalDt: 1000 / 240, // ms, when a sample has no usable timestamp (Pencil samples at 240 Hz)
});
/** 予定 tool: a gesture that never moves this far (lu) from its start is a tap. */
export const EVENT_TAP_DISTANCE = 8;
/** Padding (lu) around the strokes in snapshot(). */
export const SNAPSHOT_PADDING = 12;

const TOOLS = new Set(['pen', 'highlighter', 'eraser', 'lasso', 'event']);
const INK_TOOLS = new Set(['pen', 'highlighter']);
const LASSO_MIN_STEP = 2;          // lu between stored lasso vertices
const LASSO_MIN_EXTENT = 4;        // lu; a smaller lasso is a tap
const LASSO_SIMPLIFY_EPSILON = 1;  // lu; the lasso polygon is simplified this much before hit-testing
const LASSO_MAX_VERTICES = 512;    // a still larger (very wiggly) lasso is simplified more coarsely
const MOVE_START_PX = 6;           // screen px; a shorter drag inside the selection is a tap
const DIRTY_PAD = 1;               // lu around a partially redrawn area (antialiasing)
const SELECTION_PAD_PX = 6;        // visual padding of the dashed selection box (screen px)
const SELECTION_HIT_PAD_PX = 12;   // extra grab margin around the selection box (screen px)
const SNAPSHOT_MAX_ZOOM = 4;       // never enlarge a tiny selection more than this in snapshot()
const CLICK_SUPPRESS_MS = 400;     // swallow the click that follows a mouse/finger ink gesture
const FINGER_PAN_SLOP_PX = 12;     // allowFinger two-finger scroll starts after this (= the two-finger tap's maxMove)
const ACCENT = '#2563eb';
const SVG_NS = 'http://www.w3.org/2000/svg';
const GESTURE_EVENTS = ['gesturestart', 'gesturechange', 'gestureend'];
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------------------------

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** Round to 0.1 and normalise -0 to 0. */
const round1 = (v) => Math.round(v * 10) / 10 || 0;
const round2 = (v) => Math.round(v * 100) / 100 || 0;

/**
 * Whether a pointer may start ink (SPEC §4 E input rules): pen always, mouse with the main button,
 * touch (finger) only when allowFinger is on.
 * @param {{ pointerType?: string, button?: number }} e
 * @param {boolean} allowFinger
 */
export function acceptsPointer(e, allowFinger = false) {
  if (!e) return false;
  switch (e.pointerType) {
    case 'pen': return true;
    case 'mouse': return e.button === 0;
    case 'touch': return !!allowFinger;
    default: return false;
  }
}

/** True if any Touch in a TouchList-like has touchType 'stylus' (Apple Pencil). */
export function touchListHasStylus(list) {
  if (!list || typeof list.length !== 'number') return false;
  for (let i = 0; i < list.length; i++) {
    const t = list[i] ?? (typeof list.item === 'function' ? list.item(i) : null);
    if (t && t.touchType === 'stylus') return true;
  }
  return false;
}

/**
 * Pressure for one input sample. Pen: the reported pressure (0..1); a 0 / missing value during contact
 * falls back to `fallback` (the previous sample's pressure, 0.5 at the start). Touch and mouse: 0.5
 * (iPad fingers report 0).
 */
export function pointerPressure(pointerType, pressure, fallback = 0.5) {
  if (pointerType !== 'pen') return 0.5;
  if (isFiniteNum(pressure) && pressure > 0) return Math.min(1, pressure);
  return isFiniteNum(fallback) && fallback > 0 && fallback <= 1 ? fallback : 0.5;
}

/** Page scale from the page's client rect (CSS width = W × scale), else the fallback, else 1. */
export function resolveScale(rect, W, fallback = 1) {
  if (rect && isFiniteNum(rect.width) && rect.width > 0 && isFiniteNum(W) && W > 0) return rect.width / W;
  return isFiniteNum(fallback) && fallback > 0 ? fallback : 1;
}

/** Client (viewport) coordinates → page logical units: x = (clientX − rect.left) / scale. */
export function clientToLogical(clientX, clientY, rect, scale) {
  const s = isFiniteNum(scale) && scale > 0 ? scale : 1;
  const left = rect && isFiniteNum(rect.left) ? rect.left : 0;
  const top = rect && isFiniteNum(rect.top) ? rect.top : 0;
  return { x: (Number(clientX) - left) / s, y: (Number(clientY) - top) / s };
}

/**
 * Backing-store size for a canvas of cssW×cssH CSS px at the wanted device pixel ratio, lowering the
 * ratio so that width × height ≤ maxPixels.
 * @returns {{ width: number, height: number, ratio: number }}
 */
export function computeBackingSize(cssW, cssH, dpr = 1, maxPixels = MAX_CANVAS_PIXELS) {
  const w = isFiniteNum(cssW) && cssW > 0 ? cssW : 1;
  const h = isFiniteNum(cssH) && cssH > 0 ? cssH : 1;
  const max = isFiniteNum(maxPixels) && maxPixels >= 1 ? Math.floor(maxPixels) : MAX_CANVAS_PIXELS;
  let ratio = isFiniteNum(dpr) && dpr > 0 ? dpr : 1;
  if (w * h * ratio * ratio > max) ratio = Math.sqrt(max / (w * h));
  let width = Math.max(1, Math.floor(w * ratio));
  let height = Math.max(1, Math.floor(h * ratio));
  if (width * height > max) { // only for absurd aspect ratios (one side clamped up to 1 px)
    if (width >= height) width = Math.max(1, Math.floor(max / height));
    else height = Math.max(1, Math.floor(max / width));
  }
  return { width, height, ratio };
}

/**
 * Whether (x, y) is far enough from the last point of a flat point array to be kept.
 * @param {number[]} pts flat array with `stride` numbers per point (x, y first)
 */
export function shouldAppendPoint(pts, x, y, minDist = MIN_POINT_DISTANCE, stride = 3) {
  if (!isFiniteNum(x) || !isFiniteNum(y)) return false;
  const n = pts ? pts.length : 0;
  if (n < stride) return true;
  const dx = x - pts[n - stride];
  const dy = y - pts[n - stride + 1];
  return dx * dx + dy * dy >= minDist * minDist;
}

/**
 * Final clean-up of a stroke's flat [x, y, p, ...] samples before makeStroke: drops non-finite samples,
 * rounds x/y to 0.1 and p (clamped 0..1) to 0.01, and merges consecutive duplicates (keeping the higher
 * pressure). A single remaining point is a dot; an empty result means "no stroke".
 */
export function finalizeStrokePoints(pts) {
  const out = [];
  if (!pts || typeof pts.length !== 'number') return out;
  for (let i = 0; i + 2 < pts.length; i += 3) {
    const x = Number(pts[i]);
    const y = Number(pts[i + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const pRaw = Number(pts[i + 2]);
    const p = round2(clampNum(Number.isFinite(pRaw) ? pRaw : 0.5, 0, 1));
    const rx = round1(x);
    const ry = round1(y);
    const n = out.length;
    if (n && out[n - 3] === rx && out[n - 2] === ry) {
      out[n - 1] = Math.max(out[n - 1], p);
      continue;
    }
    out.push(rx, ry, p);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Input stabilizer (pure; exported for tests)
// ---------------------------------------------------------------------------------------------

const GRID_EPS = 1e-6;

/** Coordinate grid of a sample: 1 (whole px), 0.5 (half px) or 0 (fractional). */
function sampleGrid(x, y) {
  if (Math.abs(x - Math.round(x)) < GRID_EPS && Math.abs(y - Math.round(y)) < GRID_EPS) return 1;
  if (Math.abs(x * 2 - Math.round(x * 2)) < GRID_EPS && Math.abs(y * 2 - Math.round(y * 2)) < GRID_EPS) return 0.5;
  return 0;
}

const onGrid = (v, g) => Math.abs(v / g - Math.round(v / g)) < GRID_EPS;

/**
 * One axis of a quantized input: the reported value q is the true value rounded to a grid g. Anchors
 * (time, value) are placed where the value is known best — when q steps by one cell the true value
 * crossed the cell boundary halfway between the two samples; after a bigger jump (fast pen) the samples
 * themselves are the anchors. Between anchors the value follows a cubic Hermite curve whose tangents
 * stay one-sided at turning points (the pen went into a cell and back out the same side: a small bump,
 * not a flat cut), and the result is clamped to the sample's own cell. Where in its cell the pen
 * started (and stopped) is extrapolated from the first (last) crossings when the pen was moving steadily.
 */
class QuantizedAxis {
  constructor(t, q, g) {
    this.g = g;
    this.t = [t];
    this.v = [q];
    this.q0 = q;
    this.lastT = t;
    this.lastQ = q;
    this.startSet = false;
    this.done = false;
  }

  _clampToCell(v, q) {
    const half = this.g / 2;
    return v < q - half ? q - half : v > q + half ? q + half : v;
  }

  /** With two crossings known: the start value, extrapolated back if the pen moved off at once. */
  _softStart() {
    this.startSet = true;
    const T = this.t;
    const V = this.v;
    const lead = T[1] - T[0];
    const step = T[2] - T[1];
    if (lead > 2 * step) return; // the pen rested before it moved: the cell centre is the best guess
    V[0] = this._clampToCell(V[1] - ((V[2] - V[1]) / step) * lead, this.q0);
  }

  /** The final anchor (just pushed): extrapolated forward if the pen was still moving when it lifted. */
  _softEnd() {
    const T = this.t;
    const V = this.v;
    const n = T.length;
    if (n < 3) return;
    const trail = T[n - 1] - T[n - 2];
    const step = T[n - 2] - T[n - 3];
    if (trail > 2 * step) return;
    V[n - 1] = this._clampToCell(V[n - 2] + ((V[n - 2] - V[n - 3]) / step) * trail, this.lastQ);
  }

  _push(t, v) {
    const n = this.t.length;
    if (t <= this.t[n - 1]) return;
    this.t.push(t);
    this.v.push(v);
  }

  add(t, q) {
    const a = this.lastQ;
    if (q !== a) {
      if (Math.abs(q - a) <= this.g * (1 + GRID_EPS)) {
        this._push((this.lastT + t) / 2, (a + q) / 2);
      } else {
        this._push(this.lastT, a);
        this._push(t, q);
      }
      if (!this.startSet && this.t.length >= 3) this._softStart();
    }
    this.lastT = t;
    this.lastQ = q;
  }

  finish() {
    if (this.done) return;
    const n = this.t.length;
    this._push(this.lastT, this.lastQ);
    if (this.t.length > n) this._softEnd();
    this.done = true;
  }

  /** Temporarily behaves as if finished (live preview); returns the function that undoes it. */
  pretendFinished() {
    if (this.done) return () => {};
    const n = this.t.length;
    this.finish();
    return () => {
      this.t.length = n;
      this.v.length = n;
      this.done = false;
    };
  }

  /** Samples up to this time have their final estimate (none before the start value is settled). */
  stableUntil() {
    if (this.done) return Infinity;
    if (!this.startSet) return -Infinity;
    return this.t[this.t.length - 2];
  }

  _tangent(i) {
    const T = this.t;
    const V = this.v;
    const n = T.length;
    const dp = i > 0 ? (V[i] - V[i - 1]) / (T[i] - T[i - 1]) : null;
    const dn = i < n - 1 ? (V[i + 1] - V[i]) / (T[i + 1] - T[i]) : null;
    if (dp === null) return dn === null ? 0 : dn;
    if (dn === null) return dp;
    if (dp === 0) return dn;
    if (dn === 0) return dp;
    if ((dp > 0) !== (dn > 0)) return 0;
    return (V[i + 1] - V[i - 1]) / (T[i + 1] - T[i - 1]);
  }

  /** Estimated true value at time t of a sample that reported q (provisional while not stable). */
  estimate(t, q) {
    const T = this.t;
    const V = this.v;
    const n = T.length;
    let lo = 0;
    let hi = n - 1;
    if (t >= T[hi]) lo = hi;
    else {
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (T[mid] <= t) lo = mid;
        else hi = mid;
      }
    }
    let v;
    if (lo === n - 1) {
      v = V[lo] + (this.done ? 0 : this._tangent(lo) * (t - T[lo])); // not reached yet: extrapolate
    } else {
      const h = T[lo + 1] - T[lo];
      const f = (t - T[lo]) / h;
      const f2 = f * f;
      const f3 = f2 * f;
      v = (2 * f3 - 3 * f2 + 1) * V[lo] + (f3 - 2 * f2 + f) * h * this._tangent(lo)
        + (3 * f2 - 2 * f3) * V[lo + 1] + (f3 - f2) * h * this._tangent(lo + 1);
    }
    return this._clampToCell(v, q);
  }
}

/**
 * Turns the raw samples of one stroke into the points that are stored (and drawn live).
 * A sample is `{ cx, cy, p, t, left, top, scale }`: client px, pressure 0..1, timestamp (ms), and the
 * page's client offset and scale at that moment (so a page that scrolls during the stroke is fine).
 * Output: flat [x, y, p, ...] in page logical units, x/y rounded to 0.1 and p to 0.01 (the stored format),
 * so the live preview and the committed stroke use exactly the same numbers.
 */
export class InkStabilizer {
  constructor(first, opts = {}) {
    this._o = { ...STABILIZER, ...opts };
    const t = isFiniteNum(first.t) ? first.t : 0;
    const s = { ...first, t };
    this._grid = sampleGrid(s.cx, s.cy);
    this._ax = new QuantizedAxis(t, s.cx, this._grid);
    this._ay = new QuantizedAxis(t, s.cy, this._grid);
    this._pending = [s];
    this._last = s;
    // Filter state (page CSS px): position, velocity, time, pressure, last stored point. The first
    // final sample initialises it (with whole-pixel input that waits for the first pixel crossings).
    this._f = { ready: false, x: 0, y: 0, dx: 0, dy: 0, t, p: s.p, kx: 0, ky: 0 };
    /** Stored points so far (flat, rounded). Never rewritten except for pressure (setPressure). */
    this.pts = [];
    this._flush(false);
  }

  /** Feeds one raw sample. Returns true when stored points were added. */
  add(sample) {
    const prev = this._last;
    let t = sample.t;
    if (!isFiniteNum(t) || t <= prev.t) t = prev.t + this._o.nominalDt;
    const s = { ...sample, t };
    this._last = s;
    if (this._grid > 0 && !(onGrid(s.cx, this._grid) && onGrid(s.cy, this._grid))) this._grid = 0; // fractional input
    if (this._grid > 0) {
      this._ax.add(t, s.cx);
      this._ay.add(t, s.cy);
    }
    this._pending.push(s);
    return this._flush(false);
  }

  /**
   * The pen-up sample: it repeats the last position (only its pressure, usually 0, is new), so it only
   * counts when the pen moved. This keeps the committed stroke identical to the last live frame.
   */
  addEnd(sample) {
    const last = this._last;
    if (sample.cx !== last.cx || sample.cy !== last.cy) return this.add(sample);
    return false;
  }

  /** Every sample after the first got the fallback pressure: use the first real one instead. */
  setPressure(p) {
    const v = round2(p);
    for (let i = 2; i < this.pts.length; i += 3) this.pts[i] = v;
    for (const s of this._pending) s.p = p;
    this._last.p = p;
    this._f.p = p;
  }

  /** Ends the stroke: all samples become final, the last real point is kept exactly. Returns pts. */
  finish() {
    this._ax.finish();
    this._ay.finish();
    this._flush(true);
    this._appendEnd(this.pts, this._f);
    return this.pts;
  }

  /**
   * What the stroke would be if the pen lifted now — exactly what finish() would return (live
   * preview, so the ink does not change when the pen lifts). Does not change any state.
   */
  preview() {
    const out = this.pts.slice();
    const f = { ...this._f };
    const undoX = this._ax.pretendFinished();
    const undoY = this._ay.pretendFinished();
    try {
      for (const s of this._pending) this._step(s, f, out);
      // The end point is estimated while the axes still count as finished: finish() places it the same
      // way (final anchor + soft end), not by extrapolating along the last tangent.
      this._appendEnd(out, f);
    } finally {
      undoX();
      undoY();
    }
    return out;
  }

  _flush(all) {
    const until = all || this._grid === 0 ? Infinity : Math.min(this._ax.stableUntil(), this._ay.stableUntil());
    const before = this.pts.length;
    let k = 0;
    while (k < this._pending.length && this._pending[k].t <= until) this._step(this._pending[k++], this._f, this.pts);
    if (k) this._pending.splice(0, k);
    return this.pts.length > before;
  }

  /** One sample through reconstruction, One Euro, pressure EMA and spacing into `out` (state `f`). */
  _step(s, f, out) {
    const o = this._o;
    const g = this._grid;
    const x = (g > 0 ? this._ax.estimate(s.t, s.cx) : s.cx) - s.left;
    const y = (g > 0 ? this._ay.estimate(s.t, s.cy) : s.cy) - s.top;
    if (!f.ready) { // the first real point: kept as it is
      Object.assign(f, { ready: true, x, y, t: s.t, p: isFiniteNum(s.p) ? s.p : 0.5, kx: x, ky: y });
      out.push(round1(x / s.scale), round1(y / s.scale), round2(f.p));
      return;
    }
    const dt = Math.max(1e-3, (s.t - f.t) / 1000);
    f.t = s.t;
    const ad = oneEuroAlpha(o.dCutoff, dt);
    f.dx += ad * ((x - f.x) / dt - f.dx);
    f.dy += ad * ((y - f.y) / dt - f.dy);
    const a = oneEuroAlpha(o.minCutoff + o.beta * Math.hypot(f.dx, f.dy), dt);
    f.x += a * (x - f.x);
    f.y += a * (y - f.y);
    f.p += (1 - Math.exp(-(dt * 1000) / o.pressureTau)) * ((isFiniteNum(s.p) ? s.p : 0.5) - f.p);
    const spacing = Math.max(o.minSpacing, MIN_POINT_DISTANCE * s.scale);
    if (Math.hypot(f.x - f.kx, f.y - f.ky) < spacing) return;
    f.kx = f.x;
    f.ky = f.y;
    out.push(round1(f.x / s.scale), round1(f.y / s.scale), round2(f.p));
  }

  /**
   * The pen's last real position ends the stroke: it replaces a stored point closer than the spacing
   * (the filtered points trail the pen slightly), except the first point — a tap stays a dot.
   */
  _appendEnd(out, f) {
    const s = this._last;
    const g = this._grid;
    const x = (g > 0 ? this._ax.estimate(s.t, s.cx) : s.cx) - s.left;
    const y = (g > 0 ? this._ay.estimate(s.t, s.cy) : s.cy) - s.top;
    const spacing = Math.max(this._o.minSpacing, MIN_POINT_DISTANCE * s.scale);
    const n = out.length / 3;
    const lx = out[out.length - 3] * s.scale;
    const ly = out[out.length - 2] * s.scale;
    const close = Math.hypot(x - lx, y - ly) < spacing;
    if (close && n === 1) return;
    if (close) out.length -= 3;
    out.push(round1(x / s.scale), round1(y / s.scale), round2(f.p));
  }
}

/** One Euro smoothing factor for a cutoff (Hz) and a time step (s). */
function oneEuroAlpha(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

/**
 * Points along the segment (x0,y0)→(x1,y1) spaced at most `step` apart, excluding the start and
 * including the end, as a flat [x, y, ...] array. Used so a fast eraser does not skip strokes.
 */
export function samplePointsAlong(x0, y0, x1, y1, step) {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  if (!(step > 0) || !Number.isFinite(dist) || dist <= step) return [x1, y1];
  const n = Math.ceil(dist / step);
  const out = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    out.push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
  }
  return out;
}

/**
 * Closes a lasso path (flat [x, y, ...]) into a polygon by repeating the first vertex at the end.
 * Returns null for a degenerate lasso (fewer than 3 vertices, or smaller than minExtent in both
 * directions — i.e. a tap).
 */
export function closeLassoPolygon(pts, minExtent = LASSO_MIN_EXTENT) {
  if (!pts || typeof pts.length !== 'number') return null;
  const poly = [];
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const x = Number(pts[i]);
    const y = Number(pts[i + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    poly.push(x, y);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (poly.length < 6) return null;
  if (maxX - minX < minExtent && maxY - minY < minExtent) return null;
  const n = poly.length;
  if (poly[0] !== poly[n - 2] || poly[1] !== poly[n - 1]) poly.push(poly[0], poly[1]);
  return poly;
}

/**
 * Ramer–Douglas–Peucker simplification of a flat [x, y, ...] path: keeps the first and last vertex and
 * every vertex needed so that no dropped vertex is farther than `epsilon` from the result. A closed
 * lasso (last vertex = first) stays closed. Returns a copy of the input when it cannot be simplified
 * into at least 3 distinct vertices.
 */
export function simplifyPolygon(pts, epsilon = LASSO_SIMPLIFY_EPSILON) {
  if (!pts || typeof pts.length !== 'number') return [];
  const n = pts.length >> 1;
  const copy = Array.from(pts).slice(0, n * 2);
  if (n <= 4 || !(isFiniteNum(epsilon) && epsilon > 0)) return copy;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const eps2 = epsilon * epsilon;
  const stack = [0, n - 1];
  while (stack.length) {
    const b = stack.pop();
    const a = stack.pop();
    if (b - a < 2) continue;
    const ax = pts[a * 2]; const ay = pts[a * 2 + 1];
    const vx = pts[b * 2] - ax; const vy = pts[b * 2 + 1] - ay;
    const len2 = vx * vx + vy * vy;
    let far = -1;
    let farD2 = eps2;
    for (let i = a + 1; i < b; i++) {
      const wx = pts[i * 2] - ax;
      const wy = pts[i * 2 + 1] - ay;
      const t = len2 > 0 ? clampNum((wx * vx + wy * vy) / len2, 0, 1) : 0;
      const dx = wx - t * vx;
      const dy = wy - t * vy;
      const d2 = dx * dx + dy * dy;
      if (d2 > farD2) { farD2 = d2; far = i; }
    }
    if (far < 0) continue;
    keep[far] = 1;
    stack.push(a, far, far, b);
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1]);
  return out.length >= 8 ? out : copy; // ≥ 3 distinct vertices + the closing one
}

/** Bounding rect of a flat point array (`stride` numbers per point, x and y first), grown by pad. Null if empty. */
function flatBounds(pts, stride, pad = 0) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (let i = 0; i + 1 < pts.length; i += stride) {
    const x = pts[i];
    const y = pts[i + 1];
    if (!isFiniteNum(x) || !isFiniteNum(y)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (minX === Infinity) return null;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

/** Normalised rect spanned by two corner points. */
export function normalizeRect(x0, y0, x1, y1) {
  return { minX: Math.min(x0, x1), minY: Math.min(y0, y1), maxX: Math.max(x0, x1), maxY: Math.max(y0, y1) };
}

/** True for an object with finite minX/minY/maxX/maxY and max ≥ min. */
export function isRect(r) {
  return !!r && isFiniteNum(r.minX) && isFiniteNum(r.minY) && isFiniteNum(r.maxX) && isFiniteNum(r.maxY)
    && r.maxX >= r.minX && r.maxY >= r.minY;
}

/** Whether (x, y) lies inside rect grown by pad on every side. */
export function pointInRect(x, y, rect, pad = 0) {
  if (!isRect(rect)) return false;
  return x >= rect.minX - pad && x <= rect.maxX + pad && y >= rect.minY - pad && y <= rect.maxY + pad;
}

/**
 * Limits a selection move so the selection box stays on the page [0,W]×[0,H]. A box that already sticks
 * out may move back inwards but not further out; it is never pushed by the clamp itself.
 * @returns {{ dx: number, dy: number }}
 */
export function clampMoveDelta(bbox, dx, dy, W, H) {
  const mx = isFiniteNum(dx) ? dx : 0;
  const my = isFiniteNum(dy) ? dy : 0;
  if (!isRect(bbox)) return { dx: mx, dy: my };
  const axis = (min, max, d, limit) => {
    if (!isFiniteNum(limit) || limit <= 0) return d;
    return clampNum(d, Math.min(0, -min), Math.max(0, limit - max));
  };
  return { dx: axis(bbox.minX, bbox.maxX, mx, W), dy: axis(bbox.minY, bbox.maxY, my, H) };
}

/** Logical rect → client-coordinate DOMRect-like, given the page's client rect and scale. */
export function logicalRectToScreen(rect, pageRect, scale) {
  const s = isFiniteNum(scale) && scale > 0 ? scale : 1;
  const ox = pageRect && isFiniteNum(pageRect.left) ? pageRect.left : 0;
  const oy = pageRect && isFiniteNum(pageRect.top) ? pageRect.top : 0;
  const left = ox + rect.minX * s;
  const top = oy + rect.minY * s;
  const right = ox + rect.maxX * s;
  const bottom = oy + rect.maxY * s;
  return { x: left, y: top, left, top, right, bottom, width: right - left, height: bottom - top };
}

/**
 * Layout of a snapshot image: the bbox grown by pad, scaled to fit maxW×maxH (but never enlarged more
 * than maxZoom).
 * @returns {{ rect: Rect, zoom: number, width: number, height: number } | null}
 */
export function computeSnapshotLayout(bbox, { pad = SNAPSHOT_PADDING, maxW = 480, maxH = 240, maxZoom = SNAPSHOT_MAX_ZOOM } = {}) {
  if (!isRect(bbox)) return null;
  const p = isFiniteNum(pad) && pad >= 0 ? pad : SNAPSHOT_PADDING;
  const mw = isFiniteNum(maxW) && maxW >= 1 ? Math.floor(maxW) : 480;
  const mh = isFiniteNum(maxH) && maxH >= 1 ? Math.floor(maxH) : 240;
  const rect = { minX: bbox.minX - p, minY: bbox.minY - p, maxX: bbox.maxX + p, maxY: bbox.maxY + p };
  const w = Math.max(rect.maxX - rect.minX, 1e-6);
  const h = Math.max(rect.maxY - rect.minY, 1e-6);
  const zoomCap = isFiniteNum(maxZoom) && maxZoom > 0 ? maxZoom : SNAPSHOT_MAX_ZOOM;
  const zoom = Math.min(mw / w, mh / h, zoomCap);
  const width = clampNum(Math.round(w * zoom), 1, mw);
  const height = clampNum(Math.round(h * zoom), 1, mh);
  return { rect, zoom, width, height };
}

/**
 * Undo/redo stacks for one page. `invert(op)` produces the op that undoes `op` (model.invertOp).
 * undo()/redo() take an `apply(op)` callback; if it throws, the stacks are left unchanged.
 */
export class UndoHistory {
  constructor({ limit = UNDO_LIMIT, invert } = {}) {
    if (typeof invert !== 'function') throw new TypeError('UndoHistory: invert is required');
    this._limit = isFiniteNum(limit) && limit >= 1 ? Math.floor(limit) : UNDO_LIMIT;
    this._invert = invert;
    this._undo = [];
    this._redo = [];
  }

  get undoDepth() { return this._undo.length; }
  get redoDepth() { return this._redo.length; }
  canUndo() { return this._undo.length > 0; }
  canRedo() { return this._redo.length > 0; }

  /** A new user change: becomes the next undo step; the redo stack is discarded. */
  record(op) {
    if (!op) return;
    this._undo.push(op);
    this._trim();
    this._redo.length = 0;
  }

  /** Applies the inverse of the last change; returns the applied op, or null if nothing to undo. */
  undo(apply) {
    if (!this._undo.length) return null;
    const inverse = this._invert(this._undo[this._undo.length - 1]);
    if (apply) apply(inverse);
    this._undo.pop();
    this._redo.push(inverse);
    return inverse;
  }

  /** Re-applies the last undone change; returns the applied op, or null if nothing to redo. */
  redo(apply) {
    if (!this._redo.length) return null;
    const op = this._invert(this._redo[this._redo.length - 1]);
    if (apply) apply(op);
    this._redo.pop();
    this._undo.push(op);
    this._trim();
    return op;
  }

  /** Drops the newest undo step (e.g. a redo that turned out to change nothing). */
  discardLastUndo() {
    return this._undo.pop() ?? null;
  }

  /** Drops the newest redo step (e.g. an undo that turned out to change nothing). */
  discardLastRedo() {
    return this._redo.pop() ?? null;
  }

  clear() {
    this._undo.length = 0;
    this._redo.length = 0;
  }

  _trim() {
    if (this._undo.length > this._limit) this._undo.splice(0, this._undo.length - this._limit);
  }
}

// --- Safari pinch blocking on the document: registered once per document, removed with the last surface.

const gestureBlockCounts = new WeakMap();
function preventGesture(e) {
  if (e && typeof e.preventDefault === 'function') e.preventDefault();
}

/** Starts (or reference-counts) the gesturestart/gesturechange/gestureend blocker on a document. */
export function retainGestureBlock(dom) {
  if (!dom || typeof dom.addEventListener !== 'function') return;
  const count = gestureBlockCounts.get(dom) || 0;
  if (count === 0) for (const type of GESTURE_EVENTS) dom.addEventListener(type, preventGesture, { passive: false });
  gestureBlockCounts.set(dom, count + 1);
}

/** Releases one reference; the listeners are removed when the last surface on that document goes away. */
export function releaseGestureBlock(dom) {
  if (!dom || typeof dom.removeEventListener !== 'function') return;
  const count = gestureBlockCounts.get(dom) || 0;
  if (count <= 0) return;
  if (count === 1) {
    for (const type of GESTURE_EVENTS) dom.removeEventListener(type, preventGesture, { passive: false });
    gestureBlockCounts.delete(dom);
  } else {
    gestureBlockCounts.set(dom, count - 1);
  }
}

// ---------------------------------------------------------------------------------------------
// Private drawing helpers
// ---------------------------------------------------------------------------------------------

const rectsOverlap = (a, b) => a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
const fmt = (v) => String(isFiniteNum(v) ? Math.round(v * 1000) / 1000 : 0);

// Tappable things inside the page: day/week event boxes (.event) and the month view's chips, date numbers
// and '+n件' (they carry data-event-id or role=button, see view-common.js onActivate).
const TAP_TARGETS = '.event, [data-event-id], [role="button"]';

function isOnEventBox(target) {
  return !!(target && typeof target.closest === 'function' && target.closest(TAP_TARGETS));
}

function listFrom(e, method) {
  if (!e || typeof e[method] !== 'function') return [];
  try {
    const list = e[method]();
    return list ? Array.from(list) : [];
  } catch {
    return [];
  }
}

/** Pen width for a pressure, guarded against a bad widthAt result. */
function penWidth(partial, p) {
  let w = NaN;
  try { w = widthAt(partial, p); } catch { /* fall through */ }
  return isFiniteNum(w) && w > 0 ? w : Math.max(0.5, Number(partial.size) || 1);
}

/** True when `node` is `host` or lies inside it (parentNode chain). */
function isInside(host, node) {
  for (let n = node; n; n = n.parentNode) if (n === host) return true;
  return false;
}

/** Centroid of touches with finite client coordinates, or null. */
function touchCentroid(touches) {
  let x = 0; let y = 0; let k = 0;
  for (const t of touches) {
    if (!isFiniteNum(t.clientX) || !isFiniteNum(t.clientY)) continue;
    x += t.clientX;
    y += t.clientY;
    k++;
  }
  return k ? { x: x / k, y: y / k } : null;
}

/** Scroll limit (scrollSize − clientSize), Infinity when the element does not report it. */
function scrollLimit(total, visible) {
  const t = Number(total);
  const v = Number(visible);
  return Number.isFinite(t) && Number.isFinite(v) && t > 0 ? Math.max(0, t - v) : Infinity;
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function createCanvas(dom, className, zIndex) {
  const canvas = dom.createElement('canvas');
  canvas.className = className;
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = `position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:${zIndex};`;
  canvas.width = 1;
  canvas.height = 1;
  return canvas;
}

/** Safari keeps canvas backing stores until GC; shrink them explicitly when done. */
function releaseCanvas(canvas) {
  try {
    canvas.width = 1;
    canvas.height = 1;
    canvas.getContext('2d')?.clearRect(0, 0, 1, 1);
  } catch { /* ignore */ }
}

function removeNode(node) {
  if (!node) return;
  if (typeof node.remove === 'function') node.remove();
  else node.parentNode?.removeChild(node);
}

function svgNode(dom, tag, attrs) {
  const el = dom.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function warn(message, err) {
  if (typeof console !== 'undefined') console.warn(`[ink] ${message}`, err);
}

// Styles the ink host needs for the Pencil recipe (§7); views.css sets them too, this is a safety net.
const HOST_STYLE = {
  touchAction: 'pan-x pan-y',
  webkitUserSelect: 'none',
  userSelect: 'none',
  webkitTouchCallout: 'none',
  webkitTapHighlightColor: 'transparent',
};

// ---------------------------------------------------------------------------------------------
// InkSurface
// ---------------------------------------------------------------------------------------------

export class InkSurface {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.pageEl the .page element (ink host)
   * @param {HTMLElement} [opts.viewportEl] the scroll container (selection menu positioning)
   * @param {() => { pageId: string, W: number, H: number, scale: number, view: string, range: object }} opts.getPageInfo
   * @param {(doc: object, op: object) => void} [opts.onCommit]
   * @param {(sel: InkSelection | null) => void} [opts.onSelectionChange]
   * @param {(rect: Rect, info: { tap: boolean }) => void} [opts.onEventRect]
   * @param {(rect: Rect | null) => Rect | null} [opts.onEventPreview]
   */
  constructor({ pageEl, viewportEl = null, getPageInfo, onCommit, onSelectionChange, onEventRect, onEventPreview } = {}) {
    if (!pageEl || typeof pageEl.addEventListener !== 'function') throw new TypeError('InkSurface: pageEl is required');
    if (typeof getPageInfo !== 'function') throw new TypeError('InkSurface: getPageInfo is required');
    const dom = pageEl.ownerDocument || globalThis.document;
    if (!dom || typeof dom.createElement !== 'function') throw new TypeError('InkSurface: pageEl must belong to a document');

    this._pageEl = pageEl;
    this._viewportEl = viewportEl;
    this._dom = dom;
    this._win = dom.defaultView || globalThis;
    this._getPageInfo = getPageInfo;
    this._cb = { onCommit, onSelectionChange, onEventRect, onEventPreview };

    this._info = { pageId: '', W: 1, H: 1, scale: 1, view: '', range: null };
    this._sx = 1; // backing px per lu (x)
    this._sy = 1; // backing px per lu (y)
    this._tool = 'pen';
    this._styles = {
      pen: { color: '#1f2937', size: isFiniteNum(PEN_SIZES?.medium) ? PEN_SIZES.medium : 3.5 },
      highlighter: { color: '#fde047', size: isFiniteNum(HIGHLIGHTER_SIZE) ? HIGHLIGHTER_SIZE : 18 },
    };
    this._allowFinger = false;
    this._history = new UndoHistory({ limit: UNDO_LIMIT, invert: invertOp });
    this._gesture = null;
    this._selection = null;          // { ids: string[], bbox: Rect }
    this._hidden = new Set();        // stroke ids not drawn on base (being erased / moved)
    this._liveList = [];
    this._liveFor = null;
    this._bboxCache = new WeakMap();
    this._frameId = null;
    this._frameIsTimeout = false;
    this._needs = { base: false, baseRect: false, live: false, overlay: false, notify: false };
    this._baseDirty = null;          // logical rect of the base canvas to redraw in the next frame (eraser)
    this._liveBlend = '';            // mix-blend-mode of the live canvas ('multiply' while highlighting)
    this._fingerClaim = false;
    this._fingerPan = null;          // { x, y, left, top } while two fingers scroll (allowFinger)
    this._suppressClick = null;      // { until: ms, pointerType } after an ink gesture
    this._destroyed = false;
    this._frame = this._frame.bind(this);

    this._refreshInfo();
    this._page = emptyPage(this._info.pageId);
    this._createLayers();
    this._applyHostStyle();
    this._bindListeners();
    retainGestureBlock(dom);
    this.resize();
  }

  // ------------------------------------------------------------------ public API

  /** Replaces the page document (new page, or a remote merge with resetHistory:false). */
  setDoc(doc, { resetHistory = true } = {}) {
    if (this._destroyed) return;
    const next = doc && typeof doc === 'object' && doc.strokes && typeof doc.strokes === 'object'
      ? doc
      : emptyPage(doc && typeof doc.pageId === 'string' ? doc.pageId : this._info.pageId);
    const pageChanged = next.pageId !== this._page.pageId;
    // A stroke in progress belongs to the old page: drop it. Same page (remote merge): keep drawing.
    if (pageChanged && this._gesture) this._cancelGesture();
    this._page = next;
    if (resetHistory || pageChanged) {
      this._history.clear();
      this._clearSelection();
    } else {
      this._reconcileSelection();
    }
    this._renderBaseNow();
  }

  getDoc() {
    return this._page;
  }

  /** Re-measures the page (getPageInfo), resizes both canvases and redraws everything. */
  resize() {
    if (this._destroyed) return;
    this._refreshInfo();
    const { W, H, scale } = this._info;
    const dpr = Number(this._win.devicePixelRatio) || 1;
    const size = computeBackingSize(W * scale, H * scale, dpr, MAX_CANVAS_PIXELS);
    for (const canvas of [this._baseCanvas, this._liveCanvas]) {
      if (canvas.width !== size.width || canvas.height !== size.height) {
        canvas.width = size.width;
        canvas.height = size.height;
      }
    }
    this._sx = size.width / W;
    this._sy = size.height / H;
    for (const ctx of [this._baseCtx, this._liveCtx]) {
      if (!ctx) continue;
      ctx.setTransform(this._sx, 0, 0, this._sy, 0, 0);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
    }
    this._applyOverlayMetrics();
    this._renderBaseNow();
    this._clearLive();
    const g = this._gesture;
    if (g) {
      if (g.kind === 'ink') g.liveRect = null;
      this._schedule('live');
    }
    this._renderOverlay();
    if (this._selection) this._notifySelection();
  }

  setTool({ tool, color, size } = {}) {
    if (this._destroyed) return;
    const next = TOOLS.has(tool) ? tool : this._tool;
    if (INK_TOOLS.has(next)) {
      const style = this._styles[next];
      if (typeof color === 'string' && HEX_COLOR.test(color)) style.color = color.toLowerCase();
      const s = this._normalizeSize(size, next);
      if (s !== null) style.size = s;
    }
    if (next !== this._tool) {
      if (this._gesture) this._finishGesture();
      this._tool = next;
      this._clearSelection();
    }
  }

  setAllowFinger(allow) {
    if (this._destroyed) return;
    this._allowFinger = !!allow;
    if (!this._allowFinger) {
      this._fingerClaim = false;
      this._fingerPan = null;
      if (this._gesture && this._gesture.pointerType === 'touch') this._cancelGesture();
    }
  }

  undo() {
    return this._step('undo');
  }

  redo() {
    return this._step('redo');
  }

  canUndo() {
    return !this._destroyed && this._history.canUndo();
  }

  canRedo() {
    return !this._destroyed && this._history.canRedo();
  }

  /** @returns {InkSelection | null} */
  getSelection() {
    const sel = this._selection;
    if (!sel || this._destroyed) return null;
    const rect = this._pageEl.getBoundingClientRect();
    const scale = resolveScale(rect, this._info.W, this._info.scale);
    const pad = SELECTION_PAD_PX / scale;
    const padded = { minX: sel.bbox.minX - pad, minY: sel.bbox.minY - pad, maxX: sel.bbox.maxX + pad, maxY: sel.bbox.maxY + pad };
    return { ids: [...sel.ids], bbox: { ...sel.bbox }, screenRect: logicalRectToScreen(padded, rect, scale) };
  }

  clearSelection() {
    if (this._destroyed) return;
    this._clearSelection();
  }

  deleteSelection() {
    if (this._destroyed || !this._selection) return false;
    return this.removeStrokesById(this._selection.ids);
  }

  /** Removes strokes as one undoable op (e.g. after converting ink to an event). */
  removeStrokesById(ids) {
    if (this._destroyed) return false;
    const g = this._gesture;
    if (g) {
      if (g.kind === 'move') this._cancelGesture();
      else this._finishGesture();
    }
    const strokes = this._strokesByIds(ids);
    if (!strokes.length) return false;
    this._commitOp({ type: 'remove', strokes });
    this._renderBaseNow();
    this._reconcileSelection();
    return true;
  }

  /**
   * Ends the gesture in progress as if the pointer had been lifted (the page is being hidden or unloaded:
   * no pointerup / pointercancel will come). Ink and eraser gestures are committed, so a stroke in progress
   * is kept; a selection move is cancelled (the strokes stay where they were); a lasso or 予定-tool drag is
   * dropped (a dialog must not open on a page that is going away).
   */
  commitActiveGesture() {
    if (this._destroyed) return;
    const g = this._gesture;
    if (!g) return;
    if (g.kind === 'move' || g.kind === 'event' || g.kind === 'lasso') this._cancelGesture();
    else this._finishGesture();
  }

  /**
   * PNG data URL of the given strokes on white, cropped to their bbox + 12 lu and fitted into
   * maxW×maxH px. Null if none of the ids is a live stroke.
   */
  snapshot(ids, maxW = 480, maxH = 240) {
    const strokes = this._strokesByIds(ids);
    if (!strokes.length) return null;
    const layout = computeSnapshotLayout(this._unionBox(strokes), { pad: SNAPSHOT_PADDING, maxW, maxH });
    if (!layout) return null;
    const canvas = this._dom.createElement('canvas');
    try {
      canvas.width = layout.width;
      canvas.height = layout.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, layout.width, layout.height);
      const z = layout.zoom;
      ctx.setTransform(z, 0, 0, z, -layout.rect.minX * z, -layout.rect.minY * z);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      drawStrokes(ctx, strokes);
      return canvas.toDataURL('image/png');
    } catch (err) {
      warn('snapshot failed', err);
      return null;
    } finally {
      releaseCanvas(canvas);
    }
  }

  destroy() {
    if (this._destroyed) return;
    this._cancelGesture();
    const hadSelection = !!this._selection;
    this._selection = null;
    this._destroyed = true;
    this._cancelFrame();
    for (const [target, type, handler, options] of this._listeners) target.removeEventListener(type, handler, options);
    this._listeners = [];
    releaseGestureBlock(this._dom);
    this._restoreHostStyle();
    releaseCanvas(this._baseCanvas);
    releaseCanvas(this._liveCanvas);
    removeNode(this._baseCanvas);
    removeNode(this._overlay);
    removeNode(this._liveCanvas);
    this._baseCtx = null;
    this._liveCtx = null;
    this._hidden.clear();
    const { onSelectionChange } = this._cb;
    this._cb = {};
    if (hadSelection && typeof onSelectionChange === 'function') {
      try { onSelectionChange(null); } catch (err) { warn('onSelectionChange failed', err); }
    }
  }

  // ------------------------------------------------------------------ setup

  _refreshInfo() {
    let info = null;
    try { info = this._getPageInfo(); } catch (err) { warn('getPageInfo failed', err); }
    const prev = this._info;
    const W = isFiniteNum(info?.W) && info.W > 0 ? info.W : prev.W;
    const H = isFiniteNum(info?.H) && info.H > 0 ? info.H : prev.H;
    let scale = isFiniteNum(info?.scale) && info.scale > 0 ? info.scale : NaN;
    if (!Number.isFinite(scale)) {
      let rect = null;
      try { rect = this._pageEl.getBoundingClientRect(); } catch { /* ignore */ }
      scale = resolveScale(rect, W, prev.scale);
    }
    this._info = {
      pageId: typeof info?.pageId === 'string' ? info.pageId : prev.pageId,
      W, H, scale,
      view: typeof info?.view === 'string' ? info.view : prev.view,
      range: info?.range ?? prev.range,
    };
  }

  _createLayers() {
    const dom = this._dom;
    this._baseCanvas = createCanvas(dom, 'ink-base', 3);
    this._liveCanvas = createCanvas(dom, 'ink-live', 5);
    this._overlay = svgNode(dom, 'svg', {
      class: 'ink-overlay', 'aria-hidden': 'true', focusable: 'false', preserveAspectRatio: 'none',
    });
    this._overlay.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:4;overflow:visible;';
    this._lassoEl = svgNode(dom, 'polyline', {
      fill: ACCENT, 'fill-opacity': '0.06', stroke: ACCENT, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    });
    this._selRectEl = svgNode(dom, 'rect', { fill: ACCENT, 'fill-opacity': '0.05', stroke: ACCENT });
    this._lassoEl.style.display = 'none';
    this._selRectEl.style.display = 'none';
    this._overlay.appendChild(this._selRectEl);
    this._overlay.appendChild(this._lassoEl);
    this._pageEl.appendChild(this._baseCanvas);
    this._pageEl.appendChild(this._overlay);
    this._pageEl.appendChild(this._liveCanvas);
    this._baseCtx = this._baseCanvas.getContext('2d');
    this._liveCtx = this._liveCanvas.getContext('2d');
  }

  _applyHostStyle() {
    const style = this._pageEl.style;
    this._savedHostStyle = {};
    if (!style) return;
    for (const [prop, value] of Object.entries(HOST_STYLE)) {
      this._savedHostStyle[prop] = style[prop];
      try { style[prop] = value; } catch { /* unsupported property */ }
    }
  }

  _restoreHostStyle() {
    const style = this._pageEl.style;
    if (!style || !this._savedHostStyle) return;
    for (const [prop, value] of Object.entries(this._savedHostStyle)) {
      try { style[prop] = value ?? ''; } catch { /* ignore */ }
    }
  }

  _bindListeners() {
    const page = this._pageEl;
    const nonPassive = { passive: false };
    const onTouch = this._onTouch.bind(this);
    this._listeners = [
      [page, 'touchstart', onTouch, nonPassive],
      [page, 'touchmove', onTouch, nonPassive],
      [page, 'touchend', onTouch, nonPassive],
      [page, 'touchcancel', onTouch, { passive: true }],
      [page, 'pointerdown', this._onPointerDown.bind(this), false],
      [page, 'pointermove', this._onPointerMove.bind(this), false],
      [page, 'pointerup', this._onPointerUp.bind(this), false],
      [page, 'pointercancel', this._onPointerCancel.bind(this), false],
      [page, 'lostpointercapture', this._onLostCapture.bind(this), false],
      [page, 'contextmenu', this._onBlock.bind(this), nonPassive],
      [page, 'selectstart', this._onBlock.bind(this), nonPassive],
      [page, 'click', this._onClickCapture.bind(this), { capture: true }],
    ];
    const vp = this._viewportEl;
    if (vp && typeof vp.addEventListener === 'function') {
      this._listeners.push([vp, 'scroll', this._onViewportScroll.bind(this), { passive: true }]);
    }
    for (const [target, type, handler, options] of this._listeners) target.addEventListener(type, handler, options);
  }

  // ------------------------------------------------------------------ input: touch layer

  /**
   * Non-passive touch listener: preventDefault for the Pencil (no scroll / zoom / Scribble, fingers keep
   * native scrolling) and, with allowFinger, for finger touches that started a drawing gesture.
   * With allowFinger a second finger turns the touch into a two-finger scroll: the finger stroke is
   * dropped and the viewport is scrolled by hand (native panning is already blocked for this touch
   * sequence because its first touchstart was prevented).
   */
  _onTouch(e) {
    if (this._destroyed) return;
    const stylus = touchListHasStylus(e.changedTouches);
    if (!stylus && this._allowFinger) {
      if (e.type === 'touchstart') this._onFingerStart(e);
      else if (e.type === 'touchmove' && this._fingerPan) this._moveFingerPan(this._fingersOnPage(e.touches));
    }
    if (e.cancelable && (stylus || (this._allowFinger && this._fingerClaim))) e.preventDefault();
    if (e.type === 'touchend' || e.type === 'touchcancel') {
      if (!(e.touches && e.touches.length)) {
        this._fingerClaim = false;
        this._fingerPan = null;
      } else if (this._fingerPan) {
        this._startFingerPan(this._fingersOnPage(e.touches)); // a finger lifted: re-anchor, no jump
      }
    }
  }

  _onFingerStart(e) {
    const fingers = this._fingersOnPage(e.touches);
    const g = this._gesture;
    const penOrMouse = !!g && g.pointerType !== 'touch'; // never scroll the page under the Pencil
    const target = e.changedTouches?.[0]?.target ?? e.target;
    // pointerdown usually precedes touchstart in WebKit; handle either order.
    const claimable = this._fingerClaim || (!!g && g.pointerType === 'touch') || (!g && this._canStartGesture('touch', 0, target));
    // Two fingers: a scroll (and maybe the two-finger tap → eraser), never ink — also when both landed in
    // the same touchstart, where the first finger's pointerdown has already begun a stroke.
    if (this._fingerPan || (!penOrMouse && claimable && fingers.length >= 2)) {
      if (g && g.pointerType === 'touch') this._cancelGesture(); // the first finger's ink is discarded
      this._fingerClaim = true;
      this._startFingerPan(fingers);
      return;
    }
    if (claimable && !penOrMouse) this._fingerClaim = true;
  }

  /** Finger (non-stylus) touches of a TouchList that started inside the page. */
  _fingersOnPage(list) {
    const out = [];
    if (!list || typeof list.length !== 'number') return out;
    for (let i = 0; i < list.length; i++) {
      const t = list[i] ?? (typeof list.item === 'function' ? list.item(i) : null);
      if (t && t.touchType !== 'stylus' && isInside(this._pageEl, t.target)) out.push(t);
    }
    return out;
  }

  /** (Re-)anchors the two-finger scroll at the fingers' centroid; a scroll already under way keeps going. */
  _startFingerPan(fingers) {
    const vp = this._viewportEl;
    const c = touchCentroid(fingers);
    this._fingerPan = {
      x: c ? c.x : NaN,
      y: c ? c.y : NaN,
      left: Number(vp?.scrollLeft) || 0,
      top: Number(vp?.scrollTop) || 0,
      moving: !!this._fingerPan?.moving,
    };
  }

  _moveFingerPan(fingers) {
    const pan = this._fingerPan;
    const c = touchCentroid(fingers);
    if (!pan || !c) return;
    if (!pan.moving) {
      // A tap wobbles a little: nothing scrolls until the fingers really move (the two-finger tap stays a
      // tap), then the scroll starts from here — no jump by the slop.
      if (isFiniteNum(pan.x) && isFiniteNum(pan.y) && Math.hypot(c.x - pan.x, c.y - pan.y) < FINGER_PAN_SLOP_PX) return;
      pan.moving = true;
      pan.x = c.x;
      pan.y = c.y;
      return;
    }
    const vp = this._viewportEl;
    // (Fingers cannot ink while scrolling, so an active gesture is the Pencil / mouse: keep the page still.)
    if (vp && !this._gesture && isFiniteNum(pan.x) && isFiniteNum(pan.y)) {
      // Track the wanted position in floats (scrollTop may be rounded) and clamp it, so moving back
      // after hitting an edge scrolls again at once.
      pan.left = clampNum(pan.left - (c.x - pan.x), 0, scrollLimit(vp.scrollWidth, vp.clientWidth));
      pan.top = clampNum(pan.top - (c.y - pan.y), 0, scrollLimit(vp.scrollHeight, vp.clientHeight));
      try {
        vp.scrollLeft = pan.left;
        vp.scrollTop = pan.top;
      } catch { /* ignore */ }
    }
    pan.x = c.x;
    pan.y = c.y;
  }

  _onBlock(e) {
    if (e.cancelable !== false) e.preventDefault();
  }

  /**
   * Swallows the click that a mouse/finger ink gesture would otherwise deliver to an event box.
   * After a pen gesture only a click that identifies itself as pen is swallowed (on iPad the Pencil's
   * click is already cancelled by the touch layer, and a quick finger tap afterwards must still work).
   */
  _onClickCapture(e) {
    const s = this._suppressClick;
    if (!s) return;
    this._suppressClick = null;
    if (Date.now() > s.until) return;
    if (s.pointerType === 'pen' && e.pointerType !== 'pen') return;
    e.preventDefault();
    e.stopPropagation();
  }

  _onViewportScroll() {
    if (this._selection && !this._destroyed) this._schedule('notify');
  }

  // ------------------------------------------------------------------ input: pointer layer

  _canStartGesture(pointerType, button, target) {
    if (this._destroyed) return false;
    if (!acceptsPointer({ pointerType, button }, this._allowFinger)) return false;
    if (pointerType === 'touch' && this._fingerPan) return false; // two fingers are scrolling
    // A mouse click (or finger tap) on an event box is a tap, not ink, unless pen/highlighter is active.
    if (pointerType !== 'pen' && !INK_TOOLS.has(this._tool) && isOnEventBox(target)) return false;
    return true;
  }

  _onPointerDown(e) {
    if (this._destroyed) return;
    const active = this._gesture;
    if (active) {
      if (e.pointerId === active.pointerId) {
        this._finishGesture(); // the same pointer cannot go down twice: its up was lost
      } else if (e.pointerType === 'pen') {
        if (active.pointerType === 'pen') this._finishGesture(); // missed pen-up: keep what was drawn
        else this._cancelGesture();                              // the Pencil wins over a finger / palm
      } else {
        return; // one active pointer at a time
      }
    }
    if (!this._canStartGesture(e.pointerType, e.button, e.target)) return;
    if (e.cancelable !== false) e.preventDefault(); // blocks compat mouse events (not scrolling)
    try { this._pageEl.setPointerCapture?.(e.pointerId); } catch { /* pointer already gone */ }
    const base = { pointerId: e.pointerId, pointerType: e.pointerType, lastP: 0.5 };
    const pt = this._sampleFromEvent(e, base);
    if (!pt) {
      this._releaseCapture(e.pointerId);
      return;
    }
    // A pen contact may report pressure 0: the samples get the first real pressure later (_toSample).
    if (e.pointerType === 'pen' && !(isFiniteNum(e.pressure) && e.pressure > 0)) base.pressurePending = true;
    switch (this._tool) {
      case 'pen':
      case 'highlighter': this._beginInk(base, pt); break;
      case 'eraser': this._beginErase(base, pt); break;
      case 'lasso': this._beginLassoOrMove(base, pt); break;
      case 'event': this._beginEvent(base, pt); break;
      default: break;
    }
  }

  _onPointerMove(e) {
    const g = this._gesture;
    if (!g || e.pointerId !== g.pointerId) return; // hover (pen buttons 0) or another pointer
    if (g.pointerType === 'mouse' && e.buttons === 0) { // button released outside the window
      this._finishGesture();
      return;
    }
    const rect = this._pageEl.getBoundingClientRect();
    const scale = resolveScale(rect, this._info.W, this._info.scale);
    // Coalesced entries may lack pointerId (Safari 18.2): the parent event was already filtered.
    const coalesced = listFrom(e, 'getCoalescedEvents');
    const samples = [];
    for (const ev of coalesced.length ? coalesced : [e]) {
      const pending = g.pressurePending;
      const s = this._toSample(ev, g, rect, scale, true);
      if (!s) continue;
      if (pending && !g.pressurePending) for (const q of samples) q.p = s.p; // fallbacks of this batch
      samples.push(s);
    }
    const predicted = [];
    if (g.kind === 'ink') {
      for (const ev of listFrom(e, 'getPredictedEvents')) {
        const s = this._toSample(ev, g, rect, scale, false);
        if (s) predicted.push(s.x, s.y, s.p);
      }
    }
    this._feed(g, samples, predicted);
  }

  _onPointerUp(e) {
    const g = this._gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    const s = this._sampleFromEvent(e, g);
    if (s && g.kind === 'ink') g.stab.addEnd(s);
    else if (s) this._feed(g, [s], []);
    this._finishGesture();
  }

  _onPointerCancel(e) {
    const g = this._gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    // A cancelled finger is usually a rejected palm → discard. A cancelled pen keeps its partial ink.
    if (g.pointerType === 'touch') this._cancelGesture();
    else this._finishGesture();
  }

  _onLostCapture(e) {
    const g = this._gesture;
    if (!g || e.pointerId !== g.pointerId) return; // already finished by pointerup / pointercancel
    this._finishGesture();
  }

  _sampleFromEvent(e, g) {
    const rect = this._pageEl.getBoundingClientRect();
    return this._toSample(e, g, rect, resolveScale(rect, this._info.W, this._info.scale), true);
  }

  /**
   * One input sample: x, y in page logical units, pressure p, and for the ink stabilizer the client
   * coordinates (cx, cy), timestamp t and the page's client offset and scale.
   */
  _toSample(ev, g, rect, scale, updatePressure) {
    const { x, y } = clientToLogical(ev.clientX, ev.clientY, rect, scale);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const p = pointerPressure(g.pointerType, ev.pressure, g.lastP);
    if (updatePressure) {
      g.lastP = p;
      if (g.pressurePending && isFiniteNum(ev.pressure) && ev.pressure > 0) {
        // Until now every sample used the 0.5 fallback (pen-down reported 0): use the first real pressure.
        g.pressurePending = false;
        if (g.kind === 'ink') g.stab.setPressure(p);
      }
    }
    const s = isFiniteNum(scale) && scale > 0 ? scale : 1;
    return {
      x, y, p,
      cx: Number(ev.clientX),
      cy: Number(ev.clientY),
      t: ev.timeStamp,
      left: rect && isFiniteNum(rect.left) ? rect.left : 0,
      top: rect && isFiniteNum(rect.top) ? rect.top : 0,
      scale: s,
    };
  }

  // ------------------------------------------------------------------ gestures

  _beginInk(base, pt) {
    const tool = this._tool;
    const style = this._styles[tool];
    const g = {
      ...base, kind: 'ink', tool, color: style.color, size: style.size,
      stab: new InkStabilizer(pt), predicted: [], liveRect: null,
    };
    g.pad = penWidth(g, 1) / 2 + DIRTY_PAD;
    this._gesture = g;
    // The committed highlighter multiplies under the pens; on the live canvas (above the base) the same
    // look needs the canvas itself to multiply with what is below it.
    if (tool === 'highlighter') this._setLiveBlend('multiply');
    this._schedule('live');
  }

  _beginErase(base, pt) {
    const g = { ...base, kind: 'erase', x: pt.x, y: pt.y, erased: new Map() };
    this._gesture = g;
    this._eraseAt(g, pt.x, pt.y);
    this._schedule('live');
  }

  _beginLassoOrMove(base, pt) {
    const sel = this._selection;
    if (sel && pointInRect(pt.x, pt.y, sel.bbox, SELECTION_HIT_PAD_PX / this._info.scale)) {
      const strokes = this._strokesByIds(sel.ids);
      if (strokes.length) {
        this._gesture = { ...base, kind: 'move', x0: pt.x, y0: pt.y, dx: 0, dy: 0, active: false, strokes, bbox: sel.bbox };
        return;
      }
    }
    this._clearSelection(); // a tap or a new lasso outside the selection deselects
    this._gesture = { ...base, kind: 'lasso', pts: [pt.x, pt.y] };
    this._schedule('overlay');
  }

  _beginEvent(base, pt) {
    this._gesture = { ...base, kind: 'event', x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y, maxDist: 0, preview: null };
    this._schedule('live');
  }

  /** Feeds input samples (_toSample) and, for ink, flat [x, y, p, ...] predicted samples into the active gesture. */
  _feed(g, samples, predicted) {
    const n = samples.length;
    switch (g.kind) {
      case 'ink':
        for (const s of samples) g.stab.add(s);
        g.predicted = predicted;
        this._schedule('live');
        break;
      case 'erase': {
        for (const s of samples) {
          const along = samplePointsAlong(g.x, g.y, s.x, s.y, ERASER_RADIUS / 2);
          for (let j = 0; j + 1 < along.length; j += 2) this._eraseAt(g, along[j], along[j + 1]);
          g.x = s.x;
          g.y = s.y;
        }
        this._schedule('live');
        break;
      }
      case 'lasso':
        for (const s of samples) {
          if (shouldAppendPoint(g.pts, s.x, s.y, LASSO_MIN_STEP, 2)) g.pts.push(s.x, s.y);
        }
        this._schedule('overlay');
        break;
      case 'move': {
        if (n < 1) break;
        const rawDx = samples[n - 1].x - g.x0;
        const rawDy = samples[n - 1].y - g.y0;
        if (!g.active) {
          // Screen distance: at month scale (≈ 0.6) a few lu are only the drift of a Pencil tap.
          if (Math.hypot(rawDx, rawDy) * this._info.scale < MOVE_START_PX) break;
          g.active = true;
          for (const s of g.strokes) this._hidden.add(s.id);
          if (g.strokes.some((s) => s.tool === 'highlighter')) this._setLiveBlend('multiply');
          this._schedule('base');
        }
        const d = clampMoveDelta(g.bbox, rawDx, rawDy, this._info.W, this._info.H);
        g.dx = round1(d.dx);
        g.dy = round1(d.dy);
        this._schedule('live');
        this._schedule('overlay');
        break;
      }
      case 'event':
        for (const s of samples) {
          g.maxDist = Math.max(g.maxDist, Math.hypot(s.x - g.x0, s.y - g.y0));
          g.x1 = s.x;
          g.y1 = s.y;
        }
        this._schedule('live');
        break;
      default:
        break;
    }
  }

  /** Ends the active gesture normally (pointerup, pen pointercancel, tool switch …). */
  _finishGesture() {
    const g = this._gesture;
    if (!g) return;
    this._gesture = null;
    this._releaseCapture(g.pointerId);
    this._suppressClick = { until: Date.now() + CLICK_SUPPRESS_MS, pointerType: g.pointerType };
    try {
      switch (g.kind) {
        case 'ink': this._endInk(g); break;
        case 'erase': this._endErase(g); break;
        case 'lasso': this._endLasso(g); break;
        case 'move': this._endMove(g); break;
        case 'event': this._endEvent(g); break;
        default: break;
      }
    } catch (err) {
      warn('could not finish the gesture', err);
      this._hidden.clear();
      this._renderBaseNow();
    } finally {
      this._clearLive();
      this._setLiveBlend('');
      this._renderOverlay();
    }
  }

  /** Aborts the active gesture without changing the document (finger cancel, page change, destroy). */
  _cancelGesture() {
    const g = this._gesture;
    if (!g) return;
    this._gesture = null;
    this._releaseCapture(g.pointerId);
    if (g.kind === 'erase' || g.kind === 'move') {
      this._hidden.clear();
      this._renderBaseNow();
    } else if (g.kind === 'event') {
      this._askPreview(null);
    }
    this._clearLive();
    this._setLiveBlend('');
    this._renderOverlay();
  }

  _releaseCapture(pointerId) {
    try {
      if (this._pageEl.hasPointerCapture?.(pointerId)) this._pageEl.releasePointerCapture(pointerId);
    } catch { /* ignore */ }
  }

  _endInk(g) {
    const pts = finalizeStrokePoints(g.stab.finish());
    if (!pts.length) return;
    const stroke = makeStroke({ tool: g.tool, color: g.color, size: g.size, pts, t: Date.now() });
    this._commitOp({ type: 'add', strokes: [stroke] });
    this._clearLive();
    // Pens are drawn last (liveStrokes order), so a new pen stroke can go straight on top; a highlighter
    // must go under the pens → full redraw.
    if (g.tool === 'pen' && !this._hidden.size && !this._needs.base) this._drawOnBase(stroke);
    else this._renderBaseNow();
  }

  _endErase(g) {
    const strokes = [...g.erased.values()];
    this._hidden.clear();
    if (strokes.length) this._commitOp({ type: 'remove', strokes }); // one op per eraser gesture
    this._renderBaseNow();
  }

  _endLasso(g) {
    const closed = closeLassoPolygon(g.pts);
    if (!closed) return; // a tap: the selection was already cleared on pointerdown
    // A big lasso has thousands of vertices (one per 2 lu) and every stroke point is tested against all
    // of them: simplify the polygon and skip strokes outside its bounds so a dense page does not freeze.
    let poly = simplifyPolygon(closed, LASSO_SIMPLIFY_EPSILON);
    for (let eps = LASSO_SIMPLIFY_EPSILON * 2; poly.length > LASSO_MAX_VERTICES * 2 && eps <= 8; eps *= 2) {
      poly = simplifyPolygon(closed, eps);
    }
    const bounds = flatBounds(poly, 2);
    if (!bounds) return;
    const ids = [];
    for (const s of this._live()) {
      const b = this._bbox(s);
      if (b && !rectsOverlap(b, bounds)) continue;
      let inside = false;
      try { inside = strokeInLasso(s, poly, bounds); } catch { /* malformed stroke */ }
      if (inside) ids.push(s.id);
    }
    if (ids.length) this._setSelection(ids);
  }

  _endMove(g) {
    this._hidden.clear();
    const originals = g.strokes.filter((s) => this._isLive(s.id));
    if (!g.active || !originals.length || (g.dx === 0 && g.dy === 0)) {
      if (g.active) this._renderBaseNow();
      return;
    }
    const clones = cloneStrokes(originals, { dx: g.dx, dy: g.dy });
    this._commitOp({ type: 'batch', ops: [{ type: 'remove', strokes: originals }, { type: 'add', strokes: clones }] });
    this._renderBaseNow();
    this._clearLive();
    this._setSelection(clones.map((s) => s.id)); // the selection follows the clones
  }

  _endEvent(g) {
    this._clearLive();
    this._askPreview(null);
    const rect = normalizeRect(g.x0, g.y0, g.x1, g.y1);
    const tap = g.maxDist < EVENT_TAP_DISTANCE;
    const { onEventRect } = this._cb;
    if (typeof onEventRect === 'function') {
      try { onEventRect(rect, { tap }); } catch (err) { warn('onEventRect failed', err); }
    }
  }

  /**
   * Marks strokes touched by the eraser circle at (x, y) and schedules a redraw of just their area of
   * the base canvas; returns true if any new stroke was hit.
   */
  _eraseAt(g, x, y) {
    const r = ERASER_RADIUS;
    let hit = false;
    for (const s of this._live()) {
      if (g.erased.has(s.id)) continue;
      const b = this._bbox(s);
      if (b && (x < b.minX - r || x > b.maxX + r || y < b.minY - r || y > b.maxY + r)) continue;
      let touched = false;
      try { touched = strokeHitsCircle(s, x, y, r); } catch { /* malformed stroke */ }
      if (touched) {
        g.erased.set(s.id, s);
        this._hidden.add(s.id);
        this._scheduleBaseRect(b);
        hit = true;
      }
    }
    return hit;
  }

  _askPreview(rect) {
    const { onEventPreview } = this._cb;
    if (typeof onEventPreview !== 'function') return null;
    try {
      const r = onEventPreview(rect);
      return isRect(r) ? r : null;
    } catch (err) {
      warn('onEventPreview failed', err);
      return null;
    }
  }

  // ------------------------------------------------------------------ document changes & history

  _commitOp(op) {
    this._page = applyOp(this._page, op, Date.now());
    this._history.record(op);
    this._emitCommit(op);
  }

  _emitCommit(op) {
    const { onCommit } = this._cb;
    if (typeof onCommit !== 'function') return;
    try { onCommit(this._page, op); } catch (err) { warn('onCommit failed', err); }
  }

  /**
   * One undo / redo. A step that changes nothing visible — its strokes were already erased on another
   * device (remote merge) — is dropped and the next one is tried, so one press always changes something
   * and a later redo cannot bring back ink another device deleted.
   */
  _step(direction) {
    if (this._destroyed) return false;
    if (this._gesture) this._finishGesture();
    const history = this._history;
    for (;;) {
      const before = this._page;
      let after = before;
      let applied = null;
      try {
        applied = history[direction]((op) => { after = applyOp(before, op, Date.now()); });
      } catch (err) {
        warn(`${direction} failed`, err);
        return false;
      }
      if (!applied) return false;
      if (this._showsSameStrokes(after)) {
        if (direction === 'undo') history.discardLastRedo();
        else history.discardLastUndo();
        continue;
      }
      this._page = after;
      this._renderBaseNow();
      this._emitCommit(applied);
      this._reconcileSelection();
      return true;
    }
  }

  /** Whether `doc` shows the same strokes as the current page (same live ids; strokes are immutable). */
  _showsSameStrokes(doc) {
    if (doc === this._page) return true;
    let list = [];
    try { list = liveStrokes(doc); } catch (err) { warn('liveStrokes failed', err); return false; }
    const current = this._live();
    if (!Array.isArray(list) || list.length !== current.length) return false;
    const ids = new Set(current.map((s) => s.id));
    return list.every((s) => ids.has(s.id));
  }

  _normalizeSize(size, tool) {
    if (isFiniteNum(size) && size > 0) return clampNum(size, 0.5, 64);
    if (tool === 'pen' && typeof size === 'string' && isFiniteNum(PEN_SIZES?.[size])) return PEN_SIZES[size];
    return null;
  }

  _isLive(id) {
    const strokes = this._page && this._page.strokes;
    if (!strokes || typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(strokes, id) || !strokes[id]) return false;
    const deleted = this._page.deleted;
    return !(deleted && Object.prototype.hasOwnProperty.call(deleted, id));
  }

  /** Live strokes in draw order (highlighters first, then pens), cached per document. */
  _live() {
    if (this._liveFor !== this._page) {
      let list = [];
      try { list = liveStrokes(this._page); } catch (err) { warn('liveStrokes failed', err); }
      this._liveList = Array.isArray(list) ? list : [];
      this._liveFor = this._page;
    }
    return this._liveList;
  }

  /** Live strokes with the given ids, in draw order. */
  _strokesByIds(ids) {
    if (!ids || typeof ids[Symbol.iterator] !== 'function' || typeof ids === 'string') return [];
    const wanted = new Set();
    for (const id of ids) if (typeof id === 'string') wanted.add(id);
    if (!wanted.size) return [];
    return this._live().filter((s) => wanted.has(s.id));
  }

  _bbox(stroke) {
    let b = this._bboxCache.get(stroke);
    if (b === undefined) {
      try { b = strokeBBox(stroke); } catch { b = null; }
      if (!isRect(b)) b = null;
      this._bboxCache.set(stroke, b);
    }
    return b;
  }

  _unionBox(strokes) {
    const boxes = strokes.map((s) => this._bbox(s)).filter(Boolean);
    if (!boxes.length) return null;
    const u = unionBBox(boxes);
    return isRect(u) ? u : null;
  }

  // ------------------------------------------------------------------ selection

  _setSelection(ids) {
    const strokes = this._strokesByIds(ids);
    const bbox = strokes.length ? this._unionBox(strokes) : null;
    if (!bbox) {
      this._clearSelection();
      return;
    }
    this._selection = { ids: strokes.map((s) => s.id), bbox };
    this._renderOverlay();
    this._notifySelection();
  }

  _clearSelection() {
    if (this._gesture && this._gesture.kind === 'move') this._cancelGesture();
    if (!this._selection) return;
    this._selection = null;
    this._renderOverlay();
    this._notifySelection();
  }

  /** Drops strokes that are no longer live (remote removal, undo) from the selection. */
  _reconcileSelection() {
    const sel = this._selection;
    if (!sel) return;
    const live = sel.ids.filter((id) => this._isLive(id));
    if (live.length === sel.ids.length) return;
    if (this._gesture && this._gesture.kind === 'move') this._cancelGesture();
    if (live.length) this._setSelection(live);
    else this._clearSelection();
  }

  _notifySelection() {
    this._needs.notify = false;
    const { onSelectionChange } = this._cb;
    if (typeof onSelectionChange !== 'function') return;
    try { onSelectionChange(this.getSelection()); } catch (err) { warn('onSelectionChange failed', err); }
  }

  // ------------------------------------------------------------------ rendering

  _schedule(what) {
    if (this._destroyed) return;
    this._needs[what] = true;
    if (this._frameId !== null) return;
    const w = this._win;
    if (typeof w.requestAnimationFrame === 'function') {
      this._frameIsTimeout = false;
      this._frameId = w.requestAnimationFrame(this._frame);
    } else {
      this._frameIsTimeout = true;
      this._frameId = setTimeout(this._frame, 16);
    }
  }

  _cancelFrame() {
    if (this._frameId === null) return;
    if (this._frameIsTimeout) clearTimeout(this._frameId);
    else this._win.cancelAnimationFrame?.(this._frameId);
    this._frameId = null;
  }

  _frame() {
    this._frameId = null;
    if (this._destroyed) return;
    const needs = this._needs;
    this._needs = { base: false, baseRect: false, live: false, overlay: false, notify: false };
    try {
      if (needs.base) this._renderBase();
      else if (needs.baseRect) this._renderBaseRect();
      if (needs.live) this._renderLive();
      if (needs.overlay) this._renderOverlay();
      if (needs.notify) this._notifySelection();
    } catch (err) {
      warn('render failed', err);
    }
  }

  _clearCtx(ctx, canvas) {
    if (!ctx) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  _clearLive() {
    this._clearCtx(this._liveCtx, this._liveCanvas);
  }

  /** Device-pixel rect [x0, x1) × [y0, y1) of the canvas covering a logical rect, or null if empty. */
  _devicePxRect(canvas, rect) {
    if (!isRect(rect)) return null;
    const x0 = Math.max(0, Math.floor(rect.minX * this._sx));
    const y0 = Math.max(0, Math.floor(rect.minY * this._sy));
    const x1 = Math.min(canvas.width, Math.ceil(rect.maxX * this._sx));
    const y1 = Math.min(canvas.height, Math.ceil(rect.maxY * this._sy));
    return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
  }

  /** mix-blend-mode of the live canvas ('' = normal). */
  _setLiveBlend(mode) {
    if (this._liveBlend === mode || !this._liveCanvas) return;
    this._liveBlend = mode;
    try { this._liveCanvas.style.mixBlendMode = mode; } catch { /* unsupported */ }
  }

  _renderBaseNow() {
    this._needs.base = false;
    this._renderBase();
  }

  _renderBase() {
    this._baseDirty = null; // covered by the full redraw
    const ctx = this._baseCtx;
    if (!ctx) return;
    this._clearCtx(ctx, this._baseCanvas);
    let strokes = this._live();
    if (this._hidden.size) strokes = strokes.filter((s) => !this._hidden.has(s.id));
    if (!strokes.length) return;
    ctx.save();
    try { drawStrokes(ctx, strokes); } catch (err) { warn('drawStrokes failed', err); }
    ctx.restore();
  }

  /** Redraws only `rect` (logical, merged with other pending rects) of the base canvas in the next frame. */
  _scheduleBaseRect(rect) {
    if (!isRect(rect)) {
      this._schedule('base');
      return;
    }
    const d = this._baseDirty;
    this._baseDirty = d ? unionBBox([d, rect]) : { minX: rect.minX, minY: rect.minY, maxX: rect.maxX, maxY: rect.maxY };
    this._schedule('baseRect');
  }

  /**
   * Partial base redraw (eraser frames): clears the pending dirty rect and redraws, clipped to it, the
   * visible strokes that overlap it, in draw order. Pixel-aligned clip → same pixels as a full redraw.
   */
  _renderBaseRect() {
    const rect = this._baseDirty;
    this._baseDirty = null;
    const ctx = this._baseCtx;
    if (!ctx || !rect) return;
    const px = this._devicePxRect(this._baseCanvas, {
      minX: rect.minX - DIRTY_PAD, minY: rect.minY - DIRTY_PAD, maxX: rect.maxX + DIRTY_PAD, maxY: rect.maxY + DIRTY_PAD,
    });
    if (!px) return;
    const clip = { minX: px.x0 / this._sx, minY: px.y0 / this._sy, maxX: px.x1 / this._sx, maxY: px.y1 / this._sy };
    const strokes = this._live().filter((s) => {
      if (this._hidden.has(s.id)) return false;
      const b = this._bbox(s);
      return !b || rectsOverlap(b, clip);
    });
    ctx.save();
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(px.x0, px.y0, px.x1 - px.x0, px.y1 - px.y0);
      ctx.beginPath();
      ctx.rect(px.x0, px.y0, px.x1 - px.x0, px.y1 - px.y0);
      ctx.clip();
      ctx.setTransform(this._sx, 0, 0, this._sy, 0, 0);
      if (strokes.length) drawStrokes(ctx, strokes);
    } catch (err) {
      warn('drawStrokes failed', err);
    }
    ctx.restore();
  }

  _drawOnBase(stroke) {
    const ctx = this._baseCtx;
    if (!ctx) return;
    ctx.save();
    try { drawStroke(ctx, stroke); } catch (err) { warn('drawStroke failed', err); }
    ctx.restore();
  }

  _renderLive() {
    const ctx = this._liveCtx;
    const g = this._gesture;
    if (!ctx) return;
    if (!g) {
      this._clearLive();
      return;
    }
    switch (g.kind) {
      case 'ink': this._renderLiveInk(ctx, g); break;
      case 'erase': this._renderEraserCursor(ctx, g); break;
      case 'move': this._renderMovePreview(ctx, g); break;
      case 'event': this._renderEventPreview(ctx, g); break;
      default: this._clearLive(); break;
    }
  }

  /**
   * In-progress pen / highlighter stroke: each frame redraws the whole partial stroke (plus the
   * predicted samples) with drawLiveStroke — the same outline pipeline as the committed stroke, so the
   * ink does not change shape when the Pencil lifts, and a highlighter never darkens itself. The partial
   * stroke is InkStabilizer.preview(): the stored points so far, the not-yet-final samples estimated
   * provisionally, and the pen's current position — exactly what finish() returns if the pen lifts now.
   * Only the area the previous frame drew is cleared.
   */
  _renderLiveInk(ctx, g) {
    const prev = g.liveRect ? this._devicePxRect(this._liveCanvas, g.liveRect) : null;
    if (prev) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(prev.x0, prev.y0, prev.x1 - prev.x0, prev.y1 - prev.y0);
      ctx.restore();
    } else {
      this._clearLive();
    }
    const stroke = g.stab.preview();
    const pts = g.predicted.length ? stroke.concat(g.predicted) : stroke;
    g.liveRect = flatBounds(pts, 3, g.pad);
    ctx.save();
    try {
      drawLiveStroke(ctx, { tool: g.tool, color: g.color, size: g.size, pts });
    } catch (err) {
      warn('drawLiveStroke failed', err);
    }
    ctx.restore();
  }

  _renderEraserCursor(ctx, g) {
    this._clearLive();
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(g.x, g.y, ERASER_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.fill();
    ctx.lineWidth = 1.5 / this._info.scale;
    ctx.strokeStyle = 'rgba(31, 41, 55, 0.75)';
    ctx.stroke();
    ctx.restore();
  }

  _renderMovePreview(ctx, g) {
    this._clearLive();
    if (!g.active) return;
    ctx.save();
    ctx.translate(g.dx, g.dy);
    try { drawStrokes(ctx, g.strokes); } catch (err) { warn('drawStrokes failed', err); }
    ctx.restore();
  }

  _renderEventPreview(ctx, g) {
    this._clearLive();
    const raw = normalizeRect(g.x0, g.y0, g.x1, g.y1);
    const snapped = this._askPreview(raw);
    g.preview = snapped || (raw.maxX > raw.minX && raw.maxY > raw.minY ? raw : null);
    const r = g.preview;
    if (!r || this._gesture !== g) return; // the preview callback may have ended the gesture
    const w = r.maxX - r.minX;
    const h = r.maxY - r.minY;
    if (!(w > 0) || !(h > 0)) return;
    const px = 1 / this._info.scale;
    ctx.save();
    ctx.globalAlpha = 1;
    roundRectPath(ctx, r.minX, r.minY, w, h, 6 * px);
    ctx.fillStyle = 'rgba(37, 99, 235, 0.18)';
    ctx.fill();
    ctx.lineWidth = 1.5 * px;
    ctx.strokeStyle = 'rgba(37, 99, 235, 0.85)';
    ctx.stroke();
    ctx.restore();
  }

  _applyOverlayMetrics() {
    const { W, H, scale } = this._info;
    const px = 1 / scale; // lu per screen px: keeps overlay lines 1.5 px regardless of zoom
    this._overlay.setAttribute('viewBox', `0 0 ${fmt(W)} ${fmt(H)}`);
    for (const el of [this._lassoEl, this._selRectEl]) {
      el.setAttribute('stroke-width', fmt(1.5 * px));
      el.setAttribute('stroke-dasharray', `${fmt(6 * px)} ${fmt(4 * px)}`);
    }
    this._selRectEl.setAttribute('rx', fmt(4 * px));
  }

  _renderOverlay() {
    this._needs.overlay = false;
    if (!this._overlay) return;
    const g = this._gesture;
    if (g && g.kind === 'lasso' && g.pts.length >= 4) {
      let points = '';
      for (let i = 0; i + 1 < g.pts.length; i += 2) points += `${g.pts[i].toFixed(1)},${g.pts[i + 1].toFixed(1)} `;
      this._lassoEl.setAttribute('points', points.trim());
      this._lassoEl.style.display = '';
    } else {
      this._lassoEl.style.display = 'none';
    }
    const sel = this._selection;
    if (sel) {
      const r = g && g.kind === 'move' && g.active ? translateRect(sel.bbox, g.dx, g.dy) : sel.bbox;
      const pad = SELECTION_PAD_PX / this._info.scale;
      this._selRectEl.setAttribute('x', fmt(r.minX - pad));
      this._selRectEl.setAttribute('y', fmt(r.minY - pad));
      this._selRectEl.setAttribute('width', fmt(r.maxX - r.minX + 2 * pad));
      this._selRectEl.setAttribute('height', fmt(r.maxY - r.minY + 2 * pad));
      this._selRectEl.style.display = '';
    } else {
      this._selRectEl.style.display = 'none';
    }
  }
}
