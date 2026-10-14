// Tests for js/data/ink-export.js (the tegaki-web-export v1 file for the iPad app).
// The two fixtures are the iPad app's docs/M4_CONTRACT.md §1.4 samples, byte for byte: the app's own tests
// hold the same content, so both sides agree on the format.
// Run: TZ=Asia/Tokyo node --test tests/ink-export.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXPORT_FORMAT, EXPORT_VERSION, EXPORTABLE_ID_RE, isExportablePageId, exportFileName, localIsoString,
  buildExport, parseExport, collectDrivePages, collectKvPages, collectAll,
} from '../js/data/ink-export.js';
import { createMemoryKV } from '../js/util/idb.js';
import { addStrokes, emptyPage, makeStroke, removeStrokes, serializePage } from '../js/ink/model.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name) => JSON.parse(readFileSync(join(ROOT, 'tests/fixtures', name), 'utf8'));
const SAMPLE = fixture('tegaki-web-export-sample.json');
const EXPECTED = fixture('tegaki-web-export-expected.json');
const APP = 'web/1.0.6';
const AT = new Date(2026, 9, 14, 9, 41, 0, 0); // 2026-10-14T09:41:00.000+09:00 (TZ=Asia/Tokyo)

const stroke = (x, y, extra = {}) => makeStroke({ tool: 'pen', color: '#1f2937', size: 3.5, pts: [x, y, 0.5, x + 10, y + 10, 0.5], t: 1760000000000, ...extra });
const strokeCount = (doc) => doc.pages.reduce((n, p) => n + Object.keys(p.strokes).length, 0);

// ---------------------------------------------------------------- pure helpers

test('constants and the page id rule', () => {
  assert.equal(EXPORT_FORMAT, 'tegaki-web-export');
  assert.equal(EXPORT_VERSION, 1);
  assert.ok(EXPORTABLE_ID_RE.test('m1-2026-10'));
  assert.ok(!EXPORTABLE_ID_RE.test('m-2026-09'));
});

test('isExportablePageId: day, Monday week, Monday-start month, year; nothing else', () => {
  assert.equal(isExportablePageId('m1-2026-10'), true);
  assert.equal(isExportablePageId('m-2026-09'), false, 'Sunday-start month of 1.0.3');
  assert.equal(isExportablePageId('w-2026-10-05'), true, 'Monday');
  assert.equal(isExportablePageId('w-2026-10-04'), false, 'Sunday-start week of 1.0.3');
  assert.equal(isExportablePageId('w-2026-02-30'), false, 'not a date');
  assert.equal(isExportablePageId('y-2026'), true);
  assert.equal(isExportablePageId('d-2026-10-07'), true);
  assert.equal(isExportablePageId(''), false);
  assert.equal(isExportablePageId(undefined), false);
  assert.equal(isExportablePageId('d-2026-10-07x'), false);
  assert.equal(isExportablePageId('page:d-2026-10-07'), false);
});

test('exportFileName: local date', () => {
  assert.equal(exportFileName(AT), 'tegaki-web-export-2026-10-14.json');
  assert.equal(exportFileName(new Date(2026, 0, 3, 23, 59)), 'tegaki-web-export-2026-01-03.json');
  assert.match(exportFileName(), /^tegaki-web-export-\d{4}-\d{2}-\d{2}\.json$/);
  assert.throws(() => exportFileName(new Date(NaN)), TypeError);
});

test('localIsoString: local time with the +09:00 offset (not toISOString)', () => {
  assert.equal(localIsoString(AT), '2026-10-14T09:41:00.000+09:00');
  assert.equal(localIsoString(new Date(2026, 0, 1, 0, 0, 0, 7)), '2026-01-01T00:00:00.007+09:00');
  assert.notEqual(localIsoString(AT), AT.toISOString());
  assert.equal(localIsoString(AT.getTime()), '2026-10-14T09:41:00.000+09:00', 'ms are accepted too');
  assert.throws(() => localIsoString('nope'), TypeError);
});

// ---------------------------------------------------------------- buildExport

test('buildExport(見本 1 の pages) is exactly 見本 2 (order, dropped pages, tombstones kept)', () => {
  const out = buildExport({ pages: SAMPLE.pages, app: APP, exportedAt: AT });
  assert.deepEqual(out, EXPECTED);
  assert.deepEqual(out.pages.map((p) => p.pageId), ['d-2026-10-07', 'm1-2026-10', 'w-2026-10-05', 'y-2026']);
  assert.deepEqual(out.pages[0].deleted, { zz: 1760000000500 });
  assert.equal(strokeCount(out), 5);
  assert.equal(JSON.stringify(out), JSON.stringify(parseExport(JSON.stringify(out)) && out), 'JSON-able');
  // The input is not mutated and a string exportedAt is taken as it is.
  assert.equal(SAMPLE.pages.length, 6);
  assert.equal(buildExport({ pages: [], app: APP, exportedAt: '2026-10-14T09:41:00.000+09:00' }).exportedAt, EXPECTED.exportedAt);
});

