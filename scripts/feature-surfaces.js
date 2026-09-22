#!/usr/bin/env node
'use strict';

// The places in the source where a user-visible feature hooks in: routes,
// WebSocket messages, terminal hooks, CLI flags, page controls, Claude hooks
// and env, tab states, keys, settings, scripts. FEATURES.md lists every one of
// them against the feature it belongs to, and test/features.test.js checks the
// two agree both ways — so a new entry point cannot go unlisted and a listed
// one cannot quietly disappear. Regex over the source on purpose: no
// dependency, and a missed pattern shows up as a failing fixture test.
//
//   node scripts/feature-surfaces.js                 every entry point
//   node scripts/feature-surfaces.js --file <path>   only those in one file
//   node scripts/feature-surfaces.js diff <old.md> <new.md>
//                                    feature IDs removed / reworded between two lists

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Every source file a feature can live in. Third-party code (vendor/) is not ours.
function sourceFiles(root = ROOT) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'vendor') walk(rel); }
      else if (/\.(js|html|css)$/.test(e.name)) out.push(rel);
    }
  };
  walk('src');
  walk('bin');
  return out.sort();
}

// The body of the block that opens at the first `{` at or after `from`,
// skipping strings and comments so a brace inside them does not count.
function blockAt(src, from) {
  const open = src.indexOf('{', from);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; if (i <= 0) break; continue; }
    if (c === '\'' || c === '"' || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    // A regex literal: a `/` where an operand is expected. Its quotes and
    // braces are not code (registerPlanLinks' pattern holds " ' ` and ( ).
    if (c === '/' && /[(,=:[!&|?{};+\-*%<>~^]$|^$/.test(src.slice(0, i).trimEnd().slice(-1))) {
      let inClass = false;
      for (i++; i < src.length && src[i] !== '\n'; i++) {
        if (src[i] === '\\') { i++; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) break;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

const all = (re, text) => [...text.matchAll(re)];

// Code with its comments taken out, so a commented-out `case 'x':` is not an
// entry point. Whole-line and block comments only: a `//` inside a string
// (a URL) must survive.
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// kind → (text, file) → keys. Keys that could repeat across files carry the file.
const RULES = {
  route: (t) => all(/\bapp\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g, t)
    .map(m => `${m[1].toUpperCase()} ${m[2]}`),
  'ws-server': (t, f) => f === 'src/server.js'
    ? all(/case\s+['"]([a-z_]+)['"]\s*:/g, code(blockAt(t, t.search(/switch\s*\(\s*data\.type\s*\)/)))).map(m => m[1])
    : [],
  'ws-client': (t, f) => {
    const at = t.search(/\n\s+handleMessage\s*\([^)]*\)\s*\{/);
    if (at < 0 || !/^src\/public\//.test(f)) return [];
    const sw = code(blockAt(t, at));
    return all(/case\s+['"]([a-z_]+)['"]\s*:/g, sw).map(m => `${path.basename(f)}:${m[1]}`);
  },
  xterm: (t, f) => all(/\.(registerLinkProvider|registerOscHandler\(\s*\d+|onBell|onTitleChange|attachCustomKeyEventHandler)\b/g, t)
    .map(m => `${path.basename(f)}:${m[1].replace(/\(\s*/, '(') + (m[1].includes('(') ? ')' : '')}`)
    .concat(/^src\/public\/.*\.js$/.test(f) && /\blinkHandler\s*:\s*\{/.test(t) ? [`${path.basename(f)}:linkHandler`] : []),
  cli: (t, f) => f.startsWith('bin/')
    ? all(/\.option\(\s*['"](?:-\w,\s*)?(--[a-z0-9-]+)/g, t).map(m => m[1])
    : [],
  control: (t, f) => f.endsWith('.html')
    ? all(/<(?:button|input|select|textarea)\b[^>]*\bid="([^"]+)"/g, t).map(m => m[1])
    : [],
  hook: (t, f) => {
    if (f !== 'src/claude-bridge.js') return [];
    const at = t.search(/settings\.hooks\s*=\s*\{/);
    if (at < 0) return [];
    const body = code(blockAt(t, at));
    // Top-level keys only: nested objects inside the arrays are skipped by depth.
    const keys = [];
    let depth = 0;
    for (const line of body.split('\n')) {
      const m = depth === 0 && /^\s*([A-Za-z]+)\s*:/.exec(line);
      if (m) keys.push(m[1]);
      depth += (line.match(/[[{]/g) || []).length - (line.match(/[\]}]/g) || []).length;
    }
    return keys;
  },
  env: (t, f) => {
    if (f !== 'src/claude-bridge.js') return [];
    const at = t.search(/const childEnv\s*=\s*\{/);
    const keys = at < 0 ? [] : all(/^\s*([A-Z][A-Z0-9_]+)\s*:/gm, blockAt(t, at)).map(m => m[1]);
    return keys.concat(all(/childEnv\.([A-Z][A-Z0-9_]+)\s*=/g, t).map(m => m[1]));
  },
  state: (t, f) => f.endsWith('.css') ? all(/\.session-tab\[data-([a-z-]+)\]/g, t).map(m => m[1]) : [],
  'js-control': (t, f) => /^src\/public\/.*\.js$/.test(f)
    ? all(/\.title\s*=\s*'([^'$]{3,})'|\btitle="([^"$]{3,})"/g, t).map(m => `${path.basename(f)}:${m[1] || m[2]}`)
    : [],
  key: (t, f) => /^src\/public\/.*\.js$/.test(f)
    ? all(/\b(?:e|event|ev)\.(?:key|code)\s*===\s*'([^']+)'/g, t).map(m => `${path.basename(f)}:${m[1]}`)
    : [],
  setting: (t, f) => {
    const at = t.search(/\n\s+loadSettings\s*\([^)]*\)\s*\{/);
    if (at < 0) return [];
    const d = blockAt(t, t.indexOf('const defaults', at));
    return all(/^\s*([a-zA-Z]+)\s*:/gm, d).map(m => m[1]);
  },
  // Where a shared feature is switched on: registerPlanLinks is defined once in
  // splits.js but called from app.js too, and dropping one call site loses the
  // feature in that terminal while every other entry point stays put.
  wire: (t, f) => /^src\/public\/.*\.js$/.test(f)
    ? all(/(?<!function\s)(?<![.\w])(register[A-Z]\w*)\s*\(/g, t).map(m => `${path.basename(f)}:${m[1]}`)
    : [],
  bin: (t, f) => f.startsWith('bin/') ? [path.basename(f)] : []
};

function surfaces(root = ROOT, files = sourceFiles(root)) {
  const seen = new Set();
  const out = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const [kind, rule] of Object.entries(RULES)) {
      for (const key of rule(text, file)) {
        const id = `${kind}:${key}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ kind, key, file, id });
      }
    }
  }
  return out;
}

// FEATURES.md rows: | ID | 功能 | 入口 | 守卫 |. Entry points are the
// backticked `kind:key` tokens in the third column; `file:<path>` names a file
// the feature lives in when it has no other entry point there.
function parseFeatures(md) {
  const rows = [];
  for (const line of md.split('\n')) {
    const m = /^\|\s*([A-Z]+-\d+)\s*\|(.*)\|(.*)\|(.*)\|\s*$/.exec(line);
    if (!m) continue;
    rows.push({
      id: m[1],
      what: m[2].trim(),
      entries: all(/`([a-z-]+:[^`]+)`/g, m[3]).map(x => x[1]),
      manual: /手工/.test(m[3]),
      guards: m[4].trim()
    });
  }
  return rows;
}

// What a new list drops or rewords relative to an old one, by feature ID.
function diffFeatures(oldMd, newMd) {
  const before = new Map(parseFeatures(oldMd).map(r => [r.id, r]));
  const after = new Map(parseFeatures(newMd).map(r => [r.id, r]));
  const removed = [...before.keys()].filter(id => !after.has(id));
  const reworded = [...before.keys()].filter(id => after.has(id) && after.get(id).what !== before.get(id).what)
    .map(id => ({ id, from: before.get(id).what, to: after.get(id).what }));
  return { removed, reworded };
}

module.exports = { surfaces, sourceFiles, parseFeatures, diffFeatures, blockAt, RULES };

if (require.main === module) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'diff') {
    const read = (p) => (p && fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
    const { removed, reworded } = diffFeatures(read(a), read(b));
    for (const id of removed) console.log(`REMOVED ${id}`);
    for (const r of reworded) console.log(`REWORDED ${r.id}\n  was: ${r.from}\n  now: ${r.to}`);
  } else {
    const list = surfaces();
    const only = cmd === '--file' ? path.posix.normalize(a) : null;
    for (const s of list) if (!only || s.file === only) console.log(`${s.id}\t${s.file}`);
  }
}
