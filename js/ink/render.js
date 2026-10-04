/**
 * Ink rendering (module B).
 *
 * Pen strokes are filled outlines. The stored points go through five steps first:
 *  1. Midpoint-quadratic curve through the points. A stored point stays a sharp corner only when
 *     the turn is sharper than 75° AND both neighbouring segments are long (≥ max(3 lu, 1.5 ×
 *     stroke width)): a V drawn with few samples keeps its tip, a 1-px step never does.
 *  2. The curve is resampled every RESAMPLE_STEP (1 lu) of arc length.
 *  3. Corners of densely sampled strokes are found at the same scale: the direction over one leg
 *     length before and after a sample turns by more than 75°, and the turn is concentrated at the
 *     sample (half the window shows most of the turn) instead of spread along a tight curve.
 *  4. Between corners the samples are smoothed with a Gaussian (σ = SMOOTH_SIGMA, in lu — so about
 *     0.7 CSS px on the month page, up to 1.6 on the day page) whose ends are pinned by point reflection,
 *     so the stroke ends and the corners stay where they were. This removes digitizer jitter and the
 *     kinks of the 1-CSS-px staircase of WebKit's whole-pixel Pencil coordinates (iPadOS ≤ 26.1, WebKit
 *     bug 133180). New strokes (1.0.5) are already reconstructed from those coordinates when they are
 *     written (InkStabilizer in surface.js), so they come out smooth. Strokes saved before 1.0.5 keep
 *     their whole-pixel points: their kinks are gone, but on shallow lines (the staircase's period is
 *     far longer than σ) a gentle wave of up to about 0.4 CSS px remains (the raw staircase: ±0.5 px).
 *  5. The pressure-based width is smoothed over ≈ 6 lu of arc length and slope-limited (no blobs).
 * The outline is one closed polygon with round caps at both ends, round outer joins and inner joins
 * through the centre point (the Skia stroker's approach; gentle bends use a single bisector vertex
 * per side), so sharp turns never produce spikes. Fill it with the non-zero rule: self-overlaps are
 * simply covered twice. Every polygon winds the same way, so several pen strokes of one colour can
 * share one fill.
 *
 * Highlighter strokes follow the same smoothed path: a single constant-width polyline with round
 * caps/joins, stroked once with globalAlpha HIGHLIGHTER_ALPHA and 'multiply' compositing, so a
 * stroke never darkens itself.
 *
 * strokeOutline() is pure and runs in Node. Drawing only uses basic CanvasRenderingContext2D calls
 * (save/restore, beginPath, moveTo, lineTo, arc, fill, stroke), so it can be tested with a recording
 * fake context. Nothing touches the DOM at module load.
 */

export const PEN_COLORS = ['#1f2937', '#2563eb', '#dc2626', '#16a34a', '#ea580c', '#7c3aed'];
export const HIGHLIGHTER_COLORS = ['#fde047', '#f9a8d4', '#86efac', '#93c5fd'];
export const PEN_SIZES = { thin: 2, medium: 3.5, thick: 6 }; // base width in lu
export const HIGHLIGHTER_SIZE = 18;
export const HIGHLIGHTER_ALPHA = 0.35;

const DEFAULT_PEN_COLOR = PEN_COLORS[0];
const DEFAULT_HL_COLOR = HIGHLIGHTER_COLORS[0];
const MAX_SIZE = 1000;
const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

// Outline tuning (all in logical units).
const MIN_STEP = 0.2; // stored points closer than this to the previous kept point are jitter
const MIN_STEP_SQ = MIN_STEP * MIN_STEP;
const RESAMPLE_STEP = 1; // arc length between centreline samples before smoothing
const SMOOTH_SIGMA = 1.2; // Gaussian σ of the centreline smoothing
const SMOOTH_REACH = 2.5; // the kernel is cut off at ±2.5 σ
const MAX_TAPS = 32; // kernel half-width limit (taps per side)
const CORNER_MIN_LEG = 3; // a corner needs straight-ish legs at least this long on both sides …
const CORNER_LEG_WIDTHS = 1.5; // … and at least 1.5 × the nominal stroke width
const CORNER_DOT = Math.cos((75 * Math.PI) / 180); // turns sharper than 75° can be corners
const CORNER_CONCENTRATION = 0.8; // half the window must show ≥ 80 % of the turn (not a tight curve)
const MIN_RADIUS = 0.2; // never thinner than this
const WIDTH_SMOOTHING = 6; // arc length (lu) of the pressure/width low-pass filter
const RADIUS_SLOPE = 0.35; // max |d radius / d length| — removes pressure blobs and pinches
const FLATNESS = 0.04; // max chord error when flattening curves and arcs
const SIMPLIFY_TOL = 0.02; // a sample this close to the chord of its neighbours (and radius) is dropped
const MAX_SUBDIV = 16; // max sub-segments per smoothed curve piece
const DEDUPE_SQ = 1e-8; // centreline points closer than 1e-4 lu are merged
const GENTLE_DOT = Math.cos((30 * Math.PI) / 180); // smaller turns: one bisector vertex per side (≤ 3.5 % thinner)
const TAU = Math.PI * 2;
const MAX_BATCH_VERTICES = 20000; // drawStrokes: max outline vertices per batched fill

// ---------------------------------------------------------------------------------------------
// Scratch buffers, reused between calls so the hot loops do not allocate.
// (JS is single-threaded and every function below finishes synchronously.)
// ---------------------------------------------------------------------------------------------

