const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ClaudeCodeWebServer } = require('../src/server');
const { useTempDataDir } = require('./helpers/auth');

// Split panes against the per-tab views (fix-plan-split-view-2026-11-09).
//
// The main terminal became "one view per tab, each with its own socket", but
// splits.js still entered with app.leaveSession() and left with
// app.joinSession(id) — calls on whatever socket was current. Measured on
// 32353: closing a split with B's pane focused put tab A's view on session B
// (views: [[A -> B], [B -> B]]), so tab A showed and typed into B until a
// reload; and right after entering, currentClaudeSessionId was null because
// leave_session's ack landed after the split had set it.
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const APP = read('src', 'public', 'app.js');
const SPLITS = read('src', 'public', 'splits.js');
const MANAGER = read('src', 'public', 'session-manager.js');

// The body of a class method, by brace matching from its header.
function methodSrc(src, name) {
  const m = new RegExp(`\\n\\s+(async\\s+)?${name}\\s*\\([^)]*\\)\\s*\\{`).exec(src);
  assert.ok(m, `${name} is gone — this guard is measuring nothing`);
  let i = m.index + m[0].length;
  let depth = 1;
  while (depth && i < src.length) {
    const c = src[i++];
    if (c === '{') depth++;
    else if (c === '}') depth--;
  }
  return src.slice(m.index, i).trim();
}

// Code only: the comments explain the old calls by name.
const code = (src) => src.replace(/^\s*\/\/.*$/gm, '');

// Compare across vm realms (deepStrictEqual checks prototypes).
const same = (a, b) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), b);

// splits.js in a sandbox: just enough DOM for the classes to be used.
function loadSplits(extra = {}) {
  const ctx = vm.createContext({
    window: {}, console: { log() {}, warn() {}, error() {} },
    document: { getElementById: () => null, querySelectorAll: () => [], visibilityState: 'visible' },
    localStorage: { setItem() {}, getItem: () => null },
    WebSocket: { OPEN: 1 },
    setTimeout, ...extra
  });
  vm.runInContext(`${SPLITS}\nthis.Split = Split; this.SplitContainer = SplitContainer;`, ctx);
  return ctx;
}

function fakeSocket() {
  const sent = [];
  return { readyState: 1, sent, send(d) { sent.push(JSON.parse(d)); }, close() { this.readyState = 3; } };
}

