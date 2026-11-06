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
// The platform's credential is handed to every user who has a directory, the
// first administrator included (user 2026-11-05: "管理员也用平台key", option B):
// the shared subscription token when there is one (platformCredentials), else
// the platform key. The key is read from CCW_ANTHROPIC_API_KEY, else the first
// line of <dataDir>/platform/anthropic-key, on every spawn — so a key written
// into the file takes effect at the next Claude start, without restarting
// cc-web. With neither, each user logs in with /login in their own terminal.

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

function readFirstLine(envName, platformDir, fileName) {
  const fromEnv = String(process.env[envName] || '').trim();
  if (fromEnv) return fromEnv;
  if (!platformDir) return '';
  try {
    return fs.readFileSync(path.join(platformDir, fileName), 'utf8').split(/\r?\n/)[0].trim();
  } catch (_) {
    return '';
  }
}

function readPlatformKey(platformDir) {
  return readFirstLine('CCW_ANTHROPIC_API_KEY', platformDir, 'anthropic-key');
}

// One subscription for everyone (user 2026-11-06: 「当前所有人使用同一个订阅
// 用户」): a long-lived token from `claude setup-token`, read from
// CCW_CLAUDE_OAUTH_TOKEN, else the first line of <dataDir>/platform/
// claude-oauth-token, on every spawn like the key. Handed to Claude as
// CLAUDE_CODE_OAUTH_TOKEN. Measured on 2.1.304 with a fresh CLAUDE_CONFIG_DIR:
// no "Not logged in" and no login prompt, nothing written into the directory,
// and the statusLine reports the subscription's five-hour / seven-day limits —
// the usage is the subscription's, not API billing. The banner says "Claude
// API" and the default model is Sonnet, because the new directory holds no
// account profile; /model or the start options pick another.
function readPlatformOAuthToken(platformDir) {
  return readFirstLine('CCW_CLAUDE_OAUTH_TOKEN', platformDir, 'claude-oauth-token');
}

// Which credential a platform user's Claude gets. The subscription wins when
// both are set: Claude prefers ANTHROPIC_API_KEY over an OAuth token, so
// passing both would quietly bill the API instead.
function platformCredentials(platformDir) {
  const oauthToken = readPlatformOAuthToken(platformDir);
  return oauthToken ? { oauthToken, apiKey: '' } : { oauthToken: '', apiKey: readPlatformKey(platformDir) };
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
// the platform's — the shared subscription, else the key — come in.
function applyEnv(env, { configDir = null, apiKey = '', oauthToken = '' } = {}) {
  if (!configDir) return env;
  for (const name of CREDENTIAL_ENV) delete env[name];
  env.CLAUDE_CONFIG_DIR = configDir;
  if (oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  else if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
  return env;
}

module.exports = {
  CREDENTIAL_ENV,
  claudeHome,
  projectsDir,
  readPlatformKey,
  readPlatformOAuthToken,
  platformCredentials,
  seedConfig,
  applyEnv
};
