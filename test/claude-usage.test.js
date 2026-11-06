const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const usage = require('../src/utils/claude-usage');
const { ClaudeCodeWebServer } = require('../src/server');

// Record shapes copied from a real 2.1.304 transcript, trimmed to the fields
// the parser reads. One API response is several records (one per content
// block) repeating the same message.id and usage.
const CONV = '8e792903-f3bf-46b9-bf17-73692eb81193';

const u = (input, cacheRead, cacheCreate, output, extra = {}) => ({
  input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate,
  output_tokens: output, cache_creation: { ephemeral_1h_input_tokens: cacheCreate, ephemeral_5m_input_tokens: 0 }, ...extra
});
const assistant = (id, t, content, usage_, model = 'claude-opus-5-5') => ({
  type: 'assistant', isSidechain: false, timestamp: t,
  message: { model, id, type: 'message', role: 'assistant', content, usage: usage_ }
});

const RECORDS = [
  { type: 'user', timestamp: '2026-11-05T01:00:00.000Z', message: { role: 'user', content: 'fix the build' } },
  assistant('msg_A', '2026-11-05T01:00:05.000Z', [{ type: 'thinking', thinking: '' }], u(2, 16000, 10000, 50)),
  assistant('msg_A', '2026-11-05T01:00:06.000Z', [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'cd /w && git status' } }], u(2, 16000, 10000, 105)),
  { type: 'user', timestamp: '2026-11-05T01:00:07.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'clean' }] }, toolUseResult: {} },
  assistant('msg_B', '2026-11-05T01:00:10.000Z', [{ type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: '/w/src/app.js' } }], u(3, 26000, 500, 80)),
  { type: 'user', timestamp: '2026-11-05T01:01:00.000Z', message: { role: 'user', content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>' } },
  { type: 'system', subtype: 'compact_boundary', timestamp: '2026-11-05T01:01:30.000Z', compactMetadata: { trigger: 'manual', preTokens: 26503 } },
  assistant('msg_C', '2026-11-05T01:02:00.000Z', [{ type: 'tool_use', id: 'toolu_3', name: 'Skill', input: { skill: 'tech' } }], u(5, 4000, 2000, 40)),
  assistant('msg_D', '2026-11-05T01:03:00.000Z', [{ type: 'text', text: 'done' }], u(1, 0, 100, 10), 'claude-unknown-9'),
  // Claude Code's own placeholder for a failed request: no real usage.
  assistant('msg_E', '2026-11-05T01:03:01.000Z', [{ type: 'text', text: 'API Error' }], u(0, 0, 0, 0), '<synthetic>')
];
const lines = (records) => records.map((r) => JSON.stringify(r) + '\n').join('');

describe('claude-usage: reading a transcript', function() {
  let root;
  let projectDir;
  let workDir;
  let file;

  beforeEach(function() {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-usage-'));
    workDir = path.join(root, 'work');
    fs.mkdirSync(workDir);
    // Claude's directory-name encoding: every non-alphanumeric becomes '-'.
    projectDir = path.join(root, 'projects', workDir.replace(/[^A-Za-z0-9]/g, '-'));
    fs.mkdirSync(projectDir, { recursive: true });
    file = path.join(projectDir, `${CONV}.jsonl`);
    usage._cache.clear();
  });
  afterEach(function() { fs.rmSync(root, { recursive: true, force: true }); });

  const read = () => usage.conversationUsage(workDir, CONV, { root: path.join(root, 'projects') });

  it('counts each API response once, however many records it was written as', async function() {
    fs.writeFileSync(file, lines(RECORDS));
    const s = await read();
    assert.strictEqual(s.totals.requests, 4, 'A, B, C and D; the synthetic one has no usage');
    // msg_A's last record wins (output grew from 50 to 105).
    assert.strictEqual(s.trend.requests[0].output, 105);
    assert.strictEqual(s.totals.output, 105 + 80 + 40 + 10);
    assert.strictEqual(s.totals.cacheRead, 16000 + 26000 + 4000);
  });

  it('knows what the window holds after the last request, and the cache hit rate', async function() {
    fs.writeFileSync(file, lines(RECORDS));
    const s = await read();
    assert.deepStrictEqual(
      { ctx: s.current.ctx, model: s.current.model },
      { ctx: 1 + 0 + 100, model: 'claude-unknown-9' }
    );
    const prompt = s.totals.input + s.totals.cacheRead + s.totals.cacheCreate;
    assert.strictEqual(s.totals.cacheHitRate, s.totals.cacheRead / prompt);
    // The span runs from the first response: plain user lines are skipped
    // unparsed, which is most of what keeps a 41 MB file fast.
    assert.strictEqual(s.firstAt, '2026-11-05T01:00:05.000Z');
    assert.strictEqual(s.lastAt, '2026-11-05T01:03:01.000Z');
  });

  it('marks a compaction at the request it came before', async function() {
    fs.writeFileSync(file, lines(RECORDS));
    const s = await read();
    assert.deepStrictEqual(s.trend.compactions, [
      { t: '2026-11-05T01:01:30.000Z', trigger: 'manual', preTokens: 26503, atRequest: 2 }
    ]);
  });

  it('ranks tools, programs, files, skills and slash commands', async function() {
    fs.writeFileSync(file, lines(RECORDS));
    const s = await read();
    assert.deepStrictEqual(s.top.tools, [['Bash', 1], ['Read', 1], ['Skill', 1]]);
    assert.deepStrictEqual(s.top.programs, [['git', 1]]);
    assert.deepStrictEqual(s.top.skills, [['tech', 1]]);
    assert.deepStrictEqual(s.top.commands, [['compact', 1]]);
    assert.deepStrictEqual(s.top.files, [['/w/src/app.js', 1, { read: 1, edit: 0, write: 0 }]]);
  });

  it('prices what it can and says how much it could not', async function() {
    fs.writeFileSync(file, lines(RECORDS));
    const s = await read();
    assert.strictEqual(s.totals.unpriced, 1, 'claude-unknown-9');
    const expected = [RECORDS[2], RECORDS[4], RECORDS[7]].map((r) => usage.costOf({
      model: 'claude-opus-5-5', input: r.message.usage.input_tokens, cacheRead: r.message.usage.cache_read_input_tokens,
      cacheCreate: r.message.usage.cache_creation_input_tokens, cacheCreate1h: r.message.usage.cache_creation_input_tokens,
      output: r.message.usage.output_tokens
    })).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(s.totals.costUsd - expected) < 1e-9);
  });

  it('reads only the new tail on the next call, and waits for a half-written line', async function() {
    fs.writeFileSync(file, lines(RECORDS.slice(0, 5)));
    assert.strictEqual((await read()).totals.requests, 2);
    // The next record arrives in two writes: the first without its newline.
    const next = JSON.stringify(RECORDS[7]);
    fs.appendFileSync(file, next.slice(0, 40));
    assert.strictEqual((await read()).totals.requests, 2, 'a half line is not read');
    fs.appendFileSync(file, next.slice(40) + '\n');
    const s = await read();
    assert.strictEqual(s.totals.requests, 3);
    assert.deepStrictEqual(s.top.tools, [['Bash', 1], ['Read', 1], ['Skill', 1]], 'nothing counted twice');
  });

  it('starts over when the file is replaced by a shorter one', async function() {
    fs.writeFileSync(file, lines(RECORDS));
    assert.strictEqual((await read()).totals.requests, 4);
    fs.writeFileSync(file, lines(RECORDS.slice(0, 2)));
    assert.strictEqual((await read()).totals.requests, 1);
  });

  it("adds up sub-agents separately", async function() {
    fs.writeFileSync(file, lines(RECORDS));
    const subDir = path.join(projectDir, CONV, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'agent-a1.jsonl'), lines([
      assistant('msg_S1', '2026-11-05T01:00:20.000Z', [{ type: 'text', text: 'x' }], u(4, 100, 200, 30))
    ]));
    const s = await read();
    assert.strictEqual(s.subagents.count, 1);
    assert.strictEqual(s.subagents.totals.requests, 1);
    assert.strictEqual(s.subagents.totals.output, 30);
    assert.strictEqual(s.totals.requests, 4, 'not mixed into the conversation');
  });

  it('answers null for no transcript or a bad id', async function() {
    assert.strictEqual(await read(), null);
    assert.strictEqual(await usage.conversationUsage(workDir, '../etc', { root: path.join(root, 'projects') }), null);
  });
});

