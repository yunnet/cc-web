const assert = require('assert');
const { ClaudeCodeWebServer } = require('../src/server');

// The Settings panel shows which Claude Code is installed and what npm has.
// Two things here are easy to get wrong and expensive to notice: comparing
// versions as strings (2.1.9 would beat 2.1.10), and letting a slow or absent
// network turn "show me my version" into a hung panel.
function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; }
  };
}

describe('claude version info', function () {
  let server;

  beforeEach(function () {
    server = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
  });

  afterEach(function () {
    if (server && typeof server.dispose === 'function') server.dispose();
    server = null;
  });

  describe('parsing', function () {
    it('pulls the version out of what the CLI actually prints', function () {
      // Real output, captured: "2.1.247 (Claude Code)".
      assert.strictEqual(ClaudeCodeWebServer.parseClaudeVersion('2.1.247 (Claude Code)\n'), '2.1.247');
      assert.strictEqual(ClaudeCodeWebServer.parseClaudeVersion('  1.0.0 (Claude Code)'), '1.0.0');
    });

    it('returns null rather than a guess when the output is unfamiliar', function () {
      for (const junk of ['', 'command not found', 'Claude Code', null, undefined, '2.1']) {
        assert.strictEqual(ClaudeCodeWebServer.parseClaudeVersion(junk), null, `junk: ${JSON.stringify(junk)}`);
      }
    });
  });

  describe('comparison', function () {
    it('compares numerically, not as strings', function () {
      // The whole point: '2.1.9' > '2.1.10' as strings, and that would report
      // "up to date" to someone who is ten patches behind.
      assert.ok(ClaudeCodeWebServer.compareVersions('2.1.10', '2.1.9') > 0);
      assert.ok(ClaudeCodeWebServer.compareVersions('2.1.9', '2.1.10') < 0);
      assert.ok(ClaudeCodeWebServer.compareVersions('2.2.0', '2.10.0') < 0);
      assert.strictEqual(ClaudeCodeWebServer.compareVersions('2.1.247', '2.1.247'), 0);
      assert.ok(ClaudeCodeWebServer.compareVersions('3.0.0', '2.99.99') > 0);
    });

    it('treats an unknown version as not comparable', function () {
      assert.strictEqual(ClaudeCodeWebServer.compareVersions(null, '2.1.0'), null);
      assert.strictEqual(ClaudeCodeWebServer.compareVersions('2.1.0', null), null);
    });
  });

  describe('the endpoint', function () {
    it('reports an update when the registry is ahead', async function () {
      server.claudeVersion = async () => '2.1.247';
      server.latestVersions = async () => ({ latest: '2.1.261', stable: '2.1.236' });

      const res = mockRes();
      await server.getVersionInfo({}, res);

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.current, '2.1.247');
      assert.strictEqual(res.body.latest, '2.1.261');
      assert.strictEqual(res.body.stable, '2.1.236');
      assert.strictEqual(res.body.updateAvailable, true);
    });

    it('does not claim an update when the installed build is newer than latest', async function () {
      // Happens on a prerelease or a locally built CLI; "update available" would
      // be actively wrong there.
      server.claudeVersion = async () => '2.2.0';
      server.latestVersions = async () => ({ latest: '2.1.261', stable: '2.1.236' });

      const res = mockRes();
      await server.getVersionInfo({}, res);
      assert.strictEqual(res.body.updateAvailable, false);
    });

    it('still answers with the local version when the network is unavailable', async function () {
      // The panel's first job is "which Claude am I running". Losing the registry
      // must not cost you that.
      server.claudeVersion = async () => '2.1.247';
      server.latestVersions = async () => null;

      const res = mockRes();
      await server.getVersionInfo({}, res);

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.current, '2.1.247');
      assert.strictEqual(res.body.latest, null);
      assert.strictEqual(res.body.updateAvailable, null, 'unknown, not false');
    });

    it('answers even when the CLI cannot be run', async function () {
      server.claudeVersion = async () => null;
      server.latestVersions = async () => ({ latest: '2.1.261', stable: '2.1.236' });

      const res = mockRes();
      await server.getVersionInfo({}, res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.current, null);
      assert.strictEqual(res.body.updateAvailable, null);
    });
  });

  describe('caching', function () {
    it('does not hit the registry again inside the TTL', async function () {
      // Opening Settings took ~6s against the real registry. Without a cache
      // that cost would be paid on every open.
      let calls = 0;
      server._fetchDistTags = async () => { calls++; return { latest: '2.1.261', stable: '2.1.236' }; };

      const a = await server.latestVersions();
      const b = await server.latestVersions();
      assert.deepStrictEqual(a, b);
      assert.strictEqual(calls, 1, 'second call should have been served from cache');
    });

    it('does not cache a failure, so a blip is not sticky for hours', async function () {
      let calls = 0;
      server._fetchDistTags = async () => { calls++; return null; };
      await server.latestVersions();
      await server.latestVersions();
      assert.strictEqual(calls, 2);
    });
  });
});
