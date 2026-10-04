// App header (module F2b): ◀ 今日 ▶ · title · 日/週/月 · ＋予定 · sync indicator · account chip · ⚙︎
//
// createHeader(el, handlers) → { update(state) }
//   handlers: onPrev, onNext, onToday, onView(view), onAddEvent, onSettings, onSyncTap, onAuthTap
//   update(state) merges a PARTIAL state into the current one, so callers may send only what changed:
//     view        'day' | 'week' | 'month'
//     date        Date (the current page date)
//     range       { start, end, monthStart? } from rangeFor() (optional; derived from date/weekStart if absent)
//     weekStart   0 | 1 (used only when range is absent)
//     title       string (optional override of the computed title)
//     sync        ink-store status string ('local'|'synced'|'pending'|'syncing'|'error'|'offline')
//                 or { status, message }   (aliases: syncStatus)
//     auth        { signedIn, demo, needsReconnect | reconnect, connecting, configured, email }
//                 or a string 'signedIn'|'signedOut'|'reconnect'|'demo'|'connecting'   (alias: authState;
//                 the flat keys signedIn/demo/needsReconnect/connecting/configured/email are accepted too)
//     canAddEvent boolean (default true; false hides 「＋予定」, e.g. read-only Google access)

import { h, clear, svgIcon } from './dom.js';
import { formatDateJa, formatMonthJa, formatWeekRangeJa, startOfWeek, addDays, isValidDate } from '../util/date.js';
import { getHolidayName } from '../util/holidays-jp.js';

const VIEW_LABELS = [['day', '日'], ['week', '週'], ['month', '月']];
const VIEW_NAMES = { day: '日', week: '週', month: '月' };

/** Sync indicator per ink-store status: short text (SPEC §8), icon and tone. */
const SYNC_INFO = {
  synced: { text: '保存済み', icon: 'cloud-check', tone: 'ok', label: 'Googleドライブに保存済み' },
  syncing: { text: '保存中…', icon: 'cloud-upload', tone: 'busy', label: 'Googleドライブに保存中' },
  pending: { text: '未送信', icon: 'cloud-upload', tone: 'warn', label: 'まだGoogleドライブに送信していない手書きがあります' },
  offline: { text: 'オフライン', icon: 'cloud-off', tone: 'warn', label: 'オフラインです。手書きはこの端末に保存されています' },
  local: { text: 'この端末のみ', icon: 'tablet', tone: 'muted', label: '手書きはこの端末だけに保存されています' },
  error: { text: 'エラー', icon: 'alert', tone: 'error', label: '同期でエラーが発生しました' },
};

/**
 * Sync indicator content for a status (string or { status, message }); unknown → null (hidden).
 * @returns {{ status: string, text: string, icon: string, tone: string, label: string } | null}
 */
export function syncIndicatorInfo(sync) {
  const status = typeof sync === 'string' ? sync : (sync && typeof sync === 'object' ? sync.status : null);
  const info = typeof status === 'string' ? SYNC_INFO[status] : null;
  if (!info) return null;
  const message = sync && typeof sync === 'object' && typeof sync.message === 'string' ? sync.message.trim() : '';
  return { status, ...info, label: message ? `${info.label}：${message}` : info.label };
}

/** Normalizes the many accepted auth shapes into { signedIn, demo, needsReconnect, connecting, configured, email }. */
export function normalizeAuthState(auth) {
  const base = { signedIn: false, demo: false, needsReconnect: false, connecting: false, configured: null, email: '' };
  if (typeof auth === 'string') {
    return {
      ...base,
      signedIn: auth === 'signedIn',
      demo: auth === 'demo',
      needsReconnect: auth === 'reconnect' || auth === 'needsReconnect',
      connecting: auth === 'connecting',
      configured: auth === 'unconfigured' ? false : null,
    };
  }
  if (!auth || typeof auth !== 'object') return base;
  return {
    signedIn: Boolean(auth.signedIn),
    demo: Boolean(auth.demo),
    needsReconnect: Boolean(auth.needsReconnect || auth.reconnect),
    connecting: Boolean(auth.connecting),
    configured: typeof auth.configured === 'boolean' ? auth.configured : null,
    email: typeof auth.email === 'string' ? auth.email : '',
  };
}

/**
 * The account chip for an auth state: 「再接続」 when a reconnect is needed, 「ログイン」 when signed out,
 * 「お試し」 in demo mode, an account icon when signed in, 「接続中…」 while redirecting.
 * @returns {{ hidden: boolean, text: string, icon: string, tone: string, label: string, disabled: boolean }}
 */
