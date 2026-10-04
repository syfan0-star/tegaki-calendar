// Tiny DOM helpers shared by the UI modules (module F2b).
//
//   h(tag, attrs, ...children)  — element builder
//   clear(el)                   — removes all children
//   svgIcon(name, opts)         — inline 24×24 stroke icons (no external assets)
//
// Extra helpers (used by the dialogs): openModal / isModalOpen (modal sheet plumbing: Esc, backdrop,
// focus trap, focus restore, background inert, iPad keyboard), switchControl (iOS-like toggle).
//
// Nothing touches `document` at module load, so this file can be imported in Node for tests.

const SVG_NS = 'http://www.w3.org/2000/svg';

function getDoc() {
  const doc = globalThis.document;
  if (!doc) throw new Error('DOM が利用できません');
  return doc;
}

// ---------------------------------------------------------------------------------------------
// h() / clear()

/** Attributes that are set as boolean DOM properties (false → removed). */
const BOOL_PROPS = new Set(['disabled', 'checked', 'hidden', 'selected', 'required', 'readOnly', 'multiple']);
/** Attributes that are set as DOM properties (value must win over the attribute for form controls). */
const VALUE_PROPS = new Set(['value', 'htmlFor']);

function isNode(v) {
  return v != null && typeof v === 'object' && typeof v.nodeType === 'number';
}

function classString(v) {
  if (Array.isArray(v)) return v.filter((c) => typeof c === 'string' && c).join(' ');
  return typeof v === 'string' ? v : '';
}

function applyStyle(el, style) {
  if (typeof style === 'string') {
    el.style.cssText = style;
    return;
  }
  if (!style || typeof style !== 'object') return;
  for (const [k, v] of Object.entries(style)) {
    if (v == null || v === false) continue;
    if (k.startsWith('--')) el.style.setProperty(k, String(v));
    else el.style[k] = String(v);
  }
}

function applyAttrs(el, attrs) {
  if (!attrs || typeof attrs !== 'object') return;
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    if (key === 'class' || key === 'className') {
      const cls = classString(value);
      if (cls) el.setAttribute('class', cls);
    } else if (key === 'style') {
      applyStyle(el, value);
    } else if (key === 'dataset') {
      if (typeof value === 'object') {
        for (const [dk, dv] of Object.entries(value)) if (dv != null) el.dataset[dk] = String(dv);
      }
    } else if (key.length > 2 && key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (BOOL_PROPS.has(key)) {
      el[key] = Boolean(value);
    } else if (VALUE_PROPS.has(key)) {
      el[key] = String(value);
    } else if (value === true) {
      el.setAttribute(key, '');
    } else if (value !== false) {
      el.setAttribute(key, String(value));
    }
  }
}

function appendChildren(el, children) {
  for (const child of children) {
    if (child == null || child === false || child === true) continue;
    if (Array.isArray(child)) appendChildren(el, child);
    else if (isNode(child)) el.appendChild(child);
    else el.appendChild(el.ownerDocument.createTextNode(String(child)));
  }
}

/**
 * Creates an HTML element.
 *   attrs: class/className (string | string[]), style (string | object, '--vars' allowed), dataset (object),
 *          onClick/onInput/... (functions → addEventListener), disabled/checked/hidden/selected/... (boolean
 *          properties), value (property), true → empty attribute, false/null/undefined → skipped.
 *   children: strings/numbers (text), Nodes, nested arrays; null/undefined/booleans are skipped.
 */
export function h(tag, attrs, ...children) {
  const el = getDoc().createElement(String(tag));
  applyAttrs(el, attrs);
  appendChildren(el, children);
  return el;
}

/** Same as h() for SVG elements (attributes are always set as attributes). */
export function hSvg(tag, attrs, ...children) {
  const el = getDoc().createElementNS(SVG_NS, String(tag));
  if (attrs && typeof attrs === 'object') {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'className') el.setAttribute('class', classString(v));
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  appendChildren(el, children);
  return el;
}

