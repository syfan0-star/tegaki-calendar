// 手書きカレンダー — composition root (module F2a). The only module that touches everything.
//
// Boot order (SPEC §6, §8):
//   1. normalize the URL (…/index.html → …/), auth.handleRedirect() FIRST (before anything reads location.hash)
//   2. settings + route (OAuth returnState, else the stored view/date)
//   3. mode: お試しモード (demo) | Google | welcome screen (never signed in)
//      (an expired token → the silent prompt=none redirect starts HERE, before any UI exists)
//   4. kv (IndexedDB: one database for Google, a separate one for お試しモード) + deviceId,
//      calendar source, ink store
//   5. chrome (header / toolbar / selection menu), page DOM, ink surface, first render
//   6. lifecycle, silent re-auth, service worker, persistent storage
//
// Invariants:
//   - Ink is never lost: every surface commit is saved (IndexedDB first, then Drive by the ink store);
//     strokes drawn while a page's ink is still loading are merged in, never overwritten.
//   - We never leave the page (OAuth redirect, reload) while the pen is down. Once leaving is decided,
//     a full-screen shield takes all input (no new stroke can start) and local saves are awaited.
//   - Local ink belongs to one Google account: it is uploaded only after the signed-in account is
//     confirmed to be that account. お試しモード ink lives in its own database and is never uploaded
//     unless the user agrees to carry it over.
//   - Stale async results are ignored (pages are compared by identity, event fetches by sequence number).
//   - No handler throws: async work is wrapped (guard) and errors become Japanese toasts + console.warn
//     (never with tokens).

import { APP_VERSION, GOOGLE_CLIENT_ID, SCOPES, redirectUri, isGoogleConfigured } from './config.js';
import {
  createSettingsStore, resolveInitialRoute, reconcileCalendarVisibility,
  loadRouteAt, saveRouteAt, loadSeenCalendarIds, saveSeenCalendarIds, ROUTE_RESTORE_MS,
  INK_DB_NAMES, inkDbName, decideInkAccount, silentReauthReady, shouldRedirectBeforeUi, returnScrollRatio,
  DRAFT_KEY, DRAFT_MAX_AGE_MS, normalizeEventInput, encodeDraft, parseDraft,
  encodeEventsEntry, decodeEventsEntry, touchLru, offlineBannerText, shouldOfferUpdate,
} from './state.js';
import { createAuth } from './google/auth.js';
import { createHttp, AuthRequiredError, ApiError } from './google/http.js';
import { createCalendarApi } from './google/calendar.js';
import { createDriveApi } from './google/drive.js';
import { createGoogleCalendarSource, createDemoCalendarSource, newEventId } from './data/calendar-source.js';
import { createInkStore } from './data/ink-store.js';
import { openKV } from './util/idb.js';
import { addStrokes, emptyPage, mergePages, sameContent } from './ink/model.js';
import { legacySourcesFor, legacyStrokesFor } from './ink/legacy-week-start.js';
import { PEN_SIZES, HIGHLIGHTER_SIZE } from './ink/render.js';
import { InkSurface } from './ink/surface.js';
import {
  VIEWS, PAGE_SPECS, pageIdFor, rangeFor, navigate, minutesToY, rectToEventRange, snapEventRect,
} from './views/page-geometry.js';
import { createPageElements, applyPageScale } from './views/view-common.js';
import * as dayView from './views/day-view.js';
import * as weekView from './views/week-view.js';
import * as monthView from './views/month-view.js';
import { createHeader } from './ui/header.js';
import { createToolbar } from './ui/toolbar.js';
import { createSelectionMenu } from './ui/selection-menu.js';
import { openEventDialog } from './ui/event-dialog.js';
import { openSettings } from './ui/settings.js';
import { toast, showBanner, hideBanner } from './ui/toast.js';
import { toYMD, startOfDay, atMinutes, minutesOfDay, clamp } from './util/date.js';

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

const VIEW_MODULES = { day: dayView, week: weekView, month: monthView };

const EVENTS_STALE_MS = 60 * 1000;             // cached events younger than this are not refetched
const EVENTS_REFRESH_MS = 5 * 60 * 1000;       // periodic refresh while visible
const CALENDARS_STALE_MS = 30 * 60 * 1000;
const EVENT_CACHE_LIMIT = 40;                  // pages of events kept in memory
const TOKEN_MARGIN_MS = 5 * 60 * 1000;         // silent re-auth when the token has less than this left
const REAUTH_RETRY_MS = 5000;                  // (input silence needed per trigger: state.js REAUTH_IDLE_MS)
const LEAVE_SAVE_TIMEOUT_MS = 3000;            // wait at most this long for local ink saves before leaving
const SIGN_IN_SAVE_TIMEOUT_MS = 8000;          // the same before a sign-in the user asked for
const FLUSH_TIMEOUT_MS = 8000;                 // wait at most this long for Drive uploads (sign-out, mode switch)
const DRAWING_STALE_MS = 30 * 1000;            // a "pen down" without any pointer event for this long is stale
const DIALOG_CALENDARS_TIMEOUT_MS = 5000;      // a dialog waits at most this long for a first calendar list
const VISIBLE_FLUSH_DELAY_MS = 1000;           // back in the foreground: retry unsent ink after this delay
const REDIRECT_STALL_MS = 20 * 1000;           // still on this page this long after location.assign → abandoned
const SWIPE = { minDx: 80, ratio: 2, maxMs: 600 };
const SW_UPDATE_CHECK_MS = 60 * 60 * 1000;
const DEVICE_ID_KEY = 'tegaki.deviceId';
const TOOLBAR_COLLAPSED_KEY = 'tegaki.toolbar.collapsed';
const INK_ACCOUNT_KEY = 'inkAccount';          // kv (Google database): account the local ink belongs to
const LEGACY_DEMO_CHECKED_KEY = 'legacyDemoChecked'; // kv (Google database): old shared-database demo ink moved out
const DEMO_CARRY_KEY = 'carryOver';            // kv (demo database): 'imported' | 'declined'
const EVENTS_KV_PREFIX = 'events:';            // kv: 'events:<cacheId>' → last fetched events of a page
const EVENTS_INDEX_KEY = 'eventsIndex';        // kv: LRU list of the cacheIds above
const ACCOUNT_DATA_PREFIXES = ['page:', 'own:', 'seen:', EVENTS_KV_PREFIX];
const DEMO_DB_NOTE = 'お試しモードの手書きは、このアプリ（このブラウザ）の中だけに保存されます';
const TAB_STORAGE_WARNING = 'Safariのタブで書いた手書きは、ホーム画面に追加したアプリには引き継がれません。'
  + '先にホーム画面に追加してから使ってください（Safariでしばらく開かないと消えることもあります）';
const READ_ONLY_MESSAGE = '予定を表示・登録するには、カレンダーの予定へのアクセスを許可してください（設定から「権限を追加」できます）';
const NOT_CONFIGURED_MESSAGE = 'Google連携の設定がまだ済んでいません（docs/SETUP.md）';
const ACCOUNT_MISMATCH_MESSAGE = '前回とは別のGoogleアカウントでログインしています。この端末の手書きは前のアカウントのものなので、'
  + 'Googleドライブへの同期を止めました（前のアカウントでログインし直すと同期します）';
const TOOL_KEYS = { p: 'pen', h: 'highlighter', e: 'eraser', l: 'lasso', v: 'event' };
const VIEW_KEYS = { d: 'day', w: 'week', m: 'month' };
const SETTINGS_DIALOG_KEYS = ['allowFinger', 'eraseInkAfterConvert', 'hiddenCalendarIds', 'defaultCalendarId'];
const WRITER_LOCK = 'tegaki-writer';           // Web Lock: the newest tab (window) of the app is the live one
const STORAGE_DEGRADED_MESSAGE = 'この端末に手書きを保存できない状態になりました。再読み込みしてください（Googleに同期済みの手書きは消えません）';
const SIGN_OUT_CONFIRM = 'ログアウトすると、ほかの端末（iPad・パソコンなど）でも、もう一度Googleへのログインが必要になります。ログアウトしますか？';

const NOOP_UPDATER = Object.freeze({ update() {} });
const NOOP_MENU = Object.freeze({ show() {}, hide() {} });

// ---------------------------------------------------------------------------------------------
// App state (one object so it is easy to see everything main.js keeps)
// ---------------------------------------------------------------------------------------------

const S = {
  mode: 'none',              // 'google' | 'demo' | 'none' (welcome)
  configured: false,
  storage: null,             // localStorage (or null)
  auth: null,
  http: null,
  calendarApi: null,
  driveApi: null,
  source: null,              // CalendarSource
  inkStore: null,
  kv: null,
  deviceId: '',
  settings: null,            // settings store (state.js)
  els: null,                 // static elements from index.html
  pageEls: null,             // { pageEl, gridEl, eventsEl } (created once, reused for every page)
  ui: { header: NOOP_UPDATER, toolbar: NOOP_UPDATER, selectionMenu: NOOP_MENU },
  surface: null,
  route: { view: 'week', date: startOfDay(new Date()) },
  page: null,                // current page context (see showRoute)
  calendars: [],
  calendarsAt: 0,
  calendarsLoading: null,
  eventsCache: new Map(),    // cacheId → { events, key, at }
  eventsInflight: new Map(), // cacheId → Promise
  eventsSeq: new Map(),      // cacheId → latest request number
  seq: 0,
  scrollMemory: new Map(),   // pageId → scroll ratio (revisits keep their position)
  settlingCleanup: null,     // ends the 'just shown' state of the page (see markSettling)
  lastSize: { w: 0, h: 0 },
  pointersDown: new Set(),
  lastPointerAt: 0,
  lastInputAt: 0,
  dialogOpen: false,
  welcomeOpen: false,
  connecting: false,
  leaving: false,            // a redirect / reload has started
  shield: null,              // full-screen input shield while leaving (no new stroke can start)
  redirectStartedAt: 0,      // ms of the last location.assign to Google (0: none in progress)
  redirectHidden: false,     // this page was hidden after that (Home Screen app: the in-app browser)
  redirectWatchdog: null,
  bootDeferred: null,        // { mode, redirect }: boot stopped for a silent redirect before any UI existed
  settingsOpening: false,
  signInPending: false,
  needsReconnect: false,
  silentFailed: false,
  scopes: new Set(),         // scopes granted to this session's token (snapshot at boot)
  refreshHint: false,        // a sign-in just succeeded: re-read the account for login_hint
  inkAccount: null,          // account the local Google-mode ink belongs to (kv INK_ACCOUNT_KEY)
  inkVerified: false,        // the signed-in account is confirmed to own the local ink → Drive sync on
  inkMismatch: false,        // signed in with another account than the local ink's → never sync
  legacyDemoPending: false,  // old demo ink still sits in the Google database (move unfinished) → no sync
  demoOffer: 'idle',         // 'idle' | 'busy' | 'done': asking whether お試しモード ink is carried over
  offlineEvents: false,      // the last events fetch failed for lack of a network
  eventsPersist: Promise.resolve(),
  bannerDeferred: false,     // a banner change waits for the pen to lift (it moves the page)
  tabWarningDismissed: false,
  lastTop: NaN,              // viewport top (client px) after the last layout, to keep content still
  reauthTimer: null,
  syncStatus: 'local',
  syncMessage: null,
  bannerKey: null,
  pendingSaves: new Set(),
  notified: new Map(),       // notifyOnce key → ms
  hiddenAt: 0,
  refreshTimer: null,
  swRegistration: null,
  swCheckedAt: 0,
  offerUpdate: null,         // (worker) → shows the update toast
  pageShowHooks: new Set(),
  storageDegraded: false,    // IndexedDB failed mid-session: nothing written now survives a reload
  stale: false,              // another tab (window) of the app took over (Web Lock stolen)
  staleOverlay: null,
};

// ---------------------------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------------------------

function warn(...args) {
  try {
    console.warn('[tegaki]', ...args);
  } catch {
    // console unavailable
  }
}

/** Log-safe description of an error (never includes request headers or tokens). */
function describe(err) {
  if (!err || typeof err !== 'object') return String(err);
  const parts = [err.name || 'Error'];
  if (err.status !== undefined) parts.push(`status=${err.status}`);
  if (err.reason) parts.push(`reason=${err.reason}`);
  if (err.message) parts.push(String(err.message).slice(0, 300));
  return parts.join(' ');
}

/** Wraps a handler: sync throws and async rejections are reported instead of escaping. */
function guard(fn, label = 'handler') {
  return (...args) => {
    try {
      const r = fn(...args);
      if (r && typeof r.then === 'function') {
        return r.catch((err) => {
          reportError(err, label);
          return undefined;
        });
      }
      return r;
    } catch (err) {
      reportError(err, label);
      return undefined;
    }
  };
}

function reportError(err, label) {
  warn(label, describe(err));
  if (isAuthError(err)) {
    onAuthRequired('api');
    return;
  }
  notifyOnce(`err:${label}`, errorMessage(err), 30 * 1000, { kind: 'error' });
}

function notify(message, opts) {
  if (!message) return;
  try {
    toast(message, opts);
  } catch (err) {
    warn('toast failed', describe(err));
  }
}

/** Same message at most once per cooldown (periodic background failures must not spam). */
function notifyOnce(key, message, cooldownMs = 60 * 1000, opts) {
  const now = Date.now();
  const last = S.notified.get(key) || 0;
  if (now - last < cooldownMs) return;
  S.notified.set(key, now);
  notify(message, opts);
}

