/**
 * Ink rendering (module B).
 *
 * Pen strokes are filled outlines: the input points are smoothed with midpoint-quadratic curves
 * (sharp raw corners are kept as corners), the pressure-based width is smoothed and slope-limited
 * (no blobs), and the outline is one closed polygon with round caps at both ends, round outer joins
 * and inner joins through the centre point (the Skia stroker's approach; gentle bends use a single
 * bisector vertex per side), so sharp turns never produce spikes. Fill it with the non-zero rule:
 * self-overlaps are simply covered twice. Every polygon winds the same way, so several pen strokes
 * of one colour can share one fill.
 *
 * Highlighter strokes are a single constant-width path with round caps/joins, stroked once with
 * globalAlpha HIGHLIGHTER_ALPHA and 'multiply' compositing, so a stroke never darkens itself.
 *
 * strokeOutline() is pure and runs in Node. Drawing only uses basic CanvasRenderingContext2D calls
 * (save/restore, beginPath, moveTo, lineTo, quadraticCurveTo, arc, fill, stroke), so it can be
 * tested with a recording fake context. Nothing touches the DOM at module load.
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
const MIN_STEP = 0.2; // raw points closer than this to the previous kept point are jitter
const MIN_STEP_SQ = MIN_STEP * MIN_STEP;
const MIN_RADIUS = 0.2; // never thinner than this
const WIDTH_SMOOTHING = 2; // arc length (lu) of the pressure/width low-pass filter
const RADIUS_SLOPE = 0.35; // max |d radius / d length| — removes pressure blobs and pinches
const FLATNESS = 0.04; // max chord error when flattening curves and arcs
const MAX_SUBDIV = 16; // max sub-segments per smoothed curve piece
const DEDUPE_SQ = 1e-8; // centreline points closer than 1e-4 lu are merged
const CORNER_DOT = Math.cos((75 * Math.PI) / 180); // raw turns sharper than 75° stay corners
const GENTLE_DOT = Math.cos((30 * Math.PI) / 180); // smaller turns: one bisector vertex per side (≤ 3.5 % thinner)
const TAU = Math.PI * 2;
const MAX_BATCH_VERTICES = 20000; // drawStrokes: max outline vertices per batched fill

// ---------------------------------------------------------------------------------------------
// Scratch buffers, reused between calls so the hot loops do not allocate.
// (JS is single-threaded and every function below finishes synchronously.)
// ---------------------------------------------------------------------------------------------

class PointBuf {
  constructor(capacity, withRadius) {
    this.x = new Float64Array(capacity);
    this.y = new Float64Array(capacity);
    this.r = withRadius ? new Float64Array(capacity) : null;
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
}

const RAW = new PointBuf(256, true); // filtered input points + radius
const LINE = new PointBuf(512, true); // smoothed centreline + radius
const DIR = new PointBuf(512, true); // per centreline segment: unit direction (x, y) + length (r)
const SIDE_A = new PointBuf(512, false); // offset side +normal, forward order
const SIDE_B = new PointBuf(512, false); // offset side −normal, forward order
const OUT = new PointBuf(1024, false); // final polygon
let rawMaxRadius = 0;

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

// ---------------------------------------------------------------------------------------------
// Geometry pipeline: raw points → smoothed centreline (with radii) → outline polygon
// ---------------------------------------------------------------------------------------------

/**
 * Reads the valid points of stroke.pts into RAW (x, y, radius), skipping jitter closer than
 * MIN_STEP. `constRadius` > 0 forces a constant radius (highlighter).
 * Sets rawMaxRadius (max over all valid points, including skipped ones). Returns RAW.n.
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
    }
    RAW.push3(x, y, r);
    lx = x;
    ly = y;
  }
  return RAW.n;
}

/**
 * Smooths the raw radii along the arc length (forward + backward exponential filter, averaged:
 * no lag, independent of the input sample rate). Takes the edge off pressure spikes (blobs).
 * Uses LINE.r as temporary storage for the forward pass.
 */
