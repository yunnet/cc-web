// Skills: what Claude already knows how to do, and what it could.
//
// A "skill" reaches Claude from three different places, and they are not one
// mechanism wearing three hats:
//
//   plugin        ~/.claude/plugins/cache/<market>/<plugin>/<version>/skills/*/SKILL.md
//                 installed and removed by `claude plugin`, listed by a market
//   user skill    ~/.claude/skills/<name>/SKILL.md        (every project)
//   project skill <workingDir>/.claude/skills/<name>/SKILL.md
//
// Only the first has a catalogue, an installer and an on/off switch, so it is
// the unit this panel installs. The other two are directories: they are listed
// and read, never installed. Measured on 2.1.280 (2026-09-26):
//
//   claude plugin list --json              0.34s
//   claude plugin list --available --json  0.44s, 180 KB, 299 installable
//
// Fast enough that nothing here needs a background refresh — this server has
// been brought to its knees once already by a scan on a timer.
//
// The first half of the file is pure parsing and validation, so the contract
// tests can hold it against fixtures taken from the real CLI
// (test/fixtures/plugin-cli.json) without running anything. The IO half is
// below, under "── Reading what is installed".

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { readPrefix } = require('./utils/read-prefix');
// Killing a timed-out `claude` means killing what it forked (git, curl, npm).
// git-branches already solved exactly this, including the experiment showing
// process groups are the wrong tool here — reuse it rather than repeat it.
const { killTree } = require('./git-branches');

// A plugin id is `name` or `name@marketplace`. Everything reaching the CLI is
// checked against this first. execFile already passes an argv array and never a
// shell, so this is not the thing standing between a user and injection — it is
// what keeps a malformed id from becoming a confusing CLI error three layers
// down, and what keeps `--anything` out of the argument position.
const ID_RE = /^[A-Za-z0-9._-]{1,64}(@[A-Za-z0-9._-]{1,64})?$/;
// A marketplace is a GitHub `owner/repo` or an https URL.
const REPO_RE = /^[A-Za-z0-9._-]{1,64}\/[A-Za-z0-9._-]{1,100}$/;

function validId(id) {
  return typeof id === 'string' && ID_RE.test(id) && !id.startsWith('-');
}