function withTimeout(promise, ms) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).catch((err) => {
      warn('background task failed', describe(err));
      return undefined;
    }),
    new Promise((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function safeLocalStorage() {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    s.getItem('tegaki.probe');
    return s;
  } catch {
    return null;
  }
}

function storageGet(key) {
  try {
    return S.storage ? S.storage.getItem(key) : null;
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    if (S.storage) S.storage.setItem(key, value);
  } catch (err) {
    warn('storage write failed', key, describe(err));
  }
}

function storageRemove(key) {
  try {
    if (S.storage) S.storage.removeItem(key);
  } catch {
    // ignore
  }
}

function newId() {
  const c = globalThis.crypto;
  try {
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  } catch {
    // insecure context
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function isValidDate(d) {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

function isRect(r) {
  return !!r && ['minX', 'minY', 'maxX', 'maxY'].every((k) => Number.isFinite(r[k]));
}

function isAuthError(err) {
  return err instanceof AuthRequiredError || (!!err && err.name === 'AuthRequiredError');
}

function isOfflineError(err) {
  return !!err && typeof err === 'object' && err.status === 0;
}

function isOnline() {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function isStandalone() {
  try {
    if (globalThis.matchMedia && globalThis.matchMedia('(display-mode: standalone)').matches) return true;
  } catch {
    // ignore
  }
  return typeof navigator !== 'undefined' && navigator.standalone === true;
}

/** iPhone / iPad (iPadOS Safari reports itself as a Mac, but with a touch screen). */
function isAppleMobile() {
  if (typeof navigator === 'undefined') return false;
  const ua = String(navigator.userAgent || '');
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && Number(navigator.maxTouchPoints) > 1);
}

/** Safari tab on iPhone/iPad: its storage is not shared with the Home Screen app and may be evicted. */
function tabStorageRisk() {
  return isAppleMobile() && !isStandalone();
}

function isLocalHost() {
  return ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
}

// ---------------------------------------------------------------------------------------------
// Japanese messages
// ---------------------------------------------------------------------------------------------

function errorMessage(err) {
  if (isAuthError(err)) return 'Googleに再接続してください';
  if (err instanceof ApiError || (err && typeof err === 'object' && typeof err.status === 'number')) {
    const { status, reason } = err;
    if (status === 0) return 'オフラインのため、Googleに接続できません';
    if (reason === 'requiredAccessLevel' || reason === 'forbiddenForNonOrganizer') return 'このカレンダーは編集できません';
    if (reason === 'insufficientPermissions' || reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT') {
      return '権限不足です（設定から「権限を追加」してください）';
    }
    if (status === 429 || ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded'].includes(reason)) {
      return 'Googleの利用制限に達しました。しばらくしてからお試しください';
    }
    if (status === 404 || status === 410) return '予定が見つかりません（削除された可能性があります）';
    if (status === 403) return 'この操作は許可されていません';
    if (status === 400) return '入力内容をGoogleが受け付けませんでした';
    if (status >= 500) return 'Googleで一時的なエラーが発生しました。しばらくしてからお試しください';
    return `Googleとの通信でエラーが発生しました（${status}）`;
  }
  return '予期しないエラーが発生しました';
}

function authErrorText(code) {
  if (code === 'access_denied') return 'アクセスが許可されませんでした';
  if (code === 'state_mismatch') return 'ログインの確認に失敗しました。もう一度ログインしてください';
  return `Googleへのログインに失敗しました（コード: ${code || '不明'}）`;
}

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------

async function boot() {
  normalizeUrl();
  S.storage = safeLocalStorage();
  S.configured = isGoogleConfigured();
  S.auth = createAuth({
    clientId: GOOGLE_CLIENT_ID,
    scopes: Object.values(SCOPES),
    redirectUri: redirectUri(location),
    storage: S.storage,
    location,
    history,
  });

  // FIRST: consume an OAuth response in the fragment before anything else looks at the URL.
  let redirect = { status: 'none' };
  try {
    redirect = S.auth.handleRedirect() || redirect;
  } catch (err) {
    warn('handleRedirect failed', describe(err));
  }

  // Capabilities follow what the user granted (granular consent), captured once: a later 401 clears the
  // token but must not turn the UI read-only — it needs a reconnect, not more permissions.
  S.scopes = new Set(S.auth.grantedScopes());

  S.settings = createSettingsStore({ storage: S.storage });
  if (redirect.status === 'success' && S.settings.get().demo) S.settings.set({ demo: false });
  S.route = resolveInitialRoute({
    returnState: redirect.returnState,
    settings: S.settings.get(),
    lastRouteAt: loadRouteAt(S.storage),
  });
  persistRoute();

  S.els = collectElements();
  installGlobalGuards();

  const mode = decideMode();
  // An expired token would start a silent redirect right after the first render. Start it now instead,
  // while only the splash is on screen: no ink surface exists, so nothing can be drawn and lost while
  // the browser navigates to Google (and the page does not appear just to vanish under the pen).
  if (mode === 'google' && redirectBeforeUi(redirect)) return;
  await bootApp(mode, redirect);
}

/** Boot after the mode is known (also resumed from the bfcache when a boot-time redirect was abandoned). */
async function bootApp(initialMode, initialRedirect) {
  let mode = initialMode;
  let redirect = initialRedirect || { status: 'none' };
  if (mode === 'none') {
    hideSplash();
    const errorText = redirect.status === 'error' ? authErrorText(redirect.error) : null;
    mode = await showWelcome({ errorText }); // resolves only with 'demo' (sign-in leaves the page)
    S.settings.set({ demo: true });
    if (errorText) redirect = { status: 'none' }; // already shown on the welcome screen
  }
  S.mode = mode;

  // お試しモード and Google never share a database (demo ink must never reach a real Drive).
  S.kv = await openInkKV(mode);
  if (!S.kv) throw new Error('local storage (KV) unavailable');
  S.deviceId = await getDeviceId(S.kv);
  if (S.mode === 'google') await resolveInkAccount(redirect);
  rememberReturnScroll(redirect);
  composeServices();
  claimWriterLock();
  if (S.settings.get().tool === 'event' && !canWriteEvents()) S.settings.set({ tool: 'pen' });
  createChrome();
  installInteractions();
  showRoute();
  hideSplash();

  handleRedirectOutcome(redirect);
  updateBanner();
  updateHeader();
  if (S.mode === 'google') {
    S.inkStore.flush().catch((err) => warn('initial flush failed', describe(err)));
    maybeSilentReauth('boot');
  }
  if (S.kv.kind === 'memory') {
    notify('この端末に手書きを保存できない状態です（プライベートブラウズなど）。閉じると手書きが失われることがあります', { duration: 8000 });
  }
  offerDraft();
  if (S.mode === 'google') setTimeout(guard(() => maybeOfferDemoInk(), 'demo-ink-offer'), 1500);
  startPeriodicRefresh();
  registerServiceWorker();
  requestPersistentStorage();
}

/**
 * Boot-time silent re-auth before any UI exists (see shouldRedirectBeforeUi). The splash stays up with
 * 「Googleに接続しています…」. Returns true when the browser is navigating to Google.
 */
function redirectBeforeUi(redirect) {
  let go = false;
  try {
    go = shouldRedirectBeforeUi({
      mode: 'google',
      configured: S.configured,
      redirectStatus: redirect ? redirect.status : 'none',
      tokenFresh: tokenIsFresh(),
      everSignedIn: S.auth.hasEverSignedIn(),
      canTrySilent: S.auth.canTrySilent(),
      online: isOnline(),
      visible: document.visibilityState !== 'hidden',
      storageWritable: storageWritable(),
    });
  } catch (err) {
    warn('could not decide on a boot-time sign-in', describe(err));
    go = false;
  }
  if (!go) return false;
  S.leaving = true;
  S.signInPending = true;
  S.bootDeferred = { mode: 'google', redirect: redirect || { status: 'none' } };
  setSplashText('Googleに接続しています…');
  markBooted();
  try {
    S.auth.signIn({ silent: true, returnState: { view: S.route.view, date: toYMD(S.route.date) } });
    noteRedirectStarted();
    return true;
  } catch (err) {
    warn('boot-time sign-in failed to start', describe(err));
    S.leaving = false;
    S.signInPending = false;
    S.bootDeferred = null;
    S.silentFailed = true; // e.g. 'storage unavailable': trying again on this load would fail the same way
    setSplashText(null);
    return false;
  }
}

/** The page's scroll position survives an OAuth round trip (returnState.scroll). */
function rememberReturnScroll(redirect) {
  const ratio = returnScrollRatio(redirect && redirect.returnState);
  if (ratio === null) return;
  try {
    const pageId = pageIdFor(S.route.view, S.route.date, S.settings.get().weekStart);
    if (PAGE_SPECS[S.route.view]?.fit === 'width') S.scrollMemory.set(pageId, ratio);
  } catch (err) {
    warn('could not restore the scroll position', describe(err));
  }
}

/** …/index.html → …/ (the registered redirect URI and the manifest scope are the directory). Keeps the hash. */
function normalizeUrl() {
  try {
    const { pathname, search, hash } = location;
    if (/\/index\.html$/i.test(pathname)) {
      history.replaceState(history.state, '', `${pathname.replace(/index\.html$/i, '')}${search}${hash}`);
    }
  } catch (err) {
    warn('could not normalize the URL', describe(err));
  }
}

function decideMode() {
  if (S.settings.get().demo) return 'demo';
  if (S.configured && (S.auth.isSignedIn() || S.auth.hasEverSignedIn())) return 'google';
  return 'none';
}

function collectElements() {
  const q = (sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`index.html is missing ${sel}`);
    return el;
  };
  return {
    app: q('#app'),
    header: q('header.app-header'),
    banner: q('.banner'),
    sticky: q('.sticky-header'),
    viewport: q('.viewport'),
    toolbar: q('.toolbar'),
    selectionMenu: q('.selection-menu'),
    dialogRoot: q('#dialog-root'),
  };
}

async function getDeviceId(kv) {
  const valid = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v);
  let id = null;
  try {
    const v = await kv.get('deviceId');
    if (valid(v)) id = v;
  } catch (err) {
    warn('could not read deviceId', describe(err));
  }
  // localStorage keeps a copy, so a fresh IndexedDB (or the memory fallback) does not mint a new device.
  const backup = storageGet(DEVICE_ID_KEY);
  if (!id && valid(backup)) id = backup;
  if (!id) id = newId();
  try {
    await kv.set('deviceId', id);
  } catch (err) {
    warn('could not store deviceId', describe(err));
  }
  if (backup !== id) storageSet(DEVICE_ID_KEY, id);
  return id;
}

// ---- local databases: one for Google, one for お試しモード

/** The local database for this mode (お試しモード has its own). Never rejects: null when it cannot be opened. */
async function openInkKV(mode) {
  const open = (dbName, onDegraded = null) => openKV(onDegraded ? { dbName, onDegraded } : { dbName }).catch((err) => {
    warn('openKV failed', dbName, describe(err));
    return null;
  });
  const kv = await open(inkDbName(mode), () => onStorageDegraded());
  if (!kv) return null;
  try {
    const googleKv = mode === 'demo' ? await open(INK_DB_NAMES.google) : kv;
    if (googleKv && googleKv.kind !== 'memory' && !(await googleKv.get(LEGACY_DEMO_CHECKED_KEY))) {
      const demoKv = mode === 'demo' ? kv : await open(INK_DB_NAMES.demo);
      // Bounded; after the timeout the move stops writing (the demo ink store may be using that database),
      // and the next start finishes it.
      const run = { stopped: false };
      const done = demoKv ? await withTimeout(migrateLegacyDemoInk(googleKv, demoKv, run), 5000) : false;
      run.stopped = true;
      // Google mode must not upload ink that may still be demo ink: no Drive until the move is finished.
      if (done !== true && mode === 'google') S.legacyDemoPending = true;
    }
  } catch (err) {
    warn('legacy demo ink check failed', describe(err));
    if (mode === 'google') S.legacyDemoPending = true;
  }
  return kv;
}

/**
 * Until this version お試しモード wrote its ink into the Google database. Once, move such ink to the demo
 * database — only when the Google database was never used with an account (then every page in it is
 * demo ink). Copy first, then drop the 'dirty' list (so nothing of it is ever uploaded), then the pages;
 * the marker comes last, so an interrupted run simply repeats (copies merge).
 */
async function migrateLegacyDemoInk(googleKv, demoKv, run = { stopped: false }) {
  if (googleKv.kind === 'memory' || demoKv.kind === 'memory') return true; // nothing persistent to move
  if (typeof googleKv.keys !== 'function') return true;
  const usedWithGoogle = !!(await googleKv.get(INK_ACCOUNT_KEY)) || (await googleKv.keys('own:')).length > 0;
  const keys = usedWithGoogle ? [] : await googleKv.keys('page:');
  for (const key of keys) {
    const doc = await googleKv.get(key);
    if (!doc || typeof doc !== 'object') continue;
    const existing = await demoKv.get(key);
    if (run.stopped) return false; // copied pages stay (merging again is harmless); nothing was removed yet
    await demoKv.set(key, existing && typeof existing === 'object' ? mergePages(existing, doc) : doc);
  }
  if (run.stopped) return false;
  if (keys.length) {
    await googleKv.del('dirty');
    for (const key of keys) await googleKv.del(key);
    warn(`moved ${keys.length} page(s) of お試しモード ink to its own database`);
  }
  await googleKv.set(LEGACY_DEMO_CHECKED_KEY, Date.now());
  return true;
}

// ---- whose ink is this? (Google mode)

/**
 * Decides at boot whether the local ink may sync with the signed-in account. Right after a sign-in (or
 * when nothing is known) the account is read again first (rememberLoginHint → onAccountKnown): the ink
 * store starts without Drive, so nothing is uploaded into a different account.
 */
async function resolveInkAccount(redirect) {
  if (S.legacyDemoPending) {
    S.inkVerified = false; // finished at the next start; ink waits as 「未送信」 meanwhile
    return;
  }
  try {
    const v = await S.kv.get(INK_ACCOUNT_KEY);
    S.inkAccount = typeof v === 'string' && v ? v : null;
  } catch (err) {
    warn('could not read the ink account', describe(err));
    S.inkAccount = null;
  }
  if (scopesKnown() && !hasScope(SCOPES.calList)) {
    S.inkVerified = true; // the account cannot be read without the calendar list scope: sync as before
    return;
  }
  const justSignedIn = !!redirect && redirect.status === 'success';
  const known = justSignedIn ? null : S.auth.loginHint();
  const decision = decideInkAccount({ bound: S.inkAccount, current: known });
  if (decision === 'match') {
    S.inkVerified = true;
  } else if (decision === 'bind') {
    bindInkAccount(known);
    S.inkVerified = true;
  } else {
    S.inkVerified = false;
    S.refreshHint = true; // read the signed-in account again before any upload
  }
}

function bindInkAccount(id) {
  S.inkAccount = id;
  S.kv.set(INK_ACCOUNT_KEY, id).catch((err) => warn('could not store the ink account', describe(err)));
}

/** The signed-in account is known (primary calendar id): start syncing, or refuse for another account. */
function onAccountKnown(id) {
  if (S.mode !== 'google' || !S.inkStore || S.legacyDemoPending) return; // (binding would mark it as Google ink)
  const decision = decideInkAccount({ bound: S.inkAccount, current: id });
  if (decision === 'unknown') return;
  if (decision === 'mismatch') {
    if (S.inkVerified) {
      S.inkVerified = false;
      try {
        Promise.resolve(S.inkStore.setDrive(null)).catch(() => {});
      } catch (err) {
        warn('setDrive(null) failed', describe(err));
      }
    }
    if (!S.inkMismatch) {
      S.inkMismatch = true;
      notify(ACCOUNT_MISMATCH_MESSAGE, { kind: 'error', duration: 0 });
    }
    setSyncStatus(S.inkStore.getStatus(), null);
    return;
  }
  S.inkMismatch = false;
  if (decision === 'bind') bindInkAccount(id);
  attachInkDrive();
  setTimeout(guard(() => maybeOfferDemoInk(), 'demo-ink-offer'), 500);
}

function attachInkDrive() {
  if (S.inkVerified || !S.inkStore || S.legacyDemoPending || S.stale) return;
  S.inkVerified = true;
  const drive = driveForInk();
  if (!drive) {
    setSyncStatus(S.inkStore.getStatus(), null);
    return;
  }
  try {
    Promise.resolve(S.inkStore.setDrive(drive)).catch((err) => warn('setDrive failed', describe(err)));
  } catch (err) {
    warn('setDrive failed', describe(err));
    return;
  }
  if (S.page) refreshPageInk(S.page);
}

/**
 * Ink written in お試しモード stays in its own database. In Google mode (account confirmed) ask once —
 * until answered — whether to carry it over (then it is merged in and uploaded). Never deleted.
 */
async function maybeOfferDemoInk() {
  if (S.mode !== 'google' || !S.inkStore || !S.inkVerified || S.inkMismatch || S.leaving) return;
  if (S.demoOffer !== 'idle') return;
  if (S.dialogOpen || isDrawing() || S.shield) {
    setTimeout(guard(() => maybeOfferDemoInk(), 'demo-ink-offer'), 5000);
    return;
  }
  S.demoOffer = 'busy';
  try {
    await offerDemoInk();
  } finally {
    if (S.demoOffer === 'busy') S.demoOffer = 'done';
  }
}

async function offerDemoInk() {
  const demoKv = await openKV({ dbName: INK_DB_NAMES.demo }).catch(() => null);
  if (!demoKv || demoKv.kind === 'memory' || typeof demoKv.keys !== 'function') return;
  if (await demoKv.get(DEMO_CARRY_KEY)) return;
  const keys = await demoKv.keys('page:');
  if (!keys.length) return;
  const ok = confirmSafe('お試しモードで書いた手書きが、この端末にあります。\n'
    + 'このGoogleアカウントに引き継いで、Googleドライブに保存しますか？\n\n'
    + '（「キャンセル」を選んでも消えません。お試しモードに切り替えると見られます）');
  if (!ok) {
    await demoKv.set(DEMO_CARRY_KEY, 'declined');
    return;
  }
  let pages = 0;
  let failed = 0;
  for (const key of keys) {
    const pageId = key.slice('page:'.length);
    try {
      const doc = await demoKv.get(key);
      if (!pageId || !doc || typeof doc !== 'object' || !doc.strokes) continue;
      const saved = await track(S.inkStore.save(pageId, { ...doc, pageId }));
      pages += 1;
      if (saved && S.page && S.page.pageId === pageId) applyRemoteInk(pageId, saved);
    } catch (err) {
      failed += 1;
      warn('could not carry over a demo page', describe(err));
    }
  }
  if (failed) {
    // Nothing is lost (the demo database is untouched); the question comes back at the next start.
    notify('お試しモードの手書きの一部を引き継げませんでした。あとでもう一度お試しください', { kind: 'error', duration: 8000 });
    return;
  }
  await demoKv.set(DEMO_CARRY_KEY, 'imported');
  if (pages) notify(`お試しモードの手書き（${pages}ページ）を引き継ぎました`);
}

function confirmSafe(message) {
  try {
    return window.confirm(message) === true;
  } catch {
    return false;
  }
}

function composeServices() {
  if (S.mode === 'google') {
    S.http = createHttp({ getToken: () => S.auth.getToken(), onAuthError: (token) => handleHttpAuthError(token) });
    S.calendarApi = createCalendarApi(S.http);
    S.driveApi = createDriveApi(S.http);
    S.source = createGoogleCalendarSource(S.calendarApi);
  } else {
    S.source = createDemoCalendarSource({ storage: S.storage, now: Date.now });
  }
  S.inkStore = createInkStore({
    kv: S.kv,
    drive: driveForInk(),
    deviceId: S.deviceId,
    onRemoteUpdate: (pageId, doc) => applyRemoteInk(pageId, doc),
    onStatus: (status, detail) => setSyncStatus(status, detail),
  });
  setSyncStatus(S.inkStore.getStatus(), null);
}

/**
 * Drive for the ink store: Google mode, the drive.appdata scope granted and the signed-in account confirmed
 * to own the local ink. The scopes come from the stored token, also when it has expired: uploads then wait
 * as 'pending' (instead of 「この端末のみ」) until re-auth.
 */
function driveForInk() {
  if (S.mode !== 'google' || !S.driveApi || !S.inkVerified) return null;
  return hasScope(SCOPES.appdata) ? S.driveApi : null;
}

/** False when no token record exists at all: what was granted is unknown (a reconnect will tell). */
function scopesKnown() {
  return S.scopes.size > 0;
}

/** Granted to this session's token. Unknown scopes count as granted: the API answers 401 → reconnect. */
function hasScope(scope) {
  return !scopesKnown() || S.scopes.has(scope);
}

function canWriteEvents() {
  if (S.mode === 'demo') return true;
  return S.mode === 'google' && hasScope(SCOPES.events);
}

/** events.list needs calendar.events (calendarlist.readonly is not enough): without it there is nothing to load. */
function canReadEvents() {
  return S.mode !== 'google' || hasScope(SCOPES.events);
}

function handleRedirectOutcome(redirect) {
  if (!redirect || redirect.status === 'none') return;
  if (redirect.status === 'success') {
    S.needsReconnect = false;
    S.refreshHint = true; // possibly another account than the remembered hint
    if (!redirect.silent) notify('Googleに接続しました');
    rememberLoginHint().catch(() => {});
    return;
  }
  // Any error — a failed prompt=none, a cancelled consent, state_mismatch — means no automatic redirect
  // on this load: only the user continues (「再接続」). Never bounce straight back to Google, and never
  // loop when the one-time auth state could not be stored.
  S.silentFailed = true;
  S.needsReconnect = true;
  if (!redirect.silent) notify(authErrorText(redirect.error), { kind: 'error', duration: 8000 });
}

// ---------------------------------------------------------------------------------------------
// Welcome screen (not signed in, not demo, never signed in)
// ---------------------------------------------------------------------------------------------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

function showWelcome({ errorText = null } = {}) {
  return new Promise((resolve) => {
    const root = S.els.dialogRoot;
    S.welcomeOpen = true;

    const loginBtn = el('button', {
      type: 'button', class: 'btn btn-primary welcome-login', disabled: !S.configured,
    }, 'Googleでログイン');
    const demoBtn = el('button', { type: 'button', class: 'btn welcome-demo' }, 'お試しモードで使ってみる');
    const status = el('p', { class: 'field-error welcome-error', role: 'alert', hidden: !errorText }, errorText || '');

    const resetButtons = () => {
      loginBtn.disabled = !S.configured;
      loginBtn.textContent = 'Googleでログイン';
      demoBtn.disabled = false;
    };
    S.pageShowHooks.add(resetButtons);

    loginBtn.addEventListener('click', guard(async () => {
      if (!S.configured || S.signInPending) return;
      loginBtn.disabled = true;
      demoBtn.disabled = true;
      loginBtn.textContent = '接続中…';
      const started = await startSignIn();
      if (!started) resetButtons();
    }, 'welcome-login'));

    demoBtn.addEventListener('click', () => {
      S.welcomeOpen = false;
      S.pageShowHooks.delete(resetButtons);
      screen.remove();
      resolve('demo');
    });

    // Structure expected by styles/app.css: div.welcome (the card) > img, h1, ul, actions, notes.
    const screen = el('div', {
      class: 'welcome', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'welcome-title',
    },
    el('img', { class: 'welcome-icon', src: 'icons/icon-192.png', alt: '', width: '64', height: '64' }),
    el('h1', { class: 'welcome-title', id: 'welcome-title' }, '手書きカレンダー'),
    el('ul', { class: 'welcome-points' },
      el('li', {}, 'Googleカレンダーの予定を、日・週・月のページで表示します'),
      el('li', {}, 'Apple Pencil で、紙の手帳のように自由に書き込めます（手書きはGoogleドライブに保存）'),
      el('li', {}, '時間をなぞったり、書いた文字を囲んだりして、そのまま予定を登録できます')),
    status,
    el('div', { class: 'welcome-actions' },
      loginBtn,
      S.configured ? null : el('p', { class: 'note welcome-note' }, NOT_CONFIGURED_MESSAGE),
      demoBtn),
    isStandalone() ? null : el('p', { class: 'hint welcome-hint' },
      'ホーム画面に追加すると、アプリとして使えます（共有ボタン →『ホーム画面に追加』）'),
    tabStorageRisk() ? el('p', { class: 'note welcome-note welcome-storage-note' }, TAB_STORAGE_WARNING) : null);
    root.append(screen);
    try {
      (S.configured ? loginBtn : demoBtn).focus({ preventScroll: true });
    } catch {
      // ignore
    }
  });
}

/** Tells js/boot-watchdog.js that main.js is running (no 「再読み込み」 rescue buttons needed). */
function markBooted() {
  try {
    window.__tegakiBooted = true;
  } catch {
    // ignore
  }
}

function hideSplash() {
  markBooted();
  const splash = document.getElementById('boot-splash');
  if (splash) splash.remove();
}

/** Replaces the splash message (null restores the original). */
function setSplashText(text) {
  try {
    const node = document.querySelector('#boot-splash .boot-splash-text');
    if (!node) return;
    if (!('original' in node.dataset)) node.dataset.original = node.textContent || '';
    node.textContent = text === null ? node.dataset.original : text;
  } catch {
    // ignore
  }
}

function showFatal(err) {
  markBooted();
  warn('boot failed', describe(err));
  const splash = document.getElementById('boot-splash');
  const target = splash || document.body;
  const box = el('div', { class: 'boot-splash', role: 'alert' },
    el('div', {}, '手書きカレンダーを起動できませんでした。'),
    el('div', { class: 'boot-splash-detail' }, '再読み込みしても直らない場合は、少し時間をおいてお試しください。'),
    el('button', { type: 'button', class: 'btn btn-primary', onclick: () => location.reload() }, '再読み込み'));
  if (splash) splash.replaceWith(box);
  else target.append(box);
}

// ---------------------------------------------------------------------------------------------
// Chrome: header, toolbar, selection menu, page DOM, ink surface
// ---------------------------------------------------------------------------------------------

function safeCreate(label, factory, fallback) {
  try {
    const ui = factory();
    return ui && typeof ui === 'object' ? ui : fallback;
  } catch (err) {
    warn(`could not create ${label}`, describe(err));
    return fallback;
  }
}

function createChrome() {
  S.ui.header = safeCreate('header', () => createHeader(S.els.header, {
    onPrev: guard(() => goRelative(-1), 'prev'),
    onNext: guard(() => goRelative(1), 'next'),
    onToday: guard(() => goToday(), 'today'),
    onView: guard((view) => switchView(view), 'view'),
    onAddEvent: guard(() => addEventFlow(), 'add-event'),
    onSettings: guard(() => settingsFlow(), 'settings'),
    onSyncTap: guard(() => syncTap(), 'sync'),
    onAuthTap: guard(() => authTap(), 'auth'),
  }), NOOP_UPDATER);

  S.ui.toolbar = safeCreate('toolbar', () => createToolbar(S.els.toolbar, {
    onTool: guard((tool) => selectTool(tool), 'tool'),
    onPenColor: guard((color) => S.settings.set({ penColor: color, tool: 'pen' }), 'pen-color'),
    onPenSize: guard((size) => S.settings.set({ penSize: size, tool: 'pen' }), 'pen-size'),
    onHlColor: guard((color) => S.settings.set({ hlColor: color, tool: 'highlighter' }), 'hl-color'),
    onUndo: guard(() => undo(), 'undo'),
    onRedo: guard(() => redo(), 'redo'),
    onToggleCollapse: (collapsed) => storageSet(TOOLBAR_COLLAPSED_KEY, collapsed ? '1' : '0'),
  }), NOOP_UPDATER);
  if (storageGet(TOOLBAR_COLLAPSED_KEY) === '1') S.ui.toolbar.update({ collapsed: true });

  S.ui.selectionMenu = safeCreate('selection menu', () => createSelectionMenu(S.els.selectionMenu, {
    onConvert: guard(() => convertSelectionFlow(), 'convert'),
    onDelete: guard(() => {
      S.surface?.deleteSelection();
      S.ui.selectionMenu.hide();
    }, 'delete-selection'),
    onDeselect: guard(() => {
      S.surface?.clearSelection();
      S.ui.selectionMenu.hide();
    }, 'deselect'),
  }), NOOP_MENU);

  S.pageEls = createPageElements(S.els.viewport);

  S.settings.subscribe(guard((st, prev, changed) => onSettingsChanged(st, prev, changed), 'settings-change'));
}

/** Created on the first showRoute(), once the page has a size (getPageInfo must describe a real page). */
function createSurface() {
  try {
    S.surface = new InkSurface({
      pageEl: S.pageEls.pageEl,
      viewportEl: S.els.viewport,
      getPageInfo,
      onCommit: guard((doc, op) => handleCommit(doc, op), 'ink-commit'),
      onSelectionChange: guard((sel) => handleSelectionChange(sel), 'selection'),
      onEventRect: guard((rect, info) => handleEventRect(rect, info), 'event-rect'),
      onEventPreview: (rect) => previewEventRect(rect),
    });
    S.surface.setAllowFinger(S.settings.get().allowFinger);
    applyToolToSurface();
  } catch (err) {
    S.surface = null;
    warn('InkSurface failed', describe(err));
    notify('手書き機能を開始できませんでした。再読み込みしてください', { duration: 8000 });
  }
}

function getPageInfo() {
  const p = S.page;
  if (!p) {
    const spec = PAGE_SPECS[S.route.view] || PAGE_SPECS.week;
    return { pageId: '', W: spec.W, H: spec.H, scale: 1, view: S.route.view, range: null };
  }
  return { pageId: p.pageId, W: p.spec.W, H: p.spec.H, scale: p.layout?.scale || 1, view: p.view, range: p.range };
}

function onSettingsChanged(st, prev, changed) {
  const has = (k) => changed.includes(k);
  if (has('tool') || has('penColor') || has('penSize') || has('hlColor')) {
    applyToolToSurface();
    updateToolbar();
  }
  if (has('allowFinger')) S.surface?.setAllowFinger(st.allowFinger);
  if (has('weekStart')) {
    showRoute(); // week page ids and month grids depend on it
  } else if (has('hiddenCalendarIds')) {
    renderView();
    if (S.page) loadEvents(S.page);
  }
}

// ---------------------------------------------------------------------------------------------
// Tools, undo/redo
// ---------------------------------------------------------------------------------------------

function selectTool(tool) {
  if (!['pen', 'highlighter', 'eraser', 'lasso', 'event'].includes(tool)) return;
  if (tool === 'event' && !canWriteEvents()) {
    notify(READ_ONLY_MESSAGE);
    return;
  }
  S.settings.set({ tool });
  updateToolbar();
}

function applyToolToSurface() {
  if (!S.surface) return;
  const st = S.settings.get();
  const tool = st.tool === 'event' && !canWriteEvents() ? 'pen' : st.tool;
  const color = tool === 'highlighter' ? st.hlColor : st.penColor;
  const size = tool === 'highlighter' ? HIGHLIGHTER_SIZE : (PEN_SIZES[st.penSize] ?? PEN_SIZES.medium);
  S.surface.setTool({ tool, color, size });
}

function updateToolbar() {
  const st = S.settings.get();
  S.ui.toolbar.update({
    tool: st.tool,
    penColor: st.penColor,
    penSize: st.penSize,
    hlColor: st.hlColor,
    canUndo: !!S.surface?.canUndo(),
    canRedo: !!S.surface?.canRedo(),
  });
}

function undo() {
  if (!S.surface) return;
  S.surface.undo();
  updateToolbar();
}

function redo() {
  if (!S.surface) return;
  S.surface.redo();
  updateToolbar();
}

// ---------------------------------------------------------------------------------------------
// Routing & page rendering
// ---------------------------------------------------------------------------------------------

function persistRoute() {
  S.settings.set({ view: S.route.view, date: toYMD(S.route.date) });
  saveRouteAt(S.storage, Date.now());
}

function goTo(view, date) {
  if (isDrawing()) return; // never switch pages in the middle of a stroke
  const v = VIEWS.includes(view) ? view : S.route.view;
  const d = isValidDate(date) ? startOfDay(date) : startOfDay(new Date());
  S.route = { view: v, date: d };
  persistRoute();
  showRoute();
}

function goRelative(delta) {
  goTo(S.route.view, navigate(S.route.view, S.route.date, delta));
}

function goToday() {
  const today = startOfDay(new Date());
  const p = S.page;
  if (p && pageContainsDay(p, today) && p.spec.fit === 'width') {
    if (!isDrawing()) scrollToInitial(p, { smooth: true });
    return;
  }
  goTo(S.route.view, today);
}

/** View switch keeps the focused date; today wins when it is on the current page. */
function switchView(view) {
  if (!VIEWS.includes(view) || view === S.route.view) return;
  const today = startOfDay(new Date());
  const date = S.page && pageContainsDay(S.page, today) ? today : S.route.date;
  goTo(view, date);
}

function pageContainsDay(p, day) {
  if (p.view === 'month') {
    const m = p.range.monthStart || p.date;
    return day.getFullYear() === m.getFullYear() && day.getMonth() === m.getMonth();
  }
  return day >= p.range.start && day < p.range.end;
}

/**
 * Shows S.route. The page DOM and the ink surface are created once and reused: a new page re-renders the
 * grid/events, gives the surface an empty doc of the new page id (so nothing of the previous page can leak
 * into it), resizes its canvases for the new page spec, then loads the page's ink from the ink store.
 */
function showRoute() {
  const prev = S.page;
  const { view, date } = S.route;
  const weekStart = S.settings.get().weekStart;
  const spec = PAGE_SPECS[view];
  const range = rangeFor(view, date, weekStart);
  const pageId = pageIdFor(view, date, weekStart);
  const cacheId = `${pageId}@${toYMD(range.start)}`;
  const samePage = !!prev && prev.pageId === pageId;

  S.ui.selectionMenu.hide();
  let p;
  if (samePage) {
    p = prev;
    Object.assign(p, { date, range, cacheId });
  } else {
    if (prev) leavePage(prev);
    p = { pageId, cacheId, view, date, range, spec, layout: null, loaded: false, pendingLocal: null };
  }
  S.page = p;

  layoutPage(p);
  renderView();
  if (!S.surface) createSurface();
  if (S.surface) {
    if (!samePage) S.surface.setDoc(emptyPage(pageId), { resetHistory: true });
    S.surface.resize();
  }
  if (!samePage) scrollToInitial(p);
  updateHeader();
  updateBanner(); // the offline banner names the time of this page's events
  updateToolbar();
  if (!samePage) loadPageInk(p);
  loadEvents(p);
}

/** Bookkeeping when navigating away from a page. */
function leavePage(prev) {
  const ratio = scrollRatio();
  if (ratio !== null && prev.spec.fit === 'width') S.scrollMemory.set(prev.pageId, ratio);
  if (S.scrollMemory.size > 60) S.scrollMemory.delete(S.scrollMemory.keys().next().value);
  S.surface?.clearSelection();
  savePendingLocal(prev);
}

/** Strokes drawn before a page's stored ink finished loading: merge them into the stored doc now. */
function savePendingLocal(p) {
  if (!p || p.loaded || !p.pendingLocal || !S.inkStore) return;
  const pending = p.pendingLocal;
  p.pendingLocal = null;
  track(S.inkStore.load(p.pageId)
    .then((stored) => S.inkStore.save(p.pageId, mergePages(stored, pending)))
    .catch((err) => warn('could not save ink of the page', describe(err))));
}

function layoutPage(p) {
  const vp = S.els.viewport;
  p.layout = applyPageScale({ viewportEl: vp, pageEl: S.pageEls.pageEl, spec: p.spec });
  S.lastSize = { w: vp.clientWidth, h: vp.clientHeight };
}

function visibleEvents(p) {
  const entry = S.eventsCache.get(p.cacheId);
  if (!entry) return [];
  const hidden = new Set(S.settings.get().hiddenCalendarIds);
  return entry.events.filter((e) => e && !hidden.has(e.calendarId));
}

/** Draws grid + events + sticky header of the current page (idempotent; the ink canvases are untouched). */
function renderView() {
  const p = S.page;
  if (!p || !S.pageEls) return;
  // A new all-day row makes the sticky header taller: the page must not move under the pen.
  keepContentStill(() => renderViewNow(p));
}

function renderViewNow(p) {
  const mod = VIEW_MODULES[p.view];
  try {
    mod.render({
      pageEl: S.pageEls.pageEl,
      gridEl: S.pageEls.gridEl,
      eventsEl: S.pageEls.eventsEl,
      stickyEl: S.els.sticky,
      layout: p.layout,
      date: p.date,
      range: p.range,
      events: visibleEvents(p),
      settings: S.settings.get(),
      now: new Date(),
      onEventTap: guard((ev) => editEventFlow(ev), 'event-tap'),
      onDayTap: guard((day) => goTo('day', day), 'day-tap'),
    });
  } catch (err) {
    warn('render failed', describe(err));
    notifyOnce('render', 'ページを表示できませんでした', 30 * 1000, { kind: 'error' });
  }
}

// ---- scrolling

/** Scroll position as the ratio of the viewport center over the content height (null if no scroll). */
function scrollRatio() {
  const vp = S.els.viewport;
  const sh = vp.scrollHeight;
  if (!sh) return null;
  return (vp.scrollTop + vp.clientHeight / 2) / sh;
}

function restoreScrollRatio(ratio) {
  if (ratio === null || !Number.isFinite(ratio)) return;
  const vp = S.els.viewport;
  const max = Math.max(0, vp.scrollHeight - vp.clientHeight);
  vp.scrollTop = clamp(ratio * vp.scrollHeight - vp.clientHeight / 2, 0, max);
}

/** First show of a page: day/week scroll to initialScrollMinutes (revisits restore their position). */
function scrollToInitial(p, { smooth = false } = {}) {
  const vp = S.els.viewport;
  vp.scrollLeft = 0;
  if (p.spec.fit !== 'width') {
    vp.scrollTop = 0;
    return;
  }
  if (!smooth && S.scrollMemory.has(p.pageId)) {
    restoreScrollRatio(S.scrollMemory.get(p.pageId));
    return;
  }
  let minutes = 7 * 60;
  try {
    const m = VIEW_MODULES[p.view].initialScrollMinutes({
      date: p.date, now: new Date(), range: p.range, weekStart: S.settings.get().weekStart,
    });
    if (Number.isFinite(m)) minutes = clamp(m, 0, 1440);
  } catch (err) {
    warn('initialScrollMinutes failed', describe(err));
  }
  const y = minutesToY(p.view, minutes) * (p.layout?.scale || 1);
  const top = clamp(y, 0, Math.max(0, vp.scrollHeight - vp.clientHeight));
  if (smooth && typeof vp.scrollTo === 'function') vp.scrollTo({ top, behavior: 'smooth' });
  else vp.scrollTop = top;
  markSettling();
}

/**
 * Until the user first touches, scrolls or types, banners and sticky-header rows appearing above the
 * viewport must not push the initial hour off the top (keepPageInPlace skips its compensation while
 * the page carries data-settling). Ends on the first interaction or after a few seconds.
 */
function markSettling() {
  const pageEl = S.pageEls?.pageEl;
  const vp = S.els.viewport;
  if (!pageEl || !vp) return;
  if (S.settlingCleanup) S.settlingCleanup();
  pageEl.dataset.settling = '1';
  const events = ['pointerdown', 'wheel', 'touchstart', 'keydown'];
  let timer = null;
  const end = () => {
    delete pageEl.dataset.settling;
    for (const type of events) vp.removeEventListener(type, end, true);
    window.removeEventListener('keydown', end, true);
    if (timer !== null) clearTimeout(timer);
    S.settlingCleanup = null;
  };
  for (const type of events) vp.addEventListener(type, end, { capture: true, passive: true });
  window.addEventListener('keydown', end, { capture: true, passive: true });
  timer = setTimeout(end, 4000);
  S.settlingCleanup = end;
}

function viewportTop() {
  try {
    return S.els.viewport.getBoundingClientRect().top;
  } catch {
    return NaN;
  }
}

/**
 * Runs a change that may move the viewport (sticky header rows, banner). The page itself is kept at the
 * same place on screen by the code that makes the change — the views' render() and showBanner()/
 * hideBanner() (keepPageInPlace in view-common.js) scroll by the header delta synchronously — so this only
 * records the new viewport top for relayout() (compensating here too would scroll twice).
 */
function keepContentStill(fn) {
  try {
    fn();
  } finally {
    S.lastTop = viewportTop();
  }
}

/**
 * Viewport size changed. Same width (only the height changed: all-day rows, banner, header): keep the
 * content still on screen. Width changed (rotation, split view, Stage Manager): re-scale and keep the
 * scroll ratio.
 */
function relayout() {
  const p = S.page;
  if (!p) return;
  const vp = S.els.viewport;
  if (vp.clientWidth === S.lastSize.w && vp.clientHeight === S.lastSize.h) return;
  const sameWidth = vp.clientWidth === S.lastSize.w;
  const ratio = scrollRatio();
  const scrollTop = vp.scrollTop;
  const prevTop = S.lastTop;
  layoutPage(p);
  renderView();
  S.surface?.resize();
  const top = viewportTop();
  if (p.spec.fit === 'width') {
    if (sameWidth && Number.isFinite(prevTop) && Number.isFinite(top)) vp.scrollTop = scrollTop + (top - prevTop);
    else restoreScrollRatio(ratio);
  }
  S.lastTop = top;
}

// ---------------------------------------------------------------------------------------------
// Ink
// ---------------------------------------------------------------------------------------------

function track(promise) {
  const p = Promise.resolve(promise);
  S.pendingSaves.add(p);
  p.finally(() => S.pendingSaves.delete(p)).catch(() => {});
  return p;
}

/** Resolves when every local ink save started so far has been written (or after timeoutMs). */
function settleSaves(timeoutMs = LEAVE_SAVE_TIMEOUT_MS) {
  if (!S.pendingSaves.size) return Promise.resolve();
  return withTimeout(Promise.allSettled([...S.pendingSaves]), timeoutMs);
}

async function loadPageInk(p) {
  if (!S.inkStore) return;
  let stored;
  try {
    stored = await S.inkStore.load(p.pageId);
  } catch (err) {
    warn('ink load failed', describe(err));
    stored = emptyPage(p.pageId);
  }
  if (S.page !== p) return; // navigated away (leavePage saved anything drawn meanwhile)
  if (S.inkStore.isUnreadable?.(p.pageId)) {
    notifyOnce('ink-unreadable', 'この日の手書きを読み込めませんでした（保存されている手書きは消えていません。再読み込みで戻ることがあります）',
      60 * 1000, { kind: 'error', duration: 6000 });
  }
  const current = S.surface?.getDoc();
  const merged = current && current.pageId === p.pageId ? mergePages(stored, current) : stored;
  p.loaded = true;
  if (S.surface && !(current && current.pageId === p.pageId && sameContent(current, merged))) {
    S.surface.setDoc(merged, { resetHistory: false }); // keeps the undo stack of strokes drawn while loading
  }
  if (p.pendingLocal) {
    p.pendingLocal = null;
    saveInk(p.pageId, merged);
  }
  updateToolbar();
  refreshPageInk(p).finally(() => carryLegacyInk(p));
}

/**
 * Handwriting from before 1.0.4 on Sunday-start week / month pages (see ink/legacy-week-start.js) is
 * copied onto this Monday-start page, on the same dates. Marked done per page once the old pages were
 * read both locally and from Drive (お試しモード: locally), so later visits cost nothing.
 */
async function carryLegacyInk(p) {
  const sources = legacySourcesFor(p.pageId);
  if (!sources.length || !S.inkStore || !S.kv) return;
  const doneKey = `legacyWeekStart:${p.pageId}`;
  try {
    if (await S.kv.get(doneKey)) return;
    const docs = new Map();
    let refreshFailed = false;
    for (const id of sources) {
      try {
        await S.inkStore.refresh(id); // merges the Drive copies of the old page into the local one
      } catch (err) {
        refreshFailed = true;
        warn('legacy ink refresh failed', describe(err));
      }
      docs.set(id, await S.inkStore.load(id));
    }
    // refresh() also reports failures through the status; anything but 'synced' means "try again later".
    const remoteRead = S.mode === 'demo' || (!refreshFailed && S.inkStore.getStatus() === 'synced');
    if (S.page !== p || !p.loaded || !S.surface) return; // navigated away: the next visit copies them
    const strokes = legacyStrokesFor(p.pageId, docs);
    if (strokes.length) {
      const current = S.surface.getDoc();
      if (!current || current.pageId !== p.pageId) return;
      const merged = addStrokes(current, strokes); // copies already there (or erased) are skipped
      if (!sameContent(current, merged)) {
        S.surface.setDoc(merged, { resetHistory: false });
        updateToolbar();
        // Persist before marking the page done: on an empty page the copies exist nowhere else yet.
        await S.inkStore.save(p.pageId, merged);
      }
    }
    if (remoteRead) await S.kv.set(doneKey, true);
  } catch (err) {
    warn('legacy ink copy failed', describe(err));
  }
}

/** Pulls remote ink for a page (merge happens in applyRemoteInk via onRemoteUpdate / the return value). */
async function refreshPageInk(p) {
  if (!S.inkStore || !p || !p.loaded) return;
  try {
    const merged = await S.inkStore.refresh(p.pageId);
    if (merged) applyRemoteInk(p.pageId, merged);
  } catch (err) {
    warn('ink refresh failed', describe(err));
  }
}

/** Remote (or store-side) content for a page: merge it into what is on screen, keeping undo history. */
function applyRemoteInk(pageId, doc) {
  const p = S.page;
  if (!p || p.pageId !== pageId || !p.loaded || !S.surface || !doc || typeof doc !== 'object') return;
  const current = S.surface.getDoc();
  if (!current || current.pageId !== pageId) return;
  const merged = mergePages(current, doc);
  if (sameContent(current, merged)) return;
  S.surface.setDoc(merged, { resetHistory: false });
  updateToolbar();
  // The screen had strokes the store had not seen yet: persist the union.
  if (!sameContent(merged, doc)) saveInk(pageId, merged);
}

function handleCommit(doc) {
  updateToolbar();
  if (!doc || typeof doc !== 'object') return;
  const p = S.page;
  const pageId = typeof doc.pageId === 'string' && doc.pageId ? doc.pageId : p?.pageId;
  if (!pageId) return;
  if (p && pageId === p.pageId && !p.loaded) {
    p.pendingLocal = doc; // saved (merged with the stored ink) as soon as the page has loaded
    return;
  }
  saveInk(pageId, doc);
}

function saveInk(pageId, doc) {
  if (!S.inkStore) return;
  track(Promise.resolve()
    .then(() => S.inkStore.save(pageId, doc))
    .catch((err) => {
      warn('ink save failed', describe(err));
      notifyOnce('ink-save', '手書きをこの端末に保存できませんでした。ストレージの空き容量を確認してください', 60 * 1000, { kind: 'error', duration: 6000 });
    }));
}

function setSyncStatus(status, detail) {
  S.syncStatus = typeof status === 'string' ? status : 'local';
  // Drive is attached only once the account is confirmed: meanwhile the ink waits as 「未送信」, not 「この端末のみ」.
  if (S.syncStatus === 'local' && S.mode === 'google' && !S.inkVerified && !S.inkMismatch && hasScope(SCOPES.appdata)) {
    S.syncStatus = 'pending';
  }
  S.syncMessage = detail && typeof detail.message === 'string' ? detail.message : null;
  updateHeader();
  if (S.syncStatus === 'error' && S.syncMessage) notifyOnce('sync-error', S.syncMessage, 10 * 60 * 1000, { kind: 'error', duration: 6000 });
}

// ---------------------------------------------------------------------------------------------
// Calendars & events
// ---------------------------------------------------------------------------------------------

async function ensureCalendars({ force = false } = {}) {
  if (!S.source) return S.calendars;
  const fresh = S.calendarsAt > 0 && Date.now() - S.calendarsAt < CALENDARS_STALE_MS;
  if (!force && fresh) return S.calendars;
  if (S.calendarsLoading) return S.calendarsLoading;
  const job = (async () => {
    try {
      const list = await S.source.listCalendars();
      S.calendars = (Array.isArray(list) ? list : []).filter((c) => c && typeof c.id === 'string' && c.id);
      S.calendarsAt = Date.now();
      applyCalendarDefaults();
      rememberLoginHint().catch(() => {});
      return S.calendars;
    } finally {
      S.calendarsLoading = null;
    }
  })();
  S.calendarsLoading = job;
  return job;
}

/** Same as ensureCalendars() but never rejects (dialogs work with whatever is known). */
async function ensureCalendarsQuiet() {
  try {
    await ensureCalendars();
  } catch (err) {
    if (isAuthError(err)) onAuthRequired('api');
    else warn('calendar list failed', describe(err));
  }
  return S.calendars;
}

/** Calendars seen for the first time follow Google's own visibility ('selected'). */
function applyCalendarDefaults() {
  const st = S.settings.get();
  const r = reconcileCalendarVisibility({
    calendars: S.calendars,
    hiddenCalendarIds: st.hiddenCalendarIds,
    seenIds: loadSeenCalendarIds(S.storage),
  });
  if (!r.changed) return;
  saveSeenCalendarIds(S.storage, r.seenIds);
  S.settings.set({ hiddenCalendarIds: r.hiddenCalendarIds });
}

function visibleCalendarIds() {
  const hidden = new Set(S.settings.get().hiddenCalendarIds);
  return S.calendars.filter((c) => !c.holiday && !hidden.has(c.id)).map((c) => c.id);
}

function writableCalendars() {
  return S.calendars.filter((c) => c.writable && !c.holiday);
}

function defaultCalendarId() {
  const list = writableCalendars();
  const pref = S.settings.get().defaultCalendarId;
  if (pref && list.some((c) => c.id === pref)) return pref;
  return (list.find((c) => c.primary) || list[0])?.id ?? null;
}

/**
 * Events of a page: cached events are shown immediately (stale-while-revalidate; after a cold start the
 * last fetched events come from the local database, so an offline start does not show an empty week);
 * a fetch runs when the cache is missing, older than EVENTS_STALE_MS, for another calendar selection, or
 * when forced. Only the newest request per page may write the cache.
 */
function loadEvents(p, { force = false } = {}) {
  if (!S.source || !p) return Promise.resolve();
  if (!canReadEvents()) return Promise.resolve(); // no calendar.events: Google would answer 403 for every calendar
  const cacheId = p.cacheId;
  if (!force && S.eventsInflight.has(cacheId)) return S.eventsInflight.get(cacheId);
  const seq = ++S.seq;
  S.eventsSeq.set(cacheId, seq);
  const range = p.range;
  const job = (async () => {
    try {
      if (!S.eventsCache.has(cacheId)) await restoreEvents(cacheId);
      await ensureCalendars();
      const ids = visibleCalendarIds();
      const key = `${S.mode}|${[...ids].sort().join(',')}`;
      const entry = S.eventsCache.get(cacheId);
      if (!force && entry && entry.key === key && Date.now() - entry.at < EVENTS_STALE_MS) return;
      const events = ids.length ? await S.source.listEvents(ids, range.start, range.end) : [];
      if (S.eventsSeq.get(cacheId) !== seq) return; // a newer request owns this page
      let list = Array.isArray(events) ? [...events] : [];
      // Some calendars failed (the rest is fine): keep what we knew of those instead of showing them as gone.
      const failedIds = Array.isArray(events?.failedCalendarIds) ? events.failedCalendarIds : [];
      const latest = S.eventsCache.get(cacheId);
      if (failedIds.length && latest) {
        list = list.concat(latest.events.filter((e) => e && failedIds.includes(e.calendarId)));
      }
      const offline = failedIds.length > 0 && isOfflineError(events.firstError);
      setOfflineEvents(offline);
      const partial = failedIds.length > 0 && !offline;
      // A partial result is shown, but not kept offline and not treated as fresh (refetched next time).
      putEvents(cacheId, list, key, { persist: failedIds.length === 0, at: partial ? 0 : Date.now() });
      if (partial) notifyOnce('partial-events', '一部のカレンダーの予定を読み込めませんでした', 5 * 60 * 1000);
      if (S.page && S.page.cacheId === cacheId) renderView();
    } catch (err) {
      handleBackgroundError(err, 'events');
    } finally {
      if (S.eventsInflight.get(cacheId) === job) S.eventsInflight.delete(cacheId);
    }
  })();
  S.eventsInflight.set(cacheId, job);
  return job;
}

function putEvents(cacheId, events, key, { at = Date.now(), persist = false } = {}) {
  S.eventsCache.delete(cacheId); // re-insert: Map order doubles as LRU order
  const entry = { events, key, at };
  S.eventsCache.set(cacheId, entry);
  while (S.eventsCache.size > EVENT_CACHE_LIMIT) S.eventsCache.delete(S.eventsCache.keys().next().value);
  if (persist) persistEvents(cacheId, entry);
}

/** Google mode: keeps the last fetched events of a page in the local database (LRU, EVENT_CACHE_LIMIT pages). */
function persistEvents(cacheId, entry) {
  const kv = S.kv;
  if (S.mode !== 'google' || !kv || S.leaving) return;
  // Tagged with the account: another account must never see these, even offline.
  const data = { ...encodeEventsEntry(entry), account: eventsAccount() };
  S.eventsPersist = S.eventsPersist.then(async () => {
    await kv.set(EVENTS_KV_PREFIX + cacheId, data);
    const { list, evicted } = touchLru(await kv.get(EVENTS_INDEX_KEY), cacheId, EVENT_CACHE_LIMIT);
    await kv.set(EVENTS_INDEX_KEY, list);
    for (const id of evicted) await kv.del(EVENTS_KV_PREFIX + id);
  }).catch((err) => warn('could not keep the events offline', describe(err)));
}

/** Cold start: the page's last known events from the local database (shown at once, then revalidated). */
async function restoreEvents(cacheId) {
  if (S.mode !== 'google' || !S.kv) return;
  let entry = null;
  try {
    const raw = await S.kv.get(EVENTS_KV_PREFIX + cacheId);
    if (raw && typeof raw === 'object' && raw.account === eventsAccount()) entry = decodeEventsEntry(raw);
  } catch (err) {
    warn('could not read the stored events', describe(err));
  }
  if (!entry || !entry.key.startsWith(`${S.mode}|`) || S.eventsCache.has(cacheId)) return;
  putEvents(cacheId, entry.events, entry.key, { at: entry.at });
  if (S.page && S.page.cacheId === cacheId) {
    renderView();
    updateBanner();
  }
}

function eventsAccount() {
  return String(S.auth?.loginHint() || '').toLowerCase();
}

function setOfflineEvents(on) {
  if (S.offlineEvents === !!on) return;
  S.offlineEvents = !!on;
  updateBanner();
}

function cachedEvents(p) {
  return S.eventsCache.get(p?.cacheId)?.events || [];
}

/** Optimistic update after create/update/delete, then a forced refetch; other pages revalidate on visit. */
function applyEventChange({ added = null, removed = null } = {}) {
  const p = S.page;
  for (const [id, entry] of S.eventsCache) if (!p || id !== p.cacheId) entry.at = 0;
  if (!p) return;
  const entry = S.eventsCache.get(p.cacheId) || { events: [], key: '', at: 0 };
  let list = entry.events;
  if (removed) list = list.filter((e) => !(e.id === removed.id && e.calendarId === removed.calendarId));
  if (added && isValidDate(added.start) && isValidDate(added.end)
    && added.start < p.range.end && added.end > p.range.start) {
    list = [...list.filter((e) => !(e.id === added.id && e.calendarId === added.calendarId)), added];
  }
  S.eventsCache.set(p.cacheId, { ...entry, events: list, at: 0 });
  renderView();
  loadEvents(p, { force: true });
}

function handleBackgroundError(err, what) {
  if (isAuthError(err)) {
    onAuthRequired('api');
    return;
  }
  if (isOfflineError(err)) {
    setOfflineEvents(true); // the banner tells (with the time of the events shown)
    return;
  }
  warn(what, describe(err));
  notifyOnce(`bg:${what}`, `予定を読み込めませんでした。${errorMessage(err)}`, 2 * 60 * 1000, { kind: 'error' });
}

/** The primary calendar id is the account's email → login_hint for silent re-auth. */
async function rememberLoginHint() {
  if (S.mode !== 'google' || !S.auth.isSignedIn()) return;
  if (!S.refreshHint && S.auth.loginHint()) return;
  const looksLikeEmail = (v) => typeof v === 'string' && /^[^@\s]+@[^@\s]+$/.test(v);
  const remember = (id) => {
    S.auth.setLoginHint(id);
    S.refreshHint = false;
    onAccountKnown(id);
  };
  const primary = S.calendars.find((c) => c.primary && looksLikeEmail(c.id));
  if (primary) {
    remember(primary.id);
    return;
  }
  if (S.calendarsAt === 0 || !S.calendarApi) return; // the calendar list will call us again
  if (!hasScope(SCOPES.calList)) return; // calendarList.get needs the same scope as the list (would 403)
  try {
    // calendarList.get (calendars.get would need a scope we do not request → 403).
    const id = await S.calendarApi.getPrimaryCalendarId();
    if (looksLikeEmail(id)) remember(id);
  } catch (err) {
    warn('could not determine the account for login_hint', describe(err));
  }
}

// ---------------------------------------------------------------------------------------------
// Event dialogs: create / edit / delete / convert ink
// ---------------------------------------------------------------------------------------------

/** Validates an EventInput coming back from the dialog (or a draft). */
const normalizeInput = normalizeEventInput;

function eventToInput(ev) {
  return {
    title: typeof ev.title === 'string' ? ev.title : '',
    description: typeof ev.description === 'string' ? ev.description : '',
    location: typeof ev.location === 'string' ? ev.location : '',
    allDay: ev.allDay === true,
    start: ev.start,
    end: ev.end,
  };
}

/** Opens the event dialog modally; never rejects. */
async function runEventDialog(opts) {
  if (S.dialogOpen) return { action: 'cancel' };
  S.dialogOpen = true;
  S.ui.selectionMenu.hide();
  try {
    const r = await openEventDialog(opts);
    return r && typeof r === 'object' ? r : { action: 'cancel' };
  } catch (err) {
    warn('event dialog failed', describe(err));
    notify('予定の画面を開けませんでした');
    return { action: 'cancel' };
  } finally {
    S.dialogOpen = false;
    refreshSelectionMenu();
  }
}

function refreshSelectionMenu() {
  const sel = S.surface?.getSelection();
  if (sel && sel.ids && sel.ids.length && sel.screenRect && !S.dialogOpen) S.ui.selectionMenu.show(sel.screenRect);
  else S.ui.selectionMenu.hide();
}

/** Default time for 「＋予定」: the next full hour today (if today is on the page), else 9:00 on the page. */
function defaultNewEventInput() {
  const p = S.page;
  const now = new Date();
  const today = startOfDay(now);
  let day = p ? (p.view === 'month' ? (p.range.monthStart || p.range.start) : p.date) : today;
  let startMin = 9 * 60;
  if (!p || pageContainsDay(p, today)) {
    day = today;
    startMin = Math.min(Math.ceil((minutesOfDay(now) + 1) / 60) * 60, 23 * 60);
  }
  return { title: '', description: '', location: '', allDay: false, start: atMinutes(day, startMin), end: atMinutes(day, startMin + 60) };
}

function addEventFlow() {
  if (!canWriteEvents()) {
    notify(READ_ONLY_MESSAGE);
    return undefined;
  }
  return createEventFlow({ initial: defaultNewEventInput() });
}

/**
 * Wraps a dialog's onSubmit so the caller can tell whether a save is still running when the dialog closes
 * (「キャンセル」 after a stalled request resolves { action: 'cancel', pending: true }).
 */
function trackSubmit(submit) {
  const t = {
    running: null,
    onSubmit: (res) => {
      const p = Promise.resolve().then(() => submit(res));
      t.running = p;
      const clear = () => {
        if (t.running === p) t.running = null;
      };
      p.then(clear, clear);
      return p;
    },
  };
  return t;
}

/**
 * Create dialog → source.createEvent. `ink` = { ids, pageId } when converting a lasso selection
 * (the strokes may be erased afterwards).
 * The save runs inside the dialog's onSubmit: while Google answers the dialog stays open, and a failure is
 * shown inside it, so the handwritten title is never lost. (If a dialog ignores onSubmit, the save runs
 * after it closes and a failure toast offers to reopen it with the same input.)
 * `eventId`: the client id of the insert. One id per event to create, reused by every retry (保存 again,
 * もう一度, the restored draft): a save whose answer was lost returns the existing event (409) instead of
 * creating a duplicate.
 */
async function createEventFlow({ initial, calendarId = null, snapshotUrl = null, ink = null, eventId = null }) {
  if (!canWriteEvents()) {
    notify(READ_ONLY_MESSAGE);
    return;
  }
  if (S.dialogOpen || !S.source) return;
  await calendarsForDialog();
  if (S.dialogOpen) return;
  const calendars = writableCalendars();
  if (!calendars.length) {
    notify(S.calendarsAt === 0 && (!isOnline() || S.offlineEvents)
      ? 'オフラインのため、予定を登録できません'
      : '予定を登録できるカレンダーがありません');
    return;
  }
  const preferred = calendarId && calendars.some((c) => c.id === calendarId) ? calendarId : defaultCalendarId();
  const id = typeof eventId === 'string' && eventId ? eventId : newEventId();
  let done = null;
  let last = null; // { input, calendarId } of the latest attempt
  const retry = () => createEventFlow({
    initial: last?.input || initial, calendarId: last?.calendarId || preferred, snapshotUrl, ink, eventId: id,
  });
  const submit = async (res) => {
    if (!res || res.action !== 'save') return;
    const input = normalizeInput(res.input);
    if (!input) throw new Error('日時が正しくありません');
    const target = typeof res.calendarId === 'string' && res.calendarId ? res.calendarId : preferred;
    last = { input, calendarId: target };
    saveDraft({ kind: 'create', input, calendarId: target, eventId: id });
    try {
      const created = await S.source.createEvent(target, input, { id });
      clearDraft();
      done = { created, eraseInk: res.eraseInk === true, calendarId: target };
    } catch (err) {
      throw submitError(err, '予定を登録できませんでした', { draft: true });
    }
  };
  const tracked = trackSubmit(submit);
  const result = await runEventDialog({
    mode: 'create',
    initial,
    calendarId: preferred,
    calendars,
    snapshotUrl,
    showEraseOption: !!(ink && ink.ids.length),
    eraseDefault: S.settings.get().eraseInkAfterConvert,
    recurring: false,
    htmlLink: '',
    onSubmit: tracked.onSubmit,
  });
  if (result.action === 'cancel' && result.pending && tracked.running) {
    // Closed while Google had not answered yet (「キャンセル」 after a stall): report the outcome later.
    // The ink is never erased then — the user left the dialog.
    tracked.running.then(
      () => { if (done) finishCreated(done, null); },
      (err) => failedToast(err, retry),
    );
    return;
  }
  if (result.action !== 'save') return;
  if (!done) {
    try {
      await submit(result);
    } catch (err) {
      failedToast(err, retry);
      return;
    }
  }
  if (done) finishCreated(done, ink);
}

function finishCreated(done, ink) {
  // An event in a calendar hidden here would vanish (and with 「この手書きを消す」 the ink too): show it.
  const shownAgain = showCalendarIfHidden(done.created?.calendarId || done.calendarId);
  applyEventChange({ added: done.created });
  if (ink && done.eraseInk && S.page && S.page.pageId === ink.pageId && S.surface) {
    S.surface.removeStrokesById(ink.ids); // one undoable op → onCommit → saved
  }
  if (ink) S.surface?.clearSelection();
  notify(shownAgain ? `予定を登録しました（非表示だった「${shownAgain}」を表示しました）` : '予定を登録しました');
}

/** Un-hides a calendar; returns its name when it was hidden, else null. */
function showCalendarIfHidden(calendarId) {
  if (typeof calendarId !== 'string' || !calendarId) return null;
  const hidden = S.settings.get().hiddenCalendarIds;
  if (!hidden.includes(calendarId)) return null;
  S.settings.set({ hiddenCalendarIds: hidden.filter((id) => id !== calendarId) });
  const cal = S.calendars.find((c) => c.id === calendarId);
  return (cal && typeof cal.name === 'string' && cal.name) || 'カレンダー';
}

/**
 * Calendars for a dialog without making the tap wait on the network: a known list opens the dialog at
 * once (refreshed in the background when stale); only an empty list waits, at most a few seconds.
 */
async function calendarsForDialog() {
  if (S.calendars.length) {
    ensureCalendarsQuiet();
    return S.calendars;
  }
  await withTimeout(ensureCalendarsQuiet(), DIALOG_CALENDARS_TIMEOUT_MS);
  return S.calendars;
}

/** Finger tap on an event (or a 予定-tool tap on one): edit dialog, or a read-only view. */
async function editEventFlow(ev, override = null) {
  if (!ev || typeof ev !== 'object' || typeof ev.id !== 'string' || S.dialogOpen || !S.source) return;
  await calendarsForDialog();
  if (S.dialogOpen) return;
  const cal = S.calendars.find((c) => c.id === ev.calendarId);
  const writable = canWriteEvents() && ev.editable !== false && (!cal || cal.writable !== false);
  let calendars = writable ? writableCalendars() : S.calendars.filter((c) => c.id === ev.calendarId);
  if (cal && !calendars.some((c) => c.id === cal.id)) calendars = [cal, ...calendars];

  let done = null;
  let lastInput = null;
  const submit = async (res) => {
    if (!res) return;
    if (res.action === 'delete') {
      lastInput = null; // a failed delete is retried from the event itself, not from an older input
      try {
        await S.source.deleteEvent(ev.calendarId, ev.id);
        done = { kind: 'delete' };
      } catch (err) {
        throw submitError(err, '予定を削除できませんでした', { draft: false });
      }
      return;
    }
    if (res.action !== 'save') return;
    const input = normalizeInput(res.input);
    if (!input) throw new Error('日時が正しくありません');
    lastInput = input;
    const target = typeof res.calendarId === 'string' && res.calendarId ? res.calendarId : ev.calendarId;
    saveDraft({ kind: 'update', input, calendarId: ev.calendarId, eventId: ev.id, recurring: ev.recurring === true });
    try {
      const updated = await updateOrMoveEvent(ev, input, target);
      clearDraft();
      done = { kind: 'update', updated };
    } catch (err) {
      throw submitError(err, '予定を更新できませんでした', { draft: true });
    }
  };
  const tracked = trackSubmit(submit);
  const result = await runEventDialog({
    mode: writable ? 'edit' : 'view',
    readOnly: !writable,
    initial: { ...eventToInput(ev), ...(override || {}), editable: writable },
    calendarId: ev.calendarId,
    calendars,
    snapshotUrl: null,
    showEraseOption: false,
    eraseDefault: false,
    recurring: ev.recurring === true,
    htmlLink: typeof ev.htmlLink === 'string' ? ev.htmlLink : '',
    onSubmit: writable ? tracked.onSubmit : undefined,
  });
  if (writable && result.action === 'cancel' && result.pending && tracked.running) {
    // Closed while Google had not answered yet (「キャンセル」 after a stall): report the outcome later.
    const again = lastInput;
    tracked.running.then(
      () => { if (done) finishEdited(ev, done); },
      (err) => failedToast(err, again ? () => editEventFlow(ev, again) : () => editEventFlow(ev)),
    );
    return;
  }
  if (!writable || (result.action !== 'save' && result.action !== 'delete')) return;
  if (!done) {
    try {
      await submit(result);
    } catch (err) {
      const again = result.action === 'save' ? normalizeInput(result.input) : null;
      failedToast(err, again ? () => editEventFlow(ev, again) : null);
      return;
    }
  }
  if (done) finishEdited(ev, done);
}

function finishEdited(ev, done) {
  if (done.kind === 'delete') {
    applyEventChange({ removed: ev });
    notify('予定を削除しました');
  } else {
    applyEventChange({ removed: ev, added: done.updated });
    notify('予定を更新しました');
  }
}

/**
 * Updates in place. A different target calendar (not offered by the edit dialog today) is handled as
 * create-there-then-delete-here; recurring instances always stay in their calendar.
 */
async function updateOrMoveEvent(ev, input, targetCalendarId) {
  if (targetCalendarId === ev.calendarId || ev.recurring === true) {
    // With the original event only the changed fields are PATCHed (an edit made elsewhere meanwhile is
    // kept). A draft restored without the event (synthetic) sends every field.
    return S.source.updateEvent(ev.calendarId, ev.id, input, ev.synthetic === true ? undefined : ev);
  }
  const created = await S.source.createEvent(targetCalendarId, input);
  try {
    await S.source.deleteEvent(ev.calendarId, ev.id);
  } catch (err) {
    warn('could not delete the moved event', describe(err));
    notify('元のカレンダーの予定を削除できませんでした。重複していないか確認してください', { kind: 'error', duration: 8000 });
  }
  return created;
}

/**
 * Turns an API failure into the Error the dialog shows inline (Japanese). Auth failures keep the draft
 * (it is offered again after reconnecting) and raise the reconnect banner.
 */
function submitError(err, prefix, { draft = false } = {}) {
  warn(prefix, describe(err));
  if (isAuthError(err)) {
    onAuthRequired('api');
    const e = new Error(draft
      ? 'Googleへの再接続が必要です。閉じてから「再接続」してください（入力した内容は再接続後に開けます）'
      : 'Googleへの再接続が必要です。閉じてから「再接続」してください');
    e.authRequired = true;
    return e;
  }
  if (draft) clearDraft();
  return new Error(`${prefix}。${errorMessage(err)}`);
}

/** Failure toast for the fallback path (dialog closed before saving). */
function failedToast(err, retry) {
  const message = err && typeof err.message === 'string' && err.message ? err.message : '保存できませんでした';
  if (err && err.authRequired) {
    notify(message, { kind: 'error', actionLabel: '再接続', onAction: guard(() => startSignIn(), 'reconnect'), duration: 8000 });
  } else if (retry) {
    notify(message, { kind: 'error', actionLabel: 'もう一度', onAction: guard(retry, 'retry'), duration: 8000 });
  } else {
    notify(message, { kind: 'error', duration: 6000 });
  }
}

// ---- 予定 tool & lasso

function previewEventRect(rect) {
  const p = S.page;
  if (!p || !isRect(rect) || !canWriteEvents()) return null;
  try {
    return snapEventRect(p.view, p.range, rect) || null;
  } catch {
    return null;
  }
}

function handleEventRect(rect, info) {
  const p = S.page;
  if (!p || !isRect(rect)) return undefined;
  if (info && info.tap) {
    const existing = findEventAt(rect);
    if (existing) return editEventFlow(existing);
  }
  if (!canWriteEvents()) {
    notify(READ_ONLY_MESSAGE);
    return undefined;
  }
  let r;
  try {
    r = rectToEventRange(p.view, p.range, rect);
  } catch (err) {
    warn('rectToEventRange failed', describe(err));
    return undefined;
  }
  if (!r || !isValidDate(r.start) || !isValidDate(r.end)) return undefined;
  return createEventFlow({
    initial: { title: '', description: '', location: '', allDay: r.allDay === true, start: r.start, end: r.end },
  });
}

/** Event box under the center of a logical rect (a 予定-tool tap), or null. */
function findEventAt(rect) {
  const p = S.page;
  const pageEl = S.pageEls?.pageEl;
  if (!p || !pageEl) return null;
  const pr = pageEl.getBoundingClientRect();
  const scale = pr.width > 0 ? pr.width / p.spec.W : (p.layout?.scale || 1);
  const x = pr.left + ((rect.minX + rect.maxX) / 2) * scale;
  const y = pr.top + ((rect.minY + rect.maxY) / 2) * scale;
  let node = null;
  try {
    const hit = document.elementFromPoint(x, y);
    node = hit && typeof hit.closest === 'function' ? hit.closest('[data-event-id]') : null;
  } catch {
    node = null;
  }
  if (!node || !pageEl.contains(node)) {
    node = [...pageEl.querySelectorAll('[data-event-id]')].find((n) => {
      const r = n.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }) || null;
  }
  if (!node) return null;
  const id = node.dataset.eventId;
  const calId = node.dataset.calendarId;
  return cachedEvents(p).find((e) => e.id === id && (!calId || e.calendarId === calId)) || null;
}

function handleSelectionChange(sel) {
  if (sel && Array.isArray(sel.ids) && sel.ids.length && sel.screenRect && !S.dialogOpen) {
    S.ui.selectionMenu.show(sel.screenRect);
  } else {
    S.ui.selectionMenu.hide();
  }
}

/** Lasso 「予定にする」: selection bbox → time range → dialog with a picture of the ink. */
async function convertSelectionFlow() {
  const p = S.page;
  const sel = S.surface?.getSelection();
  if (!p || !sel || !Array.isArray(sel.ids) || !sel.ids.length || !isRect(sel.bbox)) return;
  if (!canWriteEvents()) {
    notify(READ_ONLY_MESSAGE);
    return;
  }
  let r;
  try {
    r = rectToEventRange(p.view, p.range, sel.bbox);
  } catch (err) {
    warn('rectToEventRange failed', describe(err));
    return;
  }
  if (!r || !isValidDate(r.start) || !isValidDate(r.end)) return;
  let snapshotUrl = null;
  try {
    snapshotUrl = S.surface.snapshot(sel.ids) || null;
  } catch (err) {
    warn('snapshot failed', describe(err));
  }
  await createEventFlow({
    initial: { title: '', description: '', location: '', allDay: r.allDay === true, start: r.start, end: r.end },
    snapshotUrl,
    ink: { ids: [...sel.ids], pageId: p.pageId },
  });
}

// ---- drafts: what the user entered survives an OAuth redirect / failed save

function saveDraft({ kind, input, calendarId, eventId = null, recurring = false }) {
  try {
    const data = encodeDraft({ kind, input, calendarId, eventId, recurring, mode: S.mode, now: Date.now() });
    if (data) storageSet(DRAFT_KEY, data);
  } catch (err) {
    warn('could not keep a draft', describe(err));
  }
}

function clearDraft() {
  storageRemove(DRAFT_KEY);
}

/**
 * Offers a draft that could not be saved. It is only READ here: it stays stored until it is saved
 * (createEventFlow / editEventFlow clear it), the toast is closed, or it expires (DRAFT_MAX_AGE_MS) — a
 * boot-time redirect, a read-only moment or a missed toast must not lose what the user wrote.
 */
function offerDraft() {
  if (S.signInPending || S.leaving) return;
  const { status, draft: d } = parseDraft(storageGet(DRAFT_KEY), { mode: S.mode, now: Date.now(), maxAgeMs: DRAFT_MAX_AGE_MS });
  if (status === 'invalid') clearDraft();
  if (status !== 'ok' || !d || !canWriteEvents()) return;
  notify('保存できなかった予定があります', {
    actionLabel: '開く',
    duration: 0, // stays until 開く or × (a 10 s toast is easily missed while writing)
    onClose: () => clearDraft(),
    onAction: guard(() => {
      if (d.kind === 'create') return createEventFlow({ initial: d.input, calendarId: d.calendarId, eventId: d.eventId || null });
      const known = S.eventsCache.size
        ? [...S.eventsCache.values()].flatMap((e) => e.events).find((e) => e.id === d.eventId && e.calendarId === d.calendarId)
        : null;
      const ev = known || {
        id: d.eventId, calendarId: d.calendarId, ...d.input, color: '', textColor: '', htmlLink: '',
        recurring: d.recurring, editable: true, synthetic: true, // not the real event: no field diff
      };
      return editEventFlow(ev, d.input);
    }, 'draft'),
  });
}

// ---------------------------------------------------------------------------------------------
// Settings, sync, account
// ---------------------------------------------------------------------------------------------

async function settingsFlow() {
  if (S.dialogOpen || S.settingsOpening) return;
  // Do not block other taps while a first calendar list loads (the wait is bounded).
  S.settingsOpening = true;
  try {
    await calendarsForDialog();
  } finally {
    S.settingsOpening = false;
  }
  if (S.dialogOpen || S.leaving) return;
  S.dialogOpen = true;
  S.ui.selectionMenu.hide();
  let result = null;
  try {
    result = await openSettings({
      settings: S.settings.get(),
      calendars: S.calendars.filter((c) => !c.holiday),
      auth: {
        // Google mode = an account is connected (an expired token is a reconnect, shown by the banner and
        // header chip); the sheet must still offer ログアウト / 権限を追加 then.
        signedIn: S.mode === 'google',
        email: S.auth.loginHint() || '',
        configured: S.configured,
        demo: S.mode === 'demo',
        missingScopes: missingScopes(),
      },
      version: APP_VERSION,
    });
  } catch (err) {
    warn('settings dialog failed', describe(err));
    notify('設定を開けませんでした');
  } finally {
    S.dialogOpen = false;
    refreshSelectionMenu();
  }
  if (!result || typeof result !== 'object') return;

  const next = result.settings && typeof result.settings === 'object' ? result.settings : null;
  if (next) {
    const patch = {};
    for (const k of SETTINGS_DIALOG_KEYS) if (k in next) patch[k] = next[k];
    S.settings.set(patch);
  }
  let action = result.action;
  if (!action && next && typeof next.demo === 'boolean' && next.demo !== (S.mode === 'demo')) {
    action = next.demo ? 'enterDemo' : 'exitDemo';
  }
  switch (action) {
    case 'signIn':
      await startSignIn();
      break;
    case 'addScopes':
      await startSignIn({ consent: true });
      break;
    case 'signOut':
      // signOut() revokes the grant: Google then asks for a login on every device of the account.
      if (!confirmSafe(SIGN_OUT_CONFIRM)) return;
      await signOutFlow();
      break;
    case 'enterDemo':
      await switchMode(true);
      break;
    case 'exitDemo':
      await switchMode(false);
      break;
    default:
      break;
  }
}

async function syncTap() {
  if (S.mode === 'demo') {
    notify(tabStorageRisk() ? `${DEMO_DB_NOTE}。${TAB_STORAGE_WARNING}` : DEMO_DB_NOTE, { duration: tabStorageRisk() ? 10000 : 4000 });
    return;
  }
  if (S.inkMismatch) {
    notify(ACCOUNT_MISMATCH_MESSAGE, { kind: 'error', duration: 10000 });
    return;
  }
  if (!hasScope(SCOPES.appdata)) {
    const tab = tabStorageRisk() ? `。${TAB_STORAGE_WARNING}` : '';
    notify(`手書きはこの端末だけに保存されています（Googleドライブへの保存が許可されていません）${tab}`, {
      actionLabel: '権限を追加', onAction: guard(() => startSignIn({ consent: true }), 'add-scopes'), duration: tab ? 12000 : 8000,
    });
    return;
  }
  if (!S.auth.isSignedIn()) {
    notify('Googleに再接続すると、手書きを同期します', {
      actionLabel: '再接続', onAction: guard(() => startSignIn(), 'reconnect'), duration: 8000,
    });
    return;
  }
  if (!isOnline()) {
    notify('オフラインです。接続が戻ると同期します');
    return;
  }
  if (!S.inkVerified) {
    // Uploads start once the signed-in account is confirmed (it is read from the calendar list).
    ensureCalendarsQuiet();
    notify('Googleアカウントを確認しています。確認できしだい手書きを同期します');
    return;
  }
  const ok = await S.inkStore.flush();
  if (S.page) await refreshPageInk(S.page);
  if (S.page) loadEvents(S.page, { force: true });
  if (ok) notify('手書きを同期しました');
  else notify(S.syncMessage || '同期できませんでした。あとで自動的に再試行します');
}

function authTap() {
  if (S.mode === 'demo') return settingsFlow();
  if (!S.configured) {
    notify(NOT_CONFIGURED_MESSAGE);
    return undefined;
  }
  if (S.needsReconnect || !S.auth.isSignedIn()) return startSignIn();
  return settingsFlow();
}

/**
 * Saves the route and waits until every local ink write has finished — strokes committed while waiting
 * start new writes, so wait for those too (bounded). True when nothing is left pending. Call it before
 * any navigation away from the app, after showLeaveShield() (so no new stroke can start meanwhile).
 */
async function prepareToLeave(timeoutMs = LEAVE_SAVE_TIMEOUT_MS) {
  persistRoute();
  savePendingLocal(S.page);
  const deadline = Date.now() + timeoutMs;
  while (S.pendingSaves.size) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    await settleSaves(left);
  }
  return S.pendingSaves.size === 0;
}

/** auth keeps its one-time state in localStorage: without a working storage the answer cannot be checked. */
function storageWritable() {
  const s = S.storage;
  if (!s) return false;
  try {
    const key = 'tegaki.probe';
    const value = String(Date.now());
    s.setItem(key, value);
    const ok = s.getItem(key) === value;
    s.removeItem(key);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Full-screen shield while leaving (OAuth redirect, reload): from the moment leaving is decided until
 * the page unloads, no new stroke can start — the browser keeps the old page interactive until the next
 * document arrives, and anything written then would be lost. Also explains the short pause.
 */
function showLeaveShield(text = '') {
  try {
    let node = S.shield;
    if (!node) {
      node = document.createElement('div');
      node.className = 'leave-shield';
      node.setAttribute('role', 'status');
      node.setAttribute('aria-live', 'polite');
      const label = document.createElement('div');
      label.className = 'leave-shield-text';
      node.append(label);
      const swallow = (e) => {
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
      };
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'touchstart', 'touchmove', 'touchend', 'click', 'contextmenu']) {
        node.addEventListener(type, swallow, { passive: false });
      }
      document.body.append(node);
      S.shield = node;
    }
    const label = node.querySelector('.leave-shield-text');
    if (label) label.textContent = text || '';
  } catch (err) {
    warn('could not show the shield', describe(err));
  }
}

/**
 * location.assign() was called. Normally this document is gone within a second or two. If it is still
 * here (and visible) much later, or visible again after the in-app browser of a Home Screen app was
 * closed without finishing, the navigation was abandoned: unlock the app (see onResumeFromCache).
 */
function noteRedirectStarted() {
  S.redirectStartedAt = Date.now();
  S.redirectHidden = false;
  clearTimeout(S.redirectWatchdog);
  const check = () => {
    S.redirectWatchdog = null;
    if (!S.redirectStartedAt || !S.leaving) return;
    if (document.visibilityState === 'hidden') {
      S.redirectWatchdog = setTimeout(check, REDIRECT_STALL_MS); // decided when visible again
      return;
    }
    abandonRedirect();
  };
  S.redirectWatchdog = setTimeout(check, REDIRECT_STALL_MS);
}

/** Visible again after being hidden during the redirect, without the navigation having replaced us. */
function redirectAbandoned() {
  return !!S.redirectStartedAt && S.leaving && S.redirectHidden && Date.now() - S.redirectStartedAt > 1500;
}

function abandonRedirect() {
  warn('the redirect to Google did not complete; unlocking the app');
  // No automatic redirect from this page any more (it could race a navigation that is still coming);
  // the 「再接続」 banner stays the way on.
  S.silentFailed = true;
  onResumeFromCache();
}

function hideLeaveShield() {
  const node = S.shield;
  S.shield = null;
  try {
    if (node) node.remove();
  } catch {
    // ignore
  }
}

/**
 * Full-page redirect to Google (interactive, silent prompt=none, or prompt=consent for 「権限を追加」).
 * Input is locked (shield) as soon as the redirect is decided; a silent attempt gives up (and retries
 * later) if local saves do not finish in time or the pen came down. Returns false if it did not start.
 */
async function startSignIn({ silent = false, consent = false } = {}) {
  if (!S.configured) {
    notify(NOT_CONFIGURED_MESSAGE);
    return false;
  }
  if (S.signInPending || S.leaving) return false;
  if (silent && (isDrawing() || S.dialogOpen)) {
    scheduleReauthRetry('retry');
    return false;
  }
  if (!storageWritable()) {
    if (silent) {
      S.silentFailed = true; // would come back as state_mismatch, again and again
    } else {
      notify('この端末にデータを保存できないため、Googleに接続できません（プライベートブラウズをオフにしてください）', { kind: 'error', duration: 8000 });
    }
    return false;
  }
  S.signInPending = true;
  if (!silent) setConnecting(true);
  showLeaveShield('Googleに接続しています…');
  const bail = () => {
    S.leaving = false;
    S.signInPending = false;
    hideLeaveShield();
    if (!silent) setConnecting(false);
  };
  try {
    const settled = await prepareToLeave(silent ? LEAVE_SAVE_TIMEOUT_MS : SIGN_IN_SAVE_TIMEOUT_MS);
    if (silent && !settled) {
      // Local saves are stuck: never leave on our own (the strokes would be lost), and do not try again
      // and again either (each try locks the page for seconds). The 「再接続」 banner is the way on.
      bail();
      S.silentFailed = true;
      S.needsReconnect = true;
      updateBanner();
      updateHeader();
      warn('silent sign-in skipped: local ink saves did not finish');
      return false;
    }
    if (silent && (isDrawing() || S.dialogOpen)) {
      bail();
      scheduleReauthRetry('retry');
      return false;
    }
    S.leaving = true;
    const returnState = { view: S.route.view, date: toYMD(S.route.date) };
    const ratio = S.page && S.page.spec.fit === 'width' ? scrollRatio() : null;
    if (Number.isFinite(ratio)) returnState.scroll = Math.round(clamp(ratio, 0, 1) * 10000) / 10000;
    const opts = { silent, returnState };
    if (consent) Object.assign(opts, { consent: true, prompt: 'consent' });
    S.auth.signIn(opts);
    noteRedirectStarted();
    return true;
  } catch (err) {
    bail();
    warn('signIn failed', describe(err));
    if (silent) {
      // Nothing navigated (e.g. the one-time state could not be stored): no more automatic attempts on this
      // load — each one locks the page for a moment. The 「再接続」 banner is the way on.
      S.silentFailed = true;
      S.needsReconnect = true;
      updateBanner();
      updateHeader();
    } else {
      notify('Googleへの接続を開始できませんでした', { kind: 'error' });
    }
    return false;
  }
}

function setConnecting(on) {
  S.connecting = !!on;
  updateBanner();
  updateHeader();
}

/**
 * Sign-out. Uploads first. Everything on Drive → this account's local copy is removed (it comes back from
 * Drive at the next sign-in, and the next account starts clean). Something unsent → the user decides: the
 * ink stays on this device and is sent at the next sign-in with the SAME account (never to another one).
 */
async function signOutFlow() {
  if (S.leaving) return;
  showLeaveShield('ログアウトしています…');
  await prepareToLeave();
  let synced = true;
  if (S.inkStore && S.mode === 'google') synced = (await withTimeout(S.inkStore.flush(), FLUSH_TIMEOUT_MS)) === true;
  if (!synced) {
    hideLeaveShield();
    const ok = confirmSafe('まだGoogleドライブに送れていない手書きがあります。\n\n'
      + 'ログアウトしても、この手書きは端末に残り、同じアカウントでもう一度ログインしたときに送られます。\n'
      + 'ログアウトしますか？');
    if (!ok) return;
    showLeaveShield('ログアウトしています…');
  }
  S.leaving = true;
  if (synced) {
    await withTimeout(S.eventsPersist, 2000); // a write still running must not come back after the clean-up
    await withTimeout(clearLocalAccountData(), 5000);
  }
  try {
    await S.auth.signOut();
  } catch (err) {
    warn('signOut failed', describe(err));
  }
  S.settings.set({ demo: false });
  await prepareToLeave();
  reloadApp();
}

/** Removes the signed-out account's local copy (ink pages, Drive bookkeeping, cached events). */
async function clearLocalAccountData() {
  const kv = S.kv;
  if (!kv || typeof kv.keys !== 'function' || S.mode !== 'google') return;
  const keys = [];
  for (const prefix of ACCOUNT_DATA_PREFIXES) keys.push(...await kv.keys(prefix));
  keys.push('dirty', INK_ACCOUNT_KEY, EVENTS_INDEX_KEY);
  for (const key of keys) await kv.del(key);
}

/** Demo ↔ Google: the whole composition depends on the mode, so persist everything and reload. */
async function switchMode(demo) {
  if (S.leaving) return;
  showLeaveShield('切り替えています…');
  await prepareToLeave();
  if (S.inkStore) await withTimeout(S.inkStore.flush(), FLUSH_TIMEOUT_MS);
  S.settings.set({ demo: !!demo });
  await prepareToLeave();
  reloadApp();
}

function reloadApp() {
  S.leaving = true;
  if (!S.shield) showLeaveShield('');
  location.reload();
}

// ---- local database lost mid-session (idb.js onDegraded)

function onStorageDegraded() {
  if (S.storageDegraded) return;
  S.storageDegraded = true;
  warn('local database lost: ink written from now on is only in memory until a reload');
  updateBanner();
}

/** 「再読み込み」 on the degraded-storage banner: save what can be saved (Drive), then reload. */
async function reloadAfterStorageDegraded() {
  if (S.leaving) return;
  showLeaveShield('再読み込みしています…');
  await prepareToLeave();
  const synced = S.inkStore && S.mode === 'google'
    ? (await withTimeout(S.inkStore.flush(), FLUSH_TIMEOUT_MS)) === true
    : false;
  if (!synced) {
    hideLeaveShield();
    const ok = confirmSafe('この端末に保存できなかった手書きは、再読み込みすると消えることがあります'
      + (S.mode === 'google' ? '（Googleドライブにまだ送れていません）' : '') + '。\n再読み込みしますか？');
    if (!ok) return;
  }
  reloadApp();
}

// ---- one live tab (Web Locks)

/**
 * The newest tab (window) of the app takes the writer lock; an older tab loses it (AbortError) and
 * becomes stale. Local writes would be safe anyway (the ink store does read-merge-writes); this keeps two
 * tabs from uploading the same pages and shows clearly which one is live.
 */
function claimWriterLock() {
  try {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : null;
    if (!locks || typeof locks.request !== 'function') return;
    locks.request(WRITER_LOCK, { steal: true }, () => new Promise(() => {})) // held until the page goes away
      .catch((err) => {
        if (err && err.name === 'AbortError') becomeStaleTab().catch((e) => warn('stale tab handling failed', describe(e)));
      });
  } catch (err) {
    warn('writer lock unavailable', describe(err));
  }
}

/** Another tab took over: keep everything drawn here (saved locally), stop uploading, cover the app. */
async function becomeStaleTab() {
  if (S.stale) return;
  S.stale = true;
  try {
    S.surface?.commitActiveGesture?.(); // a stroke in progress is kept
  } catch (err) {
    warn('could not keep the stroke in progress', describe(err));
  }
  S.ui.selectionMenu.hide();
  if (!S.leaving) showStaleOverlay();
  stopPeriodicRefresh();
  clearTimeout(S.reauthTimer);
  S.reauthTimer = null;
  await settleSaves();
  // No uploads from this tab: the unsent marks stay in the database and the live tab's flush() sends them.
  if (S.inkStore) {
    try {
      await S.inkStore.setDrive(null);
    } catch (err) {
      warn('setDrive(null) failed', describe(err));
    }
  }
}

function showStaleOverlay() {
  if (S.staleOverlay) return;
  try {
    const reload = el('button', { type: 'button', class: 'boot-splash-button btn-primary', onclick: () => reloadApp() }, '再読み込み');
    const node = el('div', { class: 'boot-splash stale-overlay', role: 'alertdialog', 'aria-modal': 'true' },
      el('div', { class: 'boot-splash-text' }, 'このアプリは、別のタブ（ウィンドウ）で開かれています'),
      el('div', { class: 'boot-splash-detail' }, 'ここで続けるには「再読み込み」を押してください（書いた手書きは保存されています）'),
      el('div', { class: 'boot-splash-actions' }, reload));
    // Nothing behind the overlay may get a stroke or a tap (only the button works).
    const swallow = (e) => {
      if (e.target && typeof reload.contains === 'function' && reload.contains(e.target)) return;
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
    };
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'touchstart', 'touchmove', 'touchend', 'click', 'contextmenu']) {
      node.addEventListener(type, swallow, { passive: false });
    }
    document.body.append(node);
    S.staleOverlay = node;
  } catch (err) {
    warn('could not show the stale-tab overlay', describe(err));
  }
}

