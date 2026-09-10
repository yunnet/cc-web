const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ClaudeCodeWebServer } = require('../src/server');
const SessionStore = require('../src/utils/session-store');

// How much terminal history survives an F5 — the only case that still needs a
// replay, now that a live tab keeps its own terminal across switches.
//
// The unit is BYTES. It used to be chunks, which could not express the thing
// being configured: a chunk is whatever one read off the pty returned, and
// measured on a live session 500 of them came to 50 KB, only 136 distinct, and
// replayed back to 39 lines. "Keep 2 MB" would have been twenty thousand chunks,
// four times the old maximum.
//
// One setting still drives all three places — persist, replay, memory — because
// raising only the persist cap changes nothing a user can see.
function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; }
  };
}

const SESSION_ID = 'b2eb18c9-d0b4-4264-9735-d60baa516a3a';

describe('scrollback chunk setting', function () {
  let dataDir;
  let prevEnv;
  let server;

  beforeEach(function () {
    prevEnv = process.env.CCW_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-sb-'));
    process.env.CCW_DATA_DIR = dataDir;
    server = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
  });

  afterEach(function () {
    if (server && typeof server.dispose === 'function') server.dispose();
    server = null;
    if (prevEnv === undefined) delete process.env.CCW_DATA_DIR;
    else process.env.CCW_DATA_DIR = prevEnv;
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  });

  const chunks = (n) => Array.from({ length: n }, (_, i) => `chunk-${i}\r\n`);

  const fakeSession = (buffer) => ({
    name: 'test',
    created: new Date(),
    lastActivity: new Date(),
    workingDir: dataDir,
    planDirs: [],
    claudeStarted: true,
    outputBuffer: buffer,
    connections: new Set(),
    active: false
  });

  it('defaults to 2 MB, enough for an F5 to land on real history', function () {
    const res = mockRes();
    server.getScrollback({}, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.bytes, 2 * 1024 * 1024);
    assert.strictEqual(res.body.default, 2 * 1024 * 1024);
    assert.strictEqual(server.sessionStore.maxOutputChunks, 2 * 1024 * 1024);
  });

  it('trims the persisted buffer to the configured size', function () {
    const store = new SessionStore();
    const all = chunks(600);
    const tail = all.slice(-100);
    store.maxOutputChunks = tail.reduce((n, c) => n + Buffer.byteLength(c), 0);
    const record = store.toRecord(SESSION_ID, fakeSession(all));
    assert.strictEqual(record.outputBuffer.length, 100);
    // The TAIL is what matters — keeping the oldest would preserve output nobody
    // is looking at and drop what you were just reading.
    assert.strictEqual(record.outputBuffer[99], 'chunk-599\r\n');
  });

  it('replays the configured size, not a hard-coded ceiling', async function () {
    // The one that fails if only the persist cap is raised. Replay is what the
    // browser actually receives, so a setting that does not move it is a lie.
    const sent = [];
    const wanted = chunks(600).slice(-500).reduce((n, c) => n + Buffer.byteLength(c), 0);
    // Set the budget directly: setScrollbackChunks would clamp this far below
    // the 256 KB minimum, and what is under test here is replaySlice honouring
    // whatever budget it is given.
    server.sessionStore.maxOutputChunks = wanted;
    server.claudeSessions.set(SESSION_ID, fakeSession(chunks(600)));
    server.webSocketConnections.set('ws1', { ws: {}, claudeSessionId: null });
    server.sendToWebSocket = (_ws, msg) => sent.push(msg);

    await server.joinClaudeSession('ws1', SESSION_ID);

    const joined = sent.find((m) => m.type === 'session_joined');
    assert.ok(joined, 'expected a session_joined message');
    assert.strictEqual(joined.outputBuffer.length, 500);
    assert.strictEqual(joined.outputBuffer[499], 'chunk-599\r\n');
    const bytes = joined.outputBuffer.reduce((n, c) => n + Buffer.byteLength(c), 0);
    assert.ok(bytes <= wanted, `replay ${bytes} over the ${wanted} budget`);
  });

  it('keeps the in-memory buffer able to hold what it must persist', function () {
    // Persisting N bytes is impossible if memory drops the chunks first. The
    // memory cap is still a chunk count (it is what the live buffer trims by),
    // sized from the byte budget.
    server.setScrollbackChunks(4 * 1024 * 1024);
    const chunksNeeded = Math.ceil((4 * 1024 * 1024) / 100);
    assert.ok(server.maxBufferSize() >= chunksNeeded,
      `memory cap ${server.maxBufferSize()} < ${chunksNeeded}`);
    // Existing sessions must be raised too, not just ones created later.
    const session = fakeSession(chunks(10));
    session.maxBufferSize = 1000;
    server.claudeSessions.set(SESSION_ID, session);
    server.setScrollbackChunks(8 * 1024 * 1024);
    assert.ok(session.maxBufferSize > 1000, `live session cap ${session.maxBufferSize} not raised`);
  });

  it('bounds the replay by bytes, not just by chunk count', async function () {
    // The chunk cap alone let the reconnect payload scale to ~1.75 MB at the
    // maximum setting (measured against real sessions), from 89 KB before this
    // feature. joinClaudeSession runs on EVERY reconnect, for every device on
    // the session, and serialises on the shared event loop.
    const sent = [];
    server.setScrollbackChunks(512 * 1024);
    const fat = Array.from({ length: 5000 }, (_, i) => `${i}:${'x'.repeat(400)}\r\n`);
    server.claudeSessions.set(SESSION_ID, fakeSession(fat));
    server.webSocketConnections.set('ws1', { ws: {}, claudeSessionId: null });
    server.sendToWebSocket = (_ws, msg) => sent.push(msg);

    await server.joinClaudeSession('ws1', SESSION_ID);

    const replay = sent.find((m) => m.type === 'session_joined').outputBuffer;
    const bytes = replay.reduce((n, c) => n + Buffer.byteLength(c), 0);
    assert.ok(bytes <= 512 * 1024, `replay is ${bytes} bytes, over the configured 512 KB`);
    assert.ok(replay.length < 5000, 'the budget should have bound before the whole buffer');
    // Still the NEWEST output: a ceiling that kept the head would be worse than
    // no ceiling at all.
    assert.strictEqual(replay[replay.length - 1], fat[4999]);
  });

  it('replays the whole buffer when the budget covers it', async function () {
    // There is no separate chunk cap any more — one budget, in bytes.
    const sent = [];
    const all = chunks(600);
    server.setScrollbackChunks(all.reduce((n, c) => n + Buffer.byteLength(c), 0) + 1024);
    server.claudeSessions.set(SESSION_ID, fakeSession(all));
    server.webSocketConnections.set('ws1', { ws: {}, claudeSessionId: null });
    server.sendToWebSocket = (_ws, msg) => sent.push(msg);

    await server.joinClaudeSession('ws1', SESSION_ID);

    const replay = sent.find((m) => m.type === 'session_joined').outputBuffer;
    assert.strictEqual(replay.length, 600, 'nothing should be dropped under budget');
  });

  it('still sends a single chunk that is bigger than the whole ceiling', async function () {
    // Truncating to nothing would turn one huge burst of output into a blank
    // terminal, which is the failure the ceiling is supposed to prevent.
    const sent = [];
    const huge = 'y'.repeat(ClaudeCodeWebServer.SCROLLBACK_REPLAY_MAX_BYTES * 2);
    server.claudeSessions.set(SESSION_ID, fakeSession([huge]));
    server.webSocketConnections.set('ws1', { ws: {}, claudeSessionId: null });
    server.sendToWebSocket = (_ws, msg) => sent.push(msg);

    await server.joinClaudeSession('ws1', SESSION_ID);

    const replay = sent.find((m) => m.type === 'session_joined').outputBuffer;
    assert.strictEqual(replay.length, 1);
  });

  it('does not change the live value when the write fails', function () {
    // Applying first and persisting second left the running server on the new
    // value while the caller was told it had failed — a disagreement that only
    // showed up at the next restart.
    const before = server.sessionStore.maxOutputChunks;
    fs.chmodSync(dataDir, 0o555);
    try {
      const res = mockRes();
      server.setScrollback({ body: { bytes: 2 * 1024 * 1024 } }, res);
      assert.strictEqual(res.statusCode, 500);
      assert.strictEqual(server.sessionStore.maxOutputChunks, before,
        'a rejected save must not have moved the running value');
    } finally {
      fs.chmodSync(dataDir, 0o755);
    }
  });

  it('writes the settings file atomically and leaves no temp behind', function () {
    const res = mockRes();
    server.setScrollback({ body: { bytes: 900 * 1024 } }, res);
    assert.strictEqual(res.statusCode, 200);
    const strays = fs.readdirSync(dataDir).filter((f) => f.includes('.tmp'));
    assert.deepStrictEqual(strays, [], `left temp files: ${strays}`);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'scrollback.json'), 'utf8')).bytes, 900 * 1024);
  });

  it('resolves both data-dir files from the store, so a redirect moves both', function () {
    // Two independent copies of "where is the data dir" is how a test once
    // migrated the live instance's sessions (see session-store.js). Reading the
    // env var in each place looks equivalent until something moves storageDir —
    // then the files scatter, which is exactly what that comment warns about.
    const moved = path.join(dataDir, 'moved');
    server.sessionStore.storageDir = moved;
    assert.strictEqual(path.dirname(server.scrollbackFile()), moved);
    assert.strictEqual(path.dirname(server.planDirsFile()), moved);
  });

  it('clamps out-of-range values instead of rejecting them', function () {
    const MIN = 256 * 1024, MAX = 16 * 1024 * 1024;
    for (const [input, expected] of [[0, MIN], [-5, MIN], [10, MIN], [999 * 1024 * 1024, MAX]]) {
      const res = mockRes();
      server.setScrollback({ body: { bytes: input } }, res);
      assert.strictEqual(res.statusCode, 200, `input ${input} should not be an error`);
      assert.strictEqual(res.body.bytes, expected, `input ${input} should clamp to ${expected}`);
      assert.strictEqual(server.sessionStore.maxOutputChunks, expected);
    }
  });

  it('still accepts the old chunk-counted body from a page that has not reloaded', function () {
    // The unit changed under a running browser; answering its POSTs with a 400
    // would break the settings panel until the user happened to refresh.
    const res = mockRes();
    server.setScrollback({ body: { chunks: 5000 } }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.bytes, 500000, '5000 chunks read as ~500 KB');
  });

  it('rejects anything that is not a whole number', function () {
    for (const bad of ['abc', 1.5, null, undefined, {}, NaN, Infinity, '500']) {
      const res = mockRes();
      server.setScrollback({ body: { bytes: bad } }, res);
      assert.strictEqual(res.statusCode, 400, `${JSON.stringify(bad)} should be a 400`);
    }
    // A rejected write must not have moved the live value.
    assert.strictEqual(server.sessionStore.maxOutputChunks, 2 * 1024 * 1024);
  });

  it('persists across a restart', function () {
    const res = mockRes();
    server.setScrollback({ body: { bytes: 1200 * 1024 } }, res);
    assert.strictEqual(res.body.bytes, 1200 * 1024);
    assert.ok(fs.existsSync(path.join(dataDir, 'scrollback.json')));

    const restarted = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
    try {
      assert.strictEqual(restarted.sessionStore.maxOutputChunks, 1200 * 1024);
    } finally {
      if (typeof restarted.dispose === 'function') restarted.dispose();
    }
  });

  it('clamps an out-of-range value found on disk, rather than discarding it', function () {
    // Hand-edited to more than we allow: the useful answer is the most we will
    // honour, not a silent drop back to the default (which would be LESS than
    // what was there before the edit). Same rule as the POST path.
    const MIN = 256 * 1024, MAX = 16 * 1024 * 1024;
    for (const [onDisk, expected] of [[999 * 1024 * 1024, MAX], [-1, MIN], [0, MIN]]) {
      fs.writeFileSync(path.join(dataDir, 'scrollback.json'), JSON.stringify({ bytes: onDisk }));
      const s = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
      try {
        assert.strictEqual(s.sessionStore.maxOutputChunks, expected, `${onDisk} should clamp to ${expected}`);
      } finally {
        if (typeof s.dispose === 'function') s.dispose();
      }
    }
  });

  it('falls back to the default when the settings file is unreadable', function () {
    // Genuinely unusable content, as opposed to a number outside the range.
    for (const junk of ['not json at all', '{"bytes": "banana"}', '[]', '{"bytes": 1.5}']) {
      fs.writeFileSync(path.join(dataDir, 'scrollback.json'), junk);
      const s = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
      try {
        assert.strictEqual(s.sessionStore.maxOutputChunks, 2 * 1024 * 1024,
          `junk ${junk} should fall back to the default`);
      } finally {
        if (typeof s.dispose === 'function') s.dispose();
      }
    }
  });

  it('gives an untouched old setting the new default, not the minimum', function () {
    // 500 was the old DEFAULT. Converting it literally gives 50 KB, which clamps
    // to the 256 KB floor — so every existing install would silently come out of
    // the upgrade with the least history possible.
    fs.writeFileSync(path.join(dataDir, 'scrollback.json'), JSON.stringify({ chunks: 500 }));
    const s = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
    try {
      assert.strictEqual(s.sessionStore.maxOutputChunks, 2 * 1024 * 1024);
    } finally {
      if (typeof s.dispose === 'function') s.dispose();
    }
  });

  it('carries an old chunk-counted file over to the new unit', function () {
    // Someone's setting is on disk in the old unit. Dropping it back to the
    // default would be a silent reset of a choice they made.
    fs.writeFileSync(path.join(dataDir, 'scrollback.json'), JSON.stringify({ chunks: 5000 }));
    const s = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
    try {
      assert.strictEqual(s.sessionStore.maxOutputChunks, 500000);
    } finally {
      if (typeof s.dispose === 'function') s.dispose();
    }
  });
});
