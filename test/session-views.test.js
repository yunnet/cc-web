const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ClaudeCodeWebServer } = require('../src/server');

// One terminal per open tab, kept alive in the background.
//
// Switching tabs used to call joinSession(), which reset the terminal and
// replayed the server's buffer — throwing away the scrollback the browser had
// built. That is why history vanished the moment you came back to a tab, and it
// could not be replayed back either: the server keeps a rolling window of raw
// chunks, and most of those are Claude's in-place repaint frames (measured on a
// live session: 500 chunks, only 136 distinct, reconstructing to 39 lines).
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

describe('per-tab terminals', function () {
  const APP = read('src', 'public', 'app.js');
  const MANAGER = read('src', 'public', 'session-manager.js');
  const CSS = read('src', 'public', 'style.css');

  it('switches tabs by showing a view, not by re-joining', function () {
    // The load-bearing line. joinSession is the path that resets and replays.
    const handler = MANAGER.slice(MANAGER.indexOf('async switchToTab('));
    const body = handler.slice(0, handler.indexOf('\n    }'));
    assert.ok(/app\.showSession\(sessionId\)/.test(body), 'switchToTab must call showSession');
    assert.ok(!/app\.joinSession\(/.test(body),
      'switchToTab must not join — joining resets the terminal and drops the scrollback');
  });

  it('keeps a view per session rather than one shared terminal', function () {
    assert.ok(/this\.views = new Map\(\)/.test(APP), 'views must be keyed by session');
    assert.ok(/buildView\(sessionId\)/.test(APP), 'a view factory must exist');
    assert.ok(/adoptView\(view\)/.test(APP),
      'the app must be able to point this.terminal/socket at a view');
  });

  it('gives each view its own socket, so a background tab keeps receiving', function () {
    // Without its own socket a background session's output never arrives, and
    // coming back would need a replay again — which is the bug.
    assert.ok(/openViewSocket\(view\)/.test(APP));
    assert.ok(/view\.socket = sock/.test(APP));
  });

  it('shows a view without resetting or replaying it', function () {
    const i = APP.indexOf('async showSession(sessionId)');
    assert.ok(i > 0, 'showSession must exist');
    const body = APP.slice(i, APP.indexOf('\n    }', i));
    assert.ok(!/\.reset\(\)/.test(body), 'showing an existing view must not reset it');
    assert.ok(/isNew/.test(body), 'only a brand-new view may connect and replay');
  });

  it('withdraws the outgoing view\'s size vote', function () {
    // The pty runs at the minimum across attached clients, so a hidden view
    // holding a stale size would pin the pty smaller than the window.
    assert.ok(/detach_size/.test(APP), 'the client must send detach_size on the way out');
    const SERVER = read('src', 'server.js');
    assert.ok(/case 'detach_size'/.test(SERVER), 'the server must handle it');
    assert.ok(/detachClientSize\(wsId\)/.test(SERVER), 'and route it to detachClientSize');
  });

  it('routes output to the view that owns the session', function () {
    assert.ok(/queueTerminalWrite\(filteredData, view\)/.test(APP),
      'output must land in its own view, not in whatever is on screen');
    assert.ok(/queueTerminalWrite\(data, view = this\.activeView\)/.test(APP),
      'the write queue must be per view');
  });

  it('stacks the views and shows only the active one', function () {
    assert.ok(/\.terminal-view\s*\{[\s\S]*?display:\s*none/.test(CSS));
    assert.ok(/\.terminal-view\.active\s*\{[\s\S]*?display:\s*block/.test(CSS));
  });

  it('lets the visible view carry its height again while the keyboard is open', function () {
    // The stack is absolutely positioned, and an absolutely positioned child
    // contributes no height to its parent. The soft-keyboard mode works by
    // letting the grid grow taller than the frame and scrolling the frame — so
    // with the views stacked, #terminal collapsed, the frame had nothing to
    // scroll, and the bottom of the grid (where Claude draws the input box) was
    // clipped away. Reported as "typing on my phone hides the input box".
    assert.ok(/\.terminal-container\.kb-open\s+\.terminal-view\.active\s*\{[\s\S]*?position:\s*static/.test(CSS),
      'the active view must leave the absolute stack while the keyboard is open');
  });
});

describe('detach_size on the server', function () {
  const SESSION_ID = 'b2eb18c9-d0b4-4264-9735-d60baa516a3a';
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

  it('stops a detached client from holding the pty small', async function () {
    // The exact shape of the bug: a background tab whose window has since grown.
    attach('ws-visible', 200, 50);
    attach('ws-hidden', 100, 24);
    const session = server.claudeSessions.get(SESSION_ID);

    await server.negotiatePtySize(session);
    assert.deepStrictEqual(resizes.at(-1), [100, 24], 'the minimum wins while both vote');

    await server.detachClientSize('ws-hidden');
    assert.deepStrictEqual(resizes.at(-1), [200, 50],
      'once the hidden client withdraws, the visible one gets its full size');
  });

  it('lets a returning client vote again', async function () {
    attach('ws-a', 200, 50);
    attach('ws-b', 100, 24);
    await server.detachClientSize('ws-b');
    resizes.length = 0;

    server.recordClientSize('ws-b', 120, 30);
    await server.negotiatePtySize(server.claudeSessions.get(SESSION_ID));
    assert.deepStrictEqual(resizes.at(-1), [120, 30]);
  });
});
