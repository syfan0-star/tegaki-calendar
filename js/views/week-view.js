// Week page (module F1): 7 day columns with an hour grid, timed event boxes on the page, and a sticky
// header with the day headers and all-day rows (aligned with the page columns).

import { PAGE_SPECS, columnRect, rangeFor } from './page-geometry.js';
import { allDayRowsForRange, layoutTimedEvents } from './event-layout.js';
import { WEEKDAYS_JA, addDays, formatDateJa, isSameDay, minutesOfDay } from '../util/date.js';
import { getHolidayName } from '../util/holidays-jp.js';
import {
  TYPE,
  appendNowLayer,
  appendTimeAxis,
  beginRender,
  collapseAllDayRows,
  createAllDayChip,
  createEventBox,
  dayClassList,
  dayFlags,
  dayNumberLabel,
  fontPx,
  gridPath,
  gutterLabelLu,
  htmlEl,
  initialScrollFor,
  keepNowLineCurrent,
  keepPageInPlace,
  onActivate,
  pct,
  safeCall,
  stickyShell,
  svgEl,
  timedBoxRect,
} from './view-common.js';

const VIEW = 'week';
const SPEC = PAGE_SPECS.week;
const COLS = 7;

/** Column rect, with the spec formula as a fallback. */
function colRect(i) {
  return columnRect(VIEW, i) || {
    x: SPEC.gutter + (i * (SPEC.W - SPEC.gutter)) / COLS,
    w: (SPEC.W - SPEC.gutter) / COLS,
  };
}

/** The 7 days shown (range.days, padded/trimmed defensively to exactly 7). */
function weekDays(ctx) {
  const days = ctx.days.slice(0, COLS);
  while (days.length < COLS) days.push(addDays(days[days.length - 1], 1));
  return days;
}

function buildGrid(ctx, infos) {
  const { W, H, gutter, hourH } = SPEC;
  const frag = document.createDocumentFragment();

  // Column tints: today (pale blue) wins over weekend/holiday (warm paper tint).
  infos.forEach((info, i) => {
    const cls = info.flags.isToday ? 'g-today' : info.flags.weekend ? 'g-weekend' : null;
    if (!cls) return;
    const r = colRect(i);
    frag.append(svgEl('rect', { class: cls, x: r.x, y: 0, width: r.w, height: H }));
  });

  appendTimeAxis(frag, {
    x0: gutter, x1: W, H, hourH, labelX: gutter - 8, labelLu: gutterLabelLu(TYPE.weekTimeLabel, ctx.scale, gutter),
  });

  let v = '';
  for (let i = 1; i < COLS; i++) v += `M${colRect(i).x} 0V${H}`;
  frag.append(gridPath('g-vline', v), gridPath('g-axis', `M${gutter} 0V${H}`));
  ctx.gridEl.replaceChildren(frag);
}

/** Current-time line in today's column, above the event boxes (call after buildEvents); null if no today. */
function buildNowLine(ctx, infos) {
  const todayIdx = infos.findIndex((info) => info.flags.isToday);
  if (todayIdx < 0) return null;
  const r = colRect(todayIdx);
  return appendNowLayer(ctx.eventsEl, SPEC, {
    x1: r.x, x2: r.x + r.w, y: (minutesOfDay(ctx.now) * SPEC.hourH) / 60, dotR: Math.max(5, 4 / ctx.scale),
  });
}

function buildEvents(ctx, days) {
  const fs = fontPx(TYPE.weekEvent, ctx.scale);
  ctx.eventsEl.style.setProperty('--ev-fs', `${fs}px`);
  const frag = document.createDocumentFragment();
  days.forEach((day, i) => {
    const col = colRect(i);
    const items = safeCall(() => layoutTimedEvents(ctx.events, day), []);
    for (const it of items) {
      if (!it?.event || it.event.allDay) continue;
      const rect = timedBoxRect({
        colX: col.x, colW: col.w, startMin: it.startMin, endMin: it.endMin,
        col: it.col, cols: it.cols, hourH: SPEC.hourH, padL: 2, padR: 6,
      });
      frag.append(createEventBox(it.event, {
        rect, spec: SPEC, scale: ctx.scale, fontPx: fs,
        durationMin: it.endMin - it.startMin, now: ctx.now, onEventTap: ctx.onEventTap,
      }));
    }
  });
  ctx.eventsEl.replaceChildren(frag);
}

