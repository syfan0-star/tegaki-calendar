import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PEN_COLORS,
  HIGHLIGHTER_COLORS,
  PEN_SIZES,
  HIGHLIGHTER_SIZE,
  HIGHLIGHTER_ALPHA,
  widthAt,
  strokeOutline,
  strokeCenterline,
  drawStroke,
  drawStrokes,
  drawLiveStroke,
  outlineOfCenterline,
} from '../js/ink/render.js';
import { InkStabilizer, finalizeStrokePoints } from '../js/ink/surface.js';

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let nextId = 0;
const pen = (pts, size = PEN_SIZES.medium, color = '#1f2937') => ({ id: `p${nextId++}`, tool: 'pen', color, size, pts, t: 1 });
const hl = (pts, size = HIGHLIGHTER_SIZE, color = '#fde047') => ({ id: `h${nextId++}`, tool: 'highlighter', color, size, pts, t: 1 });

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/** Non-zero winding number of a closed flat polygon around (px, py). */
function winding(poly, px, py) {
  let w = 0;
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x1 = poly[2 * i];
    const y1 = poly[2 * i + 1];
    const x2 = poly[2 * j];
    const y2 = poly[2 * j + 1];
    const side = (x2 - x1) * (py - y1) - (px - x1) * (y2 - y1);
    if (y1 <= py) {
      if (y2 > py && side > 0) w++;
    } else if (y2 <= py && side < 0) w--;
  }
  return w;
}

function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const l = vx * vx + vy * vy;
  let t = l > 0 ? ((px - ax) * vx + (py - ay) * vy) / l : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - ax - t * vx, py - ay - t * vy);
}

function signedArea(poly) {
  let a = 0;
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += poly[2 * i] * poly[2 * j + 1] - poly[2 * j] * poly[2 * i + 1];
  }
  return a / 2;
}

/**
 * Rasterises the outline on a grid and compares it with the ideal shape: the union of
 * tapered capsules around the centreline. Returns counts of problems.
 *  - holes:    points well inside the ideal shape (≤ 85 % of the radius) that are not filled
 *  - overflow: filled points outside the ideal shape (+ 0.05 lu) → spikes / artefacts
 *  - positive: points with positive winding (all outlines must wind negatively)
 */
function rasterCheck(stroke, cells = 120) {
  const poly = strokeOutline(stroke);
  const cl = strokeCenterline(stroke);
  const m = cl.length / 3;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < poly.length; i += 2) {
    minX = Math.min(minX, poly[i]);
    maxX = Math.max(maxX, poly[i]);
    minY = Math.min(minY, poly[i + 1]);
    maxY = Math.max(maxY, poly[i + 1]);
  }
  const step = Math.max(maxX - minX, maxY - minY) / cells;
  let holes = 0;
  let overflow = 0;
  let positive = 0;
  let filled = 0;
  for (let x = minX - 1; x <= maxX + 1; x += step) {
    for (let y = minY - 1; y <= maxY + 1; y += step) {
      const w = winding(poly, x, y);
      if (w > 0) positive++;
      if (w !== 0) filled++;
      let inner = false;
      let inTube = false;
      if (m === 1) {
        const d = Math.hypot(x - cl[0], y - cl[1]);
        inner = d <= 0.85 * cl[2];
        inTube = d <= cl[2] + 0.05;
      }
      for (let j = 0; j < m - 1 && !(inner && inTube); j++) {
        const d = segDist(x, y, cl[3 * j], cl[3 * j + 1], cl[3 * j + 3], cl[3 * j + 4]);
        const r0 = cl[3 * j + 2];
        const r1 = cl[3 * j + 5];
        if (d <= 0.85 * Math.min(r0, r1)) inner = true;
        if (d <= Math.max(r0, r1) + 0.05) inTube = true;
      }
      if (inner && w === 0) holes++;
      if (!inTube && w !== 0) overflow++;
    }
  }
  return { holes, overflow, positive, filled, poly, cl };
}

/** A family of nasty and ordinary strokes. */
function strokeZoo(seed = 1) {
  const r = rng(seed);
  const zoo = {};
  zoo.dot = pen([10, 10, 0.5]);
  zoo.twoPoints = pen([0, 0, 0.2, 10, 0, 0.9]);
  zoo.vCoarse = pen([0, 0, 0.5, 10, 100, 0.5, 20, 0, 0.5]);
  zoo.vDense = pen(
    (() => {
      const a = [];
      for (let i = 0; i <= 50; i++) a.push(i * 0.2, i * 2, 0.6);
      for (let i = 1; i <= 50; i++) a.push(10 + i * 0.2, 100 - i * 2, 0.6);
      return a;
    })(),
  );
  zoo.zigzag = pen(Array.from({ length: 20 }, (_, i) => [i * 0.5, (i % 2) * 8, r()]).flat(), 6);
  zoo.reversal = pen([0, 0, 0.5, 10, 0, 0.5, 0, 0.01, 0.5, 10, 0.02, 0.5]);
  zoo.exactReversal = pen([0, 0, 0.5, 10, 0, 0.5, 0, 0, 0.5]);
  zoo.circle = pen(Array.from({ length: 41 }, (_, i) => [20 + 15 * Math.cos((i / 40) * 7), 20 + 15 * Math.sin((i / 40) * 7), 0.3 + 0.6 * r()]).flat());
  zoo.tightLoops = pen(Array.from({ length: 61 }, (_, i) => [i * 0.3 + 1.2 * Math.cos(i / 5), 1.2 * Math.sin(i / 5), 0.9]).flat(), 6);
  zoo.pressureSpike = pen(Array.from({ length: 61 }, (_, i) => [i, Math.sin(i / 8) * 6, i === 30 ? 1 : 0.1]).flat(), 6);
  zoo.pressureSaw = pen(Array.from({ length: 80 }, (_, i) => [i * 0.7, Math.cos(i / 6) * 4, i % 2]).flat(), 6);
  zoo.nearDuplicates = pen([5, 5, 0.5, 5.01, 5, 0.6, 5, 5.02, 0.9, 5.05, 5.05, 0.1]);
  zoo.highlighter = hl([0, 0, 0.5, 30, 5, 0.5, 0, 10, 0.5]);
  for (let k = 0; k < 10; k++) {
    const a = [];
    let x = 50;
    let y = 50;
    const stepLen = k < 5 ? 6 : 0.6; // coarse (60 Hz) and dense (240 Hz) random walks
    for (let i = 0; i < 120; i++) {
      x += (r() - 0.5) * stepLen;
      y += (r() - 0.5) * stepLen;
      a.push(x, y, r());
    }
    zoo[`random${k}`] = pen(a, [PEN_SIZES.thin, PEN_SIZES.medium, PEN_SIZES.thick][k % 3]);
  }
  return zoo;
}

