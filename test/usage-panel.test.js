const assert = require('assert');
const fs = require('fs');
const path = require('path');
const UsageView = require('../src/public/usage-panel');

// A usage summary as the server returns it (utils/claude-usage.summarize).
const usage = (over = {}) => ({
  totals: { requests: 3, input: 6, cacheRead: 46000, cacheCreate: 12500, output: 225, costUsd: 0.1234, unpriced: 0, cacheHitRate: 0.78, models: { 'claude-opus-5-5': 3 } },
  firstAt: '2026-11-05T01:00:00.000Z',
  lastAt: '2026-11-05T02:30:00.000Z',
  current: { t: '2026-11-05T02:30:00.000Z', model: 'claude-opus-5-5', ctx: 6005, input: 5, cacheRead: 4000, cacheCreate: 2000 },
  trend: {
    skipped: 0,
    requests: [
      { t: '2026-11-05T01:00:05.000Z', model: 'claude-opus-5-5', input: 0, cacheRead: 16000, cacheCreate: 10000, output: 105 },
      { t: '2026-11-05T01:00:10.000Z', model: 'claude-opus-5-5', input: 1, cacheRead: 26000, cacheCreate: 500, output: 80 },
      { t: '2026-11-05T02:30:00.000Z', model: 'claude-opus-5-5', input: 5, cacheRead: 4000, cacheCreate: 2000, output: 40 }
    ],
    compactions: [{ t: '2026-11-05T01:01:30.000Z', trigger: 'manual', preTokens: 26503, atRequest: 2 }]
  },
  top: {
    tools: [['Bash', 3], ['<img src=x onerror=alert(1)>', 1]],
    programs: [['git', 2]],
    skills: [['tech', 1]],
    commands: [['compact', 2]],
    files: [['/w/src/deep/app.js', 2, { read: 1, edit: 1, write: 0 }]]
  },
  subagents: { count: 0, totals: { requests: 0, input: 0, cacheRead: 0, cacheCreate: 0, output: 0, costUsd: null } },
  ...over
});

describe('usage panel view', function() {
  it('shows the headline numbers, cost marked as an API estimate', function() {
    const html = UsageView.session({ usage: usage() }, 'total');
    assert.ok(html.includes('>3<'), 'requests');
    assert.ok(html.includes('58.7k'), 'all tokens');
    assert.ok(html.includes('78%'), 'cache hit rate');
    assert.ok(html.includes('$0.12'), 'cost');
    assert.ok(html.includes('花费（API 折算）'));
    assert.ok(html.includes('1.5 小时'), 'span');
    assert.ok(!html.includes('子 Agent'), 'no sub-agent cell without sub-agents');
  });

  it('says when some requests could not be priced', function() {
    const u = usage();
    u.totals.unpriced = 2;
    assert.ok(UsageView.session({ usage: u }, 'total').includes('2 个请求的模型没有价格'));
  });

  it('draws the context against the window when the ring knows its size', function() {
    const html = UsageView.now(usage(), { ctxSize: 200000 });
    assert.ok(html.includes('当前上下文 6k / 200k（3%）'), html);
    assert.ok(html.includes('剩余'));
    assert.ok(!UsageView.now(usage(), null).includes('剩余'));
  });

  it('marks the compaction on the trend, and shows shrinkage in delta mode', function() {
    const total = UsageView.trendSvg(usage().trend, 'total');
    assert.ok(total.includes('✂'));
    assert.ok(total.includes('压缩（手动 /compact）：压缩前 26.5k'));
    assert.strictEqual((total.match(/<g><title>/g) || []).length, 3, 'one bar per request');
    const delta = UsageView.trendSvg(usage().trend, 'delta');
    assert.ok(delta.includes('u-shrink'), 'the drop after the compaction');
    assert.ok(delta.includes('u-zero'));
  });

  it('says how many requests the trend left out', function() {
    const u = usage();
    u.trend.skipped = 500;
    assert.ok(UsageView.session({ usage: u }, 'total').includes('前面还有 500 个'));
  });

  it('never lets a tool name, path or command become markup', function() {
    const html = UsageView.session({ usage: usage() }, 'total');
    assert.ok(!html.includes('<img'));
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  });

  it('lists files by their last two parts, the full path on hover', function() {
    const html = UsageView.tops(usage());
    assert.ok(html.includes('>…/deep/app.js<'));
    assert.ok(html.includes('/w/src/deep/app.js'));
    assert.ok(html.includes('/compact'), 'slash commands with skills');
  });

  it('explains an empty tab instead of showing zeros', function() {
    assert.ok(UsageView.session({ usage: null }, 'total').includes('还没有对话记录'));
  });

  it('is on the page, after the tab code that opens it', function() {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'index.html'), 'utf8');
    const at = (name) => html.indexOf(`<script src="${name}"></script>`);
    assert.ok(at('usage-panel.js') > -1 && at('usage-panel.js') < at('app.js'));
    assert.ok(html.includes('id="usageModal"') && html.includes('id="usageBody"'));
  });
});
