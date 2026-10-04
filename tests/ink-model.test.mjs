import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyPage,
  newStrokeId,
  makeStroke,
  addStrokes,
  removeStrokes,
  mergePages,
  liveStrokes,
  cloneStrokes,
  applyOp,
  invertOp,
  sameContent,
  serializePage,
  deserializePage,
} from '../js/ink/model.js';

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32). */
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

const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/** A normalised stroke with a chosen id (tests need deterministic ids). */
function S(id, { tool = 'pen', color = '#1f2937', size = 3.5, t = 1000, pts = [0, 0, 0.5, 10, 10, 0.5] } = {}) {
  return { id, tool, color, size, pts, t };
}

function randomPts(r, n = 1 + Math.floor(r() * 6)) {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push(Math.round(r() * 5000) / 10, Math.round(r() * 5000) / 10, Math.round(r() * 100) / 100);
  return pts;
}

/** Content of the visible ink regardless of ids (what the user sees). */
function visible(doc) {
  return liveStrokes(doc)
    .map((s) => JSON.stringify([s.tool, s.color, s.size, s.pts, s.t]))
    .sort();
}

/** Structural invariants every doc produced by the model must satisfy. */
function assertValidDoc(doc) {
  assert.equal(doc.v, 1);
  assert.equal(typeof doc.pageId, 'string');
  assert.ok(Number.isFinite(doc.updatedAt) && doc.updatedAt >= 0);
  assert.equal(Object.getPrototypeOf(doc.strokes), Object.prototype);
  assert.equal(Object.getPrototypeOf(doc.deleted), Object.prototype);
  for (const [id, t] of Object.entries(doc.deleted)) {
    assert.ok(id.length > 0 && id !== '__proto__');
    assert.ok(Number.isFinite(t) && t >= 0, `tombstone ${id}`);
  }
  for (const [id, s] of Object.entries(doc.strokes)) {
    assert.equal(s.id, id);
    assert.ok(!Object.hasOwn(doc.deleted, id), 'live stroke must not be tombstoned');
    assert.ok(s.tool === 'pen' || s.tool === 'highlighter');
    assert.match(s.color, /^#[0-9a-f]{6}$/);
    assert.ok(Number.isFinite(s.size) && s.size > 0);
    assert.ok(Number.isFinite(s.t) && s.t >= 0);
    assert.ok(Array.isArray(s.pts) && s.pts.length >= 3 && s.pts.length % 3 === 0);
    for (let i = 0; i < s.pts.length; i += 3) {
      assert.ok(Number.isFinite(s.pts[i]) && Number.isFinite(s.pts[i + 1]));
      assert.ok(s.pts[i + 2] >= 0 && s.pts[i + 2] <= 1);
    }
  }
}

/**
 * Random doc over a shared id pool so docs overlap. Some pool ids have two different contents
 * (simulating a corrupted/forked stroke) to exercise the deterministic tie-break.
 */
function makePool(r, size = 30) {
  const pool = [];
  for (let i = 0; i < size; i++) {
    const id = `s${i}`;
    const base = S(id, {
      tool: r() < 0.25 ? 'highlighter' : 'pen',
      color: pick(r, ['#1f2937', '#2563eb', '#fde047']),
      t: 1000 + Math.floor(r() * 50),
      pts: randomPts(r),
    });
    pool.push(base);
    if (r() < 0.15) pool.push({ ...base, t: base.t + 1, pts: randomPts(r) }); // same id, other content
  }
  return pool;
}

function randomDoc(r, pool) {
  let doc = emptyPage(r() < 0.9 ? 'w-2026-09-27' : '');
  const strokes = pool.filter(() => r() < 0.4);
  doc = addStrokes(doc, strokes, 1000 + Math.floor(r() * 1000));
  const dead = pool.filter(() => r() < 0.2).map((s) => s.id);
  if (dead.length) doc = removeStrokes(doc, dead, 2000 + Math.floor(r() * 1000));
  return doc;
}

// ---------------------------------------------------------------------------------------------
// basics
// ---------------------------------------------------------------------------------------------

test('emptyPage has the PageDoc shape', () => {
  assert.deepEqual(emptyPage('d-2026-10-04'), { v: 1, pageId: 'd-2026-10-04', strokes: {}, deleted: {}, updatedAt: 0 });
  assert.equal(emptyPage(undefined).pageId, '');
  assert.equal(emptyPage(42).pageId, '');
});

test('newStrokeId: unique strings', () => {
  const ids = new Set();
  for (let i = 0; i < 2000; i++) ids.add(newStrokeId());
  assert.equal(ids.size, 2000);
  for (const id of ids) assert.equal(typeof id, 'string');
});

test('newStrokeId: falls back when crypto.randomUUID is unavailable', () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
    const ids = new Set();
    for (let i = 0; i < 2000; i++) ids.add(newStrokeId());
    assert.equal(ids.size, 2000);
    for (const id of ids) assert.match(id, /^[0-9a-z-]+$/);
    // getRandomValues only (insecure context in a browser)
    Object.defineProperty(globalThis, 'crypto', {
      value: { getRandomValues: (a) => desc.get ? desc.get.call(globalThis).getRandomValues(a) : desc.value.getRandomValues(a) },
      configurable: true,
      writable: true,
    });
    assert.match(newStrokeId(), /^[0-9a-z]+-[0-9a-z]{4}-[0-9a-z]+$/);
  } finally {
    Object.defineProperty(globalThis, 'crypto', desc);
  }
  assert.equal(typeof globalThis.crypto.randomUUID, 'function');
});

