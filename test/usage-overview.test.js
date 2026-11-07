const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const usage = require('../src/utils/claude-usage');
const UsageView = require('../src/public/usage-panel');
const { ClaudeCodeWebServer } = require('../src/server');

// The overview reads every conversation under one Claude projects directory.
// Each case builds that directory in a temp dir; nothing reads ~/.claude.
const NOW = Date.parse('2026-11-06T12:00:00Z');
const DAY = 86400000;
const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];

const req = (id, t, n, model = 'claude-opus-5-5') => ({
  type: 'assistant', timestamp: new Date(t).toISOString(), cwd: '/w/app',
  message: { id, model, role: 'assistant', content: [{ type: 'tool_use', id: 'tu_' + id, name: 'Bash', input: { command: 'git log' } }],
    usage: { input_tokens: n, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } }
});
const write = (file, records) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r) + '\n').join(''));
};

describe('usage overview', function() {
  let root;

  beforeEach(function() {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-ov-'));
    usage._cache.clear();
    const proj = path.join(root, '-w-app');
    // Today and yesterday, titled by Claude.
    write(path.join(proj, `${ids[0]}.jsonl`), [
      { type: 'user', timestamp: new Date(NOW - DAY).toISOString(), message: { role: 'user', content: 'first question' } },
      req('m1', NOW - DAY, 1000),
      req('m2', NOW - 60000, 2000),
      { type: 'ai-title', aiTitle: 'Fix the build' }
    ]);
    // Twenty days ago: in 30d, not in 7d. A person's title beats Claude's.
    write(path.join(proj, `${ids[1]}.jsonl`), [
      { type: 'user', timestamp: new Date(NOW - 20 * DAY).toISOString(), message: { role: 'user', content: 'old one' } },
      req('m3', NOW - 20 * DAY, 500),
      { type: 'ai-title', aiTitle: 'Claude title' },
      { type: 'custom-title', customTitle: 'Mine' }
    ]);
    fs.utimesSync(path.join(proj, `${ids[1]}.jsonl`), new Date(NOW - 20 * DAY), new Date(NOW - 20 * DAY));
    // No title at all: the first prompt stands in. Its sub-agent counts too.
    write(path.join(proj, `${ids[2]}.jsonl`), [
      { type: 'user', timestamp: new Date(NOW - 2 * DAY).toISOString(), message: { role: 'user', content: '<command-name>/clear</command-name>' } },
      { type: 'user', timestamp: new Date(NOW - 2 * DAY).toISOString(), message: { role: 'user', content: 'what does   this do' } },
      req('m4', NOW - 2 * DAY, 300)
    ]);
    write(path.join(proj, ids[2], 'subagents', 'agent-x.jsonl'), [req('m5', NOW - 2 * DAY, 700)]);
  });
  afterEach(function() { fs.rmSync(root, { recursive: true, force: true }); });

  const run = (days) => usage.overview(root, { sinceMs: days ? NOW - days * DAY : 0, now: NOW, tzOffsetMin: 0, chartDays: days === 7 ? 7 : 30 });

  it('counts the range by when requests were made', async function() {
    const o = await run(7);
    assert.strictEqual(o.scanning, false);
    assert.strictEqual(o.totals.sessions, 2);
    assert.strictEqual(o.totals.requests, 4, 'm1, m2, m4 and the sub-agent m5');
    assert.strictEqual(o.totals.input, 1000 + 2000 + 300 + 700);
    const all = await run(0);
    assert.strictEqual(all.totals.sessions, 3);
  });

  it('puts each request on its own day, in the reader\'s time zone', async function() {
    const o = await run(7);
    assert.deepStrictEqual(o.days.map((d) => d.day), ['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']);
    const by = Object.fromEntries(o.days.map((d) => [d.day, d.tokens]));
    assert.strictEqual(by['2026-11-06'], 2000);
    assert.strictEqual(by['2026-11-05'], 1000);
    assert.strictEqual(by['2026-11-04'], 300 + 700);
    // getTimezoneOffset() 720 is UTC-12: "now" (12:00 UTC on the 6th) is
    // midnight on the 6th there, but 11:59 UTC is 23:59 on the 5th — so the
    // last request moves to the 5th, beside the one that was already there.
    usage._cache.clear();
    const west = await usage.overview(root, { sinceMs: NOW - 7 * DAY, now: NOW, tzOffsetMin: 12 * 60, chartDays: 7 });
    const wby = Object.fromEntries(west.days.map((d) => [d.day, d.tokens]));
    assert.strictEqual(west.days[west.days.length - 1].day, '2026-11-06');
    assert.strictEqual(wby['2026-11-06'], 0);
    assert.strictEqual(wby['2026-11-05'], 1000 + 2000);
    assert.strictEqual(west.heatmap.length, 56);
  });

  it('names each conversation: a typed title, then Claude\'s, then the first prompt', async function() {
    const o = await run(0);
    const titles = Object.fromEntries(o.sessions.map((s) => [s.id, s.title]));
    assert.strictEqual(titles[ids[0]], 'Fix the build');
    assert.strictEqual(titles[ids[1]], 'Mine');
    assert.strictEqual(titles[ids[2]], 'what does this do');
    assert.strictEqual(o.sessions[0].id, ids[0], 'most recent first');
    assert.strictEqual(o.sessions[0].cwd, '/w/app');
    assert.strictEqual(o.sessions.find((s) => s.id === ids[2]).subagents, 1);
    // Counted per conversation (m1–m4); a sub-agent's tools stay its own.
    assert.deepStrictEqual(o.top.programs, [['git', 4]]);
  });

  it('answers within its budget while a big scan runs, then completes', async function() {
    const slow = usage.overview(root, { sinceMs: 0, now: NOW, budgetMs: 0 });
    const first = await slow;
    assert.strictEqual(typeof first.scanning, 'boolean');
    assert.ok(first.files.total === 3);
    const later = await run(0);
    assert.strictEqual(later.scanning, false);
    assert.strictEqual(later.files.read, 3);
  });

  it('sums each account, and narrows the rest to one when asked', async function() {
    const owners = { [ids[0]]: 'u-a', [ids[2]]: 'u-b' };
    const groupOf = (id) => owners[id] || '';
    const all = await usage.overview(root, { sinceMs: 0, now: NOW, groupOf });
    const by = Object.fromEntries(all.groups.map((g) => [g.id, g]));
    assert.deepStrictEqual(Object.keys(by).sort(), ['', 'u-a', 'u-b']);
    assert.strictEqual(by['u-a'].tokens, 3000);
    assert.strictEqual(by['u-b'].tokens, 1000, 'the sub-agent counts for its conversation\'s account');
    assert.strictEqual(by[''].sessions, 1);
    assert.strictEqual(all.groups[0].id, 'u-a', 'largest first');
    assert.strictEqual(all.totals.sessions, 3);

    const one = await usage.overview(root, { sinceMs: 0, now: NOW, groupOf, group: 'u-b' });
    assert.deepStrictEqual(one.sessions.map((s) => s.id), [ids[2]]);
    assert.strictEqual(one.totals.input, 1000);
    assert.strictEqual(one.heatmap.reduce((n, d) => n + d.tokens, 0), 1000);
    assert.strictEqual(one.groups.length, 3, 'the breakdown still shows every account');
    const none = await usage.overview(root, { sinceMs: 0, now: NOW, groupOf, group: '' });
    assert.deepStrictEqual(none.sessions.map((s) => s.id), [ids[1]]);
  });

  it('leaves the breakdown out when nothing groups the conversations', async function() {
    const o = await run(0);
    assert.strictEqual(o.groups, undefined);
  });

  describe('route', function() {
    let server;
    beforeEach(function() {
      server = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
      server.projectsDirFor = () => root;
    });
    afterEach(function() { if (server && server.dispose) server.dispose(); });

    function call(query) {
      const layer = server.app._router.stack.find((l) => l.route && l.route.path === '/api/usage/overview');
      return new Promise((resolve) => {
        const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; } };
        layer.route.stack[0].handle({ query, params: {}, headers: {} }, res, (e) => resolve({ status: 500, body: String(e) }));
      });
    }

    it('reads the caller\'s own Claude directory, and flags a conversation a tab holds', async function() {
      server.claudeSessions.set(ids[0], { id: ids[0], name: 't', workingDir: '/w/app', connections: new Set() });
      const { status, body } = await call({ range: 'all', tz: '0' });
      assert.strictEqual(status, 200);
      assert.strictEqual(body.range, 'all');
      assert.strictEqual(body.days.length, 30);
      const held = body.sessions.find((s) => s.id === ids[0]);
      assert.strictEqual(held.openSessionId, ids[0]);
      assert.strictEqual(body.sessions.find((s) => s.id === ids[2]).openSessionId, undefined);
    });

    it('falls back to 7 days and UTC for a range or zone it does not know', async function() {
      const { body } = await call({ range: '1y', tz: '99999' });
      assert.strictEqual(body.range, '7d');
      assert.strictEqual(body.days.length, 7);
    });
  });
});

