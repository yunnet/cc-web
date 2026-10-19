const assert = require('assert');
const { ClaudeCodeWebServer } = require('../src/server');

// Same doubles as hook-endpoint.test.js: minimal req/res around handleHookEvent.
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

describe('web permission card (ccweb-companion mod relay)', function() {
  let server;
  let broadcasts;

  beforeEach(function() {
    server = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
    broadcasts = [];
    server.claudeSessions.set('sid', { connections: new Set(['w1']), hookToken: 'htok' });
    server.webSocketConnections.set('w1', {
      ws: { readyState: 1, send: (s) => broadcasts.push(JSON.parse(s)) },
      claudeSessionId: 'sid'
    });
  });

  afterEach(function() {
    if (server && typeof server.dispose === 'function') server.dispose();
    server = null;
  });

  const REQUEST = {
    hook_event_name: 'ccweb_permission_request',
    call_id: 'call-1',
    tool: 'Bash',
    command: 'rm -rf /tmp/scratch'
  };

  it('holds the mod POST open and broadcasts the card to the browser', async function() {
    const res = mockRes();
    const held = server.handleHookEvent(mockReq({ sessionId: 'sid', auth: 'Bearer htok', body: REQUEST }), res);

    // Held, not answered at once…
    assert.ok(held instanceof Promise);
    assert.strictEqual(res.body, null);
    // …but already on the browser's screen.
    assert.strictEqual(broadcasts.length, 1);
    assert.strictEqual(broadcasts[0].event, 'ccweb_permission_request');
    assert.strictEqual(broadcasts[0].call_id, 'call-1');
    assert.strictEqual(broadcasts[0].tool_input.command, 'rm -rf /tmp/scratch');

    const answerRes = mockRes();
    server.answerPermissionRequest(
      mockReq({ sessionId: 'sid', body: { call_id: 'call-1', decision: 'allow' } }),
      answerRes
    );
    await held;
    assert.deepStrictEqual(res.body, { decision: 'allow' });
    assert.deepStrictEqual(answerRes.body, { ok: true });
    assert.strictEqual(server.pendingPermissionRequests.size, 0);
  });

  it('delivers the pressed decision to the held mod POST', async function() {
    const res = mockRes();
    const held = server.handleHookEvent(mockReq({ sessionId: 'sid', auth: 'Bearer htok', body: REQUEST }), res);
    const answerRes = mockRes();
    server.answerPermissionRequest(
      mockReq({ sessionId: 'sid', body: { call_id: 'call-1', decision: 'deny' } }),
      answerRes
    );
    await held;
    assert.deepStrictEqual(res.body, { decision: 'deny' });
    assert.deepStrictEqual(answerRes.body, { ok: true });
  });

  it('answers an unknown or timed-out callId without touching anything', function() {
    const res = mockRes();
    server.answerPermissionRequest(
      mockReq({ sessionId: 'sid', body: { call_id: 'ghost', decision: 'allow' } }),
      res
    );
    assert.deepStrictEqual(res.body, { ok: false, error: 'no such pending request (timeout?)' });
  });

  it('rejects answers with a bad decision', function() {
    const res = mockRes();
    server.answerPermissionRequest(
      mockReq({ sessionId: 'sid', body: { call_id: 'x', decision: 'maybe' } }),
      res
    );
    assert.strictEqual(res.statusCode, 400);
  });
});
