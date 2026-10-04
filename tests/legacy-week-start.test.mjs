import test from 'node:test';
import assert from 'node:assert/strict';
import {
  legacySourcesFor, legacyStrokesFor, legacyErasedCopyIds, mergeLegacyInk, createLegacyCarryQueue,
  legacyDoneKey, legacyDoneFlagCounts, LEGACY_DONE_PREFIX, LEGACY_RECHECK_UNTIL, LEGACY_SUFFIX,
} from '../js/ink/legacy-week-start.js';
import { addStrokes, emptyPage, liveStrokes, mergePages, removeStrokes, sameContent } from '../js/ink/model.js';
import { strokeBBox } from '../js/ink/geometry.js';
import { PAGE_SPECS, monthCellAt, pageIdFor, rangeFor } from '../js/views/page-geometry.js';
import { addDays, addMonths, isSameDay, parseYMD, toYMD } from '../js/util/date.js';

const WEEK = PAGE_SPECS.week;
const COL_W = (WEEK.W - WEEK.gutter) / 7;
const MONTH = PAGE_SPECS.month;
const CELL_W = MONTH.W / 7;
// The date grid is gridH tall (the page continues below it with the memo area since 1.0.5); the old
// Sunday-start month pages were exactly that grid.
const GRID_H = MONTH.gridH;
const CELL_H = GRID_H / 6;

/** A small stroke centred on (x, y). */
function strokeAt(id, x, y) {
  return { id, tool: 'pen', color: '#1f2937', size: 3.5, pts: [x - 5, y - 3, 0.5, x, y, 0.6, x + 5, y + 3, 0.5], t: 1000 };
}
/** A straight stroke from (x1, y1) to (x2, y2). */
function line(id, x1, y1, x2, y2) {
  return { id, tool: 'pen', color: '#1f2937', size: 3.5, pts: [x1, y1, 0.5, (x1 + x2) / 2, (y1 + y2) / 2, 0.5, x2, y2, 0.5], t: 1000 };
}
function pageWith(pageId, strokes) {
  return addStrokes(emptyPage(pageId), strokes, 1);
}
function centerX(s) { return (s.pts[0] + s.pts[6]) / 2; }
function centerY(s) { return (s.pts[1] + s.pts[7]) / 2; }
const weekColX = (col) => WEEK.gutter + (col + 0.5) * COL_W;
const cell = (row, col) => [(col + 0.5) * CELL_W, (row + 0.5) * CELL_H];
const ids = (strokes) => strokes.map((s) => s.id).sort();
const monthKey = (first) => toYMD(first).slice(0, 7);
/** Every point moved by the same (dx, dy): the shape is unchanged. */
function shiftOf(copy, original) {
  const dx = copy.pts[0] - original.pts[0];
  const dy = copy.pts[1] - original.pts[1];
  for (let i = 0; i < copy.pts.length; i += 3) {
    assert.ok(Math.abs(copy.pts[i] - original.pts[i] - dx) < 0.11, 'same x shift for every point');
    assert.ok(Math.abs(copy.pts[i + 1] - original.pts[i + 1] - dy) < 0.11, 'same y shift for every point');
    assert.equal(copy.pts[i + 2], original.pts[i + 2]);
  }
  return { dx, dy };
}

