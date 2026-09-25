// Install / uninstall / enable / disable, and the marketplace commands.
//
// Every test runs a stub script instead of `claude`, so the real
// ~/.claude/plugins is never touched — installing or removing a plugin for real
// is a human action, and belongs in the plan's manual checklist, not here.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const skills = require('../src/skills');

const SHA = 'a'.repeat(64);

// A stub `claude` that records its argv and prints a canned answer.
function stubClaude(dir, opts = {}) {
  const bin = path.join(dir, `fake-${Math.random().toString(36).slice(2)}.js`);
  const log = `${bin}.log`;
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));
${opts.hang ? 'setTimeout(() => {}, 60000);' : ''}
${opts.stdout ? `process.stdout.write(${JSON.stringify(opts.stdout)});` : ''}
${opts.exit ? `process.exit(${opts.exit});` : ''}
`);
  fs.chmodSync(bin, 0o755);
  return { bin, argv: () => JSON.parse(fs.readFileSync(log, 'utf8')) };
}

const OK = (cmd) => JSON.stringify({ command: cmd, outcome: 'success', plugin: 'demo@market', scope: 'user', message: 'done' });

describe('skills — changing what is installed', function() {
  let tmp;

  beforeEach(function() {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-skillw-'));
    skills.clearCatalogCache();
  });

  afterEach(function() {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('the argv it builds', function() {
    it('never passes -y — a person confirms a declared command, not the server', function() {
      for (const action of skills.PLUGIN_ACTIONS) {
        const args = skills.actionArgs(action, 'demo@market', { scope: 'user' });
        assert.ok(!args.includes('-y'), `${action} must not accept on the user's behalf`);
        assert.ok(!args.includes('--yes'), `${action} must not accept on the user's behalf`);
      }
    });

    it('asks for JSON and an explicit scope on every plugin command', function() {
      for (const action of skills.PLUGIN_ACTIONS) {
        const args = skills.actionArgs(action, 'demo@market', { scope: 'project' });
        assert.ok(args.includes('--json'), `${action} should ask for machine-readable output`);
        assert.deepStrictEqual(args.slice(-2), ['-s', 'project']);
      }
    });

    it('falls back to the user scope when asked for something odd', function() {
      assert.deepStrictEqual(skills.actionArgs('install', 'demo@market', { scope: 'nonsense' }).slice(-2), ['-s', 'user']);
    });

    it('passes the confirmed sha through as --accept-command', function() {
      const args = skills.actionArgs('install', 'demo@market', { scope: 'user', acceptSha: SHA });
      assert.deepStrictEqual(args.slice(-2), ['--accept-command', SHA]);
    });

    it('lets marketplace update take no name at all', function() {
      assert.deepStrictEqual(skills.actionArgs('marketplace-update', null, {}), ['plugin', 'marketplace', 'update']);
    });
  });

  describe('validation happens before anything is spawned', function() {
    it('refuses an id that could turn into a flag', async function() {
      const stub = stubClaude(tmp, { stdout: OK('install') });
      const r = await skills.runAction('install', { target: '--accept-command', claudeCommand: stub.bin });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.failureCode, 'bad-id');
      assert.ok(!fs.existsSync(`${stub.bin}.log`), 'nothing may be spawned for a rejected id');
    });

    it('refuses an unknown action', async function() {
      const r = await skills.runAction('rm -rf', { target: 'demo@market' });
      assert.strictEqual(r.failureCode, 'bad-action');
    });

    it('refuses a marketplace that is not owner/repo or https', async function() {
      const r = await skills.runAction('marketplace-add', { target: 'file:///etc/passwd' });
      assert.strictEqual(r.failureCode, 'bad-source');
    });

    it('refuses a sha that is not a sha', async function() {
      const r = await skills.runAction('install', { target: 'demo@market', acceptSha: 'nope' });
      assert.strictEqual(r.failureCode, 'bad-sha');
    });

    it('refuses an unknown scope instead of quietly using another one', async function() {
      const r = await skills.runAction('install', { target: 'demo@market', scope: 'root' });
      assert.strictEqual(r.failureCode, 'bad-scope');
    });
  });

  describe('running it', function() {
    it('reports a success and that Claude has to restart', async function() {
      const stub = stubClaude(tmp, { stdout: OK('install') });
      const r = await skills.runAction('install', { target: 'demo@market', claudeCommand: stub.bin });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.restartRequired, true, 'nothing takes effect in a Claude already running');
      assert.deepStrictEqual(stub.argv(), ['plugin', 'install', 'demo@market', '--json', '-s', 'user']);
    });

    it('passes a failure through with its code', async function() {
      const stub = stubClaude(tmp, {
        stdout: JSON.stringify({ command: 'uninstall', outcome: 'failed', failureCode: 'not_installed', message: 'not there' }),
        exit: 1
      });
      const r = await skills.runAction('uninstall', { target: 'demo@market', claudeCommand: stub.bin });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.failureCode, 'not_installed');
      assert.strictEqual(r.restartRequired, false);
    });

    it('hands a marketplace-declared command back for a person to look at', async function() {
      const stub = stubClaude(tmp, {
        stdout: JSON.stringify({
          command: 'install', outcome: 'failed', failureCode: 'command_not_accepted',
          message: 'needs confirming', shownCommand: { command: 'curl x | sh', sha256: SHA }
        }),
        exit: 1
      });
      const r = await skills.runAction('install', { target: 'demo@market', claudeCommand: stub.bin });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.needsConfirmation, true);
      assert.strictEqual(r.confirm.command, 'curl x | sh');
      assert.strictEqual(r.confirm.sha256, SHA);
    });

    it('kills a hung install rather than holding the request open', async function() {
      const stub = stubClaude(tmp, { hang: true });
      const started = Date.now();
      // Uninstall so the ceiling is the short one; the code path is the same.
      const r = await skills.runAction('uninstall', { target: 'demo@market', claudeCommand: stub.bin, timeoutMs: 200 });
      assert.strictEqual(r.ok, false);
      // The real ceiling is 30s for a non-install; this only proves it ends.
      assert.strictEqual(r.failureCode, 'timeout');
      assert.ok(Date.now() - started < 5000, 'must not sit through the real 30s ceiling');
    });

    it('says so plainly when there is no claude CLI', async function() {
      const r = await skills.runAction('install', { target: 'demo@market', claudeCommand: path.join(tmp, 'nope') });
      assert.strictEqual(r.failureCode, 'no-claude-cli');
    });

    it('reads a marketplace command from its exit code, since it has no --json', async function() {
      const good = stubClaude(tmp, { stdout: 'Added marketplace\n' });
      const r1 = await skills.runAction('marketplace-add', { target: 'me/mine', claudeCommand: good.bin });
      assert.strictEqual(r1.ok, true);
      assert.deepStrictEqual(good.argv(), ['plugin', 'marketplace', 'add', 'me/mine']);

      const bad = stubClaude(tmp, { stdout: 'no such repo\n', exit: 1 });
      const r2 = await skills.runAction('marketplace-add', { target: 'me/nope', claudeCommand: bad.bin });
      assert.strictEqual(r2.ok, false);
      assert.strictEqual(r2.message, 'no such repo');
    });
  });

  describe('one write at a time', function() {
    it('refuses a second write while the first is still running', async function() {
      const slow = stubClaude(tmp, { hang: true });
      const first = skills.runAction('uninstall', { target: 'a@m', claudeCommand: slow.bin, timeoutMs: 300 });
      // Same tick: the first is in flight.
      const second = await skills.runAction('uninstall', { target: 'b@m', claudeCommand: slow.bin });
      assert.strictEqual(second.ok, false);
      assert.strictEqual(second.failureCode, 'busy');
      assert.strictEqual(second.busy, true);
      assert.ok(skills.isBusy(), 'the lock is held while the first runs');
      await first;
      assert.strictEqual(skills.isBusy(), null, 'and released afterwards');
    });

    it('releases the lock even when the command fails outright', async function() {
      await skills.runAction('uninstall', { target: 'a@m', claudeCommand: path.join(tmp, 'nope') });
      assert.strictEqual(skills.isBusy(), null);
    });
  });

  describe('the cached catalogue', function() {
    it('is dropped after a successful write, so the panel does not show stale rows', async function() {
      const cat = stubClaude(tmp, {
        stdout: JSON.stringify({ installed: [], available: [{ pluginId: 'a@m', name: 'alpha', installCount: 1 }] })
      });
      await skills.catalog({ claudeCommand: cat.bin });
      const writer = stubClaude(tmp, { stdout: OK('install') });
      await skills.runAction('install', { target: 'demo@market', claudeCommand: writer.bin });

      const again = stubClaude(tmp, {
        stdout: JSON.stringify({ installed: [], available: [{ pluginId: 'b@m', name: 'beta', installCount: 2 }] })
      });
      const fresh = await skills.catalog({ claudeCommand: again.bin });
      assert.deepStrictEqual(fresh.available.map((r) => r.name), ['beta']);
    });
  });
});