function validMarketplaceSource(src) {
  if (typeof src !== 'string' || !src || src.startsWith('-')) return false;
  if (REPO_RE.test(src)) return true;
  try {
    const u = new URL(src);
    return u.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

// A sha256 as the CLI prints it for a marketplace-declared command.
function validSha(sha) {
  return typeof sha === 'string' && /^[a-f0-9]{64}$/i.test(sha);
}

function parseJson(text) {
  try { return JSON.parse(text); } catch (_) { return null; }
}

// `claude plugin list --json` — a pretty-printed array over many lines.
function parseInstalled(stdout) {
  const data = parseJson(stdout);
  if (!Array.isArray(data)) return [];
  return data
    .filter((p) => p && typeof p.id === 'string')
    .map((p) => ({
      id: p.id,
      name: String(p.id).split('@')[0],
      marketplace: String(p.id).split('@')[1] || null,
      version: p.version || null,
      scope: p.scope || 'user',
      enabled: p.enabled !== false,
      installPath: typeof p.installPath === 'string' ? p.installPath : null,
      projectPath: typeof p.projectPath === 'string' ? p.projectPath : null,
      installedAt: p.installedAt || null,
      lastUpdated: p.lastUpdated || null,
      kind: 'plugin'
    }));
}

// `claude plugin list --available --json` — { installed, available }.
// `source` is either a string (a path inside the marketplace repo) or an object
// carrying the git url and the exact sha. The panel shows whichever it gets:
// this is what a person needs to judge "where is this code from" before
// installing it.
function parseCatalog(stdout) {
  const data = parseJson(stdout);
  if (!data || typeof data !== 'object') return { installed: [], available: [] };
  const available = Array.isArray(data.available) ? data.available : [];
  return {
    installed: parseInstalled(JSON.stringify(data.installed || [])),
    available: available
      .filter((p) => p && typeof p.pluginId === 'string')
      .map((p) => ({
        id: p.pluginId,
        name: p.name || String(p.pluginId).split('@')[0],
        description: typeof p.description === 'string' ? p.description : '',
        marketplace: p.marketplaceName || String(p.pluginId).split('@')[1] || null,
        installCount: Number.isFinite(p.installCount) ? p.installCount : 0,
        source: sourceSummary(p.source)
      }))
  };
}

// One line a person can read: "github.com/adobe/skills.git @ 304aa23" or the
// in-repo path. Never an object the UI would have to render blind.
function sourceSummary(source) {
  if (!source) return null;
  if (typeof source === 'string') return source;
  if (typeof source !== 'object') return null;
  const url = typeof source.url === 'string' ? source.url : (typeof source.repo === 'string' ? source.repo : null);
  const parts = [];
  if (url) parts.push(url);
  if (typeof source.path === 'string' && source.path) parts.push(source.path);
  if (typeof source.sha === 'string' && source.sha) parts.push(source.sha.slice(0, 7));
  else if (typeof source.ref === 'string' && source.ref) parts.push(source.ref);
  return parts.join(' · ') || (typeof source.source === 'string' ? source.source : null);
}

// `claude plugin marketplace list --json`.
function parseMarketplaces(stdout) {
  const data = parseJson(stdout);
  const rows = Array.isArray(data) ? data : (data && typeof data === 'object' ? Object.entries(data).map(([name, v]) => ({ name, ...v })) : []);
  return rows
    .filter((m) => m && typeof m.name === 'string')
    .map((m) => ({
      name: m.name,
      source: sourceSummary(m.source),
      lastUpdated: m.lastUpdated || null
    }));
}

// A write command's result.
//
// `--json` says it prints "one machine-readable result line INSTEAD of the human
// message", but measured on 2.1.280 a failed uninstall printed BOTH: the JSON
// line, then a red ✘ line. So: scan the lines, take the first one that parses
// and names a command. Anything else that arrives is noise to be ignored, not a
// reason to report a failure the CLI did not report.
function parseActionResult(stdout, stderr) {
  const lines = `${stdout || ''}\n${stderr || ''}`.split('\n');
  let result = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    const obj = parseJson(t);
    if (obj && typeof obj === 'object' && typeof obj.command === 'string') { result = obj; break; }
  }
  if (!result) {
    // No machine-readable line at all: report the first human line rather than
    // inventing a reason.
    const human = lines.map((l) => stripAnsi(l).trim()).find(Boolean) || '';
    return { ok: false, failureCode: 'unparsable', message: human || 'the CLI said nothing' };
  }

  const ok = result.outcome === 'success';
  const out = {
    ok,
    command: result.command,
    plugin: typeof result.plugin === 'string' ? result.plugin : null,
    scope: typeof result.scope === 'string' ? result.scope : null,
    version: typeof result.version === 'string' ? result.version : null,
    failureCode: ok ? null : (typeof result.failureCode === 'string' ? result.failureCode : 'failed'),
    message: typeof result.message === 'string' ? stripAnsi(result.message) : ''
  };

  // A plugin that installs by running a marketplace-declared command needs a
  // person to look at that command. We never pass -y: the command and its
  // sha256 go back to the browser, and only a click brings them back as
  // --accept-command. If the shape ever differs from what install --help
  // describes, this simply stays a plain failure.
  const shown = result.shownCommand;
  if (!ok && shown && typeof shown === 'object' && validSha(shown.sha256)) {
    out.needsConfirmation = true;
    out.confirm = { command: String(shown.command || ''), sha256: shown.sha256 };
  }
  return out;
}

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text == null ? '' : text).replace(/\u001b\[[0-9;]*m/g, '');
}

// The `---` frontmatter block at the top of a SKILL.md: `name` and
// `description` are what the panel lists. Only a prefix of the file is ever
// read, so a huge (or hostile) SKILL.md costs the same as a real one.
function parseSkillFrontmatter(text) {
  const s = String(text == null ? '' : text);
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(s);
  if (!m) return {};
  const out = {};
  let key = null;
  for (const raw of m[1].split('\n')) {
    const line = raw.replace(/\r$/, '');
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1];
      const v = kv[2].trim();
      // `description: >` folds the following indented lines into one value.
      out[key] = (v === '>' || v === '|' || v === '>-' || v === '|-') ? '' : unquote(v);
      continue;
    }
    if (key && /^\s+\S/.test(line)) {
      out[key] = `${out[key] ? `${out[key]} ` : ''}${line.trim()}`;
    }
  }
  return out;
}

