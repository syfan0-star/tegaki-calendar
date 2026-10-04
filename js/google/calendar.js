// Google Calendar API v3 — thin REST client on top of http.js (raw API objects in, raw objects out).
// Normalization into CalInfo / CalEvent lives in js/data/calendar-source.js.

import { ApiError } from './http.js';

export const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

export const CALENDAR_LIST_FIELDS =
  'nextPageToken,items(id,summary,summaryOverride,colorId,backgroundColor,foregroundColor,primary,accessRole,selected,hidden,deleted,timeZone)';

/**
 * Fields of one event resource. organizer/guestsCanModify tell invitations (someone else's event: edits would
 * change only this user's copy) from own events; attendees(self,responseStatus) tells declined invitations.
 * organizer.email is requested only so the organizer object is always present: `self` is omitted when false,
 * and an object with no selected field left could be dropped from the partial response.
 */
export const EVENT_FIELDS =
  'id,status,summary,description,location,start,end,colorId,htmlLink,'
  + 'recurringEventId,eventType,locked,visibility,extendedProperties,'
  + 'organizer(email,self),guestsCanModify,attendees(self,responseStatus)';

export const EVENT_LIST_FIELDS = `nextPageToken,items(${EVENT_FIELDS})`;

/** Google event ids: base32hex lowercase (a-v, 0-9), 5–1024 characters. */
const EVENT_ID_RE = /^[a-v0-9]{5,1024}$/;
const BASE32HEX = '0123456789abcdefghijklmnopqrstuv';

/**
 * A new random event id (32 base32hex chars = 160 bits) for events.insert. Sending our own id makes the
 * insert idempotent: repeating it (automatic 5xx retry, the user tapping 保存 again after a lost response)
 * gets 409 instead of creating a second event.
 */
export function newEventId() {
  const c = globalThis.crypto;
  const n = 32;
  let out = '';
  if (c && typeof c.getRandomValues === 'function') {
    for (const b of c.getRandomValues(new Uint8Array(n))) out += BASE32HEX[b & 31]; // 256 % 32 = 0: no bias
  } else {
    for (let i = 0; i < n; i++) out += BASE32HEX[Math.floor(Math.random() * 32)];
  }
  return out;
}

/** True for a string Google accepts as a client-supplied event id. */
export function isValidEventId(id) {
  return typeof id === 'string' && EVENT_ID_RE.test(id);
}

/** Safety net against a server that keeps returning page tokens. */
const MAX_PAGES = 200;

const enc = encodeURIComponent;

/**
 * @param {{ request: (url: string, opts?: object) => Promise<any> }} http
 */