test('makeStroke rounds, clamps and de-duplicates points', () => {
  const s = makeStroke({
    tool: 'pen',
    color: '#2563EB',
    size: 3.5,
    pts: [1.04, 2.06, 0.333, 1.01, 2.09, 0.9, 5.55, -0.04, 1.7, NaN, 1, 0.5, 7, 8, -1, 9, 9, 'x'],
    t: 1234.6,
  });
  assert.equal(typeof s.id, 'string');
  assert.equal(s.tool, 'pen');
  assert.equal(s.color, '#2563eb');
  assert.equal(s.size, 3.5);
  assert.equal(s.t, 1235);
  // (1.0, 2.1) twice → once; -0.04 → 0 (not -0); pressure clamped; bad pressure → 0.5; NaN point dropped
  assert.deepEqual(s.pts, [1, 2.1, 0.33, 5.6, 0, 1, 7, 8, 0, 9, 9, 0.5]);
  assert.ok(!Object.is(s.pts[4], -0));
});

test('makeStroke defaults and never throws', () => {
  const before = Date.now();
  for (const input of [undefined, null, 5, 'x', {}, { tool: 'laser', pts: 'nope' }, { pts: [1, 2] }]) {
    const s = makeStroke(input);
    assert.equal(s.tool, 'pen');
    assert.equal(s.color, '#1f2937');
    assert.equal(s.size, 3.5);
    assert.deepEqual(s.pts, []);
    assert.ok(s.t >= before);
  }
  const h = makeStroke({ tool: 'highlighter', pts: [0, 0, 0.5], size: -3, color: 'red' });
  assert.equal(h.color, '#fde047');
  assert.equal(h.size, 18);
  assert.equal(makeStroke({ color: '#ABC', pts: [0, 0, 0] }).color, '#aabbcc');
  assert.equal(makeStroke({ pts: new Float32Array([1, 2, 0.5]) }).pts.length, 3);
});

test('addStrokes adds, ignores tombstoned/malformed strokes and never mutates the input', () => {
  const d0 = deepFreeze(removeStrokes(emptyPage('p'), ['dead'], 50));
  const a = S('a');
  const d1 = addStrokes(d0, [a, S('dead'), { id: 'bad' }, null, makeStroke({ pts: [] })], 100);
  assert.deepEqual(Object.keys(d1.strokes), ['a']);
  assert.equal(d1.strokes.a, a);
  assert.equal(d1.updatedAt, 100);
  assert.deepEqual(d0.strokes, {});
  assert.notEqual(d1, d0);
  // re-adding the same stroke changes nothing
  const d2 = addStrokes(d1, [a], 200);
  assert.equal(d2.updatedAt, 100);
  assert.deepEqual(d2, d1);
  // a single stroke object is accepted too
  assert.ok(addStrokes(emptyPage('p'), S('x'), 1).strokes.x);
  assertValidDoc(d1);
});