/** Removes every child of el; returns el (null-safe). */
export function clear(el) {
  if (!el) return el;
  if (typeof el.replaceChildren === 'function') el.replaceChildren();
  else while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

// ---------------------------------------------------------------------------------------------
// Icons: 24×24, stroke = currentColor, round caps/joins. Each icon is a list of [tag, attrs].

/** Gear outline with 8 trapezoid teeth (computed once; pure math). */
function gearPath(teeth = 8, rOut = 9.6, rIn = 7.3, halfOut = 0.15, halfIn = 0.27) {
  const f = (v) => (Math.round(v * 100) / 100).toString();
  const pt = (r, a) => `${f(12 + r * Math.cos(a))} ${f(12 + r * Math.sin(a))}`;
  const step = (Math.PI * 2) / teeth;
  let d = '';
  for (let i = 0; i < teeth; i += 1) {
    const a = i * step - Math.PI / 2;
    d += `${i === 0 ? 'M' : 'L'}${pt(rIn, a - halfIn)}L${pt(rOut, a - halfOut)}L${pt(rOut, a + halfOut)}L${pt(rIn, a + halfIn)}`;
    d += `A${rIn} ${rIn} 0 0 1 ${pt(rIn, a + step - halfIn)}`;
  }
  return `${d}Z`;
}

const CLOUD = ['path', { d: 'M7 19h10a4 4 0 0 0 0-8a5 5 0 0 0-10 0a4 4 0 0 0 0 8z' }];
const DOT = (cx, cy, r = 1.1) => ['circle', { cx, cy, r, fill: 'currentColor', stroke: 'none' }];

const ICONS = {
  'chevron-left': [['path', { d: 'M15 5l-7 7 7 7' }]],
  'chevron-right': [['path', { d: 'M9 5l7 7-7 7' }]],
  'chevron-up': [['path', { d: 'M5.5 15l6.5-6.5 6.5 6.5' }]],
  'chevron-down': [['path', { d: 'M5.5 9l6.5 6.5 6.5-6.5' }]],
  plus: [['path', { d: 'M12 5v14M5 12h14' }]],
  check: [['path', { d: 'M5 12.5l4.5 4.5L19 7.5' }]],
  x: [['path', { d: 'M6.5 6.5l11 11M17.5 6.5l-11 11' }]],
  gear: [['path', { d: gearPath() }], ['circle', { cx: 12, cy: 12, r: 3 }]],
  pen: [
    ['path', { d: 'M4 20l1.1-4.4L15.6 5.1a2.1 2.1 0 0 1 3 0l.3.3a2.1 2.1 0 0 1 0 3L8.4 18.9z' }],
    ['path', { d: 'M13.6 7.1l3.3 3.3' }],
  ],
  highlighter: [
    ['path', { d: 'M15.2 3.6l5.2 5.2-7.9 7.9-5.2-5.2z' }],
    ['path', { d: 'M7.3 11.5l-1.6 4.8 2 2 4.8-1.6' }],
    ['path', { d: 'M5.7 16.3L3 19h4l.7-.7' }],
    ['path', { d: 'M13 21h8' }],
  ],
  eraser: [
    ['path', { d: 'M13.4 4.3a1.8 1.8 0 0 1 2.5 0l3.8 3.8a1.8 1.8 0 0 1 0 2.5L11 19.3H7.3l-3-3a1.8 1.8 0 0 1 0-2.5z' }],
    ['path', { d: 'M8.6 9.1l6.3 6.3' }],
    ['path', { d: 'M11 19.3h9' }],
  ],
  lasso: [
    ['ellipse', { cx: 12.5, cy: 9.5, rx: 8, ry: 5.5, 'stroke-dasharray': '3.2 2.6' }],
    ['path', { d: 'M7.6 13.9c-1.3 1.2-1.2 3 .4 3.4 1.7.4 1.8 2.2.2 3.7' }],
  ],
  'calendar-plus': [
    ['rect', { x: 3.5, y: 5, width: 17, height: 15.5, rx: 2.5 }],
    ['path', { d: 'M3.5 10h17M8 3v4M16 3v4' }],
    ['path', { d: 'M12 12.8v5.4M9.3 15.5h5.4' }],
  ],
  calendar: [
    ['rect', { x: 3.5, y: 5, width: 17, height: 15.5, rx: 2.5 }],
    ['path', { d: 'M3.5 10h17M8 3v4M16 3v4' }],
  ],
  undo: [['path', { d: 'M9 14.5L4 9.5l5-5' }], ['path', { d: 'M4 9.5h10.5a5.25 5.25 0 0 1 0 10.5H11' }]],
  redo: [['path', { d: 'M15 14.5l5-5-5-5' }], ['path', { d: 'M20 9.5H9.5a5.25 5.25 0 0 0 0 10.5H13' }]],
  cloud: [CLOUD],
  'cloud-check': [CLOUD, ['path', { d: 'M9.4 14.6l1.9 1.9 3.4-3.7' }]],
  'cloud-upload': [CLOUD, ['path', { d: 'M12 17.2v-5M9.8 14.2l2.2-2.2 2.2 2.2' }]],
  'cloud-off': [CLOUD, ['path', { d: 'M4 4l16 16' }]],
  tablet: [['rect', { x: 5, y: 2.75, width: 14, height: 18.5, rx: 2.5 }], ['path', { d: 'M10.5 18h3' }]],
  alert: [
    ['path', { d: 'M10.3 4.6a2 2 0 0 1 3.4 0l7.5 13a2 2 0 0 1-1.7 3H4.5a2 2 0 0 1-1.7-3z' }],
    ['path', { d: 'M12 9.5v4' }],
    DOT(12, 16.9),
  ],
  info: [['circle', { cx: 12, cy: 12, r: 8.75 }], ['path', { d: 'M12 11v5.5' }], DOT(12, 7.9)],
  user: [['circle', { cx: 12, cy: 8.25, r: 3.75 }], ['path', { d: 'M4.75 20.25a7.25 7.25 0 0 1 14.5 0' }]],
  trash: [
    ['path', { d: 'M4 7h16M9.5 7V4.75h5V7' }],
    ['path', { d: 'M6 7l1 12.25A1.5 1.5 0 0 0 8.5 20.75h7a1.5 1.5 0 0 0 1.5-1.5L18 7' }],
    ['path', { d: 'M10 11v6M14 11v6' }],
  ],
  external: [
    ['path', { d: 'M14 4h6v6M20 4l-8.5 8.5' }],
    ['path', { d: 'M18 13.5v5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6h5' }],
  ],
  repeat: [
    ['path', { d: 'M17 2.5l3 3-3 3' }],
    ['path', { d: 'M4 11.5v-1a5 5 0 0 1 5-5h11' }],
    ['path', { d: 'M7 21.5l-3-3 3-3' }],
    ['path', { d: 'M20 12.5v1a5 5 0 0 1-5 5H4' }],
  ],
};

/** Names accepted by svgIcon(). */
export const ICON_NAMES = Object.freeze(Object.keys(ICONS));

/**
 * Inline SVG icon (decorative: aria-hidden). Unknown names give an empty icon instead of throwing.
 * @param {string} name
 * @param {{ size?: number, className?: string, strokeWidth?: number }} [opts]
 */
export function svgIcon(name, { size = 24, className = '', strokeWidth = 1.8 } = {}) {
  const shapes = Object.prototype.hasOwnProperty.call(ICONS, name) ? ICONS[name] : [];
  const svg = hSvg('svg', {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': strokeWidth,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
    class: `icon icon-${String(name).replace(/[^a-z0-9-]/gi, '')}${className ? ` ${className}` : ''}`,
  });
  for (const [tag, attrs] of shapes) svg.appendChild(hSvg(tag, attrs));
  return svg;
}

// ---------------------------------------------------------------------------------------------
// Form helpers

let uidCounter = 0;
/** Unique DOM id with a readable prefix. */
export function uid(prefix = 'ui') {
  uidCounter += 1;
  return `${prefix}-${uidCounter}`;
}

/**
 * iOS-like switch: <label class="switch-row"><span>text</span><span class="switch"><input type=checkbox
 * role=switch><span class="switch-track"></span></span></label>.
 * @returns {{ row: HTMLElement, input: HTMLInputElement }}
 */
export function switchControl(text, { checked = false, disabled = false, hint = '', onChange } = {}) {
  const input = h('input', {
    type: 'checkbox',
    role: 'switch',
    checked,
    disabled,
    onChange: typeof onChange === 'function' ? () => onChange(input.checked) : null,
  });
  const row = h('label', { class: 'switch-row' },
    h('span', { class: 'switch-text' },
      h('span', { class: 'switch-label' }, text),
      hint ? h('span', { class: 'switch-hint' }, hint) : null),
    h('span', { class: 'switch' }, input, h('span', { class: 'switch-track', 'aria-hidden': 'true' })));
  return { row, input };
}

// ---------------------------------------------------------------------------------------------
// Modal plumbing

const FOCUSABLE_TAGS = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);

