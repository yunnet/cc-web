// The four skills routes: three reads and one write.
//
// The handlers are called directly, the way plan-dirs.test.js does it, so no
// port is opened. `claude` is a stub script in a temp directory and HOME points
// there too, so nothing in here can read or change the real ~/.claude.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ClaudeCodeWebServer } = require('../src/server');
const skills = require('../src/skills');

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; }
  };
}

function stubClaude(dir, stdoutByCommand) {
  const bin = path.join(dir, 'fake-claude.js');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const args = process.argv.slice(2).join(' ');
const table = ${JSON.stringify(stdoutByCommand)};
for (const key of Object.keys(table)) {
  if (args.includes(key)) { process.stdout.write(table[key]); process.exit(0); }
}
process.stdout.write('');
`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

function writeSkill(root, name, frontmatter) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, `${frontmatter}\n# body\n`);
  return file;
}

const AVAILABLE = JSON.stringify({
  installed: [{ id: 'code-review@market', scope: 'user', enabled: true, installPath: null }],
  available: [
    { pluginId: 'code-review@market', name: 'code-review', description: 'Review a PR', installCount: 900 },
    { pluginId: 'ts-lsp@market', name: 'ts-lsp', description: 'TypeScript language server', installCount: 5 },
    { pluginId: 'other@market', name: 'other', description: 'something else', installCount: 100 }
  ]
});

