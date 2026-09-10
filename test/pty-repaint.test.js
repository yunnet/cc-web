const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ClaudeCodeWebServer } = require('../src/server');

// Joining a session must NOT manufacture a resize.
//
// This file used to assert the opposite. v4.6.3 nudged the pty down one row and
// back on every join, because Claude's FULLSCREEN renderer drew its input box
// and status line at the last rows of the pty: a client joining with a
// different row count saw nothing there, reported over and over as "the input
// box border and the status bar are gone", and only a SIGWINCH round-trip made
// Claude recompute the layout.
//
// v4.8.0 forced the classic renderer, which draws that UI inline with the
// conversation rather than at fixed rows, so the failure the nudge existed for
// cannot happen any more — and the nudge's side effect became the visible bug:
// the replay draws Claude's UI block, the fake resize makes Claude print a
// FRESH block below it, and the user gets two input boxes with only the lower
// one live. Measured in the browser, instrumented per write:
//
//   96ms   replay written (49782 bytes)  -> 1 status bar
//   280ms  resize sent
//   375ms  Claude's repaint arrives (2921 bytes)
//   391ms  written                        -> 2 status bars
//
// A real size change still repaints, and still leaves the old block above it —
// that is what a native terminal does too, and it only happens when the size
// actually changed. What is gone is cc-web inventing a size change on a join
// where nothing changed.
const SESSION_ID = 'b2eb18c9-d0b4-4264-9735-d60baa516a3a';

describe('joining a session does not force a repaint', function () {
  let server, resizes;

  beforeEach(function () {
    server = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
    resizes = [];
    server.claudeBridge.resize = async (id, cols, rows) => { resizes.push([cols, rows]); };
    server.claudeSessions.set(SESSION_ID, {
      id: SESSION_ID, name: 't', active: true, connections: new Set(),
      outputBuffer: [], maxBufferSize: 1000, created: new Date(), lastActivity: new Date()
    });
    server.sendToWebSocket = () => {};
  });

  afterEach(function () {
    if (server && typeof server.dispose === 'function') server.dispose();
    server = null;
  });

  const settle = (ms) => new Promise((r) => setTimeout(r, ms));

  it('sends no resize at all when a client joins', async function () {
    server.webSocketConnections.set('ws1', { ws: {}, claudeSessionId: null });
    server.recordClientSize('ws1', 120, 40);

    await server.joinClaudeSession('ws1', SESSION_ID);
    // Longer than the old 300ms deferral, so a surviving timer would show up.
    await settle(500);

    assert.deepStrictEqual(resizes, [],
      `joining must not resize the pty; got ${JSON.stringify(resizes)}`);
  });

  it('has no repaint machinery left to fire', function () {
    // Belt and braces: the timer used to outlive the session it belonged to and
    // had to be cancelled on close. Neither the scheduler nor the timer should
    // exist any more, so a future edit cannot resurrect the duplicate by
    // calling something that is still lying around.
    const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
    assert.ok(!/scheduleRepaint/.test(SRC), 'scheduleRepaint should be gone');
    assert.ok(!/repaintTimer/.test(SRC), 'repaintTimer should be gone');
  });

  it('still applies a real size change', async function () {
    // The negotiated size must still reach the pty — dropping the fake resize
    // must not drop the real one, or a joining client with a smaller window
    // would be left with Claude laid out for someone else's screen.
    const s = server.claudeSessions.get(SESSION_ID);
    server.webSocketConnections.set('ws1', { ws: {}, claudeSessionId: SESSION_ID });
    s.connections.add('ws1');
    server.recordClientSize('ws1', 120, 40);
    resizes.length = 0;

    await server.negotiatePtySize(s);

    assert.deepStrictEqual(resizes, [[120, 40]]);
  });
});
