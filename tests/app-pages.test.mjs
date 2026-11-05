// iPad アプリ版の公開文書（app/*.html・app/en/*.html。M5 §5.2、M6 §5.2、M7B §6.5）の静的検査。
// 【】と「下書き」の禁止は npm test に入れず tools/check-legal.mjs（npm run check:legal）に置く（M5-35）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = ['app/index.html', 'app/terms.html', 'app/privacy.html', 'app/support.html'];
const EN_PAGES = ['app/en/terms.html', 'app/en/privacy.html', 'app/en/support.html'];
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:">`;

const includesAll = (html, needles, page) => {
  for (const n of needles) assert.ok(html.includes(n), `${page} lacks ${JSON.stringify(n)}`);
};

test('(1) the four app pages exist', () => {
  for (const p of PAGES) assert.ok(existsSync(join(ROOT, p)), `${p} is missing`);
});

test('(2) every page has lang="ja", the CSP meta, the favicon and 最終更新', () => {
  for (const p of PAGES) {
    includesAll(read(p), ['<html lang="ja">', CSP, '../icons/favicon-32.png', '最終更新'], p);
  }
});

test('(3) terms.html names the prices, the trial, the contact and the sibling pages', () => {
  includesAll(read('app/terms.html'), [
    '300 円', '2,400 円', '14 日', 'syfan0@gmail.com', 'privacy.html', 'support.html', 'Apple Account', '手書きを書き出す',
  ], 'app/terms.html');
});

test('(4) privacy.html covers collection, iCloud, the UserDefaults cache and links to the terms', () => {
  includesAll(read('app/privacy.html'), ['収集', 'iCloud', 'UserDefaults', 'terms.html'], 'app/privacy.html');
});

test('(5) support.html has the contact, restore, the Web-version import steps and the export FAQ', () => {
  includesAll(read('app/support.html'), [
    'syfan0@gmail.com', '購入を復元', '手書きを書き出す（iPad アプリ用）', 'Web 版の手書きを取り込む', '手書きを書き出すには',
  ], 'app/support.html');
});

test('(6) no page links to a .md file or contains a script', () => {
  for (const p of PAGES) {
    const html = read(p);
    assert.ok(!html.includes('.md"'), `${p} links to a Markdown file`);
    assert.ok(!html.includes('<script'), `${p} contains a script`);
  }
});

test('(7) the Web-version policy (../privacy.html) is linked from privacy.html or index.html', () => {
  const linked = ['app/privacy.html', 'app/index.html'].some((p) => read(p).includes('../privacy.html'));
  assert.ok(linked, 'neither app/privacy.html nor app/index.html links to ../privacy.html');
});

test('(8) no page says the export is unreleased (未提供・提供予定・順次提供)', () => {
  // M6 §5.2: the export ships in 1.0, so terms.html and support.html must not promise it for later.
  for (const p of PAGES) {
    const html = read(p);
    for (const word of ['未提供', '提供予定', '順次提供']) assert.ok(!html.includes(word), `${p} contains ${JSON.stringify(word)}`);
  }
});

test('(9) no page says この iPad or iPad アプリ版, and support.html answers how much a page holds', () => {
  // M7A §6.4: 1.1 runs on the iPad and the iPhone, so the pages say この端末 and （アプリ版）.
  for (const p of PAGES) {
    const html = read(p);
    for (const word of ['この iPad', 'iPad アプリ版']) assert.ok(!html.includes(word), `${p} contains ${JSON.stringify(word)}`);
  }
  includesAll(read('app/support.html'), ['1 ページにどれだけ書けますか', '拡大・縮小するには'], 'app/support.html');
});

test('(10) the three English pages exist, and there is no English index page', () => {
  // M7B §6.5: the App and App Store Connect open the three pages directly.
  for (const p of EN_PAGES) assert.ok(existsSync(join(ROOT, p)), `${p} is missing`);
  assert.ok(!existsSync(join(ROOT, 'app/en/index.html')), 'app/en/index.html should not exist');
});