describe('claude-usage: prices', function() {
  it('matches model ids exactly, with or without a suffix', function() {
    assert.deepStrictEqual(usage.priceFor('claude-opus-5-5'), { input: 4, output: 20, cacheRead: 0.2 });
    assert.deepStrictEqual(usage.priceFor('claude-opus-5'), { input: 5, output: 25, cacheRead: 0.5 });
    assert.deepStrictEqual(usage.priceFor('claude-opus-5-5[1m]'), usage.priceFor('claude-opus-5-5'));
    assert.deepStrictEqual(usage.priceFor('us.anthropic.claude-sonnet-4-6'), { input: 3, output: 15, cacheRead: 0.3 });
    assert.deepStrictEqual(usage.priceFor('claude-haiku-4-5-20251001'), { input: 1, output: 5, cacheRead: 0.1 });
    assert.strictEqual(usage.priceFor('claude-opus-4-1'), null, 'not listed: no guess');
    assert.strictEqual(usage.priceFor('<synthetic>'), null);
  });

  it('prices cache writes by their TTL, and fast mode at double', function() {
    const M = 1e6;
    const base = { model: 'claude-opus-5-5', input: 0, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 0, output: 0 };
    assert.strictEqual(usage.costOf({ ...base, input: M }), 4);
    assert.strictEqual(usage.costOf({ ...base, cacheCreate: M }), 5, '5-minute write: 1.25x');
    assert.strictEqual(usage.costOf({ ...base, cacheCreate: M, cacheCreate1h: M }), 8, '1-hour write: 2x');
    assert.strictEqual(usage.costOf({ ...base, cacheRead: M }), 0.2);
    assert.strictEqual(usage.costOf({ ...base, output: M }), 20);
    assert.strictEqual(usage.costOf({ ...base, output: M, fast: true }), 40);
    assert.strictEqual(usage.costOf({ ...base, model: 'x' }), null);
  });

  it('finds the program a Bash command runs', function() {
    assert.strictEqual(usage.programOf('cd /x && git status'), 'git');
    assert.strictEqual(usage.programOf('FOO=1 npm test'), 'npm');
    assert.strictEqual(usage.programOf('sudo apt install x'), 'apt');
    assert.strictEqual(usage.programOf('"C:/Program Files/nodejs/node.exe" a.js'), 'node');
    assert.strictEqual(usage.programOf("& 'C:\\Program Files\\nodejs\\node.exe' x"), 'node');
    assert.strictEqual(usage.programOf('cd /a; cd b'), null);
    assert.strictEqual(usage.programOf(''), null);
  });
});