/** Recording fake CanvasRenderingContext2D with a real save/restore state stack. */
function fakeCtx(initial = {}) {
  const keys = ['fillStyle', 'strokeStyle', 'globalAlpha', 'globalCompositeOperation', 'lineWidth', 'lineCap', 'lineJoin'];
  let state = {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    ...initial,
  };
  const stack = [];
  const calls = [];
  const ctx = {
    calls,
    get state() {
      return { ...state };
    },
    save() {
      stack.push({ ...state });
      calls.push(['save']);
    },
    restore() {
      if (stack.length) state = stack.pop();
      calls.push(['restore']);
    },
    beginPath: () => calls.push(['beginPath']),
    closePath: () => calls.push(['closePath']),
    moveTo: (x, y) => calls.push(['moveTo', x, y]),
    lineTo: (x, y) => calls.push(['lineTo', x, y]),
    quadraticCurveTo: (cx, cy, x, y) => calls.push(['quadraticCurveTo', cx, cy, x, y]),
    arc: (x, y, r, a0, a1) => calls.push(['arc', x, y, r, a0, a1]),
    fill: () => calls.push(['fill', { ...state }]),
    stroke: () => calls.push(['stroke', { ...state }]),
  };
  for (const k of keys) {
    Object.defineProperty(ctx, k, {
      get: () => state[k],
      set: (v) => {
        state[k] = v;
      },
    });
  }
  return ctx;
}

/** Sub-paths (moveTo + lineTo runs) recorded on a fake ctx, as flat arrays. */
function recordedPolygons(calls) {
  const polys = [];
  for (const c of calls) {
    if (c[0] === 'moveTo') polys.push([c[1], c[2]]);
    else if (c[0] === 'lineTo') polys[polys.length - 1].push(c[1], c[2]);
  }
  return polys;
}

const count = (calls, name) => calls.filter((c) => c[0] === name).length;

// ---------------------------------------------------------------------------------------------
// constants & width
// ---------------------------------------------------------------------------------------------

test('constants match the spec', () => {
  assert.deepEqual(PEN_COLORS, ['#1f2937', '#2563eb', '#dc2626', '#16a34a', '#ea580c', '#7c3aed']);
  assert.deepEqual(HIGHLIGHTER_COLORS, ['#fde047', '#f9a8d4', '#86efac', '#93c5fd']);
  assert.deepEqual(PEN_SIZES, { thin: 2, medium: 3.5, thick: 6 });
  assert.equal(HIGHLIGHTER_SIZE, 18);
  assert.equal(HIGHLIGHTER_ALPHA, 0.35);
});

test('widthAt: pen size*(0.4+0.9p), highlighter constant; clamps and defaults', () => {
  const s = pen([], 4);
  assert.equal(widthAt(s, 0), 1.6);
  assert.ok(Math.abs(widthAt(s, 1) - 5.2) < 1e-12);
  assert.ok(Math.abs(widthAt(s, 0.5) - 3.4) < 1e-12);
  assert.equal(widthAt(s, 7), widthAt(s, 1));
  assert.equal(widthAt(s, -1), widthAt(s, 0));
  assert.equal(widthAt(s, NaN), widthAt(s, 0.5));
  assert.equal(widthAt(hl([], 18), 0.1), 18);
  assert.equal(widthAt(hl([], 18), 1), 18);
  assert.ok(Math.abs(widthAt({ tool: 'pen' }, 0.5) - 3.5 * 0.85) < 1e-12, 'missing size → medium');
  assert.ok(Math.abs(widthAt(null, 0.5) - 3.5 * 0.85) < 1e-12);
});

// ---------------------------------------------------------------------------------------------
// strokeOutline
// ---------------------------------------------------------------------------------------------

test('strokeOutline: no points → [], garbage never throws', () => {
  assert.deepEqual(strokeOutline(pen([])), []);
  assert.deepEqual(strokeOutline(null), []);
  assert.deepEqual(strokeOutline({}), []);
  assert.deepEqual(strokeOutline(pen('abc')), []);
  assert.deepEqual(strokeOutline(pen([NaN, 1, 0.5, Infinity, 2, 0.5])), []);
  assert.ok(strokeOutline(pen([1, 2, 'x', 'y', 3, 4, 5, 6])).length > 0);
});

test('strokeOutline: 1 point → circle of radius widthAt/2', () => {
  const s = pen([10, 20, 1], 4);
  const poly = strokeOutline(s);
  assert.ok(poly.length / 2 >= 8);
  const r = widthAt(s, 1) / 2;
  for (let i = 0; i < poly.length; i += 2) assert.ok(Math.abs(Math.hypot(poly[i] - 10, poly[i + 1] - 20) - r) < 1e-9);
  // points within jitter distance also make a dot, at the strongest pressure
  const jitter = strokeOutline(pen([10, 20, 0.1, 10.05, 20.02, 1, 10.01, 19.99, 0.3], 4));
  for (let i = 0; i < jitter.length; i += 2) assert.ok(Math.abs(Math.hypot(jitter[i] - 10, jitter[i + 1] - 20) - r) < 1e-9);
});

test('strokeOutline: 2 points → capsule with round caps', () => {
  const s = pen([0, 0, 0.5, 20, 0, 0.5], 4);
  const poly = strokeOutline(s);
  const r = widthAt(s, 0.5) / 2;
  let maxX = -Infinity;
  let minX = Infinity;
  for (let i = 0; i < poly.length; i += 2) {
    assert.ok(segDist(poly[i], poly[i + 1], 0, 0, 20, 0) <= r + 1e-9);
    maxX = Math.max(maxX, poly[i]);
    minX = Math.min(minX, poly[i]);
  }
  assert.ok(Math.abs(maxX - (20 + r)) < 1e-9, 'round end cap reaches r beyond the end');
  assert.ok(Math.abs(minX + r) < 1e-9, 'round start cap');
  for (const [x, y] of [[0, 0], [10, 0], [20, 0], [10, r * 0.9], [10, -r * 0.9], [-r * 0.9, 0], [20 + r * 0.9, 0]]) {
    assert.notEqual(winding(poly, x, y), 0, `(${x},${y}) covered`);
  }
  assert.equal(winding(poly, 10, r * 1.1), 0);
});

