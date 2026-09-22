const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');
const { blockAt } = require('../scripts/feature-surfaces');

// Behaviour guards for features in FEATURES.md whose entry points could stay in
// place while the behaviour quietly breaks — the double check in
// features.test.js cannot see that. Browser code is exercised by lifting the
// one function out of its file and running it against stubs.
const PUB = path.join(__dirname, '..', 'src', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');

// `function name(...) {...}` or a class method `name(...) {...}`, as source.
function lift(src, name, { method = false } = {}) {
  const at = src.search(new RegExp(method ? `\\n\\s+${name}\\s*\\([^)]*\\)\\s*\\{` : `\\nfunction ${name}\\s*\\(`));
  assert.ok(at >= 0, `${name} is gone — this guard is measuring nothing`);
  const head = src.slice(at, src.indexOf('{', at)).trim();
  return `${head} {${blockAt(src, at)}}`;
}

describe('TERM-13 plan-file paths are clickable', function () {
  // A fake terminal line, one cell per character; wide (CJK) glyphs take two
  // cells, the second empty — which is what makes columns drift if miscounted.
  function lineOf(text) {
    const cells = [];
    for (const ch of text) {
      const wide = /[　-鿿＀-￯]/.test(ch);
      cells.push({ ch, w: wide ? 2 : 1 });
      if (wide) cells.push({ ch: '', w: 0 });
    }
    return {
      length: cells.length,
      getCell(x, into) {
        const c = cells[x] || { ch: '', w: 1 };
        const cell = into || {};
        cell.getWidth = () => c.w;
        cell.getChars = () => c.ch;
        return cell;
      }
    };
  }

  function links(text) {
    let provider;
    const opened = [];
    const ctx = vm.createContext({
      window: {
        open: (url) => opened.push(url),
        authManager: { getPlanUrl: (p, sid) => `plan:${sid}:${p}` }
      },
      encodeURIComponent
    });
    vm.runInContext(`${lift(read('splits.js'), 'planUrl')}\n${lift(read('splits.js'), 'registerPlanLinks')}; this.f = registerPlanLinks;`, ctx);
    const term = {
      registerLinkProvider: (p) => { provider = p; },
      buffer: { active: { getLine: () => lineOf(text) } }
    };
    ctx.f(term, () => 'sid-1');
    let got;
    provider.provideLinks(1, (l) => { got = l || []; });
    return { got, opened };
  }

  it('finds the path and opens it through the plan URL of its own session', function () {
    const { got, opened } = links('see /data/ts/.claude/plans/2026-x.md now');
    assert.strictEqual(got.length, 1);
    assert.strictEqual(got[0].text, '/data/ts/.claude/plans/2026-x.md');
    assert.deepStrictEqual([got[0].range.start.x, got[0].range.end.x], [5, 36]);
    got[0].activate();
    assert.deepStrictEqual(opened, ['plan:sid-1:/data/ts/.claude/plans/2026-x.md']);
  });

  it('keeps the underline on the path when Chinese sits before it or in its name', function () {
    const { got } = links('计划：.claude/plans/防止遗漏.md');
    assert.strictEqual(got.length, 1);
    assert.strictEqual(got[0].text, '.claude/plans/防止遗漏.md');
    // 计划： is three wide glyphs = six cells, so the path starts at column 7.
    assert.strictEqual(got[0].range.start.x, 7);
    assert.strictEqual(got[0].range.end.x, 7 + '.claude/plans/'.length + 4 * 2 + '.md'.length - 1);
  });

  it('ignores markdown that is not under .claude/plans/', function () {
    assert.deepStrictEqual(links('readme.md and docs/plan.md').got, []);
  });
});

describe('TERM-08 OSC 52 copies to the browser clipboard', function () {
  function osc(payload) {
    const copied = [];
    const obj = vm.runInNewContext(`({ ${lift(read('app.js'), 'handleOsc52', { method: true })} })`,
      { atob, TextDecoder, Uint8Array });
    obj.copyToClipboard = (t) => copied.push(t);
    const ret = obj.handleOsc52(payload);
    return { ret, copied };
  }

  it('decodes UTF-8, so Chinese survives the copy', function () {
    const b64 = Buffer.from('复制 hello', 'utf8').toString('base64');
    assert.deepStrictEqual(osc(`c;${b64}`), { ret: true, copied: ['复制 hello'] });
  });

  it('ignores a query and a malformed payload instead of printing them', function () {
    assert.deepStrictEqual(osc('c;?'), { ret: true, copied: [] });
    assert.deepStrictEqual(osc('c;!!!not-base64'), { ret: true, copied: [] });
    assert.deepStrictEqual(osc('no-separator'), { ret: true, copied: [] });
  });

  it('is wired to OSC 52 in the main terminal and in split panes', function () {
    assert.ok(/registerOscHandler\(52, \(payload\) => this\.handleOsc52\(payload\)\)/.test(read('app.js')));
    assert.ok(/registerOscHandler\(52,/.test(read('splits.js')));
  });
});

describe('SRV-02 REST routes need the Authorization header', function () {
  const { ClaudeCodeWebServer } = require('../src/server');
  let server;
  let listener;
  let port;

  before(function (done) {
    server = new ClaudeCodeWebServer({ auth: 'tok-guard', folderMode: false });
    listener = http.createServer(server.app).listen(0, '127.0.0.1', () => {
      port = listener.address().port;
      done();
    });
  });

  after(function () {
    listener.close();
    if (server && typeof server.dispose === 'function') server.dispose();
  });

  const get = (p, headers = {}) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });

  it('refuses no token, a wrong token and a token in the query', async function () {
    assert.strictEqual(await get('/api/health'), 401);
    assert.strictEqual(await get('/api/health', { Authorization: 'Bearer nope' }), 401);
    assert.strictEqual(await get('/api/health?token=tok-guard'), 401);
  });

  it('lets the header through', async function () {
    assert.strictEqual(await get('/api/health', { Authorization: 'Bearer tok-guard' }), 200);
  });
});
