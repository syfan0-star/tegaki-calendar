# 手書きカレンダー (tegaki-calendar) — 実装仕様書

This is the binding contract between modules. Every module MUST implement exactly the exported
names and data shapes below. If you need something not listed, add it as a non-exported helper
inside your own file. Do not edit files owned by another module.

## 0. Product summary

An iPad web app (Safari + home-screen standalone PWA) that:

- shows the user's Google Calendar in **day / week / month** views,
- lets the user **handwrite with Apple Pencil** freely on every page (each view+date is its own "page",
  like a paper planner: a monthly page, weekly pages, daily pages),
- saves the handwriting as vector strokes to **Google Drive appDataFolder** (local IndexedDB first,
  then synced; conflict-free merge between devices),
- turns handwriting into Google Calendar **events**: (a) the 予定 tool — drag over a time range with
  the Pencil, a dialog opens with the time prefilled, the title is written with the Pencil into a
  normal `<input>` (iPadOS Scribble converts it to text); (b) lasso-select existing ink →
  「予定にする」 → same dialog prefilled from the selection's position, with a picture of the selected
  ink shown for reference, optionally erasing the ink afterwards,
- lets the user edit/delete events (finger tap on an event),
- works without Google (お試しモード / demo mode) with sample events and local-only ink.

All UI text is **Japanese**. Timezone = the device's local timezone. No build step, no npm
dependencies: plain ES modules loaded by `<script type="module" src="js/main.js">`.
Hosted at `https://syfan0-star.github.io/tegaki-calendar/` (and `http://localhost:8000/` for dev).

Target: iPadOS 17+ Safari (WebKit). Must also work with a mouse in desktop Chromium/Safari for
development (enable 「指・マウスでも書く」).

## 1. File layout and ownership

```
index.html                 F2a
manifest.webmanifest       F2a
sw.js                      F2a
styles/app.css             F2b  (chrome: header, toolbar, dialogs, banners, welcome, base/reset)
styles/views.css           F1   (page, grid, event boxes, sticky header, month cells)
icons/*                    (lead)
js/config.js               C
js/boot-watchdog.js        F2a  (classic script loaded before the module: 再読み込み rescue if main.js never starts)
js/main.js                 F2a  (composition root; the only module that touches everything)
js/state.js                F2a  (settings load/save + tiny observable store)
js/util/date.js            A
js/util/holidays-jp.js     A
js/util/idb.js             D
js/views/page-geometry.js  A
js/views/event-layout.js   A
js/views/day-view.js       F1
js/views/week-view.js      F1
js/views/month-view.js     F1
js/views/view-common.js    F1
js/google/http.js          C
js/google/auth.js          C
js/google/calendar.js      C
js/google/drive.js         C
js/data/calendar-source.js C
js/data/ink-store.js       D
js/ink/model.js            B
js/ink/geometry.js         B
js/ink/render.js           B
js/ink/surface.js          E
js/ui/header.js            F2b
js/ui/toolbar.js           F2b
js/ui/event-dialog.js      F2b
js/ui/settings.js          F2b
js/ui/selection-menu.js    F2b
js/ui/toast.js             F2b
js/ui/dom.js               F2b  (tiny helpers: h(tag, attrs, ...children), clear(el), svgIcon(name))
tests/*.test.mjs           each owner tests their own modules (node --test); tests/app-shell.test.mjs: sw.js / manifest / index.html
package.json               (lead)  "type":"module", scripts.test = "TZ=Asia/Tokyo node --test 'tests/*.test.mjs'" (Node 24 treats a bare directory as a module path)  (run: export PATH="$HOME/.local/node/bin:$PATH"; npm test  — or TZ=Asia/Tokyo node --test tests/xxx.test.mjs)
```

Rules for all code:
- ES2022, no TypeScript, JSDoc typedefs welcome. 2-space indent, single quotes, semicolons.
- Pure modules (A, B, C-except-auth-redirect, D) must be importable in Node 24 for tests:
  no top-level access to `window`, `document`, `localStorage`, `indexedDB`; take them as parameters
  or access lazily inside functions with `typeof` guards.
- Never log access tokens.
- Dates: always `Date` objects in local time inside the app. Strings only at API/storage boundaries.

## 2. Shared data shapes

```js
/** Normalized calendar (CalInfo) */
{ id: string, name: string, color: string /* '#rrggbb' bg */, textColor: string,
  primary: boolean, writable: boolean /* accessRole owner|writer */, holiday: boolean,
  selected: boolean /* Google's 'selected' flag (shown in Google's UI) */ }

/** Normalized event (CalEvent) */
{ id: string, calendarId: string, title: string, description: string, location: string,
  allDay: boolean,
  start: Date,   // timed: exact start. allDay: local midnight of first day
  end: Date,     // timed: exact end.   allDay: local midnight of the day AFTER the last day (exclusive)
  color: string, textColor: string, htmlLink: string,
  recurring: boolean, editable: boolean }

/** EventInput — what the dialog produces / what create/update take */
{ title: string, description: string, location: string, allDay: boolean, start: Date, end: Date }
// same start/end conventions as CalEvent (allDay end exclusive)

/** Stroke — immutable once created */
{ id: string, tool: 'pen' | 'highlighter', color: string /* '#rrggbb' */, size: number /* base width, logical units */,
  pts: number[] /* flat [x0,y0,p0, x1,y1,p1, ...]; x,y logical units rounded to 0.1; p pressure 0..1 rounded to 0.01 */,
  t: number /* created ms epoch */ }

/** PageDoc — one per page, JSON-serializable */
{ v: 1, pageId: string, strokes: { [id: string]: Stroke }, deleted: { [id: string]: number /* ms */ }, updatedAt: number }

/** Ink op (undo/redo unit) */
{ type: 'add', strokes: Stroke[] } | { type: 'remove', strokes: Stroke[] } | { type: 'batch', ops: Op[] }

/** Logical rect */
{ minX, minY, maxX, maxY }
```

