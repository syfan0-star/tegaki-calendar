// Tests for js/ink/surface.js (module E).
//
// Pure helpers are tested directly. InkSurface itself is driven through a small fake DOM (elements,
// canvases with a recording 2D context, manual requestAnimationFrame).
//
// The real js/ink/{model,geometry,render}.js are used when they exist. If one is missing (other
// agents work in parallel) — or with TEGAKI_FAKE_INK=1 — a minimal spec-faithful fake is served
// through a module resolution hook instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// ---------------------------------------------------------------------------------------------
// Fallback fakes for the sibling ink modules (SPEC §4 B)
// ---------------------------------------------------------------------------------------------

let fakeSeq = 0;
const r1 = (v) => Math.round(v * 10) / 10 || 0;
const r2 = (v) => Math.round(v * 100) / 100 || 0;
const roundPts = (pts, dx = 0, dy = 0) => pts.map((v, i) => (i % 3 === 0 ? r1(v + dx) : i % 3 === 1 ? r1(v + dy) : r2(v)));

const fakeModel = {
  emptyPage: (pageId) => ({ v: 1, pageId, strokes: {}, deleted: {}, updatedAt: 0 }),
  newStrokeId: () => `fake-${++fakeSeq}`,
  makeStroke: ({ tool, color, size, pts, t }) => ({ id: fakeModel.newStrokeId(), tool, color, size, pts: roundPts(pts), t: t ?? Date.now() }),
  addStrokes(doc, strokes, now = Date.now()) {
    const s = { ...doc.strokes };
    for (const st of strokes) if (!doc.deleted[st.id] && st.pts.length >= 3) s[st.id] = st;
    return { ...doc, strokes: s, updatedAt: now };
  },
  removeStrokes(doc, ids, now = Date.now()) {
    const s = { ...doc.strokes };
    const d = { ...doc.deleted };
    for (const item of ids) {
      const id = typeof item === 'object' ? item.id : item;
      delete s[id];
      d[id] = now;
    }
    return { ...doc, strokes: s, deleted: d, updatedAt: now };
  },
  mergePages: (a) => a,
  liveStrokes(doc) {
    return Object.values(doc.strokes).sort((a, b) => {
      const ka = a.tool === 'highlighter' ? 0 : 1;
      const kb = b.tool === 'highlighter' ? 0 : 1;
      return ka - kb || a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
  },
  cloneStrokes: (strokes, { dx = 0, dy = 0, color } = {}) => strokes.map((s) => ({
    ...s, id: fakeModel.newStrokeId(), pts: roundPts(s.pts, dx, dy), color: color ?? s.color,
  })),
  applyOp(doc, op, now) {
    if (op.type === 'add') return fakeModel.addStrokes(doc, op.strokes, now);
    if (op.type === 'remove') return fakeModel.removeStrokes(doc, op.strokes, now);
    if (op.type === 'batch') return op.ops.reduce((d, o) => fakeModel.applyOp(d, o, now), doc);
    return doc;
  },
  invertOp(op) {
    if (op.type === 'add') return { type: 'remove', strokes: op.strokes };
    if (op.type === 'remove') return { type: 'add', strokes: fakeModel.cloneStrokes(op.strokes) };
    return { type: 'batch', ops: op.ops.slice().reverse().map(fakeModel.invertOp) };
  },
  sameContent: () => true,
  serializePage: (doc) => JSON.stringify(doc),
  deserializePage: (json) => JSON.parse(json),
};

const fakeRender = {
  PEN_COLORS: ['#1f2937', '#2563eb', '#dc2626', '#16a34a', '#ea580c', '#7c3aed'],
  HIGHLIGHTER_COLORS: ['#fde047', '#f9a8d4', '#86efac', '#93c5fd'],
  PEN_SIZES: { thin: 2, medium: 3.5, thick: 6 },
  HIGHLIGHTER_SIZE: 18,
  HIGHLIGHTER_ALPHA: 0.35,
  widthAt: (s, p) => (s.tool === 'highlighter' ? s.size : s.size * (0.4 + 0.9 * (Number.isFinite(p) ? p : 0.5))),
  strokeOutline: () => [],
  drawStroke: (ctx) => { ctx.fill(); },
  drawStrokes: (ctx, strokes) => { for (const s of strokes) fakeRender.drawStroke(ctx, s); },
  drawLiveStroke: (ctx) => { ctx.stroke(); },
};

const fakeGeometry = {
  strokeBBox(s) {
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (let i = 0; i < s.pts.length; i += 3) {
      minX = Math.min(minX, s.pts[i]); maxX = Math.max(maxX, s.pts[i]);
      minY = Math.min(minY, s.pts[i + 1]); maxY = Math.max(maxY, s.pts[i + 1]);
    }
    const h = fakeRender.widthAt(s, 1) / 2;
    return { minX: minX - h, minY: minY - h, maxX: maxX + h, maxY: maxY + h };
  },
  unionBBox(boxes) {
    if (!boxes.length) return null;
    return boxes.reduce((a, b) => ({
      minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY),
    }));
  },
  bboxIntersects: () => false,
  pointInPolygon(x, y, poly) {
    let inside = false;
    const n = poly.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = poly[i * 2]; const yi = poly[i * 2 + 1]; const xj = poly[j * 2]; const yj = poly[j * 2 + 1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  },
  strokeInLasso(s, poly) {
    let inside = 0;
    const n = s.pts.length / 3;
    for (let i = 0; i < s.pts.length; i += 3) if (fakeGeometry.pointInPolygon(s.pts[i], s.pts[i + 1], poly)) inside++;
    return inside * 2 >= n;
  },
  segmentDistance(px, py, ax, ay, bx, by) {
    const vx = bx - ax; const vy = by - ay;
    const len2 = vx * vx + vy * vy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2)) : 0;
    return Math.hypot(px - ax - t * vx, py - ay - t * vy);
  },
  strokeHitsCircle(s, cx, cy, r) {
    const reach = r + s.size / 2;
    const p = s.pts;
    if (p.length === 3) return Math.hypot(p[0] - cx, p[1] - cy) <= reach;
    for (let i = 3; i < p.length; i += 3) {
      if (fakeGeometry.segmentDistance(cx, cy, p[i - 3], p[i - 2], p[i], p[i + 1]) <= reach) return true;
    }
    return false;
  },
  translateRect: (r, dx, dy) => ({ minX: r.minX + dx, minY: r.minY + dy, maxX: r.maxX + dx, maxY: r.maxY + dy }),
};

const FAKES = { 'model.js': fakeModel, 'geometry.js': fakeGeometry, 'render.js': fakeRender };
globalThis.__tegakiInkFakes = FAKES;
const FORCE_FAKES = process.env.TEGAKI_FAKE_INK === '1';
const usedFakes = new Set();