test('strokeOutline is pure and deterministic', () => {
  const s = deepFreeze(pen([0, 0, 0.3, 5, 8, 0.6, 12, 3, 0.9, 20, 10, 0.4]));
  const a = strokeOutline(s);
  const b = strokeOutline(s);
  assert.deepEqual(a, b);
  assert.ok(Array.isArray(a));
  assert.equal(a.length % 2, 0);
  for (const v of a) assert.ok(Number.isFinite(v));
});

test('outline quality: no holes, no spikes/overflow, consistent winding (stroke zoo)', () => {
  for (const [name, s] of Object.entries(strokeZoo(7))) {
    const { holes, overflow, positive, filled, poly } = rasterCheck(s);
    assert.ok(filled > 0, `${name}: something is filled`);
    assert.equal(holes, 0, `${name}: holes`);
    assert.equal(overflow, 0, `${name}: fill outside the stroke (spikes)`);
    assert.equal(positive, 0, `${name}: winding must be consistently negative`);
    assert.ok(signedArea(poly) < 0, `${name}: negative signed area`);
  }
});

test('outline quality: random strokes (property test)', () => {
  const r = rng(99);
  for (let i = 0; i < 60; i++) {
    const n = 2 + Math.floor(r() * 40);
    const pts = [];
    let x = 0;
    let y = 0;
    const scale = r() < 0.5 ? 1 : 10;
    for (let k = 0; k < n; k++) {
      x += (r() - 0.5) * scale;
      y += (r() - 0.5) * scale;
      pts.push(x, y, r());
    }
    const s = pen(pts, [PEN_SIZES.thin, PEN_SIZES.medium, PEN_SIZES.thick][i % 3]);
    const { holes, overflow, positive } = rasterCheck(s, 80);
    assert.deepEqual({ holes, overflow, positive }, { holes: 0, overflow: 0, positive: 0 }, `stroke #${i}`);
  }
});

test('no spikes: every outline vertex lies within its centreline radius', () => {
  for (const [name, s] of Object.entries(strokeZoo(3))) {
    const poly = strokeOutline(s);
    const cl = strokeCenterline(s);
    for (let i = 0; i < poly.length; i += 2) {
      let ok = false;
      for (let j = 0; j < cl.length && !ok; j += 3) {
        if (Math.hypot(poly[i] - cl[j], poly[i + 1] - cl[j + 1]) <= cl[j + 2] + 1e-6) ok = true;
      }
      assert.ok(ok, `${name}: vertex ${i / 2} is outside every centreline disc`);
    }
  }
});

test('width follows pressure, smoothly (no blobs)', () => {
  const pts = [];
  for (let i = 0; i <= 100; i++) pts.push(i, 0, i / 100);
  const cl = strokeCenterline(pen(pts, 6));
  const first = cl[2];
  const last = cl[cl.length - 1];
  assert.ok(first < last, 'thin at low pressure, thick at high pressure');
  assert.ok(Math.abs(cl[cl.length - 1] - widthAt(pen([], 6), 1) / 2) < 0.2);
  // a single-sample pressure spike is damped and the radius slope stays bounded
  const spike = strokeCenterline(pen(Array.from({ length: 61 }, (_, i) => [i, 0, i === 30 ? 1 : 0.1]).flat(), 6));
  let maxR = 0;
  for (let j = 2; j < spike.length; j += 3) maxR = Math.max(maxR, spike[j]);
  assert.ok(maxR < widthAt(pen([], 6), 1) / 2 - 1, `spike damped (max r ${maxR})`);
  for (let j = 3; j < spike.length; j += 3) {
    const ds = Math.hypot(spike[j] - spike[j - 3], spike[j + 1] - spike[j - 2]);
    assert.ok(Math.abs(spike[j + 2] - spike[j - 1]) <= 0.35 * ds + 1e-9, 'radius slope limited');
  }
});

test('sharp raw corners are kept (V tip is inked) while gentle turns are smoothed', () => {
  const v = pen([0, 0, 0.5, 10, 100, 0.5, 20, 0, 0.5]);
  const poly = strokeOutline(v);
  assert.notEqual(winding(poly, 10, 100), 0, 'tip point covered');
  assert.notEqual(winding(poly, 10, 100 + widthAt(v, 0.5) / 2 - 0.1), 0, 'round join around the tip');
  // a gentle polyline is smoothed: the centreline does not pass through the middle vertex
  const cl = strokeCenterline(pen([0, 0, 0.5, 50, 10, 0.5, 100, 0, 0.5]));
  let passes = false;
  for (let j = 0; j < cl.length; j += 3) if (Math.hypot(cl[j] - 50, cl[j + 1] - 10) < 0.5) passes = true;
  assert.equal(passes, false);
});

test('highlighter outline has a constant radius of size/2', () => {
  const cl = strokeCenterline(hl([0, 0, 0.1, 30, 5, 0.9, 60, 0, 0.5]));
  for (let j = 2; j < cl.length; j += 3) assert.equal(cl[j], 9);
});

// ---------------------------------------------------------------------------------------------
// drawing (recording fake ctx)
// ---------------------------------------------------------------------------------------------

test('drawStroke(pen): one filled path equal to strokeOutline, state restored', () => {
  const s = pen([0, 0, 0.3, 5, 8, 0.6, 12, 3, 0.9], 3.5, '#dc2626');
  const ctx = fakeCtx({ fillStyle: '#123456' });
  drawStroke(ctx, s);
  const names = ctx.calls.map((c) => c[0]);
  assert.equal(names[0], 'save');
  assert.equal(names.at(-1), 'restore');
  assert.equal(count(ctx.calls, 'fill'), 1);
  assert.equal(count(ctx.calls, 'stroke'), 0);
  assert.equal(count(ctx.calls, 'beginPath'), 1);
  assert.equal(ctx.calls.find((c) => c[0] === 'fill')[1].fillStyle, '#dc2626');
  const [poly] = recordedPolygons(ctx.calls);
  const expected = strokeOutline(s);
  assert.equal(poly.length, expected.length);
  for (let i = 0; i < poly.length; i++) assert.ok(Math.abs(poly[i] - expected[i]) < 1e-3);
  assert.equal(ctx.fillStyle, '#123456', 'fillStyle restored');
  // second draw uses the cached outline and produces the same calls
  const ctx2 = fakeCtx();
  drawStroke(ctx2, s);
  assert.deepEqual(recordedPolygons(ctx2.calls), recordedPolygons(ctx.calls));
});

