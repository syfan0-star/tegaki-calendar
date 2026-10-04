// Settings sheet (module F2b).
//
// openSettings({ settings, calendars, auth: { signedIn, email, configured, demo }, version })
//   → Promise<{ settings, action?: 'signIn'|'signOut'|'exitDemo'|'enterDemo'|'addScopes' }>
//
// Changes apply when the sheet closes (「完了」, Esc or a backdrop tap all keep them): the result always
// carries the edited copy of `settings` (other keys untouched). Account buttons close the sheet at once
// with their `action`.
// Optional extras: auth.missingScopes (boolean | string[]) shows 「権限を追加」 (action 'addScopes');
// option `root` = modal host element.

import { h, svgIcon, openModal, switchControl, uid } from './dom.js';
import { writableCalendars } from './event-dialog.js';

export const SETTINGS_TEXT = Object.freeze({
  title: '設定',
  done: '完了',
  account: 'Googleアカウント',
  calendars: '表示するカレンダー',
  defaultCalendar: '予定の登録先',
  input: '入力',
  allowFinger: '指・マウスでも書く',
  allowFingerHint: 'Apple Pencil がないときや、パソコンで試すときに使います。オンのときは、2本指でスクロールします',
  twoFingerTap: '2本指でトンと叩くと、ペンと消しゴムが切り替わります',
  eraseDefault: '予定にした手書きを消す（初期値）',
  about: 'データについて',
  aboutText: [
    '手書きは Google ドライブの「アプリ専用の非表示フォルダ」に保存されます。ドライブの一覧には表示されず、このアプリ以外からは見えません。',
    'ログインしていないときやお試しモードの手書きは、この端末の中だけに保存されます。',
    '保存したデータは、Google ドライブの［設定］→［アプリを管理］から削除できます。',
  ],
  version: 'バージョン',
});

/** Returns a new hiddenCalendarIds array with `id` shown (visible = true) or hidden. */
export function setCalendarVisible(hiddenIds, id, visible) {
  const list = Array.isArray(hiddenIds) ? hiddenIds.filter((x) => typeof x === 'string') : [];
  const without = list.filter((x) => x !== id);
  return visible ? without : [...without, id];
}

/** Calendars listed under 「表示するカレンダー」: everything except holiday calendars, primary first. */
export function displayableCalendars(calendars) {
  const list = (Array.isArray(calendars) ? calendars : []).filter((c) => c && typeof c.id === 'string' && !c.holiday);
  return [...list].sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)));
}

/**
 * Value for settings.defaultCalendarId after choosing `id` in 「予定の登録先」:
 * the primary calendar is stored as null (SPEC: null → primary), anything else by id.
 */
export function defaultCalendarValue(calendars, id) {
  const cal = (Array.isArray(calendars) ? calendars : []).find((c) => c && c.id === id);
  if (!cal || cal.primary) return null;
  return id;
}

/** Account section state → status text and the action buttons to show. */
export function accountView(auth = {}) {
  const a = auth && typeof auth === 'object' ? auth : {};
  const configured = a.configured !== false;
  const missing = Array.isArray(a.missingScopes) ? a.missingScopes.length > 0 : Boolean(a.missingScopes);
  if (a.demo) {
    return {
      status: 'お試しモードで使っています',
      detail: '予定と手書きは、このアプリ（このブラウザ）の中だけに保存されます。Googleでログインしたときに、手書きを引き継ぐかどうかを選べます。',
      actions: [{ action: 'exitDemo', label: 'お試しモードを終了', primary: false }],
    };
  }
  if (a.signedIn) {
    return {
      status: 'ログイン中',
      detail: typeof a.email === 'string' && a.email ? a.email : '',
      actions: [
        ...(missing ? [{ action: 'addScopes', label: '権限を追加', primary: true }] : []),
        { action: 'signOut', label: 'ログアウト', primary: false },
      ],
    };
  }
  if (!configured) {
    return {
      status: 'ログインしていません',
      detail: 'Google連携の設定がまだ済んでいません（docs/SETUP.md）',
      actions: [{ action: 'enterDemo', label: 'お試しモードで使う', primary: false }],
    };
  }
  return {
    status: 'ログインしていません',
    detail: 'ログインすると、Googleカレンダーの予定が表示され、手書きが Google ドライブに保存されます。',
    actions: [
      { action: 'signIn', label: 'Googleでログイン', primary: true },
      { action: 'enterDemo', label: 'お試しモードで使う', primary: false },
    ],
  };
}

function section(title, ...children) {
  const id = uid('set-sec');
  return h('section', { class: 'settings-section', 'aria-labelledby': id },
    h('h3', { class: 'settings-heading', id }, title),
    ...children);
}

/**
 * Opens the settings sheet.
 * @returns {Promise<{ settings: object, action?: string }>}
 */