function fakeSource(name) {
  const mod = FAKES[name];
  const ref = `globalThis.__tegakiInkFakes[${JSON.stringify(name)}]`;
  return Object.keys(mod).map((k) => (typeof mod[k] === 'function'
    ? `export function ${k}(...a) { return ${ref}.${k}(...a); }`
    : `export const ${k} = ${ref}.${k};`)).join('\n');
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const name = specifier.split('/').pop();
    const fromInk = typeof context.parentURL === 'string' && context.parentURL.includes('/js/ink/');
    const candidate = fromInk && specifier.startsWith('./') && Object.hasOwn(FAKES, name);
    if (candidate && FORCE_FAKES) return { url: `tegaki-fake:${name}`, shortCircuit: true };
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (candidate) return { url: `tegaki-fake:${name}`, shortCircuit: true };
      throw err;
    }
  },
  load(url, context, nextLoad) {
    if (url.startsWith('tegaki-fake:')) {
      const name = url.slice('tegaki-fake:'.length);
      usedFakes.add(name);
      return { format: 'module', source: fakeSource(name), shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const S = await import('../js/ink/surface.js');
const {
  InkSurface, UndoHistory, acceptsPointer, touchListHasStylus, pointerPressure, resolveScale, clientToLogical,
  computeBackingSize, shouldAppendPoint, finalizeStrokePoints, samplePointsAlong, closeLassoPolygon, normalizeRect,
  isRect, pointInRect, clampMoveDelta, logicalRectToScreen, computeSnapshotLayout, retainGestureBlock,
  releaseGestureBlock, simplifyPolygon, MAX_CANVAS_PIXELS, UNDO_LIMIT, ERASER_RADIUS,
} = S;
// The real render module (for comparing the live preview with the committed outline), unless faked.
const realRender = await import('../js/ink/render.js').catch(() => null);

test('ink dependencies in use', () => {
  // Informational: shows whether the real sibling modules or the fallback fakes were exercised.
  const used = [...usedFakes].sort();
  if (used.length) console.log(`# surface tests use fallback fakes for: ${used.join(', ')}`);
  assert.ok(true);
});

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

test('acceptsPointer: pen always, mouse main button, touch only with allowFinger', () => {
  assert.equal(acceptsPointer({ pointerType: 'pen', button: 0 }, false), true);
  assert.equal(acceptsPointer({ pointerType: 'pen', button: 5 }, false), true);
  assert.equal(acceptsPointer({ pointerType: 'mouse', button: 0 }, false), true);
  assert.equal(acceptsPointer({ pointerType: 'mouse', button: 2 }, true), false);
  assert.equal(acceptsPointer({ pointerType: 'touch', button: 0 }, false), false);
  assert.equal(acceptsPointer({ pointerType: 'touch', button: 0 }, true), true);
  assert.equal(acceptsPointer({ pointerType: '', button: 0 }, true), false);
  assert.equal(acceptsPointer(null, true), false);
});

test('touchListHasStylus detects the Pencil in a TouchList-like', () => {
  assert.equal(touchListHasStylus([{ touchType: 'direct' }, { touchType: 'stylus' }]), true);
  assert.equal(touchListHasStylus([{ touchType: 'direct' }]), false);
  assert.equal(touchListHasStylus({ length: 1, item: () => ({ touchType: 'stylus' }) }), true);
  assert.equal(touchListHasStylus(undefined), false);
  assert.equal(touchListHasStylus([]), false);
});

test('pointerPressure: pen pressure, fallback when 0, constant for touch/mouse', () => {
  assert.equal(pointerPressure('pen', 0.73), 0.73);
  assert.equal(pointerPressure('pen', 1.4), 1);
  assert.equal(pointerPressure('pen', 0), 0.5);
  assert.equal(pointerPressure('pen', 0, 0.8), 0.8);
  assert.equal(pointerPressure('pen', NaN, 7), 0.5);
  assert.equal(pointerPressure('touch', 0), 0.5);
  assert.equal(pointerPressure('mouse', 0.9), 0.5);
});

test('resolveScale and clientToLogical map client px to logical units', () => {
  const rect = { left: 10, top: 20, width: 700, height: 960 };
  assert.equal(resolveScale(rect, 1400, 3), 0.5);
  assert.equal(resolveScale({ width: 0 }, 1400, 0.75), 0.75);
  assert.equal(resolveScale(null, 1400, 0), 1);
  assert.deepEqual(clientToLogical(60, 70, rect, 0.5), { x: 100, y: 100 });
  assert.deepEqual(clientToLogical(10, 20, rect, 0), { x: 0, y: 0 }); // bad scale → 1
});

test('computeBackingSize keeps every canvas within 16,777,216 px', () => {
  assert.deepEqual(computeBackingSize(700, 960, 2), { width: 1400, height: 1920, ratio: 2 });
  // Day page on a 12.9" iPad in landscape: 1366 × 3278 CSS px at dpr 2 would be 17.9 M px.
  const big = computeBackingSize(1366, 3278.4, 2);
  assert.ok(big.width * big.height <= MAX_CANVAS_PIXELS);
  assert.ok(big.ratio < 2 && big.ratio > 1.9);
  // Absurd aspect ratio still respects the cap.
  const odd = computeBackingSize(1e9, 0.001, 2, 1000);
  assert.ok(odd.width * odd.height <= 1000);
  assert.deepEqual(computeBackingSize(NaN, -5, 0), { width: 1, height: 1, ratio: 1 });
});

test('shouldAppendPoint drops micro-jitter', () => {
  assert.equal(shouldAppendPoint([], 1, 1), true);
  assert.equal(shouldAppendPoint([0, 0, 0.5], 0.2, 0.1), false);
  assert.equal(shouldAppendPoint([0, 0, 0.5], 0.3, 0), true);
  assert.equal(shouldAppendPoint([0, 0, 0.5], NaN, 0), false);
  assert.equal(shouldAppendPoint([0, 0], 1, 1, 2, 2), false); // lasso stride 2
  assert.equal(shouldAppendPoint([0, 0], 2, 0, 2, 2), true);
});

test('finalizeStrokePoints rounds, clamps and merges consecutive duplicates', () => {
  assert.deepEqual(finalizeStrokePoints([1.04, 2.06, 0.555, 1.01, 2.09, 0.9, 5, 5, 1.7]), [1, 2.1, 0.9, 5, 5, 1]);
  assert.deepEqual(finalizeStrokePoints([3, 4, 0.5]), [3, 4, 0.5]); // a dot
  assert.deepEqual(finalizeStrokePoints([NaN, 1, 0.5, 2, 2, NaN]), [2, 2, 0.5]);
  assert.deepEqual(finalizeStrokePoints([-0.01, 0, 0.5]), [0, 0, 0.5]);
  assert.ok(!Object.is(finalizeStrokePoints([-0.01, 0, 0.5])[0], -0));
  assert.deepEqual(finalizeStrokePoints([]), []);
  assert.deepEqual(finalizeStrokePoints(null), []);
});

test('samplePointsAlong spaces samples at most `step` apart and ends at the target', () => {
  assert.deepEqual(samplePointsAlong(0, 0, 3, 4, 10), [3, 4]);
  const s = samplePointsAlong(0, 0, 20, 0, 5);
  assert.deepEqual(s, [5, 0, 10, 0, 15, 0, 20, 0]);
  assert.deepEqual(samplePointsAlong(0, 0, 1, 1, 0), [1, 1]);
});

test('closeLassoPolygon closes the path and rejects taps', () => {
  assert.deepEqual(closeLassoPolygon([0, 0, 10, 0, 10, 10]), [0, 0, 10, 0, 10, 10, 0, 0]);
  assert.deepEqual(closeLassoPolygon([0, 0, 10, 0, 10, 10, 0, 0]), [0, 0, 10, 0, 10, 10, 0, 0]);
  assert.equal(closeLassoPolygon([0, 0, 1, 1]), null);
  assert.equal(closeLassoPolygon([0, 0, 1, 1, 2, 0]), null); // smaller than 4 lu → tap
  assert.equal(closeLassoPolygon(null), null);
});

test('simplifyPolygon drops vertices within epsilon, keeps the lasso closed and the shape', () => {
  // A hand-drawn circle: one vertex every ~2 lu (as the lasso stores them), closed.
  const R = 500;
  const n = Math.ceil((2 * Math.PI * R) / 2);
  const circle = [];
  for (let i = 0; i < n; i++) circle.push(700 + R * Math.cos((2 * Math.PI * i) / n), 900 + R * Math.sin((2 * Math.PI * i) / n));
  const closed = closeLassoPolygon(circle);
  const simple = simplifyPolygon(closed, 1);
  assert.ok(simple.length / 2 < 120, `${simple.length / 2} vertices`);
  assert.ok(simple.length / 2 >= 8);
  assert.deepEqual(simple.slice(0, 2), closed.slice(0, 2));
  assert.deepEqual(simple.slice(-2), closed.slice(-2), 'still closed');
  // Every dropped vertex is within epsilon of the simplified outline.
  const dist = (px, py, ax, ay, bx, by) => {
    const vx = bx - ax; const vy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
    return Math.hypot(px - ax - t * vx, py - ay - t * vy);
  };
  for (let i = 0; i < closed.length; i += 2) {
    let best = Infinity;
    for (let j = 2; j < simple.length; j += 2) best = Math.min(best, dist(closed[i], closed[i + 1], simple[j - 2], simple[j - 1], simple[j], simple[j + 1]));
    assert.ok(best <= 1 + 1e-9, `vertex ${i / 2} is ${best} lu away`);
  }
  // Small or unsimplifiable inputs come back unchanged (as a copy).
  const square = [0, 0, 10, 0, 10, 10, 0, 10, 0, 0];
  assert.deepEqual(simplifyPolygon(square, 1), square);
  assert.notEqual(simplifyPolygon(square, 1), square);
  const sliver = [0, 0, 50, 0.2, 100, 0, 50, -0.2, 0, 0, 0.1, 0];
  assert.deepEqual(simplifyPolygon(sliver, 1), sliver, 'would collapse below 3 vertices');
  assert.deepEqual(simplifyPolygon(null), []);
});

test('rect helpers', () => {
  assert.deepEqual(normalizeRect(5, 9, 1, 2), { minX: 1, minY: 2, maxX: 5, maxY: 9 });
  assert.equal(isRect({ minX: 0, minY: 0, maxX: 1, maxY: 1 }), true);
  assert.equal(isRect({ minX: 2, minY: 0, maxX: 1, maxY: 1 }), false);
  assert.equal(isRect(null), false);
  const r = { minX: 10, minY: 10, maxX: 20, maxY: 20 };
  assert.equal(pointInRect(15, 15, r), true);
  assert.equal(pointInRect(25, 15, r), false);
  assert.equal(pointInRect(25, 15, r, 5), true);
});

test('clampMoveDelta keeps the selection on the page without pushing it', () => {
  const box = { minX: 100, minY: 100, maxX: 200, maxY: 150 };
  assert.deepEqual(clampMoveDelta(box, 50, -20, 1400, 1920), { dx: 50, dy: -20 });
  assert.deepEqual(clampMoveDelta(box, -500, 5000, 1400, 1920), { dx: -100, dy: 1770 });
  // Already sticking out on the left: may come back, may not go further, is not pushed by a 0 move.
  const out = { minX: -3, minY: 10, maxX: 50, maxY: 20 };
  assert.deepEqual(clampMoveDelta(out, 0, 0, 1400, 1920), { dx: 0, dy: 0 });
  assert.deepEqual(clampMoveDelta(out, -10, 0, 1400, 1920), { dx: 0, dy: 0 });
  assert.deepEqual(clampMoveDelta(out, 10, 0, 1400, 1920), { dx: 10, dy: 0 });
  assert.deepEqual(clampMoveDelta(null, 3, 4, 10, 10), { dx: 3, dy: 4 });
});

test('logicalRectToScreen converts with the page rect and scale', () => {
  const s = logicalRectToScreen({ minX: 100, minY: 200, maxX: 300, maxY: 260 }, { left: 10, top: -40 }, 0.5);
  assert.deepEqual(s, { x: 60, y: 60, left: 60, top: 60, right: 160, bottom: 90, width: 100, height: 30 });
});

test('computeSnapshotLayout pads by 12 lu and fits within maxW × maxH', () => {
  const l = computeSnapshotLayout({ minX: 100, minY: 100, maxX: 476, maxY: 136 }, { maxW: 480, maxH: 240 });
  assert.deepEqual(l.rect, { minX: 88, minY: 88, maxX: 488, maxY: 148 });
  assert.equal(l.zoom, 1.2);
  assert.equal(l.width, 480);
  assert.equal(l.height, 72);
  const tiny = computeSnapshotLayout({ minX: 0, minY: 0, maxX: 2, maxY: 2 });
  assert.equal(tiny.zoom, 4); // never enlarged more than 4×
  assert.ok(tiny.width <= 480 && tiny.height <= 240);
  const tall = computeSnapshotLayout({ minX: 0, minY: 0, maxX: 100, maxY: 2000 }, { maxW: 480, maxH: 240 });
  assert.ok(tall.height <= 240 && tall.width >= 1);
  assert.equal(computeSnapshotLayout(null), null);
});

test('UndoHistory: record clears redo, undo/redo invert, max depth, failed apply keeps stacks', () => {
  const invert = (op) => ({ inv: op });
  const h = new UndoHistory({ limit: 3, invert });
  assert.equal(h.canUndo(), false);
  h.record('a');
  h.record('b');
  const applied = [];
  assert.deepEqual(h.undo((op) => applied.push(op)), { inv: 'b' });
  assert.equal(h.canRedo(), true);
  assert.deepEqual(h.redo((op) => applied.push(op)), { inv: { inv: 'b' } });
  assert.deepEqual(applied, [{ inv: 'b' }, { inv: { inv: 'b' } }]);
  h.undo();
  h.record('c'); // a new change discards redo
  assert.equal(h.canRedo(), false);
  h.record('d');
  h.record('e');
  assert.equal(h.undoDepth, 3); // limit
  assert.throws(() => h.undo(() => { throw new Error('boom'); }));
  assert.equal(h.undoDepth, 3);
  assert.equal(h.redoDepth, 0);
  h.clear();
  assert.equal(h.undo(), null);
  assert.equal(h.redo(), null);
  assert.equal(new UndoHistory({ invert }).undoDepth, 0);
  assert.equal(UNDO_LIMIT, 200);
  assert.throws(() => new UndoHistory({}), TypeError);
});

test('UndoHistory: discardLastUndo / discardLastRedo drop one step', () => {
  const h = new UndoHistory({ invert: (op) => ({ inv: op }) });
  h.record('a');
  h.record('b');
  h.undo();
  assert.deepEqual(h.discardLastRedo(), { inv: 'b' });
  assert.equal(h.canRedo(), false);
  assert.equal(h.undoDepth, 1);
  assert.equal(h.discardLastUndo(), 'a');
  assert.equal(h.canUndo(), false);
  assert.equal(h.discardLastUndo(), null);
  assert.equal(h.discardLastRedo(), null);
});

test('UndoHistory default limit is 200', () => {
  const h = new UndoHistory({ invert: (x) => x });
  for (let i = 0; i < 250; i++) h.record(i);
  assert.equal(h.undoDepth, 200);
  assert.equal(h.undo(), 249);
});

test('gesture blocker is registered once per document and removed with the last release', () => {
  const dom = new FakeDocument();
  retainGestureBlock(dom);
  retainGestureBlock(dom);
  assert.equal(dom.listenerCount('gesturestart'), 1);
  assert.equal(dom.listenerCount('gesturechange'), 1);
  assert.equal(dom.listenerCount('gestureend'), 1);
  const e = evt();
  dom.dispatch('gesturestart', e);
  assert.equal(e.defaultPrevented, true);
  releaseGestureBlock(dom);
  assert.equal(dom.listenerCount('gesturestart'), 1);
  releaseGestureBlock(dom);
  assert.equal(dom.listenerCount('gesturestart'), 0);
  releaseGestureBlock(dom); // extra release is harmless
  assert.equal(dom.listenerCount('gesturestart'), 0);
});

// ---------------------------------------------------------------------------------------------
// Fake DOM
// ---------------------------------------------------------------------------------------------

function evt(props = {}) {
  return {
    cancelable: true,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
    ...props,
  };
}

class FakeEventTarget {
  constructor() { this.listeners = []; }
  addEventListener(type, fn, opts) {
    const capture = typeof opts === 'boolean' ? opts : !!opts?.capture;
    this.listeners.push({ type, fn, opts, capture });
  }
  removeEventListener(type, fn, opts) {
    const capture = typeof opts === 'boolean' ? opts : !!opts?.capture;
    const i = this.listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === capture);
    if (i >= 0) this.listeners.splice(i, 1);
  }
  listenerCount(type) { return this.listeners.filter((l) => l.type === type).length; }
  listenerOptions(type) { return this.listeners.find((l) => l.type === type)?.opts; }
  dispatch(type, e) {
    e.type = type;
    for (const l of this.listeners.slice()) if (l.type === type) l.fn.call(this, e);
    return e;
  }
}

class FakeElement extends FakeEventTarget {
  constructor(dom, tag) {
    super();
    this.ownerDocument = dom;
    this.tagName = String(tag).toUpperCase();
    this.style = { cssText: '' };
    this.attributes = {};
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this.captures = new Set();
    this.rect = { left: 0, top: 0, width: 0, height: 0 };
  }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'class') this.className = String(v); }
  getAttribute(k) { return Object.hasOwn(this.attributes, k) ? this.attributes[k] : null; }
  appendChild(c) { c.parentNode?.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; }
  remove() { this.parentNode?.removeChild(this); }
  closest(sel) {
    // Supports a comma-separated list of '.class', '[attr]' and '[attr="value"]'.
    const tests = sel.split(',').map((s) => s.trim()).map((s) => {
      if (s.startsWith('.')) return (n) => String(n.className).split(/\s+/).includes(s.slice(1));
      const m = s.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
      if (!m) return () => false;
      return (n) => (m[2] === undefined ? n.getAttribute?.(m[1]) != null : n.getAttribute?.(m[1]) === m[2]);
    });
    for (let n = this; n; n = n.parentNode) if (tests.some((t) => t(n))) return n;
    return null;
  }
  getBoundingClientRect() {
    const r = this.rect;
    return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top };
  }
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) { this.captures.delete(id); }
}