// ---------------------------------------------------------------------------------------------
// Auth state: banner, silent re-auth (SPEC §6)
// ---------------------------------------------------------------------------------------------

function handleHttpAuthError(token) {
  try {
    if (typeof S.auth.clearToken === 'function') S.auth.clearToken(token); // 401: that token is dead
  } catch {
    // ignore
  }
  onAuthRequired('401');
}

function onAuthRequired(trigger) {
  if (S.mode !== 'google') return;
  if (!S.needsReconnect) {
    S.needsReconnect = true;
    updateBanner();
    updateHeader();
  }
  maybeSilentReauth(trigger);
}

function tokenIsFresh() {
  if (!S.auth.getToken()) return false;
  const exp = S.auth.expiresAt();
  return Number.isFinite(exp) && exp - Date.now() > TOKEN_MARGIN_MS;
}

/**
 * Silent re-auth (prompt=none) when the token is missing or expiring, the user signed in before, we are
 * online, not drawing, no dialog is open and the last attempt was over 5 minutes ago. Triggers: boot,
 * visibilitychange → visible, 401 / missing token from the API. How long the input must have been quiet
 * depends on the trigger (state.js silentReauthReady): a token that ran out mid-session waits for a real
 * pause, so the page never reloads during a short thinking break. A failed attempt (previous load) leaves
 * only the 「Googleに再接続」 banner.
 */