export function createCalendarApi(http) {
  if (!http || typeof http.request !== 'function') throw new TypeError('createCalendarApi: http.request is required');

  const eventsUrl = (calendarId) => `${CALENDAR_API}/calendars/${enc(requireId(calendarId, 'calendarId'))}/events`;
  const eventUrl = (calendarId, eventId) => `${eventsUrl(calendarId)}/${enc(requireId(eventId, 'eventId'))}`;

  /** Follows nextPageToken until exhausted (pages may be empty while a token is still set). */
  async function collectPages(url, baseQuery, itemsKey) {
    const out = [];
    const seen = new Set();
    let pageToken;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await http.request(url, { query: { ...baseQuery, pageToken } });
      const items = res && Array.isArray(res[itemsKey]) ? res[itemsKey] : [];
      out.push(...items);
      const next = res && typeof res.nextPageToken === 'string' ? res.nextPageToken : '';
      if (!next || seen.has(next)) break;
      seen.add(next);
      pageToken = next;
    }
    return out;
  }

  /** Raw calendarList items (all pages; hidden calendars are not returned by default). */
  function listCalendars() {
    return collectPages(`${CALENDAR_API}/users/me/calendarList`, { maxResults: 250, fields: CALENDAR_LIST_FIELDS }, 'items');
  }

  /**
   * Raw event items overlapping [timeMin, timeMax), recurring events expanded into instances.
   * @param {string} calendarId
   * @param {string|Date} timeMin RFC3339 with offset (Dates are sent as UTC ISO strings)
   * @param {string|Date} timeMax
   */
  function listEvents(calendarId, timeMin, timeMax) {
    return collectPages(eventsUrl(calendarId), {
      timeMin: toTimeParam(timeMin, 'timeMin'),
      timeMax: toTimeParam(timeMax, 'timeMax'),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 2500,
      showDeleted: false,
      // More attendees than this → Google returns only the user's own entry (enough to see a decline).
      maxAttendees: 1,
      fields: EVENT_LIST_FIELDS,
    }, 'items');
  }

  /** One raw event (EVENT_FIELDS). */
  function getEvent(calendarId, eventId) {
    return http.request(eventUrl(calendarId, eventId), { query: { fields: EVENT_FIELDS } });
  }

  /**
   * Creates an event; tags it with extendedProperties.private.tegaki = '1'. Returns the raw event.
   * The body carries a client-generated id (body.id when valid, else a new one), so the request is
   * idempotent: a 409 means an earlier attempt with this id already created it → that event is returned.
   */
  async function insertEvent(calendarId, body) {
    const json = { ...requireBody(body) };
    if (!isValidEventId(json.id)) json.id = newEventId();
    const ext = json.extendedProperties && typeof json.extendedProperties === 'object' ? json.extendedProperties : {};
    const priv = ext.private && typeof ext.private === 'object' ? ext.private : {};
    json.extendedProperties = { ...ext, private: { ...priv, tegaki: '1' } };
    const url = eventsUrl(calendarId);
    const post = (payload) => http.request(url, { method: 'POST', query: { sendUpdates: 'none' }, json: payload, idempotent: true });
    try {
      return await post(json);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 409) throw e;
    }
    const existing = await getEvent(calendarId, json.id);
    // The earlier event was deleted since (its id stays taken): create it again under a fresh id.
    if (existing && existing.status === 'cancelled') return post({ ...json, id: newEventId() });
    return existing;
  }

  /**
   * Partial update (PATCH): only the fields present in body change. On a recurring instance id this changes
   * only that occurrence.
   */
  function patchEvent(calendarId, eventId, body) {
    return http.request(eventUrl(calendarId, eventId), {
      method: 'PATCH',
      query: { sendUpdates: 'none' },
      json: requireBody(body),
    });
  }

  /** Deletes an event; 404 / 410 (already gone) count as success. */
  async function deleteEvent(calendarId, eventId) {
    try {
      await http.request(eventUrl(calendarId, eventId), {
        method: 'DELETE',
        query: { sendUpdates: 'none' },
        responseType: 'none',
      });
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 410)) return;
      throw e;
    }
  }

  /**
   * The primary calendar's id (= the account's email address), for login_hint.
   * Uses calendarList.get, which our calendarlist.readonly scope allows
   * (calendars.get would need calendar.calendars.readonly, which we do not request).
   * @returns {Promise<string|null>}
   */
  async function getPrimaryCalendarId() {
    const res = await http.request(`${CALENDAR_API}/users/me/calendarList/primary`, { query: { fields: 'id' } });
    return res && typeof res.id === 'string' && res.id ? res.id : null;
  }

  return { listCalendars, listEvents, getEvent, insertEvent, patchEvent, deleteEvent, getPrimaryCalendarId };
}

function requireId(id, name) {
  if (typeof id !== 'string' || !id) throw new TypeError(`calendar: ${name} must be a non-empty string`);
  return id;
}

function requireBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('calendar: body must be an object');
  return body;
}

function toTimeParam(value, name) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError(`calendar: ${name} is an invalid Date`);
    return value.toISOString();
  }
  if (typeof value === 'string' && value) return value;
  throw new TypeError(`calendar: ${name} must be an RFC3339 string or a Date`);
}