function makeCtx(canvas) {
  const calls = [];
  const state = {
    globalAlpha: 1, lineWidth: 1, strokeStyle: '#000000', fillStyle: '#000000', lineCap: 'butt', lineJoin: 'miter',
    globalCompositeOperation: 'source-over', canvas,
  };
  return new Proxy({}, {
    get(_, k) {
      if (k === 'calls') return calls;
      if (Object.hasOwn(state, k)) return state[k];
      if (typeof k === 'symbol') return undefined;
      return (...args) => { calls.push([k, ...args]); };
    },
    set(_, k, v) { state[k] = v; return true; },
  });
}

class FakeCanvas extends FakeElement {
  constructor(dom) {
    super(dom, 'canvas');
    this.width = 300;
    this.height = 150;
    this.ctx = null;
  }
  getContext(kind) { return kind === '2d' ? (this.ctx ??= makeCtx(this)) : null; }
  toDataURL(type) { return `data:${type || 'image/png'};base64,FAKE${this.width}x${this.height}`; }
}

class FakeDocument extends FakeEventTarget {
  constructor({ dpr = 2 } = {}) {
    super();
    this.created = [];
    const queue = new Map();
    let nextId = 1;
    this.frames = queue;
    this.defaultView = {
      devicePixelRatio: dpr,
      requestAnimationFrame: (cb) => { const id = nextId++; queue.set(id, cb); return id; },
      cancelAnimationFrame: (id) => { queue.delete(id); },
    };
  }
  createElement(tag) {
    const el = tag === 'canvas' ? new FakeCanvas(this) : new FakeElement(this, tag);
    this.created.push(el);
    return el;
  }
  createElementNS(ns, tag) { return this.createElement(tag); }
  flush() {
    for (let i = 0; i < 20 && this.frames.size; i++) {
      const cbs = [...this.frames.values()];
      this.frames.clear();
      for (const cb of cbs) cb(16 * i);
    }
  }
}

// Builds a page + surface. Coordinates in helpers below are LOGICAL; they are converted to client px.
function setup({ W = 1400, H = 1920, scale = 0.5, left = 10, top = 20, dpr = 2, pageId = 'w-2026-09-27' } = {}) {
  const dom = new FakeDocument({ dpr });
  const pageEl = dom.createElement('div');
  pageEl.className = 'page';
  const info = { pageId, W, H, scale, view: 'week', range: null };
  pageEl.rect = { left, top, width: W * scale, height: H * scale };
  const viewportEl = dom.createElement('div');
  const calls = { commits: [], selections: [], eventRects: [], previews: [] };
  const surface = new InkSurface({
    pageEl,
    viewportEl,
    getPageInfo: () => ({ ...info }),
    onCommit: (doc, op) => calls.commits.push({ doc, op }),
    onSelectionChange: (sel) => calls.selections.push(sel),
    onEventRect: (rect, meta) => calls.eventRects.push({ rect, meta }),
    onEventPreview: (rect) => {
      calls.previews.push(rect);
      return rect ? { minX: 64, minY: rect.minY, maxX: 254, maxY: Math.max(rect.maxY, rect.minY + 80) } : null;
    },
  });
  const env = { dom, pageEl, viewportEl, surface, calls, info };
  env.client = (x, y) => ({ clientX: left + x * info.scale, clientY: top + y * info.scale });
  return env;
}

function pointer(env, type, x, y, { id = 1, pointerType = 'pen', pressure = 0.5, button = 0, buttons, target, coalesced, predicted } = {}) {
  const e = evt({
    pointerId: id, pointerType, pressure, button,
    buttons: buttons ?? (type === 'pointerup' || type === 'pointercancel' ? 0 : 1),
    target: target ?? env.pageEl,
    ...env.client(x, y),
  });
  // Coalesced / predicted entries deliberately lack pointerId (Safari 18.2 behaviour).
  if (coalesced) e.getCoalescedEvents = () => coalesced.map(([cx, cy, p = 0.5]) => ({ ...env.client(cx, cy), pressure: p }));
  if (predicted) e.getPredictedEvents = () => predicted.map(([cx, cy]) => ({ ...env.client(cx, cy), pressure: 0.5 }));
  return env.pageEl.dispatch(type, e);
}

/** Draws a full gesture through the given logical points. */
function gesture(env, points, opts = {}) {
  const [first, ...rest] = points;
  pointer(env, 'pointerdown', first[0], first[1], opts);
  for (const [x, y] of rest) pointer(env, 'pointermove', x, y, opts);
  env.dom.flush();
  const last = points[points.length - 1];
  pointer(env, 'pointerup', last[0], last[1], opts);
  env.dom.flush();
}

const line = (x0, y0, x1, y1, steps = 8) => Array.from({ length: steps + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps]);
const lastOp = (env) => env.calls.commits[env.calls.commits.length - 1].op;
const strokeCount = (env) => Object.keys(env.surface.getDoc().strokes).length;
const canvasOf = (env, cls) => env.pageEl.children.find((c) => c.className === cls);

// ---------------------------------------------------------------------------------------------
// InkSurface
// ---------------------------------------------------------------------------------------------

