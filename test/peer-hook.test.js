const assert = require('assert');
const fs = require('fs');
const { ClaudeCodeWebServer } = require('../src/server');
const { useTempDataDir } = require('./helpers/auth');

// The ccweb-companion mod's reports through /api/hooks/:sessionId, end to end
// on the server: two sessions hand a task back and forth, every step reaches
// the owner's browsers, and nothing crosses to another owner.
function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; }
  };
}

describe('peer threads through the hook endpoint', function () {
  let server;
  let dir;
  let seen;

  const session = (id, name, ownerId = null) => {
    server.claudeSessions.set(id, { id, name, ownerId, hookToken: 'tok-' + id, connections: new Set(), active: true });
  };
  const post = (sessionId, body) => {
    const res = mockRes();
    server.handleHookEvent({ params: { sessionId }, socket: { remoteAddress: '127.0.0.1' }, headers: { authorization: 'Bearer tok-' + sessionId }, body }, res);
    return res.body;
  };

  beforeEach(function () {
    server = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
    dir = useTempDataDir(server);
    seen = [];
    // One browser socket of the unowned user, showing some other task.
    server.webSocketConnections.set('w1', { ws: { readyState: 1, send: (s) => seen.push(JSON.parse(s)) }, claudeSessionId: 'elsewhere', userId: null });
    session('A', 'alpha');
    session('B', 'beta');
  });

  afterEach(function () {
    if (server && typeof server.dispose === 'function') server.dispose();
    server = null;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('answers the send with a thread id and walks the chain to the reply', function () {
    const answer = post('A', { hook_event_name: 'ccweb_peer_send', to: 'beta', text: 'fix PMS\nsrc/a.js:12' });
    assert.strictEqual(answer.ok, true);
    assert.match(answer.threadId, /^t[0-9a-f]{12}$/);
    const id = answer.threadId;
    post('A', { hook_event_name: 'ccweb_peer_sent', threadId: id, isDelivered: true });
    post('A', { hook_event_name: 'ccweb_peer_msgid', threadId: id, msgId: '50737AF5-c725-439f-a4e1-bf45db4f1137', notifyWhenIdle: true });
    post('B', { hook_event_name: 'ccweb_peer_receive', origin: 'peer', threadId: id, text: '<cross-session-message from="uds:pipe-a" from-name="alpha" from-mode="prompting">\nfix PMS\nsrc/a.js:12\n</cross-session-message>' });
    post('A', { hook_event_name: 'ccweb_peer_notice', msgId: '50737af5-c725-439f-a4e1-bf45db4f1137', text: '[Cross-session delivery notice] Your message to another session was held by that session (recipient: x; msg_id: 50737af5-c725-439f-a4e1-bf45db4f1137).' });
    assert.strictEqual(seen[seen.length - 1].thread.status, 'held');
    post('B', { hook_event_name: 'ccweb_peer_processing', origin: 'peer' });
    post('B', { hook_event_name: 'Stop', last_assistant_message: 'done' });
    const reply = post('B', { hook_event_name: 'ccweb_peer_send', to: 'uds:pipe-a', text: 'changed 2 files' });
    assert.strictEqual(reply.threadId, id, 'the reply joins the thread');

    const t = server.tenant(null).peerThreads.get(id);
    assert.strictEqual(t.status, 'replied');
    assert.strictEqual(t.toSessionId, 'B');
    assert.strictEqual(t.fromAddress, 'uds:pipe-a');
    assert.deepStrictEqual(t.replies.map((r) => r.text), ['changed 2 files']);
    // Every step went to the owner's socket, even though it shows another task.
    const steps = seen.filter((m) => m.event === 'ccweb_peer_thread').map((m) => m.thread.status);
    assert.deepStrictEqual([...new Set(steps)], ['sent', 'delivered', 'held', 'processing', 'idle', 'replied']);
  });

  it('keeps one owner\'s threads and targets away from another', function () {
    session('C', 'beta', 'u2'); // same name as B, other owner
    server.webSocketConnections.set('w2', { ws: { readyState: 1, send: (s) => seen.push({ other: JSON.parse(s) }) }, claudeSessionId: 'C', userId: 'u2' });
    const { threadId } = post('A', { hook_event_name: 'ccweb_peer_send', to: 'beta', text: 'secret work' });
    assert.strictEqual(server.tenant(null).peerThreads.get(threadId).toSessionId, 'B', 'resolved among A\'s owner\'s sessions only');
    // The other owner's session receiving it keeps its own copy, without A's.
    post('C', { hook_event_name: 'ccweb_peer_receive', origin: 'peer', threadId, text: 'secret work' });
    const theirs = server.tenant('u2').peerThreads.get(threadId);
    assert.strictEqual(theirs.fromSessionId, null);
    assert.strictEqual(server.tenant(null).peerThreads.get(threadId).status, 'sent', 'u2\'s report did not touch u1\'s thread');
    assert.ok(seen.filter((m) => m.other).every((m) => !m.other.thread || m.other.thread.fromSessionId !== 'A'));
  });

  it('a broken report answers ok:false instead of failing the request', function () {
    server.tenant(null).peerThreads.beginSend = () => { throw new Error('boom'); };
    assert.deepStrictEqual(post('A', { hook_event_name: 'ccweb_peer_send', to: 'beta', text: 'x' }), { ok: false });
  });

  it('GET /api/peer-threads lists the caller\'s threads, refuses another owner\'s session', function () {
    post('A', { hook_event_name: 'ccweb_peer_send', to: 'beta', text: 'x' });
    const res = mockRes();
    server.listPeerThreads({ query: { sessionId: 'B' }, user: null }, res);
    assert.strictEqual(res.body.threads.length, 1);
    session('D', 'delta', 'u2');
    const other = mockRes();
    server.listPeerThreads({ query: { sessionId: 'D' }, user: null }, other);
    assert.strictEqual(other.statusCode, 404);
  });
});