test('drawStroke(highlighter): single path stroked once with alpha + multiply, round caps', () => {
  const s = hl([0, 0, 0.5, 20, 2, 0.5, 40, 0, 0.5, 60, 4, 0.5], 18, '#f9a8d4');
  const ctx = fakeCtx();
  drawStroke(ctx, s);
  assert.equal(count(ctx.calls, 'stroke'), 1);
  assert.equal(count(ctx.calls, 'fill'), 0);
  assert.equal(count(ctx.calls, 'beginPath'), 1);
  assert.equal(count(ctx.calls, 'moveTo'), 1, 'one sub-path: overlaps never darken');
  // the path is the smoothed centreline (the same one strokeOutline uses), not the raw polyline
  const path = ctx.calls.filter((c) => c[0] === 'moveTo' || c[0] === 'lineTo').flatMap((c) => [c[1], c[2]]);
  const cl = strokeCenterline(s);
  assert.equal(path.length, (cl.length / 3) * 2);
  for (let i = 0; i < path.length; i += 2) {
    assert.ok(Math.abs(path[i] - cl[(i / 2) * 3]) < 1e-3 && Math.abs(path[i + 1] - cl[(i / 2) * 3 + 1]) < 1e-3);
  }
  assert.ok(path.length > 8, 'smoothed (more than the 4 raw points)');
  assert.ok(!path.some((v, i) => i % 2 === 0 && v === 20 && path[i + 1] === 2), 'does not pass through the raw corner (20, 2)');
  const st = ctx.calls.find((c) => c[0] === 'stroke')[1];
  assert.equal(st.globalAlpha, HIGHLIGHTER_ALPHA);
  assert.equal(st.globalCompositeOperation, 'multiply');
  assert.equal(st.lineCap, 'round');
  assert.equal(st.lineJoin, 'round');
  assert.equal(st.lineWidth, 18);
  assert.equal(st.strokeStyle, '#f9a8d4');
  assert.deepEqual(ctx.state, fakeCtx().state, 'context state restored');
  // respects an outer globalAlpha
  const faded = fakeCtx({ globalAlpha: 0.5 });
  drawStroke(faded, s);
  assert.equal(faded.calls.find((c) => c[0] === 'stroke')[1].globalAlpha, 0.5 * HIGHLIGHTER_ALPHA);
  assert.equal(faded.globalAlpha, 0.5);
});

test('drawStroke(highlighter) 1 point → filled circle; 2 points → straight segment', () => {
  const dot = fakeCtx();
  drawStroke(dot, hl([5, 6, 0.5]));
  const arc = dot.calls.find((c) => c[0] === 'arc');
  assert.deepEqual(arc.slice(1, 4), [5, 6, 9]);
  assert.equal(count(dot.calls, 'fill'), 1);
  assert.equal(dot.calls.find((c) => c[0] === 'fill')[1].globalAlpha, HIGHLIGHTER_ALPHA);
  const seg = fakeCtx();
  drawStroke(seg, hl([0, 0, 0.5, 10, 0, 0.5]));
  assert.deepEqual(
    seg.calls.filter((c) => c[0] === 'moveTo' || c[0] === 'lineTo'),
    [['moveTo', 0, 0], ['lineTo', 10, 0]],
  );
});

test('drawStroke ignores garbage without touching the context', () => {
  for (const s of [null, undefined, 5, {}, pen([]), pen([NaN, NaN, 1]), hl('x')]) {
    const ctx = fakeCtx();
    assert.doesNotThrow(() => drawStroke(ctx, s));
    assert.equal(count(ctx.calls, 'fill') + count(ctx.calls, 'stroke'), 0);
  }
  assert.doesNotThrow(() => drawStroke(null, pen([1, 1, 1])));
  // invalid colour falls back to the default pen colour (never inherits a stale fillStyle)
  const ctx = fakeCtx({ fillStyle: '#abcdef' });
  drawStroke(ctx, { tool: 'pen', size: 3, color: 'javascript:alert(1)', pts: [1, 1, 0.5, 5, 5, 0.5] });
  assert.equal(ctx.calls.find((c) => c[0] === 'fill')[1].fillStyle, PEN_COLORS[0]);
});

test('drawLiveStroke looks exactly like the finished stroke', () => {
  const pts = [0, 0, 0.2, 3, 4, 0.5, 9, 2, 0.8, 15, 9, 0.6, 18, 3, 0.3];
  for (const tool of ['pen', 'highlighter']) {
    const live = fakeCtx();
    drawLiveStroke(live, { tool, color: '#2563eb', size: tool === 'pen' ? 3.5 : 18, pts: pts.slice() });
    const done = fakeCtx();
    drawStroke(done, { id: `x-${tool}`, tool, color: '#2563eb', size: tool === 'pen' ? 3.5 : 18, pts: pts.slice(), t: 1 });
    const strip = (calls) => calls.map((c) => c.map((v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v)));
    assert.deepEqual(strip(live.calls), strip(done.calls), tool);
  }
  // partial strokes of any length never throw
  const ctx = fakeCtx();
  for (let n = 0; n <= pts.length; n += 3) drawLiveStroke(ctx, { tool: 'pen', color: '#000000', size: 2, pts: pts.slice(0, n) });
  drawLiveStroke(ctx, null);
  drawLiveStroke(ctx, { pts: [1, 1, 1] });
});

