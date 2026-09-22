const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ClaudeCodeWebServer } = require('../src/server');

// Delete from the file explorer. The client asks for confirmation; these cover
// what the server must refuse even when it did not. Handlers are called
// directly with mock req/res, like fs-upload.test.js — no HTTP.
function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; }
  };
}

describe('file explorer: deleteEntry', function () {
  let server;
  let root;

  const del = async (p) => {
    const res = mockRes();
    await server.deleteEntry({ body: { path: p } }, res);
    return res;
  };
  const exists = (p) => { try { fs.lstatSync(p); return true; } catch (_) { return false; } };

  beforeEach(async function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-del-'));
    fs.mkdirSync(path.join(root, 'dir', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dir', 'deep', 'f.txt'), 'x');
    fs.writeFileSync(path.join(root, 'a.txt'), 'a');
    server = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
    // The constructor loads persisted sessions asynchronously and replaces the
    // map when done; let that land before the tests put their own sessions in.
    await new Promise(r => setTimeout(r, 50));
    server.claudeSessions = new Map();
    server.baseFolder = path.join(root, 'launch');
    fs.mkdirSync(server.baseFolder);
  });

  afterEach(function () {
    if (server && typeof server.dispose === 'function') server.dispose();
    server = null;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  });

  it('deletes a file', async function () {
    const res = await del(path.join(root, 'a.txt'));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.type, 'file');
    assert.ok(!exists(path.join(root, 'a.txt')));
  });

  it('deletes a folder with everything in it', async function () {
    const res = await del(path.join(root, 'dir'));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.type, 'dir');
    assert.ok(!exists(path.join(root, 'dir')));
  });

  it('deletes a symlink as a link and leaves its target alone', async function () {
    const link = path.join(root, 'link');
    fs.symlinkSync(path.join(root, 'dir'), link);
    const res = await del(link);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.type, 'symlink');
    assert.ok(!exists(link));
    assert.ok(exists(path.join(root, 'dir', 'deep', 'f.txt')), 'the target must survive');
  });

  it('refuses the launch folder and anything above it', async function () {
    for (const p of [server.baseFolder, root]) {
      const res = await del(p);
      assert.strictEqual(res.statusCode, 403, p);
    }
    assert.ok(exists(server.baseFolder));
  });

  it('refuses a session\'s working folder and anything above it', async function () {
    const work = path.join(root, 'dir', 'deep');
    server.claudeSessions.set('s1', { id: 's1', workingDir: work });
    for (const p of [work, path.join(root, 'dir')]) {
      const res = await del(p);
      assert.strictEqual(res.statusCode, 403, p);
    }
    assert.ok(exists(path.join(work, 'f.txt')));
    // A file inside it is fine: the folder itself stays.
    assert.strictEqual((await del(path.join(work, 'f.txt'))).statusCode, 200);
  });

  it('sees through a symlinked alias of a protected folder', async function () {
    // Deleting "alias/deep" really means deleting root/dir/deep.
    const work = path.join(root, 'dir', 'deep');
    server.claudeSessions.set('s1', { id: 's1', workingDir: work });
    fs.symlinkSync(path.join(root, 'dir'), path.join(root, 'alias'));
    const res = await del(path.join(root, 'alias', 'deep'));
    assert.strictEqual(res.statusCode, 403);
    assert.ok(exists(work));
  });

  it('protects the filesystem root and the home directory', function () {
    // NEVER call deleteEntry on these: if the guard ever regressed, this test
    // would itself delete them. The check alone is enough to hold the rule.
    assert.strictEqual(server.protectedDirHit('/'), '/');
    assert.strictEqual(server.protectedDirHit(fs.realpathSync(os.homedir())), fs.realpathSync(os.homedir()));
    assert.ok(server.protectedDirHit(path.dirname(fs.realpathSync(os.homedir()))), 'the folder holding home');
    assert.strictEqual(server.protectedDirHit(path.join(root, 'a.txt')), null, 'an ordinary file is not protected');
  });

  it('answers 404 for something already gone and 400 for no path', async function () {
    assert.strictEqual((await del(path.join(root, 'nope'))).statusCode, 404);
    assert.strictEqual((await del('')).statusCode, 400);
    assert.strictEqual((await del('a\0b')).statusCode, 400);
    const res = mockRes();
    await server.deleteEntry({ body: {} }, res);
    assert.strictEqual(res.statusCode, 400);
  });
});
