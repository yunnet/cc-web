const fs = require('fs');
const os = require('os');
const path = require('path');

// Each platform user's own Claude: login, settings, transcripts, skills,
// plugins and themes all live in <dataDir>/<uid>/claude, handed to the CLI as
// CLAUDE_CONFIG_DIR. Measured on 2.1.304: a fresh directory starts out "Not
// logged in", and everything Claude writes (.claude.json, projects/,
// sessions/, plugins/) lands inside it — ~/.claude is never read.
//
// The unowned tenant (no administrator yet, or --disable-auth) has no
// directory of its own: `configDir` is null there and every helper below falls
// back to ~/.claude, which is exactly what a single-user cc-web always used.
//
// The platform key is handed to every user who has a directory, the first
// administrator included (user 2026-11-05: "管理员也用平台key", option B). It is
// read from CCW_ANTHROPIC_API_KEY, else the first line of
// <dataDir>/platform/anthropic-key, on every spawn — so a key written into the
// file takes effect at the next Claude start, without restarting cc-web.

// Credentials the server process may have inherited. Someone with a directory
// of their own gets the platform key or nothing — never the operator's.
const CREDENTIAL_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

// Claude remembers an approved key by its last 20 characters
// (customApiKeyResponses.approved), measured on 2.1.304.
const KEY_TAIL = 20;

function claudeHome(configDir) {
  return configDir || path.join(os.homedir(), '.claude');
}

function projectsDir(configDir) {
  return path.join(claudeHome(configDir), 'projects');
}

function readPlatformKey(platformDir) {
  const fromEnv = String(process.env.CCW_ANTHROPIC_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  if (!platformDir) return '';
  try {
    return fs.readFileSync(path.join(platformDir, 'anthropic-key'), 'utf8').split(/\r?\n/)[0].trim();
  } catch (_) {
    return '';
  }
}

// Answer Claude's first-run questions before it can ask them. A fresh
// directory otherwise opens on a theme picker, then — with a key in the
// environment — "Detected a custom API key… use it?", whose DEFAULT is No:
// one Enter and the user is on a Claude that cannot log in.
//
// Only fills what is missing: a theme the user picked, or anything else Claude
// keeps in that file, is never overwritten. The folder-trust question is not
// answered here; CLA-05 handles it per folder, as for everyone.
//
// Claude rewrites this file while it runs, so the write happens only when
// something actually changed — after the first start that is never.
function seedConfig(configDir, { apiKey = '', theme = 'dark' } = {}) {
  if (!configDir) return false;
  const file = path.join(configDir, '.claude.json');
  let config = {};
  try {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    // A file we cannot parse is Claude's, not ours to replace.
    if (err.code !== 'ENOENT') return false;
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;

  let changed = false;
  if (config.hasCompletedOnboarding !== true) {
    config.hasCompletedOnboarding = true;
    changed = true;
  }
  if (!config.theme) {
    config.theme = theme;
    changed = true;
  }
  if (apiKey) {
    const tail = apiKey.slice(-KEY_TAIL);
    const responses = config.customApiKeyResponses && typeof config.customApiKeyResponses === 'object'
      ? config.customApiKeyResponses
      : {};
    const approved = Array.isArray(responses.approved) ? responses.approved : [];
    const rejected = Array.isArray(responses.rejected) ? responses.rejected : [];
    // The platform key is the only credential this user is given, so a past
    // "No" to it is lifted rather than left to strand them.
    if (!approved.includes(tail) || rejected.includes(tail)) {
      config.customApiKeyResponses = {
        ...responses,
        approved: approved.includes(tail) ? approved : approved.concat(tail),
        rejected: rejected.filter((t) => t !== tail)
      };
      changed = true;
    }
  }
  if (!changed) return false;

  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch (_) {
    try { fs.unlinkSync(tmp); } catch (_e) { /* nothing to clean up */ }
    return false;
  }
}

// The environment a Claude process (or `claude plugin …`) runs under. With no
// directory of its own nothing changes; with one, inherited credentials go and
// the platform key, if any, comes in.
function applyEnv(env, { configDir = null, apiKey = '' } = {}) {
  if (!configDir) return env;
  for (const name of CREDENTIAL_ENV) delete env[name];
  env.CLAUDE_CONFIG_DIR = configDir;
  if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
  return env;
}

module.exports = {
  CREDENTIAL_ENV,
  claudeHome,
  projectsDir,
  readPlatformKey,
  seedConfig,
  applyEnv
};
