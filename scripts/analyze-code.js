#!/usr/bin/env node
/* =============================================================================
 * Remaster Suite — static analysis of the shipped JavaScript
 * -----------------------------------------------------------------------------
 * The suites run the code and the audit suite reads it with regular
 * expressions; this pass is the one that *parses* it. It looks for the defect
 * classes a regex cannot see:
 *
 *   1. accidental globals — a write to a name that is declared nowhere. In a
 *      `'use strict'` IIFE that is a `ReferenceError` at runtime, and on the
 *      worklet thread it means a dead render.
 *   2. undeclared reads — the same bug, one line earlier.
 *   3. duplicate keys in an object literal — the second silently wins, which
 *      is how a lookup table loses an entry.
 *   4. dead code — a module-level declaration nothing in the module mentions
 *      and no export object carries out.
 *
 * Usage:
 *   node scripts/analyze-code.js            report; exit 1 on a defect
 *   node scripts/analyze-code.js --dead     …and on unreferenced declarations
 *   node scripts/analyze-code.js --json     machine-readable report
 *
 * Needs `acorn` — a devDependency, like jsdom. The eleven test suites never
 * load this file; without the parser it says so and exits 2, because a silent
 * skip would be worse than an obvious one.
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JSON_OUT = process.argv.includes('--json');
const FAIL_ON_DEAD = process.argv.includes('--dead');

let acorn;
try {
  acorn = require('acorn');
} catch (e) {
  console.error('analyze-code: needs `acorn` — run `npm install` first (devDependencies only).');
  process.exit(2);
}

const FILES = fs.readdirSync(path.join(ROOT, 'assets', 'js'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => 'assets/js/' + f)
  .concat(['assets/worklets/remaster-processor.js', 'coi-serviceworker.js'])
  .filter((f) => fs.existsSync(path.join(ROOT, f)));

/**
 * Names that are legitimately undeclared in the file that uses them: the
 * platform, Node's CommonJS wrapper, and this project's own globals.
 */
const KNOWN_GLOBALS = new Set((
  'globalThis undefined NaN Infinity Math JSON Object Array Number String Boolean Symbol BigInt ' +
  'Date RegExp Error TypeError RangeError SyntaxError EvalError ReferenceError URIError ' +
  'AggregateError Map Set WeakMap WeakSet Promise Proxy Reflect Function Intl parseInt parseFloat ' +
  'isNaN isFinite encodeURIComponent decodeURIComponent encodeURI decodeURI escape unescape ' +
  'structuredClone queueMicrotask atob btoa ' +
  'ArrayBuffer SharedArrayBuffer DataView Uint8Array Uint8ClampedArray Uint16Array Uint32Array ' +
  'Int8Array Int16Array Int32Array Float32Array Float64Array BigInt64Array BigUint64Array ' +
  'Atomics WebAssembly ' +
  'window self document navigator location history screen console performance crypto fetch ' +
  'Request Response Headers AbortController AbortSignal URL URLSearchParams Blob File FileReader ' +
  'FileList FormData Image ImageBitmap ImageData OffscreenCanvas createImageBitmap TextEncoder ' +
  'TextDecoder Worker MessageChannel MessagePort BroadcastChannel Event CustomEvent EventTarget ' +
  'EventSource WebSocket MutationObserver IntersectionObserver ResizeObserver requestAnimationFrame ' +
  'cancelAnimationFrame requestIdleCallback cancelIdleCallback setTimeout clearTimeout setInterval ' +
  'clearInterval DOMException AudioContext OfflineAudioContext AudioBuffer AudioBufferSourceNode ' +
  'AudioWorkletNode GainNode AudioParam AnalyserNode MediaStream getComputedStyle matchMedia ' +
  'indexedDB caches CSS Element HTMLElement Node NodeList devicePixelRatio ' +
  'importScripts postMessage onmessage onerror registerProcessor currentTime currentFrame sampleRate ' +
  'AudioWorkletProcessor ' +
  'module exports require process Buffer __dirname __filename global ' +
  'RSDSP RSPresets RSi18n RSLibs RSOPFS RSCodecs RSAnalyzer RSNeural RSMemoryGuard RSEngine ' +
  'RSAudioEngine RSUI RSApp RSCOI'
).split(' '));