/** Day header cell: weekday + date number (circle when today) + holiday name. */
function dayHeader(info, onDayTap) {
  const btn = htmlEl('button', ['sh-day', ...dayClassList(info.flags)].join(' '));
  btn.type = 'button';
  const label = htmlEl('span', 'sh-dl');
  label.append(htmlEl('span', 'sh-wd', WEEKDAYS_JA[info.flags.dow] ?? ''), htmlEl('span', 'sh-num', dayNumberLabel(info.date)));
  btn.append(label);
  if (info.flags.holiday) btn.append(htmlEl('span', 'sh-hol', info.flags.holiday));
  btn.setAttribute('aria-label', `${formatDateJa(info.date)}${info.flags.holiday ? ` ${info.flags.holiday}` : ''}（日表示へ）`);
  onActivate(btn, () => onDayTap(info.date));
  return btn;
}

function buildAllDay(ctx, days) {
  const items = safeCall(() => allDayRowsForRange(ctx.events, days), []);
  // Every all-day event is shown (no 「他n件」): the user asked for all of them, as in the month view.
  // A very tall stack scrolls inside the header instead (styles/views.css .sh-allday max-height).
  const { visible, overflow, rows } = collapseAllDayRows(items, COLS, Infinity);
  if (rows === 0) return null;

  const wrap = htmlEl('div', 'sh-allday');
  wrap.style.gridTemplateRows = `repeat(${rows}, var(--ad-row-h))`;
  wrap.append(htmlEl('div', 'sh-allday-label', '終日'));

  const first = days[0];
  const afterLast = addDays(days[COLS - 1], 1);
  for (const it of visible) {
    const ev = it.event;
    const chip = createAllDayChip(ev, ctx.onEventTap, {
      contLeft: it.startCol === 0 && ev.start.getTime() < first.getTime(),
      contRight: it.endCol === COLS - 1 && ev.end.getTime() > afterLast.getTime(),
    });
    chip.style.gridColumn = `${it.startCol + 2} / ${it.endCol + 3}`;
    chip.style.gridRow = String(it.row + 1);
    wrap.append(chip);
  }
  overflow.forEach((n, c) => {
    if (!n) return;
    const more = htmlEl('button', 'ad-more', `他${n}件`);
    more.type = 'button';
    more.style.gridColumn = String(c + 2);
    more.style.gridRow = String(rows);
    more.setAttribute('aria-label', `${formatDateJa(days[c])} の終日予定 他${n}件（日表示へ）`);
    onActivate(more, () => ctx.onDayTap(days[c]));
    wrap.append(more);
  });
  return wrap;
}

function buildSticky(ctx, infos, days) {
  if (!ctx.stickyEl) return;
  const inner = stickyShell(ctx, { '--sh-gutter': `${pct(SPEC.gutter, SPEC.W)}%` });
  const row = htmlEl('div', 'sh-days');
  row.append(htmlEl('div', 'sh-corner'));
  for (const info of infos) row.append(dayHeader(info, ctx.onDayTap));
  inner.append(row);
  const allDay = buildAllDay(ctx, days);
  if (allDay) inner.append(allDay);
  ctx.stickyEl.replaceChildren(inner);
}

/**
 * Renders the week page (grid, timed events, sticky header). Idempotent: clears and redraws.
 * See SPEC §4 F1 for the parameters.
 */
export function render(params) {
  const ctx = beginRender(params, VIEW, SPEC, (date) => rangeFor(VIEW, date, params?.settings?.weekStart ?? 1));
  const days = weekDays(ctx);
  const infos = days.map((date) => ({
    date,
    flags: dayFlags(date, safeCall(() => getHolidayName(date), null), ctx.now),
  }));
  // The page stays put on screen even when the all-day rows (sticky header height) change.
  keepPageInPlace(ctx.pageEl, SPEC.fit, () => {
    buildGrid(ctx, infos);
    buildEvents(ctx, days);
    buildSticky(ctx, infos, days);
  });
  // Moves the now line every 30 s; after midnight, re-renders so 'today' follows the clock.
  keepNowLineCurrent({
    gridEl: ctx.gridEl,
    nowLine: buildNowLine(ctx, infos),
    renderedAt: ctx.now,
    yOfMinutes: (m) => (m * SPEC.hourH) / 60,
    onDayChange: () => render({ ...params, now: new Date() }),
  });
}

/**
 * Minutes to scroll to when the week is first shown: an hour before now if the week contains today,
 * else 7:00. `range` (or `weekStart`) identifies the week; without them the week is assumed to start
 * on Sunday.
 */
export function initialScrollMinutes({ date, now = new Date(), range = null, weekStart = 1 } = {}) {
  let days = Array.isArray(range?.days) && range.days.length ? range.days : null;
  if (!days) days = safeCall(() => rangeFor(VIEW, date instanceof Date ? date : now, weekStart).days, []);
  return initialScrollFor(days.some((d) => isSameDay(d, now)), now);
}