function unquote(v) {
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

// ── Reading what is installed ───────────────────────────────────────────────

// A SKILL.md's frontmatter sits at the top; 4 KB covers every one on this box
// with room to spare, and caps what a hostile file can cost.
const HEAD_BYTES = 4096;
// Bounds a skills directory the same way listDirectory bounds a folder: this
// server is single-threaded and shared.
const MAX_DIR_SKILLS = 200;
// Per plugin, how many of its own skills to name.
const MAX_PLUGIN_SKILLS = 50;
const READ_TIMEOUT_MS = 30000;
const MAX_BUFFER = 8 * 1024 * 1024;
// `list --available` measured 0.44s — quick enough that the panel can just ask.
// The TTL only stops a double-click from spawning two.
const CATALOG_TTL_MS = 30000;

function userSkillsDir() {
  return path.join(os.homedir(), '.claude', 'skills');
}

function projectSkillsDir(workingDir) {
  return workingDir ? path.join(String(workingDir), '.claude', 'skills') : null;
}

// Can this process actually delete that directory? Three of the skills on this
// machine are owned by root while cc-web runs as the user, so "uninstall" would
// be a button that always fails. The panel greys it out instead, with a reason.
function isWritable(dir) {
  try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch (_) { return false; }
}

// One `<dir>/<name>/SKILL.md` per skill. Anything else in there is not a skill
// and is passed over in silence.
function listDirSkills(root, origin) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return []; }
  const out = [];
  for (const entry of entries) {
    if (out.length >= MAX_DIR_SKILLS) break;
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = path.join(root, entry.name);
    const file = path.join(dir, 'SKILL.md');
    const head = readPrefix(file, HEAD_BYTES);
    if (head === null) continue;
    const fm = parseSkillFrontmatter(head);
    out.push({
      id: `${origin}:${entry.name}`,
      name: fm.name || entry.name,
      dirName: entry.name,
      description: fm.description || '',
      kind: origin,              // 'user' | 'project'
      dir,
      file,
      readOnly: !isWritable(dir)
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// What a plugin actually teaches Claude: its own skills/<name>/SKILL.md.
function pluginSkills(installPath) {
  if (!installPath) return [];
  const root = path.join(installPath, 'skills');
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return []; }
  const out = [];
  for (const entry of entries) {
    if (out.length >= MAX_PLUGIN_SKILLS) break;
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const file = path.join(root, entry.name, 'SKILL.md');
    const head = readPrefix(file, HEAD_BYTES);
    if (head === null) continue;
    const fm = parseSkillFrontmatter(head);
    out.push({ name: fm.name || entry.name, dirName: entry.name, description: fm.description || '', file });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Run a `claude` subcommand and hand back what it said.
//
// Timed by hand rather than with execFile's own `timeout`, and the whole tree
// is killed: `claude plugin install` forks git/npm/curl, and signalling only
// the wrapper leaves those running. Measured 2026-09-26: `install` against an
// id that does not exist produced nothing for 90s before it was killed.
function runCli(claudeCommand, args, opts = {}) {
  const timeoutMs = opts.timeoutMs || READ_TIMEOUT_MS;
  const cwd = opts.cwd && isDirectory(opts.cwd) ? opts.cwd : undefined;
  return new Promise((resolve) => {
    let timer = null;
    let timedOut = false;
    const child = execFile(
      claudeCommand || 'claude',
      args,
      { maxBuffer: MAX_BUFFER, windowsHide: true, cwd, env: { ...process.env } },
      (error, stdout, stderr) => {
        if (timer) clearTimeout(timer);
        if (timedOut) return;
        resolve({
          ok: !error,
          timedOut: false,
          stdout: stdout || '',
          stderr: stderr || '',
          // ENOENT means no `claude` on PATH at all — worth saying plainly
          // rather than showing an empty panel.
          missing: !!(error && error.code === 'ENOENT')
        });
      }
    );
    timer = setTimeout(() => {
      timedOut = true;
      try { killTree(child.pid); } catch (_) { /* already gone */ }
      resolve({ ok: false, timedOut: true, stdout: '', stderr: '', missing: false });
    }, timeoutMs);
  });
}

function isDirectory(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

// Everything Claude can currently draw on, in one list.
//
// Plugins come from the CLI (it owns that state); the two skills directories
// are read straight off disk, because nothing installs or uninstalls them.
async function listInstalled(options = {}) {
  const { claudeCommand, workingDir } = options;
  const res = await runCli(claudeCommand, ['plugin', 'list', '--json'], { cwd: workingDir });
  const plugins = parseInstalled(res.stdout).map((p) => ({ ...p, skills: pluginSkills(p.installPath) }));

  const dirs = listDirSkills(userSkillsDir(), 'user');
  const projectRoot = projectSkillsDir(workingDir);
  const projectSkills = projectRoot ? listDirSkills(projectRoot, 'project') : [];

  return {
    plugins,
    skills: dirs.concat(projectSkills),
    userSkillsDir: userSkillsDir(),
    projectSkillsDir: projectRoot,
    // Why the plugin half may be empty, so the panel can say so instead of
    // looking broken.
    problem: res.missing ? 'no-claude-cli' : (res.timedOut ? 'timeout' : null)
  };
}

let catalogCache = { at: 0, data: null };

// The installable catalogue. 299 entries / 180 KB / 0.44s on this machine, so
// it is fetched on demand and held for half a minute — no background refresh,
// no timer. This server has been brought down once by a scan on a timer.
async function catalog(options = {}) {
  const { claudeCommand, workingDir, force } = options;
  const now = Date.now();
  if (!force && catalogCache.data && now - catalogCache.at < CATALOG_TTL_MS) return catalogCache.data;
  const res = await runCli(claudeCommand, ['plugin', 'list', '--available', '--json'], { cwd: workingDir });
  const parsed = parseCatalog(res.stdout);
  const data = {
    ...parsed,
    problem: res.missing ? 'no-claude-cli' : (res.timedOut ? 'timeout' : null),
    fetchedAt: now
  };
  // A failed fetch is not cached: a network blip should not be sticky.
  if (!data.problem && data.available.length) catalogCache = { at: now, data };
  return data;
}

function clearCatalogCache() {
  catalogCache = { at: 0, data: null };
}

async function listMarketplaces(options = {}) {
  const res = await runCli(options.claudeCommand, ['plugin', 'marketplace', 'list', '--json'], { cwd: options.workingDir });
  return parseMarketplaces(res.stdout);
}

// Search is a plain substring match over name and description — the catalogue
// is 299 rows, so anything cleverer would be dressing up a `filter`.
function filterCatalog(rows, q, limit) {
  const needle = String(q || '').trim().toLowerCase();
  const matched = needle
    ? rows.filter((r) => `${r.name} ${r.description} ${r.marketplace || ''}`.toLowerCase().includes(needle))
    : rows.slice();
  matched.sort((a, b) => (b.installCount || 0) - (a.installCount || 0) || a.name.localeCompare(b.name));
  const n = Number(limit);
  return Number.isFinite(n) && n > 0 ? matched.slice(0, n) : matched;
}

// ── Recommending ────────────────────────────────────────────────────────────

// What a project is, judged by the files that are actually there. Deliberately
// shallow: one readdir of the top level, no walking, no parsing. A wrong guess
// costs a bad suggestion, so it is not worth more than that.
const PROJECT_SIGNALS = [
  { file: 'package.json', words: ['node', 'npm', 'javascript', 'typescript', 'react', 'next', 'eslint', 'jest', 'vitest', 'frontend'] },
  { file: 'tsconfig.json', words: ['typescript', 'lsp'] },
  { file: 'go.mod', words: ['go', 'golang'] },
  { file: 'Cargo.toml', words: ['rust', 'cargo'] },
  { file: 'pyproject.toml', words: ['python', 'pytest', 'django', 'fastapi'] },
  { file: 'requirements.txt', words: ['python', 'pytest', 'django', 'fastapi'] },
  { file: 'pom.xml', words: ['java', 'maven', 'spring'] },
  { file: 'build.gradle', words: ['java', 'kotlin', 'gradle', 'android'] },
  { file: 'Gemfile', words: ['ruby', 'rails'] },
  { file: 'composer.json', words: ['php', 'laravel'] },
  { file: 'Dockerfile', words: ['docker', 'container', 'kubernetes', 'devops'] },
  { file: '.git', words: ['git', 'commit', 'pull request', 'review', 'changelog'] }
];

function detectProject(workingDir) {
  if (!workingDir) return [];
  let names;
  try { names = new Set(fs.readdirSync(workingDir)); } catch (_) { return []; }
  return PROJECT_SIGNALS.filter((s) => names.has(s.file));
}

// Eight suggestions, each with a reason it can state out loud.
//
// No scoring mystique: a plugin whose text mentions something this project
// actually contains goes first, the rest fall back to how many people installed
// it. The reason travels as data ({kind, file} or {kind, installCount}) so the
// browser writes the sentence — the server has no business holding UI copy.
function recommend(available, options = {}) {
  const installed = options.installed instanceof Set
    ? options.installed
    : new Set(Array.isArray(options.installed) ? options.installed : []);
  const signals = detectProject(options.workingDir);
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : 8;

  const scored = (available || [])
    .filter((r) => r && !installed.has(r.id))
    .map((r) => {
      const haystack = `${r.name} ${r.description}`.toLowerCase();
      const hit = signals.find((s) => s.words.some((w) => haystack.includes(w)));
      return {
        row: r,
        hit,
        reason: hit ? { kind: 'signal', file: hit.file } : { kind: 'popular', installCount: r.installCount || 0 }
      };
    });

  scored.sort((a, b) => {
    if (!!a.hit !== !!b.hit) return a.hit ? -1 : 1;
    return (b.row.installCount || 0) - (a.row.installCount || 0) || a.row.name.localeCompare(b.row.name);
  });

  return scored.slice(0, limit).map((s) => ({ ...s.row, reason: s.reason }));
}

// ── Changing what is installed ──────────────────────────────────────────────

const SCOPES = ['user', 'project', 'local'];
// Installing pulls code over the network (git, npm, sometimes a declared
// command), so it gets the long ceiling; the rest are local bookkeeping.
const INSTALL_TIMEOUT_MS = 90000;
const ACTION_TIMEOUT_MS = 30000;

// One write at a time, for the whole server.
//
// Two `claude plugin` processes editing installed_plugins.json at once is a
// corrupted file, and the file is shared by every session. The second request
// is refused outright rather than queued: a queue would leave a button spinning
// with nothing to show for it, and these commands are seconds long, not hours.
let busy = null;

function isBusy() { return busy; }

// Each action's argv. `--json` everywhere the CLI offers it; `-y` nowhere —
// accepting a marketplace-declared command on the user's behalf is exactly what
// this must never do. Note `install` takes `--accept-command <sha>` instead:
// the sha the CLI itself printed, handed back after a person looked at it.
function actionArgs(action, target, opts) {
  const scope = SCOPES.includes(opts.scope) ? opts.scope : 'user';
  switch (action) {
    case 'install':
      return ['plugin', 'install', target, '--json', '-s', scope]
        .concat(opts.acceptSha ? ['--accept-command', opts.acceptSha] : []);
    case 'uninstall':
      return ['plugin', 'uninstall', target, '--json', '-s', scope];
    case 'enable':
      return ['plugin', 'enable', target, '--json', '-s', scope];
    case 'disable':
      return ['plugin', 'disable', target, '--json', '-s', scope];
    // The marketplace subcommands have no --json (checked against --help on
    // 2.1.280), so their result is read from the exit code.
    case 'marketplace-add':
      return ['plugin', 'marketplace', 'add', target];
    case 'marketplace-remove':
      return ['plugin', 'marketplace', 'remove', target];
    case 'marketplace-update':
      return target ? ['plugin', 'marketplace', 'update', target] : ['plugin', 'marketplace', 'update'];
    default:
      return null;
  }
}

const PLUGIN_ACTIONS = ['install', 'uninstall', 'enable', 'disable'];
const MARKET_ACTIONS = ['marketplace-add', 'marketplace-remove', 'marketplace-update'];

// Validate, then run. Returns the same shape whatever went wrong, so a caller
// never has to tell "refused" from "failed" by inspecting an exception.
async function runAction(action, params = {}) {
  const target = params.target;
  const isPlugin = PLUGIN_ACTIONS.includes(action);
  const isMarket = MARKET_ACTIONS.includes(action);
  if (!isPlugin && !isMarket) {
    return { ok: false, failureCode: 'bad-action', message: `unknown action: ${String(action).slice(0, 40)}` };
  }
  if (isPlugin && !validId(target)) {
    return { ok: false, failureCode: 'bad-id', message: 'not a plugin id' };
  }
  if (action === 'marketplace-add' && !validMarketplaceSource(target)) {
    return { ok: false, failureCode: 'bad-source', message: 'a marketplace is owner/repo or an https URL' };
  }
  if (action === 'marketplace-remove' && !validId(target)) {
    return { ok: false, failureCode: 'bad-id', message: 'not a marketplace name' };
  }
  if (action === 'marketplace-update' && target != null && !validId(target)) {
    return { ok: false, failureCode: 'bad-id', message: 'not a marketplace name' };
  }
  if (params.acceptSha != null && !validSha(params.acceptSha)) {
    return { ok: false, failureCode: 'bad-sha', message: 'not a sha256' };
  }
  if (params.scope != null && !SCOPES.includes(params.scope)) {
    return { ok: false, failureCode: 'bad-scope', message: `scope is one of ${SCOPES.join(', ')}` };
  }
  if (busy) {
    return { ok: false, failureCode: 'busy', busy: true, message: `another skill operation (${busy}) is still running` };
  }

  const args = actionArgs(action, target, params);
  if (!args) return { ok: false, failureCode: 'bad-action', message: 'unknown action' };

  busy = action;
  let res;
  try {
    res = await runCli(params.claudeCommand, args, {
      cwd: params.workingDir,
      timeoutMs: actionTimeout(action, params.timeoutMs)
    });
  } finally {
    busy = null;
  }

  if (res.missing) return { ok: false, failureCode: 'no-claude-cli', message: 'the claude CLI was not found' };
  if (res.timedOut) return { ok: false, failureCode: 'timeout', message: `no response after ${Math.round(actionTimeout(action, params.timeoutMs) / 1000)}s` };

  const out = isPlugin
    ? parseActionResult(res.stdout, res.stderr)
    // No JSON to read: the exit code is the answer, the output is the detail.
    : {
      ok: res.ok,
      command: action,
      plugin: target || null,
      failureCode: res.ok ? null : 'failed',
      message: firstLine(stripAnsi(`${res.stdout}\n${res.stderr}`))
    };

  // What is installed just changed, so the cached catalogue is stale.
  if (out.ok) clearCatalogCache();
  // Nothing takes effect in a Claude that is already running.
  out.restartRequired = out.ok && action !== 'marketplace-update';
  return out;
}

// Pulling code over the network gets the long ceiling; local bookkeeping the
// short one. An explicit `timeoutMs` overrides both — the tests use it to prove
// a hung command is killed without sitting through the real 30s.
function actionTimeout(action, override) {
  const n = Number(override);
  if (Number.isFinite(n) && n > 0) return n;
  return action === 'install' || action === 'marketplace-add' ? INSTALL_TIMEOUT_MS : ACTION_TIMEOUT_MS;
}

function firstLine(text) {
  return String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
}

module.exports = {
  validId,
  validMarketplaceSource,
  validSha,
  parseInstalled,
  parseCatalog,
  parseMarketplaces,
  parseActionResult,
  parseSkillFrontmatter,
  sourceSummary,
  stripAnsi,
  userSkillsDir,
  projectSkillsDir,
  isWritable,
  listDirSkills,
  pluginSkills,
  runCli,
  listInstalled,
  catalog,
  clearCatalogCache,
  listMarketplaces,
  filterCatalog,
  recommend,
  detectProject,
  PROJECT_SIGNALS,
  runAction,
  actionArgs,
  isBusy,
  PLUGIN_ACTIONS,
  MARKET_ACTIONS,
  SCOPES,
  HEAD_BYTES,
  MAX_DIR_SKILLS,
  CATALOG_TTL_MS,
  INSTALL_TIMEOUT_MS,
  ACTION_TIMEOUT_MS
};
