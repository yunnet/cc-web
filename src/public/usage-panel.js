// The usage panel: what one tab's Claude conversation has used, read from its
// transcript by the server (GET /api/sessions/:id/usage, utils/claude-usage.js).
//
//   KPIs         requests, tokens, cache hit rate, estimated cost, time span
//   now          what the context window holds after the latest request
//   trend        one bar per request — Total (what was sent) or Delta (how
//                much it grew or shrank) — with ✂ where Claude compacted
//   top lists    tools, programs run through Bash, files touched, skills and
//                slash commands
//
// The idea is borrowed from dsh-context (DeepSeek Harness); none of its code.
// Cost is an API-price estimate ("API 折算"), not a bill. UsageView is pure —
// strings in, strings out — so the tests require it; the modal glue below it
// runs only in the browser.

var UsageView = (function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // A hover text: data, never markup.
  function tip(s) {
    return ' title=' + '"' + esc(s) + '"';
  }

  function tokens(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    var a = Math.abs(n);
    var sign = n < 0 ? '-' : '';
    if (a >= 1e9) return sign + (a / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (a >= 1e6) return sign + (a / 1e6).toFixed(a >= 1e8 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (a >= 1e3) return sign + (a / 1e3).toFixed(a >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'k';
    return sign + String(Math.round(a));
  }

  function usd(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    return '$' + (n < 10 ? n.toFixed(2) : n < 1000 ? n.toFixed(1) : Math.round(n).toLocaleString('en-US'));
  }

  function pct(r) {
    return typeof r === 'number' && isFinite(r) ? Math.round(r * 100) + '%' : '—';
  }

  function span(from, to) {
    var a = Date.parse(from), b = Date.parse(to);
    if (!isFinite(a) || !isFinite(b) || b < a) return '—';
    var m = Math.round((b - a) / 60000);
    if (m < 60) return m + ' 分钟';
    if (m < 60 * 48) return (m / 60).toFixed(1).replace(/\.0$/, '') + ' 小时';
    return Math.round(m / 1440) + ' 天';
  }

  function ctxOf(r) { return r.input + r.cacheRead + r.cacheCreate; }

  function kpis(usage) {
    var t = usage.totals;
    var all = t.input + t.cacheRead + t.cacheCreate + t.output;
    var sub = usage.subagents && usage.subagents.count ? usage.subagents : null;
    var cells = [
      ['请求', String(t.requests)],
      ['Token', tokens(all), '输入 ' + tokens(t.input) + ' · 缓存读 ' + tokens(t.cacheRead) + ' · 缓存写 ' + tokens(t.cacheCreate) + ' · 输出 ' + tokens(t.output)],
      ['缓存命中', pct(t.cacheHitRate), '缓存读 ÷ 全部输入'],
      ['花费（API 折算）', usd(t.costUsd), t.unpriced ? t.unpriced + ' 个请求的模型没有价格，未计入' : '按 API 价格估算，订阅不按此计费'],
      ['时长', span(usage.firstAt, usage.lastAt)]
    ];
    if (sub) {
      cells.push(['子 Agent', sub.count + ' 个', tokens(sub.totals.input + sub.totals.cacheRead + sub.totals.cacheCreate + sub.totals.output) + ' Token · ' + usd(sub.totals.costUsd) + '（API 折算）']);
    }
    return '<div class="usage-kpis">' + cells.map(function (c) {
      return '<div class="usage-kpi"' + (c[2] ? tip(c[2]) : '') + '><div class="usage-kpi-value">' + esc(c[1]) +
        '</div><div class="usage-kpi-label">' + esc(c[0]) + '</div></div>';
    }).join('') + '</div>';
  }

  // The latest request's prompt, split by where it came from, against the
  // window when the statusLine told us its size.
  function now(usage, live) {
    var c = usage.current;
    if (!c) return '';
    var windowSize = live && live.ctxSize ? live.ctxSize : null;
    var whole = windowSize && windowSize > c.ctx ? windowSize : c.ctx;
    var part = function (cls, n, label) {
      var w = whole ? (n / whole) * 100 : 0;
      return w > 0 ? '<span class="usage-seg ' + cls + '" style="width:' + w.toFixed(2) + '%"' + tip(label + ' ' + tokens(n)) + '></span>' : '';
    };
    var caption = '当前上下文 ' + tokens(c.ctx) + (windowSize ? ' / ' + tokens(windowSize) + '（' + Math.round((c.ctx / windowSize) * 100) + '%）' : '');
    return '<div class="usage-section"><div class="usage-section-title">' + esc(caption) + '</div>' +
      '<div class="usage-bar">' + part('u-read', c.cacheRead, '缓存读') + part('u-write', c.cacheCreate, '缓存写') + part('u-input', c.input, '新输入') + '</div>' +
      '<div class="usage-legend"><span><i class="u-read"></i>缓存读</span><span><i class="u-write"></i>缓存写</span><span><i class="u-input"></i>新输入</span>' +
      (windowSize ? '<span><i class="u-free"></i>剩余</span>' : '') + '</div></div>';
  }

  var BAR = 6, GAP = 2, HEIGHT = 140;

  // One bar per request. Total: the prompt that request sent, stacked by
  // source. Delta: how much it grew (up) or shrank (down) from the request
  // before — a compaction is the long bar down, and it is marked ✂.
  function trendSvg(trend, mode) {
    var reqs = trend.requests;
    if (!reqs.length) return '<div class="usage-empty">还没有请求</div>';
    var delta = mode === 'delta';
    var values = reqs.map(function (r, i) { return delta ? ctxOf(r) - (i ? ctxOf(reqs[i - 1]) : 0) : ctxOf(r); });
    // In delta mode one compaction (hundreds of k down) would flatten every
    // other bar, so the scale is the 98th percentile and taller bars are
    // clipped — their tooltip still has the real number.
    var mags = values.map(Math.abs).sort(function (a, b) { return a - b; });
    var max = Math.max(delta ? mags[Math.min(mags.length - 1, Math.floor(mags.length * 0.98))] : mags[mags.length - 1], 1);
    var width = reqs.length * (BAR + GAP);
    var zero = delta ? HEIGHT / 2 : HEIGHT;
    var scale = (delta ? HEIGHT / 2 - 4 : HEIGHT - 4) / max;
    var out = [];
    reqs.forEach(function (r, i) {
      var x = i * (BAR + GAP);
      var tip = '#' + (trend.skipped + i + 1) + (r.t ? ' · ' + r.t.replace('T', ' ').slice(0, 19) : '') +
        '\n上下文 ' + tokens(ctxOf(r)) + (delta ? '（' + (values[i] >= 0 ? '+' : '') + tokens(values[i]) + '）' : '') +
        '\n缓存读 ' + tokens(r.cacheRead) + ' · 缓存写 ' + tokens(r.cacheCreate) + ' · 新输入 ' + tokens(r.input) + '\n输出 ' + tokens(r.output) +
        (r.model ? '\n' + r.model : '');
      out.push('<g><title>' + esc(tip) + '</title>');
      if (delta) {
        var h = Math.min(Math.max(Math.abs(values[i]) * scale, values[i] ? 1 : 0), HEIGHT / 2 - 2);
        out.push('<rect class="' + (values[i] >= 0 ? 'u-input' : 'u-shrink') + '" x="' + x + '" y="' + (values[i] >= 0 ? zero - h : zero).toFixed(1) +
          '" width="' + BAR + '" height="' + h.toFixed(1) + '"/>');
      } else {
        var y = zero;
        [['u-read', r.cacheRead], ['u-write', r.cacheCreate], ['u-input', r.input]].forEach(function (s) {
          var hh = s[1] * scale;
          if (hh <= 0) return;
          y -= hh;
          out.push('<rect class="' + s[0] + '" x="' + x + '" y="' + y.toFixed(1) + '" width="' + BAR + '" height="' + hh.toFixed(1) + '"/>');
        });
      }
      out.push('</g>');
    });
    (trend.compactions || []).forEach(function (c) {
      if (c.atRequest < 0 || c.atRequest > reqs.length) return;
      var x = Math.max(0, c.atRequest * (BAR + GAP) - GAP / 2);
      var tip = '压缩' + (c.trigger === 'auto' ? '（自动）' : c.trigger === 'manual' ? '（手动 /compact）' : '') +
        (c.preTokens ? '：压缩前 ' + tokens(c.preTokens) : '') + (c.t ? '\n' + c.t.replace('T', ' ').slice(0, 19) : '');
      out.push('<g class="u-compact"><title>' + esc(tip) + '</title><line x1="' + x + '" x2="' + x + '" y1="10" y2="' + HEIGHT + '"/>' +
        '<text x="' + (x + 2) + '" y="10">✂</text></g>');
    });
    if (delta) out.push('<line class="u-zero" x1="0" x2="' + width + '" y1="' + zero + '" y2="' + zero + '"/>');
    return '<svg class="usage-trend-svg" width="' + width + '" height="' + HEIGHT + '" viewBox="0 0 ' + width + ' ' + HEIGHT + '">' + out.join('') + '</svg>';
  }

  function trend(usage, mode) {
    var tr = usage.trend;
    var note = tr.skipped ? '（只画最近 ' + tr.requests.length + ' 个请求，前面还有 ' + tr.skipped + ' 个）' : '';
    var compactions = (tr.compactions || []).length;
    return '<div class="usage-section"><div class="usage-section-title">每个请求的上下文' + esc(note) +
      (compactions ? ' · 压缩 ' + compactions + ' 次' : '') +
      '<span class="usage-mode">' +
      '<button type="button" class="usage-mode-btn' + (mode !== 'delta' ? ' active' : '') + '" data-mode="total">总量</button>' +
      '<button type="button" class="usage-mode-btn' + (mode === 'delta' ? ' active' : '') + '" data-mode="delta">增量</button>' +
      '</span></div><div class="usage-trend">' + trendSvg(tr, mode) + '</div></div>';
  }

  function list(title, rows, fmt) {
    if (!rows || !rows.length) return '';
    var max = rows[0][1] || 1;
    return '<div class="usage-top"><div class="usage-section-title">' + esc(title) + '</div>' + rows.map(function (r) {
      return '<div class="usage-top-row"' + tip(fmt ? fmt(r) : r[0]) + '><span class="usage-top-name">' + esc(r[0]) +
        '</span><span class="usage-top-count">' + r[1] + '</span><span class="usage-top-bar" style="width:' + ((r[1] / max) * 100).toFixed(1) + '%"></span></div>';
    }).join('') + '</div>';
  }

  // Long paths read from the end: the file name is what matters.
  function shortPath(p) {
    var parts = String(p).split(/[\\/]/).filter(Boolean);
    return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : String(p);
  }

  function tops(usage) {
    var t = usage.top;
    var files = (t.files || []).map(function (f) { return [shortPath(f[0]), f[1], f[0], f[2]]; });
    var skills = (t.skills || []).concat((t.commands || []).map(function (c) { return ['/' + c[0], c[1]]; }))
      .sort(function (a, b) { return b[1] - a[1]; }).slice(0, 15);
    var html = list('工具', t.tools) +
      list('Bash 程序', t.programs) +
      list('文件', files, function (f) { return f[2] + '\n读 ' + f[3].read + ' · 改 ' + f[3].edit + ' · 写 ' + f[3].write; }) +
      list('技能与斜杠命令', skills);
    return html ? '<div class="usage-tops">' + html + '</div>' : '';
  }

  function session(data, mode) {
    if (!data || !data.usage) {
      return '<div class="usage-empty">这个标签还没有对话记录（Claude 没启动过，或记录不在这台机器上）。</div>';
    }
    return kpis(data.usage) + now(data.usage, data.liveUsage) + trend(data.usage, mode) + tops(data.usage);
  }

  return { esc: esc, tokens: tokens, usd: usd, span: span, kpis: kpis, now: now, trendSvg: trendSvg, tops: tops, session: session, shortPath: shortPath };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = UsageView;

if (typeof window !== 'undefined' && typeof document !== 'undefined') (function () {
  function authHeaders() {
    return (window.authManager && window.authManager.getAuthHeaders) ? window.authManager.getAuthHeaders() : {};
  }

  function UsagePanel() {
    this.sessionId = null;
    this.data = null;
    this.mode = 'total';
    this.bound = false;
  }

  UsagePanel.prototype.el = function (id) { return document.getElementById(id); };

  UsagePanel.prototype.bind = function () {
    if (this.bound) return;
    var modal = this.el('usageModal');
    if (!modal) return;
    this.bound = true;
    var self = this;
    var close = function () { self.close(); };
    var closeBtn = this.el('closeUsageBtn');
    if (closeBtn) closeBtn.addEventListener('click', close);
    var doneBtn = this.el('usageDoneBtn');
    if (doneBtn) doneBtn.addEventListener('click', close);
    var refresh = this.el('usageRefreshBtn');
    if (refresh) refresh.addEventListener('click', function () { self.load(); });
    modal.addEventListener('click', function (e) {
      if (e.target === modal) return close();
      var btn = e.target.closest && e.target.closest('.usage-mode-btn');
      if (btn) { self.mode = btn.dataset.mode === 'delta' ? 'delta' : 'total'; self.render({ keepScroll: true }); }
    });
  };

  // One tab's conversation. Without an id: the tab in front.
  UsagePanel.prototype.open = function (sessionId) {
    this.bind();
    var modal = this.el('usageModal');
    if (!modal) return;
    var tabs = window.app && window.app.sessionTabManager;
    this.sessionId = sessionId || (tabs && tabs.activeTabId) || (window.app && window.app.currentClaudeSessionId) || null;
    this.data = null;
    modal.classList.add('active');
    this.render();
    this.load();
  };

  UsagePanel.prototype.close = function () {
    var modal = this.el('usageModal');
    if (modal) modal.classList.remove('active');
  };

  UsagePanel.prototype.load = function () {
    var self = this;
    var id = this.sessionId;
    if (!id) { this.error = '没有打开的标签'; return this.render(); }
    this.loading = true;
    this.error = null;
    this.render();
    fetch('/api/sessions/' + encodeURIComponent(id) + '/usage', { headers: authHeaders() })
      .then(function (r) { return r.ok ? r.json() : r.json().catch(function () { return {}; }).then(function (b) { throw new Error(b.error || ('HTTP ' + r.status)); }); })
      .then(function (data) { if (self.sessionId === id) self.data = data; })
      .catch(function (e) { if (self.sessionId === id) self.error = '读取失败：' + e.message; })
      .then(function () { if (self.sessionId === id) { self.loading = false; self.render(); } });
  };

  UsagePanel.prototype.render = function (opts) {
    var body = this.el('usageBody');
    var title = this.el('usageTitle');
    if (!body) return;
    if (title) title.textContent = '上下文与用量' + (this.data && this.data.name ? ' · ' + this.data.name : '');
    if (this.error) { body.innerHTML = '<div class="usage-empty">' + UsageView.esc(this.error) + '</div>'; return; }
    if (!this.data) { body.innerHTML = '<div class="usage-empty">' + (this.loading ? '正在读取对话记录…' : '') + '</div>'; return; }
    // Switching total/delta keeps the reader where they were; new data
    // starts at the right, where the newest requests are.
    var trend = body.querySelector('.usage-trend');
    var keepScroll = opts && opts.keepScroll && trend ? trend.scrollLeft : null;
    body.innerHTML = UsageView.session(this.data, this.mode);
    var next = body.querySelector('.usage-trend');
    if (next) next.scrollLeft = keepScroll !== null ? keepScroll : next.scrollWidth;
  };

  window.usagePanel = new UsagePanel();
  document.addEventListener('DOMContentLoaded', function () { window.usagePanel.bind(); });
})();
