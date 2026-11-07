// Idle hibernation: stop the Claude of a task nobody is using, resume it on the
// next click.
//
// Measured on 32352 (2026-11-07): every task's Claude stays resident with its
// own copy of every MCP server — 11 tasks were 209 processes and 14 GB, about
// 1.3 GB each. A hundred tasks cannot run that way, and nothing in Claude Code
// shares or lazily starts MCP servers. A cold `claude --resume` measured
// 2.4-4.2 s to its prompt, and the conversation lives in Claude's transcript, so
// stopping an idle Claude loses nothing that resuming does not bring back.
// Claude Code's own agent view does the same: unattached sessions stop after
// about an hour, and idle ones stop under memory pressure.
//
// Two rules, both only for a Claude that is quiet, unseen and not waiting on a
// person:
//   - idle: nothing in or out and nobody looking for `idleMs` → stop it;
//   - cap:  more than `maxRunning` Claudes → stop the least recently used
//           quiet ones until the count fits. A Claude that is working is never
//           stopped, so the cap can be exceeded while many are busy.
//
// One last check runs per candidate before it is stopped: a Claude with a
// child process it started after its own startup is running a command (a build,
// a dev server, a background task), and stopping it would kill that.

const { execFile } = require('child_process');

const DEFAULTS = {
  idleMs: 60 * 60 * 1000,      // user, 2026-11-07: 1 hour
  maxRunning: 6,               // user, 2026-11-07: 6 at once
  quietMs: 2 * 60 * 1000,      // the cap only takes Claudes silent this long
  startupGraceMs: 60 * 1000,   // children younger than claude+this are tools
};

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// CCW_HIBERNATE_IDLE_MIN=0 turns the idle rule off; CCW_MAX_RUNNING_CLAUDE=0
// turns the cap off.
function configFromEnv() {
  return {
    ...DEFAULTS,
    idleMs: envNumber('CCW_HIBERNATE_IDLE_MIN', DEFAULTS.idleMs / 60000) * 60000,
    maxRunning: envNumber('CCW_MAX_RUNNING_CLAUDE', DEFAULTS.maxRunning),
  };
}

// The moment a session was last used: output, input, a viewer, or its start.
function lastUsed(s) {
  return Math.max(s.lastOutputAt || 0, s.lastInputAt || 0, s.lastViewedAt || 0, s.startedAt || 0);
}

/**
 * Which running sessions to hibernate, and why. Pure: callers pass plain
 * records, so the policy is tested without a server or a Claude.
 *
 * @param {Array<{id, viewed, awaiting, lastOutputAt, lastInputAt, lastViewedAt, startedAt}>} running
 * @returns {Array<{id, reason: 'idle'|'cap', idleMs}>}
 */
function pickHibernations(running, now, config = DEFAULTS) {
  const eligible = running.filter((s) => !s.viewed && !s.awaiting);
  const picks = new Map();

  if (config.idleMs > 0) {
    for (const s of eligible) {
      const idle = now - lastUsed(s);
      if (idle >= config.idleMs) picks.set(s.id, { id: s.id, reason: 'idle', idleMs: idle });
    }
  }

  if (config.maxRunning > 0) {
    let excess = running.length - picks.size - config.maxRunning;
    if (excess > 0) {
      const quiet = eligible
        .filter((s) => !picks.has(s.id) && now - lastUsed(s) >= config.quietMs)
        .sort((a, b) => lastUsed(a) - lastUsed(b));
      for (const s of quiet) {
        if (excess <= 0) break;
        picks.set(s.id, { id: s.id, reason: 'cap', idleMs: now - lastUsed(s) });
        excess--;
      }
    }
  }

  return [...picks.values()];
}

// [{pid, ppid, startedMs}] for every process, read once. Asynchronous on
// purpose: the CIM query takes about a second and the server's thread is shared
// with every live terminal.
function readProcessTable() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const script = "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }";
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024 },
        (error, out) => resolve(error ? null : parseTable(out, (started) => started)));
      return;
    }
    // etimes: seconds since the process started.
    execFile('ps', ['-A', '-o', 'pid=,ppid=,etimes='], { encoding: 'utf8', timeout: 10000 },
      (error, out) => resolve(error ? null : parseTable(out, (etimes) => Date.now() - etimes * 1000)));
  });
}

function parseTable(out, toStarted) {
  return String(out).split(/\r?\n/).map((l) => l.trim().split(/\s+/).map(Number))
    .filter(([pid, ppid, t]) => Number.isInteger(pid) && Number.isInteger(ppid) && Number.isFinite(t))
    .map(([pid, ppid, t]) => ({ pid, ppid, startedMs: toStarted(t) }));
}

/**
 * Is this Claude running a command? True when any direct child started more
 * than `graceMs` after Claude itself: MCP and LSP servers start with Claude,
 * tool commands start later. Unknown (no table, no pid) counts as busy, so a
 * failed check never stops anything.
 */
function isBusy(table, claudePid, graceMs = DEFAULTS.startupGraceMs) {
  if (!table || !claudePid) return true;
  const self = table.find((p) => p.pid === claudePid);
  if (!self) return true;
  return table.some((p) => p.ppid === claudePid && p.pid !== claudePid && p.startedMs > self.startedMs + graceMs);
}

module.exports = { DEFAULTS, configFromEnv, pickHibernations, lastUsed, readProcessTable, parseTable, isBusy };