function maybeSilentReauth(trigger) {
  if (S.mode !== 'google' || !S.configured || S.leaving || S.signInPending || S.stale) return;
  if (tokenIsFresh()) {
    if (S.needsReconnect) {
      S.needsReconnect = false;
      updateBanner();
      updateHeader();
    }
    return;
  }
  if (!S.auth.getToken() && !S.needsReconnect) {
    S.needsReconnect = true;
    updateBanner();
    updateHeader();
  }
  if (!S.auth.hasEverSignedIn() || S.silentFailed) return;
  if (!isOnline() || document.visibilityState === 'hidden') return; // retried on 'online' / visible
  if (!S.auth.canTrySilent()) return;
  const ready = silentReauthReady({
    trigger,
    quietForMs: Date.now() - Math.max(S.lastInputAt, S.lastPointerAt),
    drawing: isDrawing(),
    dialogOpen: S.dialogOpen || S.settingsOpening,
    welcomeOpen: S.welcomeOpen,
    hasSelection: !!S.surface?.getSelection(),
  });
  if (!ready) {
    scheduleReauthRetry(trigger);
    return;
  }
  startSignIn({ silent: true }).catch(() => {});
}

function scheduleReauthRetry(trigger) {
  if (S.reauthTimer) return;
  S.reauthTimer = setTimeout(() => {
    S.reauthTimer = null;
    maybeSilentReauth(trigger === 'boot' || trigger === 'visible' ? 'retry' : trigger);
  }, REAUTH_RETRY_MS);
}