test('InkSurface creates base/overlay/live layers inside pageEl with capped backing stores', () => {
  const env = setup();
  const classes = env.pageEl.children.map((c) => c.className);
  assert.deepEqual(classes, ['ink-base', 'ink-overlay', 'ink-live']);
  const base = canvasOf(env, 'ink-base');
  const live = canvasOf(env, 'ink-live');
  assert.match(base.style.cssText, /z-index:3/);
  assert.match(env.pageEl.children[1].style.cssText, /z-index:4/);
  assert.match(live.style.cssText, /z-index:5/);
  assert.match(base.style.cssText, /pointer-events:none/);
  assert.equal(base.width, 1400);
  assert.equal(base.height, 1920);
  assert.equal(live.width, 1400);
  assert.equal(env.pageEl.children[1].getAttribute('viewBox'), '0 0 1400 1920');
  assert.equal(env.pageEl.style.touchAction, 'pan-x pan-y');
  // Listeners live on pageEl; touch listeners are non-passive.
  for (const t of ['touchstart', 'touchmove', 'touchend']) assert.equal(env.pageEl.listenerOptions(t)?.passive, false);
  for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture', 'contextmenu', 'selectstart']) {
    assert.equal(env.pageEl.listenerCount(t), 1, t);
  }
  assert.equal(env.dom.listenerCount('gesturestart'), 1);
  env.surface.destroy();

  const tall = setup({ W: 1000, H: 2400, scale: 1.366 });
  const tb = canvasOf(tall, 'ink-base');
  assert.ok(tb.width * tb.height <= MAX_CANVAS_PIXELS);
  assert.ok(tb.width > 2600);
  tall.surface.destroy();
});

test('pen stroke → one add op in logical units; undo / redo', () => {
  const env = setup();
  const { surface, calls } = env;
  const down = pointer(env, 'pointerdown', 100, 100, { pressure: 0.6, id: 7 });
  assert.equal(down.defaultPrevented, true);
  assert.ok(env.pageEl.hasPointerCapture(7));
  pointer(env, 'pointermove', 110, 105, { pressure: 0.7, id: 7 });
  pointer(env, 'pointermove', 120, 110, { pressure: 0, id: 7 }); // 0 during contact → previous pressure
  env.dom.flush();
  const live = canvasOf(env, 'ink-live');
  assert.ok(live.ctx.calls.some((c) => c[0] === 'fill' || c[0] === 'stroke'), 'live stroke drawn');
  pointer(env, 'pointerup', 120, 110, { pressure: 0, id: 7 });
  assert.equal(env.pageEl.hasPointerCapture(7), false);

  assert.equal(calls.commits.length, 1);
  const { doc, op } = calls.commits[0];
  assert.equal(op.type, 'add');
  assert.equal(op.strokes.length, 1);
  const s = op.strokes[0];
  assert.equal(s.tool, 'pen');
  assert.equal(s.color, '#1f2937');
  assert.equal(s.size, 3.5);
  assert.deepEqual(s.pts, [100, 100, 0.6, 110, 105, 0.7, 120, 110, 0.7]);
  assert.equal(surface.getDoc(), doc);
  assert.equal(strokeCount(env), 1);
  assert.equal(surface.canUndo(), true);
  assert.equal(surface.canRedo(), false);

  assert.equal(surface.undo(), true);
  assert.equal(lastOp(env).type, 'remove');
  assert.equal(strokeCount(env), 0);
  assert.equal(surface.canRedo(), true);
  assert.equal(surface.redo(), true);
  assert.equal(lastOp(env).type, 'add');
  assert.equal(strokeCount(env), 1);
  assert.equal(calls.commits.length, 3);
  assert.equal(surface.redo(), false);
  surface.destroy();
});

test('a single tap makes a dot; jitter below 0.3 lu is ignored', () => {
  const env = setup();
  pointer(env, 'pointerdown', 50, 50);
  pointer(env, 'pointermove', 50.1, 50.1);
  pointer(env, 'pointerup', 50.2, 50);
  assert.equal(env.calls.commits.length, 1);
  assert.deepEqual(lastOp(env).strokes[0].pts, [50, 50, 0.5]);
  env.surface.destroy();
});

test('coalesced samples are used; predicted samples are drawn but never stored', () => {
  const env = setup();
  pointer(env, 'pointerdown', 10, 10);
  pointer(env, 'pointermove', 40, 10, { coalesced: [[20, 10, 0.4], [30, 10, 0.5], [40, 10, 0.6]], predicted: [[50, 10], [60, 10]] });
  env.dom.flush();
  pointer(env, 'pointerup', 40, 10, { pressure: 0 });
  const pts = lastOp(env).strokes[0].pts;
  assert.deepEqual(pts, [10, 10, 0.5, 20, 10, 0.4, 30, 10, 0.5, 40, 10, 0.6]);
  env.surface.destroy();
});

test('fingers never ink unless allowFinger; mouse main button inks; pen wins over a finger', () => {
  const env = setup();
  gesture(env, line(10, 10, 100, 10), { pointerType: 'touch' });
  assert.equal(env.calls.commits.length, 0);
  gesture(env, line(10, 10, 100, 10), { pointerType: 'mouse', button: 2 });
  assert.equal(env.calls.commits.length, 0);
  gesture(env, line(10, 10, 100, 10), { pointerType: 'mouse' });
  assert.equal(env.calls.commits.length, 1);
  env.surface.setAllowFinger(true);
  gesture(env, line(10, 30, 100, 30), { pointerType: 'touch', id: 3 });
  assert.equal(env.calls.commits.length, 2);

  // A finger (palm) goes down, then the Pencil: the finger gesture is discarded.
  pointer(env, 'pointerdown', 300, 300, { pointerType: 'touch', id: 4 });
  pointer(env, 'pointermove', 320, 300, { pointerType: 'touch', id: 4 });
  gesture(env, line(10, 60, 100, 60), { id: 5 });
  pointer(env, 'pointerup', 320, 300, { pointerType: 'touch', id: 4 });
  assert.equal(env.calls.commits.length, 3);
  assert.equal(lastOp(env).strokes[0].pts[1], 60);
  env.surface.destroy();
});

test('touch layer: preventDefault for the Pencil always, for fingers only when they draw', () => {
  const env = setup();
  const stylus = env.pageEl.dispatch('touchstart', evt({ changedTouches: [{ touchType: 'stylus' }], touches: [{}] }));
  assert.equal(stylus.defaultPrevented, true);
  const stylusEnd = env.pageEl.dispatch('touchend', evt({ changedTouches: [{ touchType: 'stylus' }], touches: [] }));
  assert.equal(stylusEnd.defaultPrevented, true);
  const finger = env.pageEl.dispatch('touchstart', evt({ changedTouches: [{ touchType: 'direct', target: env.pageEl }], touches: [{}] }));
  assert.equal(finger.defaultPrevented, false, 'fingers keep native scrolling');
  const notCancelable = env.pageEl.dispatch('touchmove', evt({ cancelable: false, changedTouches: [{ touchType: 'stylus' }] }));
  assert.equal(notCancelable.defaultPrevented, false);
  env.pageEl.dispatch('touchend', evt({ changedTouches: [{ touchType: 'direct' }], touches: [] }));

  env.surface.setAllowFinger(true);
  // pointerdown first (WebKit order), then touchstart
  pointer(env, 'pointerdown', 10, 10, { pointerType: 'touch', id: 9 });
  const t1 = env.pageEl.dispatch('touchstart', evt({ changedTouches: [{ touchType: 'direct', target: env.pageEl }], touches: [{}] }));
  const t2 = env.pageEl.dispatch('touchmove', evt({ changedTouches: [{ touchType: 'direct' }], touches: [{}] }));
  pointer(env, 'pointerup', 10, 10, { pointerType: 'touch', id: 9 });
  const t3 = env.pageEl.dispatch('touchend', evt({ changedTouches: [{ touchType: 'direct' }], touches: [] }));
  assert.deepEqual([t1.defaultPrevented, t2.defaultPrevented, t3.defaultPrevented], [true, true, true]);

  // touchstart first: a finger on an event box with a non-ink tool is a tap → not prevented.
  const box = env.dom.createElement('div');
  box.className = 'event';
  env.pageEl.appendChild(box);
  env.surface.setTool({ tool: 'lasso' });
  const onBox = env.pageEl.dispatch('touchstart', evt({ changedTouches: [{ touchType: 'direct', target: box }], touches: [{}] }));
  assert.equal(onBox.defaultPrevented, false);
  env.pageEl.dispatch('touchend', evt({ changedTouches: [{ touchType: 'direct' }], touches: [] }));
  const onPage = env.pageEl.dispatch('touchstart', evt({ changedTouches: [{ touchType: 'direct', target: env.pageEl }], touches: [{}] }));
  assert.equal(onPage.defaultPrevented, true);
  env.surface.destroy();
});

test('pen pointercancel keeps the partial stroke; finger pointercancel discards; no double finish', () => {
  const env = setup();
  pointer(env, 'pointerdown', 10, 10);
  pointer(env, 'pointermove', 50, 10);
  pointer(env, 'pointercancel', 50, 10);
  assert.equal(env.calls.commits.length, 1);
  pointer(env, 'lostpointercapture', 50, 10);
  assert.equal(env.calls.commits.length, 1);

  env.surface.setAllowFinger(true);
  pointer(env, 'pointerdown', 10, 30, { pointerType: 'touch', id: 2 });
  pointer(env, 'pointermove', 50, 30, { pointerType: 'touch', id: 2 });
  pointer(env, 'pointercancel', 50, 30, { pointerType: 'touch', id: 2 });
  assert.equal(env.calls.commits.length, 1);

  gesture(env, line(10, 60, 80, 60));
  pointer(env, 'lostpointercapture', 80, 60);
  assert.equal(env.calls.commits.length, 2);

  // lostpointercapture alone also ends a gesture.
  pointer(env, 'pointerdown', 10, 90);
  pointer(env, 'pointermove', 60, 90);
  pointer(env, 'lostpointercapture', 60, 90);
  assert.equal(env.calls.commits.length, 3);
  env.surface.destroy();
});

test('mouse released outside the page (buttons 0 on move) ends the gesture', () => {
  const env = setup();
  pointer(env, 'pointerdown', 10, 10, { pointerType: 'mouse' });
  pointer(env, 'pointermove', 40, 10, { pointerType: 'mouse' });
  pointer(env, 'pointermove', 60, 10, { pointerType: 'mouse', buttons: 0 });
  assert.equal(env.calls.commits.length, 1);
  env.surface.destroy();
});

