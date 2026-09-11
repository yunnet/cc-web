const assert = require('assert');
const { ClaudeCodeWebServer } = require('../src/server');
const ClaudeBridge = require('../src/claude-bridge');

// cc-web mints the session id and hands it to `claude --session-id`, then
// re-attaches with `--resume <same id>` forever after. That holds right up until
// Claude starts a new transcript on its own.
//
// `/clear` does exactly that. Measured on Claude Code 2.1.266, driving a real
// PTY: SessionStart fires at startup with the id we asked for, and again after
// `/clear` with source "clear", a FRESH uuid and a new .jsonl. (`/compact` does
// NOT fork on this version — the summary is written into the same file, so that
// case needs nothing.)
//
// Without SessionStart the next `--resume` re-attaches to the pre-clear
// conversation and everything said after the clear is silently dropped.
const CCW_ID = '11111111-1111-4111-8111-111111111111';
const AFTER_CLEAR = '22222222-2222-4222-8222-222222222222';

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; }
  };
}

function mockReq({ sessionId, remote = '127.0.0.1', auth, body }) {
  return {
    params: { sessionId },
    socket: { remoteAddress: remote },
    headers: auth ? { authorization: auth } : {},
    body
  };
}

// The two payloads Claude actually sends, captured from a live run.
const STARTUP = {
  session_id: CCW_ID,
  transcript_path: `/home/u/.claude/projects/-w/${CCW_ID}.jsonl`,
  cwd: '/w',
  hook_event_name: 'SessionStart',
  source: 'startup'
};
const CLEARED = {
  session_id: AFTER_CLEAR,
  transcript_path: `/home/u/.claude/projects/-w/${AFTER_CLEAR}.jsonl`,
  cwd: '/w',
  hook_event_name: 'SessionStart',
  source: 'clear'
};

describe('SessionStart hook: following Claude when it forks its own session', function () {

  describe('the hook is registered at all', function () {
    it('asks Claude for SessionStart with the same relay used for plans', function () {
      const bridge = new ClaudeBridge();
      const s = bridge.buildInjectedSettings(CCW_ID, {
        hookScript: '/x/cc-hook.js', hookPort: 4242, hookToken: 'tok'
      });
      assert.ok(s.hooks && Array.isArray(s.hooks.SessionStart), 'SessionStart must be registered');
      const cmd = s.hooks.SessionStart[0].hooks[0].command;
      assert.strictEqual(cmd, s.hooks.PreToolUse[0].hooks[0].command,
        'one relay script, one command — SessionStart must not invent a second wiring');
      assert.ok(cmd.includes('--port 4242') && cmd.includes(CCW_ID));
    });

    it('registers no hooks at all when the relay is not wired', function () {
      const bridge = new ClaudeBridge();
      const s = bridge.buildInjectedSettings(CCW_ID, {});
      assert.strictEqual(s.hooks, undefined);
    });
  });

  describe('recording what Claude reports', function () {
    let server, broadcasts, saves;

    beforeEach(function () {
      server = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
      broadcasts = [];
      saves = 0;
      server.saveSessionsToDisk = () => { saves++; };
      server.claudeSessions.set(CCW_ID, {
        id: CCW_ID, connections: new Set(['w1']), hookToken: 'htok', claudeStarted: true
      });
      server.webSocketConnections.set('w1', {
        ws: { readyState: 1, send: (s) => broadcasts.push(JSON.parse(s)) },
        claudeSessionId: CCW_ID
      });
    });

    afterEach(function () {
      if (server && typeof server.dispose === 'function') server.dispose();
      server = null;
    });

    const post = (body) => {
      const res = mockRes();
      server.handleHookEvent(mockReq({ sessionId: CCW_ID, auth: 'Bearer htok', body }), res);
      return res;
    };

    it('follows Claude to the conversation it moved to after /clear', function () {
      post(STARTUP);
      assert.strictEqual(server.resumeIdFor(server.claudeSessions.get(CCW_ID)), CCW_ID);

      post(CLEARED);
      assert.strictEqual(server.resumeIdFor(server.claudeSessions.get(CCW_ID)), AFTER_CLEAR,
        'after /clear a restart must resume the NEW conversation, not the pre-clear one');
    });

    it('persists the move, so it survives a server restart', function () {
      post(STARTUP);
      const afterFirst = saves;
      post(STARTUP);
      assert.strictEqual(saves, afterFirst, 'a repeated, unchanged id must not rewrite the session file');
      post(CLEARED);
      assert.strictEqual(saves, afterFirst + 1, 'an actual move must be persisted');
    });

    it('tells the browser which conversation it is now looking at', function () {
      post(CLEARED);
      const ev = broadcasts[broadcasts.length - 1];
      assert.strictEqual(ev.type, 'hook_event');
      assert.strictEqual(ev.event, 'SessionStart');
      assert.strictEqual(ev.claudeSessionId, AFTER_CLEAR);
      assert.strictEqual(ev.source, 'clear');
    });

    it('ignores a payload with no usable id rather than losing the one it has', function () {
      post(CLEARED);
      post({ hook_event_name: 'SessionStart', source: 'startup' });
      post({ hook_event_name: 'SessionStart', session_id: 'not-a-uuid' });
      assert.strictEqual(server.resumeIdFor(server.claudeSessions.get(CCW_ID)), AFTER_CLEAR);
    });

    it('leaves the plan relay alone', function () {
      const res = post({ hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: { plan: '# p' } });
      assert.strictEqual(res.statusCode, 200);
      const ev = broadcasts[broadcasts.length - 1];
      assert.strictEqual(ev.tool_input.plan, '# p');
      assert.strictEqual(ev.claudeSessionId, undefined,
        'only SessionStart carries a conversation id — do not bolt it onto every event');
    });

    it('keeps one conversation in one tab after the fork', function () {
      post(CLEARED);
      // The post-clear conversation now shows up in the history list. Opening it
      // would put a second Claude on a transcript this tab is already writing to.
      assert.strictEqual(server.sessionHoldingConversation(AFTER_CLEAR), CCW_ID);
      assert.strictEqual(server.sessionHoldingConversation(CCW_ID), CCW_ID);
      assert.strictEqual(server.sessionHoldingConversation('33333333-3333-4333-8333-333333333333'), null);
    });
  });

  describe('resumeIdFor', function () {
    let server;
    beforeEach(function () { server = new ClaudeCodeWebServer({ noAuth: true, folderMode: false }); });
    afterEach(function () { if (server && server.dispose) server.dispose(); server = null; });

    it('falls back to the cc-web id when Claude has not reported yet', function () {
      assert.strictEqual(server.resumeIdFor({ id: CCW_ID }), CCW_ID);
    });

    it('refuses a junk value instead of handing it to --resume', function () {
      assert.strictEqual(server.resumeIdFor({ id: CCW_ID, claudeConversationId: '../../etc' }), CCW_ID);
    });
  });
});