export function openSettings(options = {}) {
  const o = options && typeof options === 'object' ? options : {};
  const original = o.settings && typeof o.settings === 'object' ? o.settings : {};
  const calendars = Array.isArray(o.calendars) ? o.calendars : [];
  const auth = o.auth && typeof o.auth === 'object' ? o.auth : {};

  let draft = {
    ...original,
    hiddenCalendarIds: Array.isArray(original.hiddenCalendarIds) ? [...original.hiddenCalendarIds] : [],
  };

  return new Promise((resolve) => {
    let settled = false;
    const titleId = uid('set-title');
    const modal = openModal({
      root: o.root,
      className: 'dialog--settings',
      labelledBy: titleId,
      onDismiss: () => finish(),
    });

    function finish(action) {
      if (settled) return;
      settled = true;
      modal.close();
      resolve(action ? { settings: draft, action } : { settings: draft });
    }

    // ---- 「Googleアカウント」
    const acc = accountView(auth);
    const accountSection = section(SETTINGS_TEXT.account,
      h('div', { class: 'card-group' },
        h('div', { class: 'settings-row settings-account' },
          h('span', { class: 'settings-account-icon' }, svgIcon('user', { size: 22 })),
          h('span', { class: 'settings-row-text' },
            h('span', { class: 'settings-row-label' }, acc.status),
            acc.detail ? h('span', { class: 'settings-row-hint' }, acc.detail) : null))),
      h('div', { class: 'settings-actions' },
        acc.actions.map((a) => h('button', {
          type: 'button', class: ['btn', a.primary ? 'btn-primary' : ''], onClick: () => finish(a.action),
        }, a.label))));

    // ---- 「表示するカレンダー」
    const shown = displayableCalendars(calendars);
    const calendarSection = section(SETTINGS_TEXT.calendars,
      shown.length
        ? h('div', { class: 'card-group' }, shown.map((cal) => {
          const input = h('input', {
            type: 'checkbox', class: 'check', checked: !draft.hiddenCalendarIds.includes(cal.id),
            onChange: () => {
              draft = { ...draft, hiddenCalendarIds: setCalendarVisible(draft.hiddenCalendarIds, cal.id, input.checked) };
            },
          });
          return h('label', { class: 'settings-row settings-calendar' },
            h('span', { class: 'cal-dot', style: { '--cal': cal.color || '#9ca3af' }, 'aria-hidden': 'true' }),
            h('span', { class: 'settings-row-text' },
              h('span', { class: 'settings-row-label' }, cal.name || cal.id),
              cal.primary ? h('span', { class: 'settings-row-hint' }, 'メインのカレンダー') : null),
            input);
        }))
        : h('p', { class: 'settings-empty' },
          auth.signedIn || auth.demo ? 'カレンダーがありません' : 'ログインすると、ここにカレンダーが表示されます'));

    // ---- 「予定の登録先」
    const targets = writableCalendars(calendars);
    let defaultSection = null;
    if (targets.length) {
      const preferred = targets.some((c) => c.id === draft.defaultCalendarId)
        ? draft.defaultCalendarId
        : (targets.find((c) => c.primary) || targets[0]).id;
      const tint = (id) => {
        const color = targets.find((c) => c.id === id)?.color;
        select.classList.toggle('has-cal', Boolean(color));
        if (color) select.style.setProperty('--cal', color);
      };
      const selectId = uid('set-cal');
      const select = h('select', {
        id: selectId, class: 'input select', disabled: targets.length < 2,
        onChange: () => {
          draft = { ...draft, defaultCalendarId: defaultCalendarValue(calendars, select.value) };
          tint(select.value);
        },
      }, targets.map((c) => h('option', { value: c.id, selected: c.id === preferred }, `● ${c.name || c.id}`)));
      select.value = preferred;
      tint(preferred);
      defaultSection = section(SETTINGS_TEXT.defaultCalendar,
        h('label', { class: 'sr-only', for: selectId }, SETTINGS_TEXT.defaultCalendar),
        select);
    }


    // ---- 「入力」 and the erase default
    const finger = switchControl(SETTINGS_TEXT.allowFinger, {
      checked: Boolean(draft.allowFinger),
      hint: SETTINGS_TEXT.allowFingerHint,
      onChange: (on) => { draft = { ...draft, allowFinger: on }; },
    });
    const erase = switchControl(SETTINGS_TEXT.eraseDefault, {
      checked: draft.eraseInkAfterConvert !== false,
      onChange: (on) => { draft = { ...draft, eraseInkAfterConvert: on }; },
    });
    const inputSection = section(SETTINGS_TEXT.input, h('div', { class: 'card-group' }, finger.row),
      h('p', { class: 'settings-note' }, SETTINGS_TEXT.twoFingerTap));
    const eraseSection = h('section', { class: 'settings-section', 'aria-label': SETTINGS_TEXT.eraseDefault },
      h('div', { class: 'card-group' }, erase.row));

    // ---- 「データについて」 + version
    const aboutSection = section(SETTINGS_TEXT.about,
      h('div', { class: 'settings-about' }, SETTINGS_TEXT.aboutText.map((t) => h('p', null, t))),
      h('p', { class: 'settings-version' }, `${SETTINGS_TEXT.version} ${o.version ? String(o.version) : '—'}`));

    const doneBtn = h('button', { type: 'button', class: 'btn btn-primary btn-sm', onClick: () => finish() }, SETTINGS_TEXT.done);
    modal.dialog.append(
      h('div', { class: 'dialog-header' }, h('h2', { class: 'dialog-title', id: titleId }, SETTINGS_TEXT.title), doneBtn),
      h('div', { class: 'dialog-body' },
        accountSection, calendarSection, defaultSection, inputSection, eraseSection, aboutSection));
  });
}
