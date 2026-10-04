import test from 'node:test';
import assert from 'node:assert/strict';
import {
  strokeBBox,
  unionBBox,
  bboxIntersects,
  pointInPolygon,
  strokeInLasso,
  strokeHitsCircle,
  segmentDistance,
  translateRect,
} from '../js/ink/geometry.js';
import { strokeOutline } from '../js/ink/render.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const pen = (pts, size = 4) => ({ id: 'p', tool: 'pen', color: '#000000', size, pts, t: 1 });
const hl = (pts, size = 18) => ({ id: 'h', tool: 'highlighter', color: '#fde047', size, pts, t: 1 });

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

test('strokeBBox includes half of the max rendered width', () => {
  // pen width = size * (0.4 + 0.9 p): max at p = 1 → 4 * 1.3 = 5.2 → half 2.6
  const b = strokeBBox(pen([10, 20, 0.2, 30, 5, 1, 15, 40, 0.5]));
  close(b.minX, 10 - 2.6);
  close(b.maxX, 30 + 2.6);
  close(b.minY, 5 - 2.6);
  close(b.maxY, 40 + 2.6);
  const h = strokeBBox(hl([0, 0, 0.1, 100, 0, 0.1]));
  assert.deepEqual(h, { minX: -9, minY: -9, maxX: 109, maxY: 9 });
  const dot = strokeBBox(pen([5, 5, 0.5], 2));
  close(dot.maxX - dot.minX, 2 * 0.85);
});

test('strokeBBox ignores invalid points; null when nothing is valid', () => {
  assert.equal(strokeBBox(pen([])), null);
  assert.equal(strokeBBox(pen([NaN, 1, 0.5])), null);
  assert.equal(strokeBBox(null), null);
  assert.equal(strokeBBox({ pts: 'x' }), null);
  const b = strokeBBox(pen([NaN, 0, 1, 1, 1, 0, 3, 3, 0]));
  close(b.minX, 1 - 0.8);
  close(b.maxX, 3 + 0.8);
});

test('strokeBBox contains the rendered outline', () => {
  const r = rng(5);
  for (let i = 0; i < 200; i++) {
    const pts = [];
    let x = 100;
    let y = 100;
    const n = 1 + Math.floor(r() * 60);
    for (let k = 0; k < n; k++) {
      x += (r() - 0.5) * 12;
      y += (r() - 0.5) * 12;
      pts.push(x, y, r());
    }
    const s = r() < 0.2 ? hl(pts) : pen(pts, [2, 3.5, 6][i % 3]);
    const b = strokeBBox(s);
    const poly = strokeOutline(s);
    for (let k = 0; k < poly.length; k += 2) {
      assert.ok(poly[k] >= b.minX - 1e-6 && poly[k] <= b.maxX + 1e-6, 'x inside bbox');
      assert.ok(poly[k + 1] >= b.minY - 1e-6 && poly[k + 1] <= b.maxY + 1e-6, 'y inside bbox');
    }
  }
});

test('unionBBox', () => {
  assert.equal(unionBBox([]), null);
  assert.equal(unionBBox(null), null);
  assert.equal(unionBBox([null, { minX: NaN, minY: 0, maxX: 1, maxY: 1 }]), null);
  const a = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
  const u = unionBBox([a, null, { minX: -5, minY: 3, maxX: 4, maxY: 20 }]);
  assert.deepEqual(u, { minX: -5, minY: 0, maxX: 10, maxY: 20 });
  assert.deepEqual(a, { minX: 0, minY: 0, maxX: 10, maxY: 10 }, 'inputs untouched');
  assert.notEqual(unionBBox([a]), a);
});

test('bboxIntersects (touching counts)', () => {
  const a = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
  assert.equal(bboxIntersects(a, { minX: 5, minY: 5, maxX: 15, maxY: 15 }), true);
  assert.equal(bboxIntersects(a, { minX: 10, minY: 10, maxX: 15, maxY: 15 }), true);
  assert.equal(bboxIntersects(a, { minX: 10.01, minY: 0, maxX: 15, maxY: 15 }), false);
  assert.equal(bboxIntersects(a, { minX: 2, minY: 2, maxX: 3, maxY: 3 }), true, 'containment');
  assert.equal(bboxIntersects(a, null), false);
});

test('pointInPolygon (even-odd)', () => {
  const square = [0, 0, 10, 0, 10, 10, 0, 10];
  assert.equal(pointInPolygon(5, 5, square), true);
  assert.equal(pointInPolygon(15, 5, square), false);
  assert.equal(pointInPolygon(-1, -1, square), false);
  const concave = [0, 0, 10, 0, 10, 10, 5, 3, 0, 10]; // notch from the top
  assert.equal(pointInPolygon(5, 8, concave), false);
  assert.equal(pointInPolygon(5, 1, concave), true);
  // self-intersecting star: centre is outside under even-odd
  const star = [];
  for (let i = 0; i < 5; i++) {
    const a = (i * 4 * Math.PI) / 5 - Math.PI / 2;
    star.push(Math.cos(a) * 10, Math.sin(a) * 10);
  }
  assert.equal(pointInPolygon(0, 0, star), false);
  assert.equal(pointInPolygon(0, -8, star), true);
  assert.equal(pointInPolygon(1, 1, [0, 0, 5, 5]), false, 'degenerate polygon');
  assert.equal(pointInPolygon(1, 1, null), false);
});