test('pen hover moves (other pointerId, buttons 0) are ignored', () => {
  const env = setup();
  pointer(env, 'pointermove', 10, 10, { id: 1, buttons: 0, pressure: 0 });
  env.dom.flush();
  assert.equal(env.calls.commits.length, 0);
  pointer(env, 'pointerdown', 10, 10, { id: 2 });
  pointer(env, 'pointermove', 30, 10, { id: 1, buttons: 0, pressure: 0 }); // hover id
  pointer(env, 'pointermove', 20, 10, { id: 2 });
  pointer(env, 'pointerup', 20, 10, { id: 2 });
  assert.deepEqual(lastOp(env).strokes[0].pts.filter((_, i) => i % 3 === 0), [10, 20]);
  env.surface.destroy();
});

test('setTool: colors and sizes per tool; highlighter strokes', () => {
  const env = setup();
  env.surface.setTool({ tool: 'highlighter', color: '#86EFAC' });
  gesture(env, line(10, 10, 200, 10));
  let s = lastOp(env).strokes[0];
  assert.equal(s.tool, 'highlighter');
  assert.equal(s.color, '#86efac');
  assert.equal(s.size, 18);
  env.surface.setTool({ tool: 'pen', color: '#dc2626', size: 'thick' });
  gesture(env, line(10, 40, 200, 40));
  s = lastOp(env).strokes[0];
  assert.deepEqual([s.tool, s.color, s.size], ['pen', '#dc2626', 6]);
  env.surface.setTool({ size: 2 }); // partial update of the current tool
  env.surface.setTool({ tool: 'bogus', color: 'red' }); // ignored
  gesture(env, line(10, 70, 200, 70));
  s = lastOp(env).strokes[0];
  assert.deepEqual([s.tool, s.color, s.size], ['pen', '#dc2626', 2]);
  env.surface.destroy();
});

test('eraser removes every touched stroke as ONE op per gesture; undo restores them', () => {
  const env = setup();
  gesture(env, line(20, 100, 200, 100));
  gesture(env, line(20, 130, 200, 130));
  gesture(env, line(20, 500, 200, 500));
  assert.equal(strokeCount(env), 3);
  env.surface.setTool({ tool: 'eraser' });
  pointer(env, 'pointerdown', 50, 80);
  pointer(env, 'pointermove', 50, 150); // one fast move across both strokes
  env.dom.flush();
  const live = canvasOf(env, 'ink-live');
  assert.ok(live.ctx.calls.some((c) => c[0] === 'arc' && c[3] === ERASER_RADIUS), 'eraser cursor drawn');
  pointer(env, 'pointermove', 60, 160);
  pointer(env, 'pointerup', 60, 160);
  assert.equal(env.calls.commits.length, 4);
  const op = lastOp(env);
  assert.equal(op.type, 'remove');
  assert.equal(op.strokes.length, 2);
  assert.equal(strokeCount(env), 1);
  // An eraser gesture that touches nothing commits nothing.
  gesture(env, line(900, 900, 950, 950));
  assert.equal(env.calls.commits.length, 4);
  env.surface.undo();
  assert.equal(strokeCount(env), 3);
  env.surface.destroy();
});

test('lasso selects, drag inside moves as one batch op, selection follows; delete; tool switch clears', () => {
  const env = setup();
  const { surface, calls } = env;
  gesture(env, line(100, 100, 150, 100));
  const a = lastOp(env).strokes[0];
  gesture(env, line(600, 600, 650, 600));
  surface.setTool({ tool: 'lasso' });
  gesture(env, [[80, 80], [170, 80], [170, 120], [80, 120], [80, 84]]);
  const sel = calls.selections[calls.selections.length - 1];
  assert.deepEqual(sel.ids, [a.id]);
  assert.ok(sel.bbox.minX <= 100 && sel.bbox.maxX >= 150);
  // screenRect: client coords of the (6 px padded) bbox.
  assert.ok(Math.abs(sel.screenRect.left - (10 + sel.bbox.minX * 0.5 - 6)) < 1e-9);
  assert.ok(Math.abs(sel.screenRect.bottom - (20 + sel.bbox.maxY * 0.5 + 6)) < 1e-9);
  assert.deepEqual(surface.getSelection().ids, [a.id]);
  const rect = env.pageEl.children[1].children.find((c) => c.tagName === 'RECT');
  assert.equal(rect.style.display, '');
  assert.ok(Number(rect.getAttribute('stroke-width')) > 0);

  const before = calls.commits.length;
  pointer(env, 'pointerdown', 120, 100);
  pointer(env, 'pointermove', 170, 125);
  pointer(env, 'pointermove', 220, 150);
  env.dom.flush();
  assert.ok(canvasOf(env, 'ink-live').ctx.calls.some((c) => c[0] === 'translate'), 'move preview on live canvas');
  pointer(env, 'pointerup', 220, 150);
  assert.equal(calls.commits.length, before + 1);
  const op = lastOp(env);
  assert.equal(op.type, 'batch');
  assert.equal(op.ops[0].type, 'remove');
  assert.deepEqual(op.ops[0].strokes.map((s) => s.id), [a.id]);
  assert.equal(op.ops[1].type, 'add');
  const clone = op.ops[1].strokes[0];
  assert.notEqual(clone.id, a.id);
  assert.equal(clone.pts[0], a.pts[0] + 100);
  assert.equal(clone.pts[1], a.pts[1] + 50);
  assert.deepEqual(surface.getSelection().ids, [clone.id]);
  assert.deepEqual(calls.selections[calls.selections.length - 1].ids, [clone.id]);

  // A tap inside the selection keeps it and commits nothing.
  gesture(env, [[200, 150]]);
  assert.equal(calls.commits.length, before + 1);
  assert.deepEqual(surface.getSelection().ids, [clone.id]);

  // Undo the move: the clone disappears → selection cleared.
  surface.undo();
  assert.equal(surface.getSelection(), null);
  assert.equal(calls.selections[calls.selections.length - 1], null);
  surface.redo();

  // Select again and delete.
  gesture(env, [[150, 120], [300, 120], [300, 200], [150, 200], [150, 124]]);
  assert.equal(surface.getSelection().ids.length, 1);
  assert.equal(surface.deleteSelection(), true);
  assert.equal(lastOp(env).type, 'remove');
  assert.equal(surface.getSelection(), null);
  assert.equal(strokeCount(env), 1);

  // Switching tool clears the selection.
  gesture(env, [[580, 580], [700, 580], [700, 640], [580, 640], [580, 584]]);
  assert.equal(surface.getSelection().ids.length, 1);
  surface.setTool({ tool: 'pen' });
  assert.equal(surface.getSelection(), null);
  assert.equal(calls.selections[calls.selections.length - 1], null);
  surface.destroy();
});

test('lasso: tapping outside clears the selection; a moved selection stays on the page', () => {
  const env = setup();
  gesture(env, line(20, 20, 60, 20));
  env.surface.setTool({ tool: 'lasso' });
  gesture(env, [[5, 5], [80, 5], [80, 40], [5, 40], [5, 8]]);
  assert.equal(env.surface.getSelection().ids.length, 1);
  const n = env.calls.selections.length;
  gesture(env, [[1000, 1000]]);
  assert.equal(env.surface.getSelection(), null);
  assert.equal(env.calls.selections.length, n + 1);
  assert.equal(env.calls.selections[n], null);
  assert.equal(env.calls.commits.length, 1);

  // Dragging far off the top-left edge is clamped.
  gesture(env, [[5, 5], [80, 5], [80, 40], [5, 40], [5, 8]]);
  gesture(env, [[40, 20], [-500, -500]]);
  const sel = env.surface.getSelection();
  assert.ok(sel.bbox.minX >= -0.1 && sel.bbox.minY >= -0.1, JSON.stringify(sel.bbox));
  env.surface.destroy();
});

test('予定 tool: drag previews the snapped rect and reports onEventRect; a short gesture is a tap', () => {
  const env = setup();
  const { calls } = env;
  env.surface.setTool({ tool: 'event' });
  pointer(env, 'pointerdown', 300, 400);
  env.dom.flush();
  pointer(env, 'pointermove', 302, 470);
  pointer(env, 'pointermove', 305, 520);
  env.dom.flush();
  assert.ok(calls.previews.length >= 2);
  assert.deepEqual(calls.previews[calls.previews.length - 1], { minX: 300, minY: 400, maxX: 305, maxY: 520 });
  const live = canvasOf(env, 'ink-live');
  assert.ok(live.ctx.calls.some((c) => c[0] === 'arcTo'), 'rounded preview rect drawn');
  pointer(env, 'pointerup', 305, 520);
  assert.equal(calls.previews[calls.previews.length - 1], null, 'preview cleared at the end');
  assert.equal(calls.eventRects.length, 1);
  assert.deepEqual(calls.eventRects[0], { rect: { minX: 300, minY: 400, maxX: 305, maxY: 520 }, meta: { tap: false } });
  assert.equal(env.calls.commits.length, 0, 'no ink');

  gesture(env, [[500, 600], [503, 604]]);
  assert.equal(calls.eventRects.length, 2);
  assert.equal(calls.eventRects[1].meta.tap, true);
  env.surface.destroy();
});

test('mouse on an event box: a tap for non-ink tools, ink for the pen; the following click is swallowed', () => {
  const env = setup();
  const box = env.dom.createElement('div');
  box.className = 'event';
  const label = env.dom.createElement('span');
  box.appendChild(label);
  env.pageEl.appendChild(box);
  env.surface.setTool({ tool: 'event' });
  const down = pointer(env, 'pointerdown', 100, 100, { pointerType: 'mouse', target: label });
  assert.equal(down.defaultPrevented, false);
  assert.equal(env.pageEl.hasPointerCapture(1), false);
  pointer(env, 'pointerup', 100, 100, { pointerType: 'mouse', target: label });
  assert.equal(env.calls.eventRects.length, 0);
  const click1 = env.pageEl.dispatch('click', evt({ target: label }));
  assert.equal(click1.propagationStopped, false, 'event box click goes through');

  // The Pencil on an event box in 予定 mode is reported as a tap.
  gesture(env, [[100, 100]], { target: label });
  assert.equal(env.calls.eventRects.length, 1);
  assert.equal(env.calls.eventRects[0].meta.tap, true);

  env.surface.setTool({ tool: 'pen' });
  gesture(env, line(100, 100, 140, 100), { pointerType: 'mouse', target: label });
  assert.equal(env.calls.commits.length, 1);
  const click2 = env.pageEl.dispatch('click', evt({ target: label }));
  assert.equal(click2.propagationStopped, true);
  assert.equal(click2.defaultPrevented, true);
  const click3 = env.pageEl.dispatch('click', evt({ target: label }));
  assert.equal(click3.propagationStopped, false, 'only one click is swallowed');

  // After a Pencil stroke a quick finger tap must still reach the event box.
  gesture(env, line(100, 150, 140, 150));
  const fingerClick = env.pageEl.dispatch('click', evt({ target: label, pointerType: 'touch' }));
  assert.equal(fingerClick.propagationStopped, false);
  env.surface.destroy();
});