test('drawStrokes batches consecutive same-colour pens into one fill, keeps order', () => {
  const a = pen([0, 0, 0.5, 10, 0, 0.5], 3.5, '#1f2937');
  const b = pen([0, 5, 0.5, 10, 5, 0.5], 3.5, '#1f2937');
  const c = pen([0, 9, 0.5, 10, 9, 0.5], 3.5, '#dc2626');
  const h = hl([0, 0, 0.5, 10, 10, 0.5]);
  const d = pen([0, 20, 0.5], 3.5, '#dc2626');
  const ctx = fakeCtx();
  drawStrokes(ctx, [h, a, b, null, c, d, 'junk']);
  const events = ctx.calls.filter((x) => x[0] === 'fill' || x[0] === 'stroke').map((x) => [x[0], x[1].fillStyle]);
  assert.deepEqual(events, [
    ['stroke', '#000000'],
    ['fill', '#1f2937'],
    ['fill', '#dc2626'],
  ]);
  assert.equal(count(ctx.calls, 'moveTo'), 1 + 4, 'highlighter path + 4 pen outlines');
  assert.equal(count(ctx.calls, 'save'), count(ctx.calls, 'restore'));
  assert.deepEqual(ctx.state, fakeCtx().state);
  assert.doesNotThrow(() => drawStrokes(ctx, null));
  assert.doesNotThrow(() => drawStrokes(null, [a]));
  assert.doesNotThrow(() => drawStrokes(ctx, new Set([a, b])));
});

test('drawStrokes splits very large same-colour batches into several fills', () => {
  const strokes = [];
  for (let i = 0; i < 300; i++) {
    const pts = [];
    for (let k = 0; k < 60; k++) pts.push(i * 3 + Math.sin(k) * 2, k * 1.5, 0.5);
    strokes.push(pen(pts, PEN_SIZES.thick));
  }
  const ctx = fakeCtx();
  drawStrokes(ctx, strokes);
  const fills = count(ctx.calls, 'fill');
  assert.ok(fills > 1, `fills: ${fills}`);
  assert.equal(count(ctx.calls, 'moveTo'), 300, 'every outline traced exactly once');
  assert.equal(count(ctx.calls, 'save'), 1);
  assert.equal(count(ctx.calls, 'restore'), 1);
  for (const c of ctx.calls) if (c[0] === 'fill') assert.equal(c[1].fillStyle, '#1f2937');
});

test('batched fill of overlapping same-colour strokes covers the union (no cancellation)', () => {
  const r = rng(11);
  const strokes = Object.values(strokeZoo(5)).filter((s) => s.tool === 'pen');
  // overlapping crossings in both directions
  strokes.push(pen([0, 0, 0.5, 40, 40, 0.5]), pen([40, 0, 0.5, 0, 40, 0.5]), pen([40, 40, 0.5, 0, 0, 0.5]));
  const ctx = fakeCtx();
  drawStrokes(ctx, strokes);
  const polys = recordedPolygons(ctx.calls);
  for (let i = 0; i < 3000; i++) {
    const x = r() * 120 - 10;
    const y = r() * 120 - 10;
    let total = 0;
    let anyInside = false;
    for (const p of polys) {
      const w = winding(p, x, y);
      total += w;
      if (w !== 0) anyInside = true;
    }
    assert.equal(total !== 0, anyInside, `non-zero fill of the union at (${x}, ${y})`);
  }
});

test('performance: 2000 handwriting strokes draw well under budget (Node)', () => {
  const r = rng(2026);
  const strokes = [];
  for (let i = 0; i < 2000; i++) {
    // handwriting-like: smooth curve, ~100 points, ~0.8 lu apart, smooth pressure
    const pts = [];
    let x = r() * 1400;
    let y = r() * 1900;
    let dir = r() * Math.PI * 2;
    let turn = (r() - 0.5) * 0.3;
    for (let k = 0; k < 100; k++) {
      turn += (r() - 0.5) * 0.08;
      dir += turn;
      x += Math.cos(dir) * 0.8;
      y += Math.sin(dir) * 0.8;
      pts.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round((0.5 + 0.3 * Math.sin(k / 9)) * 100) / 100);
    }
    strokes.push(i % 10 === 0 ? hl(pts) : pen(pts, PEN_SIZES.medium, PEN_COLORS[i % 3]));
  }
  let ops = 0;
  const noop = () => {
    ops++;
  };
  const ctx = {
    save: noop, restore: noop, beginPath: noop, moveTo: noop, lineTo: noop, quadraticCurveTo: noop,
    arc: noop, fill: noop, stroke: noop, globalAlpha: 1,
  };
  let t0 = performance.now();
  drawStrokes(ctx, strokes);
  const first = performance.now() - t0;
  t0 = performance.now();
  drawStrokes(ctx, strokes);
  const cached = performance.now() - t0;
  let vertices = 0;
  for (const s of strokes) vertices += strokeOutline(s).length / 2;
  console.log(`  2000 strokes: first draw ${first.toFixed(1)} ms, cached redraw ${cached.toFixed(1)} ms, ${vertices} outline vertices, ${ops} ctx calls`);
  assert.ok(first < 1000, `first draw ${first} ms`);
  assert.ok(cached < 100, `cached redraw ${cached} ms`);
  assert.ok(vertices / 1800 < 400, 'compact outlines');
});

test('performance: a live frame of a 10-second stroke stays cheap', () => {
  // 2400 Pencil samples (10 s at 240 Hz, whole-pixel coordinates), one frame per 4 samples like rAF at 60 Hz.
  const scale = 0.6;
  const sample = (i) => {
    const u = i / 240;
    return {
      cx: Math.floor(300 + 150 * Math.cos(u * 0.9) + 20 * Math.cos(u * 7)),
      cy: Math.floor(300 + 150 * Math.sin(u * 0.9) + 20 * Math.sin(u * 7)),
      p: 0.5, t: (i * 1000) / 240, left: 0.3, top: 0.7, scale,
    };
  };
  const st = new InkStabilizer(sample(0));
  const noop = () => {};
  const ctx = { save: noop, restore: noop, beginPath: noop, moveTo: noop, lineTo: noop, arc: noop, fill: noop, stroke: noop, globalAlpha: 1 };
  let worst = 0;
  let total = 0;
  let frames = 0;
  for (let i = 1; i < 2400; i++) {
    st.add(sample(i));
    if (i % 4) continue;
    const t0 = performance.now();
    drawLiveStroke(ctx, { tool: 'pen', color: '#1f2937', size: PEN_SIZES.medium, pts: st.preview() });
    const ms = performance.now() - t0;
    if (frames > 20) worst = Math.max(worst, ms); // after the JIT warm-up
    total += ms;
    frames++;
  }
  console.log(`  live frame (stabilize + outline), ${st.pts.length / 3} points: mean ${(total / frames).toFixed(2)} ms, worst ${worst.toFixed(2)} ms`);
  assert.ok(total / frames < 4, 'mean frame cost');
  assert.ok(worst < 16, 'never a whole frame');
});

