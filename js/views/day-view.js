// Day page (module F1): time gutter, one timeline column with event boxes, and a free memo area on the
// right (faint ruled lines); the sticky header shows the date and the day's all-day events.

import { PAGE_SPECS, columnRect, rangeFor } from './page-geometry.js';
import { eventsOnDay, layoutTimedEvents } from './event-layout.js';
import { WEEKDAYS_JA, addDays, formatDateJa, isSameDay, minutesOfDay, toYMD } from '../util/date.js';
import { getHolidayName } from '../util/holidays-jp.js';
import {
  MAX_DAY_ALLDAY_CHIPS,
  TYPE,
  appendNowLayer,
  appendTimeAxis,
  beginRender,
  createAllDayChip,
  createEventBox,
  dayClassList,
  dayFlags,
  fontLu,
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

const VIEW = 'day';
const SPEC = PAGE_SPECS.day;
/** Memo area: ruled line spacing and side insets (lu). */
const RULE_STEP = 50;
const RULE_INSET = 20;

/** The day whose all-day list the user expanded (kept across re-renders of the same day). */
let expandedAllDayKey = null;

function timelineRect() {
  return columnRect(VIEW, 0) || { x: SPEC.gutter, w: SPEC.timelineRight - SPEC.gutter };
}

function buildGrid(ctx, info) {
  const { W, H, gutter, hourH, timelineRight } = SPEC;
  const tl = timelineRect();
  const frag = document.createDocumentFragment();

  const tint = info.flags.isToday ? 'g-today' : info.flags.weekend ? 'g-weekend' : null;
  if (tint) frag.append(svgEl('rect', { class: tint, x: tl.x, y: 0, width: tl.w, height: H }));

  appendTimeAxis(frag, {
    x0: gutter, x1: timelineRight, H, hourH, labelX: gutter - 8, labelLu: gutterLabelLu(TYPE.dayTimeLabel, ctx.scale, gutter),
  });

  // Memo area: faint ruled lines every RULE_STEP lu, a small 「メモ」 label, separated by a vertical line.
  let rules = '';
  for (let y = RULE_STEP; y < H; y += RULE_STEP) rules += `M${timelineRight + RULE_INSET} ${y}H${W - RULE_INSET}`;
  frag.append(
    gridPath('g-rule', rules),
    gridPath('g-axis', `M${gutter} 0V${H}`),
    gridPath('g-sep', `M${timelineRight} 0V${H}`),
  );
  const memoLu = fontLu(TYPE.memoLabel, ctx.scale);
  const memo = svgEl('text', {
    class: 'g-memo-label', x: timelineRight + RULE_INSET, y: Math.min(RULE_STEP - 8, 10 + memoLu), 'font-size': memoLu,
  });
  memo.textContent = 'メモ';
  frag.append(memo);
  ctx.gridEl.replaceChildren(frag);
}

/** Current-time line across the timeline, above the event boxes (call after buildEvents); null if not today. */
function buildNowLine(ctx, info) {
  if (!info.flags.isToday) return null;
  const tl = timelineRect();
  return appendNowLayer(ctx.eventsEl, SPEC, {
    x1: tl.x, x2: tl.x + tl.w, y: (minutesOfDay(ctx.now) * SPEC.hourH) / 60, dotR: Math.max(6, 4 / ctx.scale),
  });
}

function buildEvents(ctx, day) {
  const fs = fontPx(TYPE.dayEvent, ctx.scale);
  ctx.eventsEl.style.setProperty('--ev-fs', `${fs}px`);
  const tl = timelineRect();
  const frag = document.createDocumentFragment();
  const items = safeCall(() => layoutTimedEvents(ctx.events, day), []);
  for (const it of items) {
    if (!it?.event || it.event.allDay) continue;
    const rect = timedBoxRect({
      colX: tl.x, colW: tl.w, startMin: it.startMin, endMin: it.endMin,
      col: it.col, cols: it.cols, hourH: SPEC.hourH, padL: 4, padR: 14, gap: 3,
    });
    frag.append(createEventBox(it.event, {
      rect, spec: SPEC, scale: ctx.scale, fontPx: fs,
      durationMin: it.endMin - it.startMin, now: ctx.now, onEventTap: ctx.onEventTap,
    }));
  }
  ctx.eventsEl.replaceChildren(frag);
}

/** Date block of the sticky header: day number (circle when today), month, weekday, holiday. */
function dateHeader(info, onDayTap) {
  const { date, flags } = info;
  const btn = htmlEl('button', ['sh-day', 'sh-day--single', ...dayClassList(flags)].join(' '));
  btn.type = 'button';
  const text = htmlEl('span', 'sh-dtext');
  text.append(
    htmlEl('span', 'sh-md', `${date.getMonth() + 1}月`),
    htmlEl('span', 'sh-wd', `${WEEKDAYS_JA[flags.dow] ?? ''}曜日`),
  );
  btn.append(htmlEl('span', 'sh-num', String(date.getDate())), text);
  if (flags.holiday) btn.append(htmlEl('span', 'sh-hol', flags.holiday));
  btn.setAttribute('aria-label', `${formatDateJa(date)}${flags.holiday ? ` ${flags.holiday}` : ''}`);
  onActivate(btn, () => onDayTap(date));
  return btn;
}

/** All-day chips stacked in the timeline column; more than MAX_DAY_ALLDAY_CHIPS → 「他n件」 toggle. */
function allDayList(ctx, day) {
  const allDay = safeCall(() => eventsOnDay(ctx.events, day), []).filter((ev) => ev.allDay);
  if (!allDay.length) return null;

  const key = toYMD(day);
  const wrap = htmlEl('div', 'sh-allday sh-allday--day');
  const list = htmlEl('div', 'sh-allday-items');
  const nextDay = addDays(day, 1);
  allDay.forEach((ev, i) => {
    const chip = createAllDayChip(ev, ctx.onEventTap, {
      contLeft: ev.start.getTime() < day.getTime(),
      contRight: ev.end.getTime() > nextDay.getTime(),
    });
    if (i >= MAX_DAY_ALLDAY_CHIPS) chip.classList.add('is-extra');
    list.append(chip);
  });
  const hiddenCount = allDay.length - MAX_DAY_ALLDAY_CHIPS;
  if (hiddenCount > 0) {
    const toggle = htmlEl('button', 'ad-more ad-toggle');
    toggle.type = 'button';
    const sync = () => {
      const open = expandedAllDayKey === key;
      list.classList.toggle('is-expanded', open);
      toggle.textContent = open ? '折りたたむ' : `他${hiddenCount}件`;
      toggle.setAttribute('aria-expanded', String(open));
    };
    onActivate(toggle, () => {
      expandedAllDayKey = expandedAllDayKey === key ? null : key;
      keepPageInPlace(ctx.pageEl, SPEC.fit, sync); // the header grows/shrinks; the paper must not move
    });
    sync();
    list.append(toggle);
  }
  wrap.append(htmlEl('div', 'sh-allday-label', '終日'), list);
  return wrap;
}

function buildSticky(ctx, info) {
  if (!ctx.stickyEl) return;
  const inner = stickyShell(ctx, {
    '--sh-gutter': `${pct(SPEC.gutter, SPEC.W)}%`,
    '--sh-timeline': `${pct(SPEC.timelineRight - SPEC.gutter, SPEC.W)}%`,
  });
  const row = htmlEl('div', 'sh-dayrow');
  row.append(htmlEl('div', 'sh-corner'), dateHeader(info, ctx.onDayTap), htmlEl('div', 'sh-memo-col'));
  inner.append(row);
  const allDay = allDayList(ctx, info.date);
  if (allDay) inner.append(allDay);
  ctx.stickyEl.replaceChildren(inner);
}

/**
 * Renders the day page (grid + memo area, timed events, sticky header). Idempotent.
 * See SPEC §4 F1 for the parameters.
 */
export function render(params) {
  const ctx = beginRender(params, VIEW, SPEC, (date) => rangeFor(VIEW, date, params?.settings?.weekStart ?? 1));
  const day = ctx.days[0];
  const info = { date: day, flags: dayFlags(day, safeCall(() => getHolidayName(day), null), ctx.now) };
  // The page stays put on screen even when the all-day list (sticky header height) changes.
  keepPageInPlace(ctx.pageEl, SPEC.fit, () => {
    buildGrid(ctx, info);
    buildEvents(ctx, day);
    buildSticky(ctx, info);
  });
  // Moves the now line every 30 s; after midnight, re-renders so 'today' follows the clock.
  keepNowLineCurrent({
    gridEl: ctx.gridEl,
    nowLine: buildNowLine(ctx, info),
    renderedAt: ctx.now,
    yOfMinutes: (m) => (m * SPEC.hourH) / 60,
    onDayChange: () => render({ ...params, now: new Date() }),
  });
}

/** Minutes to scroll to when the day is first shown: an hour before now if it is today, else 7:00. */
export function initialScrollMinutes({ date, now = new Date() } = {}) {
  return initialScrollFor(isSameDay(date, now), now);
}