/** Requested scopes the current token lacks (granular consent), for the settings sheet. */
function missingScopes() {
  if (S.mode !== 'google' || !S.auth.hasEverSignedIn()) return [];
  return Object.values(SCOPES).filter((scope) => !hasScope(scope));
}

function missingScopeBanner() {
  if (S.mode !== 'google' || !S.auth.isSignedIn()) return null;
  const noEvents = !hasScope(SCOPES.events);
  const noDrive = !hasScope(SCOPES.appdata);
  if (!noEvents && !noDrive) return null;
  // events.list needs calendar.events too: without it no events can be shown at all (not read-only).
  let text;
  if (noEvents && noDrive) text = '予定の表示・登録と、手書きのGoogleドライブ保存が許可されていません';
  else if (noEvents) text = '予定を表示・登録するには、カレンダーの予定へのアクセスを許可してください';
  else text = '手書きはこの端末だけに保存されています（Googleドライブへの保存が許可されていません）';
  return { text, actionLabel: '権限を追加', onAction: guard(() => startSignIn({ consent: true }), 'add-scopes'), kind: 'info' };
}

function updateBanner() {
  const elBanner = S.els?.banner;
  if (!elBanner) return;
  let b = null;
  if (S.storageDegraded) {
    // Beats everything: from now on nothing written survives a reload.
    b = {
      text: STORAGE_DEGRADED_MESSAGE, actionLabel: '再読み込み', kind: 'error', closable: false,
      onAction: guard(() => reloadAfterStorageDegraded(), 'storage-reload'),
    };
  } else if (S.connecting) {
    b = { text: 'Googleに接続しています…', kind: 'info' };
  } else if (S.mode === 'google' && (!isOnline() || S.offlineEvents)) {
    // Offline beats 「再接続」 (reconnecting cannot work now) and says how old the events shown are.
    const at = S.page ? S.eventsCache.get(S.page.cacheId)?.at : 0;
    b = { text: offlineBannerText(at || 0), kind: 'info' };
  } else if (S.mode === 'google' && (S.needsReconnect || !S.auth.isSignedIn())) {
    b = { text: 'Googleに再接続してください', actionLabel: '再接続', onAction: guard(() => startSignIn(), 'reconnect'), kind: 'warn' };
  } else {
    b = missingScopeBanner() || tabStorageBanner();
  }
  const key = b ? `${b.kind}|${b.text}|${b.actionLabel || ''}` : null;
  if (key === S.bannerKey) return;
  if (isDrawing()) {
    S.bannerDeferred = true; // a banner moves the page: wait for the pen to lift
    return;
  }
  S.bannerDeferred = false;
  S.bannerKey = key;
  keepContentStill(() => {
    try {
      if (b) showBanner(elBanner, b);
      else hideBanner(elBanner);
    } catch (err) {
      warn('banner failed', describe(err));
    }
  });
}

