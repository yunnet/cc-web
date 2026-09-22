const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { surfaces, parseFeatures, diffFeatures, RULES } = require('../scripts/feature-surfaces');

// The scanner behind FEATURES.md. If it misses a way of writing an entry point,
// that entry point can be added or removed without anything noticing — so each
// rule is pinned against the spellings it has to survive.
describe('feature surface scanner', function () {
  const keys = (kind, text, file) => RULES[kind](text, file);

  it('reads routes however they are written', function () {
    assert.deepStrictEqual(keys('route', `
      this.app.get('/api/a', h);
      app.post("/api/b", h);
      this.app.delete(
        '/api/c/:id', h);
      this.app.use((req, res) => {});
    `), ['GET /api/a', 'POST /api/b', 'DELETE /api/c/:id']);
  });

  it('reads only the WebSocket switch on the server, not other switches', function () {
    const src = `
      switch (mode) { case 'nope': break; }
      switch (data.type) {
        case 'create_session': { const x = '}'; break; }
        case "input":
          break;
        // case 'commented': a comment
      }
      switch (other) { case 'also_nope': }`;
    assert.deepStrictEqual(keys('ws-server', src, 'src/server.js'), ['create_session', 'input']);
    assert.deepStrictEqual(keys('ws-server', src, 'src/other.js'), []);
  });

  it('reads the cases of a client handleMessage, per file', function () {
    const src = `
    handleMessage(message, view = this.activeView) {
        switch (message.type) {
            case 'output': break;
            case 'hook_event': break;
        }
    }
    other() { switch (a) { case 'x': } }`;
    assert.deepStrictEqual(keys('ws-client', src, 'src/public/app.js'), ['app.js:output', 'app.js:hook_event']);
  });

  it('reads terminal hooks, page controls, CLI flags, hooks, env, states', function () {
    assert.deepStrictEqual(keys('xterm', 'term.parser.registerOscHandler( 52, f); term.onBell(() => 1); t.registerLinkProvider({}); new T({ linkHandler: { activate } })', 'src/public/app.js'),
      ['app.js:registerOscHandler(52)', 'app.js:onBell', 'app.js:registerLinkProvider', 'app.js:linkHandler']);
    assert.deepStrictEqual(keys('control', '<button class="x" id="a">\n<input type="checkbox" id="b"/><div id="c"></div><select\n id="d">', 'src/public/index.html'),
      ['a', 'b', 'd']);
    assert.deepStrictEqual(keys('cli', ".option('-p, --port <number>', 'x').option(\"--auth-file <path>\")", 'bin/cc-web.js'), ['--port', '--auth-file']);
    assert.deepStrictEqual(keys('hook', `settings.hooks = {
        PreToolUse: [
          { matcher: 'ExitPlanMode', hooks: [{ type: 'command', command }] }
        ],
        Stop: [{ hooks: [{ type: 'command', command }] }]
      };`, 'src/claude-bridge.js'), ['PreToolUse', 'Stop']);
    assert.deepStrictEqual(keys('env', `const childEnv = {
        ...process.env,
        TERM: 'xterm-256color',
        // A_COMMENT: 'no'
        FORCE_HYPERLINK: '1'
      };
      if (t) childEnv.CCWEB_HOOK_TOKEN = t;`, 'src/claude-bridge.js'), ['TERM', 'FORCE_HYPERLINK', 'CCWEB_HOOK_TOKEN']);
    assert.deepStrictEqual(keys('state', '.session-tab[data-done] .tab-status {} [data-theme="light"] {}', 'src/public/style.css'), ['done']);
  });

  it('reads controls built in JS, keys, settings and wiring calls', function () {
    assert.deepStrictEqual(keys('js-control', "b.title = 'Download'; x = `<span title=\"Close tab\">`; y.title = `${dyn}`", 'src/public/f.js'),
      ['f.js:Download', 'f.js:Close tab']);
    assert.deepStrictEqual(keys('key', "if (e.key === 'Enter' && event.code === 'KeyT') {}", 'src/public/f.js'), ['f.js:Enter', 'f.js:KeyT']);
    assert.deepStrictEqual(keys('setting', `
    loadSettings(sessionId) {
        const defaults = {
            fontSize: 14,
            theme: 'dark'
        };
    }`, 'src/public/app.js'), ['fontSize', 'theme']);
    assert.deepStrictEqual(keys('wire', 'function registerPlanLinks(term) {}\nregisterPlanLinks(term, f);\nthis.registerX(1);', 'src/public/app.js'),
      ['app.js:registerPlanLinks']);
  });

  it('finds as many entry points in this repo as a plain grep does', function () {
    // Counted by hand with grep when the scanner was written (2026-09-22).
    // A rule that silently stops matching shows up here as a number dropping.
    const count = (kind) => surfaces().filter(s => s.kind === kind).length;
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
    const grepRoutes = (src.match(/this\.app\.(get|post|put|patch|delete)\('/g) || []).length;
    assert.strictEqual(count('route'), grepRoutes);
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'index.html'), 'utf8');
    assert.strictEqual(count('control'), (html.match(/<(button|input|select|textarea)[^>]* id="[^"]+"/g) || []).length);
    assert.ok(count('ws-server') >= 11, 'server WebSocket messages');
    assert.ok(count('cli') >= 13, 'CLI flags');
  });
});

describe('feature list parsing and diff', function () {
  const OLD = [
    '| ID | 功能 | 入口 | 守卫 |',
    '|---|---|---|---|',
    '| TERM-01 | 计划文件链接可点击 | `wire:app.js:registerPlanLinks` `xterm:splits.js:registerLinkProvider` | x.test.js › y |',
    '| TERM-02 | 网址可点击 | 手工 | — |',
    '| TAB-01 | 后台答完出 ✓ | `state:done` | — |'
  ].join('\n');

  it('reads IDs, entry points and the manual marker', function () {
    const rows = parseFeatures(OLD);
    assert.deepStrictEqual(rows.map(r => r.id), ['TERM-01', 'TERM-02', 'TAB-01']);
    assert.deepStrictEqual(rows[0].entries, ['wire:app.js:registerPlanLinks', 'xterm:splits.js:registerLinkProvider']);
    assert.strictEqual(rows[1].manual, true);
    assert.deepStrictEqual(rows[1].entries, []);
  });

  it('names what a new list drops and what it rewords', function () {
    const NEW = OLD.replace(/\n\| TERM-02[^\n]*/, '').replace('计划文件链接可点击', '计划文件链接显示');
    const d = diffFeatures(OLD, NEW);
    assert.deepStrictEqual(d.removed, ['TERM-02']);
    assert.deepStrictEqual(d.reworded, [{ id: 'TERM-01', from: '计划文件链接可点击', to: '计划文件链接显示' }]);
    assert.deepStrictEqual(diffFeatures(OLD, OLD), { removed: [], reworded: [] });
  });

  it('has a CLI the deploy script can call', function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-feat-'));
    try {
      fs.writeFileSync(path.join(dir, 'old.md'), OLD);
      fs.writeFileSync(path.join(dir, 'new.md'), OLD.replace(/\n\| TAB-01[^\n]*/, ''));
      const out = require('child_process').execFileSync(process.execPath,
        [path.join(__dirname, '..', 'scripts', 'feature-surfaces.js'), 'diff', path.join(dir, 'old.md'), path.join(dir, 'new.md')], { encoding: 'utf8' });
      assert.strictEqual(out.trim(), 'REMOVED TAB-01');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// FEATURES.md and the code must agree both ways. This is the check that stops
// a feature from being dropped without anyone deciding to (the user's rule:
// nothing existing is removed or weakened without their say-so).
describe('FEATURES.md matches the code', function () {
  const ROOT = path.join(__dirname, '..');
  const { sourceFiles } = require('../scripts/feature-surfaces');
  const rows = parseFeatures(fs.readFileSync(path.join(ROOT, 'FEATURES.md'), 'utf8'));
  const listed = new Set(rows.flatMap(r => r.entries));
  const found = surfaces();

  it('lists every entry point in the code', function () {
    const missing = found.filter(s => !listed.has(s.id));
    assert.deepStrictEqual(missing.map(s => s.id), [],
      missing.map(s => `entry point ${s.id} (${s.file}) is not in FEATURES.md — if it is new, list its feature; if its row was deleted, that removes a feature and needs the user's consent, quoted in the plan`).join('\n'));
  });

  it('still finds every entry point it lists', function () {
    const ids = new Set(found.map(s => s.id));
    const gone = [...listed].filter(t => t.startsWith('file:') ? !fs.existsSync(path.join(ROOT, t.slice(5))) : !ids.has(t));
    assert.deepStrictEqual(gone, [],
      gone.map(t => `listed entry point ${t} is gone from the code — this removes a feature: it needs the user's consent, quoted in the plan`).join('\n'));
  });

  it('names guard tests that exist', function () {
    const missing = rows.flatMap(r => [...r.guards.matchAll(/`(test\/[^`]+\.test\.js)`/g)].map(m => m[1]))
      .filter(f => !fs.existsSync(path.join(ROOT, f)));
    assert.deepStrictEqual(missing, []);
  });

  it('has unique, well-formed IDs, each with a description', function () {
    const ids = rows.map(r => r.id);
    assert.deepStrictEqual(ids.filter((x, i) => ids.indexOf(x) !== i), [], 'duplicate IDs');
    for (const r of rows) {
      assert.ok(r.what, `${r.id} has no description`);
      assert.ok(r.entries.length || r.manual, `${r.id} has neither an entry point nor 手工`);
    }
  });

  it('covers every source file', function () {
    const covered = new Set([
      ...found.filter(s => listed.has(s.id)).map(s => s.file),
      ...[...listed].filter(t => t.startsWith('file:')).map(t => t.slice(5))
    ]);
    const bare = sourceFiles().filter(f => !covered.has(f));
    assert.deepStrictEqual(bare, [], bare.map(f => `${f} holds no listed feature — list what it does`).join('\n'));
  });
});

describe('feature surface scanner: blocks', function () {
  const { blockAt } = require('../scripts/feature-surfaces');
  it('is not thrown off by quotes, braces or backticks inside a regex literal', function () {
    const src = "function f() { const RE = /[^\\s\"'`()]+\\.md/g; const o = { a: 1 }; return x / 2; }\nafter();";
    assert.strictEqual(blockAt(src, 0).trim(), "const RE = /[^\\s\"'`()]+\\.md/g; const o = { a: 1 }; return x / 2;");
  });
});
