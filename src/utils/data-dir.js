// The one place that answers "where does this instance keep its data?".
//
// SessionStore (sessions/), the instance registry (instances/) and plan-dirs
// all used to resolve this independently — and the two copies did once
// disagree, which is how a dev instance adopted stable's directory on
// 2026-09-03 and both rewrote it. One module, one answer.
//
// The layout (tokens and logs are placed here by restart-ccweb.sh, which owns
// those files; this module owns only the data directory):
//
//   ~/.cc-web/data           the default (a bare `node bin/cc-web.js`)
//   ~/.cc-web/data-<port>/   instances started by restart-ccweb.sh (CCW_DATA_DIR)
//
// CCW_DATA_DIR still wins absolutely — explicit is explicit. What changes is
// the default: ~/.claude-code-web at the home root is adopted (renamed) into
// ~/.cc-web/data on the first run that finds it, so existing installs move
// with one atomic, same-filesystem rename instead of silently forking a second
// store. A dotted ~/.cc-web/.claude-code-web — what a hand-move before this
// module existed left behind — is adopted the same way. Everything here is
// best-effort: housekeeping must never be the reason a server won't start.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Renames that already failed once, so a bad target doesn't warn on every
// writeLock (dataDir() is called per write, not once at startup). The failed
// source is remembered as the answer too: after one bad move the data must
// keep resolving to where it actually is, never to a fresh empty target —
// that fork is exactly what this module exists to prevent.
const failedMoves = new Set();
let failedFallback = null;

function baseDir() {
  return path.join(os.homedir(), '.cc-web');
}

// Candidates for adoption, newest layout first: the home-root default, then
// the dotted copy inside ~/.cc-web a user may have moved by hand.
function legacyDefaultDirs() {
  return [
    path.join(os.homedir(), '.claude-code-web'),
    path.join(baseDir(), '.claude-code-web'),
  ];
}

/**
 * Resolve this instance's data directory, adopting the pre-~/.cc-web layout
 * on the way. Never throws: on a move that cannot happen it falls back to the
 * legacy directory so the data stays where it already is.
 *
 * @returns {string} absolute path of the data directory
 */
function dataDir() {
  if (process.env.CCW_DATA_DIR) {
    return path.resolve(process.env.CCW_DATA_DIR);
  }
  const target = path.join(baseDir(), 'data');
  if (fs.existsSync(target)) return target;
  if (failedFallback && fs.existsSync(failedFallback)) return failedFallback;

  for (const legacy of legacyDefaultDirs()) {
    if (!fs.existsSync(legacy) || failedMoves.has(legacy)) continue;
    try {
      fs.mkdirSync(baseDir(), { recursive: true, mode: 0o700 });
      fs.renameSync(legacy, target);
      console.warn(`[cc-web] data directory moved: ${legacy} -> ${target}`);
      return target;
    } catch (error) {
      failedMoves.add(legacy);
      failedFallback = legacy;
      console.warn(`[cc-web] keeping data directory at ${legacy} (move failed: ${error.message})`);
      return legacy;
    }
  }

  try {
    fs.mkdirSync(baseDir(), { recursive: true, mode: 0o700 });
  } catch (_) { /* SessionStore's own mkdir reports real errors */ }
  return target;
}

module.exports = { dataDir, baseDir };