// ---------------------------------------------------------------------------------------------
// Smoothness (1.0.5): Pencil input as WebKit delivers it vs. the v1.0.4 renderer
// ---------------------------------------------------------------------------------------------

/**
 * The v1.0.4 centreline (render.js before 1.0.5), flat [x, y, r, ...] before the radius slope limit:
 * jitter < 0.2 lu dropped, radius EMA over 2 lu, midpoint quadratics, every raw turn sharper than 75°
 * kept as a corner however short its segments. outlineOfCenterline(legacyCenterline(s)) is exactly the
 * v1.0.4 strokeOutline(s).
 */
function legacyCenterline(stroke) {
  const half = stroke.size / 2;
  const P = [];
  for (let i = 0; i + 2 < stroke.pts.length; i += 3) {
    const x = stroke.pts[i];
    const y = stroke.pts[i + 1];
    const last = P[P.length - 1];
    if (last && (x - last[0]) ** 2 + (y - last[1]) ** 2 < 0.04) continue;
    P.push([x, y, half * (0.4 + 0.9 * Math.min(1, Math.max(0, stroke.pts[i + 2])))]);
  }
  const n = P.length;
  const alpha = (i, j) => 1 - Math.exp(-Math.hypot(P[j][0] - P[i][0], P[j][1] - P[i][1]) / 2);
  const fwd = [P[0][2]];
  for (let i = 1; i < n; i++) fwd.push(fwd[i - 1] + alpha(i - 1, i) * (P[i][2] - fwd[i - 1]));
  let back = P[n - 1][2];
  P[n - 1][2] = (fwd[n - 1] + back) / 2;
  for (let i = n - 2; i >= 0; i--) {
    back += alpha(i, i + 1) * (P[i][2] - back);
    P[i][2] = (fwd[i] + back) / 2;
  }
  const out = [];
  const emit = (x, y, r) => {
    const k = out.length;
    if (!k || (x - out[k - 3]) ** 2 + (y - out[k - 2]) ** 2 >= 1e-8) out.push(x, y, Math.max(0.2, r));
  };
  const isCorner = (i) => {
    const ax = P[i][0] - P[i - 1][0];
    const ay = P[i][1] - P[i - 1][1];
    const bx = P[i + 1][0] - P[i][0];
    const by = P[i + 1][1] - P[i][1];
    return ax * bx + ay * by < Math.cos((75 * Math.PI) / 180) * Math.hypot(ax, ay) * Math.hypot(bx, by);
  };
  emit(...P[0]);
  if (n === 2) {
    emit(...P[1]);
    return out;
  }
  let m = P[0].map((v, j) => (v + P[1][j]) / 2);
  emit(...m);
  for (let i = 1; i <= n - 2; i++) {
    const p = P[i];
    const nm = p.map((v, j) => (v + P[i + 1][j]) / 2);
    if (isCorner(i)) {
      emit(...p);
      emit(...nm);
    } else {
      const dd = Math.hypot(m[0] - 2 * p[0] + nm[0], m[1] - 2 * p[1] + nm[1]);
      const k = dd <= 0.16 ? 1 : Math.min(16, Math.ceil(Math.sqrt(dd / 0.16)));
      for (let j = 1; j <= k; j++) {
        const t = j / k;
        const a = (1 - t) ** 2;
        const b = 2 * (1 - t) * t;
        const c = t * t;
        emit(a * m[0] + b * p[0] + c * nm[0], a * m[1] + b * p[1] + c * nm[1], a * m[2] + b * p[2] + c * nm[2]);
      }
    }
    m = nm;
  }
  emit(...P[n - 1]);
  return out;
}

/** Handwriting-like shapes in CSS px (u = 0..1). */
const HANDWRITING = {
  loops: (u) => { const t = u * 6 * Math.PI; return [3 * t - 8 * Math.sin(t), 10 * (1 - Math.cos(t))]; },
  spiral: (u) => { const t = -0.3 + u * 2.3 * Math.PI; const r = 14 - 1.2 * t; return [r * Math.cos(t), r * Math.sin(t)]; },
  nearlyFlat: (u) => [u * 70, u * 70 * Math.tan(Math.PI / 60) + 1.5 * Math.sin(u * 3)],
  shallow: (u) => [u * 70, u * 70 * Math.tan(Math.PI / 15)],
  diagonal: (u) => [u * 50, u * 50 + 2 * Math.sin(u * 4)],
  arc: (u) => { const t = Math.PI * (0.1 + 0.8 * u); return [30 * Math.cos(t), -30 * Math.sin(t)]; },
  wave: (u) => [u * 80, 8 * Math.sin(u * 4 * Math.PI)],
};
const PAGE_LEFT = 120.37; // the page box starts at a fractional client offset
const PAGE_TOP = 64.61;

/**
 * Samples a shape like the Pencil: 240 Hz, mean speed `speed` CSS px/s, slower in tight curves
 * (2/3 power law) and at both ends, tiny digitizer noise, smooth pressure.
 * → [{ x, y (page CSS px, fractional), p, t (ms) }] and the dense true path.
 */
function pencilSamples(shape, speed, seed = 1) {
  const r = rng(seed);
  const N = 2000;
  const P = [];
  for (let i = 0; i <= N; i++) P.push(shape(i / N));
  const S = [0];
  for (let i = 1; i <= N; i++) S.push(S[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  const L = S[N];
  const V = P.map((b, i) => {
    const a = P[Math.max(0, i - 5)];
    const c = P[Math.min(N, i + 5)];
    const turn = Math.abs(Math.atan2((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]),
      (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])));
    const radius = turn > 1e-6 ? (S[Math.min(N, i + 5)] - S[Math.max(0, i - 5)]) / turn : 1e6;
    return Math.cbrt(Math.min(radius, 400) / 400) * (0.15 + 0.85 * Math.min(1, S[i] / 20, (L - S[i]) / 20));
  });
  const T = [0];
  for (let i = 1; i <= N; i++) T.push(T[i - 1] + (S[i] - S[i - 1]) / Math.max(0.03, (V[i] + V[i - 1]) / 2));
  const k = (L / speed) / T[N]; // seconds per unit of T
  const gauss = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
  const out = [];
  let j = 0;
  for (let step = 0; step / 240 <= T[N] * k; step++) {
    const u = step / 240 / k;
    while (j < N - 1 && T[j + 1] < u) j++;
    const f = Math.min(1, (u - T[j]) / (T[j + 1] - T[j]));
    const x = P[j][0] + f * (P[j + 1][0] - P[j][0]);
    const y = P[j][1] + f * (P[j + 1][1] - P[j][1]);
    const s = S[j] + f * (S[j + 1] - S[j]);
    out.push({ x: x + 0.03 * gauss(), y: y + 0.03 * gauss(), p: 0.5 + 0.15 * Math.sin(s / 9), t: (step * 1000) / 240 });
  }
  return { samples: out, path: P };
}

