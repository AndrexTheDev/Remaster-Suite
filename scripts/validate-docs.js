#!/usr/bin/env node
/* =============================================================================
 * Remaster Suite — documentation validator
 * -----------------------------------------------------------------------------
 * Keeps three sources of truth in step with each other:
 *
 *   tests/            the suites that actually exist on disk
 *   README.md         the "Tests" table that promises how many there are, what
 *                     each one covers and how many checks it reports
 *   package.json      the `test` chain and the per-suite `test:*` scripts
 *
 * and audits the JSDoc coverage of every module in `assets/js`.
 *
 * Usage:
 *   node scripts/validate-docs.js            static checks, no suites are run
 *   node scripts/validate-docs.js --run      also execute every suite and
 *                                            compare its own "ALL TESTS PASSED
 *                                            (n)" count with the README
 *
 * Exit code 0 means everything agrees, 1 means it does not (the failing rows
 * are printed). No dependencies — it has to run before `npm install` does.
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = process.argv.includes('--run');

let passed = 0;
let failed = 0;

function ok(cond, label, detail) {
  if (cond) {
    passed++;
    console.log('  ✓ ' + label + (detail ? '  → ' + detail : ''));
  } else {
    failed++;
    console.log('  ✗ ' + label + '  → ' + (detail === undefined ? 'failed' : detail));
  }
}

function section(name) { console.log('\n\u25b8 ' + name); }

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ─────────────────────────────────────────────── 1 · the suite inventory ── */

section('docs · suite inventory');

const suiteFiles = fs.readdirSync(path.join(ROOT, 'tests'))
  .filter((f) => f.endsWith('.test.js'))
  .sort();
const suiteNames = suiteFiles.map((f) => f.replace(/\.test\.js$/, ''));

ok(suiteFiles.length > 0, 'the test directory has suites', suiteFiles.length + ' found');

const readme = read('README.md');
const pkg = JSON.parse(read('package.json'));

const rows = [];
const rowRe = /^\|\s*([^|]+?)\s*\|\s*`tests\/([\w.-]+\.test\.js)`\s*\|\s*(\d+)\s*\|[^|]*\|/gm;
let m;
while ((m = rowRe.exec(readme))) {
  rows.push({ suite: m[1], file: m[2], checks: Number(m[3]) });
}

ok(rows.length === suiteFiles.length,
  'README lists exactly one row per suite file',
  'README ' + rows.length + ' rows, disk ' + suiteFiles.length + ' files');

const readmeFiles = rows.map((r) => r.file).sort();
const missingRows = suiteFiles.filter((f) => readmeFiles.indexOf(f) === -1);
const ghostRows = readmeFiles.filter((f) => suiteFiles.indexOf(f) === -1);
ok(missingRows.length === 0, 'every suite on disk is documented in README.md', missingRows.join(', '));
ok(ghostRows.length === 0, 'README documents no suite that does not exist', ghostRows.join(', '));

const readmeTotal = rows.reduce((sum, r) => sum + r.checks, 0);
const head = readme.match(/\*\*(\d+)\s+dependency-free suites?\s*·\s*(\d+)\s+checks\.\*\*/);
ok(!!head, 'README carries a machine-readable "N suites · M checks" summary',
  head ? head[0] : 'pattern "**N dependency-free suites · M checks.**" not found');
if (head) {
  ok(Number(head[1]) === suiteFiles.length,
    'the suite count in the README summary matches tests/*.test.js',
    head[1] + ' stated, ' + suiteFiles.length + ' on disk');
  ok(Number(head[2]) === readmeTotal,
    'the total in the README summary matches the per-suite rows',
    head[2] + ' stated, ' + readmeTotal + ' in the table');
}