/**
 * Safari tab (not the Home Screen app) with ink only on this device: the Home Screen app does not see
 * it, and WebKit may delete it after days without a visit. Shown every launch, closable per session.
 */
function tabStorageBanner() {
  if (S.tabWarningDismissed || !tabStorageRisk()) return null;
  const localOnly = S.mode === 'demo' || (S.mode === 'google' && !hasScope(SCOPES.appdata));
  if (!localOnly) return null;
  return {
    text: TAB_STORAGE_WARNING,
    kind: 'warn',
    onClose: () => {
      S.tabWarningDismissed = true;
    },
  };
}

function updateHeader() {
  const p = S.page;
  if (!S.settings) return;
  const signedIn = S.mode === 'google' && !!S.auth?.isSignedIn();
  S.ui.header.update({
    view: p ? p.view : S.route.view,
    date: p ? p.date : S.route.date,
    range: p ? p.range : null,
    weekStart: S.settings.get().weekStart,
    sync: { status: S.syncStatus, message: S.syncMessage },
    auth: {
      signedIn,
      demo: S.mode === 'demo',
      needsReconnect: S.mode === 'google' && (S.needsReconnect || !signedIn),
      connecting: S.connecting,
      configured: S.configured,
      email: S.auth?.loginHint() || '',
    },
    canAddEvent: canWriteEvents(),
  });
}

