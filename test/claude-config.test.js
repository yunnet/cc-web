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
const { ConversationOwners } = require('../src/utils/conversation-owners');
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

  // One subscription for everyone (user 2026-11-06): a `claude setup-token`
  // token, preferred over the key when both are configured.
  describe('the shared subscription token', function () {
    let prevToken;
    let prevKey;
    beforeEach(function () {
      prevToken = process.env.CCW_CLAUDE_OAUTH_TOKEN;
      prevKey = process.env.CCW_ANTHROPIC_API_KEY;
      delete process.env.CCW_CLAUDE_OAUTH_TOKEN;
      delete process.env.CCW_ANTHROPIC_API_KEY;
    });
    afterEach(function () {
      if (prevToken === undefined) delete process.env.CCW_CLAUDE_OAUTH_TOKEN; else process.env.CCW_CLAUDE_OAUTH_TOKEN = prevToken;
      if (prevKey === undefined) delete process.env.CCW_ANTHROPIC_API_KEY; else process.env.CCW_ANTHROPIC_API_KEY = prevKey;
    });

    it('reads the first line of platform/claude-oauth-token, or CCW_CLAUDE_OAUTH_TOKEN first', function () {
      assert.strictEqual(claudeConfig.readPlatformOAuthToken(tmp), '');
      fs.writeFileSync(path.join(tmp, 'claude-oauth-token'), ' sk-ant-oat01-file \r\nignored\n');
      assert.strictEqual(claudeConfig.readPlatformOAuthToken(tmp), 'sk-ant-oat01-file');
      process.env.CCW_CLAUDE_OAUTH_TOKEN = 'sk-ant-oat01-env';
      assert.strictEqual(claudeConfig.readPlatformOAuthToken(tmp), 'sk-ant-oat01-env');
    });

    it('wins over the platform key, which is then not handed out at all', function () {
      fs.writeFileSync(path.join(tmp, 'anthropic-key'), 'sk-key\n');
      assert.deepStrictEqual(claudeConfig.platformCredentials(tmp), { oauthToken: '', apiKey: 'sk-key' });
      fs.writeFileSync(path.join(tmp, 'claude-oauth-token'), 'sk-ant-oat01-x\n');
      assert.deepStrictEqual(claudeConfig.platformCredentials(tmp), { oauthToken: 'sk-ant-oat01-x', apiKey: '' });
    });
  });

  describe('the spawn environment', function () {
    const inherited = () => ({
      PATH: '/bin', ANTHROPIC_API_KEY: 'operator', ANTHROPIC_AUTH_TOKEN: 'operator', CLAUDE_CODE_OAUTH_TOKEN: 'operator'
    });

    for (const [name, apply] of [
      ['ClaudeBridge.applyOwnerEnv', (env, o) => ClaudeBridge.applyOwnerEnv(env, { claudeConfigDir: o.configDir, apiKey: o.apiKey, oauthToken: o.oauthToken })],
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

      it(`${name}: with the shared subscription, a user gets that token and never a key`, function () {
        // Claude prefers ANTHROPIC_API_KEY over an OAuth token: both would bill the API.
        const env = apply(inherited(), { configDir: '/data/u-1/claude', apiKey: 'sk-platform', oauthToken: 'sk-ant-oat01-shared' });
        assert.strictEqual(env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-shared');
        assert.strictEqual(env.ANTHROPIC_API_KEY, undefined);
        assert.strictEqual(env.ANTHROPIC_AUTH_TOKEN, undefined);
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

describe('Claude directory on the server (shared ~/.claude since 2026-11-06)', function () {
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
  let prevToken;

  beforeEach(async function () {
    // ~/.claude is the unowned tenant's: point it at a temp home.
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-m3-home-'));
    prevHome = process.env.HOME;
    prevProfile = process.env.USERPROFILE;
    prevKey = process.env.CCW_ANTHROPIC_API_KEY;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.CCW_ANTHROPIC_API_KEY;
    prevToken = process.env.CCW_CLAUDE_OAUTH_TOKEN;
    delete process.env.CCW_CLAUDE_OAUTH_TOKEN;

    server = new ClaudeCodeWebServer({ auth: 'tok-m3', folderMode: false, port: 40125 });
    dir = useTempDataDir(server);
    await server._initialLoad;
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-m3-work-')));
    server.baseFolder = path.dirname(work);
    alice = await signIn(server, { username: 'alice', role: 'admin' });
    bob = await signIn(server, { username: 'bob', role: 'user' });
    server.userStore.updateUser(bob.user.id, { rootDirs: [work] });
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
    if (prevToken === undefined) delete process.env.CCW_CLAUDE_OAUTH_TOKEN; else process.env.CCW_CLAUDE_OAUTH_TOKEN = prevToken;
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

  // User 2026-11-06: 「完全和 main 一样」 — every user's Claude runs on ~/.claude.
  it('runs every platform user, the administrator included, on ~/.claude', function () {
    for (const id of [alice.user.id, bob.user.id, null]) {
      assert.strictEqual(server.claudeDirFor(id), null);
      assert.strictEqual(server.projectsDirFor(id), path.join(home, '.claude', 'projects'));
    }
    assert.strictEqual(server.legacyClaudeDirFor(alice.user.id), path.join(dir, alice.user.id, 'claude'));
    assert.strictEqual(server.legacyClaudeDirFor(null), null);
  });

  it('hands out no platform credential and writes nothing, like the single-user cc-web', function () {
    fs.mkdirSync(path.join(dir, 'platform'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'platform', 'anthropic-key'), 'sk-ant-platform-key-000000000000000000\n');
    fs.writeFileSync(path.join(dir, 'platform', 'claude-oauth-token'), 'sk-ant-oat01-shared\n');
    for (const id of [alice.user.id, bob.user.id, null]) {
      assert.deepStrictEqual(server.prepareClaudeFor(id), { claudeConfigDir: null, apiKey: '', oauthToken: '' });
    }
    assert.ok(!fs.existsSync(path.join(home, '.claude')), 'nothing is written into ~/.claude');
    assert.ok(!fs.existsSync(path.join(dir, alice.user.id, 'claude')), 'no per-user directory is made');
  });

  it('lists the shared history to everyone and resumes from it', async function () {
    writeConversation(path.join(home, '.claude', 'projects'), work, ID_A, 'shared');
    const q = `/api/claude-sessions?dir=${encodeURIComponent(work)}`;
    for (const who of [alice, bob]) {
      const res = await request('GET', q, { cookie: who.cookie });
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(res.json.conversations.map((c) => c.id), [ID_A]);
    }
    const own = await request('POST', '/api/sessions/create', { cookie: bob.cookie, body: { workingDir: work, resumeId: ID_A } });
    assert.strictEqual(own.status, 200);
  });

  it('reads the prompt rail from ~/.claude', async function () {
    writeConversation(path.join(home, '.claude', 'projects'), work, ID_A, 'from the shared dir');
    const created = await request('POST', '/api/sessions/create', { cookie: alice.cookie, body: { workingDir: work, resumeId: ID_A } });
    const res = await request('GET', `/api/sessions/${created.json.sessionId}/prompts`, { cookie: alice.cookie });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json.prompts.map((p) => p.text), ['from the shared dir']);
  });

  it('shows a folder-limited user only their folders in the overview', async function () {
    const other = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(work), 'ccw-m3-other-')));
    try {
      const root = path.join(home, '.claude', 'projects');
      for (const [d, id] of [[work, ID_A], [other, ID_B]]) {
        const proj = path.join(root, claudeHistory.projectDirName(d));
        fs.mkdirSync(proj, { recursive: true });
        const rec = { type: 'assistant', cwd: d, sessionId: id, timestamp: new Date().toISOString(),
          message: { id: `msg-${id}`, model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 5 } } };
        fs.writeFileSync(path.join(proj, `${id}.jsonl`), `${JSON.stringify(rec)}\n`);
      }
      const ids = async (who) => (await request('GET', '/api/usage/overview?range=7d', { cookie: who.cookie })).json.sessions.map((s) => s.id).sort();
      assert.deepStrictEqual(await ids(alice), [ID_A, ID_B].sort());
      assert.deepStrictEqual(await ids(bob), [ID_A]);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('splits the overview by account: every name for an administrator, mine and 其他 for anyone else', async function () {
    const root = path.join(home, '.claude', 'projects');
    const proj = path.join(root, claudeHistory.projectDirName(work));
    fs.mkdirSync(proj, { recursive: true });
    const ID_C = '33333333-3333-4333-8333-333333333333';
    for (const [id, n] of [[ID_A, 10], [ID_B, 20], [ID_C, 40]]) {
      const rec = { type: 'assistant', cwd: work, sessionId: id, timestamp: new Date().toISOString(),
        message: { id: `msg-${id}`, model: 'claude-opus-5-5', usage: { input_tokens: n, output_tokens: 0 } } };
      fs.writeFileSync(path.join(proj, `${id}.jsonl`), `${JSON.stringify(rec)}\n`);
    }
    server.conversationOwners.record(ID_A, alice.user.id);
    server.conversationOwners.record(ID_B, bob.user.id);
    assert.strictEqual(server.conversationOwners.record(ID_B, alice.user.id), false, 'the first owner keeps it');

    const get = async (who, owner) => (await request('GET', `/api/usage/overview?range=7d&owner=${owner}`, { cookie: who.cookie })).json;
    const all = await get(alice, 'all');
    assert.deepStrictEqual(all.groups.map((g) => [g.name, g.tokens, g.me]), [['不在 cc-web 里', 40, false], ['bob', 20, false], ['alice', 10, true]]);
    assert.strictEqual(all.sessions.find((s) => s.id === ID_B).account, 'bob');
    assert.deepStrictEqual((await get(alice, bob.user.id)).sessions.map((s) => s.id), [ID_B]);
    assert.deepStrictEqual((await get(alice, 'none')).sessions.map((s) => s.id), [ID_C]);

    const b = await get(bob, 'all');
    assert.deepStrictEqual(b.groups.map((g) => [g.name, g.tokens]), [['其他账号', 50], ['bob', 20]]);
    assert.ok(!JSON.stringify(b).includes('alice'), 'no other account is named to a regular user');
    assert.deepStrictEqual((await get(bob, 'me')).sessions.map((s) => s.id), [ID_B]);
    const peek = await get(bob, alice.user.id);
    assert.strictEqual(peek.owner, 'all', 'a regular user cannot pick another account');

    // The record outlives the server.
    const again = new ConversationOwners(() => path.join(dir, 'platform', 'conversation-owners.json'));
    assert.strictEqual(again.get(ID_A), alice.user.id);
  });

  it('points the skills panel at ~/.claude for everyone', function () {
    assert.strictEqual(server.skillsContext(undefined, bob.user.id).claudeConfigDir, null);
    assert.strictEqual(server.skillsContext(undefined, null).claudeConfigDir, null);
  });
});
