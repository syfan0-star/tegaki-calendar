// Export of all handwriting as ONE JSON file (format 'tegaki-web-export' v1), for the iPad app to import
// (docs/SPEC.md §4 D; the iPad app's docs/M4_CONTRACT.md §1.3 is the authority on the shape).
//
// - Pure module: importable in Node (no DOM, no browser globals). main.js does the download (Blob + <a download>).
// - Sources: every Drive file of every device (listAllInkFiles → download), the local kv ('page:<id>') and
//   optionally the お試しモード kv. Files of the same page are merged with mergePages (union of strokes minus
//   union of tombstones), so the export is the same whatever the order of the sources.
// - Each exported page is written like serializePage: strokes in id order (live ones only), the merged
//   tombstones in id order (kept on purpose: a stroke erased here must not come back when the same file is
//   imported twice), updatedAt = max. Pages without a live stroke are dropped, and so are the ids the app
//   does not know ('m-YYYY-MM' and the Sunday-start 'w-' of 1.0.3 and before).
// - Nothing here writes: the kv and Drive are only read.

import { deserializePage, liveStrokes, mergePages, serializePage } from '../ink/model.js';

export const EXPORT_FORMAT = 'tegaki-web-export';
export const EXPORT_VERSION = 1;

/** Page ids the iPad app can place: day, Monday week, Monday-start month, year. */
export const EXPORTABLE_ID_RE = /^(?:d-\d{4}-\d{2}-\d{2}|w-\d{4}-\d{2}-\d{2}|m1-\d{4}-\d{2}|y-\d{4})$/;

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const pad2 = (n) => String(n).padStart(2, '0');

/** True for an id that matches EXPORTABLE_ID_RE; a 'w-' id must also be a real Monday (local calendar). */
export function isExportablePageId(pageId) {
  if (typeof pageId !== 'string' || !EXPORTABLE_ID_RE.test(pageId)) return false;
  if (!pageId.startsWith('w-')) return true;
  const [y, m, d] = pageId.slice(2).split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d && date.getDay() === 1;
}

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('ink-export: invalid date');
  return date;
}

/** 'tegaki-web-export-YYYY-MM-DD.json' (local date). */
export function exportFileName(date = new Date()) {
  const d = toDate(date);
  return `tegaki-web-export-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}.json`;
}

/** ISO 8601 with the LOCAL time and offset, e.g. '2026-10-14T09:41:00.000+09:00' (not toISOString, which is UTC). */
export function localIsoString(date) {
  const d = toDate(date);
  const offset = -d.getTimezoneOffset(); // minutes east of UTC
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    + `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
    + `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** Validated copy of any page-like value under `pageId` (deserializePage never throws). */
function toDoc(raw, pageId) {
  const id = typeof pageId === 'string' && pageId ? pageId : (isRecord(raw) && typeof raw.pageId === 'string' ? raw.pageId : '');
  return deserializePage(isRecord(raw) || typeof raw === 'string' ? raw : {}, id);
}

/** mergePages with the page id forced (mergePages picks the smaller id on a mismatch). */
function mergeInto(map, doc) {
  const id = doc.pageId;
  if (!id) return;
  const prev = map.get(id);
  if (!prev) {
    map.set(id, doc);
    return;
  }
  const merged = mergePages(prev, doc);
  map.set(id, merged.pageId === id ? merged : { ...merged, pageId: id });
}

const byPageId = (a, b) => (a.pageId < b.pageId ? -1 : a.pageId > b.pageId ? 1 : 0);

/**
 * The export document (an object; JSON.stringify is the caller's job).
 * @param {{ pages: object[], app: string, includesDemo?: boolean, exportedAt?: Date|string }} opts
 *   pages: PageDocs from any source (the same pageId several times is merged); app: 'web/<APP_VERSION>';
 *   exportedAt: a Date (→ localIsoString) or an already formatted string.
 */
export function buildExport({ pages, app, includesDemo = false, exportedAt = new Date() } = {}) {
  if (typeof app !== 'string' || !app) throw new TypeError('ink-export: app must be a non-empty string');
  const merged = new Map();
  for (const raw of Array.isArray(pages) ? pages : []) mergeInto(merged, toDoc(raw));
  const out = [];
  for (const doc of merged.values()) {
    if (!isExportablePageId(doc.pageId) || liveStrokes(doc).length === 0) continue;
    out.push(JSON.parse(serializePage(doc))); // strokes / deleted in id order, live strokes only
  }
  out.sort(byPageId);
  return {
    format: EXPORT_FORMAT,
    v: EXPORT_VERSION,
    exportedAt: typeof exportedAt === 'string' ? exportedAt : localIsoString(exportedAt),
    app,
    includesDemo: Boolean(includesDemo),
    pages: out,
  };
}

/**
 * The reverse (tests, and a future 「読み込み」): checks format / v, parses every page with deserializePage
 * (pages are kept as they are: no filtering, no merging). Throws when the text is not an export of this app.
 * @param {string|object} text JSON text (or an already parsed object)
 * @returns {{ format: string, v: number, exportedAt: string, app: string, includesDemo: boolean, pages: object[] }}
 */
export function parseExport(text) {
  let data = text;
  if (typeof text === 'string') {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('JSON として読めません');
    }
  }
  if (!isRecord(data) || data.format !== EXPORT_FORMAT) throw new Error('Web 版の書き出しではありません');
  if (!Number.isInteger(data.v) || data.v < 1) throw new Error('書き出しの版が読めません');
  if (data.v > EXPORT_VERSION) throw new Error(`新しい形式の書き出しです（v${data.v}）`);
  if (!Array.isArray(data.pages)) throw new Error('書き出しにページがありません');
  const pages = data.pages.map((p) => {
    if (!isRecord(p) || typeof p.pageId !== 'string' || !p.pageId) throw new Error('書き出しのページが壊れています');
    return deserializePage(p, p.pageId);
  });
  return {
    format: EXPORT_FORMAT,
    v: data.v,
    exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : '',
    app: typeof data.app === 'string' ? data.app : '',
    includesDemo: data.includesDemo === true,
    pages,
  };
}