function isFocusable(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.disabled) return false;
  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'INPUT' && String(el.type).toLowerCase() === 'hidden') return false;
  if (FOCUSABLE_TAGS.has(tag)) return true;
  if (tag === 'A' && el.hasAttribute('href')) return true;
  const ti = el.getAttribute('tabindex');
  return ti != null && Number(ti) >= 0;
}

/** Focusable descendants in document order (hidden subtrees skipped). */
export function focusableWithin(root) {
  const out = [];
  const walk = (node) => {
    for (const child of Array.from(node.children || [])) {
      if (child.hidden) continue;
      if (isFocusable(child)) out.push(child);
      walk(child);
    }
  };
  if (root) walk(root);
  return out;
}

function isEditable(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = String(el.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

function safeFocus(el) {
  try {
    el.focus({ preventScroll: true });
  } catch {
    try { el.focus(); } catch { /* ignore */ }
  }
}

/** The modal host: #dialog-root (never inside .page — Scribble), else <body>. */
function resolveModalRoot(doc, root) {
  let host = root && isNode(root) ? root : doc.getElementById?.('dialog-root');
  if (host && typeof host.closest === 'function' && host.closest('.page')) host = null;
  return host || doc.body;
}

let activeModal = null;

/** True while a modal sheet (event dialog / settings) is open. */
export function isModalOpen() {
  return Boolean(activeModal);
}

/**
 * Opens a modal sheet: div.dialog-backdrop > div.dialog[role=dialog][aria-modal=true].
 * Handles Esc and backdrop taps (→ onDismiss(reason)), a Tab focus trap, focus save/restore, `inert` on the
 * rest of the app and the iPad on-screen keyboard (visualViewport → --vv-top/--vv-bottom on the backdrop).
 * The dialog element itself gets focus (tabindex=-1): never an input, so no keyboard pops up.
 * Opening a modal while another is open dismisses the old one first (reason 'replaced').
 *
 * @param {{ root?: Element, className?: string, labelledBy?: string, label?: string,
 *           onDismiss?: (reason: 'escape'|'backdrop'|'replaced') => void }} opts
 * @returns {{ backdrop: HTMLElement, dialog: HTMLElement, close: () => void, isOpen: () => boolean }}
 */
export function openModal({ root, className = '', labelledBy, label, onDismiss } = {}) {
  if (activeModal) {
    const old = activeModal;
    try { old.dismiss('replaced'); } catch (err) { console.warn('modal dismiss failed', err); }
    if (old.isOpen()) old.close();
  }

  const doc = getDoc();
  const win = doc.defaultView || globalThis;
  const host = resolveModalRoot(doc, root);
  const previouslyFocused = doc.activeElement;

  const dialog = h('div', {
    class: ['dialog', className],
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': labelledBy || null,
    'aria-label': labelledBy ? null : (label || null),
    tabindex: '-1',
  });
  const backdrop = h('div', { class: 'dialog-backdrop' }, dialog);

  let open = true;
  const cleanups = [];
  const listen = (target, type, fn, opts) => {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  };

  const modal = {
    backdrop,
    dialog,
    isOpen: () => open,
    close,
    dismiss(reason) {
      if (!open) return;
      if (typeof onDismiss === 'function') onDismiss(reason);
      else close();
    },
  };

  // Backdrop tap = dismiss, but only when the gesture also started on the backdrop (a Scribble stroke or
  // a text selection drag that strays outside the sheet must not close it). If a field is focused (iPad
  // keyboard up), the first tap only closes the keyboard.
  let downTarget = null;
  listen(backdrop, 'pointerdown', (e) => { downTarget = e.target; });
  listen(backdrop, 'click', (e) => {
    const startedElsewhere = downTarget && downTarget !== backdrop;
    downTarget = null;
    if (e.target !== backdrop || startedElsewhere) return;
    const active = doc.activeElement;
    if (isEditable(active) && dialog.contains(active)) {
      active.blur();
      return;
    }
    modal.dismiss('backdrop');
  });

  const onKeyDown = (e) => {
    if (e.isComposing || e.keyCode === 229) return; // IME conversion in progress
    if (e.key === 'Escape') {
      e.preventDefault();
      modal.dismiss('escape');
    } else if (e.key === 'Tab') {
      trapTab(e);
    }
  };
  const trapTab = (e) => {
    const items = focusableWithin(dialog);
    if (!items.length) {
      e.preventDefault();
      safeFocus(dialog);
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = doc.activeElement;
    if (e.shiftKey && (active === first || active === dialog || !dialog.contains(active))) {
      e.preventDefault();
      safeFocus(last);
    } else if (!e.shiftKey && (active === last || !dialog.contains(active))) {
      e.preventDefault();
      safeFocus(first);
    }
  };
  // Keys typed inside the sheet must not reach the app's global shortcuts (←/→/t/d/w/m…).
  listen(backdrop, 'keydown', (e) => {
    onKeyDown(e);
    e.stopPropagation();
  });
  // Esc / Tab while focus is outside the sheet (e.g. on <body>).
  listen(doc, 'keydown', (e) => {
    if (backdrop.contains(e.target)) return;
    onKeyDown(e);
  });

  // iPad on-screen keyboard: keep the sheet inside the visual viewport.
  const vv = win.visualViewport;
  if (vv) {
    const syncViewport = () => {
      const innerH = win.innerHeight || vv.height;
      const top = Math.max(0, vv.offsetTop || 0);
      const bottom = Math.max(0, innerH - vv.height - top);
      backdrop.style.setProperty('--vv-top', `${Math.round(top)}px`);
      backdrop.style.setProperty('--vv-bottom', `${Math.round(bottom)}px`);
    };
    listen(vv, 'resize', syncViewport);
    listen(vv, 'scroll', syncViewport);
    syncViewport();
  }

  host.appendChild(backdrop);

  // Make the rest of the app inert (focus + a11y); toasts stay usable.
  const inerted = [];
  const container = host === doc.body ? host : host.parentElement;
  for (const sib of Array.from(container?.children || [])) {
    if (sib === host || sib === backdrop || sib.contains(backdrop)) continue;
    if (sib.classList?.contains('toast-host')) continue;
    const tag = String(sib.tagName || '').toUpperCase();
    if (tag === 'SCRIPT' || tag === 'STYLE' || sib.hasAttribute('inert')) continue;
    sib.setAttribute('inert', '');
    inerted.push(sib);
  }

  if (host.dataset) host.dataset.modalOpen = 'true';
  activeModal = modal;
  safeFocus(dialog);

  function close() {
    if (!open) return;
    open = false;
    for (const fn of cleanups.splice(0)) {
      try { fn(); } catch { /* ignore */ }
    }
    for (const el of inerted) el.removeAttribute('inert');
    backdrop.remove();
    if (activeModal === modal) activeModal = null;
    if (host.dataset && !activeModal) delete host.dataset.modalOpen;
    const back = previouslyFocused;
    if (back && back !== doc.body && back.isConnected && typeof back.focus === 'function') safeFocus(back);
  }

  return modal;
}

/** Restarts a one-shot CSS animation class (e.g. 'is-shaking') on el. */
export function replayClass(el, cls, ms = 600) {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth; // reflow so the animation restarts
  el.classList.add(cls);
  const timer = globalThis.setTimeout?.(() => el.classList.remove(cls), ms);
  if (timer && typeof timer.unref === 'function') timer.unref();
}
