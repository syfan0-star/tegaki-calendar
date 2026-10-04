import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCalendarApi, CALENDAR_API, EVENT_FIELDS, EVENT_LIST_FIELDS, CALENDAR_LIST_FIELDS, newEventId, isValidEventId,
} from '../js/google/calendar.js';
import { createHttp, ApiError } from '../js/google/http.js';

/** http fake: records requests and answers through `handler(url, opts, index)`. */
function fakeHttp(handler = () => ({})) {
  const calls = [];
  return {
    calls,
    async request(url, opts = {}) {
      calls.push({ url, ...opts });
      return handler(url, opts, calls.length - 1);
    },
  };
}

const HOLIDAY_ID = 'ja.japanese#holiday@group.v.calendar.google.com';

test('requires an http with request()', () => {
  assert.throws(() => createCalendarApi(null), TypeError);
  assert.throws(() => createCalendarApi({}), TypeError);
});

test('listCalendars pages through calendarList with a fields mask', async () => {
  const pages = [
    { items: [{ id: 'a' }], nextPageToken: 'p2' },
    { items: [], nextPageToken: 'p3' }, // empty page with a token: keep going
    { items: [{ id: 'b' }, { id: 'c' }] },
  ];
  const http = fakeHttp((url, opts, i) => pages[i]);
  const api = createCalendarApi(http);
  const items = await api.listCalendars();
  assert.deepEqual(items.map((x) => x.id), ['a', 'b', 'c']);
  assert.equal(http.calls.length, 3);
  for (const c of http.calls) {
    assert.equal(c.url, `${CALENDAR_API}/users/me/calendarList`);
    assert.equal(c.query.maxResults, 250);
    assert.equal(c.query.fields, CALENDAR_LIST_FIELDS);
    assert.ok(c.query.fields.startsWith('nextPageToken,'));
  }
  assert.equal(http.calls[0].query.pageToken, undefined);
  assert.equal(http.calls[1].query.pageToken, 'p2');
  assert.equal(http.calls[2].query.pageToken, 'p3');
});

test('pagination stops on a repeated token (no infinite loop)', async () => {
  const http = fakeHttp(() => ({ items: [{ id: 'x' }], nextPageToken: 'same' }));
  const items = await createCalendarApi(http).listCalendars();
  assert.equal(http.calls.length, 2);
  assert.equal(items.length, 2);
});

test('listEvents: exact query, encoded calendar id, all pages', async () => {
  const pages = [
    { items: [{ id: 'e1' }], nextPageToken: 'n1' },
    { items: [] , nextPageToken: 'n2' },
    { items: [{ id: 'e2' }] },
  ];
  const http = fakeHttp((url, opts, i) => pages[i]);
  const api = createCalendarApi(http);
  const items = await api.listEvents('me@example.com', '2026-10-04T00:00:00+09:00', '2026-10-11T00:00:00+09:00');
  assert.deepEqual(items.map((e) => e.id), ['e1', 'e2']);
  assert.equal(http.calls.length, 3);
  const first = http.calls[0];
  assert.equal(first.url, `${CALENDAR_API}/calendars/me%40example.com/events`);
  assert.equal(first.method, undefined); // GET
  assert.deepEqual(first.query, {
    timeMin: '2026-10-04T00:00:00+09:00',
    timeMax: '2026-10-11T00:00:00+09:00',
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 2500,
    showDeleted: false,
    maxAttendees: 1,
    fields: EVENT_LIST_FIELDS,
    pageToken: undefined,
  });
  assert.equal(http.calls[2].query.pageToken, 'n2');
  assert.equal(EVENT_FIELDS,
    'id,status,summary,description,location,start,end,colorId,htmlLink,recurringEventId,eventType,locked,visibility,'
    + 'extendedProperties,organizer(email,self),guestsCanModify,attendees(self,responseStatus)');
  assert.equal(EVENT_LIST_FIELDS, `nextPageToken,items(${EVENT_FIELDS})`);
});

test('listEvents encodes "#" in holiday ids and accepts Dates', async () => {
  const http = fakeHttp(() => ({ items: [] }));
  const api = createCalendarApi(http);
  await api.listEvents(HOLIDAY_ID, new Date('2026-10-03T15:00:00Z'), new Date('2026-10-04T15:00:00Z'));
  assert.equal(http.calls[0].url, `${CALENDAR_API}/calendars/ja.japanese%23holiday%40group.v.calendar.google.com/events`);
  assert.equal(http.calls[0].query.timeMin, '2026-10-03T15:00:00.000Z');
});

test('listEvents rejects bad arguments before any request', async () => {
  const http = fakeHttp();
  const api = createCalendarApi(http);
  assert.throws(() => api.listEvents('', 'a', 'b'), TypeError);
  assert.throws(() => api.listEvents('x', new Date(NaN), 'b'), TypeError);
  assert.throws(() => api.listEvents('x', 'a', null), TypeError);
  assert.equal(http.calls.length, 0);
});