function smoothRawRadii(n) {
  const X = RAW.x;
  const Y = RAW.y;
  const R = RAW.r;
  while (LINE.r.length < n) LINE.grow();
  const fwd = LINE.r;
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

/** True when the raw polyline turns by more than 75° at point i (kept sharp, not smoothed). */
function isCorner(i) {
  const X = RAW.x;
  const Y = RAW.y;
  const ax = X[i] - X[i - 1];
  const ay = Y[i] - Y[i - 1];
  const bx = X[i + 1] - X[i];
  const by = Y[i + 1] - Y[i];
  const dot = ax * bx + ay * by;
  return dot < CORNER_DOT * Math.sqrt((ax * ax + ay * ay) * (bx * bx + by * by));
}

function emit(x, y, r) {
  const n = LINE.n;
  if (n > 0) {
    const dx = x - LINE.x[n - 1];
    const dy = y - LINE.y[n - 1];
    if (dx * dx + dy * dy < DEDUPE_SQ) return;
  }
  LINE.push3(x, y, r < MIN_RADIUS ? MIN_RADIUS : r);
}

/** Number of chords for a quadratic whose second difference has length dd (error ≤ FLATNESS). */
function subdivisions(dd) {
  if (dd <= 4 * FLATNESS) return 1;
  const k = Math.ceil(Math.sqrt(dd / (4 * FLATNESS)));
  return k > MAX_SUBDIV ? MAX_SUBDIV : k;
}

/**
 * Midpoint-quadratic smoothing: p0 → m0 (line), m(i-1) → m(i) with control p(i), m(n-2) → p(n-1).
 * Radii follow the same Bézier weights. Corners are kept: m(i-1) → p(i) → m(i).
 * Fills LINE; returns LINE.n.
 */
function buildCenterline(n) {
  LINE.n = 0;
  const X = RAW.x;
  const Y = RAW.y;
  const R = RAW.r;
  emit(X[0], Y[0], R[0]);
  if (n === 2) {
    emit(X[1], Y[1], R[1]);
    return LINE.n;
  }
  let mx = (X[0] + X[1]) / 2;
  let my = (Y[0] + Y[1]) / 2;
  let mr = (R[0] + R[1]) / 2;
  emit(mx, my, mr);
  for (let i = 1; i <= n - 2; i++) {
    const px = X[i];
    const py = Y[i];
    const pr = R[i];
    const nx = (X[i] + X[i + 1]) / 2;
    const ny = (Y[i] + Y[i + 1]) / 2;
    const nr = (R[i] + R[i + 1]) / 2;
    if (isCorner(i)) {
      emit(px, py, pr);
      emit(nx, ny, nr);
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
        emit(a * mx + b * px + c * nx, a * my + b * py + c * ny, a * mr + b * pr + c * nr);
      }
    }
    mx = nx;
    my = ny;
    mr = nr;
  }
  emit(X[n - 1], Y[n - 1], R[n - 1]);
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
    if (!isHighlighter) smoothRawRadii(n);
    if (buildCenterline(n) >= 2) return LINE.n;
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

/**
 * Closed outline polygon of a stroke as a flat [x0, y0, x1, y1, ...] array (fill with the
 * non-zero rule). Pens get the variable-width smoothed outline; highlighters the constant-width
 * outline of the same path. 1 point → circle. No points → []. Pure.
 * @returns {number[]}
 */
export function strokeOutline(stroke) {
  const k = computeOutline(stroke);
  const out = new Array(k * 2);
  for (let i = 0; i < k; i++) {
    out[i * 2] = OUT.x[i];
    out[i * 2 + 1] = OUT.y[i];
  }
  return out;
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

// ---------------------------------------------------------------------------------------------
// Outline cache: strokes are immutable, so a finished stroke's polygon is computed once.
// ---------------------------------------------------------------------------------------------

const outlineCache = new WeakMap();

/** Float32Array [x, y, ...] for a committed stroke (cached by object identity). */
function cachedOutline(stroke) {
  const pts = stroke.pts;
  const len = pts && typeof pts.length === 'number' ? pts.length : 0;
  const hit = outlineCache.get(stroke);
  if (hit && hit.pts === pts && hit.len === len && hit.size === stroke.size && hit.tool === stroke.tool) {
    return hit.poly;
  }
  const k = computeOutline(stroke);
  const poly = new Float32Array(k * 2);
  for (let i = 0; i < k; i++) {
    poly[i * 2] = OUT.x[i];
    poly[i * 2 + 1] = OUT.y[i];
  }
  outlineCache.set(stroke, { pts, len, size: stroke.size, tool: stroke.tool, poly });
  return poly;
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

/** The highlighter's smoothed path, identical to the centreline used by strokeOutline. */
function traceHighlighterPath(ctx, n) {
  const X = RAW.x;
  const Y = RAW.y;
  ctx.moveTo(X[0], Y[0]);
  if (n === 2) {
    ctx.lineTo(X[1], Y[1]);
    return;
  }
  ctx.lineTo((X[0] + X[1]) / 2, (Y[0] + Y[1]) / 2);
  for (let i = 1; i <= n - 2; i++) {
    const mx = (X[i] + X[i + 1]) / 2;
    const my = (Y[i] + Y[i + 1]) / 2;
    if (isCorner(i)) {
      ctx.lineTo(X[i], Y[i]);
      ctx.lineTo(mx, my);
    } else {
      ctx.quadraticCurveTo(X[i], Y[i], mx, my);
    }
  }
  ctx.lineTo(X[n - 1], Y[n - 1]);
}

function drawHighlighter(ctx, stroke) {
  const size = sizeOf(stroke);
  const n = readRaw(stroke, Math.max(MIN_RADIUS, size / 2));
  if (n === 0) return;
  const color = colorOf(stroke);
  const base = Number.isFinite(ctx.globalAlpha) ? ctx.globalAlpha : 1;
  ctx.save();
  ctx.globalAlpha = base * HIGHLIGHTER_ALPHA;
  ctx.globalCompositeOperation = 'multiply'; // ignored by canvases that do not support it
  ctx.beginPath();
  if (n === 1) {
    ctx.fillStyle = color;
    ctx.arc(RAW.x[0], RAW.y[0], size / 2, 0, TAU);
    ctx.fill();
  } else {
    ctx.strokeStyle = color;
    ctx.lineWidth = size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    traceHighlighterPath(ctx, n);
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
  if (stroke.tool === 'highlighter') drawHighlighter(ctx, stroke);
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
      drawHighlighter(ctx, s);
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
  if (partial.tool === 'highlighter') drawHighlighter(ctx, partial);
  else fillPen(ctx, partial, false);
}
