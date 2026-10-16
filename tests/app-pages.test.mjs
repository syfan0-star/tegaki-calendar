// iPad アプリ版の公開文書（app/*.html。M5 §5.2）の静的検査。
// 【】と「下書き」の禁止は npm test に入れず tools/check-legal.mjs（npm run check:legal）に置く（M5-35）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = ['app/index.html', 'app/terms.html', 'app/privacy.html', 'app/support.html'];
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
    '300 円', '2,400 円', '14 日', 'syfan0@gmail.com', 'privacy.html', 'support.html', 'Apple Account',
  ], 'app/terms.html');
});

test('(4) privacy.html covers collection, iCloud, the UserDefaults cache and links to the terms', () => {
  includesAll(read('app/privacy.html'), ['収集', 'iCloud', 'UserDefaults', 'terms.html'], 'app/privacy.html');
});

test('(5) support.html has the contact, restore and the Web-version import steps', () => {
  includesAll(read('app/support.html'), [
    'syfan0@gmail.com', '購入を復元', '手書きを書き出す（iPad アプリ用）', 'Web 版の手書きを取り込む',
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
