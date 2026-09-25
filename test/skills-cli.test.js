// The `claude plugin` CLI is an external contract this panel depends on.
// These fixtures are what it really printed on 2.1.280 (2026-09-26), so a CLI
// upgrade that renames a field fails here — loudly — instead of leaving the
// panel silently empty. Nothing in this file runs the CLI.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const skills = require('../src/skills');

const F = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'plugin-cli.json'), 'utf8'));

describe('skills — CLI output contract', function() {
  describe('plugin list --json', function() {
    it('reads id, scope, enabled and installPath', function() {
      const rows = skills.parseInstalled(F.list);
      assert.strictEqual(rows.length, 2);
      const karpathy = rows[0];
      assert.strictEqual(karpathy.id, 'andrej-karpathy-skills@karpathy-skills');
      assert.strictEqual(karpathy.name, 'andrej-karpathy-skills');
      assert.strictEqual(karpathy.marketplace, 'karpathy-skills');
      assert.strictEqual(karpathy.scope, 'project');
      assert.strictEqual(karpathy.enabled, false);
      assert.strictEqual(karpathy.projectPath, '/home/u/work/some-project');
      assert.strictEqual(karpathy.kind, 'plugin');
    });

    it('treats a missing `enabled` as enabled, not as disabled', function() {
      const rows = skills.parseInstalled('[{"id":"x@m","installPath":"/p"}]');
      assert.strictEqual(rows[0].enabled, true);
    });

    it('returns [] rather than throwing on garbage', function() {
      assert.deepStrictEqual(skills.parseInstalled('not json'), []);
      assert.deepStrictEqual(skills.parseInstalled(''), []);
      assert.deepStrictEqual(skills.parseInstalled('{"not":"an array"}'), []);
    });

    it('drops entries with no id instead of listing a blank row', function() {
      assert.deepStrictEqual(skills.parseInstalled('[{"version":"1"},null]'), []);
    });
  });

  describe('plugin list --available --json', function() {
    it('splits installed from available and keeps installCount', function() {
      const cat = skills.parseCatalog(F.available);
      assert.strictEqual(cat.installed.length, 1);
      assert.strictEqual(cat.available.length, 3);
      const sdk = cat.available.find((p) => p.name === 'agent-sdk-dev');
      assert.strictEqual(sdk.id, 'agent-sdk-dev@claude-plugins-official');
      assert.strictEqual(sdk.marketplace, 'claude-plugins-official');
      assert.strictEqual(sdk.installCount, 70287);
      assert.ok(sdk.description.includes('Agent SDK'));
    });

    it('flattens the object form of `source` into one readable line with the sha', function() {
      const cat = skills.parseCatalog(F.available);
      const adobe = cat.available.find((p) => p.name === 'adobe-for-creativity');
      // A person deciding whether to install needs to see WHERE the code comes
      // from, not a rendered [object Object].
      assert.ok(adobe.source.includes('https://github.com/adobe/skills.git'));
      assert.ok(adobe.source.includes('plugins/creative-cloud/adobe-for-creativity'));
      assert.ok(adobe.source.includes('304aa23'), 'the pinned sha is part of the provenance');
      assert.ok(!adobe.source.includes('[object'));
    });

    it('keeps the string form of `source` as is', function() {
      const cat = skills.parseCatalog(F.available);
      assert.strictEqual(cat.available.find((p) => p.name === 'code-review').source, './plugins/code-review');
    });

    it('survives a missing available section', function() {
      assert.deepStrictEqual(skills.parseCatalog('{"installed":[]}'), { installed: [], available: [] });
      assert.deepStrictEqual(skills.parseCatalog('nope'), { installed: [], available: [] });
    });
  });

  describe('write commands', function() {
    it('reads a success', function() {
      const r = skills.parseActionResult(F.install_ok, '');
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.command, 'install');
      assert.strictEqual(r.plugin, 'demo@claude-plugins-official');
      assert.strictEqual(r.version, '1.0.0');
      assert.ok(r.message.includes('Restart required'));
    });

    it('reads a failure and its failureCode', function() {
      const r = skills.parseActionResult(F.uninstall_failed, '');
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.failureCode, 'not_installed');
      assert.ok(r.message.includes('not found in installed plugins'));
    });

    it('finds the JSON line even though --json also prints a human line', function() {
      // Measured: a failed uninstall printed the JSON line AND a red ✘ line,
      // despite --json documenting "instead of the human message".
      assert.ok(F.uninstall_failed.includes('✘'), 'fixture really does carry the human line');
      const r = skills.parseActionResult(F.uninstall_failed, '');
      assert.strictEqual(r.failureCode, 'not_installed');
    });

    it('strips ANSI out of the message', function() {
      const r = skills.parseActionResult(F.uninstall_ok, '');
      assert.strictEqual(r.ok, true);
      assert.ok(!/\u001b\[/.test(r.message));
    });

    it('surfaces a marketplace-declared command for a person to confirm', function() {
      const r = skills.parseActionResult(F.install_needs_confirmation, '');
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.needsConfirmation, true);
      assert.strictEqual(r.confirm.command, 'curl -fsSL https://example.test/install.sh | sh');
      assert.strictEqual(r.confirm.sha256.length, 64);
    });

    it('does not claim a confirmation when the sha is not a sha', function() {
      // Degrade to a plain failure rather than sending the browser a button
      // that would pass junk to --accept-command.
      const bogus = '{"command":"install","outcome":"failed","shownCommand":{"command":"x","sha256":"nope"}}';
      const r = skills.parseActionResult(bogus, '');
      assert.strictEqual(r.ok, false);
      assert.ok(!r.needsConfirmation);
    });

    it('reports the human line when there is no JSON at all', function() {
      const r = skills.parseActionResult('', '\u001b[31mSomething broke\u001b[0m\n');
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.failureCode, 'unparsable');
      assert.strictEqual(r.message, 'Something broke');
    });
  });

  describe('marketplaces', function() {
    it('reads the array form', function() {
      const m = skills.parseMarketplaces(F.marketplace_list);
      assert.strictEqual(m.length, 1);
      assert.strictEqual(m[0].name, 'claude-plugins-official');
      assert.ok(m[0].source.includes('anthropics/claude-plugins-official'));
    });

    it('reads the keyed-object form known_marketplaces.json uses', function() {
      const m = skills.parseMarketplaces('{"mine":{"source":{"source":"github","repo":"me/mine"}}}');
      assert.strictEqual(m[0].name, 'mine');
      assert.ok(m[0].source.includes('me/mine'));
    });
  });

  describe('argument validation', function() {
    it('accepts real ids', function() {
      assert.ok(skills.validId('code-review'));
      assert.ok(skills.validId('code-review@claude-plugins-official'));
      assert.ok(skills.validId('a.b_c-1@m.2'));
    });

    it('refuses anything that could land in an argument position as a flag or a path', function() {
      for (const bad of ['', '-y', '--json', 'a b', 'a;b', 'a/b', '../etc', 'a@b@c', 'a'.repeat(200), null, 42]) {
        assert.strictEqual(skills.validId(bad), false, `should refuse ${JSON.stringify(bad)}`);
      }
    });

    it('accepts owner/repo and https marketplaces, refuses the rest', function() {
      assert.ok(skills.validMarketplaceSource('anthropics/claude-plugins-official'));
      assert.ok(skills.validMarketplaceSource('https://github.com/me/mine'));
      for (const bad of ['http://insecure/x', 'file:///etc/passwd', '--scope', 'no-slash', '', null]) {
        assert.strictEqual(skills.validMarketplaceSource(bad), false, `should refuse ${JSON.stringify(bad)}`);
      }
    });

    it('accepts only a real sha256', function() {
      assert.ok(skills.validSha('9f2c1b0e5d4a3f88776655443322110099887766554433221100998877665544'));
      assert.strictEqual(skills.validSha('abc'), false);
      assert.strictEqual(skills.validSha('g'.repeat(64)), false);
    });
  });

  describe('SKILL.md frontmatter', function() {
    it('reads name and a single-line description', function() {
      const fm = skills.parseSkillFrontmatter('---\nname: ponytail\ndescription: Do the laziest thing that works\n---\n\n# Body\n');
      assert.strictEqual(fm.name, 'ponytail');
      assert.strictEqual(fm.description, 'Do the laziest thing that works');
    });

    it('folds a `description: >` block into one line', function() {
      // This is the real shape of ~/.claude/skills/github-analyzer/SKILL.md.
      const fm = skills.parseSkillFrontmatter('---\nname: github-analyzer\ndescription: >\n  Deep analysis of a GitHub repository.\n  Covers tech stack and architecture.\n---\n');
      assert.strictEqual(fm.name, 'github-analyzer');
      assert.strictEqual(fm.description, 'Deep analysis of a GitHub repository. Covers tech stack and architecture.');
    });

    it('drops the quotes around a quoted value', function() {
      assert.strictEqual(skills.parseSkillFrontmatter('---\nname: "quoted"\n---\n').name, 'quoted');
    });

    it('returns {} for a file with no frontmatter', function() {
      assert.deepStrictEqual(skills.parseSkillFrontmatter('# Just a heading\n'), {});
      assert.deepStrictEqual(skills.parseSkillFrontmatter(''), {});
    });
  });
});
