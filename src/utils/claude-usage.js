const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const claudeHistory = require('./claude-history');

// What one Claude conversation used, read from its transcript:
//
//   ~/.claude/projects/<encoded-dir>/<uuid>.jsonl            the conversation
//   ~/.claude/projects/<encoded-dir>/<uuid>/subagents/*.jsonl its sub-agents
//
// Measured on 2.1.304: every assistant record carries `message.usage`
// (input_tokens, cache_read_input_tokens, cache_creation_input_tokens with a
// 5m / 1h split, output_tokens) plus `message.id`; one API response is written
// as several records — one per content block — repeating the same usage, so
// requests are counted by message.id, last record wins. A compaction is a
// `system` record with subtype `compact_boundary` and compactMetadata
// {trigger, preTokens}. Sub-agent transcripts live beside the conversation,
// not inside it (the main file carries no isSidechain records).
//
// Read-only, like claude-history.js. Transcripts only grow, so each file keeps
// its running totals and the byte offset of the last complete line it read: a
// later call parses only the new tail (the turn rail's listUserPrompts does the
// same). Transcripts reach tens of MB (41 MB measured), so lines are filtered
// as bytes before any JSON.parse.

// API prices in $ per million tokens: [input, output, cache read]. Cache writes
// are 1.25x input (5-minute TTL) and 2x input (1-hour TTL); fast mode is 2x.
// From the claude-api reference, cached 2026-10-06. A subscription does not pay
// these — the figure is what the tokens would cost on the API ("API 折算"),
// an estimate. A model not listed has no price: null, never a guess.
const PRICES = [
  ['claude-fable-5-1', 10, 50, 0.25],
  ['claude-mythos-5-1', 10, 50, 0.25],
  ['claude-fable-5', 10, 50, 1],
  ['claude-mythos-5', 10, 50, 1],
  ['claude-opus-5-5', 4, 20, 0.2],
  ['claude-opus-5', 5, 25, 0.5],
  ['claude-opus-4-8', 5, 25, 0.5],
  ['claude-opus-4-7', 5, 25, 0.5],
  ['claude-opus-4-6', 5, 25, 0.5],
  ['claude-sonnet-5-5', 2, 10, 0.2],
  ['claude-sonnet-5', 2, 10, 0.2],
  ['claude-sonnet-4-6', 3, 15, 0.3],
  ['claude-haiku-5-5', 0.1, 0.5, 0.01],
  ['claude-haiku-4-5', 1, 5, 0.1]
];

