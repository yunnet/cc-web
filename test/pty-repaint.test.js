const assert = require('assert');
const { ClaudeCodeWebServer } = require('../src/server');

// Claude draws its input box and status line at the LAST rows of the pty. A
// client that joins with a different row count than Claude last laid out for
// sees nothing there — reported repeatedly as "the input box border and the
// status bar are gone", and measured live: pty 49 rows, Claude addressing row
// 49, browser 45 rows.
//
// Asking Claude to redraw is not enough: it would repaint from the same stale
// idea of the size. A resize round-trip (SIGWINCH twice) is what makes it
// re-read the terminal and recompute the layout.
const SESSION_ID = 'b2eb18c9-d0b4-4264-9735-d60baa516a3a';

describe('repaint after joining a session', function () {
  let server, resizes;

  beforeEach(function () {
    server = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
    resizes = [];
    server.claudeBridge.resize = async (id, cols, rows) => { resizes.push([cols, rows]); };
    server.claudeSessions.set(SESSION_ID, {
      id: SESSION_ID, name: 't', active: true, connections: new Set(),
      outputBuffer: [], maxBufferSize: 1000, created: new Date(), lastActivity: new Date()
    });
  });

  afterEach(function () {
    if (server && typeof server.dispose === 'function') server.dispose();
    server = null;
  });

  const attach = (wsId, cols, rows) => {
    const s = server.claudeSessions.get(SESSION_ID);
    server.webSocketConnections.set(wsId, { ws: {}, claudeSessionId: SESSION_ID });
    s.connections.add(wsId);
    server.recordClientSize(wsId, cols, rows);
  };
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));

  it('nudges the size down one row and back', async function () {
    attach('pc', 173, 45);
    server.scheduleRepaint(server.claudeSessions.get(SESSION_ID));
    await settle(600);
    assert.deepStrictEqual(resizes, [[173, 44], [173, 45]],
      'expected a round trip to rows-1 and back');
  });

  it('coalesces several joins into one repaint', async function () {
    // Reconnecting devices and tab switches arrive in bursts; repainting per
    // event would make Claude redraw its whole UI several times over.
    attach('pc', 173, 45);
    const s = server.claudeSessions.get(SESSION_ID);
    server.scheduleRepaint(s);
    server.scheduleRepaint(s);
    server.scheduleRepaint(s);
    await settle(600);
    assert.strictEqual(resizes.length, 2, `one round trip, got ${resizes.length} resizes`);
  });

  it('repaints at the negotiated size, not one client\'s', async function () {
    // The pty belongs to every attached device; a repaint must not quietly
    // resize it to whoever happened to trigger the repaint.
    attach('pc', 250, 49);
    attach('phone', 48, 44);
    server.scheduleRepaint(server.claudeSessions.get(SESSION_ID));
    await settle(600);
    assert.deepStrictEqual(resizes, [[48, 43], [48, 44]]);
  });

  it('does nothing when Claude is not running', async function () {
    server.claudeSessions.get(SESSION_ID).active = false;
    attach('pc', 173, 45);
    server.scheduleRepaint(server.claudeSessions.get(SESSION_ID));
    await settle(600);
    assert.deepStrictEqual(resizes, []);
  });

  it('does nothing when no client has reported a size', async function () {
    const s = server.claudeSessions.get(SESSION_ID);
    server.webSocketConnections.set('joining', { ws: {}, claudeSessionId: SESSION_ID });
    s.connections.add('joining');
    server.scheduleRepaint(s);
    await settle(600);
    assert.deepStrictEqual(resizes, []);
  });

  it('is scheduled when a client joins an active session', async function () {
    attach('pc', 173, 45);
    server.sendToWebSocket = () => {};
    server.webSocketConnections.set('ws2', { ws: {}, claudeSessionId: null });
    await server.joinClaudeSession('ws2', SESSION_ID);
    await settle(700);
    assert.ok(resizes.length >= 2, 'joining an active session should have triggered a repaint');
  });
});
