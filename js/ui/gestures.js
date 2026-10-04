// Two-finger tap → pen ↔ eraser (module F2a; pure, no DOM).
//
// Apple Pencil's double-tap / squeeze (UIPencilInteraction) is native-only: no web page ever receives it.
// The app offers a two-finger tap on the page instead. main.js feeds this recognizer with snapshots of the
// touch events of the viewport (passive listeners) and switches the tool when end() reports a tap.
//
// A two-finger tap is:
//   - exactly two finger ('direct') touches, the first of them landing while no other touch was down,
//     no stylus touch at any time (iPadOS does not deliver fingers while the Pencil is down anyway);
//   - both fingers lifted within maxMs of the first touch;
//   - each finger moved less than maxMove CSS px, and the viewport did not scroll in between;
//   - not blocked (pen down, a dialog open, …) at its start or at its end (main.js decides `blocked`).
// It never cancels or prevents anything: the touches still scroll, swipe or tap as before (a swipe needs
// one finger and > 80 px, so the two never fire on the same gesture).

export const TWO_FINGER_TAP = Object.freeze({ maxMs: 350, maxMove: 12 });

/** Labels of the toast shown after the switch. */
export const TOOL_TOAST_LABELS = Object.freeze({ eraser: '消しゴム', pen: 'ペン', highlighter: 'マーカー' });

const INK_TOOLS = new Set(['pen', 'highlighter']);

/**
 * The tool a two-finger tap switches to: from the eraser back to the last ink tool (pen or highlighter;
 * pen when unknown), from anything else (pen, highlighter, lasso, 予定) to the eraser.
 * @param {string} tool          current tool
 * @param {string} [lastInkTool] last pen/highlighter tool used
 * @returns {{ tool: 'pen'|'highlighter'|'eraser', label: string }}
 */
export function twoFingerTapTool(tool, lastInkTool) {
  if (tool === 'eraser') {
    const next = INK_TOOLS.has(lastInkTool) ? lastInkTool : 'pen';
    return { tool: next, label: TOOL_TOAST_LABELS[next] };
  }
  return { tool: 'eraser', label: TOOL_TOAST_LABELS.eraser };
}

/**
 * One touch of a TouchList as plain data: { id, x, y, stylus }.
 * @param {Touch|any} t
 */
export function touchPoint(t) {
  return {
    id: t?.identifier,
    x: Number(t?.clientX) || 0,
    y: Number(t?.clientY) || 0,
    stylus: t?.touchType === 'stylus',
  };
}

/** TouchList (or array) → touchPoint[]. */
export function touchPoints(list) {
  const out = [];
  if (!list || typeof list.length !== 'number') return out;
  for (let i = 0; i < list.length; i++) {
    const t = list[i] ?? (typeof list.item === 'function' ? list.item(i) : null);
    if (t) out.push(touchPoint(t));
  }
  return out;
}

const list = (v) => (Array.isArray(v) ? v.filter((p) => p && p.id !== undefined && p.id !== null) : []);

/**
 * Recognizer for the two-finger tap. Every call takes plain data (see touchPoints):
 *   start({ touches, changed, at, scroll, blocked })  touchstart (touches = e.touches, changed = e.changedTouches)
 *   move({ touches })                                touchmove
 *   end({ touches, changed, at, scroll, blocked })   touchend → { startAt, endAt } when a two-finger tap
 *                                                    just ended (all fingers up), else null
 *   cancel()                                         touchcancel: forget the gesture
 *   scrolled()                                       the viewport scrolled: the gesture is no tap
 *   active()                                         a gesture is being tracked
 * scroll = { top, left } of the viewport (optional; compared between start and end).
 * @param {{ maxMs?: number, maxMove?: number }} [opts]
 */
export function createTwoFingerTapRecognizer({ maxMs = TWO_FINGER_TAP.maxMs, maxMove = TWO_FINGER_TAP.maxMove } = {}) {
  let g = null; // { startAt, points: Map(id → {x, y}), max, invalid, scroll }

  const tooFar = (p) => {
    const s = g.points.get(p.id);
    return !!s && Math.hypot(p.x - s.x, p.y - s.y) >= maxMove;
  };

  function start({ touches, changed, at = Date.now(), scroll = null, blocked = false } = {}) {
    const all = list(touches);
    const fresh = list(changed);
    const freshIds = new Set(fresh.map((p) => p.id));
    // Every finger down is new → a new gesture (this also drops a gesture whose touchend got lost).
    if (all.length && all.every((p) => freshIds.has(p.id))) {
      g = { startAt: Number(at), points: new Map(), max: 0, invalid: false, scroll: scroll ? { ...scroll } : null };
    } else if (!g) {
      return; // a finger was already down (outside the viewport, or a gesture we did not see start)
    }
    for (const p of fresh) if (!g.points.has(p.id)) g.points.set(p.id, { x: p.x, y: p.y });
    g.max = Math.max(g.max, all.length);
    if (blocked || g.points.size > 2 || all.length > 2 || all.some((p) => p.stylus) || fresh.some((p) => p.stylus)) {
      g.invalid = true;
    }
  }

  function move({ touches } = {}) {
    if (!g || g.invalid) return;
    if (list(touches).some(tooFar)) g.invalid = true;
  }

  function end({ touches, changed, at = Date.now(), scroll = null, blocked = false } = {}) {
    if (!g) return null;
    if (list(changed).some(tooFar)) g.invalid = true;
    if (list(touches).length) return null; // wait for the last finger
    const done = g;
    g = null;
    const endAt = Number(at);
    const moved = !!(done.scroll && scroll)
      && (Math.abs((Number(scroll.top) || 0) - (Number(done.scroll.top) || 0)) >= 1
        || Math.abs((Number(scroll.left) || 0) - (Number(done.scroll.left) || 0)) >= 1);
    const ok = !done.invalid && !blocked && !moved && done.points.size === 2 && done.max === 2
      && Number.isFinite(endAt) && endAt - done.startAt <= maxMs && endAt >= done.startAt;
    return ok ? { startAt: done.startAt, endAt } : null;
  }

  return {
    start,
    move,
    end,
    cancel() {
      g = null;
    },
    scrolled() {
      if (g) g.invalid = true;
    },
    active() {
      return g !== null;
    },
  };
}
