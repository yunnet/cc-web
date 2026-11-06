// The context ring on a session tab: how full Claude's context window is, from
// the statusLine snapshot the server relays (server.liveUsageFrom). Pure, like
// claude-title.js, so the browser loads it and the tests require it.
//
// Cost is Claude's own figure. For a subscription that is what the tokens
// would have cost on the API, not a bill — hence "API 折算" wherever it shows.
// And it counts this Claude process only: measured on 2.1.304, a resumed
// conversation starts again at $0.00 — hence "本次运行", not "本会话".

var ContextRing = (function () {
  // Where the colour turns: Claude starts compacting near the top, so amber is
  // "plan for it" and red is "it is about to happen".
  var WARN_PCT = 60;
  var FULL_PCT = 85;
  var RADIUS = 5;
  var CIRCUMFERENCE = 2 * Math.PI * RADIUS;

  function level(pct) {
    if (typeof pct !== 'number' || !isFinite(pct)) return 'unknown';
    if (pct >= FULL_PCT) return 'full';
    if (pct >= WARN_PCT) return 'warn';
    return 'ok';
  }

  // 1234 → "1.2k", 1000000 → "1M": tab-tooltip precision.
  function tokens(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '?';
    if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'k';
    return String(Math.round(n));
  }

  function usd(n) {
    if (typeof n !== 'number' || !isFinite(n)) return null;
    return '$' + (n < 10 ? n.toFixed(2) : n.toFixed(1));
  }

  // The tab tooltip, one fact per line.
  function tooltip(usage) {
    if (!usage) return '';
    var lines = [];
    if (typeof usage.ctxPct === 'number') {
      var size = usage.ctxSize ? ' · ' + tokens(usage.ctxUsed) + ' / ' + tokens(usage.ctxSize) : '';
      lines.push('上下文 ' + usage.ctxPct + '%' + size);
    }
    var cost = usd(usage.costUsd);
    if (cost) lines.push('本次运行 ' + cost + '（API 折算）');
    if (usage.model) lines.push(usage.model);
    var limits = [];
    if (typeof usage.fiveHourPct === 'number') limits.push('5 小时 ' + usage.fiveHourPct + '%');
    if (typeof usage.sevenDayPct === 'number') limits.push('7 天 ' + usage.sevenDayPct + '%');
    if (limits.length) lines.push('额度 ' + limits.join(' · '));
    return lines.join('\n');
  }

  // stroke-dasharray for the filled arc. Clamped, and a sliver always shows
  // once there is anything at all, so 0.4% does not read as "no data".
  function dash(pct) {
    var p = typeof pct === 'number' && isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
    var filled = p > 0 ? Math.max(CIRCUMFERENCE * p / 100, 1.5) : 0;
    return filled.toFixed(2) + ' ' + CIRCUMFERENCE.toFixed(2);
  }

  function svg(pct) {
    return '<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">' +
      '<circle class="ctx-track" cx="7" cy="7" r="' + RADIUS + '"/>' +
      '<circle class="ctx-fill" cx="7" cy="7" r="' + RADIUS + '" stroke-dasharray="' + dash(pct) + '" transform="rotate(-90 7 7)"/>' +
      '</svg>';
  }

  return { level: level, tokens: tokens, usd: usd, tooltip: tooltip, dash: dash, svg: svg, WARN_PCT: WARN_PCT, FULL_PCT: FULL_PCT };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ContextRing;