test('mouse on a month chip / date number (data-event-id, role=button) is a tap for non-ink tools', () => {
  const env = setup();
  const chip = env.dom.createElement('div');
  chip.className = 'mc-chip';
  chip.setAttribute('data-event-id', 'ev1');
  const dateNum = env.dom.createElement('div');
  dateNum.className = 'mc-date';
  dateNum.setAttribute('role', 'button');
  env.pageEl.appendChild(chip);
  env.pageEl.appendChild(dateNum);
  env.surface.setTool({ tool: 'lasso' });
  for (const target of [chip, dateNum]) {
    const down = pointer(env, 'pointerdown', 100, 100, { pointerType: 'mouse', target });
    assert.equal(down.defaultPrevented, false);
    pointer(env, 'pointerup', 100, 100, { pointerType: 'mouse', target });
  }
  assert.equal(env.pageEl.hasPointerCapture(1), false);
  env.surface.destroy();
});

test('contextmenu and selectstart are blocked on the page', () => {
  const env = setup();
  assert.equal(env.pageEl.dispatch('contextmenu', evt()).defaultPrevented, true);
  assert.equal(env.pageEl.dispatch('selectstart', evt()).defaultPrevented, true);
  env.surface.destroy();
});

test('setDoc: resetHistory semantics, remote removals drop out of the selection, page change', () => {
  const env = setup();
  const { surface, calls } = env;
  gesture(env, line(20, 20, 60, 20));
  gesture(env, line(20, 300, 60, 300));
  const doc = surface.getDoc();
  const [a, b] = Object.values(doc.strokes).sort((x, y) => x.pts[1] - y.pts[1]);
  surface.setDoc(doc, { resetHistory: false });
  assert.equal(surface.canUndo(), true);

  surface.setTool({ tool: 'lasso' });
  gesture(env, [[0, 0], [100, 0], [100, 400], [0, 400], [0, 4]]);
  assert.equal(surface.getSelection().ids.length, 2);
  const commitsBefore = calls.commits.length;
  // Remote merge removed stroke a.
  const strokes = { ...doc.strokes };
  delete strokes[a.id];
  surface.setDoc({ ...doc, strokes, deleted: { ...doc.deleted, [a.id]: Date.now() } }, { resetHistory: false });
  assert.deepEqual(surface.getSelection().ids, [b.id]);
  assert.deepEqual(calls.selections[calls.selections.length - 1].ids, [b.id]);
  assert.equal(calls.commits.length, commitsBefore, 'setDoc is not a user change');
  assert.equal(surface.canUndo(), true);

  // resetHistory (default) clears history and selection.
  surface.setDoc(surface.getDoc());
  assert.equal(surface.canUndo(), false);
  assert.equal(surface.getSelection(), null);

  // A different page drops an in-progress stroke and the history.
  surface.setTool({ tool: 'pen' });
  gesture(env, line(20, 600, 60, 600));
  pointer(env, 'pointerdown', 20, 700);
  pointer(env, 'pointermove', 80, 700);
  const n = calls.commits.length;
  surface.setDoc({ v: 1, pageId: 'w-2026-10-04', strokes: {}, deleted: {}, updatedAt: 0 }, { resetHistory: false });
  pointer(env, 'pointerup', 80, 700);
  assert.equal(calls.commits.length, n);
  assert.equal(surface.canUndo(), false);
  assert.equal(strokeCount(env), 0);
  assert.equal(surface.getDoc().pageId, 'w-2026-10-04');

  // Garbage → an empty page for the current page id.
  surface.setDoc(null);
  assert.deepEqual(surface.getDoc().strokes, {});
  surface.destroy();
});

test('an in-progress stroke survives a remote merge of the same page', () => {
  const env = setup();
  gesture(env, line(20, 20, 60, 20));
  const doc = env.surface.getDoc();
  pointer(env, 'pointerdown', 20, 100);
  pointer(env, 'pointermove', 80, 100);
  env.surface.setDoc(doc, { resetHistory: false });
  pointer(env, 'pointermove', 120, 100);
  pointer(env, 'pointerup', 120, 100);
  assert.equal(env.calls.commits.length, 2);
  assert.equal(strokeCount(env), 2);
  env.surface.destroy();
});

test('removeStrokesById creates one undoable op and ignores unknown ids', () => {
  const env = setup();
  gesture(env, line(20, 20, 60, 20));
  gesture(env, line(20, 60, 60, 60));
  const ids = Object.keys(env.surface.getDoc().strokes);
  assert.equal(env.surface.removeStrokesById([ids[0], 'nope']), true);
  const op = lastOp(env);
  assert.equal(op.type, 'remove');
  assert.deepEqual(op.strokes.map((s) => s.id), [ids[0]]);
  assert.equal(strokeCount(env), 1);
  assert.equal(env.surface.removeStrokesById(['nope']), false);
  assert.equal(env.surface.removeStrokesById('not-an-array'), false);
  env.surface.undo();
  assert.equal(strokeCount(env), 2);
  env.surface.destroy();
});

test('snapshot renders the strokes on white into a PNG within maxW × maxH', () => {
  const env = setup();
  gesture(env, line(100, 100, 500, 140));
  const id = Object.keys(env.surface.getDoc().strokes)[0];
  const before = env.dom.created.length;
  const url = env.surface.snapshot([id]);
  assert.match(url, /^data:image\/png/);
  const [, w, h] = url.match(/FAKE(\d+)x(\d+)/);
  assert.ok(Number(w) <= 480 && Number(h) <= 240 && Number(w) > 0 && Number(h) > 0);
  const canvas = env.dom.created[before];
  assert.equal(canvas.tagName, 'CANVAS');
  assert.equal(canvas.parentNode, null, 'offscreen');
  const fill = canvas.ctx.calls.find((c) => c[0] === 'fillRect');
  assert.deepEqual(fill.slice(1, 3), [0, 0]);
  const small = env.surface.snapshot([id], 100, 50);
  const [, w2, h2] = small.match(/FAKE(\d+)x(\d+)/);
  assert.ok(Number(w2) <= 100 && Number(h2) <= 50);
  assert.equal(env.surface.snapshot(['missing']), null);
  assert.equal(env.surface.snapshot([]), null);
  env.surface.destroy();
});

test('resize re-measures the scale and resizes the canvases', () => {
  const env = setup();
  const base = canvasOf(env, 'ink-base');
  env.info.scale = 0.75;
  env.pageEl.rect.width = 1400 * 0.75;
  env.pageEl.rect.height = 1920 * 0.75;
  env.surface.resize();
  assert.equal(base.width, 2100);
  assert.equal(base.height, 2880);
  // The context maps logical units onto the backing store: dpr 2 × scale 0.75.
  assert.ok(base.ctx.calls.some((c) => c[0] === 'setTransform' && c[1] === 1.5 && c[4] === 1.5));
  // Ink still maps through the new scale.
  gesture(env, line(100, 100, 200, 100));
  assert.deepEqual(lastOp(env).strokes[0].pts.slice(0, 2), [100, 100]);
  env.surface.destroy();
});

test('selection screen rect is re-sent when the viewport scrolls', () => {
  const env = setup();
  gesture(env, line(20, 20, 60, 20));
  env.surface.setTool({ tool: 'lasso' });
  gesture(env, [[5, 5], [80, 5], [80, 40], [5, 40], [5, 8]]);
  const n = env.calls.selections.length;
  env.pageEl.rect.top = -100;
  env.viewportEl.dispatch('scroll', evt());
  env.dom.flush();
  assert.equal(env.calls.selections.length, n + 1);
  assert.ok(env.calls.selections[n].screenRect.top < 0);
  env.surface.destroy();
});

test('destroy removes layers and listeners; the document gesture blocker goes with the last surface', () => {
  const env = setup();
  const second = new InkSurface({
    pageEl: env.dom.createElement('div'),
    getPageInfo: () => ({ pageId: 'm-2026-10', W: 1400, H: 1050, scale: 0.5 }),
  });
  assert.equal(env.dom.listenerCount('gesturestart'), 1);
  gesture(env, line(20, 20, 60, 20));
  env.surface.setTool({ tool: 'lasso' });
  gesture(env, [[5, 5], [80, 5], [80, 40], [5, 40], [5, 8]]);
  const n = env.calls.selections.length;
  env.surface.destroy();
  assert.equal(env.calls.selections.length, n + 1);
  assert.equal(env.calls.selections[n], null);
  assert.deepEqual(env.pageEl.children, []);
  assert.equal(env.pageEl.listeners.length, 0);
  assert.equal(env.viewportEl.listeners.length, 0);
  assert.equal(env.dom.listenerCount('gesturestart'), 1, 'still used by the second surface');
  assert.equal(env.dom.frames.size, 0, 'no pending frame');
  assert.equal(env.surface.undo(), false);
  assert.equal(env.surface.canUndo(), false);
  env.surface.destroy(); // idempotent
  second.destroy();
  assert.equal(env.dom.listenerCount('gesturestart'), 0);
  assert.equal(env.dom.listenerCount('gestureend'), 0);
});

test('constructor validates its inputs', () => {
  assert.throws(() => new InkSurface({}), TypeError);
  const dom = new FakeDocument();
  assert.throws(() => new InkSurface({ pageEl: dom.createElement('div') }), TypeError);
  // A throwing getPageInfo does not break construction (it is only logged).
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const s = new InkSurface({ pageEl: dom.createElement('div'), getPageInfo: () => { throw new Error('x'); } });
    assert.equal(s.getDoc().pageId, '');
    s.destroy();
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(warnings.length > 0);
});