export function authChipInfo(authInput) {
  const a = normalizeAuthState(authInput);
  if (a.connecting) {
    return { hidden: false, text: '接続中…', icon: 'cloud-upload', tone: 'muted', label: 'Googleに接続中', disabled: true };
  }
  if (a.demo) {
    return { hidden: false, text: 'お試し', icon: 'user', tone: 'muted', label: 'お試しモードで使用中', disabled: false };
  }
  if (a.needsReconnect) {
    return { hidden: false, text: '再接続', icon: 'alert', tone: 'warn', label: 'Googleに再接続', disabled: false };
  }
  if (a.signedIn) {
    return {
      hidden: false, text: '', icon: 'user', tone: 'plain',
      label: a.email ? `アカウント（${a.email}）` : 'アカウント', disabled: false,
    };
  }
  if (a.configured === false) {
    return { hidden: true, text: '', icon: 'user', tone: 'plain', label: '', disabled: true };
  }
  return { hidden: false, text: 'ログイン', icon: 'user', tone: 'accent', label: 'Googleでログイン', disabled: false };
}

/**
 * Header title for a view/date: day → '2026年10月4日(日)' (+ holiday name), week → week range,
 * month → '2026年10月'.
 * @returns {{ title: string, holiday: string }}
 */
export function headerTitle({ view, date, range, weekStart = 1 } = {}) {
  const d = isValidDate(date) ? date : null;
  if (view === 'month') {
    const m = isValidDate(range?.monthStart) ? range.monthStart : d;
    return { title: m ? formatMonthJa(m) : '', holiday: '' };
  }
  if (view === 'week') {
    let start = isValidDate(range?.start) ? range.start : null;
    let end = isValidDate(range?.end) ? range.end : null;
    if (!start && d) start = startOfWeek(d, weekStart);
    if (start && !end) end = addDays(start, 7);
    return { title: start ? formatWeekRangeJa(start, end) : '', holiday: '' };
  }
  if (!d) return { title: '', holiday: '' };
  let holiday = '';
  try {
    holiday = getHolidayName(d) || '';
  } catch {
    holiday = '';
  }
  return { title: formatDateJa(d), holiday };
}

/** Normalizes one update() patch into the internal state keys (only keys present in the patch). */
function normalizePatch(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  if (typeof patch.view === 'string' && VIEW_NAMES[patch.view]) out.view = patch.view;
  if (isValidDate(patch.date)) out.date = patch.date;
  if ('range' in patch) out.range = patch.range && typeof patch.range === 'object' ? patch.range : null;
  else if ('view' in out || 'date' in out) out.range = null; // a stale range must not outlive its date
  if (patch.weekStart === 0 || patch.weekStart === 1) out.weekStart = patch.weekStart;
  if ('title' in patch) out.title = typeof patch.title === 'string' ? patch.title : null;
  else if ('view' in out || 'date' in out) out.title = null;

  const sync = 'sync' in patch ? patch.sync : ('syncStatus' in patch ? patch.syncStatus : undefined);
  if (sync !== undefined) out.sync = sync;

  // `auth` / `authState` replace the whole auth state; flat keys are merged into the current one.
  if ('auth' in patch) out.authReplace = patch.auth;
  else if ('authState' in patch) out.authReplace = patch.authState;
  else {
    const flat = ['signedIn', 'demo', 'needsReconnect', 'reconnect', 'connecting', 'configured', 'email'];
    if (flat.some((k) => k in patch)) {
      out.authMerge = {};
      for (const k of flat) if (k in patch) out.authMerge[k] = patch[k];
    }
  }

  if ('canAddEvent' in patch) out.canAddEvent = patch.canAddEvent !== false;
  return out;
}

/** Merges flat auth keys into the current normalized auth. */
function mergeAuth(current, patch) {
  const next = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'reconnect') next.needsReconnect = Boolean(v);
    else if (k in next) next[k] = k === 'email' ? String(v ?? '') : (k === 'configured' ? v : Boolean(v));
  }
  return normalizeAuthState(next);
}

function call(fn, ...args) {
  if (typeof fn !== 'function') return;
  try {
    fn(...args);
  } catch (err) {
    console.warn('header handler failed', err);
  }
}

/**
 * Builds the header inside `el` (header.app-header).
 * @param {HTMLElement} el
 * @param {{ onPrev?, onNext?, onToday?, onView?, onAddEvent?, onSettings?, onSyncTap?, onAuthTap? }} handlers
 */
