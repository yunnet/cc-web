#!/usr/bin/env node
'use strict';

// Claude Code statusLine relay. Claude runs this (registered as `statusLine` in
// claude-bridge's injected --settings) with a JSON snapshot of the session on
// stdin: context window use, cost, model, rate limits. We POST that snapshot to
// the local cc-web server — the tab's context ring — and print what the user's
// OWN statusLine prints, so injecting ours does not take theirs away.
//
// Measured on 2.1.304 (Windows, real PTY): Claude calls it once at start and
// once at the end of every turn, so this is not a hot path. Like cc-hook.js it
// is strictly best-effort: any failure exits 0, printing nothing of ours.

const http = require('http');
const { spawn } = require('child_process');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const port = arg('--port');
const session = arg('--session');
// Token and the user's statusLine come from the environment (set on the
// spawned Claude by claude-bridge), not argv.
const token = process.env.CCWEB_HOOK_TOKEN;
const userStatusLine = process.env.CCWEB_USER_STATUSLINE || '';

// Two jobs — the POST and the user's own command — each settles exactly once.
let pending = 2;
let finished = false;
function settler() {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--pending === 0) finish();
  };
}
function finish() {
  if (finished) return;
  finished = true;
  try { clearTimeout(timer); } catch (_) {}
  // Let the user's status line drain before exiting: an exit with the write
  // still queued would cut it off.
  process.stdout.write('', () => process.exit(0));
}

// Never hang: Claude waits for a status line, so give up well before it would.
const timer = setTimeout(finish, 6000);

let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  body += chunk;
  if (body.length > 256 * 1024) body = body.slice(0, 256 * 1024);
});
process.stdin.on('end', () => { post(); runUserStatusLine(); });
process.stdin.on('error', finish);

function post() {
  const settle = settler();
  let event;
  try { event = JSON.parse(body); } catch (_) { return settle(); }
  if (!port || !session || !token || !event || typeof event !== 'object') return settle();
  event.hook_event_name = 'ccweb_statusline';
  const data = Buffer.from(JSON.stringify(event));
  const req = http.request({
    host: '127.0.0.1',
    port: Number(port),
    path: `/api/hooks/${encodeURIComponent(session)}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': data.length,
      'Authorization': `Bearer ${token}`
    }
  }, (res) => { res.resume(); res.on('end', settle); });
  req.on('error', settle);
  req.setTimeout(1000, () => { req.destroy(); settle(); });
  req.write(data);
  req.end();
}

// The command the user configured, run the way Claude would have run it:
// measured on 2.1.304, Claude on Windows runs statusLine through PowerShell
// (even with Git Bash installed); elsewhere through a POSIX shell.
function runUserStatusLine() {
  const settle = settler();
  if (!userStatusLine) return settle();
  let child;
  try {
    child = process.platform === 'win32'
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', userStatusLine], { windowsHide: true })
      : spawn(process.env.SHELL || '/bin/sh', ['-c', userStatusLine]);
  } catch (_) {
    return settle();
  }
  const kill = setTimeout(() => { try { child.kill(); } catch (_) {} }, 5000);
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.resume();
  child.on('error', () => { clearTimeout(kill); settle(); });
  child.on('close', () => { clearTimeout(kill); settle(); });
  child.stdin.on('error', () => {});
  child.stdin.end(body);
}