Settings (owned by F2's state.js, persisted in localStorage key `tegaki.settings.v1`):
```js
{ weekStart: 0 /* 0=Sun, 1=Mon */, allowFinger: false, eraseInkAfterConvert: true,
  hiddenCalendarIds: [] /* calendars the user unchecked */, defaultCalendarId: null /* null → primary */,
  demo: false, tool: 'pen', penColor: '#1f2937', penSize: 'medium', hlColor: '#fde047',
  view: 'week', date: 'YYYY-MM-DD' /* last route */ }
```

## 3. Page geometry (module A: js/views/page-geometry.js)

Each page has a fixed **logical coordinate system** (units "lu"), origin top-left. The page is
rendered at `scale = pageCssWidth / W` (fit mode `width`: day/week, the viewport scrolls vertically)
or `scale = min(vw/W, vh/H)` (fit `contain`: month, centered, no scroll). Grid, events and ink all
live in this coordinate system so ink stays aligned regardless of iPad model or orientation.

```js
export const VIEWS = ['day', 'week', 'month'];
export const PAGE_SPECS = {
  day:   { W: 1000, H: 2400, gutter: 72, hourH: 100, timelineRight: 660, fit: 'width' },
  // day: time labels in [0,gutter); timeline column [gutter, timelineRight); free memo area [timelineRight, W)
  week:  { W: 1400, H: 1920, gutter: 64, hourH: 80, cols: 7, fit: 'width' },
  // week: col i spans [gutter + i*colW, gutter + (i+1)*colW), colW = (W - gutter)/7
  month: { W: 1400, H: 1050, cols: 7, rows: 6, fit: 'contain' },
  // month: cell (r,c) = x c*200, y r*175, 200x175
};
export function pageIdFor(view, date, weekStart)  // 'd-2026-10-04' | 'w-2026-09-27' (week start date) | 'm-2026-10'
                                                  // month with Monday start: 'm1-2026-10' (weekStart moves every date of
                                                  // the week/month grids, so ink of one setting never shows on the other's grid)
export function rangeFor(view, date, weekStart)   // { start: Date, end: Date /*exclusive*/, days: Date[] }
                                                  // day: 1 day; week: 7 days from startOfWeek; month: 42 days from monthGridStart
                                                  // month also returns { monthStart: Date } (1st of the month)
export function navigate(view, date, delta)        // day ±1 day, week ±7 days, month ±1 month (returns 1st of month)
export function minutesToY(view, minutes)          // day/week only: minutes * hourH / 60
export function yToMinutes(view, y)                // inverse, clamped [0, 1440]
export function columnRect(view, col)              // day: col 0 → { x: gutter, w: timelineRight-gutter }; week: per day col
export function xToColumn(view, x)                 // day: 0 if in timeline, -1 otherwise (gutter or memo); week: 0..6 or -1 (gutter)
export function monthCellRect(row, col)            // { x, y, w, h }
export function monthCellAt(x, y)                  // { row, col } or null
export function rectToEventRange(view, range, rect)
  // Converts a logical rect (lasso bbox or 予定-tool drag rect) into { start: Date, end: Date, allDay: boolean }.
  // day/week: column = xToColumn(center x) (day: if -1 use col 0); start = round15(yToMinutes(minY)),
  //   end = round15(yToMinutes(maxY)) (nearest 15 min: a drag ending a few lu past 15:00 is still 15:00);
  //   if end - start < 30 → end = start + 60 (tap-like/small) ; clamp end ≤ 1440 (start < end always).
  //   If rect height < 12 lu (a tap) → start = floor30(minutesAtCenterY), end = start + 60.
  // month: cell at center → allDay event on that date: start = that day 00:00, end = next day 00:00.
  //   (Week: if column is -1 use the column nearest to center.)
export function snapEventRect(view, range, rect)
  // Returns the logical rect that the resulting event would occupy (for the live preview while dragging
  // with the 予定 tool): day/week → { minX: colX, maxX: colX+colW, minY: minutesToY(start), maxY: minutesToY(end) };
  // month → the cell rect.
export function pointToSlot(view, range, x, y)     // { date: Date, minutes: number|null } | null  (month → minutes null)
```

## 4. Module APIs

### A. js/util/date.js
```js
export const WEEKDAYS_JA = ['日','月','火','水','木','金','土'];
export function startOfDay(d)            // new Date (local midnight)
export function addDays(d, n)            // calendar-day arithmetic via setDate (DST-safe)
export function addMonths(d, n)          // returns 1st of the resulting month at 00:00
export function startOfWeek(d, weekStart)
export function startOfMonth(d)
export function monthGridStart(d, weekStart)   // startOfWeek(startOfMonth(d))
export function isSameDay(a, b)
export function daysBetween(a, b)        // whole calendar days from a to b (b - a), DST-safe
export function toYMD(d)                 // 'YYYY-MM-DD'
export function parseYMD(s)              // local midnight Date; invalid → null
export function toHM(d)                  // 'HH:MM' 24h zero-padded (for <input type=time>)
export function parseHM(s)               // minutes or null
export function minutesOfDay(d)
export function atMinutes(day, minutes)  // startOfDay(day) + minutes (1440 → next day 00:00)
export function toRFC3339(d)             // '2026-10-04T09:00:00+09:00' with the local offset
export function formatDateJa(d)          // '2026年10月4日(日)'
export function formatMonthJa(d)         // '2026年10月'
export function formatWeekRangeJa(start, endExclusive) // '2026年9月27日〜10月3日' (year shown once; cross-year → '2026年12月28日〜2027年1月3日')
export function formatTimeJa(d)          // '9:00'
export function formatTimeRangeJa(start, end) // '9:00〜10:30'
export function roundMinutes(m, step, mode)   // mode 'floor' | 'ceil' | 'round'
export function clamp(v, lo, hi)
```
### A. js/util/holidays-jp.js
```js
export function getHolidayName(dateOrYMD)          // '元日' | ... | '振替休日' | '国民の休日' | null
export function getHolidaysInRange(start, endExclusive) // [{ date: 'YYYY-MM-DD', name }] sorted
```
Rule-based (2000–2099), cached per year. Must match 内閣府 lists for 2025–2027 exactly (tests).

### A. js/views/event-layout.js
```js
export function eventsOnDay(events, day)      // events overlapping [day, day+1); sorted: allDay first, then start, then longer first, then title
export function layoutTimedEvents(events, day)
  // timed events overlapping that day → [{ event, startMin, endMin, col, cols }] where startMin/endMin are clipped to [0,1440],
  // endMin ≥ startMin + 15 (visual minimum); overlapping clusters get columns (greedy, by start then longer first);
  // cols = number of columns in that event's cluster.
export function splitAllDay(events)           // { allDay: CalEvent[], timed: CalEvent[] }
export function allDayRowsForRange(events, days)
  // For the week header: lay multi-day all-day (and timed events spanning ≥ 24h are NOT included; only allDay)
  // events into rows: [{ event, startCol, endCol /*inclusive*/, row }]; days = Date[] of the week.
```

### B. js/ink/model.js
```js
export function emptyPage(pageId)
export function newStrokeId()                 // crypto.randomUUID() if available, else time+random base36
export function makeStroke({ tool, color, size, pts, t })  // assigns id, rounds pts
export function addStrokes(doc, strokes)      // returns new doc; ignores strokes whose id is tombstoned
export function removeStrokes(doc, ids, now)  // returns new doc with tombstones
export function mergePages(a, b)              // union strokes, union tombstones (max time), drop tombstoned; updatedAt = max
export function liveStrokes(doc)              // Stroke[]: highlighters first, then pens; within each by t then id
export function cloneStrokes(strokes, { dx = 0, dy = 0, color } = {}) // new ids, translated, optional recolor, new t keeps order (t = original t)
export function applyOp(doc, op, now)         // add → addStrokes; remove → removeStrokes(ids); batch → sequential
export function invertOp(op)                  // add S → remove S ; remove S → add cloneStrokes(S) ; batch → batch(reversed inverted)
export function sameContent(a, b)             // same set of live ids and tombstone ids
export function serializePage(doc)            // JSON string
export function deserializePage(json, pageId) // tolerant parse/validate; drops malformed strokes; returns PageDoc (emptyPage on garbage)
```
### B. js/ink/geometry.js
```js
export function strokeBBox(stroke)            // includes half the max width
export function unionBBox(boxes)              // null for empty
export function bboxIntersects(a, b)
export function pointInPolygon(x, y, poly)    // poly flat [x,y,...]; even-odd
export function strokeInLasso(stroke, poly, bounds?) // true if ≥ 50% of the stroke's points are inside (or bbox center inside for 1-point strokes)
                                              // bounds: the polygon's precomputed bounding rect (optional, speeds up big lassos)
export function strokeHitsCircle(stroke, cx, cy, r) // distance from any segment ≤ r + size/2
export function segmentDistance(px, py, ax, ay, bx, by)
export function translateRect(rect, dx, dy)
```
### B. js/ink/render.js
```js
export const PEN_COLORS = ['#1f2937', '#2563eb', '#dc2626', '#16a34a', '#ea580c', '#7c3aed'];
export const HIGHLIGHTER_COLORS = ['#fde047', '#f9a8d4', '#86efac', '#93c5fd'];
export const PEN_SIZES = { thin: 2, medium: 3.5, thick: 6 };   // base width in lu
export const HIGHLIGHTER_SIZE = 18;
export const HIGHLIGHTER_ALPHA = 0.35;
export function widthAt(stroke, pressure)     // pen: size * (0.4 + 0.9 * p) ; highlighter: size
export function strokeOutline(stroke)         // pen: closed polygon flat array (variable width, smoothed); pure, testable
export function drawStroke(ctx, stroke)       // ctx already scaled to logical units; pen → fill outline; highlighter → round-cap path with alpha
export function drawStrokes(ctx, strokes)
export function drawLiveStroke(ctx, partial)  // same visual as drawStroke for an in-progress stroke {tool,color,size,pts}
```

### C. js/config.js
```js
export const APP_VERSION = '1.0.2';
export const GOOGLE_CLIENT_ID = '';  // filled in after Google Cloud setup ('' → Google features disabled, demo only)
export const SCOPES = { events: '.../calendar.events', calList: '.../calendar.calendarlist.readonly', appdata: '.../drive.appdata' }; // full URLs, see §6
export const PAGES_ORIGIN_PATH = 'https://syfan0-star.github.io/tegaki-calendar/';
export function redirectUri(loc = globalThis.location) // exact registered string, see §6
export function isGoogleConfigured()   // GOOGLE_CLIENT_ID ends with '.apps.googleusercontent.com'
```
### C. js/google/http.js
```js
export class AuthRequiredError extends Error {}           // no token / 401
export class ApiError extends Error { /* status, reason, body */ }
export function createHttp({ getToken, onAuthError, fetchImpl = globalThis.fetch, sleep })
  → { request(url, { method='GET', query, headers, body, json, rawBody, responseType='json'|'text'|'none' }) }
  // adds Authorization: Bearer; query object → URLSearchParams; json → JSON body + content-type
  // retries (max 4, exponential backoff 0.5s,1s,2s,4s + jitter): 429 and 403 rateLimitExceeded/userRateLimitExceeded
  //   always; 500/502/503/504 and network failures (status 0, up to 2) only for GET/HEAD/PUT/PATCH/DELETE or
  //   opts.idempotent: true (a 5xx may come after Google did the work)
  // 401 → onAuthError(token) then throw AuthRequiredError; no token → throw AuthRequiredError without fetching
  // network TypeError or a broken body stream → throw ApiError(status 0, reason 'network')
```
### C. js/google/auth.js  (see §6 for the flow)
```js
export function createAuth({ clientId, scopes, redirectUri, storage, location, history, now = Date.now })
  → {
    handleRedirect(),   // → { status: 'none' | 'success' | 'error', error?: string, returnState?: object }
                        //   parses location.hash, validates state, stores token, cleans the URL (history.replaceState)
    getToken(),         // access token string if > 60 s left, else null
    isSignedIn(),
    hasEverSignedIn(),
    expiresAt(),        // ms or null
    grantedScopes(),    // string[]
    hasScopes(list),    // boolean
    signIn({ silent = false, returnState = null, loginHint }),  // builds URL and location.assign(); reads the stored
                        //   pending state (and lastSilent) back first → throws 'storage unavailable' without navigating
    signOut({ revoke = true, timeoutMs = 3000 }), // clear storage, then revoke (keepalive; awaited ≤ timeoutMs).
                        //   NOTE: revoke ends the grant for the whole account → every device must log in again
    clearToken(token?), // 401: expire the token (exp 0) but keep its scopes; with `token` only if it is still the stored one
    setLoginHint(email), // remembered for silent re-auth
    loginHint(),        // string|null
    canTrySilent(),     // hasEverSignedIn() && last silent attempt > 5 min ago
    lastError()         // last handleRedirect error code or null
  }
```
### C. js/google/calendar.js
```js
export function createCalendarApi(http) → {
  listCalendars(),                         // raw calendarList items (all pages)
  listEvents(calendarId, timeMin, timeMax),// raw event items (all pages), singleEvents=true, orderBy=startTime, showDeleted=false, maxAttendees=1
  getEvent(calendarId, eventId),
  insertEvent(calendarId, body),           // always sends a client id (body.id if valid, else newEventId()); 409 → getEvent (idempotent retry)
  patchEvent(calendarId, eventId, body), deleteEvent(calendarId, eventId), getPrimaryCalendarId()
}
// EVENT_FIELDS adds organizer(email,self), guestsCanModify, attendees(self,responseStatus). export newEventId() (32 base32hex chars).
```
### C. js/google/drive.js
```js
export const META_FIELDS = 'id,name,createdTime,modifiedTime,version,md5Checksum,size,appProperties';
export function createDriveApi(http) → {
  listPageFiles(pageId),   // files in appDataFolder with appProperties page=<pageId> (all devices), all pages of results
                           // GET /drive/v3/files?spaces=appDataFolder&q=appProperties has { key='page' and value='<escaped>' }
                           //   &fields=nextPageToken,files(META_FIELDS)&pageSize=1000&orderBy=createdTime  (nextPageToken MUST be in fields)
  getMeta(fileId),         // META_FIELDS of one file
  download(fileId),        // text (alt=media)
  generateId(),            // one pre-generated id (keeps a pool: GET /drive/v3/files/generateIds?count=20&space=appDataFolder&type=files)
  create({ id, name, appProperties }, text),
                           // multipart/related POST /upload/drive/v3/files?uploadType=multipart&fields=META_FIELDS
                           // metadata { id, name, parents:['appDataFolder'], mimeType:'application/json', appProperties }
                           // CRLF line endings, boundary in Content-Type; 409 with id → update(id, text) (an earlier attempt
                           // whose response was lost may have uploaded older content)
  update(fileId, text),    // PATCH (uppercase!) /upload/drive/v3/files/{id}?uploadType=media&fields=META_FIELDS, Content-Type application/json; charset=UTF-8
  remove(fileId)           // DELETE; 404 is success. (appDataFolder files cannot be trashed; DELETE is permanent)
}
// Always encodeURIComponent ids; escape ' and \ in q values; send cache:'no-store'.
```
### C. js/data/calendar-source.js
```js
export function normalizeCalendar(raw)              // → CalInfo
export function normalizeEvent(raw, cal)            // → CalEvent | null (cancelled → null)
export function toApiEventBody(input)               // EventInput → Google body (allDay → {date}, timed → {dateTime, timeZone})
export function createGoogleCalendarSource(calendarApi)
export function createDemoCalendarSource({ storage, now })
// CalendarSource:
//   { kind: 'google'|'demo',
//     listCalendars(): Promise<CalInfo[]>,
//     listEvents(calendarIds, start, end): Promise<CalEvent[]>,   // merged & sorted; one failing calendar does not fail all
//     createEvent(calendarId, input, { id }?): Promise<CalEvent>,   // id from newEventId(): the SAME id on every retry
//     updateEvent(calendarId, eventId, input, original?): Promise<CalEvent>, // with the original CalEvent only changed
//                                                    //   fields are PATCHed (nothing changed → no request)
//     deleteEvent(calendarId, eventId): Promise<void> }
// Google listEvents result carries non-enumerable failedCalendarIds (string[]) / firstError (all failing → throws).
// Declined invitations are hidden; invitations the user does not organize are editable:false unless guestsCanModify.
```

### D. js/util/idb.js
```js
export function openKV({ dbName = 'tegaki-calendar', storeName = 'kv', indexedDB = globalThis.indexedDB, onDegraded })
  // → Promise<KV>; falls back to createMemoryKV() if IndexedDB is unavailable or fails to open;
  //   onDegraded(reason): IndexedDB became unusable MID-session (memory from then on) → main.js shows an error banner
export function createMemoryKV()   // KV: { get(key), set(key, value), del(key), keys(prefix), update(key, fn) } all async,
                                   //   values structured-cloned; update = atomic read-modify-write (fn returns undefined → no write)
// Databases: Google mode 'tegaki-calendar'; お試しモード 'tegaki-calendar-demo' (never uploaded).
```
### D. js/data/ink-store.js
```js
export function createInkStore({ kv, drive = null, deviceId, onRemoteUpdate, onStatus, debounceMs = 1500, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout })
  → {
    load(pageId),          // Promise<PageDoc> from local kv (emptyPage if none). Fast; never touches network.
    refresh(pageId),       // Promise<PageDoc|null>: if drive: download remote, merge with local, persist local; if result differs
                           //   from what was loaded → also onRemoteUpdate(pageId, merged) and return merged; null if unchanged/no drive.
                           //   If local has content the remote lacks → mark dirty (will upload).
    save(pageId, doc),     // persist to kv immediately (await), mark dirty, schedule debounced upload
    flush(),               // upload all dirty pages now (read-merge-write each); resolves when done
    setDrive(drive|null),  // sign-in state changes; when non-null, triggers flush of persisted dirty pages
    getStatus(),           // 'local' (no drive) | 'synced' | 'pending' | 'syncing' | 'error' | 'offline'
    getStatusDetail(), isUnreadable(pageId), // extras: message/dirtyCount/lastSyncAt; the stored page could not be read
  }
// Local writes (several tabs share the database): 'page:<id>' is only written by read-merge-write (kv.update), the
//   'dirty' list by atomic per-page updates, and the dirty mark is written BEFORE the page. flush() also adopts pages
//   other tabs marked dirty; refresh() without a drive picks up what another tab stored for a loaded page.
// Retry: after an 'offline' / 'error' failure with unsent pages one timer runs flush() (15 s doubling to 5 min, reset
//   on success). flush() cancels a page's debounce timer only right before uploading that page.
// DESIGN: one Drive file PER PAGE PER DEVICE → no cross-device lost updates (Drive v3 has no If-Match).
//   name 'ink-<pageId>--<deviceId>.json', appProperties { page: pageId, dev: deviceId, schema: '1' }.
//   Each device writes ONLY its own file, whose content is the device's full merged PageDoc (union semantics make
//   this safe). Readers merge every device's file for the page (union strokes − union tombstones).
// deviceId: createInkStore option `deviceId` (main.js generates crypto.randomUUID() once and keeps it in kv 'deviceId').
// kv keys: 'page:<pageId>' → PageDoc ; 'dirty' → string[] (pageIds with local changes not yet uploaded) ;
//   'own:<pageId>' → own fileId ; 'seen:<pageId>' → { [fileId]: md5Checksum } of remote files already merged.
// refresh(pageId): listPageFiles → download only files whose md5Checksum differs from 'seen' (skip own file unless the
//   own file is unknown locally, e.g. after a reinstall with the same deviceId — normally never) → merge into local →
//   persist → if local now has content not yet in own remote file, mark dirty.
// upload(pageId): own fileId from kv 'own:' (or from listPageFiles filtered by appProperties.dev === deviceId; if several,
//   keep oldest createdTime/smallest id, merge the rest into it and remove them) → update(); none → create() with a
//   generateId() id. 404 on update → forget own id and create again. After success record md5 in 'seen'.
// Errors: AuthRequiredError → status 'pending' (retry after next setDrive()); ApiError status 0 (network) → 'offline',
//   retried by the retry timer, the next save()/flush() and main.js flush() on 'online' / visible / every 5 min;
//   403 storageQuotaExceeded → status 'error' with message. Other errors → 'error', keep dirty, retry later.
//   Never lose local data.
// Concurrency: serialize per page (one upload at a time per pageId; a save during upload re-schedules after it).
```

### E. js/ink/surface.js  (canvases: base + live, both inside pageEl, same size)
```js
export class InkSurface {
  constructor({ pageEl, viewportEl, getPageInfo, onCommit, onSelectionChange, onEventRect, onEventPreview })
  // pageEl: the .page element (position:relative, css size = W*scale x H*scale). The surface creates inside it:
  //   canvas.ink-base (absolute, inset 0, pointer-events none, z-index 3) and svg.ink-overlay (selection/lasso, z-index 4).
  //   It also creates canvas.ink-live (same size as base, z-index 5, pointer-events none) for the in-progress stroke.
  //   Each canvas backing store ≤ 16,777,216 device px (lower the effective dpr if needed).
  // viewportEl: the scroll container (used only to know the visible region / for selection menu positioning).
  // All listeners are attached to pageEl (the "ink host"); see §7.
  // getPageInfo(): { pageId, W, H, scale, view, range }
  // onCommit(doc, op): called after every user change (stroke added, erased, moved, deleted, undo/redo)
  // onSelectionChange(sel | null): sel = { ids: string[], bbox: Rect(logical), screenRect: DOMRect-like (client coords) }
  // onEventRect(rect, { tap }): 予定 tool finished a drag (logical rect) or tap
  // onEventPreview(rect|null): asks the app for a snapped rect to preview; the app returns the snapped rect (sync)
  setDoc(doc, { resetHistory = true })   // new page or remote merge (resetHistory false keeps undo stacks)
  getDoc()
  resize()                               // after layout/scale change: resize canvases (cap backing store ≤ 16.7M px each; lower dpr if needed) and redraw
  setTool({ tool /* 'pen'|'highlighter'|'eraser'|'lasso'|'event' */, color, size })
  setAllowFinger(bool)
  undo(); redo(); canUndo(); canRedo()
  getSelection(); clearSelection(); deleteSelection()
  removeStrokesById(ids)                 // used after converting ink to an event (creates an undoable op, calls onCommit)
  snapshot(ids, maxW = 480, maxH = 240)  // PNG dataURL of those strokes on white, cropped to their bbox (for the dialog)
  commitActiveGesture()                  // page hidden / unloading (no pointerup comes): ink & eraser gestures are
                                         // committed; a selection move, lasso or 予定 drag is cancelled
  destroy()
}
```
Input rules (see §7 for the iPad recipe): Pencil (pointerType 'pen') always draws with the active tool.
Touch (finger) never draws unless allowFinger; it scrolls/taps normally. Mouse / trackpad (pointerType 'mouse',
button 0) always draws (desktop dev, iPad trackpad) — but a mouse click on an event box (closest('.event')) is a tap,
not ink, when the tool is not pen/highlighter. Eraser removes whole strokes touched (radius 10 lu). Lasso: closed polygon → strokes with
`strokeInLasso` selected → dashed bbox; dragging inside the bbox with the pen moves the selection
(on release: one batch op = remove originals + add translated clones; selection follows the clones);
tapping outside clears. 予定 tool: drag → live preview of `onEventPreview(rect)`; release →
`onEventRect(rect, { tap: dragDistance < 8 lu })`.

### F1. Views (js/views/*.js)
```js
// view-common.js
export function createPageElements(viewportEl)  // clears viewportEl, creates & appends .page containing svg.grid (z1) and div.events (z2)
                                                // → { pageEl, gridEl, eventsEl }  (the ink surface adds its canvases later, z3–5)
export function applyPageScale({ viewportEl, pageEl, spec })
  // fit 'width': scale = viewportEl.clientWidth / W ; fit 'contain': scale = min(clientWidth / W, clientHeight / H)
  // sets pageEl.style.width/height (W*scale, H*scale px), margin-left for centering (contain), CSS var --s = scale
  // → { scale, cssW, cssH, offsetX }  (offsetX = left offset of the page inside the viewport, for aligning stickyEl)
export function svgEl(tag, attrs)  // createElementNS helper
// day-view.js / week-view.js / month-view.js each export:
export function render({ pageEl, gridEl, eventsEl, stickyEl, layout, date, range, events, settings, now, onEventTap, onDayTap })
  // layout = return value of applyPageScale. stickyEl = the static div.sticky-header from index.html (F1 replaces its
  // children each render and sets its padding-left/width so its columns align with the page: use layout.offsetX/cssW and
  // the same % geometry). May be called again with new events only — must be idempotent (clear and redraw).
  // gridEl: SVG with viewBox `0 0 W H` (preserveAspectRatio none) drawing the grid: hour lines, half-hour dashed,
  //   time labels (gutter), weekend/holiday tint, today highlight.
  // eventsEl: absolutely positioned event boxes using % of W/H (left/top/width/height), color = event.color,
  //   text = time + title; tappable with a finger (onEventTap(event)). Font size scales with the page
  //   (set CSS var --s = scale on pageEl; use calc()); plus, for day/week when today is shown, the current-time
  //   red line in an svg.now-layer overlay (page viewBox, pointer-events:none) appended after the boxes so it is
  //   drawn above them; after midnight the view re-renders itself so today follows the clock.
  // render keeps the page's on-screen position when the sticky header height changes (fit width: the viewport's
  //   scrollTop compensates, keepPageInPlace; showBanner/hideBanner do the same). main.js does NOT compensate again.
  // stickyEl (above the scroller, not inkable): day/week → weekday + date headers aligned to columns, holiday
  //   names, and all-day events row(s) (tappable); month → weekday labels row.
  //   Tapping a date header → onDayTap(date). Month cells: date number at top-left (red Sun/holiday, blue Sat),
  //   holiday name, events listed (up to what fits, then '+n件'); tapping the date number → onDayTap(date).
export function initialScrollMinutes({ date, now })   // day/week: minutes to scroll to on first show (now-60 if today else 7:00)
```

### F2. App shell
- index.html: viewport meta `width=device-width, initial-scale=1, viewport-fit=cover`, apple-mobile-web-app meta,
  manifest link, apple-touch-icon, `<div id="app">` with header, sticky header, viewport, toolbar, dialog root.
- main.js: composition (auth → http → calendar/drive → sources → ink store → surface → views → UI), routing
  (`view`/`date` kept in settings and restored after the OAuth redirect), event loading per range (cache in memory
  per pageId; re-fetch on navigation, on focus, and every 5 min while visible), sync status, banners,
  welcome screen (Googleでログイン / お試しモード), keyboard shortcuts on desktop (←/→/t/d/w/m, ⌘Z/⇧⌘Z).
- ui/event-dialog.js: `openEventDialog({ mode, initial, calendarId, calendars, snapshotUrl, showEraseOption, eraseDefault, recurring, htmlLink, onSubmit? })`
  → `Promise<{ action: 'save', input, calendarId, eraseInk } | { action: 'delete' } | { action: 'cancel', pending?: true }>`
  onSubmit(result): the sheet stays open (「保存中…」) while it runs and shows its error inline. After ~15 s of a pending
  onSubmit, 「キャンセル」/Esc/backdrop work again and resolve { action: 'cancel', pending: true } (main.js reports the late
  outcome as a toast; create flows reuse one client event id, so a retry never duplicates).
  Fields: タイトル (text, large, NOT autofocused, placeholder 「ここにペンで書くと文字になります」), 終日 checkbox,
  日付 / 開始・終了 time (all-day: 開始日・終了日 inclusive in UI), カレンダー select (writable only), メモ textarea.
  Validation: end > start (auto-fix end = start + 1h when the user moves start past end).
- ui/settings.js, ui/header.js, ui/toolbar.js, ui/selection-menu.js, ui/toast.js as described in §8.

## 5. Google Calendar mapping rules (C)
- calendars: hide `hidden: true`; `holiday: id.includes('#holiday@')`; writable = accessRole in (owner, writer);
  color = backgroundColor; textColor = foregroundColor.
- events: skip status 'cancelled'; skip eventType 'workingLocation' (noise); title fallback '(タイトルなし)';
  allDay when start.date exists (parse as local midnight; end.date exclusive); recurring = !!recurringEventId;
  editable = cal.writable && !raw.locked && raw.eventType not in ('fromGmail','birthday');
  color = raw.colorId ? EVENT_COLORS[colorId] : cal.color (embed the 11 standard Google event colors).
- Events from holiday calendars (`id` contains '#holiday@') are not fetched/displayed (holidays come from holidays-jp.js;
  Google's ja.japanese#holiday now also contains non-holiday observances).
- accessRole writerWithoutPrivateAccess counts as writable, but events with visibility 'private' on such calendars are not editable.
- eventType rules: skip 'workingLocation'; 'fromGmail' and 'birthday' → editable false.
- Always encodeURIComponent(calendarId) and eventId in URLs ('#' in holiday ids!). method strings uppercase ('PATCH').
- listEvents query: timeMin/timeMax = toRFC3339 (with offset), singleEvents=true, orderBy=startTime, maxResults=2500,
  showDeleted=false, fields=nextPageToken,items(id,status,summary,description,location,start,end,colorId,htmlLink,
  recurringEventId,eventType,locked,visibility,extendedProperties). Loop on nextPageToken (pages can be empty).
- insert: query sendUpdates=none; body adds extendedProperties.private = { tegaki: '1' }.
- patch (update): send summary, description, location, start, end with explicit nulls for the unused variant
  (timed → start:{dateTime, timeZone, date:null}; allDay → start:{date, dateTime:null, timeZone:null}); sendUpdates=none.
  Recurring instance ids (from singleEvents=true) patch/delete only that occurrence (dialog says so).
- delete: 404/410 → treat as success.
- EVENT_COLORS (colorId → background) embedded: 1 '#a4bdfc', 2 '#7ae7bf', 3 '#dbadff', 4 '#ff887c', 5 '#fbd75b',
  6 '#ffb878', 7 '#46d6db', 8 '#e1e1e1', 9 '#5484ed', 10 '#51b749', 11 '#dc2127' (foreground '#1d1d1d').
  Text color for event boxes: choose dark/white by luminance of the background (helper in calendar-source.js: `readableTextColor(bg)`).
- Error policy (http.js): 401 → AuthRequiredError; 403 insufficientPermissions → ApiError reason surfaced (UI shows 権限不足);
  403 requiredAccessLevel/forbiddenForNonOrganizer → ApiError (UI: 「このカレンダーは編集できません」); 403 quotaExceeded → no retry.
- toApiEventBody: allDay → { start: { date }, end: { date } } (end exclusive);
  timed → { start: { dateTime: toRFC3339, timeZone: Intl tz }, end: {...} }; summary, description, location.

## 6. Auth flow (C) — redirect implicit flow (decided after research)

Google's GIS token client has no redirect mode and its popup is unreliable in iOS home-screen apps, so we use the
OAuth 2.0 implicit grant by full-page redirect (`response_type=token`), the same code for Safari tabs and standalone.
Google documents it as legacy; keep it isolated in auth.js so it can be swapped for a backend code+PKCE flow later.

- Endpoint `https://accounts.google.com/o/oauth2/v2/auth` with: client_id, redirect_uri, response_type=token,
  scope (space-separated), state (32 random bytes base64url), include_granted_scopes=true, optional login_hint,
  prompt=none for silent attempts (prompt=consent only for 「権限を追加」).
- `redirectUri()` in config.js returns an EXACT registered constant chosen by hostname:
  localhost/127.0.0.1 → `${location.origin}/` ; otherwise `'https://syfan0-star.github.io/tegaki-calendar/'`.
  Never derive it from location.href. main.js normalizes `/tegaki-calendar/index.html` → `/tegaki-calendar/` at boot.
- Scopes: `https://www.googleapis.com/auth/calendar.events`, `https://www.googleapis.com/auth/calendar.calendarlist.readonly`,
  `https://www.googleapis.com/auth/drive.appdata` (requested together once).
- Storage (localStorage via the injected `storage`): 'tegaki.auth.token' {access_token, exp (ms, = now + (expires_in−120)s), scopes[]},
  'tegaki.auth.pending' {state, silent, returnState, t} (one-time, 10-min TTL), 'tegaki.auth.hint' (email),
  'tegaki.auth.lastSilent' (ms), 'tegaki.auth.ever' ('1').
- handleRedirect(): runs FIRST at boot before anything reads location.hash. If hash has access_token or error:
  history.replaceState to strip the fragment; read+delete pending; reject if state missing/mismatched/stale
  (status 'error', error 'state_mismatch'); error param → { status:'error', error, silent: pending.silent };
  success → store token (expires_in default 3600), mark ever, return { status:'success', returnState, scopes }.
- Silent re-auth policy (implemented in main.js using auth helpers): when the token is missing/expiring (<5 min) AND
  hasEverSignedIn AND online AND not drawing AND ink flushed to IndexedDB AND last silent attempt > 5 min ago →
  signIn({ silent:true }). Triggers: boot, visibilitychange→visible, 401 from the API, 'online'. At boot the redirect
  starts BEFORE any UI exists (splash only, nothing can be drawn). Mid-session each trigger needs input silence
  (state.js REAUTH_IDLE_MS: boot 0, visible 1.5 s, retry 4 s, api/401/online 60 s; api/401/online also wait while a
  selection exists). Once leaving is decided a full-screen input shield takes all input and local saves are awaited.
  ANY redirect error (failed prompt=none, cancelled consent, state_mismatch) or a signIn() that throws stops automatic
  redirects for that page load → only the 「Googleに再接続」 banner (signIn({ silent:false })). Never redirect while the pen
  is down. Export `canTrySilent()` from auth (hint known not required; time-gated) — add to the auth API.
- Granular consent: check returned scopes. Missing calendar.events → NO events can be listed or created (events.list
  does not accept calendarlist.readonly); the banner asks for access (「権限を追加」), not 'read-only'.
  Missing calendarlist.readonly → use only 'primary' with default color. Missing drive.appdata → ink stays local
  (status 'local'), banner offers 「権限を追加」 (prompt=consent).
- After a successful sign-in main.js uses the primary calendarList entry id (or `calendarApi.getPrimaryCalendarId()` =
  `GET /calendar/v3/users/me/calendarList/primary?fields=id`; `calendars/primary` would need a scope we do not request)
  and calls auth.setLoginHint(id).
- signOut(): clear storage keys first, then POST https://oauth2.googleapis.com/revoke (form-urlencoded token), ignore failures.
- pageshow with e.persisted (user came back from Google with the back button) → main.js resets any 「接続中…」 UI.
- Error messages in Japanese for: access_denied (「アクセスが許可されませんでした」), state_mismatch, and others
  (「Googleへのログインに失敗しました（コード: …）」).
- Testing note for docs: in Google's 'Testing' publishing status consent expires after 7 days → recommend 'In production' (unverified).
- index.html sets a CSP meta: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;
  connect-src 'self' https://www.googleapis.com https://oauth2.googleapis.com; manifest-src 'self'; worker-src 'self'.

## 7. iPad Pencil input recipe (E) — decided after research

- pageEl CSS: `position:relative; touch-action: pan-x pan-y; -webkit-user-select:none; user-select:none;
  -webkit-touch-callout:none; -webkit-tap-highlight-color:transparent`. html also `touch-action: pan-x pan-y`
  (blocks pinch & double-tap zoom). Canvases `pointer-events:none`.
- Non-passive `touchstart`/`touchmove`/`touchend` listeners on pageEl (`{passive:false}`): if any
  `e.changedTouches[i].touchType === 'stylus'` and e.cancelable → `e.preventDefault()`. This stops the Pencil from
  scrolling/zooming/Scribble while fingers keep native momentum scrolling. (preventDefault on pointerdown does NOT stop
  scrolling on iOS.) When allowFinger is on, also preventDefault for finger touches that started a drawing gesture
  (i.e. when the active tool consumes the finger) so fingers draw instead of scroll.
- Ink from Pointer Events only. Accept: 'pen' always; 'mouse' (button 0) always; 'touch' only when allowFinger.
  With allowFinger on, a second finger on the page cancels the finger stroke and the fingers scroll the viewport
  manually (native panning is already blocked for that touch sequence).
  One active pointer at a time; setPointerCapture on pointerdown; e.preventDefault() on pen pointerdown (blocks compat mouse events).
- pressure: pen → e.pressure (if 0 while buttons>0 use 0.5); touch/mouse → 0.5 constant (iPad fingers report 0).
- Hover: pen pointermove with buttons===0 is hover (pointerId differs from contact) — ignore for drawing (optional cursor).
- pointermove: if `e.getCoalescedEvents` exists use its list (filter by the PARENT event's pointerId, coalesced entries may
  lack pointerId); predicted events (getPredictedEvents) may be drawn as a temporary tail on the live canvas, never stored.
- pointercancel for a pen → keep the partial stroke (commit it). pointercancel for touch → discard.
- Also listen to lostpointercapture as an end signal (guard against double finish). Block 'contextmenu' and 'selectstart' on pageEl.
- Safari pinch: preventDefault on document 'gesturestart'/'gesturechange'/'gestureend'.
- Rendering: live canvas: once per requestAnimationFrame, clear the area the previous frame drew and redraw the whole
  partial stroke (plus predicted samples) with drawLiveStroke, which is the same outline as the committed stroke. While a
  highlighter is being drawn, or a selection containing one is being moved, the live canvas has mix-blend-mode:multiply.
  On end: clear live, draw the finished stroke on base with drawStroke (outline fill).
- A Pencil tap on a calendar event in pen/highlighter mode just inks (paper-like). In 予定 tool mode a Pencil tap is
  reported via onEventRect(rect,{tap:true}); main.js checks `document.elementFromPoint` / event boxes for an existing event
  under the point (opens edit) else creates. Fingers tap events normally (click handlers on event boxes) because finger
  touches are not prevented.
- Inputs (<input>, <textarea>) must never be inside pageEl (Scribble would grab Pencil strokes near them).
## 8. UI details (F2)

Visual style: calm paper-planner look. Light theme only is fine for the page (paper), but the chrome (header/toolbar/
dialogs) should respect `prefers-color-scheme: dark` minimally (or stay light — acceptable). System font stack with
Japanese: `-apple-system, BlinkMacSystemFont, 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif`.
Colors: accent #2563eb; Sunday/holiday red #dc2626; Saturday blue #2563eb; grid lines #e5e7eb; paper #fffdf8.
Touch targets ≥ 44×44 pt. Respect safe areas (env(safe-area-inset-*)).

Layout (CSS grid, full height `100dvh`):
```
#app
 ├─ header.app-header        (top bar)
 ├─ div.sticky-header        (non-ink: weekday/date headers + all-day rows; F1 renders into it)
 ├─ div.viewport             (scroll container: overflow:auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain)
 │    └─ div.page            (ink host; F1 grid/events + E canvases)
 ├─ div.toolbar              (floating pill at bottom center, above safe area)
 ├─ div.selection-menu       (floating, hidden by default)
 ├─ div.banner               (auth/sync banners, below header)
 └─ div#dialog-root          (modals)
```

Header (ui/header.js): `createHeader(el, handlers) → { update(state) }`
- Left: ◀ (前へ), 「今日」, ▶ (次へ). Title: day → formatDateJa (+ holiday name), week → formatWeekRangeJa, month → formatMonthJa.
- Center/right: segmented control 「日」「週」「月」; 「＋予定」 button; sync indicator (icon + short text:
  「保存済み」「保存中…」「未送信」「オフライン」「この端末のみ」「エラー」); account/auth chip (「ログイン」 or 「再接続」 when needed);
  ⚙︎ settings.
- handlers: onPrev, onNext, onToday, onView(view), onAddEvent, onSettings, onSyncTap, onAuthTap.

Toolbar (ui/toolbar.js): `createToolbar(el, handlers) → { update({ tool, penColor, penSize, hlColor, canUndo, canRedo }) }`
- Tools (icon + tiny label): ペン, マーカー, 消しゴム, 投げなわ, 予定. Then contextual: pen → 6 color dots + 3 sizes;
  highlighter → 4 colors; others → nothing. Then ↶ 元に戻す, ↷ やり直す.
- Inline SVG icons (no external assets). Active tool highlighted. handlers: onTool(tool), onPenColor, onPenSize, onHlColor, onUndo, onRedo.

Selection menu (ui/selection-menu.js): `createSelectionMenu(el, { onConvert, onDelete, onDeselect }) → { show(screenRect), hide() }`
- Buttons: 「予定にする」(primary), 「削除」, 「選択解除」. Positioned above the selection's screen rect (or below if no room), clamped to viewport.

Event dialog (ui/event-dialog.js): see §4 F2 signature. Layout: sheet/modal centered, max-width 560px.
- If snapshotUrl: shows the handwriting image at top with caption 「書いた内容」.
- タイトル: `<input type="text" enterkeyhint="done" autocomplete="off">`, large (20px), placeholder
  「ここにペンで書くと文字になります」; hint text under it: 「✏️ Apple Pencil で欄の上に書くと、文字に変換されます（スクリブル）」.
- 終日 toggle; when off: 日付 (date) + 開始 (time) + 終了 (time) ; when on: 開始日 + 終了日 (inclusive in UI; converts to exclusive).
  Changing start keeps duration. End before start → auto-correct.
- カレンダー select (only writable; shows color dot via text '●'), default = initial calendarId or settings.defaultCalendarId or primary.
- 場所 (text), メモ (textarea).
- showEraseOption → checkbox 「この手書きを消す」 (default eraseDefault).
- Edit mode: 「削除」 (danger, asks confirm() 「この予定を削除しますか？」), and if recurring: note 「繰り返し予定のうち、この回だけが変更されます」;
  if htmlLink: link 「Googleカレンダーで開く」 (target _blank, rel noopener).
- Read-only events (editable false): fields disabled, only 「閉じる」 and the Google link.
- Buttons: 「キャンセル」, 「保存」(primary, disabled while title empty? — no: empty title allowed → saved as '(タイトルなし)'? Use: if empty, focus title & shake; require non-empty).
- Esc/backdrop tap = cancel. Returns a Promise as specified. Never autofocus the title (keyboard would pop up).

Settings (ui/settings.js): `openSettings({ settings, calendars, auth: { signedIn, email, configured, demo }, version }) → Promise<{ settings, action?: 'signIn'|'signOut'|'exitDemo'|'enterDemo'|'addScopes' }>`
- Sections: 「Googleアカウント」(status, email, ログイン/ログアウト, お試しモード切替), 「表示するカレンダー」(checkbox list with color dots),
  「予定の登録先」(select writable), 「週の始まり」(日曜/月曜, note: 「切り替えると、週ページと月ページの手書きは別のページになります（元に戻すと表示されます）」),
  「入力」(指・マウスでも書く toggle), 「予定にした手書きを消す（初期値）」toggle,
  「データについて」(text: 手書きは Google ドライブの「アプリ専用の非表示フォルダ」に保存されます。…), バージョン.

Toast (ui/toast.js): `toast(message, { actionLabel, onAction, duration = 3000, kind, onClose })` (duration ≤ 0 → sticky with ×;
onClose only for that ×); also `showBanner(el, { text, actionLabel, onAction, kind, closable, onClose })`/`hideBanner(el)`.

Welcome screen (main.js renders into #dialog-root when not signed in, not demo, never signed in):
- Title 「手書きカレンダー」, 3 bullet lines explaining the app, buttons 「Googleでログイン」 (disabled with note
  「Google連携の設定がまだ済んでいません（docs/SETUP.md）」 if !isGoogleConfigured()) and 「お試しモードで使ってみる」.
- Note for Safari users: 「ホーム画面に追加すると、アプリとして使えます（共有ボタン →『ホーム画面に追加』）」 shown when not standalone.

main.js responsibilities (composition root):
1. Normalize URL (strip index.html), auth.handleRedirect() FIRST, load settings, restore route (returnState or settings.view/date).
2. kv = await openKV({ dbName, onDegraded }): Google 'tegaki-calendar', お試しモード 'tegaki-calendar-demo'; deviceId from kv
   (create once; backup in localStorage). One-time move of old demo ink out of the Google database (marker kv
   'legacyDemoChecked'; Google mode does not sync until it is done). Demo ink is carried into Google mode only after a
   confirm (marker 'carryOver' in the demo DB: 'imported' | 'declined'; never deleted).
   Google kv 'inkAccount': Drive is attached to the ink store only after the signed-in primary calendar id matches it
   (or binds it the first time); a mismatch never syncs (persistent error toast).
   onDegraded → persistent error banner 「この端末に手書きを保存できない状態になりました…」 with 再読み込み (flush first).
   Web Lock 'tegaki-writer' ({ steal: true }): the newest tab is live; an older tab that loses it commits its stroke,
   stops uploading (setDrive(null); its dirty marks stay for the live tab), shows a 再読み込み overlay and reloads when
   visible again.
3. Build http/calendarApi/driveApi when configured & signed in; source = demo ? createDemoCalendarSource : createGoogleCalendarSource.
4. inkStore = createInkStore({ kv, drive: (signedIn && hasScope(appdata) && !demo) ? driveApi : null, deviceId, ... }).
5. Render current view: compute range/pageId, create page DOM (view-common), applyPageScale, view.render(...),
   surface.setDoc(await inkStore.load(pageId)), then inkStore.refresh(pageId) (merge remote; surface.setDoc(merged, {resetHistory:false})).
   Fetch events for range (cache by pageId; show cached immediately), re-render events only (not the ink) when they arrive.
   Google mode keeps the last events per page in kv 'events:<cacheId>' + 'eventsIndex' (LRU 40, tagged with the account)
   for offline cold starts; offline → banner with the time of the events shown. Some calendars failing → their last
   known events are kept, the page is refetched next time, toast 「一部のカレンダーの予定を読み込めませんでした」.
6. Wire surface callbacks: onCommit → inkStore.save(pageId, doc) + toolbar undo state; onSelectionChange → selection menu;
   onEventPreview → page-geometry.snapEventRect; onEventRect → open dialog (create) or edit if tapping an existing event.
7. Convert-to-event (selection menu 「予定にする」): rect = selection bbox → rectToEventRange → dialog with snapshot → on save:
   source.createEvent → if eraseInk surface.removeStrokesById(ids) → refetch events → toast 「予定を登録しました」.
8. Resize/orientation: ResizeObserver on viewport → applyPageScale + surface.resize() + re-render events (keep scroll ratio).
9. Lifecycle: visibilitychange hidden / pagehide → surface.commitActiveGesture() + inkStore.flush(); visible → refresh
   page + events, flush, maybe silent re-auth. 'online' → inkStore.flush(). Every 5 min while visible: events refresh
   and flush of unsent ink.
   Sign-out (confirm: it logs out every device): flush first; everything uploaded → remove page:/own:/seen:/events:/
   dirty/inkAccount/eventsIndex; unsent ink → confirm, keep it for the SAME account.
10. Navigation swipe: horizontal finger swipe (|dx| > 80px, |dx| > 2|dy|, < 600ms) on the viewport → prev/next.
11. Keyboard (desktop): ←/→ prev/next, t today, d/w/m views, ⌘Z/Ctrl+Z undo, ⇧⌘Z/Ctrl+Y redo, p/h/e/l/v tools, Escape clears selection.
12. Service worker registration (only on https or localhost), update toast 「新しいバージョンがあります」→ reload.
13. navigator.storage.persist() when standalone.
14. Errors: never crash the app; show toast with Japanese message; console.warn details (no tokens).

PWA files:
- manifest.webmanifest: id "tegaki-calendar" (resolves against start_url's origin → …/tegaki-calendar, not the origin root),
  start_url/scope "./" relative (works on both localhost and Pages), display standalone,
  name 「手書きカレンダー」, short_name 「手書き暦」, lang ja, background/theme #fffdf8, icons 192/512 (purpose any) — icons exist in icons/.
- sw.js: cache name `tegaki-v${VERSION}` (VERSION const at top, keep in sync with config.js APP_VERSION).
  Precache app shell (index.html, styles, all js modules, manifest, icons). Fetch: only same-origin GET; navigation &
  same-origin → network-first with cache fallback (so updates arrive quickly, offline still works). Never touch
  googleapis/accounts.google.com requests. skipWaiting on message 'skipWaiting'; clients.claim on activate; delete old caches.