export function createHeader(el, handlers = {}) {
  if (!el) throw new TypeError('createHeader: el is required');
  const hd = handlers || {};
  let state = {
    view: 'week', date: null, range: null, weekStart: 1, title: null,
    sync: null, auth: normalizeAuthState(null), canAddEvent: true,
  };

  const iconButton = (icon, label, onClick, extraClass = '') => h('button', {
    type: 'button', class: ['icon-btn', extraClass], 'aria-label': label, title: label, onClick,
  }, svgIcon(icon));

  const prevBtn = iconButton('chevron-left', '前へ', () => call(hd.onPrev));
  const nextBtn = iconButton('chevron-right', '次へ', () => call(hd.onNext));
  const todayBtn = h('button', { type: 'button', class: 'btn-today', onClick: () => call(hd.onToday) }, '今日');

  const titleText = h('span', { class: 'hdr-title-text' });
  const holidayBadge = h('span', { class: 'hdr-holiday', hidden: true });
  const titleEl = h('h1', { class: 'hdr-title', 'aria-live': 'polite' }, titleText, holidayBadge);

  const viewButtons = new Map();
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': '表示の切り替え' },
    VIEW_LABELS.map(([view, label]) => {
      const b = h('button', {
        type: 'button',
        'aria-pressed': 'false',
        'aria-label': `${label}表示`,
        dataset: { view },
        onClick: () => { if (state.view !== view) call(hd.onView, view); },
      }, h('span', null, label));
      viewButtons.set(view, b);
      return b;
    }));

  const addBtn = h('button', {
    type: 'button', class: 'btn-add', 'aria-label': '予定を追加', title: '予定を追加',
    onClick: () => call(hd.onAddEvent),
  }, svgIcon('plus'), h('span', { class: 'btn-add-label' }, '予定'));

  const syncIcon = h('span', { class: 'sync-icon' });
  const syncText = h('span', { class: 'sync-text' });
  const syncBtn = h('button', {
    type: 'button', class: 'sync-ind', hidden: true, onClick: () => call(hd.onSyncTap),
  }, syncIcon, syncText);

  const authIcon = h('span', { class: 'auth-icon' });
  const authText = h('span', { class: 'auth-text' });
  const authBtn = h('button', {
    type: 'button', class: 'chip auth-chip', hidden: true, onClick: () => call(hd.onAuthTap),
  }, authIcon, authText);

  const settingsBtn = iconButton('gear', '設定', () => call(hd.onSettings), 'hdr-settings');

  clear(el);
  el.classList.add('app-header');
  el.append(
    h('div', { class: 'hdr-nav' }, prevBtn, todayBtn, nextBtn),
    titleEl,
    h('div', { class: 'hdr-actions' }, seg, addBtn, syncBtn, authBtn, settingsBtn),
  );

  let lastSyncIcon = null;
  let lastAuthIcon = null;

  function render() {
    const computed = headerTitle(state);
    const title = state.title != null ? state.title : computed.title;
    titleText.textContent = title;
    const holiday = state.title != null ? '' : computed.holiday;
    holidayBadge.textContent = holiday;
    holidayBadge.hidden = !holiday;
    titleEl.title = holiday ? `${title} ${holiday}` : title;

    for (const [view, b] of viewButtons) {
      const on = view === state.view;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.classList.toggle('is-active', on);
    }

    addBtn.hidden = !state.canAddEvent;

    const sync = syncIndicatorInfo(state.sync);
    syncBtn.hidden = !sync;
    if (sync) {
      if (lastSyncIcon !== sync.icon) {
        clear(syncIcon).appendChild(svgIcon(sync.icon, { size: 22 }));
        lastSyncIcon = sync.icon;
      }
      syncText.textContent = sync.text;
      syncBtn.dataset.tone = sync.tone;
      syncBtn.dataset.status = sync.status;
      syncBtn.setAttribute('aria-label', sync.label);
      syncBtn.title = sync.label;
    }

    const chip = authChipInfo(state.auth);
    authBtn.hidden = chip.hidden;
    authBtn.disabled = chip.disabled;
    authBtn.dataset.tone = chip.tone;
    authBtn.classList.toggle('is-icon-only', !chip.text);
    if (lastAuthIcon !== chip.icon) {
      clear(authIcon).appendChild(svgIcon(chip.icon, { size: 20 }));
      lastAuthIcon = chip.icon;
    }
    authText.textContent = chip.text;
    authBtn.setAttribute('aria-label', chip.label || chip.text);
    authBtn.title = chip.label || chip.text;
  }

  function update(patch) {
    const { authReplace, authMerge, ...rest } = normalizePatch(patch);
    state = { ...state, ...rest };
    if (authReplace !== undefined) state.auth = normalizeAuthState(authReplace);
    else if (authMerge) state.auth = mergeAuth(state.auth, authMerge);
    render();
  }

  render();
  return { update };
}