test('removeStrokes tombstones (max time), also unknown ids, accepts stroke objects', () => {
  const d0 = deepFreeze(addStrokes(emptyPage('p'), [S('a'), S('b')], 10));
  const d1 = removeStrokes(d0, ['a', 'ghost', '', null, '__proto__'], 500);
  assert.deepEqual(Object.keys(d1.strokes), ['b']);
  assert.deepEqual(d1.deleted, { a: 500, ghost: 500 });
  assert.equal(d1.updatedAt, 500);
  const d2 = removeStrokes(d1, [S('a')], 300); // older delete keeps the newer time
  assert.equal(d2.deleted.a, 500);
  const d3 = removeStrokes(d2, [{ id: 'b' }], 900);
  assert.deepEqual(liveStrokes(d3), []);
  assert.equal(d3.deleted.b, 900);
  assertValidDoc(d3);
  // a tombstoned id can never come back
  assert.deepEqual(addStrokes(d3, [S('a')], 1000).strokes, {});
});

test('liveStrokes: highlighters first, then pens; by t then id', () => {
  let d = emptyPage('p');
  d = addStrokes(d, [
    S('p2', { t: 5 }),
    S('h1', { tool: 'highlighter', t: 9 }),
    S('p1', { t: 5 }),
    S('p0', { t: 1 }),
    S('h0', { tool: 'highlighter', t: 2 }),
  ]);
  d = removeStrokes(d, ['p0'], 10);
  assert.deepEqual(
    liveStrokes(d).map((s) => s.id),
    ['h0', 'h1', 'p1', 'p2'],
  );
  assert.deepEqual(liveStrokes(null), []);
});

test('cloneStrokes: new ids, translated + rounded, optional recolor, same t', () => {
  const src = deepFreeze([S('a', { pts: [1, 1, 0.5, 2.5, 3, 0.7], t: 77 }), { bogus: true }]);
  const [c] = cloneStrokes(src, { dx: 10.04, dy: -0.06 });
  assert.notEqual(c.id, 'a');
  assert.deepEqual(c.pts, [11, 0.9, 0.5, 12.5, 2.9, 0.7]);
  assert.equal(c.t, 77);
  assert.equal(c.color, '#1f2937');
  const [r] = cloneStrokes(src, { color: '#DC2626' });
  assert.equal(r.color, '#dc2626');
  assert.deepEqual(r.pts, src[0].pts);
  assert.notEqual(r.pts, src[0].pts, 'pts must be a copy');
  assert.equal(cloneStrokes(src).length, 1);
  assert.deepEqual(cloneStrokes(null), []);
});

test('sameContent compares live ids and tombstone ids', () => {
  const a = addStrokes(emptyPage('p'), [S('x'), S('y')], 1);
  const b = addStrokes(emptyPage('q'), [S('y'), S('x', { t: 99 })], 5);
  assert.equal(sameContent(a, b), true);
  assert.equal(sameContent(a, removeStrokes(a, ['x'], 2)), false);
  assert.equal(sameContent(a, removeStrokes(a, ['zzz'], 2)), false);
  assert.equal(sameContent(emptyPage('a'), emptyPage('b')), true);
});

// ---------------------------------------------------------------------------------------------
// CRDT merge properties
// ---------------------------------------------------------------------------------------------

test('mergePages = union strokes − union tombstones (max time), updatedAt max', () => {
  let a = addStrokes(emptyPage('p'), [S('1'), S('2')], 100);
  a = removeStrokes(a, ['3'], 150);
  let b = addStrokes(emptyPage('p'), [S('2'), S('3'), S('4')], 300);
  b = removeStrokes(b, ['1'], 120);
  b = removeStrokes(b, ['3'], 140);
  deepFreeze(a);
  deepFreeze(b);
  const m = mergePages(a, b);
  assert.deepEqual(Object.keys(m.strokes).sort(), ['2', '4']);
  assert.deepEqual(m.deleted, { 1: 120, 3: 150 });
  assert.equal(m.updatedAt, Math.max(a.updatedAt, b.updatedAt));
  assert.equal(m.pageId, 'p');
  assertValidDoc(m);
});

