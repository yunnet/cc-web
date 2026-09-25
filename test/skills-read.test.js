// Reading what is installed: the two skills directories off disk, the plugin
// list off the CLI, and the two together.
//
// HOME is pointed at a temp directory for the whole file, so nothing here can
// read — let alone touch — the real ~/.claude. The "claude" binary is a stub
// script written into that temp directory; no real CLI is ever run.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const skills = require('../src/skills');

function writeSkill(root, name, frontmatter, body) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `${frontmatter}\n${body || '# body\n'}`);
  return dir;
}

// A stub standing in for `claude`: prints whatever we tell it to, and records
// each call so a test can prove the cache stopped a second one.
function stubClaude(dir, stdout, opts = {}) {
  const bin = path.join(dir, 'fake-claude.js');
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
${opts.hang ? 'setTimeout(() => {}, 60000);' : `process.stdout.write(${JSON.stringify(stdout)});`}
`);
  fs.chmodSync(bin, 0o755);
  return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []) };
}

const LIST_JSON = JSON.stringify([
  { id: 'demo@market', version: '1.0.0', scope: 'user', enabled: true, installPath: null }
]);

describe('skills — reading what is installed', function() {
  let tmp;
  let prevHome;

  beforeEach(function() {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-skills-'));
    prevHome = process.env.HOME;
    process.env.HOME = tmp;
    skills.clearCatalogCache();
  });

  afterEach(function() {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('a skills directory', function() {
    it('lists one skill per <name>/SKILL.md, with its frontmatter', function() {
      const root = path.join(tmp, 'skills');
      writeSkill(root, 'ponytail', '---\nname: ponytail\ndescription: Do the laziest thing that works\n---');
      const rows = skills.listDirSkills(root, 'user');
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].name, 'ponytail');
      assert.strictEqual(rows[0].description, 'Do the laziest thing that works');
      assert.strictEqual(rows[0].kind, 'user');
      assert.strictEqual(rows[0].id, 'user:ponytail');
    });

    it('falls back to the directory name when there is no frontmatter', function() {
      const root = path.join(tmp, 'skills');
      writeSkill(root, 'bare', '# no frontmatter here');
      const rows = skills.listDirSkills(root, 'user');
      assert.strictEqual(rows[0].name, 'bare');
      assert.strictEqual(rows[0].description, '');
    });

    it('ignores a directory with no SKILL.md, a loose file, and dotfiles', function() {
      const root = path.join(tmp, 'skills');
      writeSkill(root, 'real', '---\nname: real\n---');
      fs.mkdirSync(path.join(root, 'empty-dir'), { recursive: true });
      fs.writeFileSync(path.join(root, 'loose.md'), 'x');
      writeSkill(root, '.hidden', '---\nname: hidden\n---');
      const rows = skills.listDirSkills(root, 'user');
      assert.deepStrictEqual(rows.map((r) => r.name), ['real']);
    });

    it('returns [] for a directory that does not exist, rather than throwing', function() {
      assert.deepStrictEqual(skills.listDirSkills(path.join(tmp, 'nope'), 'user'), []);
    });

    it('stops at MAX_DIR_SKILLS so one directory cannot stall the server', function() {
      const root = path.join(tmp, 'skills');
      for (let i = 0; i < skills.MAX_DIR_SKILLS + 10; i++) writeSkill(root, `s${i}`, '---\nname: s\n---');
      assert.strictEqual(skills.listDirSkills(root, 'user').length, skills.MAX_DIR_SKILLS);
    });

    it('marks a directory this process cannot delete as read-only', function() {
      if (typeof process.getuid === 'function' && process.getuid() === 0) return this.skip(); // root can delete anything
      const root = path.join(tmp, 'skills');
      const dir = writeSkill(root, 'locked', '---\nname: locked\n---');
      fs.chmodSync(dir, 0o555);
      try {
        const row = skills.listDirSkills(root, 'user').find((r) => r.name === 'locked');
        assert.strictEqual(row.readOnly, true, 'a skill owned by someone else must not offer an uninstall button');
      } finally {
        fs.chmodSync(dir, 0o755);
      }
    });

    it('reads only a prefix, so a huge SKILL.md costs the same as a real one', function() {
      const root = path.join(tmp, 'skills');
      const dir = path.join(root, 'huge');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: huge\ndescription: short\n---\n${'x'.repeat(2 * 1024 * 1024)}`);
      const row = skills.listDirSkills(root, 'user')[0];
      assert.strictEqual(row.name, 'huge');
      assert.strictEqual(row.description, 'short');
    });
  });

  describe("a plugin's own skills", function() {
    it('names what the plugin teaches Claude', function() {
      const install = path.join(tmp, 'cache', 'demo', '1.0.0');
      writeSkill(path.join(install, 'skills'), 'review', '---\nname: review\ndescription: Review a PR\n---');
      writeSkill(path.join(install, 'skills'), 'ship', '---\nname: ship\n---');
      const rows = skills.pluginSkills(install);
      assert.deepStrictEqual(rows.map((r) => r.name), ['review', 'ship']);
      assert.strictEqual(rows[0].description, 'Review a PR');
    });

    it('is empty for a plugin with no skills, and for no install path', function() {
      assert.deepStrictEqual(skills.pluginSkills(path.join(tmp, 'nothing')), []);
      assert.deepStrictEqual(skills.pluginSkills(null), []);
    });
  });

  describe('listInstalled', function() {
    it('merges plugins with the user and project skills directories', async function() {
      const stub = stubClaude(tmp, LIST_JSON);
      writeSkill(path.join(tmp, '.claude', 'skills'), 'mine', '---\nname: mine\n---');
      const project = path.join(tmp, 'proj');
      writeSkill(path.join(project, '.claude', 'skills'), 'theirs', '---\nname: theirs\n---');

      const out = await skills.listInstalled({ claudeCommand: stub.bin, workingDir: project });
      assert.deepStrictEqual(out.plugins.map((p) => p.id), ['demo@market']);
      assert.deepStrictEqual(out.skills.map((s) => `${s.kind}:${s.name}`), ['user:mine', 'project:theirs']);
      assert.strictEqual(out.problem, null);
    });

    it('still lists the directory skills when there is no claude CLI at all', async function() {
      writeSkill(path.join(tmp, '.claude', 'skills'), 'mine', '---\nname: mine\n---');
      const out = await skills.listInstalled({ claudeCommand: path.join(tmp, 'not-a-binary') });
      assert.deepStrictEqual(out.plugins, []);
      assert.deepStrictEqual(out.skills.map((s) => s.name), ['mine']);
      assert.strictEqual(out.problem, 'no-claude-cli', 'the panel must be able to say why the plugin half is empty');
    });

    it('has no project section when the session has no working directory', async function() {
      const stub = stubClaude(tmp, LIST_JSON);
      const out = await skills.listInstalled({ claudeCommand: stub.bin });
      assert.strictEqual(out.projectSkillsDir, null);
    });
  });

  describe('catalog', function() {
    const AVAILABLE = JSON.stringify({
      installed: [],
      available: [
        { pluginId: 'a@m', name: 'alpha', description: 'about typescript', installCount: 10 },
        { pluginId: 'b@m', name: 'beta', description: 'about go', installCount: 500 }
      ]
    });

    it('parses and sorts by install count', async function() {
      const stub = stubClaude(tmp, AVAILABLE);
      const cat = await skills.catalog({ claudeCommand: stub.bin });
      assert.deepStrictEqual(skills.filterCatalog(cat.available).map((r) => r.name), ['beta', 'alpha']);
    });

    it('serves a second call from cache instead of spawning again', async function() {
      const stub = stubClaude(tmp, AVAILABLE);
      await skills.catalog({ claudeCommand: stub.bin });
      await skills.catalog({ claudeCommand: stub.bin });
      assert.strictEqual(stub.calls().length, 1, 'a double click must not spawn two CLIs');
    });

    it('does not cache a failure, so a blip is not sticky', async function() {
      const bad = stubClaude(tmp, 'not json');
      await skills.catalog({ claudeCommand: bad.bin });
      await skills.catalog({ claudeCommand: bad.bin });
      assert.strictEqual(bad.calls().length, 2);
    });

    it('reports a missing CLI rather than an empty catalogue', async function() {
      const cat = await skills.catalog({ claudeCommand: path.join(tmp, 'not-a-binary') });
      assert.strictEqual(cat.problem, 'no-claude-cli');
      assert.deepStrictEqual(cat.available, []);
    });
  });

  describe('filterCatalog', function() {
    const rows = [
      { name: 'alpha', description: 'typescript things', marketplace: 'm', installCount: 10 },
      { name: 'beta', description: 'go things', marketplace: 'm', installCount: 500 },
      { name: 'typescript-lsp', description: 'language server', marketplace: 'm', installCount: 1 }
    ];

    it('matches name and description, case-insensitively', function() {
      assert.deepStrictEqual(skills.filterCatalog(rows, 'TYPESCRIPT').map((r) => r.name), ['alpha', 'typescript-lsp']);
    });

    it('returns everything for an empty query, most-installed first', function() {
      assert.deepStrictEqual(skills.filterCatalog(rows, '').map((r) => r.name), ['beta', 'alpha', 'typescript-lsp']);
    });

    it('honours a limit', function() {
      assert.strictEqual(skills.filterCatalog(rows, '', 2).length, 2);
    });
  });

  describe('runCli', function() {
    it('kills a hung command at the timeout instead of waiting for it', async function() {
      // The real reason this exists: `claude plugin install <bad id>` produced
      // nothing for 90s when measured on 2.1.280.
      const stub = stubClaude(tmp, '', { hang: true });
      const started = Date.now();
      const res = await skills.runCli(stub.bin, ['plugin', 'list'], { timeoutMs: 300 });
      assert.strictEqual(res.timedOut, true);
      assert.ok(Date.now() - started < 5000, 'must not wait for the hung process');
    });

    it('reports a missing binary as missing, not as a crash', async function() {
      const res = await skills.runCli(path.join(tmp, 'nope'), ['plugin', 'list']);
      assert.strictEqual(res.missing, true);
      assert.strictEqual(res.ok, false);
    });
  });
});