describe('usage overview view', function() {
  const data = {
    range: '7d', scanning: true, files: { read: 2, total: 5 },
    totals: { sessions: 2, requests: 4, input: 4000, cacheRead: 0, cacheCreate: 0, output: 0, costUsd: 0.016, unpriced: 0, cacheHitRate: 0 },
    days: [{ day: '2026-11-05', tokens: 1000, costUsd: 0.004, requests: 1 }, { day: '2026-11-06', tokens: 3000, costUsd: 0.012, requests: 3 }],
    heatmap: Array.from({ length: 56 }, (_, i) => ({ day: new Date(Date.parse('2026-09-12T00:00:00Z') + i * 86400000).toISOString().slice(0, 10), tokens: i % 3 ? i * 10 : 0, costUsd: 0, requests: 0 })),
    sessions: [
      { id: 'a', title: '<b>Fix</b>', cwd: '/w/app', tokens: 3000, costUsd: 0.012, requests: 3, lastAt: '2026-11-06T11:59:00Z', openSessionId: 'a', cacheHitRate: 0, ctx: 2000, subagents: 0 },
      { id: 'b', title: null, cwd: '/w/other/deep', tokens: 9000, costUsd: 0.004, requests: 1, lastAt: '2026-11-05T12:00:00Z', cacheHitRate: 0, ctx: 1000, subagents: 0 }
    ],
    sessionsTotal: 2,
    top: { tools: [['Bash', 3]], programs: [['git', 3]], skills: [], commands: [['clear', 1]] }
  };
  const NOW_MS = Date.parse('2026-11-06T12:00:00Z');

  it('lists accounts with their share, the chosen one marked, and names the account on rows', function() {
    const withAccounts = Object.assign({}, data, {
      owner: 'all',
      groups: [
        { id: 'u-1', name: '<i>alice</i>', me: true, sessions: 2, requests: 4, tokens: 3000, costUsd: 0.012 },
        { id: '', name: '不在 cc-web 里', me: false, sessions: 1, requests: 1, tokens: 1000, costUsd: 0.004 },
        { id: 'others', name: '其他账号', me: false, sessions: 1, requests: 1, tokens: 0, costUsd: 0 }
      ],
      sessions: data.sessions.map((s) => Object.assign({}, s, { account: 'alice' }))
    });
    const html = UsageView.overview(withAccounts, { now: NOW_MS });
    assert.ok(html.includes('按账号'));
    assert.ok(html.includes('&lt;i&gt;alice&lt;/i&gt;') && !html.includes('<i>alice'));
    assert.ok(/usage-owner-btn usage-mode-btn active" data-owner="all"/.test(html));
    assert.ok(html.includes('data-owner="me"') && html.includes('data-owner="none"'));
    assert.ok(html.includes('width:75.0%'), 'alice has three quarters of the Token');
    assert.ok(!/<button[^>]*data-owner="others"/.test(html), '其他账号 is not a filter');
    assert.ok(html.includes('alice · '), 'rows name their account under 全部');
    const mine = UsageView.overview(Object.assign({}, withAccounts, { owner: 'me' }), { now: NOW_MS });
    assert.ok(/usage-acct usage-owner-btn active" data-owner="me"/.test(mine));
    assert.ok(!mine.includes('alice · '));
    assert.ok(!UsageView.overview(data, { now: NOW_MS }).includes('按账号'), 'no accounts, no section');
  });

  it('shows the scan in progress, the range, and the cost as an API estimate', function() {
    const html = UsageView.overview(data, { now: NOW_MS });
    assert.ok(html.includes('正在读取对话记录（2 / 5）'));
    assert.ok(html.includes('data-range="7d"') && /usage-range-btn usage-mode-btn active" data-range="7d"/.test(html));
    assert.ok(html.includes('花费（API 折算）'));
  });

  it('lists conversations, escaped, the open one marked, sortable', function() {
    const html = UsageView.overview(data, { now: NOW_MS });
    assert.ok(!html.includes('<b>Fix</b>') && html.includes('&lt;b&gt;Fix&lt;/b&gt;'));
    assert.ok(html.includes('已打开'));
    assert.ok(html.includes('（无标题）'));
    assert.ok(html.includes('1 分钟前'));
    assert.deepStrictEqual(UsageView.sortSessions(data.sessions, 'tokens').map((s) => s.id), ['b', 'a']);
    assert.deepStrictEqual(UsageView.sortSessions(data.sessions, 'cost').map((s) => s.id), ['a', 'b']);
  });

  it('draws eight weeks starting on a Monday column, in four shades', function() {
    const html = UsageView.heatmap(data.heatmap);
    // 2026-09-12 is a Saturday: five blanks put it on the sixth row.
    assert.strictEqual((html.match(/u-blank/g) || []).length, 5);
    assert.strictEqual((html.match(/data-level=/g) || []).length, 56);
    assert.ok(html.includes('data-level="0"') && html.includes('data-level="4"'));
  });

  it('gives every day a bar with its numbers on hover', function() {
    const svg = UsageView.dailySvg(data.days);
    assert.strictEqual((svg.match(/<rect/g) || []).length, 2);
    assert.ok(svg.includes('2026-11-06\n3k Token · 3 个请求\n$0.01（API 折算）'));
  });
});