test('(10) every English page has lang="en", the CSP meta, the favicon, Last updated, the contact and a link to its Japanese version', () => {
  for (const p of EN_PAGES) {
    const name = posix.basename(p);
    includesAll(read(p), [
      '<html lang="en">', CSP, '../../icons/favicon-32.png', 'Last updated', 'syfan0@gmail.com',
      'This is a translation for convenience. The Japanese version prevails.',
      `<a href="../${name}" lang="ja">日本語版（正本）</a>`,
    ], p);
  }
});

test('(10) no English page links to a .md file, contains a script or uses hreflang', () => {
  for (const p of EN_PAGES) {
    const html = read(p);
    assert.ok(!html.includes('.md"'), `${p} links to a Markdown file`);
    assert.ok(!html.includes('<script'), `${p} contains a script`);
    assert.ok(!html.includes('hreflang'), `${p} uses hreflang`);
  }
});

test('(10) en/terms.html names the prices, the Apple EULA and the EU terms of M7B §11.3', () => {
  includesAll(read('app/en/terms.html'), [
    '¥300', '¥2,400', '14-day free trial', 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/',
    'The App is available in the countries and regions where it is offered on the App Store.', // T-1
    'Apple Distribution International Ltd.', 'https://www.apple.com/legal/internet-services/itunes/ie/terms.html', // T-3
    'the law gives you a right of withdrawal', // T-4
    'If you are a consumer living in the EU (European Union)', // T-6
    'Showing public holidays', // T-9
  ], 'app/en/terms.html');
});

test('(10) en/privacy.html has Sections 12 and 13 of M7B §11.3, and the headings of P-4', () => {
  includesAll(read('app/en/privacy.html'), [
    'id="1-information-the-app-collects-none"',
    'id="6-sharing-the-apps-data-with-third-parties-none"',
    'id="12-emails-to-support-and-opening-these-pages"',
    'id="13-if-you-live-in-the-eu-european-union-iceland-norway-the-uk-or-switzerland"',
    "Emails are stored in Google's Gmail.", 'Claude, by Anthropic', 'GDPR Article 6(1)(f)',
  ], 'app/en/privacy.html');
});

test('(10) en/support.html answers the EU, language, holiday and week questions, and carries the python-holidays license', () => {
  includesAll(read('app/en/support.html'), [
    'How do I cancel a purchase in the EU?', // S-4
    'How do I change the display language?', 'How do I change the holiday country?',
    'My week handwriting is gone. What should I do?', 'How do I zoom in and out?',
    'Replies are prepared with the help of machine translation',
    'https://github.com/vacanza/holidays/blob/v0.107/CONTRIBUTORS',
    'Permission is hereby granted, free of charge', '&lt;ryanssdev@icloud.com&gt;',
  ], 'app/en/support.html');
});

test('(10) no English page says the App is kept out of the EU', () => {
  for (const p of EN_PAGES) {
    for (const words of ['not distributed in the EU', 'Use from the EU', 'Distribution area']) {
      assert.ok(!read(p).includes(words), `${p} contains ${JSON.stringify(words)}`);
    }
  }
});

test('(10) no page has an unfilled date (XX, Month DD): the date goes in on the day of release', () => {
  // M7B §11.1 順 5: the line of S-5 and the dates are added then, so neither may be in a commit half filled.
  for (const p of [...PAGES, ...EN_PAGES]) {
    const html = read(p);
    for (const word of ['XX', 'Month DD']) assert.ok(!html.includes(word), `${p} contains ${JSON.stringify(word)}`);
  }
});

test('(10) every link between the pages lands on a file and, with a #, on an id of that file', () => {
  // The headings of P-4 change their ids, and a dead anchor would not show anywhere else.
  for (const p of [...PAGES, ...EN_PAGES]) {
    for (const [, href] of read(p).matchAll(/href="([^"]+)"/g)) {
      if (/^(https?:|mailto:)/.test(href)) continue;
      const [path, fragment] = href.split('#');
      let target = path ? posix.normalize(posix.join(posix.dirname(p), path)) : p;
      if (statSync(join(ROOT, target), { throwIfNoEntry: false })?.isDirectory()) target = posix.join(target, 'index.html');
      assert.ok(existsSync(join(ROOT, target)), `${p}: ${href} → ${target} does not exist`);
      if (fragment) assert.ok(read(target).includes(`id="${fragment}"`), `${p}: ${href} has no such id in ${target}`);
    }
  }
});