// ---------------------------------------------------------------------------------------------
// Interactions: keyboard, swipe, resize, drawing tracker, lifecycle
// ---------------------------------------------------------------------------------------------

function installGlobalGuards() {
  window.addEventListener('unhandledrejection', (e) => {
    warn('unhandled rejection', describe(e.reason));
  });
  window.addEventListener('error', (e) => {
    warn('uncaught error', e && e.message);
  });
  // Back from Google with the back button (bfcache) — also while the welcome screen is up.
  window.addEventListener('pageshow', guard((e) => {
    if (e.persisted) onResumeFromCache();
  }, 'pageshow'));
  // Redirect bookkeeping. Before the page UI exists (welcome screen, boot-time redirect) this listener also
  // unlocks the app when it comes back without the navigation (installInteractions handles it later).
  document.addEventListener('visibilitychange', guard(() => {
    if (document.visibilityState === 'hidden') {
      if (S.redirectStartedAt) S.redirectHidden = true;
    } else if (!S.page && redirectAbandoned()) {
      abandonRedirect();
    }
  }, 'visibility-redirect'));
  // Safari pinch-zoom (also blocked by the ink surface; harmless twice).
  const block = (e) => {
    if (e.cancelable) e.preventDefault();
  };
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, block, { passive: false });
}

