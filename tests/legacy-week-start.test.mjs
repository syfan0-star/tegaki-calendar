import test from 'node:test';
import assert from 'node:assert/strict';
import { legacySourcesFor, legacyStrokesFor, LEGACY_SUFFIX } from '../js/ink/legacy-week-start.js';
import { addStrokes, emptyPage, liveStrokes, removeStrokes } from '../js/ink/model.js';
import { PAGE_SPECS, pageIdFor, rangeFor } from '../js/views/page-geometry.js';
import { parseYMD } from '../js/util/date.js';

const WEEK = PAGE_SPECS.week;
const COL_W = (WEEK.W - WEEK.gutter) / 7;
const MONTH = PAGE_SPECS.month;
const CELL_W = MONTH.W / 7;
const CELL_H = MONTH.H / 6;

/** A small stroke centred on (x, y). */
function strokeAt(id, x, y) {
  return { id, tool: 'pen', color: '#1f2937', size: 3.5, pts: [x - 5, y - 3, 0.5, x, y, 0.6, x + 5, y + 3, 0.5], t: 1000 };
}
function pageWith(pageId, strokes) {
  return addStrokes(emptyPage(pageId), strokes, 1);
}
function centerX(s) { return (s.pts[0] + s.pts[6]) / 2; }
function centerY(s) { return (s.pts[1] + s.pts[7]) / 2; }
const weekColX = (col) => WEEK.gutter + (col + 0.5) * COL_W;

test('legacySourcesFor: Monday weeks take two Sunday weeks, Monday months the Sunday month', () => {
  assert.deepEqual(legacySourcesFor('w-2026-09-28'), ['w-2026-09-27', 'w-2026-10-04']);
  assert.deepEqual(legacySourcesFor('m1-2026-10'), ['m-2026-10']);
  assert.deepEqual(legacySourcesFor('d-2026-10-04'), []);
  assert.deepEqual(legacySourcesFor('w-2026-10-04'), [], 'a Sunday id is not a Monday page');
  assert.deepEqual(legacySourcesFor('m-2026-10'), []);
  assert.deepEqual(legacySourcesFor('garbage'), []);
  // the ids the app now uses are exactly these Monday pages
  assert.equal(pageIdFor('week', parseYMD('2026-10-04'), 1), 'w-2026-09-28');
  assert.equal(pageIdFor('month', parseYMD('2026-10-04'), 1), 'm1-2026-10');
});

test('week: every stroke of a Sunday week lands on exactly one Monday week, on the same date', () => {
  // Old page: Sun 10/4 .. Sat 10/10. One stroke per day column + one in the time gutter.
  const old = pageWith('w-2026-10-04', [
    ...Array.from({ length: 7 }, (_, col) => strokeAt(`s${col}`, weekColX(col), 500 + col)),
    strokeAt('gutter', 30, 900),
  ]);
  const docs = new Map([['w-2026-10-04', old]]);
  const prev = legacyStrokesFor('w-2026-09-28', docs); // Mon 9/28 .. Sun 10/4: takes the Sunday
  const next = legacyStrokesFor('w-2026-10-05', docs); // Mon 10/5 .. Sun 10/11: takes Mon–Sat + gutter

  assert.deepEqual(prev.map((s) => s.id), [`s0${LEGACY_SUFFIX}`]);
  assert.ok(Math.abs(centerX(prev[0]) - weekColX(6)) < 0.11, 'Sunday → last column');
  assert.equal(centerY(prev[0]), 500, 'time of day unchanged');

  assert.deepEqual(next.map((s) => s.id).sort(), ['gutter', 's1', 's2', 's3', 's4', 's5', 's6'].map((id) => id + LEGACY_SUFFIX).sort());
  for (const s of next) {
    if (s.id.startsWith('gutter')) {
      assert.equal(centerX(s), 30, 'gutter notes stay where they were');
      continue;
    }
    const oldCol = Number(s.id[1]);
    assert.ok(Math.abs(centerX(s) - weekColX(oldCol - 1)) < 0.11, `${s.id} moved one column left`);
  }
  // check the dates: column → date on both grids
  const oldDays = rangeFor('week', parseYMD('2026-10-04'), 0).days.map((d) => d.getDate());
  const newDays = rangeFor('week', parseYMD('2026-10-05'), 1).days.map((d) => d.getDate());
  assert.equal(oldDays[3], newDays[2]); // Wed 10/7
});

