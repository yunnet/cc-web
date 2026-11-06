const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { ClaudeCodeWebServer } = require('../src/server');
const ClaudeBridge = require('../src/claude-bridge');
const SessionStore = require('../src/utils/session-store');

// The tab's context ring rides Claude's statusLine: bin/cc-statusline.js gets a
// snapshot on stdin, POSTs it to /api/hooks/:sessionId, and the server keeps
// the numbers and tells the browser. The fixture is a real 2.1.304 snapshot,
// paths trimmed.
const SNAPSHOT = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'statusline-input.json'), 'utf8'));
const RELAY = path.join(__dirname, '..', 'bin', 'cc-statusline.js');
const USER_LINE = path.join(__dirname, 'fixtures', 'statusline-user.js');

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; }
  };
}

function hookReq(body, remote = '127.0.0.1') {
  return { params: { sessionId: 'sid' }, socket: { remoteAddress: remote }, headers: { authorization: 'Bearer htok' }, body };
}

describe('statusLine snapshot → context ring', function() {
  describe('liveUsageFrom', function() {
    it('keeps the numbers the ring and its tooltip show', function() {
      const u = ClaudeCodeWebServer.liveUsageFrom(SNAPSHOT);
      assert.strictEqual(u.ctxPct, 6);
      assert.strictEqual(u.ctxSize, 1000000);
      // What is in the window now: new input plus both cache halves, not output.
      assert.strictEqual(u.ctxUsed, 2 + 22850 + 32854);
      assert.strictEqual(u.costUsd, 0.1895855);
      assert.strictEqual(u.model, 'Opus 5.5');
      assert.strictEqual(u.fiveHourPct, 8);
      assert.strictEqual(u.sevenDayPct, 40);
      assert.strictEqual(typeof u.at, 'number');
    });

    it('says null, not 0, for what the snapshot leaves out', function() {
      const u = ClaudeCodeWebServer.liveUsageFrom({ cost: { total_cost_usd: 0.5 } });
      assert.strictEqual(u.ctxPct, null);
      assert.strictEqual(u.ctxUsed, null);
      assert.strictEqual(u.fiveHourPct, null);
    });

    it('drops a snapshot with no numbers at all', function() {
      assert.strictEqual(ClaudeCodeWebServer.liveUsageFrom({ model: { display_name: 'x' } }), null);
      assert.strictEqual(ClaudeCodeWebServer.liveUsageFrom({ context_window: { used_percentage: 'lots' } }), null);
    });
  });

  describe('the hook endpoint', function() {
    let server;
    let broadcasts;
    let session;

    beforeEach(function() {
      server = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
      broadcasts = [];
      session = { connections: new Set(['w1']), hookToken: 'htok' };
      server.claudeSessions.set('sid', session);
      server.webSocketConnections.set('w1', {
        ws: { readyState: 1, send: (s) => broadcasts.push(JSON.parse(s)) },
        claudeSessionId: 'sid'
      });
    });

    afterEach(function() {
      if (server && typeof server.dispose === 'function') server.dispose();
      server = null;
    });

    it('keeps the snapshot on the session and tells the browser', function() {
      const res = mockRes();
      server.handleHookEvent(hookReq({ ...SNAPSHOT, hook_event_name: 'ccweb_statusline' }), res);
      assert.deepStrictEqual(res.body, { ok: true });
      assert.strictEqual(session.liveUsage.ctxPct, 6);
      assert.strictEqual(broadcasts.length, 1);
      assert.strictEqual(broadcasts[0].type, 'hook_event');
      assert.strictEqual(broadcasts[0].event, 'ccweb_statusline');
      assert.strictEqual(broadcasts[0].usage.ctxPct, 6);
    });

    it('stays quiet when nothing changed', function() {
      const body = { ...SNAPSHOT, hook_event_name: 'ccweb_statusline' };
      server.handleHookEvent(hookReq(body), mockRes());
      server.handleHookEvent(hookReq(body), mockRes());
      assert.strictEqual(broadcasts.length, 1);
      const more = { ...body, context_window: { ...SNAPSHOT.context_window, used_percentage: 7 } };
      server.handleHookEvent(hookReq(more), mockRes());
      assert.strictEqual(broadcasts.length, 2);
      assert.strictEqual(session.liveUsage.ctxPct, 7);
    });

    it('still refuses a caller that is not this machine', function() {
      const res = mockRes();
      server.handleHookEvent(hookReq({ ...SNAPSHOT, hook_event_name: 'ccweb_statusline' }, '10.0.0.5'), res);
      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(session.liveUsage, undefined);
      assert.strictEqual(broadcasts.length, 0);
    });

    it('survives a restart: the snapshot is persisted with the session', async function() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-sl-'));
      const prev = process.env.CCW_DATA_DIR;
      process.env.CCW_DATA_DIR = dir;
      try {
        const store = new SessionStore();
        const id = '00000001-1111-2222-3333-444444444444';
        const usage = ClaudeCodeWebServer.liveUsageFrom(SNAPSHOT);
        await store.saveSessions(new Map([[id, {
          name: 's', workingDir: '/w', planDirs: [], created: new Date(), lastActivity: new Date(),
          lastAccessed: Date.now(), outputBuffer: [], liveUsage: usage
        }]]));
        const loaded = await store.loadSessions();
        assert.deepStrictEqual(loaded.get(id).liveUsage, usage);
      } finally {
        if (prev === undefined) delete process.env.CCW_DATA_DIR; else process.env.CCW_DATA_DIR = prev;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('bin/cc-statusline.js', function() {
    this.timeout(15000);

    // Runs the relay as Claude would: snapshot on stdin, token in the env.
    function runRelay({ port = 1, userStatusLine } = {}) {
      return new Promise((resolve) => {
        const env = { ...process.env, CCWEB_HOOK_TOKEN: 'htok' };
        delete env.CCWEB_USER_STATUSLINE;
        if (userStatusLine) env.CCWEB_USER_STATUSLINE = userStatusLine;
        const started = Date.now();
        const child = spawn(process.execPath, [RELAY, '--port', String(port), '--session', 'sid'], { env });
        let out = '';
        child.stdout.on('data', (c) => { out += c; });
        child.on('close', (code) => resolve({ code, out, ms: Date.now() - started }));
        child.stdin.end(JSON.stringify(SNAPSHOT));
      });
    }

    let receiver;
    let received;
    beforeEach(async function() {
      received = [];
      receiver = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          received.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
          res.end('{"ok":true}');
        });
      });
      await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
    });
    afterEach(function() { receiver.close(); });

    it('posts the snapshot to this session with the token, marked as ours', async function() {
      const { code, out } = await runRelay({ port: receiver.address().port });
      assert.strictEqual(code, 0);
      assert.strictEqual(out, '', 'no status line of our own');
      assert.strictEqual(received.length, 1);
      assert.strictEqual(received[0].url, '/api/hooks/sid');
      assert.strictEqual(received[0].auth, 'Bearer htok');
      assert.strictEqual(received[0].body.hook_event_name, 'ccweb_statusline');
      assert.strictEqual(received[0].body.context_window.used_percentage, 6);
    });

    it("runs the user's own statusLine on the same snapshot and prints what it prints", async function() {
      // A bare `node` first word runs in PowerShell and sh alike (measured).
      const userStatusLine = `node "${USER_LINE.split(path.sep).join('/')}"`;
      const { code, out } = await runRelay({ port: receiver.address().port, userStatusLine });
      assert.strictEqual(code, 0);
      assert.strictEqual(out.trim(), 'USER-LINE Opus 5.5');
      assert.strictEqual(received.length, 1, 'and still relays');
    });

    it('exits 0 at once when the server is not there', async function() {
      const closed = receiver.address().port;
      receiver.close();
      const { code, out, ms } = await runRelay({ port: closed });
      assert.strictEqual(code, 0);
      assert.strictEqual(out, '');
      assert.ok(ms < 6000, `took ${ms}ms`);
    });
  });

  describe('the injected statusLine', function() {
    const onPlatform = (platform, fn) => {
      const original = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: platform });
      try { return fn(); } finally { Object.defineProperty(process, 'platform', original); }
    };
    const bridge = new ClaudeBridge();
    const wired = { hookScript: '/a/cc-hook.js', statusLineScript: '/a/cc-statusline.js', hookPort: 32353, hookToken: 'tok-xyz' };

    it('is a PowerShell call on Windows, where Claude runs statusLine through PowerShell', function() {
      // Measured on 2.1.304: the exec form is never run, and a quoted path
      // followed by arguments is a PowerShell parse error without `&`.
      const s = onPlatform('win32', () => bridge.buildInjectedSettings("a'b", wired));
      assert.strictEqual(s.statusLine.type, 'command');
      assert.strictEqual(s.statusLine.args, undefined);
      assert.ok(s.statusLine.command.startsWith(`& '${process.execPath}' '/a/cc-statusline.js'`), s.statusLine.command);
      assert.ok(s.statusLine.command.endsWith("--port 32353 --session 'a''b'"), s.statusLine.command);
    });

    it('is a single-quoted line elsewhere', function() {
      const s = onPlatform('linux', () => bridge.buildInjectedSettings("a'b", wired));
      assert.ok(!s.statusLine.command.startsWith('&'));
      assert.ok(s.statusLine.command.includes(`'a'\\''b'`), s.statusLine.command);
    });

    it('never carries the token, and is left out without the relay wiring', function() {
      const s = bridge.buildInjectedSettings('sid', wired);
      assert.ok(!JSON.stringify(s.statusLine).includes('tok-xyz'));
      assert.strictEqual(bridge.buildInjectedSettings('sid', { ...wired, hookToken: '' }).statusLine, undefined);
      assert.strictEqual(bridge.buildInjectedSettings('sid', { ...wired, statusLineScript: '' }).statusLine, undefined);
    });

    it("keeps the user's padding", function() {
      const s = bridge.buildInjectedSettings('sid', { ...wired, userStatusLine: { command: 'x', padding: 2 } });
      assert.strictEqual(s.statusLine.padding, 2);
    });
  });

  describe("finding the user's own statusLine", function() {
    let root;
    beforeEach(function() { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-usl-')); });
    afterEach(function() { fs.rmSync(root, { recursive: true, force: true }); });

    const write = (file, json) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(json));
    };

    it('takes the most specific settings file that sets one', function() {
      const work = path.join(root, 'work');
      const userDir = path.join(root, 'claude');
      write(path.join(userDir, 'settings.json'), { statusLine: { type: 'command', command: 'user' } });
      assert.strictEqual(ClaudeBridge.userStatusLine(work, userDir).command, 'user');
      write(path.join(work, '.claude', 'settings.json'), { statusLine: { type: 'command', command: 'project', padding: 1 } });
      assert.deepStrictEqual(ClaudeBridge.userStatusLine(work, userDir), { command: 'project', padding: 1 });
      write(path.join(work, '.claude', 'settings.local.json'), { statusLine: { type: 'command', command: 'local' } });
      assert.strictEqual(ClaudeBridge.userStatusLine(work, userDir).command, 'local');
    });

    it('has nothing to run when no file sets one, or a file is broken', function() {
      const work = path.join(root, 'work');
      fs.mkdirSync(path.join(work, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(work, '.claude', 'settings.json'), '{ not json');
      assert.strictEqual(ClaudeBridge.userStatusLine(work, path.join(root, 'none')), null);
    });

    it('never runs our own relay as the user\'s', function() {
      const userDir = path.join(root, 'claude');
      write(path.join(userDir, 'settings.json'), { statusLine: { type: 'command', command: "& 'node' '/x/bin/cc-statusline.js' --port 1" } });
      assert.strictEqual(ClaudeBridge.userStatusLine(path.join(root, 'w'), userDir), null);
    });
  });
});