/** v1.0.4 storage: whole-pixel client coordinates, samples closer than 0.3 lu dropped, rounded. */
function legacyStore(samples, scale) {
  const pts = [];
  for (const q of samples) {
    const x = (Math.floor(q.x + PAGE_LEFT) - PAGE_LEFT) / scale;
    const y = (Math.floor(q.y + PAGE_TOP) - PAGE_TOP) / scale;
    const n = pts.length;
    if (n && (x - pts[n - 3]) ** 2 + (y - pts[n - 2]) ** 2 < 0.09) continue;
    pts.push(x, y, q.p);
  }
  return finalizeStrokePoints(pts);
}

/** 1.0.5 storage: the surface's InkStabilizer fed with whole-pixel (or fractional) client coordinates. */
function stabilizedStore(samples, scale, whole = true) {
  const sample = (q) => ({
    cx: whole ? Math.floor(q.x + PAGE_LEFT) : q.x + PAGE_LEFT,
    cy: whole ? Math.floor(q.y + PAGE_TOP) : q.y + PAGE_TOP,
    p: q.p, t: q.t, left: PAGE_LEFT, top: PAGE_TOP, scale,
  });
  const st = new InkStabilizer(sample(samples[0]));
  for (let i = 1; i < samples.length; i++) st.add(sample(samples[i]));
  return finalizeStrokePoints(st.finish());
}

/** Total absolute turning of a closed polygon per unit of perimeter (rad / lu): kinks and wobble add to it. */
function turningPerLength(poly) {
  const n = poly.length / 2;
  let turn = 0;
  let perimeter = 0;
  for (let i = 0; i < n; i++) {
    const a = (i + n - 1) % n;
    const b = (i + 1) % n;
    const ax = poly[2 * i] - poly[2 * a];
    const ay = poly[2 * i + 1] - poly[2 * a + 1];
    const bx = poly[2 * b] - poly[2 * i];
    const by = poly[2 * b + 1] - poly[2 * i + 1];
    perimeter += Math.hypot(bx, by);
    if (Math.hypot(ax, ay) > 1e-9 && Math.hypot(bx, by) > 1e-9) turn += Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by));
  }
  return turn / perimeter;
}

/** RMS distance (lu) of a centreline's points from the true path (CSS px, shifted by the whole-pixel bias). */
function pathError(cl, path, scale, bias) {
  let sum = 0;
  for (let i = 0; i < cl.length; i += 3) {
    let best = Infinity;
    for (let j = 0; j + 1 < path.length; j++) {
      const ax = (path[j][0] - bias) / scale;
      const ay = (path[j][1] - bias) / scale;
      best = Math.min(best, segDist(cl[i], cl[i + 1], ax, ay, (path[j + 1][0] - bias) / scale, (path[j + 1][1] - bias) / scale));
    }
    sum += best * best;
  }
  return Math.sqrt(sum / (cl.length / 3));
}

/** Largest turn (degrees) between consecutive centreline segments. */
function maxVertexTurn(cl) {
  let max = 0;
  for (let i = 3; i + 3 < cl.length; i += 3) {
    const ax = cl[i] - cl[i - 3];
    const ay = cl[i + 1] - cl[i - 2];
    const bx = cl[i + 3] - cl[i];
    const by = cl[i + 4] - cl[i + 1];
    max = Math.max(max, Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by)));
  }
  return (max * 180) / Math.PI;
}

test('smoothness: whole-pixel Pencil input renders far less jagged than with v1.0.4 (quantitative)', () => {
  const sum = { legacy: 0, renderOnly: 0, full: 0, ideal: 0, errLegacy: 0, errFull: 0, n: 0 };
  for (const [name, shape] of Object.entries(HANDWRITING)) {
    for (const scale of [0.6, 0.85]) {
      for (const speed of [30, 150, 450]) {
        const { samples, path } = pencilSamples(shape, speed, 7);
        const legacyPts = legacyStore(samples, scale);
        const fullPts = stabilizedStore(samples, scale);
        const s = (pts) => pen(pts, PEN_SIZES.medium);
        const J = {
          legacy: turningPerLength(outlineOfCenterline(legacyCenterline(s(legacyPts)))),
          renderOnly: turningPerLength(strokeOutline(s(legacyPts))), // strokes saved by v1.0.4, drawn by 1.0.5
          full: turningPerLength(strokeOutline(s(fullPts))),
          ideal: turningPerLength(strokeOutline(s(stabilizedStore(samples, scale, false)))), // fractional input
        };
        const tag = `${name} scale ${scale} ${speed} px/s`;
        assert.ok(J.renderOnly < J.legacy, `${tag}: render ${J.renderOnly} vs legacy ${J.legacy}`);
        assert.ok(J.full <= J.legacy, `${tag}: full ${J.full} vs legacy ${J.legacy}`);
        for (const k of ['legacy', 'renderOnly', 'full', 'ideal']) sum[k] += J[k];
        sum.errLegacy += pathError(legacyCenterline(s(legacyPts)), path, scale, 0.5);
        sum.errFull += pathError(strokeCenterline(s(fullPts)), path, scale, 0.5);
        sum.n++;
      }
    }
  }
  const mean = (k) => sum[k] / sum.n;
  console.log(`  outline turning per lu (mean of ${sum.n} strokes): v1.0.4 ${mean('legacy').toFixed(3)}, ` +
    `1.0.5 render only ${mean('renderOnly').toFixed(3)}, 1.0.5 input + render ${mean('full').toFixed(3)}, ` +
    `fractional-input reference ${mean('ideal').toFixed(3)}; RMS path error v1.0.4 ${mean('errLegacy').toFixed(3)} lu, ` +
    `1.0.5 ${mean('errFull').toFixed(3)} lu`);
  assert.ok(mean('renderOnly') < 0.35 * mean('legacy'), 'old strokes are drawn much smoother');
  assert.ok(mean('full') < 0.2 * mean('legacy'), 'new strokes: at least 5× less turning');
  assert.ok(mean('full') < 1.15 * mean('ideal'), 'new strokes: as smooth as with fractional coordinates');
  assert.ok(mean('errFull') < mean('errLegacy'), 'and closer to the real pen path');
});