// the prose in the Repository layout section quotes the same numbers
const layoutMissing = rows.filter((r) => {
  const name = r.file.replace(/\.test\.js$/, '');
  const flat = readme.replace(/\s+/g, ' ');
  const re = new RegExp(name.replace(/[-]/g, '\\-') + '\\.test\\.js\\b[\\s\\S]{0,1400}?\\(' + r.checks + ' checks?\\)');
  return !re.test(flat);
});
ok(layoutMissing.length === 0, 'the Repository layout repeats every count',
  layoutMissing.map((r) => r.file + ' (' + r.checks + ')').join(', '));

/* ────────────────────────────────────────────── 2 · the npm script chain ── */

section('docs · npm scripts');

const chain = ((pkg.scripts || {}).test || '').match(/node\s+tests\/([\w.-]+)\.test\.js/g) || [];
const chained = chain.map((c) => c.replace(/^node\s+tests\//, '')).sort();
ok(chained.length === suiteFiles.length && chained.every((f, i) => f === suiteFiles[i]),
  'the npm test chain runs exactly the suites on disk',
  chained.length + ' in the chain, ' + suiteFiles.length + ' on disk');

const missingScripts = suiteNames.filter((n) => !pkg.scripts['test:' + n]);
ok(missingScripts.length === 0, 'every suite has its own test:<name> script',
  missingScripts.join(', '));

ok(!!pkg.scripts['validate:docs'], 'package.json exposes the validator itself',
  pkg.scripts['validate:docs'] || 'no validate:docs script');

const layoutDirs = ['scripts', 'tools', path.join('tests', 'beta')];
const listed = [];
for (const dir of layoutDirs) {
  for (const f of fs.readdirSync(path.join(ROOT, dir))) {
    if (!f.endsWith('.js')) continue;
    if (readme.indexOf(f) === -1) listed.push(dir + '/' + f);
  }
}
const testHelpers = fs.readdirSync(path.join(ROOT, 'tests'))
  .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
  .filter((f) => readme.indexOf(f) === -1);
ok(listed.length === 0 && testHelpers.length === 0,
  'every helper, probe and script is named in the Repository layout',
  listed.concat(testHelpers).join(', '));

/* ─────────────────────────────────────────── 3 · JSDoc coverage of assets ── */

section('docs · JSDoc coverage (assets/js)');

const jsFiles = fs.readdirSync(path.join(ROOT, 'assets', 'js')).filter((f) => f.endsWith('.js')).sort();
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'do', 'try', 'new', 'function', 'await']);
const DECL = [
  [/^ {0,4}(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/, 'function'],
  [/^ {0,4}class\s+([A-Za-z_$][\w$]*)/, 'class'],
  [/^ {0,2}const\s+([A-Za-z_$][\w$]*)\s*=\s*\{/, 'object'],
];

function docAbove(lines, i) {
  let k = i - 1;
  while (k >= 0 && !lines[k].trim()) k--;
  if (k < 0 || !lines[k].trim().endsWith('*/')) return false;
  while (k >= 0) {
    const t = lines[k].trim();
    if (t.startsWith('/**')) return true;
    if (t.startsWith('/*')) return false;
    k--;
  }
  return false;
}

/** The doc block above line `i`, as one string, or `''`. */
function blockOf(lines, i) {
  let k = i - 1;
  while (k >= 0 && !lines[k].trim()) k--;
  if (k < 0 || !lines[k].trim().endsWith('*/')) return '';
  const end = k;
  while (k >= 0) {
    const t = lines[k].trim();
    if (t.startsWith('/**')) return lines.slice(k, end + 1).join('\n');
    if (t.startsWith('/*')) break;
    k--;
  }
  return '';
}

/** The parenthesised parameter list of a declaration line, or `''`. */
function signatureOf(line) {
  const open = line.indexOf('(');
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < line.length; i++) {
    if (line[i] === '(') depth++;
    else if (line[i] === ')') {
      depth--;
      if (depth === 0) return line.slice(open, i + 1);
    }
  }
  return '';
}

/** Parameter names of a `( … )` list, without defaults, destructuring or rests. */
function paramsOf(sig) {
  const inner = sig.replace(/^\(|\)$/g, '');
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if ('([{'.indexOf(ch) !== -1) depth++;
    if (')]}'.indexOf(ch) !== -1) depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()
    .replace(/^\.\.\./, '')
    .split('=')[0]
    .replace(/^[^A-Za-z_$]*/, '')
    .replace(/[{}\[]/g, '')
    .trim())
    .filter(Boolean);
}

/** The names a doc block's `@param` tags mention, in order. */
function paramNames(doc) {
  const names = [];
  const re = /@param\s*\{/g;
  let m;
  while ((m = re.exec(doc))) {
    let depth = 0;
    let end = m.index + m[0].length - 1;
    for (let i = end; i < doc.length; i++) {
      if (doc[i] === '{') depth++;
      else if (doc[i] === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    const after = doc.slice(end + 1).replace(/^\s*/, '');
    const hit = /^(\[?[\w$.]+\]?)/.exec(after);
    if (hit) names.push(hit[1].replace(/\[/g, '').replace(/\]/g, ''));
    re.lastIndex = end;
  }
  return names;
}

const undoc = [];
const decls = [];          // every documented declaration, with its signature

for (const file of jsFiles) {
  const lines = fs.readFileSync(path.join(ROOT, 'assets', 'js', file), 'utf8').split('\n');
  const source = lines.join('\n');
  if (!/@fileoverview/.test(source) || !/@module/.test(source)) {
    undoc.push(file + ': no @fileoverview/@module header');
  }
  let depth = 0;
  const classStack = [];
  lines.forEach((line, i) => {
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
    for (const [re, kind] of DECL) {
      const hit = re.exec(line);
      if (!hit) continue;
      const name = hit[1];
      if (KEYWORDS.has(name)) return;
      const sig = kind === 'class' ? '' : signatureOf(line);
      const documented = docAbove(lines, i);
      if (!documented) undoc.push(file + ':' + (i + 1) + ' ' + kind + ' ' + name);
      else decls.push({ file, line: i + 1, kind, name, sig, doc: blockOf(lines, i) });
      if (kind === 'class') classStack.push(depth);
      return;
    }
    // a method of the innermost class body
    if (classStack.length && depth === classStack[classStack.length - 1]) {
      const hit = /^ {4,}(?:async\s+)?([A-Za-z_$][\w$]*)\s*(\([^)]*\))\s*\{\s*$/.exec(line);
      if (hit && !KEYWORDS.has(hit[1]) && hit[1] !== 'constructor') {
        if (docAbove(lines, i)) decls.push({ file, line: i + 1, kind: 'method', name: hit[1], sig: hit[2], doc: blockOf(lines, i) });
        else undoc.push(file + ':' + (i + 1) + ' method ' + hit[1]);
      }
    }
    if (classStack.length && depth < classStack[classStack.length - 1]) classStack.pop();
  });
}

const declarations = decls.length + undoc.length;

ok(jsFiles.length === 14, 'all fourteen modules are present', jsFiles.length + ' files');
ok(undoc.length === 0, 'every module, function, class, object and class method is documented',
  undoc.length ? undoc.slice(0, 12).join(' | ') + (undoc.length > 12 ? ' …(+' + (undoc.length - 12) + ')' : '') : undefined);
ok(decls.length + undoc.length === declarations,
  'the JSDoc coverage is complete',
  decls.length + '/' + declarations + ' declarations documented');

/* every @param must name the parameter the function really takes */

const nameMismatch = [];
for (const d of decls) {
  const real = paramsOf(d.sig);
  const documented = paramNames(d.doc).filter((p) => p.indexOf('.') === -1);
  if (real.length === 0 && documented.length === 0) continue;
  if (real.join(',') !== documented.join(',')) {
    nameMismatch.push(d.file + ':' + d.line + ' ' + d.name + ' — code (' + real.join(', ') +
      ') vs doc (' + (documented.join(', ') || 'nothing') + ')');
  }
}
ok(nameMismatch.length === 0,
  'every @param names the parameter its function actually takes',
  nameMismatch.length ? nameMismatch.slice(0, 8).join(' | ') : decls.length + ' documented signatures agree');

/* every { @link } target must exist somewhere in the tree */

const SOURCES = jsFiles.map((f) => 'assets/js/' + f).concat(['assets/worklets/remaster-processor.js']);
const treeText = SOURCES.map(read).join('\n');
function resolves(name) {
  return new RegExp('\\b' + name.replace(/[$]/g, '\\$') + '\\b').test(treeText);
}
const strayLinks = [];
for (const file of SOURCES) {
  for (const m of read(file).matchAll(/\{@link\s+([^}\s]+)/g)) {
    const target = m[1];
    const segments = target.split(/[#.(]/).filter(Boolean);
    const base = segments[0];
    const wrong = !base || !resolves(base) || segments.some((seg) => !resolves(seg));
    if (wrong) strayLinks.push(file + ' → {@link ' + target + '}');
  }
}
ok(strayLinks.length === 0, 'every {@link} points at something that exists',
  strayLinks.slice(0, 8).join(' | '));

/* every @typedef must carry its structure, not just a name */

const thinTypedefs = [];
for (const file of jsFiles) {
  const source = read(path.join('assets', 'js', file));
  for (const m of source.matchAll(/@typedef\s+\{([^}]*)\}\s+([\w$.]+)/g)) {
    const type = m[1];
    const name = m[2];
    const tail = source.slice(m.index, m.index + 4000).split('*/')[0];
    const hasProps = /@property/.test(tail);
    // a union, a primitive alias or a generic map/collection is a complete
    // definition on its own; a plain `Object` typedef has to list its fields
    const isAlias = /['"|]/.test(type) || /</.test(type);
    if (!hasProps && !isAlias) thinTypedefs.push(file + ' → ' + name + ' (' + type + ')');
  }
}
ok(thinTypedefs.length === 0, 'every @typedef documents its members or is an alias',
  thinTypedefs.slice(0, 8).join(' | '));

const typed = jsFiles.filter((f) => /@typedef/.test(read(path.join('assets', 'js', f))));
ok(typed.length >= 10, 'the structured data is described with @typedefs',
  typed.length + ' of ' + jsFiles.length + ' modules carry @typedef');

/* ──────────────────────────────────────── 4 · the suites themselves (--run) ── */

if (RUN) {
  section('docs · suite counts (--run)');
  const actual = {};
  for (const file of suiteFiles) {
    const res = spawnSync(process.execPath, [path.join('tests', file)], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    const out = (res.stdout || '') + (res.stderr || '');
    const hit = out.match(/ALL TESTS PASSED \((\d+)\)/);
    const n = hit ? Number(hit[1]) : null;
    actual[file] = n;
    const row = rows.find((r) => r.file === file);
    const wanted = row ? row.checks : null;
    ok(res.status === 0 && n !== null && n === wanted,
      file + ' reports the count the README promises',
      (n === null ? 'no "ALL TESTS PASSED (n)" line (exit ' + res.status + ')' : n + ' checks') +
      ' vs README ' + (wanted === null ? '—' : wanted));
  }
  const total = Object.keys(actual).reduce((s, k) => s + (actual[k] || 0), 0);
  ok(total === readmeTotal, 'the suites still add up to the README total',
    total + ' checks run, ' + readmeTotal + ' documented');
}

/* ────────────────────────────────────────────────────────────── summary ── */

console.log('\n' + '-'.repeat(60));
if (failed === 0) console.log('ALL CHECKS PASSED (' + passed + ')');
else console.log('FAILED: ' + failed + ' of ' + (passed + failed));
process.exit(failed === 0 ? 0 : 1);