function installInteractions() {
  const vp = S.els.viewport;
  const pageEl = S.pageEls.pageEl;

  // Input activity (idle detection for API-triggered silent re-auth).
  const noteInput = () => {
    S.lastInputAt = Date.now();
  };
  document.addEventListener('pointerdown', noteInput, { capture: true, passive: true });
  document.addEventListener('keydown', noteInput, { capture: true, passive: true });

  installDrawingTracker(pageEl);
  document.addEventListener('keydown', guard(handleKeydown, 'keydown'));
  installSwipe(vp);

  const onResize = () => requestAnimationFrame(guard(relayout, 'relayout'));
  if (typeof ResizeObserver === 'function') {
    // Synchronously (ResizeObserver runs after layout, before paint): no frame shows the shifted page.
    new ResizeObserver(guard(relayout, 'relayout')).observe(vp);
  } else {
    window.addEventListener('resize', onResize);
  }
  window.addEventListener('orientationchange', onResize);

  document.addEventListener('visibilitychange', guard(() => {
    if (document.visibilityState === 'hidden') onHidden();
    else if (redirectAbandoned()) abandonRedirect(); // back without the navigation (in-app browser closed)
    else onVisible();
  }, 'visibility'));
  window.addEventListener('pagehide', guard(() => onHidden(), 'pagehide'));
  window.addEventListener('online', guard(() => onOnline(), 'online'));
  window.addEventListener('offline', guard(() => {
    updateHeader();
    updateBanner();
  }, 'offline'));
}

/** Pen / mouse / allowed-finger contacts on the page: "drawing" while any is down. */
function installDrawingTracker(pageEl) {
  const inkPointer = (e) => e.pointerType === 'pen'
    || (e.pointerType === 'mouse' && e.button === 0)
    || (e.pointerType === 'touch' && S.settings.get().allowFinger);
  const down = (e) => {
    S.lastPointerAt = Date.now();
    if (!inkPointer(e)) return;
    S.pointersDown.add(e.pointerId);
    // The selection may be dragged: keep its menu out of the way until the gesture ends.
    if (S.surface?.getSelection()) S.ui.selectionMenu.hide();
  };
  const move = () => {
    if (S.pointersDown.size) S.lastPointerAt = Date.now();
  };
  const up = (e) => {
    S.lastPointerAt = Date.now();
    // After the surface has handled the release (it listens on the page, below this window listener).
    if (S.pointersDown.delete(e.pointerId) && !S.pointersDown.size) {
      setTimeout(() => {
        refreshSelectionMenu();
        if (S.bannerDeferred) updateBanner();
      }, 0);
    }
  };
  const opts = { capture: true, passive: true };
  pageEl.addEventListener('pointerdown', down, opts);
  pageEl.addEventListener('pointermove', move, opts);
  pageEl.addEventListener('lostpointercapture', up, opts);
  window.addEventListener('pointerup', up, opts);
  window.addEventListener('pointercancel', up, opts);
}

function isDrawing() {
  if (!S.pointersDown.size) return false;
  if (Date.now() - S.lastPointerAt > DRAWING_STALE_MS) {
    S.pointersDown.clear(); // a lost pointerup must not block navigation forever
    return false;
  }
  return true;
}

function isEditableTarget(t) {
  if (!t || t.nodeType !== 1) return false;
  if (t.isContentEditable) return true;
  const tag = String(t.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function handleKeydown(e) {
  if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
  if (S.dialogOpen || S.welcomeOpen || S.leaving || S.shield || S.stale) return;
  if (isEditableTarget(e.target)) return;
  const key = typeof e.key === 'string' ? e.key : '';
  const lower = key.toLowerCase();

  if ((e.metaKey || e.ctrlKey) && !e.altKey) {
    if (lower === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (lower === 'y' && e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      redo();
    }
    return;
  }
  if (e.altKey || e.metaKey || e.ctrlKey) return;

  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    e.preventDefault();
    goRelative(key === 'ArrowLeft' ? -1 : 1);
  } else if (key === 'Escape') {
    if (S.surface?.getSelection()) {
      e.preventDefault();
      S.surface.clearSelection();
    }
  } else if (lower === 't') {
    e.preventDefault();
    goToday();
  } else if (VIEW_KEYS[lower]) {
    e.preventDefault();
    switchView(VIEW_KEYS[lower]);
  } else if (TOOL_KEYS[lower]) {
    e.preventDefault();
    selectTool(TOOL_KEYS[lower]);
  }
}

/** Horizontal finger swipe on the viewport → previous / next page. */
function installSwipe(vp) {
  let start = null;
  vp.addEventListener('touchstart', (e) => {
    const t = e.touches.length === 1 ? e.touches[0] : null;
    start = t && t.touchType !== 'stylus'
      ? { x: t.clientX, y: t.clientY, at: Date.now(), id: t.identifier }
      : null;
  }, { passive: true });
  vp.addEventListener('touchmove', (e) => {
    if (start && e.touches.length > 1) start = null; // pinch / two fingers
  }, { passive: true });
  vp.addEventListener('touchcancel', () => {
    start = null;
  }, { passive: true });
  vp.addEventListener('touchend', guard((e) => {
    const s = start;
    start = null;
    if (!s) return;
    const t = Array.from(e.changedTouches || []).find((x) => x.identifier === s.id);
    if (!t) return;
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    const dt = Date.now() - s.at;
    if (Math.abs(dx) <= SWIPE.minDx || Math.abs(dx) <= SWIPE.ratio * Math.abs(dy) || dt >= SWIPE.maxMs) return;
    // With 指でも書く on, a finger stroke is ink, not navigation.
    if (S.dialogOpen || isDrawing() || S.settings.get().allowFinger) return;
    goRelative(dx < 0 ? 1 : -1);
  }, 'swipe'), { passive: true });
}

function onHidden() {
  if (S.hiddenAt === 0) S.hiddenAt = Date.now();
  S.pointersDown.clear();
  // A stroke still in progress (no pointerup comes when the page goes away): keep it.
  try {
    if (typeof S.surface?.commitActiveGesture === 'function') S.surface.commitActiveGesture();
  } catch (err) {
    warn('could not keep the stroke in progress', describe(err));
  }
  if (S.leaving) return;
  persistRoute();
  stopPeriodicRefresh();
  if (S.inkStore) S.inkStore.flush().catch((err) => warn('flush on hide failed', describe(err)));
}

function onVisible() {
  const hiddenFor = S.hiddenAt ? Date.now() - S.hiddenAt : 0;
  S.hiddenAt = 0;
  if (S.stale && !S.leaving) {
    reloadApp(); // back to an older tab: it takes over again (with the latest ink from the database)
    return;
  }
  if (S.leaving || !S.page) return;
  startPeriodicRefresh();
  if (hiddenFor > ROUTE_RESTORE_MS && !pageContainsDay(S.page, startOfDay(new Date()))) {
    goTo(S.route.view, new Date()); // back after a long time: open today's page
  } else {
    renderView(); // today marker / now line may be outdated
    refreshPageInk(S.page);
    loadEvents(S.page, { force: hiddenFor > EVENTS_STALE_MS });
  }
  // An upload cut off when the app went to the background is not retried by anything else.
  if (S.inkStore && S.mode === 'google') {
    setTimeout(() => {
      if (S.leaving || !S.inkStore) return;
      S.inkStore.flush().catch((err) => warn('flush on visible failed', describe(err)));
    }, VISIBLE_FLUSH_DELAY_MS);
  }
  ensureCalendars().catch(() => {});
  maybeSilentReauth('visible');
  checkForServiceWorkerUpdate();
  const waiting = S.swRegistration?.waiting;
  if (waiting && typeof S.offerUpdate === 'function') S.offerUpdate(waiting);
}

/** Back from Google with the browser's back button (bfcache): undo the 「接続中…」 state. */
function onResumeFromCache() {
  S.leaving = false;
  S.signInPending = false;
  S.connecting = false;
  S.redirectStartedAt = 0;
  S.redirectHidden = false;
  clearTimeout(S.redirectWatchdog);
  S.redirectWatchdog = null;
  hideLeaveShield();
  if (S.bootDeferred) {
    // The boot-time redirect was abandoned before any UI existed: start the app now.
    const { mode, redirect } = S.bootDeferred;
    S.bootDeferred = null;
    setSplashText(null);
    bootApp(mode, redirect).catch(showFatal);
    return;
  }
  for (const fn of S.pageShowHooks) {
    try {
      fn();
    } catch (err) {
      warn('pageshow hook failed', describe(err));
    }
  }
  updateBanner();
  updateHeader();
  if (S.page) onVisible();
}

function onOnline() {
  updateHeader();
  updateBanner();
  if (S.inkStore) S.inkStore.flush().catch((err) => warn('flush on online failed', describe(err)));
  if (S.page) loadEvents(S.page, { force: true });
  maybeSilentReauth('online');
}

function startPeriodicRefresh() {
  if (S.refreshTimer) return;
  S.refreshTimer = setInterval(guard(() => {
    if (document.visibilityState !== 'visible' || S.leaving || !S.page) return;
    if (!S.dialogOpen) loadEvents(S.page, { force: true });
    // Unsent ink (a failed or cut-off upload) is retried here too, not only on the next save of that page.
    if (S.inkStore && S.mode === 'google' && ['pending', 'error', 'offline'].includes(S.syncStatus) && isOnline()) {
      S.inkStore.flush().catch((err) => warn('periodic flush failed', describe(err)));
    }
  }, 'periodic-refresh'), EVENTS_REFRESH_MS);
}

function stopPeriodicRefresh() {
  if (!S.refreshTimer) return;
  clearInterval(S.refreshTimer);
  S.refreshTimer = null;
}

// ---------------------------------------------------------------------------------------------
// PWA: service worker, persistent storage
// ---------------------------------------------------------------------------------------------

async function registerServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && !isLocalHost()) return;
  let reg;
  try {
    reg = await navigator.serviceWorker.register('sw.js', { scope: './' });
  } catch (err) {
    warn('service worker registration failed', describe(err));
    return;
  }
  S.swRegistration = reg;
  S.swCheckedAt = Date.now();
  let offeredWorker = null;
  let offeredAt = 0;
  // A missed toast (or a second deploy) is offered again: a Home Screen app can stay open for days.
  const offer = (worker) => {
    if (!navigator.serviceWorker.controller) return; // first install: nothing to update
    if (!shouldOfferUpdate({ worker, offeredWorker, offeredAt, now: Date.now() })) return;
    offeredWorker = worker;
    offeredAt = Date.now();
    notify('新しいバージョンがあります', {
      actionLabel: '更新', duration: 15000, onAction: guard(() => applyUpdate(worker), 'sw-update'),
    });
  };
  S.offerUpdate = offer;
  if (reg.waiting) offer(reg.waiting);
  reg.addEventListener('updatefound', () => {
    const worker = reg.installing;
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed') offer(worker);
    });
  });
}

let reloadOnControllerChange = false;

async function applyUpdate(worker) {
  if (S.leaving) return;
  if (S.dialogOpen || S.settingsOpening) {
    // The reload would throw away what is being typed in the dialog.
    notify('予定や設定の画面を閉じてから「更新」してください', {
      actionLabel: '更新', duration: 0, onAction: guard(() => applyUpdate(worker), 'sw-update'),
    });
    return;
  }
  S.leaving = true;
  showLeaveShield('更新しています…'); // no stroke can start until the page reloads
  await prepareToLeave();
  if (S.inkStore) await withTimeout(S.inkStore.flush(), 3000);
  reloadOnControllerChange = true;
  const finish = guard(async () => {
    if (!reloadOnControllerChange) return;
    reloadOnControllerChange = false;
    await prepareToLeave();
    reloadApp();
  }, 'sw-reload');
  navigator.serviceWorker.addEventListener('controllerchange', finish);
  try {
    worker.postMessage('skipWaiting');
  } catch (err) {
    warn('could not activate the new version', describe(err));
  }
  // Fallback if controllerchange never arrives.
  setTimeout(finish, 4000);
}

function checkForServiceWorkerUpdate() {
  const reg = S.swRegistration;
  if (!reg || Date.now() - S.swCheckedAt < SW_UPDATE_CHECK_MS || !isOnline()) return;
  S.swCheckedAt = Date.now();
  reg.update().catch(() => {});
}

async function requestPersistentStorage() {
  if (!isStandalone()) return;
  try {
    const sm = navigator.storage;
    if (!sm || typeof sm.persist !== 'function') return;
    if (typeof sm.persisted === 'function' && await sm.persisted()) return;
    await sm.persist();
  } catch (err) {
    warn('storage.persist failed', describe(err));
  }
}

// ---------------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------------

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  const start = () => boot().catch(showFatal);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