// ---------------------------------------------------------------------------------------------
// Live rendering, partial redraws, finger scrolling, undo after remote merges
// ---------------------------------------------------------------------------------------------

/** Flat [x, y, ...] vertices of the last filled path recorded on a fake context. */
function lastFilledPath(calls) {
  let end = calls.length - 1;
  while (end >= 0 && calls[end][0] !== 'fill') end--;
  let start = end;
  while (start >= 0 && calls[start][0] !== 'beginPath') start--;
  const out = [];
  for (let i = start + 1; i < end; i++) if (calls[i][0] === 'moveTo' || calls[i][0] === 'lineTo') out.push(calls[i][1], calls[i][2]);
  return out;
}

const callsSince = (ctx, n) => ctx.calls.slice(n);

test('live pen preview is drawn with the committed outline, so the ink does not change on pen-up', (t) => {
  if (usedFakes.has('render.js') || !realRender) return t.skip('needs the real render module');
  const env = setup();
  const live = canvasOf(env, 'ink-live');
  pointer(env, 'pointerdown', 100, 100, { pressure: 0.6 });
  pointer(env, 'pointermove', 110, 105, { pressure: 1 });   // pressure spike
  pointer(env, 'pointermove', 120, 100, { pressure: 0.2 });
  pointer(env, 'pointermove', 130, 112, { pressure: 0.7 });
  pointer(env, 'pointermove', 118, 124, { pressure: 0.7 }); // sharp turn
  env.dom.flush();
  const livePath = lastFilledPath(live.ctx.calls);
  pointer(env, 'pointerup', 118, 124, { pressure: 0 });
  const stroke = lastOp(env).strokes[0];
  assert.deepEqual(stroke.pts, [100, 100, 0.6, 110, 105, 1, 120, 100, 0.2, 130, 112, 0.7, 118, 124, 0.7]);
  const committed = realRender.strokeOutline(stroke);
  assert.ok(committed.length > 20);
  assert.equal(livePath.length, committed.length);
  for (let i = 0; i < committed.length; i++) assert.ok(Math.abs(livePath[i] - committed[i]) < 1e-9, `vertex ${i >> 1}`);
  env.surface.destroy();
});

test('live ink: later frames clear only the previous stroke area; predicted samples extend the preview', () => {
  const env = setup();
  const live = canvasOf(env, 'ink-live');
  pointer(env, 'pointerdown', 100, 100);
  pointer(env, 'pointermove', 120, 100);
  env.dom.flush();
  const first = live.ctx.calls.filter((c) => c[0] === 'clearRect');
  assert.deepEqual(first[first.length - 1].slice(1), [0, 0, live.width, live.height], 'first frame clears the canvas');
  const mark = live.ctx.calls.length;
  pointer(env, 'pointermove', 140, 100, { predicted: [[150, 100], [160, 100]] });
  env.dom.flush();
  const frame = callsSince(live.ctx, mark);
  const clears = frame.filter((c) => c[0] === 'clearRect');
  assert.equal(clears.length, 1);
  const [, x, y, w, h] = clears[0];
  // Previous frame: x 100..120 lu ± (max radius + 1) at 1 device px per lu.
  assert.ok(x <= 100 - 3 && x >= 100 - 6 && x + w >= 120 + 3 && w < 40, JSON.stringify(clears[0]));
  assert.ok(y <= 97 && y + h >= 103 && h < 20);
  if (!usedFakes.has('render.js')) {
    const xs = lastFilledPath(frame).filter((_, i) => i % 2 === 0);
    assert.ok(Math.max(...xs) > 160, 'the predicted samples are part of the preview');
  }
  pointer(env, 'pointerup', 140, 100);
  assert.deepEqual(lastOp(env).strokes[0].pts.filter((_, i) => i % 3 === 0), [100, 120, 140], 'predictions never stored');
  env.surface.destroy();
});

test('a pen-down that reports pressure 0 takes the first real pressure instead of the 0.5 fallback', () => {
  const env = setup();
  pointer(env, 'pointerdown', 10, 10, { pressure: 0 });
  pointer(env, 'pointermove', 20, 10, { coalesced: [[20, 10, 0], [30, 10, 0.3]] });
  pointer(env, 'pointermove', 40, 10, { pressure: 0.6 });
  pointer(env, 'pointerup', 40, 10, { pressure: 0 });
  assert.deepEqual(lastOp(env).strokes[0].pts, [10, 10, 0.3, 20, 10, 0.3, 30, 10, 0.3, 40, 10, 0.6]);
  // A real pen-down pressure is kept.
  pointer(env, 'pointerdown', 10, 50, { pressure: 0.8 });
  pointer(env, 'pointermove', 20, 50, { pressure: 0.3 });
  pointer(env, 'pointerup', 20, 50, { pressure: 0 });
  assert.deepEqual(lastOp(env).strokes[0].pts, [10, 50, 0.8, 20, 50, 0.3]);
  env.surface.destroy();
});

test('highlighter and moved highlights preview with multiply blending on the live canvas; pens do not', () => {
  const env = setup();
  const { surface } = env;
  const live = canvasOf(env, 'ink-live');
  surface.setTool({ tool: 'highlighter' });
  pointer(env, 'pointerdown', 20, 20);
  assert.equal(live.style.mixBlendMode, 'multiply');
  pointer(env, 'pointermove', 120, 20);
  env.dom.flush();
  pointer(env, 'pointerup', 120, 20);
  assert.equal(live.style.mixBlendMode, '');
  assert.equal(lastOp(env).strokes[0].tool, 'highlighter');

  // A cancelled highlighter gesture resets the blend too.
  pointer(env, 'pointerdown', 20, 300, { pointerType: 'mouse' });
  assert.equal(live.style.mixBlendMode, 'multiply');
  pointer(env, 'pointermove', 60, 300, { pointerType: 'mouse' });
  surface.setDoc({ v: 1, pageId: 'w-2026-10-04', strokes: {}, deleted: {}, updatedAt: 0 }, { resetHistory: false });
  assert.equal(live.style.mixBlendMode, '');
  pointer(env, 'pointerup', 60, 300, { pointerType: 'mouse' });
  surface.setDoc({ v: 1, pageId: 'w-2026-09-27', strokes: {}, deleted: {}, updatedAt: 0 });

  surface.setTool({ tool: 'pen' });
  pointer(env, 'pointerdown', 20, 60);
  assert.equal(live.style.mixBlendMode || '', '');
  pointer(env, 'pointerup', 40, 60);

  // Moving a selection with a highlighter in it.
  surface.setTool({ tool: 'highlighter' });
  gesture(env, line(20, 100, 120, 100));
  surface.setTool({ tool: 'lasso' });
  gesture(env, [[0, 80], [140, 80], [140, 120], [0, 120], [0, 84]]);
  assert.equal(surface.getSelection().ids.length, 1);
  pointer(env, 'pointerdown', 60, 100);
  assert.equal(live.style.mixBlendMode || '', '', 'not before the move starts');
  pointer(env, 'pointermove', 90, 130);
  assert.equal(live.style.mixBlendMode, 'multiply');
  pointer(env, 'pointerup', 90, 130);
  assert.equal(live.style.mixBlendMode, '');
  surface.destroy();
});

test('eraser frames redraw only the erased area of the base canvas; the gesture end redraws all', () => {
  const env = setup();
  const base = canvasOf(env, 'ink-base');
  gesture(env, line(20, 100, 200, 100)); // A: erased
  gesture(env, line(20, 104, 200, 104)); // B: overlaps A's area, not touched by the eraser
  gesture(env, line(20, 800, 200, 800)); // C: far away
  env.surface.setTool({ tool: 'eraser' });
  const paths = (calls) => calls.filter((c) => c[0] === (usedFakes.has('render.js') ? 'fill' : 'moveTo')).length;
  let mark = base.ctx.calls.length;
  pointer(env, 'pointerdown', 100, 90); // reaches A only (10 + 1.75 lu)
  env.dom.flush();
  let frame = callsSince(base.ctx, mark);
  const clear = frame.find((c) => c[0] === 'clearRect');
  assert.ok(clear, 'base touched');
  const [, , y, w, h] = clear;
  assert.ok(h < 20 && y >= 90 && y + h <= 110, `partial clear ${JSON.stringify(clear)}`);
  assert.ok(w < base.width / 2);
  assert.ok(frame.some((c) => c[0] === 'clip'));
  assert.equal(paths(frame), 1, 'only B is redrawn (clipped)');

  // A frame that hits nothing new leaves the base canvas alone.
  mark = base.ctx.calls.length;
  pointer(env, 'pointermove', 100, 40);
  env.dom.flush();
  assert.equal(callsSince(base.ctx, mark).filter((c) => c[0] === 'clearRect').length, 0);

  mark = base.ctx.calls.length;
  pointer(env, 'pointerup', 100, 40);
  frame = callsSince(base.ctx, mark);
  assert.deepEqual(frame.find((c) => c[0] === 'clearRect').slice(1), [0, 0, base.width, base.height]);
  assert.equal(paths(frame), 2, 'full redraw of B and C at the end');
  assert.equal(lastOp(env).strokes.length, 1);
  assert.equal(strokeCount(env), 2);
  env.surface.destroy();
});