describe('usage routes', function() {
  let server;
  let root;

  function call(route, req) {
    const layer = server.app._router.stack.find((l) => l.route && l.route.path === route && l.route.methods.get);
    return new Promise((resolve) => {
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { resolve({ status: this.statusCode, body }); return this; }
      };
      layer.route.stack[0].handle({ query: {}, params: {}, headers: {}, ...req }, res, (e) => resolve({ status: 500, body: String(e) }));
    });
  }

  beforeEach(function() {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-usage-r-'));
    server = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
    // Never the real ~/.claude.
    server.projectsDirFor = () => path.join(root, 'projects');
    usage._cache.clear();
  });
  afterEach(function() {
    if (server && typeof server.dispose === 'function') server.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function seed(workDir, id) {
    const projectDir = path.join(root, 'projects', workDir.replace(/[^A-Za-z0-9]/g, '-'));
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, `${id}.jsonl`), lines(RECORDS));
  }

  it("reads the conversation Claude is writing to now, with the ring's last snapshot", async function() {
    const workDir = path.join(root, 'w');
    fs.mkdirSync(workDir);
    const sid = '00000001-1111-2222-3333-444444444444';
    // A /clear moved Claude to CONV: that is the one to read.
    seed(workDir, CONV);
    server.claudeSessions.set(sid, { id: sid, name: 'tab', workingDir: workDir, claudeConversationId: CONV, connections: new Set(), liveUsage: { ctxPct: 3 } });
    const { status, body } = await call('/api/sessions/:sessionId/usage', { params: { sessionId: sid } });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.name, 'tab');
    assert.strictEqual(body.usage.totals.requests, 4);
    assert.strictEqual(body.usage.conversationId, CONV);
    assert.deepStrictEqual(body.liveUsage, { ctxPct: 3 });
  });

  it('says so when the tab has no transcript yet, and 404s an unknown tab', async function() {
    const sid = '00000002-1111-2222-3333-444444444444';
    server.claudeSessions.set(sid, { id: sid, name: 't', workingDir: root, connections: new Set() });
    const empty = await call('/api/sessions/:sessionId/usage', { params: { sessionId: sid } });
    assert.strictEqual(empty.status, 200);
    assert.strictEqual(empty.body.usage, null);
    const missing = await call('/api/sessions/:sessionId/usage', { params: { sessionId: '00000009-1111-2222-3333-444444444444' } });
    assert.strictEqual(missing.status, 404);
  });

  it('reads a history conversation by id and folder, and refuses a bad id', async function() {
    const workDir = path.join(root, 'h');
    fs.mkdirSync(workDir);
    seed(workDir, CONV);
    const ok = await call('/api/claude-sessions/:conversationId/usage', { params: { conversationId: CONV }, query: { dir: workDir } });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.usage.totals.requests, 4);
    const bad = await call('/api/claude-sessions/:conversationId/usage', { params: { conversationId: 'nope' }, query: { dir: workDir } });
    assert.strictEqual(bad.status, 400);
    const noDir = await call('/api/claude-sessions/:conversationId/usage', { params: { conversationId: CONV } });
    assert.strictEqual(noDir.status, 400);
  });
});
