// Floating tool palette (module F2b).
//
// createToolbar(el, handlers) → { update(state) }
//   handlers: onTool(tool), onPenColor(color), onPenSize(sizeKey), onHlColor(color), onUndo(), onRedo(),
//             onToggleCollapse(collapsed) (optional — lets main.js remember the collapsed state)
//   update({ tool, penColor, penSize, hlColor, canUndo, canRedo, collapsed? }) — partial updates are merged.
//
// Layout: [ペン マーカー 消しゴム 投げなわ 予定] | [contextual: pen → 6 colors + 3 sizes; marker → 4 colors]
//         | [元に戻す やり直す] [⌄ collapse]. Collapsed: a small pill [active tool][↶][↷][⌃].

import { h, clear, svgIcon } from './dom.js';
import { PEN_COLORS, HIGHLIGHTER_COLORS, PEN_SIZES } from '../ink/render.js';

export const TOOLS = Object.freeze([
  { id: 'pen', label: 'ペン', icon: 'pen' },
  { id: 'highlighter', label: 'マーカー', icon: 'highlighter' },
  { id: 'eraser', label: '消しゴム', icon: 'eraser' },
  { id: 'lasso', label: '投げなわ', icon: 'lasso' },
  { id: 'event', label: '予定', icon: 'calendar-plus' },
]);

const TOOL_IDS = new Set(TOOLS.map((t) => t.id));

/** Japanese names for the palette colors (accessibility labels). */
const COLOR_NAMES = {
  '#1f2937': '黒', '#2563eb': '青', '#dc2626': '赤', '#16a34a': '緑', '#ea580c': 'オレンジ', '#7c3aed': '紫',
  '#fde047': '黄', '#f9a8d4': 'ピンク', '#86efac': '緑', '#93c5fd': '水色',
};

const SIZE_LABELS = { thin: '細', medium: '中', thick: '太' };

/** Accessible name of a color ('黒', … or the hex code). */
export function colorName(color) {
  const key = typeof color === 'string' ? color.toLowerCase() : '';
  return COLOR_NAMES[key] || key || '色';
}

/**
 * Normalizes a pen size: a key of PEN_SIZES, or a numeric width that matches one of them.
 * Anything else → null.
 */
export function normalizePenSize(size) {
  if (typeof size === 'string' && Object.prototype.hasOwnProperty.call(PEN_SIZES, size)) return size;
  const n = Number(size);
  if (typeof size === 'number' && Number.isFinite(n)) {
    for (const [key, width] of Object.entries(PEN_SIZES)) if (Math.abs(width - n) < 1e-6) return key;
  }
  return null;
}

