#!/usr/bin/env node
// Static import/export checker for the app's ES modules (no dependencies).
//
//   node tools/check-imports.mjs            # checks js/**/*.js (and sw.js)
//   node tools/check-imports.mjs a.js b.js  # checks only the given files
//
// For every static import / re-export it verifies that
//   (a) the target file exists, and
//   (b) every named import (or re-exported name) is actually exported by the target
//       (export function|async function|function*|const|let|var|class NAME,
//        export { a, b as c } [from '...'], export * [as ns] from '...', export default).
// Dynamic import('...') with a string literal is checked for file existence only.
// Exit code 1 when any problem is found.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Lexing: blank out comments, and the *contents* of strings, template literals
// and regex literals, keeping offsets identical, so the regexes below never match
// inside them. The original text is still available at the same offsets.

const REGEX_PREFIX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await',
]);

/** @param {string} src */
export function maskSource(src) {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  // Stack of brace depths for template literal `${ ... }` expressions.
  const tplStack = [];
  let braceDepth = 0;
  let lastSignificant = ''; // last non-space char outside comments/strings
  let lastWord = '';

  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };

  const regexAllowed = () => {
    if (lastSignificant === '') return true;
    if (/[(,=:[!&|?{};+\-*%<>~^]/.test(lastSignificant)) return true;
    if (/[A-Za-z0-9_$]/.test(lastSignificant)) return REGEX_PREFIX_KEYWORDS.has(lastWord);
    return false;
  };

  const readTemplate = (start) => {
    // start points just after the opening backtick (or after a closing `}` of ${})
    let k = start;
    while (k < n) {
      const c = src[k];
      if (c === '\\') { k += 2; continue; }
      if (c === '`') { blank(start, k); return { end: k + 1, open: false }; }
      if (c === '$' && src[k + 1] === '{') { blank(start, k); return { end: k + 2, open: true }; }
      k++;
    }
    blank(start, n);
    return { end: n, open: false };
  };

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      let k = i;
      while (k < n && src[k] !== '\n') k++;
      blank(i, k);
      i = k;
      continue;
    }
    if (c === '/' && d === '*') {
      let k = src.indexOf('*/', i + 2);
      k = k < 0 ? n : k + 2;
      blank(i, k);
      i = k;
      continue;
    }
    if (c === '\'' || c === '"') {
      let k = i + 1;
      while (k < n && src[k] !== c && src[k] !== '\n') {
        if (src[k] === '\\') k++;
        k++;
      }
      blank(i + 1, k);
      i = k + 1;
      lastSignificant = c;
      lastWord = '';
      continue;
    }
    if (c === '`') {
      const r = readTemplate(i + 1);
      if (r.open) { tplStack.push(braceDepth); braceDepth++; }
      i = r.end;
      lastSignificant = r.open ? '{' : '`';
      lastWord = '';
      continue;
    }
    if (c === '/' && regexAllowed()) {
      let k = i + 1;
      let inClass = false;
      while (k < n && src[k] !== '\n') {
        const ch = src[k];
        if (ch === '\\') { k += 2; continue; }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
        k++;
      }
      blank(i + 1, k);
      k++;
      while (k < n && /[a-z]/i.test(src[k])) k++;
      i = k;
      lastSignificant = '/';
      lastWord = '';
      continue;
    }
    if (c === '{') braceDepth++;
    if (c === '}') {
      braceDepth--;
      if (tplStack.length && tplStack[tplStack.length - 1] === braceDepth) {
        tplStack.pop();
        const r = readTemplate(i + 1);
        if (r.open) { tplStack.push(braceDepth); braceDepth++; }
        i = r.end;
        lastSignificant = r.open ? '{' : '`';
        lastWord = '';
        continue;
      }
    }
    if (!/\s/.test(c)) {
      if (/[A-Za-z0-9_$]/.test(c)) {
        let k = i;
        while (k < n && /[A-Za-z0-9_$]/.test(src[k])) k++;
        lastWord = src.slice(i, k);
        lastSignificant = src[k - 1];
        i = k;
        continue;
      }
      lastSignificant = c;
      lastWord = '';
    }
    i++;
  }
  return out.join('');
}

// ---------------------------------------------------------------------------
// Parsing

const ID = '[A-Za-z_$][A-Za-z0-9_$]*';