test('newEventId: 32 base32hex chars, unique; isValidEventId', () => {
  const ids = new Set(Array.from({ length: 200 }, () => newEventId()));
  assert.equal(ids.size, 200);
  for (const id of ids) {
    assert.match(id, /^[a-v0-9]{32}$/);
    assert.equal(isValidEventId(id), true);
  }
  for (const bad of ['', 'abcd', 'ABCDEFGH', 'xyz12345', 'has-dash1', null, 42, undefined]) assert.equal(isValidEventId(bad), false, String(bad));
  assert.equal(isValidEventId('0123456789abcdefuv'), true);
});

test('insertEvent: POST, sendUpdates=none, tegaki private property merged', async () => {
  const http = fakeHttp((url, opts) => ({ ...opts.json }));
  const api = createCalendarApi(http);
  const body = {
    summary: '会議',
    start: { dateTime: '2026-10-05T10:00:00+09:00', timeZone: 'Asia/Tokyo' },
    end: { dateTime: '2026-10-05T11:00:00+09:00', timeZone: 'Asia/Tokyo' },
    extendedProperties: { private: { other: 'x' }, shared: { s: '1' } },
  };
  const res = await api.insertEvent('primary', body);
  const call = http.calls[0];
  assert.match(call.json.id, /^[a-v0-9]{32}$/, 'client-generated id makes the insert idempotent');
  assert.equal(res.id, call.json.id);
  assert.equal('id' in body, false, 'caller body untouched');
  assert.equal(call.idempotent, true);
  assert.equal(call.url, `${CALENDAR_API}/calendars/primary/events`);
  assert.equal(call.method, 'POST');
  assert.deepEqual(call.query, { sendUpdates: 'none' });
  assert.deepEqual(call.json.extendedProperties, { private: { other: 'x', tegaki: '1' }, shared: { s: '1' } });
  assert.equal(call.json.summary, '会議');
  assert.deepEqual(body.extendedProperties.private, { other: 'x' }); // caller's object untouched

  await api.insertEvent('primary', { summary: 'x', start: {}, end: {} });
  assert.deepEqual(http.calls[1].json.extendedProperties, { private: { tegaki: '1' } });
  assert.notEqual(http.calls[1].json.id, call.json.id);

  // A caller-supplied valid id is kept (the same id on every retry of one save); an invalid one is replaced.
  await api.insertEvent('primary', { summary: 'x', id: 'abc0123456789vuv' });
  assert.equal(http.calls[2].json.id, 'abc0123456789vuv');
  await api.insertEvent('primary', { summary: 'x', id: 'Not-Valid' });
  assert.match(http.calls[3].json.id, /^[a-v0-9]{32}$/);
});

test('insertEvent: 409 (an earlier attempt already created it) → that event, no duplicate', async () => {
  const stored = { id: 'abc0123456789vuv', status: 'confirmed', summary: '会議' };
  const http = fakeHttp((url, opts) => {
    if (opts.method === 'POST') throw new ApiError({ status: 409, reason: 'duplicate' });
    return stored;
  });
  const api = createCalendarApi(http);
  assert.equal(await api.insertEvent('team#1', { summary: '会議', id: 'abc0123456789vuv' }), stored);
  assert.equal(http.calls.length, 2);
  assert.equal(http.calls[1].url, `${CALENDAR_API}/calendars/team%231/events/abc0123456789vuv`);
  assert.equal(http.calls[1].method, undefined); // GET
  assert.deepEqual(http.calls[1].query, { fields: EVENT_FIELDS });
});

test('insertEvent: 409 for an event deleted since → created again under a fresh id', async () => {
  let posts = 0;
  const http = fakeHttp((url, opts) => {
    if (opts.method === 'POST') {
      posts++;
      if (posts === 1) throw new ApiError({ status: 409, reason: 'duplicate' });
      return { ...opts.json, status: 'confirmed' };
    }
    return { id: 'abc0123456789vuv', status: 'cancelled' };
  });
  const api = createCalendarApi(http);
  const res = await api.insertEvent('primary', { summary: 'x', id: 'abc0123456789vuv' });
  assert.equal(posts, 2);
  assert.notEqual(res.id, 'abc0123456789vuv');
  assert.match(res.id, /^[a-v0-9]{32}$/);
});

test('insertEvent: other errors propagate', async () => {
  const http = fakeHttp(() => { throw new ApiError({ status: 403, reason: 'requiredAccessLevel' }); });
  const api = createCalendarApi(http);
  await assert.rejects(api.insertEvent('primary', { summary: 'x' }), (e) => e.reason === 'requiredAccessLevel');
  assert.equal(http.calls.length, 1);
  await assert.rejects(api.insertEvent('primary', null), TypeError);
});

test('getEvent: GET with the event field mask, encoded ids', async () => {
  const http = fakeHttp(() => ({ id: 'e/1' }));
  const api = createCalendarApi(http);
  assert.deepEqual(await api.getEvent('me@example.com', 'e/1'), { id: 'e/1' });
  assert.equal(http.calls[0].url, `${CALENDAR_API}/calendars/me%40example.com/events/e%2F1`);
  assert.deepEqual(http.calls[0].query, { fields: EVENT_FIELDS });
  assert.throws(() => api.getEvent('x', ''), TypeError);
});