test('smoothness: a 1-px staircase has no kinks; real corners stay sharp', () => {
  // Diagonal line, whole-pixel coordinates at scale 0.6: v1.0.4 kept every pixel step as a corner.
  const { samples } = pencilSamples(HANDWRITING.diagonal, 30, 3);
  const stairs = pen(legacyStore(samples, 0.6), PEN_SIZES.medium);
  const turns = {
    legacy: maxVertexTurn(legacyCenterline(stairs)),
    renderOnly: maxVertexTurn(strokeCenterline(stairs)),
    full: maxVertexTurn(strokeCenterline(pen(stabilizedStore(samples, 0.6), PEN_SIZES.medium))),
  };
  console.log(`  1-px staircase, largest turn between centreline segments: v1.0.4 ${turns.legacy.toFixed(1)}°, ` +
    `1.0.5 render only ${turns.renderOnly.toFixed(1)}°, 1.0.5 input + render ${turns.full.toFixed(1)}°`);
  assert.ok(turns.legacy >= 45, 'v1.0.4: pixel steps are kinks');
  assert.ok(turns.renderOnly < 20, 'strokes saved by v1.0.4: no kinks any more');
  assert.ok(turns.full < 8, 'new strokes: smooth');

  // A 90° turn with 20-lu legs, sparse (3 points) and dense (every 0.5 lu, as the Pencil samples it).
  const dense = [];
  for (let i = 0; i <= 40; i++) dense.push(i * 0.5, 0, 0.5);
  for (let i = 1; i <= 40; i++) dense.push(20, i * 0.5, 0.5);
  for (const [label, pts] of [['sparse', [0, 0, 0.5, 20, 0, 0.5, 20, 20, 0.5]], ['dense', dense]]) {
    const s = pen(pts, PEN_SIZES.medium);
    const cl = strokeCenterline(s);
    let nearest = Infinity;
    for (let i = 0; i < cl.length; i += 3) nearest = Math.min(nearest, Math.hypot(cl[i] - 20, cl[i + 1]));
    assert.ok(nearest < 1e-6, `${label}: the centreline goes through the corner (${nearest})`);
    assert.ok(maxVertexTurn(cl) > 85, `${label}: one sharp vertex`);
    const r = widthAt(s, 0.5) / 2;
    const poly = strokeOutline(s);
    assert.notEqual(winding(poly, 20 + 0.7 * r * Math.SQRT1_2, -0.7 * r * Math.SQRT1_2), 0, `${label}: outer corner inked`);
    assert.equal(winding(poly, 20 - 2 * r, 2 * r), 0, `${label}: the inside of the corner stays empty`);
  }

  // The same corner written with whole-pixel coordinates (decelerating into the corner) still has one.
  const ku = (u) => (u < 0.5 ? [25 - 50 * u, 44 * u] : [50 * (u - 0.5), 22 + 44 * (u - 0.5)]);
  const { samples: kuSamples } = pencilSamples(ku, 60, 5);
  const cl = strokeCenterline(pen(stabilizedStore(kuSamples, 0.6), PEN_SIZES.medium));
  assert.ok(maxVertexTurn(cl) > 70, `く keeps its corner (${maxVertexTurn(cl)}°)`);
});

test('smoothness: strokes saved by v1.0.4 keep a gentle wave (≤ ~0.4 CSS px) on shallow lines; new ones are straighter', () => {
  // What render.js / SPEC say about old strokes: the Gaussian (σ = 1.2 lu) is far shorter than the period of
  // a shallow line's staircase, so it rounds the pixel steps' kinks but cannot straighten the long steps.
  // New strokes are reconstructed while they are written (InkStabilizer) instead.
  const wave = (pts, slope, scale) => {
    const n = pts.length / 3;
    const d = [];
    for (let i = 0; i < n; i++) d.push(((pts[3 * i] * slope - pts[3 * i + 1]) / Math.hypot(1, slope)) * scale);
    const mid = d.slice(Math.floor(n * 0.1), Math.ceil(n * 0.9)); // away from the (unknowable) ends
    return (Math.max(...mid) - Math.min(...mid)) / 2;
  };
  for (const scale of [0.586, 0.7, 0.85]) {
    for (const slope of [0.05, 0.1, 0.2]) {
      const { samples } = pencilSamples((u) => [u * 60, 0.3 + u * 60 * slope], 40, 9);
      const tag = `scale ${scale}, slope ${slope}`;
      const old = legacyStore(samples, scale);
      const stored = wave(old, slope, scale);
      const drawn = wave(strokeCenterline(pen(old, PEN_SIZES.medium)), slope, scale);
      const fresh = wave(strokeCenterline(pen(stabilizedStore(samples, scale), PEN_SIZES.medium)), slope, scale);
      assert.ok(stored > 0.45, `${tag}: the stored staircase ±${stored.toFixed(2)} px`);
      assert.ok(drawn < 0.45 && drawn < stored, `${tag}: an old stroke is drawn with a wave of ±${drawn.toFixed(2)} px`);
      assert.ok(fresh < drawn, `${tag}: a new stroke ±${fresh.toFixed(2)} px`);
    }
  }
});

test('smoothness: dots stay round, short flicks stay strokes', () => {
  for (const pts of [[30, 40, 0.6], [30, 40, 0.6, 30.1, 40.05, 0.7, 29.95, 40, 0.65]]) {
    const s = pen(pts, PEN_SIZES.thick);
    const poly = strokeOutline(s);
    const r = widthAt(s, 0.7 * (pts.length > 3) + 0.6 * (pts.length === 3)) / 2;
    for (let i = 0; i < poly.length; i += 2) assert.ok(Math.abs(Math.hypot(poly[i] - 30, poly[i + 1] - 40) - r) < 1e-9);
  }
  const flick = strokeCenterline(pen([0, 0, 0.5, 1.5, -2, 0.5, 2, -4, 0.4], PEN_SIZES.medium));
  assert.ok(flick.length >= 6, 'a 4-lu flick is not collapsed into a dot');
  assert.deepEqual([flick[0], flick[1]], [0, 0]);
  assert.deepEqual([flick.at(-3), flick.at(-2)], [2, -4]);
});