test('buildExport: header fields, defaults and validation', () => {
  const out = buildExport({ pages: [], app: 'web/9.9.9', includesDemo: true, exportedAt: AT });
  assert.deepEqual(out, { format: 'tegaki-web-export', v: 1, exportedAt: '2026-10-14T09:41:00.000+09:00', app: 'web/9.9.9', includesDemo: true, pages: [] });
  assert.equal(buildExport({ pages: [], app: APP }).includesDemo, false);
  assert.match(buildExport({ pages: [], app: APP }).exportedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  assert.throws(() => buildExport({ pages: [], app: '' }), TypeError);
  assert.throws(() => buildExport({ pages: [] }), TypeError);
  assert.deepEqual(buildExport({ pages: null, app: APP }).pages, []);
  assert.deepEqual(buildExport({ pages: [null, 7, 'x', { pageId: 'd-2026-10-07' }], app: APP }).pages, [], 'garbage pages are dropped');
});

test('buildExport: the same page from two devices becomes one page; a tombstone from either side wins', () => {
  const a = stroke(10, 10);
  const b = stroke(50, 50);
  const c = stroke(90, 90);
  const dev1 = addStrokes(emptyPage('d-2026-10-07'), [a, b], 1760000001000);
  const dev2 = removeStrokes(addStrokes(emptyPage('d-2026-10-07'), [a, c], 1760000002000), [a.id], 1760000003000);
  const out = buildExport({ pages: [dev1, dev2], app: APP, exportedAt: AT });
  assert.equal(out.pages.length, 1);
  const page = out.pages[0];
  assert.deepEqual(Object.keys(page.strokes).sort(), [b.id, c.id].sort());
  assert.deepEqual(Object.keys(page.strokes), Object.keys(page.strokes).slice().sort(), 'strokes in id order');
  assert.deepEqual(page.deleted, { [a.id]: 1760000003000 });
  assert.equal(page.updatedAt, 1760000003000);
  assert.equal(page.v, 1);
  // Same result whatever the order (merge is commutative).
  assert.deepEqual(buildExport({ pages: [dev2, dev1], app: APP, exportedAt: AT }), out);
  // Raw JSON text of a page (as stored on Drive) is accepted as well.
  assert.deepEqual(buildExport({ pages: [serializePage(dev1), JSON.parse(serializePage(dev2))], app: APP, exportedAt: AT }), out);
});

test('buildExport: pages with only tombstones, unknown ids and malformed strokes are left out', () => {
  const a = stroke(10, 10);
  const gone = removeStrokes(addStrokes(emptyPage('d-2026-10-07'), [a]), [a.id]);
  const legacy = addStrokes(emptyPage('m-2026-10'), [stroke(1, 1)]);
  const sunday = addStrokes(emptyPage('w-2026-10-04'), [stroke(1, 1)]);
  const bad = { v: 1, pageId: 'y-2026', strokes: { q: { id: 'q', tool: 'crayon', pts: [1, 2, 3, 4, 5, 6] } }, deleted: {}, updatedAt: 5 };
  const ok = addStrokes(emptyPage('y-2026'), [stroke(1, 1)]);
  const out = buildExport({ pages: [gone, legacy, sunday, bad, ok], app: APP, exportedAt: AT });
  assert.deepEqual(out.pages.map((p) => p.pageId), ['y-2026']);
  assert.equal(strokeCount(out), 1);
});

// ---------------------------------------------------------------- parseExport

test('parseExport: round trip of buildExport, and 見本 1 reads as 6 pages', () => {
  const out = buildExport({ pages: SAMPLE.pages, app: APP, exportedAt: AT });
  const back = parseExport(JSON.stringify(out));
  assert.deepEqual(back, out);
  assert.deepEqual(buildExport({ pages: back.pages, app: APP, exportedAt: AT }), out, 'export → parse → export is stable');

  const sample = parseExport(readFileSync(join(ROOT, 'tests/fixtures/tegaki-web-export-sample.json'), 'utf8'));
  assert.equal(sample.pages.length, 6);
  assert.deepEqual(sample.pages.map((p) => p.pageId), ['m1-2026-10', 'w-2026-10-05', 'd-2026-10-07', 'y-2026', 'm-2026-09', 'd-2026-10-08']);
  assert.equal(sample.app, 'web/1.0.6');
  assert.equal(sample.exportedAt, '2026-10-14T09:41:00.000+09:00');
  assert.equal(sample.includesDemo, false);
  assert.deepEqual(sample.pages[2].deleted, { zz: 1760000000500 });
  assert.deepEqual(sample.pages[5], emptyPage('d-2026-10-08'));
  assert.deepEqual(parseExport(SAMPLE).pages, sample.pages, 'an already parsed object is accepted');
});

test('parseExport: rejects other files, newer versions and broken pages', () => {
  assert.throws(() => parseExport('{'), /JSON/);
  assert.throws(() => parseExport('[]'), /書き出しではありません/);
  assert.throws(() => parseExport(JSON.stringify({ v: 1, pageId: 'd-2026-10-07', strokes: {}, deleted: {} })), /書き出しではありません/);
  assert.throws(() => parseExport(JSON.stringify({ format: 'tegaki-web-export', v: 2, pages: [] })), /新しい形式.*v2/);
  assert.throws(() => parseExport(JSON.stringify({ format: 'tegaki-web-export', v: 'x', pages: [] })), /版/);
  assert.throws(() => parseExport(JSON.stringify({ format: 'tegaki-web-export', v: 1 })), /ページ/);
  assert.throws(() => parseExport(JSON.stringify({ format: 'tegaki-web-export', v: 1, pages: [{ strokes: {} }] })), /壊れています/);
  assert.deepEqual(parseExport(JSON.stringify({ format: 'tegaki-web-export', v: 1, pages: [] })),
    { format: 'tegaki-web-export', v: 1, exportedAt: '', app: '', includesDemo: false, pages: [] });
});

// ---------------------------------------------------------------- collecting: fake Drive + memory KVs

/** A fake appDataFolder: listAllInkFiles / download only (what the export uses). */
function fakeDrive(files, { fail = null } = {}) {
  const calls = [];
  return {
    calls,
    async listAllInkFiles() {
      calls.push('list');
      if (fail === 'list') throw Object.assign(new Error('network'), { name: 'ApiError', status: 0, reason: 'network' });
      return files.map((f) => ({ id: f.id, name: `ink-${f.page}--${f.dev}.json`, appProperties: { page: f.page, dev: f.dev, schema: '1' }, md5Checksum: 'x' }));
    },
    async download(id) {
      calls.push(`download:${id}`);
      if (fail === 'download') throw Object.assign(new Error('network'), { name: 'ApiError', status: 0, reason: 'network' });
      const f = files.find((x) => x.id === id);
      if (!f) throw Object.assign(new Error('not found'), { name: 'ApiError', status: 404, reason: 'notFound' });
      return typeof f.content === 'string' ? f.content : serializePage(f.content);
    },
  };
}

async function kvWith(pages) {
  const kv = createMemoryKV();
  for (const doc of pages) await kv.set(`page:${doc.pageId}`, doc);
  return kv;
}

test('collectDrivePages: every file of every device, merged per page, onProgress per download', async () => {
  const a = stroke(10, 10);
  const b = stroke(20, 20);
  const c = stroke(30, 30);
  const drive = fakeDrive([
    { id: 'f1', page: 'd-2026-10-07', dev: 'ipad', content: addStrokes(emptyPage('d-2026-10-07'), [a]) },
    { id: 'f2', page: 'd-2026-10-07', dev: 'mac', content: removeStrokes(addStrokes(emptyPage('d-2026-10-07'), [a, b]), [a.id]) },
    { id: 'f3', page: 'm1-2026-10', dev: 'ipad', content: addStrokes(emptyPage('m1-2026-10'), [c]) },
    { id: 'f4', page: 'y-2026', dev: 'ipad', content: 'not json at all' },
    { id: 'f5', page: '', dev: 'ipad', content: '{}' },
    { id: 'f1', page: 'd-2026-10-07', dev: 'ipad', content: '{}' }, // duplicate listing
  ]);
  const progress = [];
  const map = await collectDrivePages(drive, { onProgress: (p) => progress.push(p) });
  assert.deepEqual([...map.keys()].sort(), ['d-2026-10-07', 'm1-2026-10', 'y-2026']);
  assert.deepEqual(Object.keys(map.get('d-2026-10-07').strokes), [b.id]);
  assert.deepEqual(map.get('d-2026-10-07').deleted, { [a.id]: map.get('d-2026-10-07').deleted[a.id] });
  assert.deepEqual(map.get('y-2026'), emptyPage('y-2026'), 'unreadable content → empty page (never throws)');
  assert.deepEqual(progress, [{ done: 1, total: 4 }, { done: 2, total: 4 }, { done: 3, total: 4 }, { done: 4, total: 4 }]);
  assert.deepEqual(drive.calls, ['list', 'download:f1', 'download:f2', 'download:f3', 'download:f4']);
  assert.deepEqual(await collectDrivePages(fakeDrive([])), new Map());
  await assert.rejects(collectDrivePages(null), TypeError);
  await assert.rejects(collectDrivePages({ listPageFiles() {}, download() {} }), TypeError);
});

test('collectDrivePages: Drive errors propagate (the caller decides what offline means)', async () => {
  await assert.rejects(collectDrivePages(fakeDrive([{ id: 'f1', page: 'y-2026', dev: 'd', content: '{}' }], { fail: 'list' })), (e) => e.status === 0);
  await assert.rejects(collectDrivePages(fakeDrive([{ id: 'f1', page: 'y-2026', dev: 'd', content: '{}' }], { fail: 'download' })), (e) => e.status === 0);
});

test('collectKvPages: every page:<id> key, other keys ignored, values re-validated', async () => {
  const a = stroke(10, 10);
  const kv = await kvWith([addStrokes(emptyPage('d-2026-10-07'), [a])]);
  await kv.set('dirty', ['d-2026-10-07']);
  await kv.set('own:d-2026-10-07', 'f1');
  await kv.set('page:w-2026-10-05', serializePage(addStrokes(emptyPage('w-2026-10-05'), [stroke(1, 1)])));
  await kv.set('page:', { v: 1 });
  await kv.set('page:junk', 'garbage');
  const map = await collectKvPages(kv);
  assert.deepEqual([...map.keys()], ['d-2026-10-07', 'junk', 'w-2026-10-05']);
  assert.deepEqual(Object.keys(map.get('d-2026-10-07').strokes), [a.id]);
  assert.equal(Object.keys(map.get('w-2026-10-05').strokes).length, 1, 'JSON text is accepted');
  assert.deepEqual(map.get('junk'), emptyPage('junk'));
  await assert.rejects(collectKvPages(null), TypeError);
});

test('collectAll: Drive (2 devices) + kv + demo merged per page, pageId order', async () => {
  const a = stroke(10, 10);
  const b = stroke(20, 20);
  const c = stroke(30, 30);
  const d = stroke(40, 40);
  const e = stroke(50, 50);
  const drive = fakeDrive([
    { id: 'f1', page: 'd-2026-10-07', dev: 'ipad', content: addStrokes(emptyPage('d-2026-10-07'), [a]) },
    { id: 'f2', page: 'd-2026-10-07', dev: 'mac', content: addStrokes(emptyPage('d-2026-10-07'), [b]) },
    { id: 'f3', page: 'y-2026', dev: 'mac', content: addStrokes(emptyPage('y-2026'), [c]) },
  ]);
  // Local: the iPad's own copy of the day page (a, plus an unsent d) and a deletion of b made offline.
  const kv = await kvWith([removeStrokes(addStrokes(emptyPage('d-2026-10-07'), [a, d]), [b.id])]);
  const demoKv = await kvWith([addStrokes(emptyPage('m1-2026-10'), [e]), addStrokes(emptyPage('d-2026-10-07'), [stroke(60, 60)])]);
  const progress = [];
  const pages = await collectAll({ drive, kv, demoKv, onProgress: (p) => progress.push(p) });
  assert.deepEqual(pages.map((p) => p.pageId), ['d-2026-10-07', 'm1-2026-10', 'y-2026']);
  const day = pages[0];
  assert.equal(Object.keys(day.strokes).length, 3, 'a, d and the demo stroke; b is tombstoned');
  assert.ok(!(b.id in day.strokes));
  assert.ok(b.id in day.deleted);
  assert.deepEqual(Object.keys(pages[1].strokes), [e.id]);
  assert.deepEqual(Object.keys(pages[2].strokes), [c.id]);
  assert.equal(progress.length, 3, 'one progress call per Drive file');

  // Without the demo database the demo pages are absent; without Drive only the local part.
  const noDemo = await collectAll({ drive, kv });
  assert.deepEqual(noDemo.map((p) => p.pageId), ['d-2026-10-07', 'y-2026']);
  assert.equal(Object.keys(noDemo[0].strokes).length, 2);
  const local = await collectAll({ kv });
  assert.deepEqual(local.map((p) => p.pageId), ['d-2026-10-07']);
  assert.deepEqual(Object.keys(local[0].strokes).sort(), [a.id, d.id].sort());
  assert.deepEqual(await collectAll({ kv: createMemoryKV() }), []);

  // The whole thing feeds buildExport: tombstones travel with the page.
  const out = buildExport({ pages, app: APP, exportedAt: AT });
  assert.equal(out.pages.length, 3);
  assert.ok(b.id in out.pages[0].deleted);
  assert.equal(strokeCount(out), 5);
});

test('collectAll: a Drive failure rejects (nothing is swallowed), the kv is required', async () => {
  const kv = await kvWith([addStrokes(emptyPage('d-2026-10-07'), [stroke(1, 1)])]);
  const drive = fakeDrive([{ id: 'f1', page: 'y-2026', dev: 'd', content: '{}' }], { fail: 'list' });
  await assert.rejects(collectAll({ drive, kv }), (e) => e.status === 0);
  await assert.rejects(collectAll({}), TypeError);
});
