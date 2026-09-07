const assert = require('assert');
const { ClaudeCodeWebServer } = require('../src/server');

// A session can be open on several devices at once. Each client used to force
// the shared PTY to its own size on join, so the last one to arrive won and
// every other device was left mismatched — and a device whose terminal has
// fewer rows than the PTY never sees Claude's bottom rows at all, because it
// draws its input box and status line at absolute row numbers that do not
// exist there. Measured on a live install: PTY 49x250, browser 45 rows, input
// box addressed at row 46 and the status line at row 49. Both invisible.
//
// The smallest attached client now defines the canvas, the way tmux does it.
const SESSION_ID = 'b2eb18c9-d0b4-4264-9735-d60baa516a3a';

describe('shared PTY size negotiation', function () {
  let server;
  let resizes;

  beforeEach(function () {
    server = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
    resizes = [];
    server.claudeBridge.resize = async (id, cols, rows) => { resizes.push({ id, cols, rows }); };
    server.claudeSessions.set(SESSION_ID, {
      id: SESSION_ID, name: 'test', active: true,
      connections: new Set(), outputBuffer: [], maxBufferSize: 1000,
      created: new Date(), lastActivity: new Date()
    });
  });

  afterEach(function () {
    if (server && typeof server.dispose === 'function') server.dispose();
    server = null;
  });

  // Attach a client and tell the server how big its terminal is.
  const attach = (wsId, cols, rows) => {
    const session = server.claudeSessions.get(SESSION_ID);
    server.webSocketConnections.set(wsId, { ws: {}, claudeSessionId: SESSION_ID });
    session.connections.add(wsId);
    if (cols) server.recordClientSize(wsId, cols, rows);
  };

  it('sizes the PTY to the one client when only one is attached', async function () {
    attach('pc', 173, 45);
    await server.negotiatePtySize(server.claudeSessions.get(SESSION_ID));
    assert.deepStrictEqual(resizes.pop(), { id: SESSION_ID, cols: 173, rows: 45 });
  });

  it('takes the smallest of every attached client, per axis', async function () {
    // The phone is narrow, the laptop is short. Neither alone is the answer:
    // the canvas has to fit inside both or one of them loses rows or columns.
    attach('pc', 250, 49);
    attach('phone', 48, 60);
    attach('laptop', 120, 40);
    await server.negotiatePtySize(server.claudeSessions.get(SESSION_ID));
    assert.deepStrictEqual(resizes.pop(), { id: SESSION_ID, cols: 48, rows: 40 });
  });

  it('grows back when the small client leaves', async function () {
    // The bug this prevents: closing the phone used to leave the desktop stuck
    // at phone size until something else happened to trigger a resize.
    attach('pc', 250, 49);
    attach('phone', 48, 44);
    await server.negotiatePtySize(server.claudeSessions.get(SESSION_ID));
    assert.deepStrictEqual(resizes.pop(), { id: SESSION_ID, cols: 48, rows: 44 });

    await server.detachClientSize('phone');
    assert.deepStrictEqual(resizes.pop(), { id: SESSION_ID, cols: 250, rows: 49 },
      'the desktop should get its full size back');
  });

  it('ignores a client that has not reported a size yet', async function () {
    // A connection exists from the moment it joins, but its size arrives a beat
    // later. Counting it as zero would collapse the PTY for everyone.
    attach('pc', 173, 45);
    attach('joining', null, null);
    await server.negotiatePtySize(server.claudeSessions.get(SESSION_ID));
    assert.deepStrictEqual(resizes.pop(), { id: SESSION_ID, cols: 173, rows: 45 });
  });

  it('does not resize when nothing changed', async function () {
    // Claude repaints its whole UI on every resize. Re-sending the same size on
    // each join would make one device's reconnect flicker every other device.
    attach('pc', 173, 45);
    await server.negotiatePtySize(server.claudeSessions.get(SESSION_ID));
    assert.strictEqual(resizes.length, 1);
    await server.negotiatePtySize(server.claudeSessions.get(SESSION_ID));
    assert.strictEqual(resizes.length, 1, 'a second call with no change must be a no-op');
  });

  it('counts a client whose only size ever came from start_claude', async function () {
    // The gap that made the first end-to-end run still fail. A client that
    // creates a session sends its size on start_claude and may never send a
    // `resize` at all; if that size is not recorded, the client is invisible to
    // the negotiation and the next, bigger client grows the pty past what it
    // can display — which is the original bug, unfixed.
    const session = server.claudeSessions.get(SESSION_ID);
    server.webSocketConnections.set('creator', { ws: {}, claudeSessionId: SESSION_ID });
    session.connections.add('creator');
    server.claudeBridge.startSession = async () => ({});
    await server.startClaude('creator', {}, 48, 44).catch(() => {});

    attach('pc', 250, 49);
    await server.negotiatePtySize(session);
    assert.deepStrictEqual(resizes.pop(), { id: SESSION_ID, cols: 48, rows: 44 },
      "the creator's size must constrain the canvas even without a resize message");
  });

  it('leaves an inactive session alone', async function () {
    server.claudeSessions.get(SESSION_ID).active = false;
    attach('pc', 173, 45);
    await server.negotiatePtySize(server.claudeSessions.get(SESSION_ID));
    assert.strictEqual(resizes.length, 0, 'nothing to resize when Claude is not running');
  });

  it('refuses sizes that are not usable numbers', async function () {
    attach('pc', 173, 45);
    for (const [c, r] of [[0, 45], [173, 0], [-5, 45], ['80', 24], [NaN, 24], [null, null]]) {
      server.recordClientSize('bad', c, r);
    }
    await server.negotiatePtySize(server.claudeSessions.get(SESSION_ID));
    assert.deepStrictEqual(resizes.pop(), { id: SESSION_ID, cols: 173, rows: 45 },
      'garbage from one client must not shrink the canvas');
  });
});