class PointBuf {
  constructor(capacity, withRadius, withFlags = false) {
    this.x = new Float64Array(capacity);
    this.y = new Float64Array(capacity);
    this.r = withRadius ? new Float64Array(capacity) : null;
    this.f = withFlags ? new Uint8Array(capacity) : null; // flag (corner / end)
    this.s = withFlags ? new Int32Array(capacity) : null; // source: index of the stored point it came from
    this.n = 0;
  }

  grow() {
    const cap = this.x.length * 2;
    const nx = new Float64Array(cap);
    const ny = new Float64Array(cap);
    nx.set(this.x);
    ny.set(this.y);
    this.x = nx;
    this.y = ny;
    if (this.r) {
      const nr = new Float64Array(cap);
      nr.set(this.r);
      this.r = nr;
    }
    if (this.f) {
      const nf = new Uint8Array(cap);
      nf.set(this.f);
      this.f = nf;
      const ns = new Int32Array(cap);
      ns.set(this.s);
      this.s = ns;
    }
  }

  push(x, y) {
    if (this.n === this.x.length) this.grow();
    this.x[this.n] = x;
    this.y[this.n] = y;
    this.n++;
  }

  push3(x, y, r) {
    if (this.n === this.x.length) this.grow();
    this.x[this.n] = x;
    this.y[this.n] = y;
    this.r[this.n] = r;
    this.n++;
  }

  push4(x, y, r, f, src) {
    if (this.n === this.x.length) this.grow();
    this.x[this.n] = x;
    this.y[this.n] = y;
    this.r[this.n] = r;
    this.f[this.n] = f;
    this.s[this.n] = src;
    this.n++;
  }
}

const RAW = new PointBuf(256, true); // filtered input points + radius
const CURVE = new PointBuf(512, true, true); // midpoint-quadratic curve (flattened) + radius; f = corner
const SAMP = new PointBuf(512, true, true); // curve resampled every ~1 lu, then smoothed; f = corner / end
const TMP = new PointBuf(512, false); // smoothing output
const LINE = new PointBuf(512, true); // final centreline + radius
const DIR = new PointBuf(512, true); // per centreline segment: unit direction (x, y) + length (r)
const SIDE_A = new PointBuf(512, false); // offset side +normal, forward order
const SIDE_B = new PointBuf(512, false); // offset side −normal, forward order
const OUT = new PointBuf(1024, false); // final polygon
const WEIGHTS = new Float64Array(MAX_TAPS + 1);
let rawMaxRadius = 0;
let rawMinX = 0;
let rawMinY = 0;
let rawMaxX = 0;
let rawMaxY = 0;

// ---------------------------------------------------------------------------------------------
// Width / style helpers
// ---------------------------------------------------------------------------------------------

function sizeOf(stroke) {
  const s = stroke ? stroke.size : undefined;
  if (Number.isFinite(s) && s > 0) return Math.min(s, MAX_SIZE);
  return stroke && stroke.tool === 'highlighter' ? HIGHLIGHTER_SIZE : PEN_SIZES.medium;
}