/** Every name a binding pattern introduces. */
function boundNames(pattern, out) {
  out = out || [];
  if (!pattern) return out;
  switch (pattern.type) {
    case 'Identifier': out.push(pattern.name); break;
    case 'ObjectPattern':
      for (const p of pattern.properties) boundNames(p.value || p.argument, out);
      break;
    case 'ArrayPattern':
      for (const el of pattern.elements) boundNames(el, out);
      break;
    case 'AssignmentPattern': boundNames(pattern.left, out); break;
    case 'RestElement': boundNames(pattern.argument, out); break;
    default: break;
  }
  return out;
}

/** Every node of a subtree, `visit(node, parent)`. */
function walk(node, visit, parent) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child.type === 'string') walk(child, visit, node);
    } else if (value && typeof value.type === 'string') {
      walk(value, visit, node);
    }
  }
}

/** Declarations that belong to the file itself (program scope). */
function programBindings(ast) {
  const names = new Set();
  for (const stmt of ast.body) {
    if (stmt.type === 'FunctionDeclaration' || stmt.type === 'ClassDeclaration') {
      if (stmt.id) names.add(stmt.id.name);
    } else if (stmt.type === 'VariableDeclaration') {
      for (const d of stmt.declarations) boundNames(d.id, []).forEach((n) => names.add(n));
    }
  }
  // `var`/`function` inside a block still hoist to the program in a script
  walk(ast, (n) => {
    if (n.type === 'VariableDeclaration' && n.kind === 'var') {
      for (const d of n.declarations) boundNames(d.id, []).forEach((x) => names.add(x));
    }
    if (n.type === 'FunctionDeclaration' && n.id) names.add(n.id.name);
  });
  return names;
}

const DEFECT_KINDS = new Set(['accidental-global', 'undeclared-read', 'duplicate-key', 'parse-error']);
const findings = [];
const add = (kind, file, line, message) => findings.push({ kind, file, line, message });