describe('skills API', function() {
  let server;
  let tmp;
  let dataDir;
  let workDir;
  let prevHome;
  let prevData;

  beforeEach(function() {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-skillapi-'));
    dataDir = path.join(tmp, 'data');
    workDir = path.join(tmp, 'project');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
    prevHome = process.env.HOME;
    prevData = process.env.CCW_DATA_DIR;
    process.env.HOME = tmp;
    process.env.CCW_DATA_DIR = dataDir;
    skills.clearCatalogCache();

    server = Object.create(ClaudeCodeWebServer.prototype);
    server.claudeSessions = new Map();
    server.baseFolder = workDir;
    server.claudeBridge = { claudeCommand: stubClaude(tmp, { '--available': AVAILABLE, 'plugin list': '[]', 'marketplace list': '[]' }) };
  });

  afterEach(function() {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevData === undefined) delete process.env.CCW_DATA_DIR; else process.env.CCW_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('GET /api/skills', function() {
    it('lists the user and project skills directories', async function() {
      writeSkill(path.join(tmp, '.claude', 'skills'), 'mine', '---\nname: mine\ndescription: personal\n---');
      writeSkill(path.join(workDir, '.claude', 'skills'), 'theirs', '---\nname: theirs\n---');
      server.claudeSessions.set('s1', { workingDir: workDir });

      const res = mockRes();
      await server.getSkills({ query: { sessionId: 's1' } }, res);
      assert.deepStrictEqual(res.body.skills.map((s) => s.name), ['mine', 'theirs']);
      assert.strictEqual(res.body.projectSkillsDir, path.join(workDir, '.claude', 'skills'));
    });

    it('falls back to the base folder when the session is unknown', async function() {
      const res = mockRes();
      await server.getSkills({ query: {} }, res);
      assert.strictEqual(res.statusCode, 200, 'an unknown session is not an error — the user skills still exist');
    });

    it('refuses a repeated sessionId instead of choking on an array', async function() {
      // A `?sessionId=a&sessionId=b` once took this server down elsewhere.
      const res = mockRes();
      await server.getSkills({ query: { sessionId: ['a', 'b'] } }, res);
      assert.strictEqual(res.statusCode, 400);
    });
  });

  describe('GET /api/skills/catalog', function() {
    it('marks what is already installed and keeps the marketplaces alongside', async function() {
      const res = mockRes();
      await server.getSkillsCatalog({ query: {} }, res);
      const cr = res.body.rows.find((r) => r.name === 'code-review');
      assert.strictEqual(cr.installed, true);
      assert.strictEqual(res.body.rows.find((r) => r.name === 'other').installed, false);
      assert.strictEqual(res.body.total, 3);
      assert.ok(Array.isArray(res.body.marketplaces));
    });

    it('searches by name and description', async function() {
      const res = mockRes();
      await server.getSkillsCatalog({ query: { q: 'typescript' } }, res);
      assert.deepStrictEqual(res.body.rows.map((r) => r.name), ['ts-lsp']);
    });

    it('recommends what matches the project, never what is already installed', async function() {
      fs.writeFileSync(path.join(workDir, 'tsconfig.json'), '{}');
      const res = mockRes();
      await server.getSkillsCatalog({ query: {} }, res);
      assert.strictEqual(res.body.recommended[0].name, 'ts-lsp', 'a tsconfig.json project should be offered the TS plugin first');
      assert.deepStrictEqual(res.body.recommended[0].reason, { kind: 'signal', file: 'tsconfig.json' });
      assert.ok(!res.body.recommended.some((r) => r.name === 'code-review'), 'already installed must not be recommended');
    });

    it('falls back to popularity when nothing matches the project', async function() {
      const res = mockRes();
      await server.getSkillsCatalog({ query: {} }, res);
      assert.strictEqual(res.body.recommended[0].name, 'other');
      assert.deepStrictEqual(res.body.recommended[0].reason, { kind: 'popular', installCount: 100 });
    });

    it('refuses a repeated query parameter', async function() {
      const res = mockRes();
      await server.getSkillsCatalog({ query: { q: ['a', 'b'] } }, res);
      assert.strictEqual(res.statusCode, 400);
    });
  });

  describe('GET /api/skills/file', function() {
    it('serves a SKILL.md that lives under a skills root', async function() {
      const file = writeSkill(path.join(tmp, '.claude', 'skills'), 'mine', '---\nname: mine\n---');
      const res = mockRes();
      await server.getSkillFile({ query: { path: file } }, res);
      assert.strictEqual(res.statusCode, 200);
      assert.ok(res.body.text.includes('name: mine'));
    });

    it('refuses a file outside every skills root, even a readable one', async function() {
      const outside = path.join(tmp, 'SKILL.md');
      fs.writeFileSync(outside, 'not a skill');
      const res = mockRes();
      await server.getSkillFile({ query: { path: outside } }, res);
      assert.strictEqual(res.statusCode, 403, 'this is not a general-purpose file reader');
    });

    it('refuses a symlink that points out of the skills roots', async function() {
      const secret = path.join(tmp, 'secret.txt');
      fs.writeFileSync(secret, 'nope');
      const dir = path.join(tmp, '.claude', 'skills', 'sneaky');
      fs.mkdirSync(dir, { recursive: true });
      const link = path.join(dir, 'SKILL.md');
      fs.symlinkSync(secret, link);
      const res = mockRes();
      await server.getSkillFile({ query: { path: link } }, res);
      assert.ok(res.statusCode === 403 || res.statusCode === 400, `realpath must defeat the symlink (got ${res.statusCode})`);
    });

    it('refuses a path that is not called SKILL.md', async function() {
      const dir = path.join(tmp, '.claude', 'skills', 'x');
      fs.mkdirSync(dir, { recursive: true });
      const other = path.join(dir, 'notes.md');
      fs.writeFileSync(other, 'hello');
      const res = mockRes();
      await server.getSkillFile({ query: { path: other } }, res);
      assert.strictEqual(res.statusCode, 400);
    });

    it('404s a file that is not there, without leaking whether the directory is', async function() {
      const res = mockRes();
      await server.getSkillFile({ query: { path: path.join(tmp, '.claude', 'skills', 'ghost', 'SKILL.md') } }, res);
      assert.strictEqual(res.statusCode, 404);
    });

    it('refuses an over-sized SKILL.md rather than sending it', async function() {
      const dir = path.join(tmp, '.claude', 'skills', 'big');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'SKILL.md');
      fs.writeFileSync(file, 'x'.repeat(ClaudeCodeWebServer.SKILL_FILE_MAX + 1));
      const res = mockRes();
      await server.getSkillFile({ query: { path: file } }, res);
      assert.strictEqual(res.statusCode, 413);
    });

    it('needs a path, once', async function() {
      const a = mockRes();
      await server.getSkillFile({ query: {} }, a);
      assert.strictEqual(a.statusCode, 400);
      const b = mockRes();
      await server.getSkillFile({ query: { path: ['x', 'y'] } }, b);
      assert.strictEqual(b.statusCode, 400);
    });
  });

  describe('POST /api/skills/action', function() {
    it('400s a bad id without spawning anything', async function() {
      const res = mockRes();
      await server.postSkillAction({ body: { action: 'install', target: '--json' } }, res);
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.body.failureCode, 'bad-id');
    });

    it('400s an unknown action', async function() {
      const res = mockRes();
      await server.postSkillAction({ body: { action: 'sudo', target: 'a@m' } }, res);
      assert.strictEqual(res.statusCode, 400);
    });

    it('passes a real result through as 200', async function() {
      server.claudeBridge.claudeCommand = stubClaude(tmp, {
        'plugin install': JSON.stringify({ command: 'install', outcome: 'success', plugin: 'a@m', message: 'ok' })
      });
      const res = mockRes();
      await server.postSkillAction({ body: { action: 'install', target: 'a@m' } }, res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.ok, true);
      assert.strictEqual(res.body.restartRequired, true);
    });

    it('409s a second write while one is running, rather than queueing it', async function() {
      const hang = path.join(tmp, 'hang.js');
      fs.writeFileSync(hang, '#!/usr/bin/env node\nsetTimeout(() => {}, 60000);\n');
      fs.chmodSync(hang, 0o755);
      server.claudeBridge.claudeCommand = hang;

      const first = skills.runAction('uninstall', { target: 'a@m', claudeCommand: hang, timeoutMs: 400 });
      const res = mockRes();
      await server.postSkillAction({ body: { action: 'uninstall', target: 'b@m' } }, res);
      assert.strictEqual(res.statusCode, 409);
      assert.strictEqual(res.body.failureCode, 'busy');
      await first;
    });
  });
});