function clampPressure(p) {
  if (!Number.isFinite(p)) return 0.5;
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

function colorOf(stroke) {
  const c = stroke.color;
  if (typeof c === 'string' && COLOR_RE.test(c)) return c;
  return stroke.tool === 'highlighter' ? DEFAULT_HL_COLOR : DEFAULT_PEN_COLOR;
}

/**
 * Stroke width at a pressure. pen: size * (0.4 + 0.9 * p) ; highlighter: size.
 * Missing/invalid pressure counts as 0.5; it is clamped to 0..1.
 */
export function widthAt(stroke, pressure) {
  const size = sizeOf(stroke);
  if (stroke && stroke.tool === 'highlighter') return size;
  return size * (0.4 + 0.9 * clampPressure(pressure));
}

/** Minimum leg length (lu) on both sides of a corner: max(3 lu, 1.5 × the width at pressure 0.5). */
function cornerLeg(stroke) {
  return Math.max(CORNER_MIN_LEG, CORNER_LEG_WIDTHS * widthAt(stroke, 0.5));
}

// ---------------------------------------------------------------------------------------------
// Geometry pipeline: raw points → curve → resampled, smoothed centreline (with radii) → outline
// ---------------------------------------------------------------------------------------------

/**
 * Reads the valid points of stroke.pts into RAW (x, y, radius), skipping jitter closer than
 * MIN_STEP. `constRadius` > 0 forces a constant radius (highlighter).
 * Sets rawMaxRadius (max over all valid points, including skipped ones) and the points' bounds.
 * Returns RAW.n.
 */
function readRaw(stroke, constRadius) {
  RAW.n = 0;
  rawMaxRadius = 0;
  const pts = stroke.pts;
  if (!pts || typeof pts !== 'object' || typeof pts.length !== 'number') return 0;
  const half = sizeOf(stroke) / 2;
  const count = Math.floor(pts.length / 3);
  let lx = 0;
  let ly = 0;
  for (let i = 0; i < count; i++) {
    const x = pts[i * 3];
    const y = pts[i * 3 + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const r = constRadius > 0 ? constRadius : half * (0.4 + 0.9 * clampPressure(pts[i * 3 + 2]));
    if (r > rawMaxRadius) rawMaxRadius = r;
    if (RAW.n > 0) {
      const dx = x - lx;
      const dy = y - ly;
      if (dx * dx + dy * dy < MIN_STEP_SQ) continue;
      if (x < rawMinX) rawMinX = x;
      else if (x > rawMaxX) rawMaxX = x;
      if (y < rawMinY) rawMinY = y;
      else if (y > rawMaxY) rawMaxY = y;
    } else {
      rawMinX = x;
      rawMaxX = x;
      rawMinY = y;
      rawMaxY = y;
    }
    RAW.push3(x, y, r);
    lx = x;
    ly = y;
  }
  return RAW.n;
}

/**
 * True when the stored polyline keeps a sharp corner at point i: it turns by more than 75° and
 * both neighbouring segments are at least `leg` long (sparse samples of a real corner; the short
 * steps of a pixel staircase or of jitter never qualify).
 */
function isRawCorner(i, leg) {
  const X = RAW.x;
  const Y = RAW.y;
  const ax = X[i] - X[i - 1];
  const ay = Y[i] - Y[i - 1];
  const bx = X[i + 1] - X[i];
  const by = Y[i + 1] - Y[i];
  const la = ax * ax + ay * ay;
  const lb = bx * bx + by * by;
  const leg2 = leg * leg;
  if (la < leg2 || lb < leg2) return false;
  return ax * bx + ay * by < CORNER_DOT * Math.sqrt(la * lb);
}

function emitCurve(x, y, r, corner, src) {
  const n = CURVE.n;
  if (n > 0) {
    const dx = x - CURVE.x[n - 1];
    const dy = y - CURVE.y[n - 1];
    if (dx * dx + dy * dy < DEDUPE_SQ) {
      if (corner) CURVE.f[n - 1] = 1;
      return;
    }
  }
  CURVE.push4(x, y, r, corner ? 1 : 0, src);
}

/** Number of chords for a quadratic whose second difference has length dd (error ≤ FLATNESS). */
function subdivisions(dd) {
  if (dd <= 4 * FLATNESS) return 1;
  const k = Math.ceil(Math.sqrt(dd / (4 * FLATNESS)));
  return k > MAX_SUBDIV ? MAX_SUBDIV : k;
}

/**
 * Midpoint-quadratic curve: p0 → m0 (line), m(i-1) → m(i) with control p(i), m(n-2) → p(n-1).
 * Radii follow the same Bézier weights. Corners are kept: m(i-1) → p(i) → m(i), with p(i) flagged.
 * Both ends are flagged too. Fills CURVE; returns CURVE.n.
 */
function buildCurve(n, leg) {
  CURVE.n = 0;
  const X = RAW.x;
  const Y = RAW.y;
  const R = RAW.r;
  emitCurve(X[0], Y[0], R[0], true, 0);
  if (n === 2) {
    emitCurve(X[1], Y[1], R[1], true, 1);
    return CURVE.n;
  }
  let mx = (X[0] + X[1]) / 2;
  let my = (Y[0] + Y[1]) / 2;
  let mr = (R[0] + R[1]) / 2;
  emitCurve(mx, my, mr, false, 0);
  for (let i = 1; i <= n - 2; i++) {
    const px = X[i];
    const py = Y[i];
    const pr = R[i];
    const nx = (X[i] + X[i + 1]) / 2;
    const ny = (Y[i] + Y[i + 1]) / 2;
    const nr = (R[i] + R[i + 1]) / 2;
    if (isRawCorner(i, leg)) {
      emitCurve(px, py, pr, true, i);
      emitCurve(nx, ny, nr, false, i);
    } else {
      const ddx = mx - 2 * px + nx;
      const ddy = my - 2 * py + ny;
      const k = subdivisions(Math.sqrt(ddx * ddx + ddy * ddy));
      for (let j = 1; j <= k; j++) {
        const t = j / k;
        const u = 1 - t;
        const a = u * u;
        const b = 2 * u * t;
        const c = t * t;
        emitCurve(a * mx + b * px + c * nx, a * my + b * py + c * ny, a * mr + b * pr + c * nr, false, i);
      }
    }
    mx = nx;
    my = ny;
    mr = nr;
  }
  emitCurve(X[n - 1], Y[n - 1], R[n - 1], true, n - 1);
  CURVE.f[CURVE.n - 1] = 1;
  return CURVE.n;
}

/**
 * Resamples the curve between consecutive flagged points (ends / corners) at a uniform spacing of
 * at most RESAMPLE_STEP, flagged points included exactly. Fills SAMP; returns SAMP.n.
 */
function resampleCurve() {
  SAMP.n = 0;
  const cx = CURVE.x;
  const cy = CURVE.y;
  const cr = CURVE.r;
  const cf = CURVE.f;
  const m = CURVE.n;
  SAMP.push4(cx[0], cy[0], cr[0], 1, CURVE.s[0]);
  let a = 0;
  while (a < m - 1) {
    let b = a + 1;
    while (b < m - 1 && !cf[b]) b++;
    let length = 0;
    for (let j = a; j < b; j++) length += Math.hypot(cx[j + 1] - cx[j], cy[j + 1] - cy[j]);
    const steps = Math.max(1, Math.ceil(length / RESAMPLE_STEP - 1e-9));
    const h = length / steps;
    // Walk the polyline a..b and drop a sample every h.
    let seg = a;
    let segStart = 0; // arc length at curve point `seg`
    let segLen = Math.hypot(cx[seg + 1] - cx[seg], cy[seg + 1] - cy[seg]);
    for (let s = 1; s < steps; s++) {
      const target = s * h;
      while (segStart + segLen < target && seg < b - 1) {
        segStart += segLen;
        seg++;
        segLen = Math.hypot(cx[seg + 1] - cx[seg], cy[seg + 1] - cy[seg]);
      }
      let t = segLen > 0 ? (target - segStart) / segLen : 0;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      SAMP.push4(
        cx[seg] + t * (cx[seg + 1] - cx[seg]),
        cy[seg] + t * (cy[seg + 1] - cy[seg]),
        cr[seg] + t * (cr[seg + 1] - cr[seg]),
        0,
        CURVE.s[t < 0.5 ? seg : seg + 1],
      );
    }
    SAMP.push4(cx[b], cy[b], cr[b], 1, CURVE.s[b]);
    a = b;
  }
  return SAMP.n;
}

/** Turn between (q[i] − q[i−k]) and (q[i+k] − q[i]) as cos (−1..1); 1 when degenerate. */
function turnCos(i, k) {
  const X = SAMP.x;
  const Y = SAMP.y;
  const ax = X[i] - X[i - k];
  const ay = Y[i] - Y[i - k];
  const bx = X[i + k] - X[i];
  const by = Y[i + k] - Y[i];
  const l = Math.sqrt((ax * ax + ay * ay) * (bx * bx + by * by));
  return l > 0 ? (ax * bx + ay * by) / l : 1;
}

/**
 * Corners of densely sampled strokes, between samples a and b (flagged ends, uniform spacing h):
 * the turn over `leg` before/after a sample exceeds 75° and is concentrated at the sample (the
 * half-length window turns by ≥ CORNER_CONCENTRATION of it). One corner (the sharpest) per run.
 */
function markCorners(a, b, h, leg) {
  const k = Math.ceil(leg / h - 1e-9);
  if (b - a < 2 * k) return;
  const k2 = Math.max(1, Math.round(k / 2));
  const F = SAMP.f;
  let best = -1;
  let bestCos = 2;
  for (let i = a + k; i <= b - k + 1; i++) {
    const c = i <= b - k ? turnCos(i, k) : 2; // the extra step closes the last run
    if (c < CORNER_DOT) {
      const angle = Math.acos(c);
      const half = Math.acos(Math.max(-1, Math.min(1, turnCos(i, k2))));
      if (half >= CORNER_CONCENTRATION * angle && c < bestCos) {
        best = i;
        bestCos = c;
      }
      continue;
    }
    if (best >= 0) pinCorner(best);
    best = -1;
    bestCos = 2;
  }
}

/**
 * Makes sample i a corner. The curve has rounded the stored corner point slightly (midpoint
 * quadratics): the corner goes back onto that stored point when it is within one resample step.
 */
function pinCorner(i) {
  SAMP.f[i] = 1;
  const src = SAMP.s[i];
  const dx = RAW.x[src] - SAMP.x[i];
  const dy = RAW.y[src] - SAMP.y[i];
  if (dx * dx + dy * dy <= RESAMPLE_STEP * RESAMPLE_STEP) {
    SAMP.x[i] = RAW.x[src];
    SAMP.y[i] = RAW.y[src];
  }
}

/** Normalised Gaussian half-kernel for spacing h into WEIGHTS; returns the number of taps per side. */
function gaussianWeights(h, maxTaps) {
  let taps = Math.ceil((SMOOTH_REACH * SMOOTH_SIGMA) / h);
  if (taps > maxTaps) taps = maxTaps;
  if (taps > MAX_TAPS) taps = MAX_TAPS;
  const inv = (h * h) / (2 * SMOOTH_SIGMA * SMOOTH_SIGMA);
  let total = 1;
  WEIGHTS[0] = 1;
  for (let t = 1; t <= taps; t++) {
    WEIGHTS[t] = Math.exp(-t * t * inv);
    total += 2 * WEIGHTS[t];
  }
  for (let t = 0; t <= taps; t++) WEIGHTS[t] /= total;
  return taps;
}

/**
 * Gaussian smoothing of SAMP[a..b] (positions only; uniform spacing h). Samples outside the run are
 * point reflections of the run through its end points, so both ends stay exactly in place, a
 * straight run stays straight, and the smoothing stays at full strength up to the ends.
 * The result is clamped to the stored points' bounds (strokeBBox always contains the outline).
 */
function smoothRun(a, b, h) {
  if (b - a < 2) return;
  const taps = gaussianWeights(h, b - a);
  if (taps < 1) return;
  const X = SAMP.x;
  const Y = SAMP.y;
  TMP.n = 0;
  while (TMP.x.length < b - a + 1) TMP.grow();
  const xa = X[a];
  const ya = Y[a];
  const xb = X[b];
  const yb = Y[b];
  for (let j = a + 1; j < b; j++) {
    let sx = WEIGHTS[0] * X[j];
    let sy = WEIGHTS[0] * Y[j];
    for (let t = 1; t <= taps; t++) {
      const w = WEIGHTS[t];
      let i = j - t;
      if (i >= a) {
        sx += w * X[i];
        sy += w * Y[i];
      } else {
        i = 2 * a - i;
        sx += w * (2 * xa - X[i]);
        sy += w * (2 * ya - Y[i]);
      }
      i = j + t;
      if (i <= b) {
        sx += w * X[i];
        sy += w * Y[i];
      } else {
        i = 2 * b - i;
        sx += w * (2 * xb - X[i]);
        sy += w * (2 * yb - Y[i]);
      }
    }
    TMP.x[j - a] = sx < rawMinX ? rawMinX : sx > rawMaxX ? rawMaxX : sx;
    TMP.y[j - a] = sy < rawMinY ? rawMinY : sy > rawMaxY ? rawMaxY : sy;
  }
  for (let j = a + 1; j < b; j++) {
    X[j] = TMP.x[j - a];
    Y[j] = TMP.y[j - a];
  }
}

/**
 * Finds the corners of every run between flagged samples, then smooths each run between corners.
 */
function smoothSamples(leg) {
  const X = SAMP.x;
  const Y = SAMP.y;
  const F = SAMP.f;
  const n = SAMP.n;
  // Pass 1: corners of dense input, run by run (a run has uniform spacing).
  let a = 0;
  while (a < n - 1) {
    let b = a + 1;
    while (b < n - 1 && !F[b]) b++;
    const h = Math.hypot(X[a + 1] - X[a], Y[a + 1] - Y[a]);
    if (b - a >= 2 && h > 0) markCorners(a, b, h, leg);
    a = b;
  }
  // Pass 2: smooth between flagged samples.
  a = 0;
  while (a < n - 1) {
    let b = a + 1;
    while (b < n - 1 && !F[b]) b++;
    if (b - a >= 2) {
      // Spacing before smoothing: the run's chord length per step along its polyline.
      let length = 0;
      for (let j = a; j < b; j++) length += Math.hypot(X[j + 1] - X[j], Y[j + 1] - Y[j]);
      smoothRun(a, b, length / (b - a));
    }
    a = b;
  }
}

/**
 * Smooths the radii along the arc length (forward + backward exponential filter, averaged:
 * no lag, independent of the sample spacing). Takes the edge off pressure spikes (blobs).
 * Uses TMP.x as temporary storage for the forward pass.
 */
function smoothRadii(n) {
  const X = SAMP.x;
  const Y = SAMP.y;
  const R = SAMP.r;
  while (TMP.x.length < n) TMP.grow();
  const fwd = TMP.x;
  fwd[0] = R[0];
  for (let i = 1; i < n; i++) {
    const a = smoothingAlpha(X[i] - X[i - 1], Y[i] - Y[i - 1]);
    fwd[i] = fwd[i - 1] + a * (R[i] - fwd[i - 1]);
  }
  let back = R[n - 1];
  R[n - 1] = (fwd[n - 1] + back) / 2;
  for (let i = n - 2; i >= 0; i--) {
    const a = smoothingAlpha(X[i + 1] - X[i], Y[i + 1] - Y[i]);
    back += a * (R[i] - back);
    R[i] = (fwd[i] + back) / 2;
  }
}

/** EMA weight for a step of length |(dx, dy)|: 1 − exp(−d / WIDTH_SMOOTHING). */
function smoothingAlpha(dx, dy) {
  return 1 - Math.exp(-Math.sqrt(dx * dx + dy * dy) / WIDTH_SMOOTHING);
}

function emitLine(x, y, r) {
  const n = LINE.n;
  if (n > 0) {
    const dx = x - LINE.x[n - 1];
    const dy = y - LINE.y[n - 1];
    if (dx * dx + dy * dy < DEDUPE_SQ) return;
  }
  LINE.push3(x, y, r < MIN_RADIUS ? MIN_RADIUS : r);
}

/**
 * Copies SAMP into LINE, dropping samples that lie on the chord from the last kept sample to the
 * next one (and whose radius is on its linear interpolation): straight parts need no vertices.
 * Corners and ends are always kept. Returns LINE.n.
 */
function simplifyInto(n) {
  LINE.n = 0;
  const X = SAMP.x;
  const Y = SAMP.y;
  const R = SAMP.r;
  const F = SAMP.f;
  emitLine(X[0], Y[0], R[0]);
  for (let i = 1; i < n - 1; i++) {
    if (!F[i]) {
      const k = LINE.n - 1;
      const ax = LINE.x[k];
      const ay = LINE.y[k];
      const ar = LINE.r[k];
      const vx = X[i + 1] - ax;
      const vy = Y[i + 1] - ay;
      const len2 = vx * vx + vy * vy;
      if (len2 > 0) {
        const wx = X[i] - ax;
        const wy = Y[i] - ay;
        const t = (wx * vx + wy * vy) / len2;
        const cross = wx * vy - wy * vx;
        if (t > 0 && t < 1 && cross * cross <= SIMPLIFY_TOL * SIMPLIFY_TOL * len2
          && Math.abs(R[i] - (ar + t * (R[i + 1] - ar))) <= SIMPLIFY_TOL) continue;
      }
    }
    emitLine(X[i], Y[i], R[i]);
  }
  emitLine(X[n - 1], Y[n - 1], R[n - 1]);
  return LINE.n;
}

/** Segment directions/lengths into DIR, then limits the radius slope (forward + backward pass). */
function prepareSegments(m) {
  DIR.n = 0;
  const x = LINE.x;
  const y = LINE.y;
  const r = LINE.r;
  for (let j = 0; j < m - 1; j++) {
    const dx = x[j + 1] - x[j];
    const dy = y[j + 1] - y[j];
    const len = Math.sqrt(dx * dx + dy * dy);
    DIR.push3(dx / len, dy / len, len);
  }
  const len = DIR.r;
  for (let j = 1; j < m; j++) {
    const lim = r[j - 1] + RADIUS_SLOPE * len[j - 1];
    if (r[j] > lim) r[j] = lim;
  }
  for (let j = m - 2; j >= 0; j--) {
    const lim = r[j + 1] + RADIUS_SLOPE * len[j];
    if (r[j] > lim) r[j] = lim;
  }
}

/** Chords needed for an arc of `angle` radians at radius r (error ≤ FLATNESS). */
function arcSteps(angle, r) {
  let step = r > FLATNESS ? 2 * Math.acos(1 - FLATNESS / r) : Math.PI / 2;
  if (step > Math.PI / 2) step = Math.PI / 2;
  const steps = Math.ceil(angle / step - 1e-9);
  return steps < 1 ? 1 : steps > 64 ? 64 : steps;
}

/** Pushes the interior points of an arc around (cx, cy) starting at unit vector (sx, sy). */
function pushArcInterior(buf, cx, cy, r, sx, sy, angle) {
  const steps = arcSteps(Math.abs(angle), r);
  if (steps < 2) return;
  const da = angle / steps;
  const c = Math.cos(da);
  const s = Math.sin(da);
  let vx = sx;
  let vy = sy;
  for (let k = 1; k < steps; k++) {
    const t = vx * c - vy * s;
    vy = vx * s + vy * c;
    vx = t;
    buf.push(cx + r * vx, cy + r * vy);
  }
}

/** Arc from unit vector s to unit vector e (signed angle), endpoints included and exact. */
function pushArc(buf, cx, cy, r, sx, sy, ex, ey, angle) {
  buf.push(cx + r * sx, cy + r * sy);
  pushArcInterior(buf, cx, cy, r, sx, sy, angle);
  buf.push(cx + r * ex, cy + r * ey);
}

/**
 * Builds the closed outline of the centreline in LINE (m ≥ 2 points) into OUT.
 * Normal of direction d is n = (−d.y, d.x); side A = c + r·n, side B = c − r·n.
 * Polygon: A forward, end cap, B backward, start cap.
 *
 * Why it never has holes or spikes: with centre-pivot joins the polygon is, as a chain, the sum of
 * the boundaries of one trapezoid per segment, one round sector per outer join and the two caps,
 * all oriented the same way (negative shoelace area in canvas coordinates). Its non-zero fill is
 * therefore exactly their union, however the stroke folds over itself. The bisector shortcut for
 * gentle bends only shaves thin slivers that neighbouring trapezoids still cover.
 */
function buildOutline(m) {
  const x = LINE.x;
  const y = LINE.y;
  const r = LINE.r;
  const dx = DIR.x;
  const dy = DIR.y;
  const len = DIR.r;
  SIDE_A.n = 0;
  SIDE_B.n = 0;

  SIDE_A.push(x[0] - r[0] * dy[0], y[0] + r[0] * dx[0]);
  SIDE_B.push(x[0] + r[0] * dy[0], y[0] - r[0] * dx[0]);

  for (let j = 1; j < m - 1; j++) {
    const ax = dx[j - 1];
    const ay = dy[j - 1];
    const bx = dx[j];
    const by = dy[j];
    const cx = x[j];
    const cy = y[j];
    const rj = r[j];
    const dot = ax * bx + ay * by;
    const cross = ax * by - ay * bx;
    // Gentle bend: one vertex per side along the bisector normal. Only safe when the inner wedge
    // it cuts off (reaching r·sin(turn) along each neighbouring segment) is still covered by both
    // neighbouring segments; otherwise the inner side folds and could open a hole.
    const shortest = len[j - 1] < len[j] ? len[j - 1] : len[j];
    if (dot >= GENTLE_DOT && rj * (cross < 0 ? -cross : cross) <= shortest) {
      let hx = ax + bx;
      let hy = ay + by;
      const hl = Math.sqrt(hx * hx + hy * hy);
      hx /= hl;
      hy /= hl;
      SIDE_A.push(cx - rj * hy, cy + rj * hx);
      SIDE_B.push(cx + rj * hy, cy - rj * hx);
      continue;
    }
    // Sharp bend: round join on the outer side, inner side passes through the centre point.
    const angle = Math.atan2(cross, dot);
    if (angle > 0) {
      SIDE_A.push(cx - rj * ay, cy + rj * ax);
      SIDE_A.push(cx, cy);
      SIDE_A.push(cx - rj * by, cy + rj * bx);
      pushArc(SIDE_B, cx, cy, rj, ay, -ax, by, -bx, angle);
    } else {
      SIDE_B.push(cx + rj * ay, cy - rj * ax);
      SIDE_B.push(cx, cy);
      SIDE_B.push(cx + rj * by, cy - rj * bx);
      pushArc(SIDE_A, cx, cy, rj, -ay, ax, -by, bx, angle);
    }
  }

  const e = m - 1;
  const ex = dx[m - 2];
  const ey = dy[m - 2];
  SIDE_A.push(x[e] - r[e] * ey, y[e] + r[e] * ex);
  SIDE_B.push(x[e] + r[e] * ey, y[e] - r[e] * ex);

  OUT.n = 0;
  for (let i = 0; i < SIDE_A.n; i++) OUT.push(SIDE_A.x[i], SIDE_A.y[i]);
  pushArcInterior(OUT, x[e], y[e], r[e], -ey, ex, -Math.PI); // end cap: +n → +d → −n
  for (let i = SIDE_B.n - 1; i >= 0; i--) OUT.push(SIDE_B.x[i], SIDE_B.y[i]);
  pushArcInterior(OUT, x[0], y[0], r[0], dy[0], -dx[0], -Math.PI); // start cap: −n → −d → +n
  return OUT.n;
}

/** Full circle (same winding as the outlines) into OUT. */
function buildDot(cx, cy, r) {
  OUT.n = 0;
  const steps = Math.max(8, arcSteps(TAU, r));
  const da = -TAU / steps;
  for (let k = 0; k < steps; k++) OUT.push(cx + r * Math.cos(k * da), cy + r * Math.sin(k * da));
  return OUT.n;
}

/**
 * Raw points → smoothed centreline in LINE. Returns the number of centreline points
 * (0: nothing to draw; 1: a dot whose radius is LINE.r[0]).
 */
function computeCenterline(stroke) {
  LINE.n = 0;
  if (!stroke || typeof stroke !== 'object') return 0;
  const isHighlighter = stroke.tool === 'highlighter';
  const constRadius = isHighlighter ? Math.max(MIN_RADIUS, sizeOf(stroke) / 2) : 0;
  const n = readRaw(stroke, constRadius);
  if (n === 0) return 0;
  if (n > 1) {
    const leg = cornerLeg(stroke);
    buildCurve(n, leg);
    if (CURVE.n >= 2) {
      const k = resampleCurve();
      smoothSamples(leg);
      if (!isHighlighter) smoothRadii(k);
      if (simplifyInto(k) >= 2) return LINE.n;
    }
  }
  // A single point (or everything within jitter distance): a dot at full pressure.
  LINE.n = 0;
  LINE.push3(RAW.x[0], RAW.y[0], Math.max(MIN_RADIUS, rawMaxRadius));
  return 1;
}

/** Computes the outline into OUT; returns the vertex count (0 when there is nothing to draw). */
function computeOutline(stroke) {
  const m = computeCenterline(stroke);
  if (m === 0) {
    OUT.n = 0;
    return 0;
  }
  if (m === 1) return buildDot(LINE.x[0], LINE.y[0], LINE.r[0]);
  prepareSegments(m);
  return buildOutline(m);
}

function copyOut(k) {
  const out = new Array(k * 2);
  for (let i = 0; i < k; i++) {
    out[i * 2] = OUT.x[i];
    out[i * 2 + 1] = OUT.y[i];
  }
  return out;
}

/**
 * Closed outline polygon of a stroke as a flat [x0, y0, x1, y1, ...] array (fill with the
 * non-zero rule). Pens get the variable-width smoothed outline; highlighters the constant-width
 * outline of the same path. 1 point → circle. No points → []. Pure.
 * @returns {number[]}
 */
export function strokeOutline(stroke) {
  return copyOut(computeOutline(stroke));
}

/**
 * Extra export (used by tests and handy for debugging): the smoothed centreline the outline is
 * built around, flat [x, y, radius, ...]. One triple for a dot, [] when nothing is drawable.
 * @returns {number[]}
 */
export function strokeCenterline(stroke) {
  const m = computeCenterline(stroke);
  if (m > 1) prepareSegments(m); // apply the radius slope limit exactly like the outline does
  const out = new Array(m * 3);
  for (let i = 0; i < m; i++) {
    out[i * 3] = LINE.x[i];
    out[i * 3 + 1] = LINE.y[i];
    out[i * 3 + 2] = LINE.r[i];
  }
  return out;
}

/**
 * Extra export (used by tests): the outline polygon of a given centreline flat [x, y, radius, ...]
 * built exactly like strokeOutline builds it (same radius slope limit, joins and caps), so two
 * smoothing methods can be compared on equal terms. 1 point → circle; nothing valid → [].
 * @returns {number[]}
 */
export function outlineOfCenterline(centerline) {
  LINE.n = 0;
  if (centerline && typeof centerline.length === 'number') {
    for (let i = 0; i + 2 < centerline.length; i += 3) {
      const x = centerline[i];
      const y = centerline[i + 1];
      const r = centerline[i + 2];
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(r) && r > 0) emitLine(x, y, r);
    }
  }
  const m = LINE.n;
  if (m === 0) return [];
  if (m === 1) return copyOut(buildDot(LINE.x[0], LINE.y[0], LINE.r[0]));
  prepareSegments(m);
  return copyOut(buildOutline(m));
}

// ---------------------------------------------------------------------------------------------
// Outline cache: strokes are immutable, so a finished stroke's polygon is computed once.
// ---------------------------------------------------------------------------------------------

const outlineCache = new WeakMap();

/** Cache entry of a committed stroke if it is still valid (same points array, length, size, tool). */
function cacheHit(stroke) {
  const pts = stroke.pts;
  const len = pts && typeof pts.length === 'number' ? pts.length : 0;
  const hit = outlineCache.get(stroke);
  if (hit && hit.pts === pts && hit.len === len && hit.size === stroke.size && hit.tool === stroke.tool) return hit;
  return null;
}

function cacheStore(stroke, poly) {
  const pts = stroke.pts;
  const len = pts && typeof pts.length === 'number' ? pts.length : 0;
  outlineCache.set(stroke, { pts, len, size: stroke.size, tool: stroke.tool, poly });
  return poly;
}

/** Float32Array [x, y, ...] outline polygon of a committed pen stroke (cached by object identity). */
function cachedOutline(stroke) {
  const hit = cacheHit(stroke);
  if (hit) return hit.poly;
  const k = computeOutline(stroke);
  const poly = new Float32Array(k * 2);
  for (let i = 0; i < k; i++) {
    poly[i * 2] = OUT.x[i];
    poly[i * 2 + 1] = OUT.y[i];
  }
  return cacheStore(stroke, poly);
}

/** Float32Array [x, y, ...] smoothed path of a committed highlighter (one point: a dot; cached). */
function cachedPath(stroke) {
  const hit = cacheHit(stroke);
  if (hit) return hit.poly;
  const m = computeCenterline(stroke);
  const path = new Float32Array(m * 2);
  for (let i = 0; i < m; i++) {
    path[i * 2] = LINE.x[i];
    path[i * 2 + 1] = LINE.y[i];
  }
  return cacheStore(stroke, path);
}

// ---------------------------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------------------------

/** Adds a flat polygon as one sub-path (fill() closes it implicitly). */
function tracePolygon(ctx, poly) {
  const k = poly.length >> 1;
  if (k < 3) return;
  ctx.moveTo(poly[0], poly[1]);
  for (let i = 1; i < k; i++) ctx.lineTo(poly[i * 2], poly[i * 2 + 1]);
}

/** Adds the scratch outline (OUT) as one sub-path. */
function traceScratch(ctx, k) {
  ctx.moveTo(OUT.x[0], OUT.y[0]);
  for (let i = 1; i < k; i++) ctx.lineTo(OUT.x[i], OUT.y[i]);
}

function isPen(stroke) {
  return stroke !== null && typeof stroke === 'object' && stroke.tool !== 'highlighter';
}

function fillPen(ctx, stroke, useCache) {
  if (useCache) {
    const poly = cachedOutline(stroke);
    if (poly.length < 6) return;
    ctx.save();
    ctx.fillStyle = colorOf(stroke);
    ctx.beginPath();
    tracePolygon(ctx, poly);
    ctx.fill();
    ctx.restore();
    return;
  }
  const k = computeOutline(stroke);
  if (k < 3) return;
  ctx.save();
  ctx.fillStyle = colorOf(stroke);
  ctx.beginPath();
  traceScratch(ctx, k);
  ctx.fill();
  ctx.restore();
}

/** The highlighter's smoothed path (the centreline strokeOutline uses), cached for committed strokes. */
function drawHighlighter(ctx, stroke, useCache) {
  let path = null;
  let m = 0;
  if (useCache) {
    path = cachedPath(stroke);
    m = path.length >> 1;
  } else {
    m = computeCenterline(stroke);
  }
  if (m === 0) return;
  const px = (i) => (path ? path[i * 2] : LINE.x[i]);
  const py = (i) => (path ? path[i * 2 + 1] : LINE.y[i]);
  const size = sizeOf(stroke);
  const color = colorOf(stroke);
  const base = Number.isFinite(ctx.globalAlpha) ? ctx.globalAlpha : 1;
  ctx.save();
  ctx.globalAlpha = base * HIGHLIGHTER_ALPHA;
  ctx.globalCompositeOperation = 'multiply'; // ignored by canvases that do not support it
  ctx.beginPath();
  if (m === 1) {
    ctx.fillStyle = color;
    ctx.arc(px(0), py(0), size / 2, 0, TAU);
    ctx.fill();
  } else {
    ctx.strokeStyle = color;
    ctx.lineWidth = size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.moveTo(px(0), py(0));
    for (let i = 1; i < m; i++) ctx.lineTo(px(i), py(i));
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Draws one committed stroke. `ctx` is already scaled to logical units. The context state is
 * restored afterwards. Pen → filled outline; highlighter → one round-capped path with alpha.
 */
export function drawStroke(ctx, stroke) {
  if (!ctx || !stroke || typeof stroke !== 'object') return;
  if (stroke.tool === 'highlighter') drawHighlighter(ctx, stroke, true);
  else fillPen(ctx, stroke, true);
}

/**
 * Draws strokes in the given order (use liveStrokes(doc) order). Consecutive pen strokes of the
 * same colour are filled as one path (all outlines wind the same way, so non-zero = union).
 */
export function drawStrokes(ctx, strokes) {
  if (!ctx || !strokes) return;
  const list = Array.isArray(strokes) ? strokes : Array.from(strokes);
  let i = 0;
  while (i < list.length) {
    const s = list[i];
    if (!s || typeof s !== 'object') {
      i++;
      continue;
    }
    if (s.tool === 'highlighter') {
      drawHighlighter(ctx, s, true);
      i++;
      continue;
    }
    const color = colorOf(s);
    let started = false;
    let vertices = 0;
    let j = i;
    for (; j < list.length && isPen(list[j]) && colorOf(list[j]) === color; j++) {
      const poly = cachedOutline(list[j]);
      if (poly.length < 6) continue;
      if (started && vertices > MAX_BATCH_VERTICES) {
        // Keep each path reasonably small for the rasterizer.
        ctx.fill();
        ctx.beginPath();
        vertices = 0;
      }
      if (!started) {
        ctx.save();
        ctx.fillStyle = color;
        ctx.beginPath();
        started = true;
      }
      tracePolygon(ctx, poly);
      vertices += poly.length >> 1;
    }
    if (started) {
      ctx.fill();
      ctx.restore();
    }
    i = j;
  }
}

/**
 * Draws an in-progress stroke `{ tool, color, size, pts }` exactly like drawStroke will draw the
 * finished one (same smoothing, width and caps). Draws the whole partial stroke: clear the live
 * canvas before each call. Nothing is cached (the points keep changing).
 */
export function drawLiveStroke(ctx, partial) {
  if (!ctx || !partial || typeof partial !== 'object') return;
  if (partial.tool === 'highlighter') drawHighlighter(ctx, partial, false);
  else fillPen(ctx, partial, false);
}
