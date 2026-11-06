const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { ClaudeCodeWebServer } = require('../src/server');
const ClaudeBridge = require('../src/claude-bridge');
const claudeConfig = require('../src/utils/claude-config');
const claudeHistory = require('../src/utils/claude-history');
const claudeTheme = require('../src/utils/claude-theme');
const skills = require('../src/skills');
const { useTempDataDir, signIn } = require('./helpers/auth');

// M3: every platform user runs their own Claude (CLAUDE_CONFIG_DIR under
// <dataDir>/<uid>/claude) on the platform key. The unowned tenant keeps
// ~/.claude and gets no key.

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

// A transcript Claude would have written for `dir`, with one real turn.
function writeConversation(projectsRoot, dir, id, text) {
  const proj = path.join(projectsRoot, claudeHistory.projectDirName(dir));
  fs.mkdirSync(proj, { recursive: true });
  const line = JSON.stringify({ type: 'user', cwd: dir, sessionId: id, message: { role: 'user', content: text } });
  fs.writeFileSync(path.join(proj, `${id}.jsonl`), `${line}\n`);
  return proj;
}

describe('per-user Claude directory (M3)', function () {
  let tmp;

  beforeEach(function () {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-m3-'));
  });

  afterEach(function () {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('seedConfig', function () {
    const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    const read = () => JSON.parse(fs.readFileSync(path.join(tmp, 'claude', '.claude.json'), 'utf8'));

    it('answers the first-run questions in a fresh directory', function () {
      assert.strictEqual(claudeConfig.seedConfig(path.join(tmp, 'claude'), { apiKey: KEY }), true);
      const c = read();
      assert.strictEqual(c.hasCompletedOnboarding, true);
      assert.strictEqual(c.theme, 'dark');
      assert.deepStrictEqual(c.customApiKeyResponses, { approved: [KEY.slice(-20)], rejected: [] });
    });

    it('approves no key when there is none', function () {
      claudeConfig.seedConfig(path.join(tmp, 'claude'));
      assert.strictEqual(read().customApiKeyResponses, undefined);
    });

    it('keeps what is already there and writes nothing when nothing is missing', function () {
      const dir = path.join(tmp, 'claude');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ theme: 'light', numStartups: 7 }));
      claudeConfig.seedConfig(dir, { apiKey: KEY });
      const c = read();
      assert.strictEqual(c.theme, 'light');
      assert.strictEqual(c.numStartups, 7);
      assert.strictEqual(claudeConfig.seedConfig(dir, { apiKey: KEY }), false);
    });

    it('approves a new key alongside the old one, and lifts an earlier No', function () {
      const dir = path.join(tmp, 'claude');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({
        hasCompletedOnboarding: true, theme: 'dark',
        customApiKeyResponses: { approved: ['old-tail'], rejected: [KEY.slice(-20)] }
      }));
      claudeConfig.seedConfig(dir, { apiKey: KEY });
      assert.deepStrictEqual(read().customApiKeyResponses, { approved: ['old-tail', KEY.slice(-20)], rejected: [] });
    });

    it('leaves a file it cannot parse alone', function () {
      const dir = path.join(tmp, 'claude');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, '.claude.json'), '{ not json');
      assert.strictEqual(claudeConfig.seedConfig(dir, { apiKey: KEY }), false);
      assert.strictEqual(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'), '{ not json');
    });
  });

  describe('readPlatformKey', function () {
    let prev;
    beforeEach(function () { prev = process.env.CCW_ANTHROPIC_API_KEY; delete process.env.CCW_ANTHROPIC_API_KEY; });
    afterEach(function () {
      if (prev === undefined) delete process.env.CCW_ANTHROPIC_API_KEY;
      else process.env.CCW_ANTHROPIC_API_KEY = prev;
    });

    it('reads the first line of platform/anthropic-key', function () {
      fs.writeFileSync(path.join(tmp, 'anthropic-key'), '  sk-file  \r\nignored\n');
      assert.strictEqual(claudeConfig.readPlatformKey(tmp), 'sk-file');
    });

    it('prefers CCW_ANTHROPIC_API_KEY', function () {
      fs.writeFileSync(path.join(tmp, 'anthropic-key'), 'sk-file\n');
      process.env.CCW_ANTHROPIC_API_KEY = 'sk-env';
      assert.strictEqual(claudeConfig.readPlatformKey(tmp), 'sk-env');
    });

    it('is empty when neither is set', function () {
      assert.strictEqual(claudeConfig.readPlatformKey(tmp), '');
    });
  });

  describe('the spawn environment', function () {
    const inherited = () => ({
      PATH: '/bin', ANTHROPIC_API_KEY: 'operator', ANTHROPIC_AUTH_TOKEN: 'operator', CLAUDE_CODE_OAUTH_TOKEN: 'operator'
    });

    for (const [name, apply] of [
      ['ClaudeBridge.applyOwnerEnv', (env, o) => ClaudeBridge.applyOwnerEnv(env, { claudeConfigDir: o.configDir, apiKey: o.apiKey })],
      ['claudeConfig.applyEnv', (env, o) => claudeConfig.applyEnv(env, o)]
    ]) {
      it(`${name}: a user gets their directory and the platform key, never the operator's credentials`, function () {
        const env = apply(inherited(), { configDir: '/data/u-1/claude', apiKey: 'sk-platform' });
        assert.strictEqual(env.CLAUDE_CONFIG_DIR, '/data/u-1/claude');
        assert.strictEqual(env.ANTHROPIC_API_KEY, 'sk-platform');
        assert.strictEqual(env.ANTHROPIC_AUTH_TOKEN, undefined);
        assert.strictEqual(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
        assert.strictEqual(env.PATH, '/bin');
      });

      it(`${name}: with no platform key a user gets no key at all`, function () {
        const env = apply(inherited(), { configDir: '/data/u-1/claude', apiKey: '' });
        assert.strictEqual(env.ANTHROPIC_API_KEY, undefined);
      });

      it(`${name}: the unowned tenant's env is left alone`, function () {
        assert.deepStrictEqual(apply(inherited(), { configDir: null, apiKey: 'sk-platform' }), inherited());
      });
    }
  });

  describe('themes', function () {
    afterEach(function () { claudeTheme._reset(); });

    it('are written into the user directory and named only there', function () {
      const dir = path.join(tmp, 'claude');
      const written = claudeTheme.ensureThemes(dir);
      assert.ok(fs.existsSync(claudeTheme.themeFile(written.dark, dir)));
      assert.strictEqual(claudeTheme.themeForUi('dark', dir), `custom:${written.dark}`);
      // Another directory has none written yet, so it gets the built-in.
      assert.strictEqual(claudeTheme.themeForUi('dark', path.join(tmp, 'other')), claudeTheme.BUILT_IN.dark);
    });
  });

  describe('adoptConversation', function () {
    it('copies a session\'s conversation from ~/.claude into the user directory, once', async function () {
      const from = path.join(tmp, 'home', 'projects');
      const to = path.join(tmp, 'user', 'projects');
      const work = path.join(tmp, 'work');
      const src = writeConversation(from, work, ID_A, 'hello');
      fs.mkdirSync(path.join(src, ID_A, 'subagents'), { recursive: true });
      fs.writeFileSync(path.join(src, ID_A, 'subagents', 'a.jsonl'), 'x\n');

      assert.strictEqual(await claudeHistory.adoptConversation(work, ID_A, { from, to }), true);
      assert.ok(await claudeHistory.hasConversation(work, ID_A, { root: to }));
      assert.ok(fs.existsSync(path.join(to, path.basename(src), ID_A, 'subagents', 'a.jsonl')));
      assert.ok(fs.existsSync(path.join(src, `${ID_A}.jsonl`)), 'the original stays');

      // Not twice, and never over what the user's Claude has written since.
      fs.appendFileSync(path.join(to, path.basename(src), `${ID_A}.jsonl`), 'newer\n');
      assert.strictEqual(await claudeHistory.adoptConversation(work, ID_A, { from, to }), false);
      assert.match(fs.readFileSync(path.join(to, path.basename(src), `${ID_A}.jsonl`), 'utf8'), /newer/);
    });

    it('does nothing for a conversation that is not there', async function () {
      const from = path.join(tmp, 'home', 'projects');
      writeConversation(from, path.join(tmp, 'work'), ID_A, 'hello');
      assert.strictEqual(await claudeHistory.adoptConversation(path.join(tmp, 'work'), ID_B, { from, to: path.join(tmp, 'u') }), false);
    });
  });

  describe('skills act on the caller\'s own Claude', function () {
    it('reads the user skills directory and the plugin root from that directory', function () {
      assert.strictEqual(skills.userSkillsDir('/d/u-1/claude'), path.join('/d/u-1/claude', 'skills'));
      assert.strictEqual(skills.pluginsDir('/d/u-1/claude'), path.join('/d/u-1/claude', 'plugins'));
      assert.strictEqual(skills.userSkillsDir(), path.join(os.homedir(), '.claude', 'skills'));
    });

    it('runs the CLI with CLAUDE_CONFIG_DIR and keeps one catalog per directory', async function () {
      skills.clearCatalogCache();
      const bin = path.join(tmp, 'fake-claude.js');
      const log = path.join(tmp, 'calls.log');
      fs.writeFileSync(bin, `const fs = require('fs');
fs.appendFileSync(${JSON.stringify(log)}, (process.env.CLAUDE_CONFIG_DIR || '-') + '\\n');
process.stdout.write(JSON.stringify({ installed: [], available: [{ pluginId: 'a@m', name: 'a', installCount: 1 }] }));
`);
      const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n');
      await skills.catalog({ claudeCommand: bin, claudeConfigDir: path.join(tmp, 'u1') });
      await skills.catalog({ claudeCommand: bin, claudeConfigDir: path.join(tmp, 'u1') });
      await skills.catalog({ claudeCommand: bin, claudeConfigDir: path.join(tmp, 'u2') });
      assert.deepStrictEqual(calls(), [path.join(tmp, 'u1'), path.join(tmp, 'u2')]);
      skills.clearCatalogCache();
    });
  });
});