test('month (1st not a Sunday): strokes move to the cell of the same date; dates off the grid are dropped', () => {
  // October 2026: old grid starts Sun 9/27, new grid Mon 9/28 → every date moves one cell back.
  const cell = (row, col) => [(col + 0.5) * CELL_W, (row + 0.5) * CELL_H];
  const old = pageWith('m-2026-10', [
    strokeAt('oct15', ...cell(2, 4)),  // Thu 10/15: idx 18 → 17 (row 2, col 3)
    strokeAt('oct4', ...cell(1, 0)),   // Sun 10/4: idx 7 → 6 (row 0, col 6)
    strokeAt('sep27', ...cell(0, 0)),  // Sun 9/27: idx 0 → −1, not on the new grid
    strokeAt('outside', MONTH.W + 50, 20),
  ]);
  const out = new Map(legacyStrokesFor('m1-2026-10', { 'm-2026-10': old }).map((s) => [s.id.replace(LEGACY_SUFFIX, ''), s]));
  assert.deepEqual([...out.keys()].sort(), ['oct15', 'oct4', 'outside']);
  assert.deepEqual([centerX(out.get('oct15')), centerY(out.get('oct15'))], cell(2, 3));
  assert.deepEqual([centerX(out.get('oct4')), centerY(out.get('oct4'))], cell(0, 6));
  assert.equal(centerX(out.get('outside')), MONTH.W + 50, 'off-grid strokes keep their place');
  const newDays = rangeFor('month', parseYMD('2026-10-01'), 1).days;
  assert.equal(newDays[17].getDate(), 15);
  assert.equal(newDays[6].getDate(), 4);
});

test('month (1st is a Sunday): the grid gains a leading week', () => {
  // February 2026 starts on Sunday: old grid starts 2/1, new grid Mon 1/26 → +6 cells.
  const cell = (row, col) => [(col + 0.5) * CELL_W, (row + 0.5) * CELL_H];
  const old = pageWith('m-2026-02', [
    strokeAt('feb1', ...cell(0, 0)),   // idx 0 → 6 (row 0, col 6)
    strokeAt('feb2', ...cell(0, 1)),   // idx 1 → 7 (row 1, col 0)
    strokeAt('mar14', ...cell(5, 6)),  // idx 41 → 47: not on the new grid
  ]);
  const out = new Map(legacyStrokesFor('m1-2026-02', { 'm-2026-02': old }).map((s) => [s.id.replace(LEGACY_SUFFIX, ''), s]));
  assert.deepEqual([...out.keys()].sort(), ['feb1', 'feb2']);
  assert.deepEqual([centerX(out.get('feb1')), centerY(out.get('feb1'))], cell(0, 6));
  assert.deepEqual([centerX(out.get('feb2')), centerY(out.get('feb2'))], cell(1, 0));
});

test('copies are idempotent and an erased copy stays erased', () => {
  const old = pageWith('w-2026-10-04', [strokeAt('a', weekColX(2), 300), strokeAt('b', weekColX(3), 300)]);
  const docs = { 'w-2026-10-04': old };
  let page = emptyPage('w-2026-10-05');
  page = addStrokes(page, legacyStrokesFor('w-2026-10-05', docs), 2);
  page = addStrokes(page, legacyStrokesFor('w-2026-10-05', docs), 3); // second visit / other device
  assert.equal(liveStrokes(page).length, 2);
  page = removeStrokes(page, [`a${LEGACY_SUFFIX}`], 4);
  page = addStrokes(page, legacyStrokesFor('w-2026-10-05', docs), 5);
  assert.deepEqual(liveStrokes(page).map((s) => s.id), [`b${LEGACY_SUFFIX}`]);
});

test('deleted strokes of the old page are not copied; bad input is ignored', () => {
  let old = pageWith('w-2026-10-04', [strokeAt('gone', weekColX(2), 300), strokeAt('kept', weekColX(2), 400)]);
  old = removeStrokes(old, ['gone'], 9);
  assert.deepEqual(legacyStrokesFor('w-2026-10-05', { 'w-2026-10-04': old }).map((s) => s.id), [`kept${LEGACY_SUFFIX}`]);
  assert.deepEqual(legacyStrokesFor('w-2026-10-05', {}), []);
  assert.deepEqual(legacyStrokesFor('w-2026-10-05', null), []);
  assert.deepEqual(legacyStrokesFor('d-2026-10-05', { 'w-2026-10-04': old }), []);
  const longId = 'x'.repeat(128);
  const long = pageWith('w-2026-10-04', [strokeAt(longId, weekColX(2), 300)]);
  const [copy] = legacyStrokesFor('w-2026-10-05', { 'w-2026-10-04': long });
  assert.equal(copy.id.length, 128);
  assert.ok(copy.id.endsWith(LEGACY_SUFFIX));
});
