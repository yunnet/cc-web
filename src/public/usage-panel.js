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

  // ── 总览: every conversation in the reader's Claude directory
  // (GET /api/usage/overview), the idea of dsh-context's Context Insights page.

  function ago(t, nowMs) {
    var ms = Date.parse(t);
    if (!isFinite(ms)) return '';
    var m = Math.max(0, Math.round((nowMs - ms) / 60000));
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    if (m < 60 * 24) return Math.round(m / 60) + ' 小时前';
    return Math.round(m / 1440) + ' 天前';
  }

  var RANGES = [['7d', '7 天'], ['30d', '30 天'], ['all', '全部']];
  var SORTS = [['recent', '最近'], ['tokens', 'Token'], ['cost', '花费']];

  function overviewKpis(o) {
    var t = o.totals;
    var cells = [
      ['对话', String(t.sessions || 0)],
      ['请求', String(t.requests)],
      ['Token', tokens(t.input + t.cacheRead + t.cacheCreate + t.output), '输入 ' + tokens(t.input) + ' · 缓存读 ' + tokens(t.cacheRead) + ' · 缓存写 ' + tokens(t.cacheCreate) + ' · 输出 ' + tokens(t.output)],
      ['缓存命中', pct(t.cacheHitRate), '缓存读 ÷ 全部输入'],
      ['花费（API 折算）', usd(t.costUsd), t.unpriced ? t.unpriced + ' 个请求的模型没有价格，未计入' : '按 API 价格估算，订阅不按此计费']
    ];
    return '<div class="usage-kpis">' + cells.map(function (c) {
      return '<div class="usage-kpi"' + (c[2] ? tip(c[2]) : '') + '><div class="usage-kpi-value">' + esc(c[1]) +
        '</div><div class="usage-kpi-label">' + esc(c[0]) + '</div></div>';
    }).join('') + '</div>';
  }

  // Tokens per day as bars, the day's estimated cost on hover.
  // The bars stretch to the panel's width; the day labels are HTML below
  // them, because SVG text would stretch along with the bars.
  function dailySvg(days) {
    var H = 110, W = 640, gap = 4;
    var bw = Math.max(4, (W - gap * (days.length - 1)) / days.length);
    var max = Math.max.apply(null, days.map(function (d) { return d.tokens; }).concat([1]));
    var every = days.length > 10 ? 5 : 1;
    var out = days.map(function (d, i) {
      var h = d.tokens ? Math.max((d.tokens / max) * (H - 4), 1) : 0;
      var x = i * (bw + gap);
      return '<g><title>' + esc(d.day + '\n' + tokens(d.tokens) + ' Token · ' + d.requests + ' 个请求\n' + usd(d.costUsd) + '（API 折算）') + '</title>' +
        '<rect class="u-input" x="' + x.toFixed(1) + '" y="' + (H - h).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '"/></g>';
    });
    var labels = days.map(function (d, i) {
      return '<span>' + ((days.length - 1 - i) % every === 0 ? d.day.slice(5) : '') + '</span>';
    });
    return '<svg class="usage-daily-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' + out.join('') + '</svg>' +
      '<div class="usage-days">' + labels.join('') + '</div>';
  }

  // Eight weeks, a column per week, Monday on top; four shades by quartile
  // of the active days, so one huge day does not wash out the rest.
  function heatmap(days) {
    var active = days.map(function (d) { return d.tokens; }).filter(Boolean).sort(function (a, b) { return a - b; });
    var q = function (p) { return active.length ? active[Math.min(active.length - 1, Math.floor(active.length * p))] : 0; };
    var cuts = [q(0.25), q(0.5), q(0.75)];
    var first = new Date(days[0].day + 'T00:00:00Z').getUTCDay();
    var lead = (first + 6) % 7; // Monday = 0
    var cells = [];
    for (var i = 0; i < lead; i++) cells.push('<span class="usage-heat-cell u-blank"></span>');
    days.forEach(function (d) {
      var lvl = !d.tokens ? 0 : d.tokens <= cuts[0] ? 1 : d.tokens <= cuts[1] ? 2 : d.tokens <= cuts[2] ? 3 : 4;
      cells.push('<span class="usage-heat-cell" data-level="' + lvl + '"' + tip(d.day + ' · ' + tokens(d.tokens) + ' Token · ' + usd(d.costUsd) + '（API 折算）') + '></span>');
    });
    return '<div class="usage-heat">' + cells.join('') + '</div>';
  }

  function sortSessions(list, sort) {
    var by = {
      recent: function (a, b) { return String(b.lastAt || '').localeCompare(String(a.lastAt || '')); },
      tokens: function (a, b) { return b.tokens - a.tokens; },
      cost: function (a, b) { return (b.costUsd || 0) - (a.costUsd || 0); }
    }[sort] || null;
    return by ? list.slice().sort(by) : list;
  }

  function sessionRows(o, sort, nowMs) {
    if (!o.sessions.length) return '<div class="usage-empty">这段时间没有对话</div>';
    return sortSessions(o.sessions, sort).map(function (s) {
      var where = s.cwd || s.project;
      var search = ((s.title || '') + ' ' + (where || '')).toLowerCase();
      return '<button type="button" class="usage-conv" data-id="' + esc(s.id) + '"' +
        (s.openSessionId ? ' data-open="' + esc(s.openSessionId) + '"' : '') +
        ' data-cwd="' + esc(s.cwd || '') + '" data-name="' + esc(s.title || '') + '" data-search="' + esc(search) + '"' +
        tip((s.title || s.id) + '\n' + (where || '') + '\n' + s.requests + ' 个请求 · 缓存命中 ' + pct(s.cacheHitRate) +
          (s.ctx !== null ? ' · 最后上下文 ' + tokens(s.ctx) : '') + (s.subagents ? ' · 子 Agent ' + s.subagents : '') +
          (s.openSessionId ? '\n已在标签中打开，点击切换过去' : '\n点击在新标签中继续这段对话')) + '>' +
        '<span class="usage-conv-main"><span class="usage-conv-title">' + esc(s.title || '（无标题）') +
        (s.openSessionId ? '<span class="usage-conv-open">已打开</span>' : '') + '</span>' +
        '<span class="usage-conv-where">' + (s.account && o.owner === 'all' ? esc(s.account) + ' · ' : '') + esc(shortPath(where || '')) + ' · ' + esc(ago(s.lastAt, nowMs)) + '</span></span>' +
        '<span class="usage-conv-num">' + tokens(s.tokens) + '</span><span class="usage-conv-num">' + usd(s.costUsd) + '</span></button>';
    }).join('');
  }

  // 按账号: what each cc-web account used in the range, one row each with its
  // share of the Token. A row (or 全部 / 我的) narrows the rest of the page.
  // groups is absent without accounts (auth off); an administrator gets every
  // account by name, anyone else theirs and 其他账号.
  function ownerValue(g) {
    return g.me ? 'me' : g.id === '' ? 'none' : g.id;
  }

  function accounts(o) {
    if (!o.groups) return '';
    var owner = o.owner || 'all';
    var total = o.groups.reduce(function (n, g) { return n + g.tokens; }, 0) || 1;
    var chips = [['all', '全部'], ['me', '我的']].map(function (c) {
      return '<button type="button" class="usage-owner-btn usage-mode-btn' + (owner === c[0] ? ' active' : '') + '" data-owner="' + c[0] + '">' + c[1] + '</button>';
    }).join('');
    var rows = o.groups.map(function (g) {
      var value = ownerValue(g);
      var pick = g.id !== 'others';
      var share = g.tokens / total;
      var inner = '<span class="usage-acct-name">' + esc(g.name) + (g.me ? '<span class="usage-conv-open">我</span>' : '') + '</span>' +
        '<span class="usage-acct-bar"><span style="width:' + (share * 100).toFixed(1) + '%"></span></span>' +
        '<span class="usage-conv-num">' + g.sessions + ' 段</span>' +
        '<span class="usage-conv-num">' + tokens(g.tokens) + '</span><span class="usage-conv-num">' + usd(g.costUsd) + '</span>';
      var hint = g.name + '\n' + g.sessions + ' 段对话 · ' + g.requests + ' 个请求 · 占 ' + pct(share) +
        (g.id === '' ? '\n本机命令行、32352 等 cc-web 账号之外开的对话，或记录之前就关掉的标签' : '') +
        (pick ? '\n点击只看这个账号' : '');
      return pick
        ? '<button type="button" class="usage-acct usage-owner-btn' + (owner === value ? ' active' : '') + '" data-owner="' + esc(value) + '"' + tip(hint) + '>' + inner + '</button>'
        : '<div class="usage-acct"' + tip(hint) + '>' + inner + '</div>';
    }).join('');
    return '<div class="usage-section"><div class="usage-section-title">按账号<span class="usage-mode">' + chips + '</span></div>' +
      '<div class="usage-accts">' + (rows || '<div class="usage-empty">这段时间没有对话</div>') + '</div></div>';
  }

  function overview(o, opts) {
    opts = opts || {};
    var nowMs = opts.now || Date.now();
    var range = '<div class="usage-section-title">' +
      (o.scanning ? '<span class="usage-scanning">正在读取对话记录（' + o.files.read + ' / ' + o.files.total + '）…</span>' : '') +
      '<span class="usage-mode">' + RANGES.map(function (r) {
        return '<button type="button" class="usage-range-btn usage-mode-btn' + (o.range === r[0] ? ' active' : '') + '" data-range="' + r[0] + '">' + r[1] + '</button>';
      }).join('') + '</span></div>';
    var daily = '<div class="usage-section"><div class="usage-section-title">每日用量' + (o.days.length > 7 ? '（最近 ' + o.days.length + ' 天）' : '') + '</div>' + dailySvg(o.days) + '</div>';
    var heat = '<div class="usage-section"><div class="usage-section-title">最近 8 周</div>' + heatmap(o.heatmap) + '</div>';
    var convs = '<div class="usage-section"><div class="usage-section-title">对话' +
      (o.sessionsTotal > o.sessions.length ? '（显示 ' + o.sessions.length + ' / ' + o.sessionsTotal + '）' : '（' + o.sessions.length + '）') +
      '<span class="usage-mode">' + SORTS.map(function (s) {
        return '<button type="button" class="usage-sort-btn usage-mode-btn' + ((opts.sort || 'recent') === s[0] ? ' active' : '') + '" data-sort="' + s[0] + '">' + s[1] + '</button>';
      }).join('') + '</span></div>' +
      '<input type="search" class="usage-conv-search skills-search" placeholder="搜索标题或目录…" autocomplete="off" spellcheck="false">' +
      '<div class="usage-convs">' + sessionRows(o, opts.sort, nowMs) + '</div></div>';
    var t = o.top;
    var skills = (t.skills || []).concat((t.commands || []).map(function (c) { return ['/' + c[0], c[1]]; }))
      .sort(function (a, b) { return b[1] - a[1]; }).slice(0, 15);
    var lists = list('工具', t.tools) + list('Bash 程序', t.programs) + list('技能与斜杠命令', skills);
    var topsHtml = lists ? '<div class="usage-section"><div class="usage-section-title">这些对话累计</div><div class="usage-tops">' + lists + '</div></div>' : '';
    return range + accounts(o) + overviewKpis(o) + daily + heat + convs + topsHtml;
  }

  return {
    esc: esc, tokens: tokens, usd: usd, span: span, kpis: kpis, now: now, trendSvg: trendSvg, tops: tops, session: session, shortPath: shortPath,
    ago: ago, dailySvg: dailySvg, heatmap: heatmap, sortSessions: sortSessions, accounts: accounts, overview: overview
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = UsageView;

if (typeof window !== 'undefined' && typeof document !== 'undefined') (function () {
  function authHeaders() {
    return (window.authManager && window.authManager.getAuthHeaders) ? window.authManager.getAuthHeaders() : {};
  }

  function UsagePanel() {
    this.view = 'session';     // 'session' (one tab) or 'overview' (总览)
    this.sessionId = null;
    this.data = null;
    this.mode = 'total';
    this.overviewData = null;
    this.range = '7d';
    this.owner = 'all';       // 按账号: all / me / none / a user id
    this.sort = 'recent';
    this.query = '';
    this.bound = false;
  }

  function getJson(url) {
    return fetch(url, { headers: authHeaders() }).then(function (r) {
      return r.ok ? r.json() : r.json().catch(function () { return {}; }).then(function (b) { throw new Error(b.error || ('HTTP ' + r.status)); });
    });
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
    var tabSession = this.el('usageTabSession');
    if (tabSession) tabSession.addEventListener('click', function () { self.show('session'); });
    var tabOverview = this.el('usageTabOverview');
    if (tabOverview) tabOverview.addEventListener('click', function () { self.show('overview'); });
    modal.addEventListener('click', function (e) {
      if (e.target === modal) return close();
      var t = e.target.closest ? e.target : null;
      if (!t) return;
      var range = t.closest('.usage-range-btn');
      if (range) { self.range = range.dataset.range; self.overviewData = null; return self.load(); }
      var owner = t.closest('.usage-owner-btn');
      if (owner) {
        // A second click on the chosen account goes back to 全部.
        var next = owner.dataset.owner === self.owner && owner.classList.contains('usage-acct') ? 'all' : owner.dataset.owner;
        if (next === self.owner) return;
        self.owner = next;
        return self.load();
      }
      var sort = t.closest('.usage-sort-btn');
      if (sort) { self.sort = sort.dataset.sort; return self.render({ keepScroll: true }); }
      var mode = t.closest('.usage-mode-btn');
      if (mode && mode.dataset.mode) { self.mode = mode.dataset.mode === 'delta' ? 'delta' : 'total'; return self.render({ keepScroll: true }); }
      var conv = t.closest('.usage-conv');
      if (conv) self.openConversation(conv);
    });
    // Search filters the rows in place: re-rendering would take the focus
    // out of the box being typed in.
    modal.addEventListener('input', function (e) {
      if (!e.target.classList || !e.target.classList.contains('usage-conv-search')) return;
      self.query = e.target.value.trim().toLowerCase();
      self.filterRows();
    });
  };

  UsagePanel.prototype.filterRows = function () {
    var q = this.query;
    var rows = document.querySelectorAll('#usageModal .usage-conv');
    for (var i = 0; i < rows.length; i++) rows[i].hidden = !!q && rows[i].dataset.search.indexOf(q) === -1;
  };

  // One tab's conversation (the ring, the tab menu). Without an id: the tab
  // in front. view 'overview' opens 总览 instead (the menu's 用量).
  UsagePanel.prototype.open = function (sessionId, view) {
    this.bind();
    var modal = this.el('usageModal');
    if (!modal) return;
    var tabs = window.app && window.app.sessionTabManager;
    this.sessionId = sessionId || (tabs && tabs.activeTabId) || (window.app && window.app.currentClaudeSessionId) || null;
    this.data = null;
    modal.classList.add('active');
    this.show(view === 'overview' ? 'overview' : 'session');
  };

  UsagePanel.prototype.show = function (view) {
    this.view = view;
    var a = this.el('usageTabSession'), b = this.el('usageTabOverview');
    if (a) a.classList.toggle('active', view === 'session');
    if (b) b.classList.toggle('active', view === 'overview');
    this.render();
    this.load();
  };

  UsagePanel.prototype.close = function () {
    var modal = this.el('usageModal');
    if (modal) modal.classList.remove('active');
    clearTimeout(this.pollTimer);
  };

  UsagePanel.prototype.isOpen = function () {
    var modal = this.el('usageModal');
    return !!(modal && modal.classList.contains('active'));
  };

  UsagePanel.prototype.load = function () {
    var self = this;
    clearTimeout(this.pollTimer);
    this.error = null;
    if (this.view === 'overview') {
      var range = this.range;
      var owner = this.owner;
      this.loading = true;
      this.render();
      return getJson('/api/usage/overview?range=' + range + '&owner=' + encodeURIComponent(owner) + '&tz=' + new Date().getTimezoneOffset())
        .then(function (data) {
          if (self.range !== range || self.owner !== owner) return;
          self.overviewData = data;
          // The first scan of a big Claude directory answers early with what
          // it has read; ask again until it is done.
          if (data.scanning) self.pollTimer = setTimeout(function () { if (self.isOpen() && self.view === 'overview') self.load(); }, 1500);
        })
        .catch(function (e) { self.error = '读取失败：' + e.message; })
        .then(function () { self.loading = false; if (self.view === 'overview') self.render({ keepScroll: true }); });
    }
    var id = this.sessionId;
    if (!id) { this.error = '没有打开的标签'; return this.render(); }
    this.loading = true;
    this.render();
    getJson('/api/sessions/' + encodeURIComponent(id) + '/usage')
      .then(function (data) { if (self.sessionId === id) self.data = data; })
      .catch(function (e) { if (self.sessionId === id) self.error = '读取失败：' + e.message; })
      .then(function () { if (self.sessionId === id && self.view === 'session') { self.loading = false; self.render(); } });
  };

  // A row of 总览: switch to the tab that holds it, or continue it in a new
  // tab the way the Sessions panel does (app.openConversationInTab).
  UsagePanel.prototype.openConversation = function (row) {
    var app = window.app;
    if (!app) return;
    this.close();
    if (row.dataset.open && app.sessionTabManager && app.sessionTabManager.tabs.has(row.dataset.open)) {
      app.sessionTabManager.switchToTab(row.dataset.open);
      return;
    }
    app.openConversationInTab({ id: row.dataset.id, title: row.dataset.name || undefined }, row.dataset.cwd || undefined);
  };

  UsagePanel.prototype.render = function (opts) {
    var body = this.el('usageBody');
    var title = this.el('usageTitle');
    if (!body) return;
    if (this.view === 'overview') return this.renderOverview(body, title, opts);
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

  UsagePanel.prototype.renderOverview = function (body, title, opts) {
    if (title) title.textContent = '上下文与用量 · 总览';
    if (this.error) { body.innerHTML = '<div class="usage-empty">' + UsageView.esc(this.error) + '</div>'; return; }
    if (!this.overviewData) { body.innerHTML = '<div class="usage-empty">' + (this.loading ? '正在读取对话记录…' : '') + '</div>'; return; }
    // A poll repaints the whole view: keep the reader's scroll and search.
    var scroller = body.closest('.modal-body') || body;
    var top = opts && opts.keepScroll ? scroller.scrollTop : 0;
    body.innerHTML = UsageView.overview(this.overviewData, { sort: this.sort });
    var search = body.querySelector('.usage-conv-search');
    if (search) search.value = this.query;
    this.filterRows();
    scroller.scrollTop = top;
  };

  window.usagePanel = new UsagePanel();
  document.addEventListener('DOMContentLoaded', function () { window.usagePanel.bind(); });
})();