function parseSpecifierList(text) {
  // "a, b as c, default as d" → [{ imported, local }]
  return text.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = s.match(new RegExp(`^(${ID}|'[^']*'|"[^"]*")(?:\\s+as\\s+(${ID}|'[^']*'|"[^"]*"))?$`));
    if (!m) return { imported: s, local: s, bad: true };
    const unq = (x) => x.replace(/^['"]|['"]$/g, '');
    return { imported: unq(m[1]), local: unq(m[2] || m[1]) };
  });
}

function lineOf(src, offset) {
  let line = 1;
  for (let k = 0; k < offset && k < src.length; k++) if (src[k] === '\n') line++;
  return line;
}

/**
 * @param {string} src original source
 * @returns {{ imports: Array<{spec, names: string[], line, kind}>, exports: Set<string>, starFrom: string[], reexports: Array<{spec, names, line}> }}
 */
export function parseModule(src) {
  const masked = maskSource(src);
  const imports = [];
  const exportsSet = new Set();
  const starFrom = [];
  const reexports = [];

  const specAt = (quoteOffset) => {
    // masked has the quotes at the same offsets; read original between them.
    const q = src[quoteOffset];
    const end = src.indexOf(q, quoteOffset + 1);
    return src.slice(quoteOffset + 1, end);
  };

  let m;
  // import ... from '...'
  const importRe = new RegExp(
    `(^|[;\\n}\\s])import\\s+(?!\\()([\\s\\S]*?)\\s*from\\s*(['"])`, 'g');
  while ((m = importRe.exec(masked))) {
    const clause = m[2].trim();
    const quoteOffset = m.index + m[0].length - 1;
    const spec = specAt(quoteOffset);
    const line = lineOf(src, m.index + m[1].length);
    const names = [];
    let kind = 'named';
    let rest = clause;
    const def = rest.match(new RegExp(`^(${ID})\\s*(,|$)`));
    if (def && def[1] !== 'type') {
      names.push('default');
      rest = rest.slice(def[0].length).trim();
    }
    let ns = null;
    const nsm = rest.match(new RegExp(`^\\*\\s*as\\s+(${ID})$`));
    if (nsm) {
      kind = 'namespace';
      ns = nsm[1];
      rest = '';
      // Members used as ns.NAME are checked like named imports.
      const useRe = new RegExp(`(^|[^.\\w$])${ns.replace(/\$/g, '\\$')}\\s*\\.\\s*(${ID})`, 'g');
      let u;
      const used = new Set();
      while ((u = useRe.exec(masked))) used.add(u[2]);
      names.push(...used);
    }
    const braces = rest.match(/^\{([\s\S]*)\}$/);
    if (braces) for (const s of parseSpecifierList(braces[1])) names.push(s.imported);
    imports.push({ spec, names, line, kind });
  }
  // import '...'
  const bareRe = /(^|[;\n}\s])import\s*(['"])/g;
  while ((m = bareRe.exec(masked))) {
    const quoteOffset = m.index + m[0].length - 1;
    imports.push({ spec: specAt(quoteOffset), names: [], line: lineOf(src, m.index + m[1].length), kind: 'bare' });
  }
  // dynamic import('...')
  const dynRe = /(^|[^.\w$])import\s*\(\s*(['"])/g;
  while ((m = dynRe.exec(masked))) {
    const quoteOffset = m.index + m[0].length - 1;
    imports.push({ spec: specAt(quoteOffset), names: [], line: lineOf(src, m.index + m[1].length), kind: 'dynamic' });
  }

  // export declarations
  const declRe = new RegExp(
    `(^|[;\\n}\\s])export\\s+(?:async\\s+)?(?:function\\s*\\*?|class|const|let|var)\\s*(${ID})`, 'g');
  while ((m = declRe.exec(masked))) exportsSet.add(m[2]);
  // export const { a, b: c } = ... / export const [a, b] = ...
  const destrRe = /(^|[;\n}\s])export\s+(?:const|let|var)\s*([{[])([^=]*?)[}\]]\s*=/g;
  while ((m = destrRe.exec(masked))) {
    for (const part of m[3].split(',')) {
      const p = part.trim();
      if (!p) continue;
      const name = p.includes(':') ? p.split(':')[1].trim() : p;
      const id = name.split('=')[0].trim().replace(/^\.\.\./, '');
      if (id) exportsSet.add(id);
    }
  }
  // export default
  if (/(^|[;\n}\s])export\s+default\b/.test(masked)) exportsSet.add('default');
  // export { ... } [from '...']
  const listRe = /(^|[;\n}\s])export\s*\{([^}]*)\}(\s*from\s*(['"]))?/g;
  while ((m = listRe.exec(masked))) {
    const specs = parseSpecifierList(m[2]);
    for (const s of specs) exportsSet.add(s.local);
    if (m[3]) {
      const quoteOffset = m.index + m[0].length - 1;
      reexports.push({ spec: specAt(quoteOffset), names: specs.map((s) => s.imported), line: lineOf(src, m.index + m[1].length) });
    }
  }
  // export * from '...' / export * as ns from '...'
  const starRe = new RegExp(`(^|[;\\n}\\s])export\\s*\\*\\s*(?:as\\s+(${ID})\\s*)?from\\s*(['"])`, 'g');
  while ((m = starRe.exec(masked))) {
    const quoteOffset = m.index + m[0].length - 1;
    const spec = specAt(quoteOffset);
    if (m[2]) exportsSet.add(m[2]);
    else starFrom.push(spec);
    reexports.push({ spec, names: [], line: lineOf(src, m.index + m[1].length) });
  }
  return { imports, exports: exportsSet, starFrom, reexports };
}

// ---------------------------------------------------------------------------
// Checking

const cache = new Map();
function moduleInfo(file) {
  if (!cache.has(file)) cache.set(file, parseModule(readFileSync(file, 'utf8')));
  return cache.get(file);
}

function exportedNames(file, seen = new Set()) {
  if (seen.has(file)) return new Set();
  seen.add(file);
  const info = moduleInfo(file);
  const names = new Set(info.exports);
  for (const spec of info.starFrom) {
    const target = resolveSpec(file, spec);
    if (!target || !existsSync(target)) continue;
    for (const n of exportedNames(target, seen)) if (n !== 'default') names.add(n);
  }
  return names;
}

function resolveSpec(fromFile, spec) {
  if (spec.startsWith('./') || spec.startsWith('../')) return resolve(dirname(fromFile), spec);
  if (spec.startsWith('/')) return resolve(ROOT, '.' + spec);
  return null; // bare specifier (node:..., packages) — not part of the app
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (p.endsWith('.js') || p.endsWith('.mjs')) acc.push(p);
  }
  return acc;
}

/** Path for messages: relative to the project root when inside it. */
function show(file) {
  const rel = relative(ROOT, file);
  return rel.startsWith('..') ? file : rel;
}

export function checkFiles(files) {
  const problems = [];
  let importCount = 0;
  for (const file of files) {
    const rel = show(file);
    let info;
    try {
      info = moduleInfo(file);
    } catch (err) {
      problems.push(`${rel}: cannot read (${err.message})`);
      continue;
    }
    const all = [
      ...info.imports.map((x) => ({ ...x, what: 'import' })),
      ...info.reexports.map((x) => ({ ...x, what: 're-export', kind: 'named' })),
    ];
    for (const imp of all) {
      const target = resolveSpec(file, imp.spec);
      if (!target) continue;
      importCount++;
      if (!existsSync(target)) {
        problems.push(`${rel}:${imp.line}: ${imp.what} '${imp.spec}' → file not found`);
        continue;
      }
      if (imp.kind === 'dynamic' || imp.kind === 'bare') continue;
      const exported = exportedNames(target);
      for (const name of imp.names) {
        if (!exported.has(name)) {
          problems.push(`${rel}:${imp.line}: '${name}' is not exported by ${show(target)}`);
        }
      }
    }
  }
  return { problems, importCount };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const files = args.length
    ? args.map((a) => resolve(process.cwd(), a))
    : [...walk(join(ROOT, 'js')), ...(existsSync(join(ROOT, 'sw.js')) ? [join(ROOT, 'sw.js')] : [])];
  const { problems, importCount } = checkFiles(files);
  for (const p of problems) console.log(p);
  console.log(`${files.length} files, ${importCount} relative imports checked, ${problems.length} problem(s).`);
  process.exitCode = problems.length ? 1 : 0;
}
