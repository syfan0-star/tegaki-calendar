// Toasts and banners (module F2b).
//
// toast(message, { actionLabel, onAction, duration = 3000 }) → { dismiss() }
//   Short message at the bottom center, above the toolbar. Up to 3 stack; the oldest goes first.
//   duration ≤ 0 or Infinity keeps the toast until its action/close is tapped. Extra options: kind
//   ('info' | 'error') for styling; onClose() — called only when the user taps the × of a sticky toast
//   (not after the action button, the auto-dismiss or when a newer toast pushes it out).
// showBanner(el, { text, actionLabel, onAction, kind = 'info' }) / hideBanner(el)
//   Fills div.banner (the row under the header). kind: 'info' | 'warn' | 'error'.
//   Extra options: closable (default true), onClose().

import { h, clear, svgIcon } from './dom.js';
import { keepPageInPlace } from '../views/view-common.js';

const MAX_TOASTS = 3;
const LEAVE_MS = 200;
const BANNER_KINDS = new Set(['info', 'warn', 'error']);

function later(fn, ms) {
  const t = globalThis.setTimeout(fn, ms);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
}

function run(fn) {
  if (typeof fn !== 'function') return;
  try {
    const r = fn();
    if (r && typeof r.catch === 'function') r.catch((err) => console.warn('action failed', err));
  } catch (err) {
    console.warn('action failed', err);
  }
}

/** The shared toast container (div.toast-host, aria-live) appended to <body> on first use. */
function toastHost(doc) {
  let host = doc.querySelector('.toast-host');
  if (!host) {
    host = h('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'false' });
    doc.body.appendChild(host);
  }
  return host;
}

/**
 * Shows a toast.
 * @param {string} message
 * @param {{ actionLabel?: string, onAction?: Function, duration?: number, kind?: 'info'|'error',
 *           onClose?: Function }} [opts]
 * @returns {{ dismiss: () => void }}
 */
export function toast(message, { actionLabel, onAction, duration = 3000, kind = 'info', onClose } = {}) {
  const doc = globalThis.document;
  const text = typeof message === 'string' ? message : String(message ?? '');
  if (!doc || !doc.body || !text) return { dismiss() {} };

  const host = toastHost(doc);
  let timer = null;
  let gone = false;

  const el = h('div', { class: 'toast', dataset: { kind: kind === 'error' ? 'error' : 'info' } },
    h('span', { class: 'toast-text' }, text));

  function dismiss() {
    if (gone) return;
    gone = true;
    if (timer) globalThis.clearTimeout(timer);
    el.classList.add('is-leaving');
    later(() => el.remove(), LEAVE_MS);
  }

  if (actionLabel && typeof onAction === 'function') {
    el.appendChild(h('button', {
      type: 'button', class: 'toast-action',
      onClick: () => { dismiss(); run(onAction); },
    }, String(actionLabel)));
  }
  const sticky = !(Number(duration) > 0) || !Number.isFinite(Number(duration));
  if (sticky) {
    el.appendChild(h('button', {
      type: 'button', class: 'toast-close', 'aria-label': '閉じる',
      onClick: () => {
        if (gone) return;
        dismiss();
        run(onClose);
      },
    }, svgIcon('x', { size: 18 })));
  }

  // Keep at most MAX_TOASTS (oldest first out).
  const live = Array.from(host.children).filter((c) => !c.classList.contains('is-leaving'));
  for (const old of live.slice(0, Math.max(0, live.length - MAX_TOASTS + 1))) {
    old.classList.add('is-leaving');
    later(() => old.remove(), LEAVE_MS);
  }
  host.appendChild(el);
  if (!sticky) timer = later(dismiss, Number(duration));
  return { dismiss };
}

/** The page in the scroll container beside the banner (#app > .viewport > .page), or null. */
function pageBeside(el) {
  try {
    const vp = el.parentElement?.querySelector?.('.viewport');
    const page = vp?.querySelector?.('.page');
    return page && page.parentNode === vp ? page : null;
  } catch {
    return null;
  }
}

/**
 * Runs fn (which shows, refills or hides the banner) without moving the paper: the banner is an 'auto'
 * row above the scroll container, so a banner appearing in the middle of a stroke (e.g. after a failed
 * background refresh) would otherwise push the page — and the ink being written — down.
 */
function keepPaperStill(el, fn) {
  const page = pageBeside(el);
  if (!page) return fn();
  return keepPageInPlace(page, page.dataset?.fit, fn);
}

/**
 * Shows the banner in `el` (div.banner): icon, text, optional action button, close button.
 * @param {HTMLElement} el
 * @param {{ text: string, actionLabel?: string, onAction?: Function, kind?: 'info'|'warn'|'error',
 *           closable?: boolean, onClose?: Function }} opts
 */
export function showBanner(el, opts = {}) {
  if (!el) return;
  keepPaperStill(el, () => fillBanner(el, opts || {}));
}

function fillBanner(el, { text, actionLabel, onAction, kind = 'info', closable = true, onClose }) {
  const k = BANNER_KINDS.has(kind) ? kind : 'info';
  clear(el);
  el.classList.add('banner');
  el.dataset.kind = k;
  el.setAttribute('role', k === 'error' ? 'alert' : 'status');

  const children = [
    h('span', { class: 'banner-icon' }, svgIcon(k === 'info' ? 'info' : 'alert', { size: 20 })),
    h('span', { class: 'banner-text' }, typeof text === 'string' ? text : String(text ?? '')),
  ];
  if (actionLabel && typeof onAction === 'function') {
    const btn = h('button', {
      type: 'button', class: 'btn btn-sm banner-action',
      onClick: () => {
        // Guard against double taps (e.g. two sign-in redirects).
        btn.disabled = true;
        later(() => { btn.disabled = false; }, 1200);
        run(onAction);
      },
    }, String(actionLabel));
    children.push(btn);
  }
  if (closable !== false) {
    children.push(h('button', {
      type: 'button', class: 'icon-btn banner-close', 'aria-label': '閉じる', title: '閉じる',
      onClick: () => { hideBanner(el); run(onClose); },
    }, svgIcon('x', { size: 20 })));
  }
  el.append(...children);
  el.hidden = false;
}

/** Hides and empties the banner. */
export function hideBanner(el) {
  if (!el) return;
  keepPaperStill(el, () => {
    el.hidden = true;
    clear(el);
    delete el.dataset.kind;
  });
}