test('strokeInLasso: at least half of the points inside', () => {
  const lasso = [0, 0, 100, 0, 100, 100, 0, 100];
  assert.equal(strokeInLasso(pen([10, 10, 0.5, 20, 20, 0.5, 200, 200, 0.5, 300, 300, 0.5]), lasso), true); // 2 of 4
  assert.equal(strokeInLasso(pen([10, 10, 0.5, 200, 20, 0.5, 200, 200, 0.5]), lasso), false); // 1 of 3
  assert.equal(strokeInLasso(pen([50, 50, 0.5]), lasso), true);
  assert.equal(strokeInLasso(pen([150, 50, 0.5]), lasso), false);
  assert.equal(strokeInLasso(pen([]), lasso), false);
  assert.equal(strokeInLasso(pen([50, 50, 0.5]), [0, 0, 1, 1]), false, 'degenerate lasso');
  assert.equal(strokeInLasso(pen([50, 50, 0.5, NaN, 0, 0, 500, 500, 0.5]), lasso), true, 'invalid points ignored');
});

test('strokeInLasso: precomputed bounds and early exits give the same answer as counting every point', () => {
  const reference = (stroke, poly) => {
    let valid = 0;
    let inside = 0;
    for (let i = 0; i + 2 < stroke.pts.length; i += 3) {
      const x = stroke.pts[i];
      const y = stroke.pts[i + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      valid++;
      if (pointInPolygon(x, y, poly)) inside++;
    }
    return valid > 0 && inside * 2 >= valid;
  };
  const rand = rng(42);
  for (let k = 0; k < 400; k++) {
    const poly = [];
    const n = 3 + Math.floor(rand() * 12);
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      const r = 20 + rand() * 80;
      poly.push(100 + r * Math.cos(a), 100 + r * Math.sin(a));
    }
    const pts = [];
    const m = 1 + Math.floor(rand() * 20);
    for (let i = 0; i < m; i++) pts.push(rand() < 0.05 ? NaN : rand() * 220 - 10, rand() * 220 - 10, 0.5);
    const s = pen(pts);
    const want = reference(s, poly);
    assert.equal(strokeInLasso(s, poly), want, `case ${k}`);
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (let i = 0; i < poly.length; i += 2) {
      minX = Math.min(minX, poly[i]); maxX = Math.max(maxX, poly[i]);
      minY = Math.min(minY, poly[i + 1]); maxY = Math.max(maxY, poly[i + 1]);
    }
    assert.equal(strokeInLasso(s, poly, { minX, minY, maxX, maxY }), want, `case ${k} with bounds`);
  }
  // Invalid bounds are ignored (computed from the polygon instead).
  assert.equal(strokeInLasso(pen([50, 50, 0.5]), [0, 0, 100, 0, 100, 100, 0, 100], { minX: NaN }), true);
});

test('segmentDistance', () => {
  close(segmentDistance(5, 5, 0, 0, 10, 0), 5);
  close(segmentDistance(-3, 4, 0, 0, 10, 0), 5); // beyond A
  close(segmentDistance(13, 4, 0, 0, 10, 0), 5); // beyond B
  close(segmentDistance(3, 4, 0, 0, 0, 0), 5); // degenerate segment
  close(segmentDistance(1, 1, 0, 0, 2, 2), 0);
});

test('strokeHitsCircle uses r + size/2 against every segment', () => {
  const s = pen([0, 0, 0.5, 100, 0, 0.5], 4); // half size 2
  assert.equal(strokeHitsCircle(s, 50, 11.9, 10), true);
  assert.equal(strokeHitsCircle(s, 50, 12.1, 10), false);
  assert.equal(strokeHitsCircle(s, 111.9, 0, 10), true);
  const dot = pen([10, 10, 0.5], 4);
  assert.equal(strokeHitsCircle(dot, 10, 21.9, 10), true);
  assert.equal(strokeHitsCircle(dot, 10, 22.1, 10), false);
  const h = hl([0, 0, 0.5, 0, 100, 0.5]); // half size 9
  assert.equal(strokeHitsCircle(h, 18.9, 50, 10), true);
  assert.equal(strokeHitsCircle(h, 19.1, 50, 10), false);
  assert.equal(strokeHitsCircle(pen([]), 0, 0, 10), false);
  assert.equal(strokeHitsCircle(s, NaN, 0, 10), false);
  // a polyline: the far corner segment counts
  assert.equal(strokeHitsCircle(pen([0, 0, 0.5, 100, 0, 0.5, 100, 100, 0.5], 2), 105, 60, 5), true);
});

test('translateRect', () => {
  assert.deepEqual(translateRect({ minX: 1, minY: 2, maxX: 3, maxY: 4 }, 10, -2), { minX: 11, minY: 0, maxX: 13, maxY: 2 });
  assert.equal(translateRect(null, 1, 1), null);
  assert.deepEqual(translateRect({ minX: 1, minY: 2, maxX: 3, maxY: 4 }, NaN, 1), { minX: 1, minY: 3, maxX: 3, maxY: 5 });
});