function sameColor(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

/** Merges a partial toolbar update into the current state, ignoring invalid values. */
export function mergeToolbarState(current, patch) {
  const next = { ...current };
  if (!patch || typeof patch !== 'object') return next;
  if (TOOL_IDS.has(patch.tool)) next.tool = patch.tool;
  if (typeof patch.penColor === 'string' && patch.penColor) next.penColor = patch.penColor;
  if (typeof patch.hlColor === 'string' && patch.hlColor) next.hlColor = patch.hlColor;
  const size = normalizePenSize(patch.penSize);
  if (size) next.penSize = size;
  if ('canUndo' in patch) next.canUndo = Boolean(patch.canUndo);
  if ('canRedo' in patch) next.canRedo = Boolean(patch.canRedo);
  if ('collapsed' in patch) next.collapsed = Boolean(patch.collapsed);
  return next;
}

function call(fn, ...args) {
  if (typeof fn !== 'function') return;
  try {
    fn(...args);
  } catch (err) {
    console.warn('toolbar handler failed', err);
  }
}

/**
 * Builds the toolbar inside `el` (div.toolbar).
 * @param {HTMLElement} el
 * @param {{ onTool?, onPenColor?, onPenSize?, onHlColor?, onUndo?, onRedo?, onToggleCollapse? }} handlers
 */
export function createToolbar(el, handlers = {}) {
  if (!el) throw new TypeError('createToolbar: el is required');
  const hd = handlers || {};
  let state = {
    tool: 'pen', penColor: PEN_COLORS[0], penSize: 'medium', hlColor: HIGHLIGHTER_COLORS[0],
    canUndo: false, canRedo: false, collapsed: false,
  };

  // ---- full palette
  const toolButtons = new Map();
  const toolsGroup = h('div', { class: 'tb-group tb-tools', role: 'group', 'aria-label': '道具' },
    TOOLS.map((t) => {
      const b = h('button', {
        type: 'button', class: 'tb-tool', 'aria-pressed': 'false', dataset: { tool: t.id },
        onClick: () => call(hd.onTool, t.id),
      }, svgIcon(t.icon, { size: 22 }), h('span', { class: 'tb-label' }, t.label));
      toolButtons.set(t.id, b);
      return b;
    }));

  const optionsGroup = h('div', { class: 'tb-group tb-options' });
  const optionsSep = h('div', { class: 'tb-sep', 'aria-hidden': 'true' });

  const undoBtn = h('button', {
    type: 'button', class: 'tb-btn tb-undo', 'aria-label': '元に戻す', title: '元に戻す', disabled: true,
    onClick: () => call(hd.onUndo),
  }, svgIcon('undo', { size: 22 }));
  const redoBtn = h('button', {
    type: 'button', class: 'tb-btn tb-redo', 'aria-label': 'やり直す', title: 'やり直す', disabled: true,
    onClick: () => call(hd.onRedo),
  }, svgIcon('redo', { size: 22 }));
  const collapseBtn = h('button', {
    type: 'button', class: 'tb-btn tb-collapse', 'aria-label': 'ツールバーをたたむ', title: 'ツールバーをたたむ',
    onClick: () => setCollapsed(true),
  }, svgIcon('chevron-down', { size: 22 }));

  const full = h('div', { class: 'tb-full' },
    toolsGroup,
    optionsSep,
    optionsGroup,
    h('div', { class: 'tb-sep', 'aria-hidden': 'true' }),
    h('div', { class: 'tb-group tb-history' }, undoBtn, redoBtn),
    collapseBtn);

  // ---- collapsed pill
  const miniToolIcon = h('span', { class: 'tb-mini-icon' });
  const miniDot = h('span', { class: 'tb-mini-dot', 'aria-hidden': 'true' });
  const miniTool = h('button', {
    type: 'button', class: 'tb-mini-tool', onClick: () => setCollapsed(false),
  }, miniToolIcon, miniDot);
  const miniUndo = h('button', {
    type: 'button', class: 'tb-btn tb-undo', 'aria-label': '元に戻す', title: '元に戻す', disabled: true,
    onClick: () => call(hd.onUndo),
  }, svgIcon('undo', { size: 22 }));
  const miniRedo = h('button', {
    type: 'button', class: 'tb-btn tb-redo', 'aria-label': 'やり直す', title: 'やり直す', disabled: true,
    onClick: () => call(hd.onRedo),
  }, svgIcon('redo', { size: 22 }));
  const expandBtn = h('button', {
    type: 'button', class: 'tb-btn tb-expand', 'aria-label': 'ツールバーを開く', title: 'ツールバーを開く',
    onClick: () => setCollapsed(false),
  }, svgIcon('chevron-up', { size: 22 }));
  const mini = h('div', { class: 'tb-mini' }, miniTool, miniUndo, miniRedo, expandBtn);

  clear(el);
  el.classList.add('toolbar');
  if (!el.hasAttribute('role')) el.setAttribute('role', 'toolbar');
  if (!el.hasAttribute('aria-label')) el.setAttribute('aria-label', '書く道具');
  el.append(full, mini);

  function setCollapsed(collapsed) {
    if (state.collapsed === collapsed) return;
    state = { ...state, collapsed };
    render();
    call(hd.onToggleCollapse, collapsed);
  }

  // ---- contextual options (rebuilt only when the tool changes)
  let optionsFor = null;
  const swatches = [];
  const sizeButtons = [];

  function buildOptions() {
    clear(optionsGroup);
    swatches.length = 0;
    sizeButtons.length = 0;
    const tool = state.tool;
    if (tool === 'pen' || tool === 'highlighter') {
      const colors = tool === 'pen' ? PEN_COLORS : HIGHLIGHTER_COLORS;
      const handler = tool === 'pen' ? hd.onPenColor : hd.onHlColor;
      const colorGroup = h('div', { class: 'tb-colors', role: 'group', 'aria-label': '色' },
        colors.map((color) => {
          const b = h('button', {
            type: 'button', class: ['tb-swatch', tool === 'highlighter' ? 'is-marker' : ''],
            'aria-pressed': 'false', 'aria-label': colorName(color), title: colorName(color),
            dataset: { color }, style: { '--swatch': color },
            onClick: () => call(handler, color),
          }, h('span', { class: 'tb-swatch-dot', 'aria-hidden': 'true' }));
          swatches.push(b);
          return b;
        }));
      optionsGroup.append(colorGroup);
    }
    if (tool === 'pen') {
      const sizeGroup = h('div', { class: 'tb-sizes', role: 'group', 'aria-label': '太さ' },
        Object.keys(PEN_SIZES).map((key) => {
          const b = h('button', {
            type: 'button', class: 'tb-size', 'aria-pressed': 'false',
            'aria-label': `太さ：${SIZE_LABELS[key] || key}`, title: `太さ：${SIZE_LABELS[key] || key}`,
            dataset: { size: key }, onClick: () => call(hd.onPenSize, key),
          }, h('span', { class: `tb-size-dot is-${key}`, 'aria-hidden': 'true' }));
          sizeButtons.push(b);
          return b;
        }));
      optionsGroup.append(sizeGroup);
    }
    const empty = !optionsGroup.firstChild;
    optionsGroup.hidden = empty;
    optionsSep.hidden = empty;
    optionsFor = tool;
  }

  let lastMiniIcon = null;

  function render() {
    if (optionsFor !== state.tool) buildOptions();

    for (const [id, b] of toolButtons) {
      const on = id === state.tool;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.classList.toggle('is-active', on);
    }
    const activeColor = state.tool === 'highlighter' ? state.hlColor : state.penColor;
    for (const b of swatches) {
      const on = sameColor(b.dataset.color, activeColor);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.classList.toggle('is-active', on);
    }
    for (const b of sizeButtons) {
      const on = b.dataset.size === state.penSize;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.classList.toggle('is-active', on);
    }
    el.style.setProperty('--pen-color', state.penColor);

    undoBtn.disabled = !state.canUndo;
    redoBtn.disabled = !state.canRedo;
    miniUndo.disabled = !state.canUndo;
    miniRedo.disabled = !state.canRedo;

    const tool = TOOLS.find((t) => t.id === state.tool) || TOOLS[0];
    if (lastMiniIcon !== tool.icon) {
      clear(miniToolIcon).appendChild(svgIcon(tool.icon, { size: 22 }));
      lastMiniIcon = tool.icon;
    }
    const dotColor = state.tool === 'pen' ? state.penColor : (state.tool === 'highlighter' ? state.hlColor : '');
    miniDot.hidden = !dotColor;
    if (dotColor) miniDot.style.setProperty('--swatch', dotColor);
    miniTool.setAttribute('aria-label', `${tool.label}（ツールバーを開く）`);
    miniTool.title = `${tool.label}（ツールバーを開く）`;

    el.classList.toggle('is-collapsed', state.collapsed);
    el.dataset.tool = state.tool;
    full.hidden = state.collapsed;
    mini.hidden = !state.collapsed;
  }

  function update(patch) {
    state = mergeToolbarState(state, patch);
    render();
  }

  render();
  return { update };
}
