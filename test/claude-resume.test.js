const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ClaudeCodeWebServer } = require('../src/server');
const claudeHistory = require('../src/utils/claude-history');

// Creating a tab bound to an existing Claude conversation. The cc-web session id
// IS the conversation id, so "continue this conversation" is entirely about
// which id the new session gets — see server.createSession.
function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; }
  };
}

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('resuming a Claude conversation in a new session', function() {
  let server;
  let dataDir;
  let home;
  let workDir;
  let prevData;
  let prevHome;

  beforeEach(function() {
    prevData = process.env.CCW_DATA_DIR;
    prevHome = process.env.HOME;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-data-'));
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-home-')));
    workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-work-')));
    process.env.CCW_DATA_DIR = dataDir;
    process.env.HOME = home;

    const projectDir = path.join(home, '.claude', 'projects', claudeHistory.projectDirName(workDir));
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, `${A}.jsonl`),
      JSON.stringify({ type: 'user', message: { content: 'the earlier conversation' } }) + '\n'
    );

    server = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
  });

  afterEach(function() {
    if (server && typeof server.dispose === 'function') server.dispose();
    server = null;
    if (prevData === undefined) delete process.env.CCW_DATA_DIR; else process.env.CCW_DATA_DIR = prevData;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    for (const d of [dataDir, home, workDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  });

  it('lists the directory\'s conversations, flagging ones a tab already holds', async function() {
    let res = mockRes();
    await server.listClaudeConversations({ query: { dir: workDir } }, res);
    assert.deepStrictEqual(res.body.conversations.map(c => c.id), [A]);
    assert.strictEqual(res.body.conversations[0].title, 'the earlier conversation');
    assert.strictEqual(res.body.conversations[0].openInTab, false);

    server.claudeSessions.set(A, { id: A, workingDir: workDir, connections: new Set() });
    res = mockRes();
    await server.listClaudeConversations({ query: { dir: workDir } }, res);
    assert.strictEqual(res.body.conversations[0].openInTab, true);
  });

  it('rejects a repeated ?dir= instead of throwing', async function() {
    const res = mockRes();
    await server.listClaudeConversations({ query: { dir: [workDir, '/etc'] } }, res);
    assert.strictEqual(res.statusCode, 400);
  });

  it('creates the session under the conversation id, already marked started', async function() {
    const res = mockRes();
    await server.createSession({ body: { name: 'resumed', workingDir: workDir, resumeId: A } }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.sessionId, A);
    assert.strictEqual(res.body.resumed, true);

    const session = server.claudeSessions.get(A);
    assert.ok(session, 'the session is held under the conversation id');
    // Both flags matter: claudeStarted is what makes the first start a --resume,
    // resumedConversation is what stops a failed resume becoming a fresh launch.
    assert.strictEqual(session.claudeStarted, true);
    assert.strictEqual(session.resumedConversation, true);
    assert.strictEqual(session.workingDir, workDir);
  });

  it('still mints a fresh id, unstarted, without a resumeId', async function() {
    const res = mockRes();
    await server.createSession({ body: { name: 'plain', workingDir: workDir } }, res);
    assert.strictEqual(res.body.resumed, false);
    const session = server.claudeSessions.get(res.body.sessionId);
    assert.strictEqual(session.claudeStarted, false);
    assert.strictEqual(session.resumedConversation, false);
  });

  it('refuses a second tab on a conversation already in use', async function() {
    let res = mockRes();
    await server.createSession({ body: { workingDir: workDir, resumeId: A } }, res);
    assert.strictEqual(res.statusCode, 200);

    res = mockRes();
    await server.createSession({ body: { workingDir: workDir, resumeId: A } }, res);
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.sessionId, A, 'the caller is told which tab to switch to');
    assert.strictEqual(server.claudeSessions.size, 1, 'no second session was created');
  });

  it('refuses a malformed id and one that is not recorded in this directory', async function() {
    let res = mockRes();
    await server.createSession({ body: { workingDir: workDir, resumeId: 'not-a-uuid' } }, res);
    assert.strictEqual(res.statusCode, 400);

    res = mockRes();
    await server.createSession({ body: { workingDir: workDir, resumeId: B } }, res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(server.claudeSessions.size, 0);
  });
});