test('mergePages is commutative, associative and idempotent (random docs)', () => {
  const r = rng(12345);
  for (let iter = 0; iter < 300; iter++) {
    const pool = makePool(r);
    const a = deepFreeze(randomDoc(r, pool));
    const b = deepFreeze(randomDoc(r, pool));
    const c = deepFreeze(randomDoc(r, pool));
    const ab = mergePages(a, b);
    assert.deepEqual(ab, mergePages(b, a), `commutative #${iter}`);
    assert.deepEqual(mergePages(ab, c), mergePages(a, mergePages(b, c)), `associative #${iter}`);
    assert.deepEqual(mergePages(a, a), a, `idempotent #${iter}`);
    assert.deepEqual(mergePages(ab, ab), ab);
    assert.deepEqual(mergePages(ab, a), ab, 'absorbs an already merged input');
    assert.deepEqual(mergePages(a, emptyPage('')), a, 'empty doc is neutral');
    assertValidDoc(ab);
  }
});

test('mergePages tolerates garbage docs', () => {
  const a = addStrokes(emptyPage('p'), [S('1')], 1);
  for (const junk of [null, undefined, 3, 'x', [], { strokes: 5, deleted: [] }, { strokes: { z: { id: 'z' } } }]) {
    const m = mergePages(a, junk);
    assert.deepEqual(Object.keys(m.strokes), ['1']);
    assertValidDoc(m);
    assert.deepEqual(m, mergePages(junk, a));
  }
});

test('replicas converge under random concurrent edits and random sync order', () => {
  const r = rng(777);
  for (let round = 0; round < 40; round++) {
    const replicas = [emptyPage('m-2026-10'), emptyPage('m-2026-10'), emptyPage('m-2026-10')];
    const removedEver = new Set();
    let clock = 1000;
    for (let step = 0; step < 60; step++) {
      const i = Math.floor(r() * replicas.length);
      const doc = replicas[i];
      const roll = r();
      clock += 1 + Math.floor(r() * 10);
      if (roll < 0.45) {
        replicas[i] = applyOp(doc, { type: 'add', strokes: [makeStroke({ pts: randomPts(r), t: clock })] }, clock);
      } else if (roll < 0.7) {
        const live = liveStrokes(doc);
        if (live.length) {
          const victim = pick(r, live);
          removedEver.add(victim.id);
          replicas[i] = applyOp(doc, { type: 'remove', strokes: [victim] }, clock);
        }
      } else if (roll < 0.8) {
        // undo of a removal = clones with new ids
        const live = liveStrokes(doc);
        if (live.length) {
          const op = { type: 'remove', strokes: [pick(r, live)] };
          removedEver.add(op.strokes[0].id);
          const after = applyOp(doc, op, clock);
          replicas[i] = applyOp(after, invertOp(op), clock + 1);
        }
      } else {
        const j = Math.floor(r() * replicas.length);
        replicas[i] = mergePages(replicas[i], replicas[j]);
      }
    }
    // gossip until everyone has everything
    let all = replicas.reduce((acc, d) => mergePages(acc, d), emptyPage(''));
    for (let k = 0; k < replicas.length; k++) replicas[k] = mergePages(replicas[k], all);
    for (const d of replicas) {
      assert.deepEqual(d, replicas[0]);
      assertValidDoc(d);
      for (const id of removedEver) assert.ok(!Object.hasOwn(d.strokes, id), 'deleted stroke resurrected');
    }
    all = mergePages(all, replicas[1]);
    assert.ok(sameContent(all, replicas[2]));
  }
});

// ---------------------------------------------------------------------------------------------
// ops: apply / invert (undo / redo)
// ---------------------------------------------------------------------------------------------

test('applyOp handles add, remove, batch and ignores unknown ops', () => {
  const d0 = deepFreeze(emptyPage('p'));
  const a = S('a');
  const b = S('b');
  const d1 = applyOp(d0, { type: 'add', strokes: [a, b] }, 10);
  assert.deepEqual(Object.keys(d1.strokes).sort(), ['a', 'b']);
  const d2 = applyOp(d1, { type: 'batch', ops: [{ type: 'remove', strokes: [a] }, { type: 'add', strokes: [S('c')] }] }, 20);
  assert.deepEqual(Object.keys(d2.strokes).sort(), ['b', 'c']);
  assert.equal(d2.deleted.a, 20);
  assert.equal(applyOp(d2, { type: 'nope' }), d2);
  assert.equal(applyOp(d2, null), d2);
  assert.equal(applyOp(d2, { type: 'batch', ops: 'x' }), d2);
  // deeply nested batches do not blow the stack
  let deep = { type: 'add', strokes: [S('deep')] };
  for (let i = 0; i < 10000; i++) deep = { type: 'batch', ops: [deep] };
  assert.doesNotThrow(() => applyOp(d2, deep));
  assert.doesNotThrow(() => invertOp(deep));
});