test('end to end: a POST 503 is retried only because the insert carries its own id', async () => {
  const bodies = [];
  let n = 0;
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    n++;
    if (n === 1) return new Response(JSON.stringify({ error: { code: 503, errors: [{ reason: 'backendError' }] } }), { status: 503 });
    return new Response(JSON.stringify({ ...JSON.parse(init.body) }), { status: 200 });
  };
  const http = createHttp({ getToken: () => 't', fetchImpl, sleep: async () => {} });
  const res = await createCalendarApi(http).insertEvent('primary', { summary: 'x' });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].id, bodies[1].id, 'the retry repeats the same id → Google answers 409, never a 2nd event');
  assert.equal(res.id, bodies[0].id);
});

test('patchEvent: uppercase PATCH, encoded ids, sendUpdates=none', async () => {
  const http = fakeHttp((url, opts) => ({ id: 'ev_20261004T010000Z', ...opts.json }));
  const api = createCalendarApi(http);
  const body = { summary: 'x', start: { date: '2026-10-04', dateTime: null, timeZone: null } };
  await api.patchEvent('team#1@group.calendar.google.com', 'ev/1 2', body);
  const call = http.calls[0];
  assert.equal(call.method, 'PATCH');
  assert.equal(call.url, `${CALENDAR_API}/calendars/team%231%40group.calendar.google.com/events/ev%2F1%202`);
  assert.deepEqual(call.query, { sendUpdates: 'none' });
  assert.deepEqual(call.json, body);
  assert.throws(() => api.patchEvent('c', '', body), TypeError);
  assert.throws(() => api.patchEvent('c', 'e', null), TypeError);
});

test('deleteEvent: DELETE; 404 and 410 count as success; other errors propagate', async () => {
  let reply = null;
  const http = fakeHttp(() => {
    if (reply) throw reply;
    return null;
  });
  const api = createCalendarApi(http);
  await api.deleteEvent('primary', 'abc');
  assert.equal(http.calls[0].method, 'DELETE');
  assert.equal(http.calls[0].url, `${CALENDAR_API}/calendars/primary/events/abc`);
  assert.deepEqual(http.calls[0].query, { sendUpdates: 'none' });
  assert.equal(http.calls[0].responseType, 'none');

  reply = new ApiError({ status: 410, reason: 'deleted' });
  await assert.doesNotReject(api.deleteEvent('primary', 'abc'));
  reply = new ApiError({ status: 404, reason: 'notFound' });
  await assert.doesNotReject(api.deleteEvent('primary', 'abc'));
  reply = new ApiError({ status: 403, reason: 'requiredAccessLevel' });
  await assert.rejects(api.deleteEvent('primary', 'abc'), (e) => e.reason === 'requiredAccessLevel');
  reply = new ApiError({ status: 0, reason: 'network' });
  await assert.rejects(api.deleteEvent('primary', 'abc'), (e) => e.status === 0);
});

test('getPrimaryCalendarId uses calendarList/primary (allowed by calendarlist.readonly)', async () => {
  const http = fakeHttp(() => ({ id: 'me@example.com' }));
  const api = createCalendarApi(http);
  assert.equal(await api.getPrimaryCalendarId(), 'me@example.com');
  assert.equal(http.calls[0].url, `${CALENDAR_API}/users/me/calendarList/primary`);
  assert.deepEqual(http.calls[0].query, { fields: 'id' });
  const empty = createCalendarApi(fakeHttp(() => ({})));
  assert.equal(await empty.getPrimaryCalendarId(), null);
});

test('end to end through http.js: final URL string', async () => {
  const urls = [];
  const fetchImpl = async (url, init) => {
    urls.push({ url, init });
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  };
  const http = createHttp({ getToken: () => 't', fetchImpl, sleep: async () => {} });
  const api = createCalendarApi(http);
  await api.listEvents(HOLIDAY_ID, '2026-10-04T00:00:00+09:00', '2026-10-05T00:00:00+09:00');
  const u = new URL(urls[0].url);
  assert.equal(u.pathname, '/calendar/v3/calendars/ja.japanese%23holiday%40group.v.calendar.google.com/events');
  assert.equal(u.hash, '');
  assert.equal(u.searchParams.get('timeMin'), '2026-10-04T00:00:00+09:00');
  assert.equal(u.searchParams.get('singleEvents'), 'true');
  assert.equal(u.searchParams.get('showDeleted'), 'false');
  assert.equal(u.searchParams.get('maxResults'), '2500');
  assert.equal(u.searchParams.has('pageToken'), false);
  assert.equal(urls[0].init.cache, 'no-store');

  await api.patchEvent('primary', 'e1', { summary: 'x' });
  assert.equal(urls[1].init.method, 'PATCH');
  assert.equal(urls[1].init.headers['Content-Type'], 'application/json; charset=UTF-8');
  assert.equal(new URL(urls[1].url).search, '?sendUpdates=none');
});
