#!/usr/bin/env node
// 公開前の関門（M5 §5.2、M5-35、M7B §6.5）: app/ の下の HTML（下の階層も）に、公開してはいけない字が残っていないかを調べる。
//
//   全部のページ: 【 】 「下書き」、埋め忘れの字 XX と Month DD（公開の日に入れる日付。M7B §11.1 の順 5）
//   app/en/ の下: さらに [ と、TODO・DRAFT（大文字小文字を問わない）
//
//   node tools/check-legal.mjs      # = npm run check:legal
//
// 見つかれば「ファイル名:行番号: 行の内容」を出して exit 1。npm test には入れない（氏名が届く前でも test は緑に保つ）。

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = 'app';
const FORBIDDEN = ['【', '】', '下書き', 'XX', 'Month DD'];
const FORBIDDEN_EN = ['['];
const FORBIDDEN_EN_ANY_CASE = ['TODO', 'DRAFT'];

const htmlFiles = (dir) =>
  readdirSync(join(ROOT, dir), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? htmlFiles(`${dir}/${e.name}`) : e.name.endsWith('.html') ? [`${dir}/${e.name}`] : []))
    .sort();

let problems = 0;
const files = htmlFiles(DIR);
for (const rel of files) {
  const english = rel.startsWith(`${DIR}/en/`);
  const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n');
  lines.forEach((line, i) => {
    const hit = FORBIDDEN.filter((s) => line.includes(s));
    if (english) {
      hit.push(...FORBIDDEN_EN.filter((s) => line.includes(s)));
      hit.push(...FORBIDDEN_EN_ANY_CASE.filter((s) => line.toUpperCase().includes(s)));
    }
    if (hit.length) {
      problems++;
      console.error(`${rel}:${i + 1}: ${hit.join(' ')} — ${line.trim()}`);
    }
  });
}

if (problems) {
  console.error(`check-legal: ${problems} problem(s) under ${DIR}/`);
  process.exit(1);
}
console.log(
  `check-legal: OK (${files.length} files, none of ${FORBIDDEN.join(' ')}; under ${DIR}/en/ also none of ${[...FORBIDDEN_EN, ...FORBIDDEN_EN_ANY_CASE].join(' ')})`,
);
