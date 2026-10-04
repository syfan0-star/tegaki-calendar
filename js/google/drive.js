// Google Drive API v3 — appDataFolder client for ink files (on top of http.js).
//
// Notes (see docs/SPEC.md §4 D for how ink-store uses this):
// - appDataFolder files cannot be trashed: remove() is a permanent DELETE.
// - create() uses a pre-generated id so a retried create returns 409 instead of a duplicate file; the 409
//   path then writes the NEW content into that file (an earlier attempt may have uploaded older content).
// - Drive v3 has no If-Match; correctness comes from one file per page per device.

import { ApiError } from './http.js';

export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
export const META_FIELDS = 'id,name,createdTime,modifiedTime,version,md5Checksum,size,appProperties';

const ID_POOL_SIZE = 20;
const MAX_PAGES = 200;
const enc = encodeURIComponent;

/** Escapes a value for a single-quoted Drive query string literal (\ → \\, ' → \'). */
export function escapeQueryValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * @param {{ request: (url: string, opts?: object) => Promise<any> }} http
 */
export function createDriveApi(http) {
  if (!http || typeof http.request !== 'function') throw new TypeError('createDriveApi: http.request is required');

  const fileUrl = (fileId) => `${DRIVE_API}/files/${enc(requireId(fileId))}`;
  let idPool = [];
  let idRefill = null; // in-flight generateIds request shared by concurrent callers

  /** All files (any device) tagged appProperties.page = pageId, oldest first, all result pages. */
  async function listPageFiles(pageId) {
    if (typeof pageId !== 'string' || !pageId) throw new TypeError('drive: pageId must be a non-empty string');
    const query = {
      spaces: 'appDataFolder',
      q: `appProperties has { key='page' and value='${escapeQueryValue(pageId)}' }`,
      fields: `nextPageToken,files(${META_FIELDS})`, // without nextPageToken here, paging silently stops
      pageSize: 1000,
      orderBy: 'createdTime',
    };
    const files = [];
    const seen = new Set();
    let pageToken;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await http.request(`${DRIVE_API}/files`, { query: { ...query, pageToken } });
      if (res && Array.isArray(res.files)) files.push(...res.files);
      const next = res && typeof res.nextPageToken === 'string' ? res.nextPageToken : '';
      if (!next || seen.has(next)) break;
      seen.add(next);
      pageToken = next;
    }
    return files;
  }

  /** META_FIELDS of one file. */
  function getMeta(fileId) {
    return http.request(fileUrl(fileId), { query: { fields: META_FIELDS } });
  }

  /** File content as text. */
  function download(fileId) {
    return http.request(fileUrl(fileId), { query: { alt: 'media' }, responseType: 'text' });
  }

  /** One pre-generated file id from a pool (refilled 20 at a time). */
  async function generateId() {
    while (idPool.length === 0) {
      if (!idRefill) {
        idRefill = http.request(`${DRIVE_API}/files/generateIds`, {
          query: { count: ID_POOL_SIZE, space: 'appDataFolder', type: 'files' },
        }).then((res) => {
          const ids = res && Array.isArray(res.ids) ? res.ids.filter((id) => typeof id === 'string' && id) : [];
          if (ids.length === 0) throw new ApiError({ status: 200, reason: 'noIds', body: res, message: 'Drive generateIds returned no ids' });
          idPool.push(...ids);
        }).finally(() => {
          idRefill = null;
        });
      }
      await idRefill;
    }
    return idPool.shift();
  }

  /**
   * Creates a JSON file in appDataFolder (multipart/related upload).
   * With a pre-generated id, a 409 means an earlier attempt (whose response was lost) already created it —
   * possibly with older content — so the content is written again with update(id, text) and the fresh
   * metadata (new md5Checksum) is returned. Safe: the id was generated for this caller's own file.
   * @param {{ id?: string, name: string, appProperties?: Record<string,string> }} meta
   * @param {string} text file content (JSON text; non-strings are JSON-encoded)
   */
  async function create({ id, name, appProperties } = {}, text) {
    if (typeof name !== 'string' || !name) throw new TypeError('drive.create: name must be a non-empty string');
    const metadata = { name, parents: ['appDataFolder'], mimeType: 'application/json' };
    if (id !== undefined && id !== null) metadata.id = requireId(id);
    if (appProperties && typeof appProperties === 'object') metadata.appProperties = { ...appProperties };
    const content = typeof text === 'string' ? text : JSON.stringify(text ?? null);
    const { boundary, body } = buildMultipart(metadata, content);
    try {
      return await http.request(`${DRIVE_UPLOAD_API}/files`, {
        method: 'POST',
        query: { uploadType: 'multipart', fields: META_FIELDS },
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        rawBody: body,
        idempotent: !!metadata.id, // with an id, a repeat yields 409 (handled below), never a second file
      });
    } catch (e) {
      if (metadata.id && e instanceof ApiError && e.status === 409) return update(metadata.id, content);
      throw e;
    }
  }

  /** Replaces a file's content (PATCH uploadType=media). Returns META_FIELDS. */
  function update(fileId, text) {
    const content = typeof text === 'string' ? text : JSON.stringify(text ?? null);
    return http.request(`${DRIVE_UPLOAD_API}/files/${enc(requireId(fileId))}`, {
      method: 'PATCH',
      query: { uploadType: 'media', fields: META_FIELDS },
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      rawBody: content,
    });
  }

  /** Permanently deletes a file; 404 (already gone) is success. */
  async function remove(fileId) {
    try {
      await http.request(fileUrl(fileId), { method: 'DELETE', responseType: 'none' });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return;
      throw e;
    }
  }

  return { listPageFiles, getMeta, download, generateId, create, update, remove };
}

function requireId(id) {
  if (typeof id !== 'string' || !id) throw new TypeError('drive: file id must be a non-empty string');
  return id;
}

/** multipart/related body (RFC 2387) with CRLF line endings: metadata part first, then the media part. */
export function buildMultipart(metadata, content) {
  let boundary = randomBoundary();
  while (content.includes(boundary)) boundary = randomBoundary();
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    'Content-Type: application/json',
    '',
    content,
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return { boundary, body };
}

function randomBoundary() {
  const c = globalThis.crypto;
  let hex = '';
  if (c && typeof c.getRandomValues === 'function') {
    for (const b of c.getRandomValues(new Uint8Array(16))) hex += b.toString(16).padStart(2, '0');
  } else {
    hex = `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  }
  return `tegaki_${hex}`;
}