describe('split panes and the per-tab views', function () {
  describe('entering a split', function () {
    it('parks the main view instead of leaving its session', function () {
      const body = code(methodSrc(SPLITS, 'createSplit'));
      assert.ok(!/leaveSession\(/.test(body), 'leaveSession nulls the current session and clears the view');
      assert.ok(/this\.app\.parkActiveView\(\)/.test(body));
    });

    it('parkActiveView withdraws the size vote and hands the screen to the idle view', function () {
      const obj = vm.runInNewContext(`({ ${methodSrc(APP, 'adoptView')}, ${methodSrc(APP, 'parkActiveView')} })`);
      const sent = [];
      const removed = [];
      const view = { socket: 's', el: { classList: { remove: (c) => removed.push(c) } } };
      const idle = { socket: null, terminal: 'idle-term' };
      Object.assign(obj, {
        activeView: view, idleView: idle,
        sendOn: (v, d) => sent.push([v, d])
      });
      obj.parkActiveView();
      assert.strictEqual(sent.length, 1);
      assert.strictEqual(sent[0][0], view);
      same(sent[0][1], { type: 'detach_size' });
      same(removed, ['active']);
      assert.strictEqual(obj.activeView, idle);
      assert.strictEqual(obj.socket, null);
    });

    it('names the focused pane\'s session as current, whether or not focusSplit ran', function () {
      const body = methodSrc(SPLITS, 'createSplit');
      assert.ok(/this\.app\.currentClaudeSessionId = \(focused && focused\.sessionId\) \|\| currentSessionId/.test(body));
    });
  });

  describe('closing a split', function () {
    function container(panes, active) {
      const ctx = loadSplits();
      const sc = Object.create(ctx.SplitContainer.prototype);
      const switched = [];
      const joined = [];
      Object.assign(sc, {
        enabled: true, activeSplitIndex: active, orientation: 'horizontal', dividerPosition: 50,
        splitContainerEl: { style: {}, querySelectorAll: () => [] },
        splits: panes.map((sessionId, i) => ({
          sessionId, isActive: i === active, terminal: { clear() {} },
          disconnect() {}, updateActiveState() {}
        })),
        app: {
          currentClaudeSessionId: panes[active],
          sessionTabManager: { tabs: new Map(panes.filter(Boolean).map(id => [id, {}])), switchToTab: (id) => switched.push(id) },
          joinSession: (id) => joined.push(id),
          showSession: () => { throw new Error('tab exists, should switch'); }
        }
      });
      return { sc, switched, joined };
    }

    it('switches to the focused pane\'s session like a tab click, never re-joins', function () {
      const { sc, switched, joined } = container(['A', 'B'], 1);
      sc.closeSplit();
      assert.deepStrictEqual(switched, ['B']);
      assert.deepStrictEqual(joined, []);
      assert.strictEqual(sc.enabled, false);
      const body = code(methodSrc(SPLITS, 'closeSplit'));
      assert.ok(!/joinSession\(|\.connect\(/.test(body), 'joining on the current socket is the bug');
    });

    it('folds onto the other pane when a pane\'s tab is closed', function () {
      const { sc, switched } = container(['A', 'B'], 1);
      sc.onSessionClosed('B');
      assert.deepStrictEqual(switched, ['A']);
    });

    it('leaves the switch to the tab manager when no other session is shown', function () {
      const { sc, switched } = container(['A', null], 1);
      sc.onSessionClosed('A');
      assert.deepStrictEqual(switched, []);
      assert.strictEqual(sc.enabled, false);
    });

    it('is told about every closed tab', function () {
      const body = methodSrc(MANAGER, 'closeSession');
      assert.ok(/split\.onSessionClosed\(sessionId\)/.test(body));
    });
  });

  describe('the main view during a split', function () {
    it('no longer pushes a joining view\'s session into the focused pane', function () {
      const at = APP.indexOf("case 'session_joined':");
      const body = APP.slice(at, APP.indexOf("case 'session_left':", at));
      assert.ok(!/onTabSwitch\(/.test(body));
    });

    it('rejoins a background view whose socket died, and casts no vote if the screen moved on', function () {
      const body = methodSrc(APP, 'showSession');
      assert.ok(/readyState > WebSocket\.OPEN/.test(body));
      assert.ok(/await this\.openViewSocket\(view\);\s*[\s\S]{0,200}if \(this\.activeView !== view\) return;/.test(body));
    });

    it('shows the Start prompt for a stopped Claude only on screen', function () {
      const at = APP.indexOf("case 'claude_stopped':");
      const body = APP.slice(at, APP.indexOf('break;', at));
      assert.ok(/if \(forActive\) this\.showOverlay\('startPrompt'\)/.test(body));
    });
  });

  describe('keys the page sends itself', function () {
    function app(split) {
      const obj = vm.runInNewContext(`({ ${methodSrc(APP, 'inputSocket')}, ${methodSrc(APP, 'sendInput')}, ${methodSrc(APP, 'sendOnSocket')} })`, { WebSocket: { OPEN: 1 }, JSON });
      return Object.assign(obj, { socket: fakeSocket(), views: new Map(), splitContainer: split });
    }

    it('go to the focused pane while split, to the view on screen otherwise', function () {
      const left = { sessionId: 'A', socket: fakeSocket() };
      const right = { sessionId: 'B', socket: fakeSocket() };
      const split = { enabled: true, activeSplitIndex: 1, splits: [left, right] };
      const a = app(split);
      a.sendInput('\x1b');
      assert.deepStrictEqual(right.socket.sent, [{ type: 'input', data: '\x1b' }]);
      assert.deepStrictEqual(a.socket.sent, []);
      split.enabled = false;
      a.sendInput('x');
      assert.deepStrictEqual(a.socket.sent, [{ type: 'input', data: 'x' }]);
    });

    it('go to a named session\'s pane or view (the plan dialog, an image)', function () {
      const left = { sessionId: 'A', socket: fakeSocket() };
      const split = { enabled: true, activeSplitIndex: 0, splits: [left, { sessionId: 'B', socket: fakeSocket() }] };
      const a = app(split);
      const bg = { socket: fakeSocket() };
      a.views.set('C', bg);
      a.sendInput('\r', 'C');
      a.sendInput('\r', 'A');
      assert.strictEqual(bg.socket.sent.length, 1);
      assert.strictEqual(left.socket.sent.length, 1);
      assert.strictEqual(a.sendInput('\r', 'GONE'), false, 'a session with no pane or view is reported, not typed elsewhere');
      assert.deepStrictEqual(a.socket.sent, []);
    });

    it('a dead letter is said, not shown as success', function () {
      assert.ok(/if \(this\.sendInput\(data\.path \+ ' ', sessionId\)\) this\.showToast\('Image inserted'\)/.test(methodSrc(APP, 'uploadAndInsertImage')));
      for (const name of ['acceptPlan', 'rejectPlan']) {
        assert.ok(/if \(!this\.sendInput\([\s\S]*?return;/.test(methodSrc(APP, name)), `${name} must keep the dialog when the answer went nowhere`);
      }
    });

    it('every toolbar key and the plan answers use it', function () {
      for (const name of ['sendEscape', 'switchMode', 'sendRightArrow', 'acceptPlan', 'rejectPlan', 'uploadAndInsertImage']) {
        const body = methodSrc(APP, name);
        assert.ok(/this\.sendInput\(/.test(body), `${name} must send through sendInput`);
        assert.ok(!/this\.send\(\{ type: 'input'|this\.socket\.send\(/.test(body), `${name} still writes to this.socket`);
      }
      assert.ok(/this\.sendInput\('\\r', this\._planSessionId\)/.test(methodSrc(APP, 'acceptPlan')));
    });

    it('panes take pasted and dropped images, for the pane they landed in', function () {
      assert.ok(/this\.app\.wireImageInput\(this\.splitContainerEl, this\.splitContainerEl,/.test(SPLITS));
      // An empty pane answers null, which must not fall back to the other pane's session.
      assert.ok(/return pane \? \(pane\.sessionId \|\| null\) : undefined;/.test(SPLITS));
      assert.ok(/return sid === undefined \? this\.currentClaudeSessionId : sid;/.test(methodSrc(APP, 'wireImageInput')));
    });
  });

  describe('a pane\'s own messages', function () {
    function pane(app = {}) {
      const ctx = loadSplits();
      const p = Object.create(ctx.Split.prototype);
      const written = [];
      Object.assign(p, {
        index: 1, sessionId: 'B', isActive: true, hibernated: false, socket: fakeSocket(),
        terminal: { cols: 90, rows: 30, write: (d) => written.push(d) },
        app: Object.assign({
          getAlias: () => 'Claude', startDefaultsOptions: () => ({ model: 'm' }), currentUiTheme: () => 'dark',
          views: new Map()
        }, app)
      });
      return { p, written };
    }

    it('starts a stopped session with the new task\'s options, else the defaults', function () {
      const app = { pendingStart: { options: { effort: 'high' }, sessionId: 'B' } };
      let { p } = pane(app);
      p.handleMessage({ type: 'session_joined', active: false });
      same(p.socket.sent, [{ type: 'start_claude', options: { effort: 'high' }, uiTheme: 'dark', cols: 90, rows: 30 }]);
      assert.strictEqual(p.app.pendingStart, null);

      ({ p } = pane({ pendingStart: { options: { effort: 'high' }, sessionId: 'OTHER' } }));
      p.handleMessage({ type: 'session_joined', active: false });
      same(p.socket.sent[0].options, { model: 'm' });
      assert.ok(p.app.pendingStart, 'another session\'s pending start is not ours to take');

      ({ p } = pane());
      p.handleMessage({ type: 'session_joined', active: true });
      assert.deepStrictEqual(p.socket.sent, []);
    });

    it('does not restart a session this page already has a view of (stopped on purpose, or hibernated)', function () {
      let { p } = pane();
      p.app.views.set('B', { hibernated: false });
      p.handleMessage({ type: 'session_joined', active: false });
      assert.deepStrictEqual(p.socket.sent, []);

      ({ p } = pane());
      p.app.views.set('B', { hibernated: true });
      p.handleMessage({ type: 'session_joined', active: false });
      assert.deepStrictEqual(p.socket.sent, []);
      assert.strictEqual(p.hibernated, true, 'focusing the pane resumes it');
    });

    it('starts on "not running" only for the focused, awake pane', function () {
      const info = { type: 'info', message: 'Claude is not running' };
      const { p } = pane();
      p.isActive = false;
      p.handleMessage(info);
      assert.deepStrictEqual(p.socket.sent, []);
      p.isActive = true; p.hibernated = true;
      p.handleMessage(info);
      assert.deepStrictEqual(p.socket.sent, []);
      p.hibernated = false;
      p.handleMessage(info);
      assert.strictEqual(p.socket.sent[0].type, 'start_claude');
    });

    it('drops xterm focus reports from what it sends', function () {
      assert.ok(methodSrc(SPLITS, 'createTerminal').includes("data.replace(/\\x1b\\[\\[?[IO]/g, '')"));
    });

    it('resumes a hibernated session when focused', function () {
      const { p, written } = pane({ sessionTabManager: { setTabWorking() {}, updateTabStatus() {}, activeSessions: new Map() } });
      p.isActive = false;
      p.handleMessage({ type: 'claude_hibernated', reason: 'idle', idleMinutes: 30 });
      assert.ok(p.hibernated && /Hibernated/.test(written.join('')));
      assert.deepStrictEqual(p.socket.sent, []);
      p.resumeIfHibernated();
      assert.strictEqual(p.socket.sent[0].type, 'start_claude');
      assert.strictEqual(p.hibernated, false);
    });

    it('closes the tab of a session deleted elsewhere', function () {
      const closed = [];
      const { p } = pane({
        showToast() {},
        sessionTabManager: { tabs: new Map([['B', {}]]), closeSession: (id, o) => closed.push([id, o]) }
      });
      p.handleMessage({ type: 'session_deleted', sessionId: 'B' });
      same(closed, [['B', { skipServerRequest: true }]]);
    });

    it('leaves hook events to the session\'s own view while it is connected', function () {
      const heard = [];
      const msg = { type: 'hook_event', tool_name: 'ExitPlanMode', tool_input: { plan: 'x' } };
      let { p } = pane({ handleHookEvent: (m, sid) => heard.push(sid) });
      p.app.views.set('B', { socket: { readyState: 1 } });
      p.handleMessage(msg);
      assert.deepStrictEqual(heard, []);

      p.app.views.set('B', { socket: { readyState: 3 } }); // its socket died
      p.handleMessage(msg);
      ({ p } = pane({ handleHookEvent: (m, sid) => heard.push(sid) }));
      p.handleMessage(msg); // no view at all
      assert.deepStrictEqual(heard, ['B', 'B']);
    });

    it('shares one hook handler with the main view (plan, permission card, rails)', function () {
      const body = methodSrc(APP, 'handleHookEvent');
      for (const re of [/this\.showPlanModal\(/, /this\.showPermissionRequestCard\(/, /sessionTabManager\.hookEvent\(/, /this\.refreshTurnRails\(/]) {
        assert.ok(re.test(body), `handleHookEvent lost ${re}`);
      }
    });
  });

  describe('server: one start at a time', function () {
    let server;
    afterEach(function () { if (server && server.dispose) server.dispose(); server = null; });

    it('ignores a second start_claude while the first is still starting', async function () {
      server = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
      useTempDataDir(server); // never write the test session into the real sessions.json
      const sent = [];
      let starts = 0;
      server.claudeBridge.startSession = () => { starts++; return new Promise(() => {}); }; // still starting
      server.sendToWebSocket = (ws, m) => sent.push(m);
      server.claudeSessions.set('S', { id: 'S', active: false, connections: new Set(['w1', 'w2']), workingDir: process.cwd() });
      server.webSocketConnections.set('w1', { id: 'w1', ws: {}, claudeSessionId: 'S' });
      server.webSocketConnections.set('w2', { id: 'w2', ws: {}, claudeSessionId: 'S' });
      server.startClaude('w1', {}, 80, 24);
      await new Promise(r => setImmediate(r));
      await server.startClaude('w2', {}, 80, 24);
      assert.strictEqual(starts, 1);
      assert.deepStrictEqual(sent.filter(m => m.type === 'error'), [], 'the second asker must not get an error');
    });

    it('tells every asker when the start fails', async function () {
      server = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
      useTempDataDir(server);
      const errors = [];
      let fail;
      server.claudeBridge.startSession = () => new Promise((_, rej) => { fail = rej; });
      server.sendToWebSocket = (ws, m) => { if (m.type === 'error') errors.push(ws.id); };
      server.claudeSessions.set('S', { id: 'S', active: false, connections: new Set(['w1', 'w2']), workingDir: process.cwd() });
      server.webSocketConnections.set('w1', { id: 'w1', ws: { id: 'w1' }, claudeSessionId: 'S' });
      server.webSocketConnections.set('w2', { id: 'w2', ws: { id: 'w2' }, claudeSessionId: 'S' });
      const first = server.startClaude('w1', {}, 80, 24);
      await new Promise(r => setImmediate(r));
      await server.startClaude('w2', {}, 80, 24);
      fail(new Error('spawn failed'));
      await first;
      assert.deepStrictEqual(errors.sort(), ['w1', 'w2']);
      assert.strictEqual(server.claudeSessions.get('S')._starting, false, 'a failed start must not block the next one');
    });
  });

  // TERM-33 in a split: each pane has its own jump-to-latest button.
  describe('each pane\'s own jump button', function () {
    function btn() {
      return { attrs: { hidden: true }, writes: 0, style: {},
        hasAttribute(n) { return n in this.attrs; },
        toggleAttribute(n, on) { this.writes++; if (on) this.attrs[n] = true; else delete this.attrs[n]; } };
    }
    function pane(viewportY, baseY) {
      const ctx = loadSplits();
      const p = Object.create(ctx.Split.prototype);
      const cleared = [];
      Object.assign(p, {
        jumpBtn: btn(), container: {},
        terminal: { buffer: { active: { viewportY, baseY } }, scrolled: 0, focused: 0,
          scrollToBottom() { this.scrolled++; this.buffer.active.viewportY = this.buffer.active.baseY; },
          focus() { this.focused++; } },
        app: { keepPaneJumpClear: (b) => cleared.push(b) }
      });
      return { p, cleared };
    }

    it('shows while its own pane is scrolled up, focused or not, and only writes on change', function () {
      const { p, cleared } = pane(10, 90);
      p.isActive = false;
      p.updateJump();
      assert.strictEqual(p.jumpBtn.hasAttribute('hidden'), false);
      assert.strictEqual(cleared.length, 1, 'placed clear of the floating buttons when it appears');
      for (let i = 0; i < 10; i++) p.updateJump();
      assert.strictEqual(p.jumpBtn.writes, 1);
      p.terminal.buffer.active.viewportY = 90;
      p.updateJump();
      assert.strictEqual(p.jumpBtn.hasAttribute('hidden'), true);
    });

    it('scrolls its own pane to the bottom and hands it the keyboard', function () {
      const { p } = pane(10, 90);
      p.updateJump();
      p.scrollToLatest();
      assert.strictEqual(p.terminal.scrolled, 1);
      assert.strictEqual(p.terminal.focused, 1);
      assert.strictEqual(p.jumpBtn.hasAttribute('hidden'), true);
    });

    it('is built per pane, labelled, and refreshed when the split opens, clears or closes', function () {
      const make = methodSrc(SPLITS, 'createTerminal');
      assert.ok(/this\.jumpBtn\.title = 'Jump to latest'/.test(make));
      assert.ok(/setAttribute\('aria-label', 'Jump to latest'\)/.test(make));
      assert.ok(/this\.container\.appendChild\(this\.jumpBtn\)/.test(make));
      assert.ok(/this\.app\.refreshScrollBottom\(\)/.test(methodSrc(SPLITS, 'createSplit')));
      assert.ok(/this\.updateJump\(\)/.test(methodSrc(SPLITS, 'clear')));
      assert.ok(/split\.updateJump\(\)/.test(methodSrc(SPLITS, 'closeSplit')));
      assert.ok(/reclearPaneJumps\(\)/.test(methodSrc(SPLITS, 'scheduleRefit')));
    });

    it('lifts itself above the install button or key stack, inside its pane', function () {
      const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
      const els = {};
      const obj = vm.runInNewContext(`({ ${methodSrc(APP, 'keepPaneJumpClear')} })`, {
        document: { getElementById: (id) => els[id] || null }
      });
      const paneEl = { getBoundingClientRect: () => rect(900, 40, 700, 800) };     // bottom 840
      const b = { attrs: {}, style: { bottom: '' }, hasAttribute(n) { return n in this.attrs; },
        getBoundingClientRect: () => rect(1548, 788, 36, 36) };                   // 16px off the pane bottom
      obj.keepPaneJumpClear(b, paneEl);
      assert.strictEqual(b.style.bottom, '', 'nothing there: CSS decides');
      els.installBtn = { getBoundingClientRect: () => rect(1450, 780, 129, 43) };  // over the button
      obj.keepPaneJumpClear(b, paneEl);
      assert.strictEqual(b.style.bottom, '68px', 'just above the install button (840 - 780 + 8)');
      els.installBtn = { getBoundingClientRect: () => rect(1450, 30, 129, 900) };  // taller than the pane
      obj.keepPaneJumpClear(b, paneEl);
      assert.strictEqual(b.style.bottom, '756px', 'never pushed out of the pane (800 - 36 - 8)');
    });

    it('re-places itself when what it avoids moves', function () {
      assert.ok(/this\.reclearPaneJumps\(\);\s*\}/.test(methodSrc(APP, 'applyFabPosition')), 'the key stack was moved');
      const html = read('src', 'public', 'index.html');
      assert.strictEqual((html.match(/window\.app\.reclearPaneJumps\(\)/g) || []).length, 2, 'the install button came or went');
    });

    it('stays in its pane\'s corner without overriding the phone size or [hidden]', function () {
      const css = read('src', 'public', 'style.css');
      const m = /\.split-pane > \.scroll-bottom-btn \{([^}]*)\}/.exec(css);
      assert.ok(m, 'pane rule');
      assert.ok(/position: absolute;/.test(m[1]) && /z-index: 20;/.test(m[1]));
      assert.ok(!/width|height|display/.test(m[1]));
    });
  });
});
