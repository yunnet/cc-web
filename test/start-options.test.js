const assert = require('assert');
const path = require('path');
const { ClaudeCodeWebServer } = require('../src/server');

// start_claude carries launch options chosen in the browser. They used to be
// spread LAST over the bridge call (`...options`), so any field the server sets
// could be replaced from the client: `workingDir` skipped validatePath, and
// `hookScript` named a file node would run as the hook. Only the four launch
// options may come from the browser; everything else is the server's.
const SESSION_ID = '5f0c9a52-7a4e-4d2a-9d0e-3c1f2b6a8e10';

describe('start_claude options', function () {
  let server;
  let seen;

  beforeEach(function () {
    server = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
    server.saveSessionsToDisk = () => {}; // never touch the real data dir
    seen = null;
    server.claudeBridge.startSession = async (id, opts) => { seen = opts; return {}; };
    server.claudeSessions.set(SESSION_ID, {
      id: SESSION_ID, name: 'test', active: false, claudeStarted: false,
      workingDir: '/data/work/project',
      connections: new Set(['ws1']), outputBuffer: [], maxBufferSize: 1000,
      created: new Date(), lastActivity: new Date()
    });
    server.webSocketConnections.set('ws1', { ws: {}, claudeSessionId: SESSION_ID });
  });

  afterEach(function () {
    if (server && typeof server.dispose === 'function') server.dispose();
    server = null;
  });

  it('keeps the server-owned fields out of the client\'s reach', async function () {
    await server.startClaude('ws1', {
      workingDir: '/etc',
      hookScript: '/tmp/evil.js',
      hookToken: 'forged',
      resumeId: 'not-ours',
      allowFreshFallback: true,
      onOutput: null
    }, 80, 24);

    assert.ok(seen, 'the bridge was never called');
    assert.strictEqual(seen.workingDir, '/data/work/project');
    assert.strictEqual(seen.hookScript, path.join(__dirname, '..', 'bin', 'cc-hook.js'));
    assert.notStrictEqual(seen.hookToken, 'forged');
    assert.notStrictEqual(seen.resumeId, 'not-ours');
    assert.strictEqual(typeof seen.onOutput, 'function');
  });

  it('still passes the four launch options through', async function () {
    await server.startClaude('ws1', {
      model: 'fable', permissionMode: 'auto', effort: 'high', dangerouslySkipPermissions: true
    }, 80, 24);

    assert.strictEqual(seen.model, 'fable');
    assert.strictEqual(seen.permissionMode, 'auto');
    assert.strictEqual(seen.effort, 'high');
    assert.strictEqual(seen.dangerouslySkipPermissions, true);
  });
});
