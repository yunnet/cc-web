// One Playwright MCP server for every Claude, instead of one per Claude.
//
// Measured on 32352 (2026-11-07): each task's Claude started its own
// `npx @playwright/mcp` — five processes and ~156 MB per task, for a browser
// tool most tasks never call. @playwright/mcp serves HTTP with `--port`, and
// by default gives every connected client its own browser context, so a single
// process can serve all of them. Claude reaches it through a user-scope MCP
// entry of type "http" pointing at http://localhost:<port>/mcp.
//
// The server is started detached: it outlives a cc-web restart, and the next
// cc-web (or the other instance, 32352/32353) finds the port taken and leaves
// it alone. A check every minute starts it again if it has died.

const net = require('net');
const { spawn } = require('child_process');

const DEFAULT_PORT = 8931;

function portFromEnv() {
  const raw = process.env.CCW_SHARED_PLAYWRIGHT_PORT;
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n < 65536 ? n : DEFAULT_PORT;
}

// Is something listening on localhost:<port>? Both loopbacks: @playwright/mcp
// binds `localhost`, which Node resolves to ::1 on this machine — a check of
// 127.0.0.1 alone said "down" every minute and started a duplicate (measured
// 2026-11-07; the duplicate then died on EADDRINUSE).
async function isListening(port, timeoutMs = 1500) {
  for (const host of ['127.0.0.1', '::1']) {
    if (await isListeningOn(port, host, timeoutMs)) return true;
  }
  return false;
}

function isListeningOn(port, host, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// The command line, kept separate so it is testable and visible in one place.
function playwrightArgs(port) {
  return ['-y', '@playwright/mcp@latest', '--port', String(port), '--isolated'];
}

class SharedPlaywright {
  constructor({ port = portFromEnv(), log = console.log, spawnFn = spawn, isListeningFn = isListening } = {}) {
    this.port = port;
    this.log = log;
    this.spawnFn = spawnFn;
    this.isListeningFn = isListeningFn;
    this.timer = null;
    this.starting = null;
  }

  get enabled() { return this.port > 0; }

  // Start it when nothing answers on the port. Returns 'running' | 'started' | 'off'.
  async ensure() {
    if (!this.enabled) return 'off';
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if (await this.isListeningFn(this.port)) return 'running';
      const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
      const child = this.spawnFn(npx, playwrightArgs(this.port), {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        // npx.cmd is a batch file; Node refuses to spawn one without a shell.
        shell: process.platform === 'win32',
      });
      if (child && child.unref) child.unref();
      this.log(`[shared-mcp] started Playwright MCP on http://localhost:${this.port}/mcp (pid ${child && child.pid})`);
      return 'started';
    })();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  // Check now and then once a minute. unref: never holds a process open.
  start(intervalMs = 60000) {
    if (!this.enabled || this.timer) return;
    this.ensure().catch((e) => this.log(`[shared-mcp] ${e.message}`));
    this.timer = setInterval(() => this.ensure().catch((e) => this.log(`[shared-mcp] ${e.message}`)), intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { SharedPlaywright, isListening, playwrightArgs, portFromEnv, DEFAULT_PORT };