test('legacySourcesFor: Monday weeks take two Sunday weeks, Monday months their Sunday month and its neighbours', () => {
  assert.deepEqual(legacySourcesFor('w-2026-09-28'), ['w-2026-09-27', 'w-2026-10-04']);
  assert.deepEqual(legacySourcesFor('m1-2026-10'), ['m-2026-10', 'm-2026-09', 'm-2026-11']);
  assert.deepEqual(legacySourcesFor('m1-2026-01'), ['m-2026-01', 'm-2025-12', 'm-2026-02']);
  assert.deepEqual(legacySourcesFor('m1-2026-12'), ['m-2026-12', 'm-2026-11', 'm-2027-01']);
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

test('week, all of 2026–2027: each stroke of each Sunday week is on exactly one Monday week, on its date', () => {
  for (let sunday = parseYMD('2026-01-04'); sunday < parseYMD('2028-01-01'); sunday = addDays(sunday, 7)) {
    const sourceId = `w-${toYMD(sunday)}`;
    const old = pageWith(sourceId, [
      ...Array.from({ length: 7 }, (_, col) => strokeAt(`c${col}`, weekColX(col), 700)),
      strokeAt('gutter', 20, 300),
    ]);
    const docs = { [sourceId]: old };
    const seen = new Map();
    for (const monday of [addDays(sunday, -6), addDays(sunday, 1)]) {
      for (const s of legacyStrokesFor(`w-${toYMD(monday)}`, docs)) {
        assert.ok(!seen.has(s.id), `${sourceId} ${s.id} is copied once`);
        seen.set(s.id, s);
        if (s.id.startsWith('gutter')) continue;
        const col = Number(s.id[1]);
        const newCol = Math.floor((centerX(s) - WEEK.gutter) / COL_W);
        assert.ok(isSameDay(addDays(monday, newCol), addDays(sunday, col)), `${sourceId} ${s.id} keeps its date`);
      }
    }
    assert.equal(seen.size, 8, `${sourceId}: every stroke lands somewhere`);
  }
});

test('month (1st not a Sunday): strokes move to the cell of the same date', () => {
  // October 2026: old grid starts Sun 9/27, new grid Mon 9/28 → every date moves one cell back.
  const old = pageWith('m-2026-10', [
    strokeAt('oct15', ...cell(2, 4)),  // Thu 10/15: idx 18 → 17 (row 2, col 3)
    strokeAt('oct4', ...cell(1, 0)),   // Sun 10/4: idx 7 → 6 (row 0, col 6)
    strokeAt('sep27', ...cell(0, 0)),  // Sun 9/27: not on the new October grid → the September page
    strokeAt('outside', MONTH.W + 50, 20),
  ]);
  const docs = { 'm-2026-10': old };
  const out = new Map(legacyStrokesFor('m1-2026-10', docs).map((s) => [s.id.replace(LEGACY_SUFFIX, ''), s]));
  assert.deepEqual([...out.keys()].sort(), ['oct15', 'oct4', 'outside']);
  assert.deepEqual([centerX(out.get('oct15')), centerY(out.get('oct15'))], cell(2, 3));
  assert.deepEqual([centerX(out.get('oct4')), centerY(out.get('oct4'))], cell(0, 6));
  assert.equal(centerX(out.get('outside')), MONTH.W + 50, 'off-grid strokes keep their place');
  const newDays = rangeFor('month', parseYMD('2026-10-01'), 1).days;
  assert.equal(newDays[17].getDate(), 15);
  assert.equal(newDays[6].getDate(), 4);

  // 9/27 goes to the September page (Mon 8/31 .. Sun 10/11): idx 27 = row 3, col 6
  const sep = legacyStrokesFor('m1-2026-09', docs);
  assert.deepEqual(sep.map((s) => s.id), [`sep27${LEGACY_SUFFIX}`]);
  assert.deepEqual([centerX(sep[0]), centerY(sep[0])], cell(3, 6));
  assert.equal(rangeFor('month', parseYMD('2026-09-01'), 1).days[27].getDate(), 27);
  assert.deepEqual(legacyStrokesFor('m1-2026-11', docs), [], 'nothing of October goes to November');
});

test('month (1st is a Sunday): the grid gains a leading week; the last week goes to the next month', () => {
  // February 2026 starts on Sunday: old grid starts 2/1, new grid Mon 1/26 → +6 cells.
  const old = pageWith('m-2026-02', [
    strokeAt('feb1', ...cell(0, 0)),   // idx 0 → 6 (row 0, col 6)
    strokeAt('feb2', ...cell(0, 1)),   // idx 1 → 7 (row 1, col 0)
    strokeAt('mar14', ...cell(5, 6)),  // idx 41: 3/14 is not on the new February grid
  ]);
  const docs = { 'm-2026-02': old };
  const out = new Map(legacyStrokesFor('m1-2026-02', docs).map((s) => [s.id.replace(LEGACY_SUFFIX, ''), s]));
  assert.deepEqual([...out.keys()].sort(), ['feb1', 'feb2']);
  assert.deepEqual([centerX(out.get('feb1')), centerY(out.get('feb1'))], cell(0, 6));
  assert.deepEqual([centerX(out.get('feb2')), centerY(out.get('feb2'))], cell(1, 0));
  // March 2026 also starts on Sunday: new grid Mon 2/23 .. Sun 4/5, so 3/14 is idx 19 (row 2, col 5)
  const mar = legacyStrokesFor('m1-2026-03', docs);
  assert.deepEqual(mar.map((s) => s.id), [`mar14${LEGACY_SUFFIX}`]);
  assert.deepEqual([centerX(mar[0]), centerY(mar[0])], cell(2, 5));
  assert.equal(rangeFor('month', parseYMD('2026-03-01'), 1).days[19].getDate(), 14);
  assert.deepEqual(legacyStrokesFor('m1-2026-01', docs), []);
});

test('month: the review examples land on the neighbouring month (5/31 of June, 12/10 of November)', () => {
  const june = pageWith('m-2026-06', [strokeAt('may31', ...cell(0, 0))]); // old June grid starts Sun 5/31
  const nov = pageWith('m-2026-11', [strokeAt('dec10', ...cell(5, 4))]); // old Nov grid: 11/1 .. 12/12
  const docs = { 'm-2026-06': june, 'm-2026-11': nov };
  assert.deepEqual(legacyStrokesFor('m1-2026-06', docs), []);
  const may = legacyStrokesFor('m1-2026-05', docs);
  assert.deepEqual(may.map((s) => s.id), [`may31${LEGACY_SUFFIX}`]);
  const mayDays = rangeFor('month', parseYMD('2026-05-01'), 1).days;
  const mayIdx = Math.floor(centerY(may[0]) / CELL_H) * 7 + Math.floor(centerX(may[0]) / CELL_W);
  assert.equal(toYMD(mayDays[mayIdx]), '2026-05-31');
  assert.deepEqual(legacyStrokesFor('m1-2026-11', docs), []);
  const dec = legacyStrokesFor('m1-2026-12', docs);
  assert.deepEqual(dec.map((s) => s.id), [`dec10${LEGACY_SUFFIX}`]);
  const decDays = rangeFor('month', parseYMD('2026-12-01'), 1).days;
  const decIdx = Math.floor(centerY(dec[0]) / CELL_H) * 7 + Math.floor(centerX(dec[0]) / CELL_W);
  assert.equal(toYMD(decDays[decIdx]), '2026-12-10');
});

test('month, all of 2026–2027: each stroke of each old month page is on exactly one new page, on its date', () => {
  // Old pages 2025-11 .. 2028-02, each with a stroke at the centre and near two corners of every cell,
  // plus strokes off the grid. Every new page that reads any of them is checked.
  const docs = new Map();
  const where = new Map(); // stroke id → { source, date | null (off grid), x, y }
  for (let first = parseYMD('2025-11-01'); first <= parseYMD('2028-02-01'); first = addMonths(first, 1)) {
    const sourceId = `m-${monthKey(first)}`;
    const oldDays = rangeFor('month', first, 0).days;
    const strokes = [];
    for (let i = 0; i < 42; i++) {
      const row = Math.floor(i / 7);
      const col = i % 7;
      const spots = [cell(row, col), [col * CELL_W + 8, row * CELL_H + 6], [(col + 1) * CELL_W - 8, (row + 1) * CELL_H - 6]];
      spots.forEach(([x, y], k) => {
        const id = `${monthKey(first)}/${i}/${k}`;
        strokes.push(strokeAt(id, x, y));
        where.set(id, { source: monthKey(first), date: oldDays[i], x, y });
      });
    }
    for (const [k, [x, y]] of [[MONTH.W + 40, 100], [300, GRID_H + 30], [-30, 500]].entries()) {
      const id = `${monthKey(first)}/off/${k}`;
      strokes.push(strokeAt(id, x, y));
      where.set(id, { source: monthKey(first), date: null, x, y });
    }
    docs.set(sourceId, pageWith(sourceId, strokes));
  }
  const landed = new Map(); // stroke id → [{ page, copy }]
  for (let first = parseYMD('2025-12-01'); first <= parseYMD('2028-01-01'); first = addMonths(first, 1)) {
    const pageId = `m1-${monthKey(first)}`;
    for (const s of legacyStrokesFor(pageId, docs)) {
      const id = s.id.slice(0, -LEGACY_SUFFIX.length);
      if (!landed.has(id)) landed.set(id, []);
      landed.get(id).push({ first, copy: s });
    }
  }
  let checked = 0;
  for (const [id, info] of where) {
    if (info.source < '2026-01' || info.source > '2027-12') continue;
    const hits = landed.get(id) || [];
    assert.equal(hits.length, 1, `${id} lands on exactly one page (got ${hits.length})`);
    const [{ first, copy }] = hits;
    if (info.date === null) {
      assert.equal(monthKey(first), info.source, `${id}: off-grid strokes stay with their month`);
      assert.deepEqual([centerX(copy), centerY(copy)], [info.x, info.y], `${id}: unmoved`);
    } else {
      const idx = Math.floor(centerY(copy) / CELL_H) * 7 + Math.floor(centerX(copy) / CELL_W);
      const newDays = rangeFor('month', first, 1).days;
      assert.ok(isSameDay(newDays[idx], info.date), `${id}: on the cell of ${toYMD(info.date)} (got ${toYMD(newDays[idx])})`);
    }
    checked++;
  }
  assert.equal(checked, 24 * (42 * 3 + 3));
});

test('a stroke crossing from Sunday into Monday stays fully on the page (week)', () => {
  // Old week Sun 9/27: a line from Sunday (x=150) into Monday (x=400); centre in Monday → new page 9/28
  const arrow = line('arrow', 150, 600, 400, 600);
  const docs = { 'w-2026-09-27': pageWith('w-2026-09-27', [arrow]) };
  const [copy] = legacyStrokesFor('w-2026-09-28', docs);
  const b = strokeBBox(copy);
  assert.ok(b.minX >= -0.06, `left end stays on the page (minX ${b.minX})`);
  assert.ok(b.maxX <= WEEK.W);
  const { dx, dy } = shiftOf(copy, arrow);
  assert.ok(dx < 0 && dx > -COL_W, 'moved left, but less than a whole column');
  assert.equal(dy, 0);
  // the Saturday → Sunday case: a line from Saturday into the page edge goes to the last column, inside
  const sat = line('sat', 1300, 400, 1396, 400); // old Sat column (col 6) → new page of 9/28, col 5
  const [satCopy] = legacyStrokesFor('w-2026-09-28', { 'w-2026-09-27': pageWith('w-2026-09-27', [sat]) });
  assert.ok(Math.abs(shiftOf(satCopy, sat).dx + COL_W) < 0.11, 'room to move: the whole column');
  // a stroke on the next old week's Sunday that reaches into the gutter goes to the last column, inside
  const sun = line('sun', 40, 300, 320, 300); // centre x=180 → column 0 (Sunday 10/4); +6 columns would pass x=1400
  const [sunCopy] = legacyStrokesFor('w-2026-09-28', { 'w-2026-10-04': pageWith('w-2026-10-04', [sun]) });
  const sb = strokeBBox(sunCopy);
  assert.ok(sb.maxX <= WEEK.W + 0.06, `right end stays on the page (maxX ${sb.maxX})`);
  assert.ok(sb.minX >= WEEK.gutter + 5 * COL_W, 'in the Sunday column (part of it)');
  assert.ok(shiftOf(sunCopy, sun).dx < 6 * COL_W - 1, 'clamped');
});

test('a stroke crossing cells stays fully on the month page; strokes already off the page move unclamped', () => {
  // October 2026: Sun 10/4 (row 1, col 0) → row 0, col 6 (+1200). A line into Monday's cell would leave the page.
  const line1 = line('wide', 30, 260, 330, 260); // centre x=180 → col 0, row 1
  const docs = { 'm-2026-10': pageWith('m-2026-10', [line1]) };
  const [copy] = legacyStrokesFor('m1-2026-10', docs);
  const b = strokeBBox(copy);
  assert.ok(b.maxX <= MONTH.W + 0.06, `right end on the page (maxX ${b.maxX})`);
  assert.ok(b.minX >= 0);
  const { dx, dy } = shiftOf(copy, line1);
  assert.ok(dx > 0 && dx < 1200);
  assert.equal(dy, -CELL_H);

  // February 2026 (+6 cells): row 4, col 1 → row 5, col 0. A tall stroke would leave the bottom of the page.
  const tall = line('tall', 230, 710, 230, 1000); // centre y=855 → row 4
  const [tallCopy] = legacyStrokesFor('m1-2026-02', { 'm-2026-02': pageWith('m-2026-02', [tall]) });
  const tb = strokeBBox(tallCopy);
  assert.ok(tb.maxY <= GRID_H + 0.06, `bottom on the grid, not pushed into the memo area (maxY ${tb.maxY})`);
  const t = shiftOf(tallCopy, tall);
  assert.equal(t.dx, -CELL_W);
  assert.ok(t.dy > 0 && t.dy < CELL_H);

  // Already sticking out of the page on the left: moved by whole cells as before
  const out = line('out', -40, 260, 120, 260); // centre x=40 → col 0, row 1
  const [outCopy] = legacyStrokesFor('m1-2026-10', { 'm-2026-10': pageWith('m-2026-10', [out]) });
  assert.deepEqual(shiftOf(outCopy, out), { dx: 1200, dy: -CELL_H });
});

test('month since 1.0.5 (memo area below the grid): copies land on the grid cells of their dates, never in the memo area', () => {
  assert.equal(MONTH.gridH, 1050, 'the old pages were 1400×1050: the grid kept that size');
  assert.ok(MONTH.H > MONTH.gridH);
  // Strokes everywhere on the old grids of 2026 (cell centres, and tall strokes filling a cell's height).
  for (let first = parseYMD('2026-01-01'); first <= parseYMD('2026-12-01'); first = addMonths(first, 1)) {
    const sourceId = `m-${monthKey(first)}`;
    const oldDays = rangeFor('month', first, 0).days;
    const strokes = [];
    const dateOf = new Map();
    for (let i = 0; i < 42; i++) {
      const row = Math.floor(i / 7);
      const col = i % 7;
      strokes.push(strokeAt(`c${i}`, ...cell(row, col)));
      strokes.push(line(`t${i}`, (col + 0.5) * CELL_W, row * CELL_H + 4, (col + 0.5) * CELL_W, (row + 1) * CELL_H - 4));
      dateOf.set(`c${i}`, oldDays[i]);
      dateOf.set(`t${i}`, oldDays[i]);
    }
    const docs = { [sourceId]: pageWith(sourceId, strokes) };
    for (const target of [addMonths(first, -1), first, addMonths(first, 1)]) {
      const range = rangeFor('month', target, 1);
      for (const copy of legacyStrokesFor(`m1-${monthKey(target)}`, docs)) {
        const b = strokeBBox(copy);
        assert.ok(b.maxY <= MONTH.gridH + 0.06, `${copy.id} stays above the memo area (maxY ${b.maxY})`);
        // Read back with the app's own geometry: the cell under the copy is the stroke's date.
        const at = monthCellAt((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
        assert.ok(at, `${copy.id} is on the grid`);
        const id = copy.id.slice(0, -LEGACY_SUFFIX.length);
        assert.ok(isSameDay(range.days[at.row * 7 + at.col], dateOf.get(id)),
          `${id} of ${sourceId} on ${toYMD(dateOf.get(id))} (got ${toYMD(range.days[at.row * 7 + at.col])})`);
      }
    }
  }
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
  // the same through mergeLegacyInk
  const again = mergeLegacyInk('w-2026-10-05', page, docs, 6);
  assert.ok(sameContent(again, page));
});

test('deleted strokes of the old page are not copied; bad input is ignored', () => {
  let old = pageWith('w-2026-10-04', [strokeAt('gone', weekColX(2), 300), strokeAt('kept', weekColX(2), 400)]);
  old = removeStrokes(old, ['gone'], 9);
  assert.deepEqual(legacyStrokesFor('w-2026-10-05', { 'w-2026-10-04': old }).map((s) => s.id), [`kept${LEGACY_SUFFIX}`]);
  assert.deepEqual(legacyStrokesFor('w-2026-10-05', {}), []);
  assert.deepEqual(legacyStrokesFor('w-2026-10-05', null), []);
  assert.deepEqual(legacyStrokesFor('d-2026-10-05', { 'w-2026-10-04': old }), []);
  assert.deepEqual(legacyErasedCopyIds('w-2026-10-05', null), []);
  assert.deepEqual(legacyErasedCopyIds('d-2026-10-05', { 'w-2026-10-04': old }), []);
  const longId = 'x'.repeat(128);
  const long = pageWith('w-2026-10-04', [strokeAt(longId, weekColX(2), 300)]);
  const [copy] = legacyStrokesFor('w-2026-10-05', { 'w-2026-10-04': long });
  assert.equal(copy.id.length, 128);
  assert.ok(copy.id.endsWith(LEGACY_SUFFIX));
  assert.deepEqual(legacyErasedCopyIds('w-2026-10-05', { 'w-2026-10-04': removeStrokes(long, [longId], 9) }), [copy.id]);
});

test('legacyErasedCopyIds: copy ids of every erased stroke of the page\'s old pages only', () => {
  let a = pageWith('w-2026-09-27', [strokeAt('x', weekColX(0), 300), strokeAt('y', weekColX(3), 300)]);
  a = removeStrokes(a, ['x', 'y'], 5); // x was Sunday's (another page's copy): listed anyway, harmless
  let b = pageWith('w-2026-10-04', [strokeAt('z', weekColX(0), 300)]);
  b = removeStrokes(b, ['z'], 5);
  const other = removeStrokes(pageWith('w-2026-10-11', [strokeAt('q', weekColX(0), 300)]), ['q'], 5);
  const docs = { 'w-2026-09-27': a, 'w-2026-10-04': b, 'w-2026-10-11': other };
  assert.deepEqual(legacyErasedCopyIds('w-2026-09-28', docs).sort(), ['x', 'y', 'z'].map((id) => id + LEGACY_SUFFIX));
});

test('F2: a copy made from an out-of-date old page is erased once the old page is read again', () => {
  // Mac (old version) moves memo X on the old week of 9/27 from Wednesday to Thursday: X erased, X2 added.
  const stale = pageWith('w-2026-09-27', [strokeAt('X', weekColX(3), 500)]);
  const fresh = addStrokes(removeStrokes(stale, ['X'], 10), [strokeAt('X2', weekColX(4), 500)], 10);
  // iPad (offline) copies from its stale local old page and saves; later, online, it reads the fresh one
  let page = mergeLegacyInk('w-2026-09-28', emptyPage('w-2026-09-28'), { 'w-2026-09-27': stale }, 20);
  assert.deepEqual(ids(liveStrokes(page)), [`X${LEGACY_SUFFIX}`]);
  page = mergeLegacyInk('w-2026-09-28', page, { 'w-2026-09-27': fresh }, 30);
  assert.deepEqual(ids(liveStrokes(page)), [`X2${LEGACY_SUFFIX}`], 'the memo is on Thursday only, not twice');
  assert.ok(Object.hasOwn(page.deleted, `X${LEGACY_SUFFIX}`));
  // erasing it on the old page erases the copy too, even when nothing is left to copy
  const erased = removeStrokes(fresh, ['X2'], 40);
  page = mergeLegacyInk('w-2026-09-28', page, { 'w-2026-09-27': erased }, 50);
  assert.deepEqual(liveStrokes(page), []);
  // stale copies coming back from another device are removed by the merge (tombstones win)
  const otherDevice = mergeLegacyInk('w-2026-09-28', emptyPage('w-2026-09-28'), { 'w-2026-09-27': stale }, 25);
  assert.deepEqual(liveStrokes(mergePages(page, otherDevice)), []);
});

test('mergeLegacyInk: tombstones only for copies on the page, so an untouched page stays the same', () => {
  let old = pageWith('w-2026-09-27', [strokeAt('a', weekColX(2), 300), strokeAt('b', weekColX(5), 300)]);
  old = removeStrokes(old, ['a'], 5);
  const docs = { 'w-2026-09-27': old };
  const empty = emptyPage('w-2026-09-28');
  const once = mergeLegacyInk('w-2026-09-28', empty, docs, 10);
  assert.deepEqual(ids(liveStrokes(once)), [`b${LEGACY_SUFFIX}`]);
  assert.deepEqual(Object.keys(once.deleted), [], 'no tombstone for a copy that was never made');
  assert.ok(sameContent(mergeLegacyInk('w-2026-09-28', once, docs, 20), once), 'nothing to save the second time');
  const nothing = { 'w-2026-09-27': removeStrokes(pageWith('w-2026-09-27', []), ['zz'], 5) };
  assert.ok(sameContent(mergeLegacyInk('w-2026-09-28', empty, nothing, 30), empty), 'an empty page stays empty');
  // the user's own strokes and the user's erasing of a copy are kept
  let mine = addStrokes(once, [strokeAt('own', 500, 500)], 40);
  mine = removeStrokes(mine, [`b${LEGACY_SUFFIX}`], 41);
  const after = mergeLegacyInk('w-2026-09-28', mine, docs, 50);
  assert.deepEqual(ids(liveStrokes(after)), ['own']);
});

test('done flag: per-page key under the account prefix; ignored until 2026-12-01 (local)', () => {
  assert.equal(LEGACY_DONE_PREFIX, 'legacyWeekStart:');
  for (const pageId of ['w-2026-09-28', 'm1-2026-10']) {
    const key = legacyDoneKey(pageId);
    assert.ok(key.startsWith(LEGACY_DONE_PREFIX), 'cleared on sign-out with the other account data');
    assert.ok(key.endsWith(pageId));
    assert.notEqual(key, `legacyWeekStart:${pageId}`, 'flags of the first 1.0.4 build do not count');
  }
  assert.notEqual(legacyDoneKey('w-2026-09-28'), legacyDoneKey('w-2026-10-05'));
  assert.equal(LEGACY_RECHECK_UNTIL.getTime(), new Date(2026, 11, 1).getTime());
  assert.equal(toYMD(LEGACY_RECHECK_UNTIL), '2026-12-01');
  assert.equal(LEGACY_RECHECK_UNTIL.getHours(), 0);
  assert.equal(legacyDoneFlagCounts(new Date(2026, 9, 4, 12)), false);
  assert.equal(legacyDoneFlagCounts(new Date(2026, 10, 30, 23, 59, 59).getTime()), false);
  assert.equal(legacyDoneFlagCounts(new Date(2026, 11, 1)), true);
  assert.equal(legacyDoneFlagCounts(new Date(2027, 5, 1).getTime()), true);
  assert.equal(legacyDoneFlagCounts(NaN), false);
});

test('createLegacyCarryQueue: one run per page at a time; a call during a run repeats it for the latest visit', async () => {
  const calls = [];
  const gates = [];
  const carry = createLegacyCarryQueue((p) => {
    calls.push(p.tag);
    return new Promise((resolve) => gates.push(resolve));
  });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const first = carry({ pageId: 'w-2026-09-28', tag: 'load' });
  const other = carry({ pageId: 'm1-2026-10', tag: 'month' });
  await tick();
  assert.deepEqual(calls, ['load', 'month'], 'different pages run independently');
  const second = carry({ pageId: 'w-2026-09-28', tag: 'drive-1' });
  const third = carry({ pageId: 'w-2026-09-28', tag: 'drive-2' });
  assert.equal(second, first);
  assert.equal(third, first);
  await tick();
  assert.deepEqual(calls, ['load', 'month'], 'no second run alongside the first');
  gates[0]();
  await tick();
  assert.deepEqual(calls, ['load', 'month', 'drive-2'], 'repeated once, for the latest call');
  gates[1]();
  gates[2]();
  await Promise.all([first, other]);
  // after it finished, a new call starts a new run; a failing run does not reject or block the next
  const failing = createLegacyCarryQueue(async (p) => {
    calls.push(p.tag);
    throw new Error('boom');
  });
  await failing({ pageId: 'w-2026-09-28', tag: 'fail-1' });
  await failing({ pageId: 'w-2026-09-28', tag: 'fail-2' });
  assert.deepEqual(calls.slice(-2), ['fail-1', 'fail-2']);
  await carry(null);
  await carry({});
});