describe('per-user Claude directory on the server (M3)', function () {
  let server;
  let listener;
  let port;
  let dir;
  let work;
  let home;
  let alice;
  let bob;
  let prevHome;
  let prevProfile;
  let prevKey;

  beforeEach(async function () {
    // ~/.claude is the unowned tenant's: point it at a temp home.
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-m3-home-'));
    prevHome = process.env.HOME;
    prevProfile = process.env.USERPROFILE;
    prevKey = process.env.CCW_ANTHROPIC_API_KEY;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.CCW_ANTHROPIC_API_KEY;

    server = new ClaudeCodeWebServer({ auth: 'tok-m3', folderMode: false, port: 40125 });
    dir = useTempDataDir(server);
    await server._initialLoad;
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-m3-work-')));
    server.baseFolder = path.dirname(work);
    alice = await signIn(server, { username: 'alice', role: 'admin' });
    bob = await signIn(server, { username: 'bob', role: 'user' });
    await new Promise((resolve) => {
      listener = http.createServer(server.app).listen(0, '127.0.0.1', () => {
        port = listener.address().port;
        resolve();
      });
    });
  });

  afterEach(function () {
    listener.close();
    if (server && typeof server.dispose === 'function') server.dispose();
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
    if (prevKey === undefined) delete process.env.CCW_ANTHROPIC_API_KEY; else process.env.CCW_ANTHROPIC_API_KEY = prevKey;
    claudeTheme._reset();
    for (const d of [dir, work, home]) fs.rmSync(d, { recursive: true, force: true });
  });

  function request(method, p, { body, cookie } = {}) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const req = http.request({
        host: '127.0.0.1', port, path: p, method,
        headers: {
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
      }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch (_) { /* not json */ }
          resolve({ status: res.statusCode, json });
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  it('gives every platform user, the administrator included, a directory of their own', function () {
    assert.strictEqual(server.claudeDirFor(alice.user.id), path.join(dir, alice.user.id, 'claude'));
    assert.strictEqual(server.claudeDirFor(bob.user.id), path.join(dir, bob.user.id, 'claude'));
    assert.strictEqual(server.claudeDirFor(null), null);
    assert.strictEqual(server.projectsDirFor(null), path.join(home, '.claude', 'projects'));
  });

  it('prepares a user directory with the platform key, and the unowned tenant with nothing', function () {
    fs.mkdirSync(path.join(dir, 'platform'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'platform', 'anthropic-key'), 'sk-ant-platform-key-000000000000000000\n');
    const prepared = server.prepareClaudeFor(alice.user.id);
    assert.strictEqual(prepared.apiKey, 'sk-ant-platform-key-000000000000000000');
    const seeded = JSON.parse(fs.readFileSync(path.join(prepared.claudeConfigDir, '.claude.json'), 'utf8'));
    assert.deepStrictEqual(seeded.customApiKeyResponses.approved, ['key-000000000000000000'.slice(-20)]);
    assert.ok(fs.existsSync(path.join(prepared.claudeConfigDir, 'themes')));

    assert.deepStrictEqual(server.prepareClaudeFor(null), { claudeConfigDir: null, apiKey: '' });
    assert.ok(!fs.existsSync(path.join(home, '.claude')), 'nothing is written into ~/.claude');
  });

  it('lists only the caller\'s own conversations and resumes only those', async function () {
    writeConversation(server.projectsDirFor(alice.user.id), work, ID_A, 'alice asks');
    writeConversation(server.projectsDirFor(bob.user.id), work, ID_B, 'bob asks');
    writeConversation(path.join(home, '.claude', 'projects'), work, ID_B.replace(/2/g, '3'), 'shared');

    const q = `/api/claude-sessions?dir=${encodeURIComponent(work)}`;
    const a = await request('GET', q, { cookie: alice.cookie });
    assert.strictEqual(a.status, 200);
    assert.deepStrictEqual(a.json.conversations.map((c) => c.id), [ID_A]);
    const b = await request('GET', q, { cookie: bob.cookie });
    assert.deepStrictEqual(b.json.conversations.map((c) => c.id), [ID_B]);

    // Bob cannot resume Alice's conversation: it is not in his history.
    const steal = await request('POST', '/api/sessions/create', { cookie: bob.cookie, body: { workingDir: work, resumeId: ID_A } });
    assert.strictEqual(steal.status, 404);
    const own = await request('POST', '/api/sessions/create', { cookie: alice.cookie, body: { workingDir: work, resumeId: ID_A } });
    assert.strictEqual(own.status, 200);
  });

  it('reads the prompt rail from the owner\'s directory', async function () {
    writeConversation(server.projectsDirFor(alice.user.id), work, ID_A, 'from alice dir');
    const created = await request('POST', '/api/sessions/create', { cookie: alice.cookie, body: { workingDir: work, resumeId: ID_A } });
    const res = await request('GET', `/api/sessions/${created.json.sessionId}/prompts`, { cookie: alice.cookie });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json.prompts.map((p) => p.text), ['from alice dir']);
  });

  it('points the skills panel at the caller\'s directory', function () {
    assert.strictEqual(server.skillsContext(undefined, bob.user.id).claudeConfigDir, server.claudeDirFor(bob.user.id));
    assert.strictEqual(server.skillsContext(undefined, null).claudeConfigDir, null);
  });
});