// `claude-opus-5-5`, `claude-opus-5-5[1m]`, a dated snapshot, a Bedrock
// `us.anthropic.claude-…` id — but never `claude-opus-5` for `claude-opus-5-5`.
function priceFor(model) {
  const id = String(model || '').replace(/^.*?(?=claude-)/, '');
  for (const [prefix, input, output, cacheRead] of PRICES) {
    if (!id.startsWith(prefix)) continue;
    const rest = id.slice(prefix.length);
    // Nothing more, a `[1m]` / `@date` suffix, or a `-YYYYMMDD` snapshot.
    if (rest === '' || /^[[@]/.test(rest) || /^-\d{8}/.test(rest)) return { input, output, cacheRead };
  }
  return null;
}

function costOf(req) {
  const p = priceFor(req.model);
  if (!p) return null;
  const write1h = Math.min(req.cacheCreate1h || 0, req.cacheCreate);
  const write5m = req.cacheCreate - write1h;
  const usd = (req.input * p.input + write5m * p.input * 1.25 + write1h * p.input * 2
    + req.cacheRead * p.cacheRead + req.output * p.output) / 1e6;
  return req.fast ? usd * 2 : usd;
}

// The program a Bash command runs: its first word, past `cd … &&`, env
// assignments and sudo. `/usr/bin/git` and `git.exe` are both "git".
function programOf(command) {
  const parts = String(command || '').split(/&&|\|\||;|\n/);
  for (const part of parts) {
    // Words, a quoted one ("C:/Program Files/…/node.exe") kept whole.
    const words = (part.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((w) => w.replace(/^["']|["']$/g, ''));
    while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || words[0] === 'sudo' || words[0] === '&')) words.shift();
    if (!words.length || words[0] === 'cd') continue;
    const name = path.posix.basename(words[0].replace(/\\/g, '/')).replace(/\.(exe|cmd|bat)$/i, '');
    if (name) return name.slice(0, 40);
  }
  return null;
}

const FILE_TOOLS = { Read: 'read', Edit: 'edit', MultiEdit: 'edit', Write: 'write', NotebookEdit: 'edit' };

function emptyAcc() {
  return {
    requests: [],          // in file order
    byId: new Map(),       // message.id -> index into requests
    toolIds: new Set(),
    compactions: [],
    tools: new Map(),
    programs: new Map(),
    files: new Map(),
    skills: new Map(),
    commands: new Map(),
    firstAt: null,
    lastAt: null,
    // For the overview's conversation list: where it ran and what it is
    // called — the title Claude or a person gave it, else the first prompt.
    cwd: null,
    aiTitle: null,
    customTitle: null,
    firstPrompt: null
  };
}

const bump = (map, key, n = 1) => map.set(key, (map.get(key) || 0) + n);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// The opening of the first thing a person typed: the fallback title, the
// same pick as claude-history's (no command echoes, reminders, tool results).
const NOT_A_PROMPT = /^\s*<(local-command-caveat|command-name|command-message|command-args|system-reminder|user-prompt-submit-hook)/;

function addRecord(acc, record) {
  if (record.type === 'ai-title' && typeof record.aiTitle === 'string' && record.aiTitle.trim()) {
    acc.aiTitle = record.aiTitle.trim().slice(0, 120);
    return;
  }
  if (record.type === 'custom-title' && typeof record.customTitle === 'string' && record.customTitle.trim()) {
    acc.customTitle = record.customTitle.trim().slice(0, 120);
    return;
  }
  if (!acc.cwd && typeof record.cwd === 'string') acc.cwd = record.cwd;
  const at = typeof record.timestamp === 'string' ? record.timestamp : null;
  if (at) {
    if (!acc.firstAt || at < acc.firstAt) acc.firstAt = at;
    if (!acc.lastAt || at > acc.lastAt) acc.lastAt = at;
  }
  if (record.type === 'system' && record.subtype === 'compact_boundary') {
    const meta = record.compactMetadata || {};
    acc.compactions.push({ t: at, trigger: meta.trigger || null, preTokens: num(meta.preTokens) || null, atRequest: acc.requests.length });
    return;
  }
  if (record.type === 'user') {
    const content = record.message && record.message.content;
    if (typeof content === 'string') {
      const m = /<command-name>\/?([^<\s]{1,60})<\/command-name>/.exec(content);
      if (m) bump(acc.commands, m[1]);
      else if (!acc.firstPrompt && !record.isMeta && content.trim() && !NOT_A_PROMPT.test(content)) {
        acc.firstPrompt = content.trim().replace(/\s+/g, ' ').slice(0, 120);
      }
    }
    return;
  }
  if (record.type !== 'assistant' || !record.message) return;
  const msg = record.message;
  const usage = msg.usage;
  if (usage && msg.id && msg.model !== '<synthetic>') {
    const cc = usage.cache_creation || {};
    const req = {
      t: at,
      model: typeof msg.model === 'string' ? msg.model : null,
      input: num(usage.input_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheCreate: num(usage.cache_creation_input_tokens),
      cacheCreate1h: num(cc.ephemeral_1h_input_tokens),
      output: num(usage.output_tokens),
      fast: usage.speed === 'fast'
    };
    if (req.input || req.cacheRead || req.cacheCreate || req.output) {
      const i = acc.byId.get(msg.id);
      if (i === undefined) {
        acc.byId.set(msg.id, acc.requests.length);
        acc.requests.push(req);
      } else {
        req.t = acc.requests[i].t || req.t;
        acc.requests[i] = req;
      }
    }
  }
  for (const block of Array.isArray(msg.content) ? msg.content : []) {
    if (!block || block.type !== 'tool_use' || typeof block.name !== 'string') continue;
    if (block.id) {
      if (acc.toolIds.has(block.id)) continue;
      acc.toolIds.add(block.id);
    }
    const input = block.input || {};
    bump(acc.tools, block.name);
    if (block.name === 'Bash' || block.name === 'PowerShell') {
      const program = programOf(input.command);
      if (program) bump(acc.programs, program);
    } else if (block.name === 'Skill' && typeof input.skill === 'string') {
      bump(acc.skills, input.skill.slice(0, 80));
    }
    const op = FILE_TOOLS[block.name];
    const file = input.file_path || input.notebook_path;
    if (op && typeof file === 'string') {
      const entry = acc.files.get(file) || { read: 0, edit: 0, write: 0 };
      entry[op]++;
      acc.files.set(file, entry);
    }
  }
}

// Only these lines can matter; everything else (tool results, attachments,
// hook output — most of the bytes) is skipped without parsing.
const WANTED = ['"type":"assistant"', 'compact_boundary', '<command-name>', '-title"'];

// Until a conversation's first prompt is found, plain user lines are parsed
// too — except tool results, which are most of the bytes and never a prompt.
function wanted(line, acc) {
  if (WANTED.some((w) => line.includes(w))) return true;
  return !acc.firstPrompt && line.includes('"type":"user"') && !line.includes('"tool_result"');
}

// file -> { offset, ino, acc }. Bounded: an overview reads many files.
const cache = new Map();
const CACHE_MAX = 400;

async function readFrom(file, entry, size) {
  const stream = fs.createReadStream(file, { start: entry.offset, end: size - 1 });
  let carry = Buffer.alloc(0);
  let consumed = entry.offset;
  for await (const chunk of stream) {
    let buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    let start = 0;
    let nl;
    while ((nl = buf.indexOf(0x0a, start)) !== -1) {
      const line = buf.subarray(start, nl);
      consumed += nl - start + 1;
      start = nl + 1;
      if (!wanted(line, entry.acc)) continue;
      let record;
      try { record = JSON.parse(line.toString('utf8')); } catch (_) { continue; }
      addRecord(entry.acc, record);
    }
    carry = buf.subarray(start);
  }
  // A trailing line without its newline is still being written: its bytes
  // are read again next time.
  entry.offset = consumed;
}

// The running totals of one transcript file, brought up to date.
async function accumulate(file) {
  let st;
  try { st = await fsp.stat(file); } catch (_) { return null; }
  let entry = cache.get(file);
  if (entry) cache.delete(file); // re-inserted below: most recently used last
  if (!entry || st.size < entry.offset || (entry.ino && st.ino && entry.ino !== st.ino)) {
    // New, or shrank / replaced — a different conversation under this name.
    entry = { offset: 0, ino: st.ino, acc: emptyAcc() };
  }
  if (st.size > entry.offset) await readFrom(file, entry, st.size);
  cache.set(file, entry);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return entry.acc;
}

const top = (map, n = 15) => [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, n);

function totalsOf(requests) {
  const t = { requests: requests.length, input: 0, cacheRead: 0, cacheCreate: 0, output: 0, costUsd: 0, unpriced: 0, models: {} };
  for (const r of requests) {
    t.input += r.input;
    t.cacheRead += r.cacheRead;
    t.cacheCreate += r.cacheCreate;
    t.output += r.output;
    const c = costOf(r);
    if (c === null) t.unpriced++;
    else t.costUsd += c;
    if (r.model) t.models[r.model] = (t.models[r.model] || 0) + 1;
  }
  const prompt = t.input + t.cacheRead + t.cacheCreate;
  t.cacheHitRate = prompt ? t.cacheRead / prompt : null;
  // Every request unpriced: there is no estimate at all, not a $0 one.
  if (t.requests && t.unpriced === t.requests) t.costUsd = null;
  return t;
}

// How many requests the trend chart gets: the newest ones. The totals above
// always cover every request.
const TREND_MAX = 2000;

function summarize(acc) {
  const requests = acc.requests;
  const skip = Math.max(0, requests.length - TREND_MAX);
  const last = requests[requests.length - 1] || null;
  return {
    totals: totalsOf(requests),
    firstAt: acc.firstAt,
    lastAt: acc.lastAt,
    current: last ? { t: last.t, model: last.model, ctx: last.input + last.cacheRead + last.cacheCreate, input: last.input, cacheRead: last.cacheRead, cacheCreate: last.cacheCreate } : null,
    trend: {
      skipped: skip,
      requests: requests.slice(skip).map((r) => ({ t: r.t, model: r.model, input: r.input, cacheRead: r.cacheRead, cacheCreate: r.cacheCreate, output: r.output })),
      compactions: acc.compactions.map((c) => ({ ...c, atRequest: c.atRequest - skip }))
    },
    top: {
      tools: top(acc.tools),
      programs: top(acc.programs),
      skills: top(acc.skills),
      commands: top(acc.commands),
      files: [...acc.files.entries()]
        .map(([file, ops]) => [file, ops.read + ops.edit + ops.write, ops])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
    }
  };
}

async function subagentFiles(projectDir, conversationId) {
  const dir = path.join(projectDir, conversationId, 'subagents');
  let names;
  try { names = await fsp.readdir(dir); } catch (_) { return []; }
  return names.filter((n) => n.endsWith('.jsonl')).map((n) => path.join(dir, n));
}

async function projectDirOf(dir, root) {
  let projectDir = await claudeHistory.projectDirFor(dir, root);
  if (!projectDir) {
    // Claude writes under the realpath of the working dir (see listUserPrompts).
    try {
      const real = await fsp.realpath(dir);
      if (real && real !== dir) projectDir = await claudeHistory.projectDirFor(real, root);
    } catch (_) { /* the dir itself is gone */ }
  }
  return projectDir;
}

// One conversation's usage, sub-agents included. Null when there is no
// transcript (a session that never started Claude, an id from elsewhere).
async function conversationUsage(dir, conversationId, { root = claudeHistory.projectsRoot() } = {}) {
  if (!claudeHistory.UUID.test(String(conversationId || ''))) return null;
  const projectDir = await projectDirOf(dir, root);
  if (!projectDir) return null;
  const file = path.join(projectDir, `${conversationId}.jsonl`);
  const acc = await accumulate(file);
  if (!acc) return null;
  const summary = summarize(acc);

  const subRequests = [];
  const files = await subagentFiles(projectDir, conversationId);
  for (const f of files) {
    const sub = await accumulate(f);
    if (sub) subRequests.push(...sub.requests);
  }
  summary.subagents = { count: files.length, totals: totalsOf(subRequests) };
  summary.conversationId = conversationId;
  return summary;
}

// ── The overview: every conversation under one Claude projects directory.
//
// Measured on this machine (2026-11-06): 157 transcripts, 332 MB — a cold
// scan is ~2 s, and after it every call reads only what was appended. A
// request waits at most `budgetMs` for the scan and answers with what is read
// so far plus `scanning: true`; the scan carries on and the browser asks again.
// Days are the browser's local days (tzOffsetMin is getTimezoneOffset()), and
// a request counts on the day it was made, not the day its file last changed.

const scans = new Map(); // root -> promise of the running scan

async function listTranscripts(root, sinceMs) {
  const out = [];
  let projects;
  try { projects = await fsp.readdir(root, { withFileTypes: true }); } catch (_) { return out; }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = path.join(root, project.name);
    let names;
    try { names = await fsp.readdir(dir); } catch (_) { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl') || !claudeHistory.UUID.test(name.slice(0, -6))) continue;
      const file = path.join(dir, name);
      let st;
      try { st = await fsp.stat(file); } catch (_) { continue; }
      if (st.mtimeMs < sinceMs) continue;
      const id = name.slice(0, -6);
      out.push({ id, project: project.name, file, subagents: await subagentFiles(dir, id) });
    }
  }
  return out;
}

async function scanAll(files, concurrency = 4) {
  const queue = files.flatMap((f) => [f.file, ...f.subagents]);
  const worker = async () => {
    while (queue.length) {
      const file = queue.shift();
      try { await accumulate(file); } catch (_) { /* unreadable: skipped */ }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}

const dayOf = (t, tzOffsetMin) => {
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? new Date(ms - tzOffsetMin * 60000).toISOString().slice(0, 10) : null;
};

function dayList(endDay, n) {
  const out = [];
  const end = Date.parse(endDay + 'T00:00:00Z');
  for (let i = n - 1; i >= 0; i--) out.push(new Date(end - i * 86400000).toISOString().slice(0, 10));
  return out;
}

// include(cwd), when given, keeps only the conversations it accepts: a user
// limited to some folders reads the shared ~/.claude through it.
async function overview(root, { sinceMs = 0, tzOffsetMin = 0, budgetMs = 3000, now = Date.now(), chartDays = 7, include = null } = {}) {
  const files = await listTranscripts(root, sinceMs);
  let scan = scans.get(root);
  if (!scan) {
    scan = scanAll(files).finally(() => scans.delete(root));
    scans.set(root, scan);
  }
  let done = false;
  await Promise.race([
    scan.then(() => { done = true; }),
    new Promise((r) => setTimeout(r, budgetMs))
  ]);

  const today = dayOf(new Date(now).toISOString(), tzOffsetMin);
  const chart = dayList(today, chartDays);
  const heat = dayList(today, 56); // eight weeks
  const byDay = new Map();
  const dayBucket = (d) => {
    let b = byDay.get(d);
    if (!b) { b = { tokens: 0, costUsd: 0, requests: 0 }; byDay.set(d, b); }
    return b;
  };
  const inRange = [];
  const tools = new Map(), programs = new Map(), skills = new Map(), commands = new Map();
  const sessions = [];
  let read = 0;

  for (const f of files) {
    const entry = cache.get(f.file);
    if (!entry) continue;
    read++;
    const acc = entry.acc;
    if (include && !include(acc.cwd)) continue;
    const subs = f.subagents.map((s) => cache.get(s)).filter(Boolean).map((e) => e.acc);
    const own = [];
    for (const r of acc.requests.concat(...subs.map((s) => s.requests))) {
      const ms = Date.parse(r.t);
      // Requests on the eight-week heatmap, whatever the range.
      const d = dayOf(r.t, tzOffsetMin);
      const tokensOf = r.input + r.cacheRead + r.cacheCreate + r.output;
      if (d) {
        const b = dayBucket(d);
        b.tokens += tokensOf;
        b.requests++;
        const c = costOf(r);
        if (c !== null) b.costUsd += c;
      }
      if (Number.isFinite(ms) && ms >= sinceMs) own.push(r);
    }
    if (!own.length) continue;
    inRange.push(...own);
    const t = totalsOf(own);
    const last = acc.requests[acc.requests.length - 1];
    sessions.push({
      id: f.id,
      project: f.project,
      cwd: acc.cwd,
      title: acc.customTitle || acc.aiTitle || acc.firstPrompt || null,
      requests: t.requests,
      tokens: t.input + t.cacheRead + t.cacheCreate + t.output,
      costUsd: t.costUsd,
      cacheHitRate: t.cacheHitRate,
      ctx: last ? last.input + last.cacheRead + last.cacheCreate : null,
      lastAt: acc.lastAt,
      subagents: f.subagents.length
    });
    for (const [map, from] of [[tools, acc.tools], [programs, acc.programs], [skills, acc.skills], [commands, acc.commands]]) {
      for (const [k, v] of from) bump(map, k, v);
    }
  }

  sessions.sort((a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || '')));
  const totals = totalsOf(inRange);
  totals.sessions = sessions.length;
  const series = (days) => days.map((d) => ({ day: d, ...(byDay.get(d) || { tokens: 0, costUsd: 0, requests: 0 }) }));
  return {
    scanning: !done,
    files: { read, total: files.length },
    totals,
    days: series(chart),
    heatmap: series(heat),
    sessions: sessions.slice(0, 300),
    sessionsTotal: sessions.length,
    top: { tools: top(tools), programs: top(programs), skills: top(skills), commands: top(commands) }
  };
}

module.exports = {
  overview,
  PRICES,
  priceFor,
  costOf,
  programOf,
  accumulate,
  summarize,
  totalsOf,
  conversationUsage,
  _cache: cache
};