test('invertOp: add ↔ remove, remove → clones with NEW ids, batch reversed', () => {
  const a = S('a');
  const inv = invertOp({ type: 'add', strokes: [a] });
  assert.deepEqual(inv, { type: 'remove', strokes: [a] });

  const back = invertOp({ type: 'remove', strokes: [a] });
  assert.equal(back.type, 'add');
  assert.equal(back.strokes.length, 1);
  assert.notEqual(back.strokes[0].id, 'a');
  assert.deepEqual({ ...back.strokes[0], id: 'a' }, a);

  const batch = invertOp({ type: 'batch', ops: [{ type: 'remove', strokes: [a] }, { type: 'add', strokes: [S('b')] }] });
  assert.equal(batch.type, 'batch');
  assert.equal(batch.ops[0].type, 'remove');
  assert.equal(batch.ops[0].strokes[0].id, 'b');
  assert.equal(batch.ops[1].type, 'add');
  assert.deepEqual(invertOp(null), { type: 'batch', ops: [] });
});

test('undo/redo of erase and move restores the visible ink', () => {
  let doc = addStrokes(emptyPage('p'), [S('a', { t: 1 }), S('b', { t: 2 })], 1);
  const initial = visible(doc);

  // erase "a", undo, redo, undo
  const erase = { type: 'remove', strokes: [doc.strokes.a] };
  doc = applyOp(doc, erase, 10);
  const undoErase = invertOp(erase);
  doc = applyOp(doc, undoErase, 11);
  assert.deepEqual(visible(doc), initial);
  assert.ok(!doc.strokes.a, 'original id stays dead');
  const redoErase = invertOp(undoErase);
  doc = applyOp(doc, redoErase, 12);
  assert.equal(liveStrokes(doc).length, 1);
  doc = applyOp(doc, invertOp(redoErase), 13);
  assert.deepEqual(visible(doc), initial);

  // move = remove originals + add translated clones
  const sel = liveStrokes(doc);
  const move = { type: 'batch', ops: [{ type: 'remove', strokes: sel }, { type: 'add', strokes: cloneStrokes(sel, { dx: 5, dy: 5 }) }] };
  doc = applyOp(doc, move, 20);
  assert.notDeepEqual(visible(doc), initial);
  const undoMove = invertOp(move);
  doc = applyOp(doc, undoMove, 21);
  assert.deepEqual(visible(doc), initial);
  doc = applyOp(doc, invertOp(undoMove), 22);
  assert.deepEqual(
    visible(doc),
    visible(addStrokes(emptyPage('p'), cloneStrokes(sel, { dx: 5, dy: 5 }))),
  );
});

test('stale undo references: draw, erase, undo, undo → empty; redo, redo → erased again', () => {
  const x = makeStroke({ pts: [1, 1, 0.5, 9, 9, 0.5], t: 5 });
  const undoStack = [];
  const redoStack = [];
  let doc = emptyPage('p');
  const commit = (op) => {
    doc = applyOp(doc, op, 10);
    undoStack.push(op);
    redoStack.length = 0;
  };
  const undo = () => {
    const inv = invertOp(undoStack.pop());
    doc = applyOp(doc, inv, 20);
    redoStack.push(inv);
  };
  const redo = () => {
    const inv = invertOp(redoStack.pop());
    doc = applyOp(doc, inv, 30);
    undoStack.push(inv);
  };
  commit({ type: 'add', strokes: [x] });
  commit({ type: 'remove', strokes: [x] });
  assert.equal(liveStrokes(doc).length, 0);
  undo(); // erase undone → clone X'
  assert.equal(liveStrokes(doc).length, 1);
  undo(); // draw undone → must remove X' although the op names X
  assert.equal(liveStrokes(doc).length, 0);
  redo(); // draw again
  assert.equal(liveStrokes(doc).length, 1);
  redo(); // erase again (op names X', which is dead → its live twin is erased)
  assert.equal(liveStrokes(doc).length, 0);
  undo();
  undo();
  assert.equal(liveStrokes(doc).length, 0);
  assertValidDoc(doc);
});

