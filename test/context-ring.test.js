const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ContextRing = require('../src/public/context-ring');

describe('context ring', function() {
  it('turns amber at 60% and red at 85%', function() {
    assert.strictEqual(ContextRing.level(0), 'ok');
    assert.strictEqual(ContextRing.level(59), 'ok');
    assert.strictEqual(ContextRing.level(60), 'warn');
    assert.strictEqual(ContextRing.level(84), 'warn');
    assert.strictEqual(ContextRing.level(85), 'full');
    assert.strictEqual(ContextRing.level(null), 'unknown');
  });

  it('shortens token counts for a tooltip', function() {
    assert.strictEqual(ContextRing.tokens(950), '950');
    assert.strictEqual(ContextRing.tokens(55706), '55.7k');
    assert.strictEqual(ContextRing.tokens(124000), '124k');
    assert.strictEqual(ContextRing.tokens(1000000), '1M');
    assert.strictEqual(ContextRing.tokens(null), '?');
  });

  // Claude's total_cost_usd counts this process only: measured on 2.1.304, a
  // resumed conversation starts again at $0.00. Hence "this run".
  it('says the cost is the API equivalent, for this run', function() {
    const tip = ContextRing.tooltip({
      ctxPct: 62, ctxUsed: 124000, ctxSize: 200000, costUsd: 1.234, model: 'Opus 5.5', fiveHourPct: 8, sevenDayPct: 40
    });
    assert.strictEqual(tip, '上下文 62% · 124k / 200k\n本次运行 $1.23（API 折算）\nOpus 5.5\n额度 5 小时 8% · 7 天 40%');
  });

  it('leaves out what it does not know', function() {
    assert.strictEqual(ContextRing.tooltip({ ctxPct: 5, ctxSize: null, costUsd: null }), '上下文 5%');
    assert.strictEqual(ContextRing.tooltip(null), '');
  });

  it('draws a visible sliver for a tiny share and clamps past 100%', function() {
    const filled = (pct) => Number(ContextRing.dash(pct).split(' ')[0]);
    assert.strictEqual(filled(0), 0);
    assert.ok(filled(0.4) >= 1.5);
    assert.strictEqual(filled(150), filled(100));
  });

  it('is on the page before app.js, which opens the sockets that feed it', function() {
    // session-manager.js only touches ContextRing when a message arrives,
    // which is after every script has loaded.
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'index.html'), 'utf8');
    const at = (name) => html.indexOf(`<script src="${name}"></script>`);
    assert.ok(at('context-ring.js') > -1);
    assert.ok(at('context-ring.js') < at('app.js'));
  });
});