test('a huge lasso on a dense page selects exactly the strokes inside it', () => {
  const env = setup();
  const cx = 700; const cy = 960; const R = 600;
  const strokes = {};
  const inside = new Set();
  let k = 0;
  for (let gy = 20; gy < 1900; gy += 30) {
    for (let gx = 20; gx < 1380; gx += 45) {
      const pts = [];
      for (let i = 0; i < 30; i++) pts.push(gx + i, gy + (i % 3), 0.5);
      const d0 = Math.hypot(gx - cx, gy - cy);
      const d1 = Math.hypot(gx + 29 - cx, gy + 2 - cy);
      if (Math.abs(d0 - R) < 6 || Math.abs(d1 - R) < 6 || (d0 < R) !== (d1 < R)) continue; // keep clear of the lasso line
      const id = `s${k++}`;
      strokes[id] = { id, tool: 'pen', color: '#1f2937', size: 3.5, pts, t: k };
      if (d0 < R) inside.add(id);
    }
  }
  env.surface.setDoc({ v: 1, pageId: 'w-2026-09-27', strokes, deleted: {}, updatedAt: 1 });
  env.surface.setTool({ tool: 'lasso' });
  const steps = Math.ceil((2 * Math.PI * R) / 2.1);
  const lasso = [];
  for (let i = 0; i <= steps; i++) lasso.push([cx + R * Math.cos((2 * Math.PI * i) / steps), cy + R * Math.sin((2 * Math.PI * i) / steps)]);
  pointer(env, 'pointerdown', lasso[0][0], lasso[0][1]);
  for (const [x, y] of lasso.slice(1)) pointer(env, 'pointermove', x, y);
  pointer(env, 'pointerup', lasso[lasso.length - 1][0], lasso[lasso.length - 1][1]);
  const sel = env.surface.getSelection();
  assert.ok(inside.size > 100);
  assert.deepEqual(new Set(sel.ids), inside);
  env.surface.destroy();
});

test('moving a selection starts after a few screen px, not a few lu (month page at scale 0.6)', () => {
  const env = setup({ W: 1400, H: 1050, scale: 0.6, pageId: 'm-2026-10' });
  const { surface, calls } = env;
  gesture(env, line(100, 100, 150, 100));
  surface.setTool({ tool: 'lasso' });
  gesture(env, [[80, 80], [170, 80], [170, 120], [80, 120], [80, 84]]);
  const ids = surface.getSelection().ids;
  const n = calls.commits.length;
  gesture(env, [[120, 100], [123, 104]]); // a tap that drifts 5 lu = 3 px
  assert.equal(calls.commits.length, n, 'a tap does not move the ink');
  assert.deepEqual(surface.getSelection().ids, ids);
  gesture(env, [[120, 100], [132, 100]]); // 12 lu = 7.2 px: a deliberate drag
  assert.equal(calls.commits.length, n + 1);
  assert.equal(lastOp(env).type, 'batch');
  surface.destroy();
});

test('allowFinger: a second finger turns the touch into a two-finger scroll instead of ink', () => {
  const env = setup();
  const { pageEl, viewportEl, surface } = env;
  viewportEl.scrollTop = 300;
  viewportEl.scrollLeft = 0;
  viewportEl.scrollHeight = 2000;
  viewportEl.clientHeight = 800;
  viewportEl.scrollWidth = 700;
  viewportEl.clientWidth = 700;
  surface.setAllowFinger(true);
  const touch = (x, y, target = pageEl) => ({ touchType: 'direct', target, ...env.client(x, y) });
  const touchEvt = (type, touches, changed = touches.slice(-1)) => pageEl.dispatch(type, evt({ touches, changedTouches: changed }));

  // One finger draws (pointerdown before touchstart, as in WebKit) …
  pointer(env, 'pointerdown', 100, 100, { pointerType: 'touch', id: 1 });
  assert.equal(touchEvt('touchstart', [touch(100, 100)]).defaultPrevented, true);
  pointer(env, 'pointermove', 120, 100, { pointerType: 'touch', id: 1 });
  // … the second finger lands: the stroke is dropped and both fingers scroll.
  pointer(env, 'pointerdown', 200, 100, { pointerType: 'touch', id: 2 });
  assert.equal(touchEvt('touchstart', [touch(120, 100), touch(200, 100)]).defaultPrevented, true);
  const moved = touchEvt('touchmove', [touch(120, 60), touch(200, 60)]); // 40 lu = 20 px up
  assert.equal(moved.defaultPrevented, true);
  assert.equal(viewportEl.scrollTop, 320);
  touchEvt('touchmove', [touch(120, 0), touch(200, 0)]);
  assert.equal(viewportEl.scrollTop, 350);
  pointer(env, 'pointermove', 120, 0, { pointerType: 'touch', id: 1 });
  // One finger lifts: the other keeps scrolling without a jump.
  pointer(env, 'pointerup', 200, 0, { pointerType: 'touch', id: 2 });
  touchEvt('touchend', [touch(120, 0)], [touch(200, 0)]);
  touchEvt('touchmove', [touch(120, -40)]);
  assert.equal(viewportEl.scrollTop, 370);
  // Scrolling stops at the end of the content and comes back at once.
  touchEvt('touchmove', [touch(120, -4000)]);
  assert.equal(viewportEl.scrollTop, 1200);
  touchEvt('touchmove', [touch(120, -3960)]);
  assert.equal(viewportEl.scrollTop, 1180);
  pointer(env, 'pointerup', 120, -3960, { pointerType: 'touch', id: 1 });
  touchEvt('touchend', [], [touch(120, -3960)]);
  assert.equal(env.calls.commits.length, 0, 'no ink from the scrolling fingers');

  // touchstart before pointerdown: the second finger's pointerdown does not start ink either.
  assert.equal(touchEvt('touchstart', [touch(300, 300)]).defaultPrevented, true);
  pointer(env, 'pointerdown', 300, 300, { pointerType: 'touch', id: 3 });
  touchEvt('touchstart', [touch(300, 300), touch(400, 300)]);
  const down4 = pointer(env, 'pointerdown', 400, 300, { pointerType: 'touch', id: 4 });
  assert.equal(down4.defaultPrevented, false);
  pointer(env, 'pointermove', 420, 300, { pointerType: 'touch', id: 4 });
  pointer(env, 'pointerup', 420, 300, { pointerType: 'touch', id: 4 });
  pointer(env, 'pointerup', 300, 300, { pointerType: 'touch', id: 3 });
  touchEvt('touchend', [], [touch(300, 300), touch(400, 300)]);
  assert.equal(env.calls.commits.length, 0);

  // A thumb resting outside the page (toolbar) does not count: one finger on the page still draws.
  const toolbar = env.dom.createElement('div');
  pointer(env, 'pointerdown', 100, 500, { pointerType: 'touch', id: 5 });
  assert.equal(touchEvt('touchstart', [touch(0, 0, toolbar), touch(100, 500)]).defaultPrevented, true);
  pointer(env, 'pointermove', 160, 500, { pointerType: 'touch', id: 5 });
  pointer(env, 'pointerup', 160, 500, { pointerType: 'touch', id: 5 });
  touchEvt('touchend', [touch(0, 0, toolbar)], [touch(160, 500)]);
  assert.equal(env.calls.commits.length, 1);

  // Without allowFinger nothing changes: fingers are never claimed.
  touchEvt('touchend', [], [touch(0, 0, toolbar)]);
  surface.setAllowFinger(false);
  assert.equal(touchEvt('touchstart', [touch(100, 100)]).defaultPrevented, false);
  assert.equal(touchEvt('touchstart', [touch(100, 100), touch(200, 100)]).defaultPrevented, false);
  surface.destroy();
});

test('undo skips steps whose strokes another device already erased; redo cannot bring them back', () => {
  const env = setup();
  const { surface, calls } = env;
  gesture(env, line(20, 20, 60, 20)); // T
  gesture(env, line(20, 60, 60, 60)); // S
  const s = lastOp(env).strokes[0];
  const remoteErase = (id) => {
    const doc = surface.getDoc();
    const strokes = { ...doc.strokes };
    delete strokes[id];
    surface.setDoc({ ...doc, strokes, deleted: { ...doc.deleted, [id]: Date.now() } }, { resetHistory: false });
  };
  remoteErase(s.id);
  assert.equal(strokeCount(env), 1);
  let n = calls.commits.length;
  assert.equal(surface.undo(), true, 'one press undoes T (the step for S changes nothing)');
  assert.equal(strokeCount(env), 0);
  assert.equal(calls.commits.length, n + 1);
  assert.equal(surface.canUndo(), false);
  assert.equal(surface.redo(), true);
  assert.equal(strokeCount(env), 1);
  assert.equal(surface.redo(), false, 'S never comes back');
  assert.equal(strokeCount(env), 1);

  // Only a no-op step left: undo reports false and commits nothing.
  const t2 = lastOp(env).strokes[0];
  remoteErase(t2.id);
  n = calls.commits.length;
  assert.equal(surface.undo(), false);
  assert.equal(calls.commits.length, n);
  assert.equal(surface.canUndo(), false);

  // Redo direction: erase X, undo (X' comes back), X' erased elsewhere → redo is dropped.
  gesture(env, line(20, 200, 60, 200));
  surface.setTool({ tool: 'eraser' });
  gesture(env, line(40, 190, 40, 210));
  surface.undo();
  const restored = lastOp(env).strokes[0];
  assert.equal(lastOp(env).type, 'add');
  remoteErase(restored.id);
  n = calls.commits.length;
  assert.equal(surface.redo(), false);
  assert.equal(calls.commits.length, n);
  assert.equal(surface.canRedo(), false);
  assert.equal(surface.canUndo(), true, 'the drawing of X is still undoable');
  surface.destroy();
});

test('commitActiveGesture keeps a stroke in progress (page hidden / unloaded) and drops non-ink gestures', () => {
  const env = setup();
  env.surface.commitActiveGesture(); // nothing in progress: no-op
  assert.equal(env.calls.commits.length, 0);

  pointer(env, 'pointerdown', 10, 10);
  pointer(env, 'pointermove', 60, 10);
  env.surface.commitActiveGesture();
  assert.equal(env.calls.commits.length, 1, 'the partial stroke is committed');
  assert.equal(lastOp(env).type, 'add');
  pointer(env, 'pointerup', 60, 10); // the late release must not finish twice
  pointer(env, 'lostpointercapture', 60, 10);
  assert.equal(env.calls.commits.length, 1);
  assert.equal(strokeCount(env), 1);

  // 予定 tool: no dialog may open on a page that is going away.
  env.surface.setTool({ tool: 'event' });
  pointer(env, 'pointerdown', 300, 400);
  pointer(env, 'pointermove', 305, 520);
  env.surface.commitActiveGesture();
  assert.equal(env.calls.eventRects.length, 0);
  assert.equal(env.calls.previews[env.calls.previews.length - 1], null, 'preview cleared');

  env.surface.destroy();
  env.surface.commitActiveGesture(); // after destroy: no-op, no throw
});
