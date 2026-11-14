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

describe('SET-04 the settings title names the active tab', function () {
  // GAP-09: switching to an already-open tab left the title on the last
  // session joined. The name now comes from the tab bar.
  function nameFor(app) {
    const obj = vm.runInNewContext(`({ ${lift(read('app.js'), 'activeSessionName', { method: true })} })`, {});
    return obj.activeSessionName.call(app);
  }
  const tabs = (entries) => ({ activeSessions: new Map(entries) });

  it('follows the active tab, not the last one joined', function () {
    const app = { currentClaudeSessionId: 'a', currentClaudeSessionName: 'C', sessionTabManager: tabs([['a', { name: 'A' }], ['c', { name: 'C' }]]) };
    assert.strictEqual(nameFor(app), 'A');
  });

  it('follows a rename', function () {
    const s = tabs([['a', { name: 'A' }]]);
    const app = { currentClaudeSessionId: 'a', currentClaudeSessionName: 'A', sessionTabManager: s };
    s.activeSessions.get('a').name = 'Renamed';
    assert.strictEqual(nameFor(app), 'Renamed');
  });

  it('has nothing to name without a session, and falls back when the tab bar does not know it', function () {
    assert.strictEqual(nameFor({ currentClaudeSessionId: null }), null);
    assert.strictEqual(nameFor({ currentClaudeSessionId: 'x', currentClaudeSessionName: 'X', sessionTabManager: tabs([]) }), 'X');
    assert.strictEqual(nameFor({ currentClaudeSessionId: 'x', sessionTabManager: tabs([]) }), 'this session');
  });

  it('is what the settings title uses', function () {
    assert.ok(/const name = this\.activeSessionName\(\);\s*title\.textContent = name \? `Settings — \$\{name\}` : 'Settings';/.test(read('app.js')));
  });
});

describe('TERM-23 / UI-04 sounds: the bell and the plan chime', function () {
  // GAP-10: the plan chime was a truncated WAV the browser could not decode.
  // Both now go through playBeep, run here against a stub AudioContext.
  function play(method, arg) {
    const played = [];
    function Ctx() {
      this.currentTime = 0;
      this.destination = {};
      this.createOscillator = () => ({ type: '', frequency: {}, connect(g) { this._g = g; return g; }, start() { played.push({ type: this.type, freq: this.frequency.value }); }, stop() {} });
      this.createGain = () => ({ gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect(d) { return d; } });
    }
    const src = `({ ${lift(read('app.js'), 'playBeep', { method: true })}, ${lift(read('app.js'), method, { method: true })} })`;
    const obj = vm.runInNewContext(src, { window: { AudioContext: Ctx }, document: { hidden: false } });
    obj.sessionTabManager = null;
    obj[method](arg);
    return played;
  }

  it('the plan modal chimes (it never did)', function () {
    assert.deepStrictEqual(play('playNotificationSound'), [{ type: 'sine', freq: 660 }]);
    assert.ok(!/data:audio\/wav/.test(read('app.js')), 'no embedded WAV left');
    assert.ok(/showPlanModal\([^)]*\) \{[\s\S]*?this\.playNotificationSound\(\);/.test(read('app.js')), 'the modal still calls it');
  });

  it('the bell still rings as before', function () {
    assert.deepStrictEqual(play('handleBell', 's1'), [{ type: 'sine', freq: 880 }]);
  });

  it('stays silent, without throwing, where there is no audio', function () {
    const obj = vm.runInNewContext(`({ ${lift(read('app.js'), 'playBeep', { method: true })} })`, { window: {} });
    assert.doesNotThrow(() => obj.playBeep(660));
  });
});

