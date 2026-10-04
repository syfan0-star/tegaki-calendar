// Floating menu for a lasso selection (module F2b): 「予定にする」 「削除」 「選択解除」.
//
// createSelectionMenu(el, { onConvert, onDelete, onDeselect }) → { show(screenRect), hide() }
//   screenRect: DOMRect-like client rect of the selection ({ left, top, right, bottom } or { x, y, width, height }).
//   The menu sits above the selection, or below it when there is no room above, clamped to the visible area
//   (below the app header, above the toolbar).

import { h, clear, svgIcon } from './dom.js';

const GAP = 10; // px between the selection and the menu
const MARGIN = 8; // px kept free at the edges of the visible area

/** Normalizes a DOMRect-like object to { left, top, right, bottom } (null if unusable). */
export function toClientRect(r) {
  if (!r || typeof r !== 'object') return null;
  const left = Number(r.left ?? r.x);
  const top = Number(r.top ?? r.y);
  let right = Number(r.right);
  let bottom = Number(r.bottom);
  if (!Number.isFinite(right)) right = left + Number(r.width);
  if (!Number.isFinite(bottom)) bottom = top + Number(r.height);
  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  return {
    left: Math.min(left, right), top: Math.min(top, bottom),
    right: Math.max(left, right), bottom: Math.max(top, bottom),
  };
}

/**
 * Position of a menu of `size` next to `anchor` inside `bounds` (all client px).
 * Above when it fits, else below, else inside the bounds overlapping the anchor ('over').
 * Horizontally centered on the anchor and clamped into the bounds.
 * @param {{left,top,right,bottom}} anchor
 * @param {{width:number,height:number}} size
 * @param {{left,top,right,bottom}} bounds
 * @returns {{ left: number, top: number, placement: 'above'|'below'|'over' }}
 */
export function placeMenu(anchor, size, bounds, gap = GAP) {
  const w = Math.max(0, Number(size?.width) || 0);
  const hgt = Math.max(0, Number(size?.height) || 0);
  const b = toClientRect(bounds) || { left: 0, top: 0, right: w, bottom: hgt };
  const a = toClientRect(anchor) || { left: b.left, top: b.top, right: b.right, bottom: b.bottom };

  const clampX = (x) => Math.min(Math.max(x, b.left), Math.max(b.left, b.right - w));
  const clampY = (y) => Math.min(Math.max(y, b.top), Math.max(b.top, b.bottom - hgt));

  const left = clampX((a.left + a.right) / 2 - w / 2);
  const aboveTop = a.top - gap - hgt;
  if (aboveTop >= b.top && a.top <= b.bottom) return { left, top: aboveTop, placement: 'above' };
  const belowTop = a.bottom + gap;
  if (belowTop + hgt <= b.bottom && a.bottom >= b.top) return { left, top: belowTop, placement: 'below' };
  // No room on either side (very tall selection or the selection is off screen): keep it visible.
  const overTop = clampY(Math.max(a.top, b.top) + gap);
  return { left, top: overTop, placement: 'over' };
}

/** Visible area for floating UI: the window minus the header (top) and the toolbar (bottom). */
function visibleBounds(doc) {
  const win = doc.defaultView || globalThis;
  const vv = win.visualViewport;
  const width = vv?.width || win.innerWidth || doc.documentElement?.clientWidth || 0;
  const height = vv?.height || win.innerHeight || doc.documentElement?.clientHeight || 0;
  const offL = vv?.offsetLeft || 0;
  const offT = vv?.offsetTop || 0;
  let top = offT + MARGIN;
  let bottom = offT + height - MARGIN;
  try {
    const header = doc.querySelector('.app-header');
    const hr = header?.getBoundingClientRect?.();
    if (hr && hr.bottom > top && hr.bottom < bottom) top = hr.bottom + MARGIN;
    const toolbar = doc.querySelector('.toolbar');
    const tr = toolbar && !toolbar.hidden ? toolbar.getBoundingClientRect?.() : null;
    if (tr && tr.height > 0 && tr.top > top && tr.top < bottom) bottom = tr.top - MARGIN;
  } catch {
    /* measuring is best effort */
  }
  return { left: offL + MARGIN, top, right: offL + width - MARGIN, bottom };
}

function call(fn) {
  if (typeof fn !== 'function') return;
  try {
    fn();
  } catch (err) {
    console.warn('selection menu handler failed', err);
  }
}

/**
 * Builds the menu inside `el` (div.selection-menu). Hidden until show().
 * @param {HTMLElement} el
 * @param {{ onConvert?: Function, onDelete?: Function, onDeselect?: Function }} handlers
 */
export function createSelectionMenu(el, handlers = {}) {
  if (!el) throw new TypeError('createSelectionMenu: el is required');
  const hd = handlers || {};

  const item = (cls, icon, label, fn) => h('button', {
    type: 'button', class: ['sm-btn', cls], role: 'menuitem', onClick: () => call(fn),
  }, svgIcon(icon, { size: 18 }), h('span', null, label));

  clear(el);
  el.classList.add('selection-menu');
  if (!el.hasAttribute('role')) el.setAttribute('role', 'menu');
  if (!el.hasAttribute('aria-label')) el.setAttribute('aria-label', '選択した手書き');
  el.append(
    item('sm-primary', 'calendar-plus', '予定にする', hd.onConvert),
    item('', 'trash', '削除', hd.onDelete),
    item('', 'x', '選択解除', hd.onDeselect),
  );
  el.hidden = true;

  function show(screenRect) {
    const doc = el.ownerDocument || globalThis.document;
    el.hidden = false;
    // Measure at the origin first so a previous position near the edge does not squeeze the menu.
    el.style.left = '0px';
    el.style.top = '0px';
    const size = { width: el.offsetWidth || 0, height: el.offsetHeight || 0 };
    const pos = placeMenu(screenRect, size, visibleBounds(doc));
    el.style.left = `${Math.round(pos.left)}px`;
    el.style.top = `${Math.round(pos.top)}px`;
    el.dataset.placement = pos.placement;
  }

  function hide() {
    el.hidden = true;
    delete el.dataset.placement;
  }

  return { show, hide };
}