for (const file of FILES) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  let ast;
  try {
    ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
  } catch (e) {
    add('parse-error', file, e.loc ? e.loc.line : 0, e.message);
    continue;
  }

  const moduleNames = programBindings(ast);
  const scopes = [new Set(moduleNames)];
  const declared = (name) => {
    for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(name)) return true;
    return false;
  };
  const bindIn = (scope, pattern) => boundNames(pattern).forEach((n) => scope.add(n));

  const visit = (node, parent) => {
    if (!node || typeof node.type !== 'string') return;

    /* declarations of hoisted/block-scoped names, then the body */
    if (node.type === 'BlockStatement') {
      const scope = new Set();
      for (const stmt of node.body) {
        if (stmt.type === 'VariableDeclaration' && stmt.kind !== 'var') {
          for (const d of stmt.declarations) bindIn(scope, d.id);
        }
        if (stmt.type === 'ClassDeclaration' && stmt.id) scope.add(stmt.id.name);
      }
      scopes.push(scope);
      for (const stmt of node.body) visit(stmt, node);
      scopes.pop();
      return;
    }

    if (node.type === 'ForStatement' || node.type === 'ForOfStatement' || node.type === 'ForInStatement') {
      const scope = new Set();
      const head = node.left || node.init;
      if (head && head.type === 'VariableDeclaration' && head.kind !== 'var') {
        for (const d of head.declarations) bindIn(scope, d.id);
      }
      scopes.push(scope);
      for (const key of ['init', 'test', 'update', 'left', 'right', 'body']) visit(node[key], node);
      scopes.pop();
      return;
    }

    if (node.type === 'CatchClause') {
      const scope = new Set();
      bindIn(scope, node.param);
      scopes.push(scope);
      visit(node.body, node);
      scopes.pop();
      return;
    }

    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      const scope = new Set();
      for (const p of node.params || []) bindIn(scope, p);
      if (node.id && node.type === 'FunctionExpression') scope.add(node.id.name);
      if (node.body) {
        walk(node.body, (n) => {
          if (n.type === 'VariableDeclaration' && n.kind === 'var') {
            for (const d of n.declarations) bindIn(scope, d.id);
          }
          if (n.type === 'FunctionDeclaration' && n.id) scope.add(n.id.name);
        });
      }
      scopes.push(scope);
      for (const p of node.params || []) walk(p, (n) => {}, node);
      visit(node.body, node);
      scopes.pop();
      return;
    }

    if (node.type === 'Identifier') {
      const isProperty = parent && (
        (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) ||
        (parent.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand) ||
        (parent.type === 'MethodDefinition' && parent.key === node) ||
        (parent.type === 'PropertyDefinition' && parent.key === node) ||
        (parent.type === 'LabeledStatement') || (parent.type === 'BreakStatement') ||
        (parent.type === 'ContinueStatement')
      );
      const isDeclaration = parent && (
        (parent.type === 'VariableDeclarator' && parent.id === node) ||
        (parent.type === 'FunctionDeclaration' && parent.id === node) ||
        (parent.type === 'ClassDeclaration' && parent.id === node) ||
        (parent.type === 'FunctionExpression' && parent.id === node) ||
        (parent.type === 'Property' && parent.shorthand && parent.value !== parent.key)
      );
      if (!isProperty && !isDeclaration && !declared(node.name) && !KNOWN_GLOBALS.has(node.name)) {
        const isWrite = parent && (
          (parent.type === 'AssignmentExpression' && parent.left === node) ||
          (parent.type === 'UpdateExpression' && parent.argument === node)
        );
        add(isWrite ? 'accidental-global' : 'undeclared-read', file, node.loc.start.line,
          (isWrite ? 'write to' : 'read of') + ' undeclared `' + node.name + '`');
      }
    }

    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child.type === 'string') visit(child, node);
      } else if (value && typeof value.type === 'string') {
        visit(value, node);
      }
    }
  };
  visit(ast, null);

  /* duplicate keys in one object literal */
  walk(ast, (node) => {
    if (node.type !== 'ObjectExpression') return;
    const seen = new Map();
    for (const prop of node.properties) {
      if (prop.type !== 'Property' || prop.computed) continue;
      const key = prop.key.type === 'Identifier' ? prop.key.name
        : prop.key.type === 'Literal' ? String(prop.key.value) : null;
      if (key === null) continue;
      if (seen.has(key)) {
        add('duplicate-key', file, prop.loc.start.line,
          'duplicate key `' + key + '` (first at line ' + seen.get(key) + ')');
      } else {
        seen.set(key, prop.loc.start.line);
      }
    }
  });

  /* module-level declarations nothing mentions */
  const mentionCount = new Map();
  walk(ast, (node, parent) => {
    if (node.type !== 'Identifier') return;
    const isDeclaration = parent && (
      (parent.type === 'VariableDeclarator' && parent.id === node) ||
      (parent.type === 'FunctionDeclaration' && parent.id === node) ||
      (parent.type === 'ClassDeclaration' && parent.id === node) ||
      (parent.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand)
    );
    if (isDeclaration) return;
    mentionCount.set(node.name, (mentionCount.get(node.name) || 0) + 1);
  });
  for (const name of moduleNames) {
    if (KNOWN_GLOBALS.has(name)) continue;
    if (!mentionCount.get(name)) add('dead-code', file, 0, 'module-level `' + name + '` is never referenced');
  }
}

/* ------------------------------------------------------------------ report */

const defects = findings.filter((f) => DEFECT_KINDS.has(f.kind));
const dead = findings.filter((f) => f.kind === 'dead-code');

if (JSON_OUT) {
  console.log(JSON.stringify({ defects, dead }, null, 2));
} else {
  console.log('\n▸ static analysis · ' + FILES.length + ' files parsed');
  if (!defects.length) {
    console.log('  ✓ no parse errors, accidental globals, undeclared reads or duplicate keys');
  }
  for (const f of defects) console.log('  ✗ ' + f.kind + '  ' + f.file + ':' + f.line + '  ' + f.message);
  console.log('\n▸ unreferenced module-level declarations');
  if (!dead.length) console.log('  ✓ none');
  for (const f of dead) console.log('  · ' + f.file + '  ' + f.message.slice(0, 96));
  console.log('\n' + '-'.repeat(60));
  console.log('defects: ' + defects.length + ' · unreferenced: ' + dead.length + ' · files: ' + FILES.length);
}

process.exit(defects.length || (FAIL_ON_DEAD && dead.length) ? 1 : 0);