describe('TERM-33 back to the newest screen', function () {
  // The button appears only while the terminal on screen is scrolled up, and
  // touches the DOM only when that answer changes (it runs on every render).
  function app(extra = {}, install = null) {
    const src = ['currentTerminal', 'updateScrollBottom', 'keepScrollBottomClear', 'scrollToLatest', 'refreshScrollBottom']
      .map(n => lift(read('app.js'), n, { method: true })).join(',\n');
    const btn = { attrs: { hidden: true }, writes: 0, style: {},
      hasAttribute(n) { return n in this.attrs; },
      toggleAttribute(n, on) { this.writes++; if (on) this.attrs[n] = true; else delete this.attrs[n]; } };
    const obj = vm.runInNewContext(`({ ${src} })`, {
      window: { innerHeight: 800 },
      document: { getElementById: (id) => (id === 'scrollBottomBtn' ? btn : id === 'installBtn' ? install : null) }
    });
    Object.assign(obj, extra);
    return { obj, btn };
  }
  const term = (viewportY, baseY) => ({ buffer: { active: { viewportY, baseY } }, scrolled: 0, focused: 0, scrollToBottom() { this.scrolled++; this.buffer.active.viewportY = this.buffer.active.baseY; }, focus() { this.focused++; } });

  it('shows while scrolled up, hides at the bottom', function () {
    const t = term(50, 200);
    const { obj, btn } = app({ activeView: { terminal: t }, splitContainer: null });
    obj.updateScrollBottom(t);
    assert.strictEqual(btn.hasAttribute('hidden'), false, 'scrolled up → shown');
    t.buffer.active.viewportY = 200;
    obj.updateScrollBottom(t);
    assert.strictEqual(btn.hasAttribute('hidden'), true, 'at the bottom → hidden');
  });

  it('does not touch the DOM when nothing changed', function () {
    const t = term(50, 200);
    const { obj, btn } = app({ activeView: { terminal: t }, splitContainer: null });
    obj.updateScrollBottom(t);
    const after = btn.writes;
    for (let i = 0; i < 20; i++) obj.updateScrollBottom(t);   // as onRender would
    assert.strictEqual(btn.writes, after, 'one write, then quiet');
  });

  it('ignores a terminal that is not the one on screen', function () {
    const shown = term(200, 200);
    const other = term(0, 500);
    const { obj, btn } = app({ activeView: { terminal: shown }, splitContainer: null });
    obj.updateScrollBottom(other);
    assert.strictEqual(btn.hasAttribute('hidden'), true, 'a background tab must not raise it');
  });

  it('answers for the focused split pane when split', function () {
    const pane = term(10, 90);
    const main = term(90, 90);
    const { obj } = app({ activeView: { terminal: main }, splitContainer: { enabled: true, splits: [{ isActive: false, terminal: term(90, 90) }, { isActive: true, terminal: pane }] } });
    assert.strictEqual(obj.currentTerminal(), pane);
  });

  it('leaves split panes to their own buttons: the page button hides while split', function () {
    // Measured 2026-11-09: one page-wide button answered for the focused pane
    // only, so an unfocused pane scrolled up showed nothing, and a shown one
    // sat in the right pane's corner while acting on the left.
    const pane = term(10, 90);
    const jumps = [];
    const split = { enabled: true, splits: [{ isActive: true, terminal: pane, updateJump() { jumps.push(1); } }] };
    const { obj, btn } = app({ activeView: { terminal: term(90, 90) }, splitContainer: split });
    btn.attrs = {};                         // shown from before the split
    obj.updateScrollBottom(pane);
    assert.strictEqual(btn.hasAttribute('hidden'), true, 'not for a pane');
    btn.attrs = {};
    obj.refreshScrollBottom();
    assert.strictEqual(btn.hasAttribute('hidden'), true);
    assert.strictEqual(jumps.length, 1, 'each pane is asked about its own');
  });

  it('scrolls to the bottom and hands the keyboard back', function () {
    const t = term(50, 200);
    const { obj, btn } = app({ activeView: { terminal: t }, splitContainer: null });
    obj.updateScrollBottom(t);
    obj.scrollToLatest();
    assert.strictEqual(t.scrolled, 1);
    assert.strictEqual(t.focused, 1);
    assert.strictEqual(btn.hasAttribute('hidden'), true, 'and hides itself');
  });

  it('steps aside for the PWA install button, and back when it goes', function () {
    // Measured in the browser: install is 129x43 at right/bottom 20, same corner.
    // A fixed-position element always has offsetParent null, so size is the test.
    const installShown = { offsetParent: null, getBoundingClientRect: () => ({ top: 737, height: 43, width: 129 }) };
    let t = term(50, 200);
    let a = app({ activeView: { terminal: t }, splitContainer: null }, installShown);
    a.obj.updateScrollBottom(t);
    assert.strictEqual(a.btn.style.bottom, '75px', 'above the install button');
    t = term(50, 200);
    a = app({ activeView: { terminal: t }, splitContainer: null }, { getBoundingClientRect: () => ({ top: 0, height: 0, width: 0 }) });
    a.obj.updateScrollBottom(t);
    assert.strictEqual(a.btn.style.bottom, '', 'install hidden → back to the corner (CSS decides)');
  });

  it('is wired to every terminal and to the button', function () {
    const a = read('app.js');
    assert.ok(/term\.onScroll\(\(\) => this\.updateScrollBottom\(term\)\)/.test(a), 'main terminal, on scroll');
    assert.ok(/term\.onRender\(\(\) => this\.updateScrollBottom\(term\)\)/.test(a), 'main terminal, on new output');
    assert.ok(/getElementById\('scrollBottomBtn'\)[\s\S]{0,120}addEventListener\('click', \(\) => this\.scrollToLatest\(\)\)/.test(a), 'the click');
    assert.ok(/this\.refreshScrollBottom\(\);/.test(a) && /adoptView\(view\)[\s\S]{0,120}refreshScrollBottom/.test(a), 'refreshed on tab switch');
    const s = read('splits.js');
    // A pane answers for itself with its own button (Split.updateJump).
    assert.ok(/this\.terminal\.onScroll\(\(\) => this\.updateJump\(\)\)/.test(s), 'split pane, on scroll');
    assert.ok(/this\.terminal\.onRender\(\(\) => this\.updateJump\(\)\)/.test(s), 'split pane, on new output');
    assert.ok(/focusSplit[\s\S]{0,600}refreshScrollBottom/.test(s), 'refreshed when a pane takes focus');
    const css = fs.readFileSync(path.join(PUB, 'style.css'), 'utf8');
    assert.ok(/\.scroll-bottom-btn \{[\s\S]*?position: fixed;[\s\S]*?right: 84px;[\s\S]*?bottom: 24px;/.test(css), 'bottom-right, left of the floating key column');
    assert.ok(/\.scroll-bottom-btn\[hidden\] \{\s*display: none;/.test(css));
  });
});

describe('SPACE-05 the fresh-install hint leaves when there is something to show', function () {
  it('a hidden .sidebar-empty is really gone — its display:flex would beat [hidden]', function () {
    // Without this rule the hint stays visible beside a populated tree and,
    // being flex:1 like the tree, takes half the sidebar's height.
    const css = fs.readFileSync(path.join(PUB, 'style.css'), 'utf8');
    assert.ok(/\.sidebar-empty\[hidden\]\s*\{\s*display:\s*none/.test(css));
  });
});

describe('SPACE-05 one header toggle opens and closes the sidebar', function () {
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(PUB, 'spaces.js'), 'utf8');

  it('the in-sidebar collapse button is gone (user 2026-11-04)', function () {
    assert.ok(!html.includes('sidebarCollapseBtn'));
  });

  it('on desktop the toggle folds as well as unfolds', function () {
    // It used to only bring a hidden sidebar back; hiding needed the other button.
    const body = /toggleDrawer\(\)\s*\{([\s\S]*?)\n    \}/.exec(js)[1];
    assert.ok(/!this\.isNarrow\(\)[\s\S]*?classList\.toggle\('sidebar-hidden'\)/.test(body));
  });

  it('aria-expanded follows the state', function () {
    assert.ok(/setAttribute\('aria-expanded'/.test(js));
  });
});

describe('SPACE-19 tasks not open on this device stay visible in their space', function () {
  const js = read('spaces.js');
  const css = read('style.css');

  it('every server session without a tab here is drawn as a dim row', function () {
    const body = lift(js, 'renderRemote', { method: true });
    assert.ok(/this\.serverSessions\.values\(\)/.test(body));
    assert.ok(/tabs\.tabs\.has\(s\.id\)\)\s*continue/.test(body), 'open tabs are skipped');
    assert.ok(/buildRemoteRow/.test(body));
  });

  it('a dim row opens through the same path as the Sessions panel', function () {
    // An async method — lift() matches plain ones only.
    assert.ok(/async openRemote\(s\) \{[\s\S]{0,200}attachSessionTab\(s\.id/.test(js));
  });

  it('a closed (deleted) tab does not come back as a dim row', function () {
    assert.ok(/this\.serverSessions\.delete\(sessionId\)/.test(lift(js, 'forgetSession', { method: true })));
  });

  it('the list is re-read when the page returns and every minute', function () {
    assert.ok(/visibilitychange[\s\S]{0,120}syncServerSessions/.test(js));
    assert.ok(/setInterval\([\s\S]{0,80}syncServerSessions[\s\S]{0,40}60000/.test(js));
  });

  it('a space holding only such tasks does not say (empty), and folding hides them', function () {
    assert.ok(/\.space-group\.has-remote \.space-tasks:empty\s*\{\s*display:\s*none/.test(css));
    assert.ok(/\.space-group\.collapsed \.space-remote\s*\{\s*display:\s*none/.test(css));
  });
});

describe('START-05 / GAP-15 the restore dialog', function () {
  const src = lift(read('app.js'), 'showSessionReconcileModal', { method: true });

  it('ticks sessions made on another device by default (user 2026-11-07)', function () {
    assert.ok(/persistedIds\.has\(sv\.id\)\s*\|\|\s*extraIds\.has\(sv\.id\)\)\s*\?\s*'checked'/.test(src));
  });

  it('closes with ×, Esc and the backdrop, marking nothing ignored', function () {
    assert.ok(/rc-close/.test(src) && /'Escape'/.test(src) && /e\.target === modal/.test(src));
    const dismiss = /const dismiss = async \(\) => \{([\s\S]*?)\n        \};/.exec(src);
    assert.ok(dismiss, 'dismiss is gone');
    assert.ok(/stm\.saveTabState\(\)/.test(dismiss[1]), 'saves without an ignored list');
    assert.ok(!/ignoredIds/.test(dismiss[1]));
  });
});

describe('MOB-25 the phone header fits and names the task', function () {
  const css = read('style.css');
  const html = read('index.html');
  const phone = (() => {
    const at = css.lastIndexOf('@media (max-width: 480px) {\n    .app-header {');
    assert.ok(at >= 0, 'the phone header block is gone');
    return css.slice(at, at + blockAt(css, at).length + 40);
  })();

  it('files, branches and account leave the header, but not the branch panel', function () {
    assert.ok(/#explorerBtn,\s*#branchBtn,\s*(#peerThreadsBtn,\s*)?#accountHeaderBtn\s*\{\s*display:\s*none/.test(phone));
    assert.ok(!/#branchWrapper[^{]*\{\s*display:\s*none/.test(phone), 'the wrapper holds the panel');
  });

  it('…and are in the ⚙ menu, shown only on a phone', function () {
    for (const id of ['accountBtnMenu', 'explorerBtnMenu', 'branchBtnMenu']) {
      assert.ok(new RegExp(`id="${id}" class="mobile-menu-btn menu-narrow-only"`).test(html), id);
    }
    assert.ok(/^\.menu-narrow-only \{ display: none; \}/m.test(css));
    assert.ok(/\.menu-narrow-only:not\(\[hidden\]\)\s*\{\s*display:\s*block/.test(phone),
      ':not([hidden]) — the account entry must stay hidden while nobody is signed in');
  });

  it('the breadcrumb shows the task name and is not squeezed to nothing', function () {
    assert.ok(/\.app-logo \{ display: none; \}/.test(phone));
    assert.ok(/\.header-new-task span \{ display: none; \}/.test(phone));
    assert.ok(/\.header-breadcrumb \.crumb-task \{\s*grid-row: 1/.test(phone));
  });
});

describe('header icons are one size (user 2026-11-11)', function () {
  // 「增加图标，首要条件就要保持样式一致」: the Hand-offs button shipped at the
  // bare .tab-settings 28px / 16px beside 44px / 24px neighbours.
  const html = read('index.html');
  const css = read('style.css');
  const whole = html.slice(html.indexOf('<div class="header-actions">'), html.indexOf('id="accountHeaderBtn"'));
  // The branch dropdown's own buttons live inside the row; they are a panel's.
  const panelAt = whole.indexOf('class="branch-panel');
  const row = whole.slice(0, panelAt) + whole.slice(whole.indexOf('<!-- Sessions + the folder', panelAt));

  it('every icon button in the header row is a .tab-settings (or the ⚙ menu button)', function () {
    const buttons = [...row.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
    assert.ok(buttons.length >= 6, 'the header row moved; update this test');
    for (const b of buttons) {
      if (/class="(header-new-task|hamburger-btn)"/.test(b)) continue;
      assert.match(b, /class="tab-settings[" ]/, `${b} is not sized like its neighbours`);
    }
  });

  it('one rule gives them all a 44px target and a 24px glyph', function () {
    assert.match(css, /\.header-actions \.tab-settings \{\s*width: 44px;\s*height: 44px;\s*\}/);
    assert.match(css, /\.header-actions \.tab-settings svg \{\s*width: 24px;\s*height: 24px;\s*\}/);
    assert.match(css, /\.hamburger-btn svg \{\s*width: 24px;\s*height: 24px;/);
  });
});

describe('TAB-03 / SPACE-15 a task row has one button: ⋯ (user 2026-11-14)', function () {
  const js = read('session-manager.js');
  const row = js.slice(js.indexOf("tab.className = 'session-tab'"), js.indexOf('tabsContainer.appendChild(tab)'));

  it('the row markup holds the ⋯ and no other button', function () {
    assert.deepStrictEqual([...row.matchAll(/<button\b[^>]*class="([^"]+)"/g)].map((m) => m[1]), ['tab-menu']);
    assert.ok(!row.includes('tab-close') && !row.includes('class="tab-pin"'));
  });

  it('pin and delete are items of the ⋯ menu, and delete still confirms', function () {
    const menu = js.slice(js.indexOf('openTabContextMenu(sessionId, clientX, clientY) {'), js.indexOf('createNewSession() {'));
    assert.ok(menu.includes("pinned ? 'Unpin' : 'Pin'"));
    assert.ok(menu.includes("addItem('Delete task', () => this.closeSession(sessionId))"));
    assert.ok(!/closeSession\(sessionId, \{ skipConfirm/.test(menu), 'the menu item must not skip the confirmation');
  });

  it('a pinned row keeps a passive mark, not a button', function () {
    assert.match(row, /<span class="tab-pin-mark"/);
    assert.match(read('style.css'), /\.tab-pin-mark \{[^}]*pointer-events: none/);
  });
});

describe('PEER-02..04 hand-offs between tasks (peer-threads.js)', function () {
  const src = read('peer-threads.js');

  it('PEER-02: a card offers navigation and copy only — never an approval', function () {
    const acts = [...src.matchAll(/add\('[^']+', '([a-z-]+)'/g)].map((m) => m[1]);
    assert.deepStrictEqual([...new Set(acts)].sort(), ['copy', 'goto-from', 'goto-self', 'goto-to']);
    assert.ok(!/approve|allow|reject/i.test(acts.join(' ')));
    // Message text is another model's words: text nodes, never innerHTML.
    assert.ok(!/innerHTML/.test(src));
  });

  it('PEER-02: thread updates reach the drawer from any socket', function () {
    assert.match(read('app.js'), /message\.event === 'ccweb_peer_thread'[\s\S]{0,120}window\.peerThreads\.onThread\(message\.thread\)/);
    // An older copy of a thread (several sockets get each update) is ignored.
    assert.match(src, /known\.updatedAt \|\| ''\) >= \(t\.updatedAt/);
  });

  it('PEER-03: news marks the sender\'s task and the header count', function () {
    assert.match(src, /tab\.dataset\.peer = ''/);
    assert.match(read('style.css'), /\.session-tab\[data-peer\]:not\(\[data-awaiting\]\) \.tab-content::after/);
    assert.match(read('index.html'), /id="peerThreadsBadge" hidden/);
  });

  it('PEER-04: a hand-off is typed into this task\'s own Claude, not sent by the page', function () {
    const send = src.slice(src.indexOf('PeerThreads.prototype.sendHandoff'), src.indexOf('window.PeerThreads = '));
    // Bracketed paste (ESC[200~ … ESC[201~) keeps the text one prompt.
    assert.ok(send.includes(String.raw`app.sendInput('\x1b[200~' + prompt + '\x1b[201~', sid)`));
    assert.ok(send.includes(String.raw`app.sendInput('\r', sid)`));
    assert.ok(!/fetch\(/.test(send), 'no request to another session from the page');
    assert.match(read('session-manager.js'), /addItem\('Hand off to…', \(\) => window\.peerThreads && window\.peerThreads\.openHandoff\(sessionId\)\)/);
  });

  it('PEER-02: on a phone the header button lives in the ⚙ menu', function () {
    assert.match(read('style.css'), /#peerThreadsBtn,\s*#accountHeaderBtn \{ display: none; \}/);
    assert.match(read('app.js'), /\['peerThreadsBtnMenu', 'peerThreadsBtn'\]/);
  });
});
