#!/usr/bin/env node
// 公開前の関門（M5 §5.2、M5-35）: app/*.html に 【 】 と「下書き」が残っていないかを調べる。
//
//   node tools/check-legal.mjs      # = npm run check:legal
//
// 見つかれば「ファイル名:行番号: 行の内容」を出して exit 1。npm test には入れない（氏名が届く前でも test は緑に保つ）。

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = 'app';
const FORBIDDEN = ['【', '】', '下書き'];

let problems = 0;
const files = readdirSync(join(ROOT, DIR)).filter((n) => n.endsWith('.html')).sort();
for (const name of files) {
  const rel = `${DIR}/${name}`;
  const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n');
  lines.forEach((line, i) => {
    const hit = FORBIDDEN.filter((s) => line.includes(s));
    if (hit.length) {
      problems++;
      console.error(`${rel}:${i + 1}: ${hit.join(' ')} — ${line.trim()}`);
    }
  });
}

if (problems) {
  console.error(`check-legal: ${problems} problem(s) in ${DIR}/*.html`);
  process.exit(1);
}
console.log(`check-legal: OK (${files.length} files, none of ${FORBIDDEN.join(' ')})`);