/**
 * Every page of every device from Drive: listAllInkFiles() → download each → deserializePage → merge per page.
 * onProgress({ done, total }) after every download. Errors (offline, auth) propagate: the caller decides.
 * @param {{ listAllInkFiles: () => Promise<object[]>, download: (fileId: string) => Promise<string> }} drive
 * @returns {Promise<Map<string, object>>} pageId → PageDoc
 */
export async function collectDrivePages(drive, { onProgress } = {}) {
  if (!drive || typeof drive.listAllInkFiles !== 'function' || typeof drive.download !== 'function') {
    throw new TypeError('ink-export: drive must provide listAllInkFiles and download');
  }
  const listed = await drive.listAllInkFiles();
  const files = [];
  const seen = new Set();
  for (const f of Array.isArray(listed) ? listed : []) {
    if (!isRecord(f) || typeof f.id !== 'string' || !f.id || seen.has(f.id)) continue;
    const page = isRecord(f.appProperties) ? f.appProperties.page : undefined;
    if (typeof page !== 'string' || !page) continue;
    seen.add(f.id);
    files.push({ id: f.id, page });
  }
  const map = new Map();
  let done = 0;
  for (const f of files) {
    const text = await drive.download(f.id);
    mergeInto(map, toDoc(text, f.page));
    done++;
    if (typeof onProgress === 'function') onProgress({ done, total: files.length });
  }
  return map;
}

/**
 * Every 'page:<id>' of a kv (the local database of one mode).
 * @returns {Promise<Map<string, object>>} pageId → PageDoc
 */
export async function collectKvPages(kv) {
  if (!kv || typeof kv.keys !== 'function' || typeof kv.get !== 'function') {
    throw new TypeError('ink-export: kv must provide keys and get');
  }
  const map = new Map();
  for (const key of await kv.keys('page:')) {
    const id = key.slice('page:'.length);
    if (!id) continue;
    mergeInto(map, toDoc(await kv.get(key), id));
  }
  return map;
}

/**
 * All three sources merged per page → PageDoc[] in pageId order (every page, also the ones buildExport drops).
 * @param {{ drive?: object|null, kv: object, demoKv?: object|null, onProgress?: Function }} opts
 */
export async function collectAll({ drive = null, kv, demoKv = null, onProgress } = {}) {
  if (!kv) throw new TypeError('ink-export: kv is required');
  const map = new Map();
  for (const doc of (await collectKvPages(kv)).values()) mergeInto(map, doc);
  if (demoKv) for (const doc of (await collectKvPages(demoKv)).values()) mergeInto(map, doc);
  if (drive) for (const doc of (await collectDrivePages(drive, { onProgress })).values()) mergeInto(map, doc);
  return [...map.values()].sort(byPageId);
}