test('remove of a dead stroke without a live twin only tombstones it', () => {
  const a = S('a');
  let doc = addStrokes(emptyPage('p'), [a, S('b', { pts: [5, 5, 0.5] })], 1);
  doc = removeStrokes(doc, ['a'], 2);
  const after = applyOp(doc, { type: 'remove', strokes: [a] }, 3);
  assert.deepEqual(Object.keys(after.strokes), ['b']);
  assert.equal(after.deleted.a, 3);
  // two identical live twins: exactly one is removed per reference
  const [c1, c2] = [...cloneStrokes([a]), ...cloneStrokes([a])];
  let twins = addStrokes(doc, [c1, c2], 4);
  twins = applyOp(twins, { type: 'remove', strokes: [a] }, 5);
  assert.equal(liveStrokes(twins).filter((s) => s.pts === c1.pts || s.pts === c2.pts).length, 1);
});

test('random op histories: undo all → initial ink, redo all → final ink', () => {
  const r = rng(4242);
  for (let round = 0; round < 60; round++) {
    let doc = addStrokes(emptyPage('p'), Array.from({ length: 5 }, () => makeStroke({ pts: randomPts(r), t: 1 + Math.floor(r() * 9) })), 1);
    const initial = visible(doc);
    const undo = [];
    let now = 100;
    for (let k = 0; k < 15; k++) {
      const live = liveStrokes(doc);
      let op;
      const roll = r();
      if (roll < 0.4 || live.length === 0) {
        op = { type: 'add', strokes: [makeStroke({ pts: randomPts(r), t: now })] };
      } else if (roll < 0.7) {
        op = { type: 'remove', strokes: live.filter(() => r() < 0.5).slice(0, 3) };
      } else {
        const sel = live.filter(() => r() < 0.5);
        op = { type: 'batch', ops: [{ type: 'remove', strokes: sel }, { type: 'add', strokes: cloneStrokes(sel, { dx: 3, dy: -2 }) }] };
      }
      doc = applyOp(doc, op, now++);
      undo.push(op);
    }
    const final = visible(doc);
    const redo = [];
    while (undo.length) {
      const inv = invertOp(undo.pop());
      doc = applyOp(doc, inv, now++);
      redo.push(inv);
    }
    assert.deepEqual(visible(doc), initial, `undo all #${round}`);
    while (redo.length) doc = applyOp(doc, invertOp(redo.pop()), now++);
    assert.deepEqual(visible(doc), final, `redo all #${round}`);
    assertValidDoc(doc);
  }
});

// ---------------------------------------------------------------------------------------------
// serialisation
// ---------------------------------------------------------------------------------------------

test('serialize → deserialize round-trips and is deterministic and compact', () => {
  const r = rng(99);
  const pool = makePool(r);
  for (let i = 0; i < 50; i++) {
    const doc = randomDoc(r, pool);
    const json = serializePage(doc);
    assert.deepEqual(deserializePage(json, doc.pageId), doc);
    assert.equal(serializePage(deserializePage(json, doc.pageId)), json);
    assert.ok(!/\s/.test(json.replace(/"[^"]*"/g, '')), 'no whitespace outside strings');
  }
  const s = makeStroke({ pts: [1.23456, 2.34567, 0.56789], t: 5 });
  const doc = addStrokes(emptyPage('d-2026-10-04'), [s], 5);
  const json = serializePage(doc);
  assert.ok(json.includes('"pts":[1.2,2.3,0.57]'));
  assert.deepEqual(JSON.parse(json), { v: 1, pageId: 'd-2026-10-04', strokes: { [s.id]: s }, deleted: {}, updatedAt: 5 });
  // key order does not change the output
  const shuffled = { ...doc, strokes: Object.fromEntries(Object.entries(doc.strokes).reverse()) };
  assert.equal(serializePage(shuffled), json);
});

test('deserializePage: pageId argument wins, falls back to stored id', () => {
  const json = serializePage(addStrokes(emptyPage('w-2026-09-27'), [S('a')], 1));
  assert.equal(deserializePage(json, 'w-other').pageId, 'w-other');
  assert.equal(deserializePage(json).pageId, 'w-2026-09-27');
  assert.equal(deserializePage(JSON.parse(json), 'x').strokes.a.id, 'a', 'accepts an already parsed object');
});

test('deserializePage never throws on garbage and returns a valid doc', () => {
  const garbage = [
    undefined, null, '', ' ', 'null', 'true', '42', '"str"', '[]', '{', 'not json', '{"v":1', NaN, 0, [], {},
    '{"strokes":null,"deleted":null}', '{"strokes":[1,2,3],"deleted":"x"}', '{"strokes":{"a":"b"}}',
    '{"__proto__":{"polluted":1},"strokes":{"__proto__":{"id":"__proto__","tool":"pen","pts":[1,2,3]}}}',
    '{"strokes":{"a":{"id":"a","tool":"pen","pts":[1,2,0.5],"color":5,"size":"big","t":"now"}}}',
    '{"strokes":{"a":{"id":"a","tool":"pencil","pts":[1,2,0.5]}}}',
    '{"strokes":{"a":{"id":"a","tool":"pen","pts":[1e308,2,0.5,"1",2,3,null,null,null]}}}',
    '{"strokes":{"a":{"id":"a","tool":"pen","pts":{"length":3,"0":1,"1":2,"2":0.5}}}}',
    '{"deleted":{"a":"x","b":-5,"c":1e400,"":3},"updatedAt":-1}',
  ];
  for (const g of garbage) {
    const d = deserializePage(g, 'p');
    assertValidDoc(d);
    assert.equal(d.pageId, 'p');
  }
  assert.equal({}.polluted, undefined, 'no prototype pollution');
  const repaired = deserializePage('{"strokes":{"a":{"id":"a","tool":"pen","pts":[1,2,0.5],"color":5,"size":"big","t":"now"}}}', 'p');
  assert.deepEqual(repaired.strokes.a, { id: 'a', tool: 'pen', color: '#1f2937', size: 3.5, pts: [1, 2, 0.5], t: 0 });
  const dels = deserializePage('{"deleted":{"a":"x","b":-5,"c":7.6},"strokes":{"c":{"id":"c","tool":"pen","pts":[1,2,3]}}}', 'p');
  assert.deepEqual(dels.deleted, { a: 0, b: 0, c: 8 });
  assert.deepEqual(dels.strokes, {}, 'tombstoned strokes are dropped');
  // array form + missing ids use the map key
  const keyed = deserializePage({ strokes: { k1: { tool: 'highlighter', pts: [1, 1, 1] } } }, 'p');
  assert.equal(keyed.strokes.k1.tool, 'highlighter');
});

test('deserializePage fuzz: random corruption of valid JSON never throws', () => {
  const r = rng(2024);
  const pool = makePool(r);
  const base = serializePage(randomDoc(r, pool));
  for (let i = 0; i < 2000; i++) {
    const chars = base.split('');
    const edits = 1 + Math.floor(r() * 4);
    for (let e = 0; e < edits; e++) {
      const at = Math.floor(r() * chars.length);
      const op = r();
      if (op < 0.4) chars.splice(at, 1);
      else if (op < 0.8) chars[at] = pick(r, ['"', ',', ':', '{', '}', '[', ']', '-', '9', 'e', 'n', '.']);
      else chars.splice(at, 0, pick(r, ['null', '"__proto__"', '1e999', '[]', '{}']));
    }
    const d = deserializePage(chars.join(''), 'p');
    assertValidDoc(d);
  }
});

test('deserializePage caps absurd sizes', () => {
  // too many points: kept up to the cap
  const pts = [];
  for (let i = 0; i < 25000; i++) pts.push(i % 1000, Math.floor(i / 1000), 0.5);
  const big = deserializePage({ strokes: { a: { id: 'a', tool: 'pen', pts } } }, 'p');
  assert.equal(big.strokes.a.pts.length, 20000 * 3);
  // too many strokes
  const strokes = {};
  for (let i = 0; i < 20050; i++) strokes[`s${i}`] = { id: `s${i}`, tool: 'pen', pts: [1, 2, 0.5] };
  const many = deserializePage(JSON.stringify({ strokes }), 'p');
  assert.equal(Object.keys(many.strokes).length, 20000);
  // absurd size and coordinates
  const odd = deserializePage({ strokes: { a: { id: 'a', tool: 'pen', size: 1e9, pts: [1e7, 1, 0.5, 5, 5, 0.5] } } }, 'p');
  assert.equal(odd.strokes.a.size, 200);
  assert.deepEqual(odd.strokes.a.pts, [5, 5, 0.5]);
  // over-long ids are rejected
  const longId = 'x'.repeat(500);
  assert.deepEqual(deserializePage({ strokes: { [longId]: { tool: 'pen', pts: [1, 2, 3] } } }, 'p').strokes, {});
});
