// The skills panel: what Claude can already do, and what it could.
//
// Three views behind one modal — installed, discover, marketplaces — because
// they are three questions about one thing, and a person switching between them
// should not lose the panel. The rows reuse the .conv-* look from the Sessions
// panel so the two read as the same product.
//
// What this panel will not do:
//   • accept a marketplace-declared install command on your behalf. When the
//     CLI wants one confirmed, the command and its sha256 are shown verbatim
//     and only a click sends them back as --accept-command.
//   • offer an uninstall button for a skill this server cannot delete (three of
//     them on this machine are owned by root). It says so instead.
//   • restart anything. Installing changes what the NEXT Claude sees; the
//     running one keeps the skills it started with, and the panel says so.

(function () {
  const ICONS = {
    plugin: '<svg class="conv-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v6M9 5h6"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M9 14h6"/></svg>',
    skill: '<svg class="conv-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.3 4.9 5.2.7-3.8 3.7.9 5.3L12 15.9 7.4 17.6l.9-5.3L4.5 8.6l5.2-.7z"/></svg>',
    market: '<svg class="conv-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9h18l-1.5 10.5a2 2 0 0 1-2 1.5H6.5a2 2 0 0 1-2-1.5Z"/><path d="M8 9V6a4 4 0 0 1 8 0v3"/></svg>'
  };

  const PANES = ['installed', 'discover', 'markets'];

  // Why the plugin half of a listing can be empty, said in the user's language
  // rather than as a code.
  const PROBLEMS = {
    'no-claude-cli': '找不到 claude 命令，插件部分无法读取（技能目录仍然正常）',
    timeout: 'claude 命令没有在限定时间内返回'
  };

  // Failures the CLI reports often enough to be worth translating; anything
  // else falls through to the CLI's own message, unchanged.
  const FAILURES = {
    not_installed: '这个插件并没有装在该范围里',
    busy: '另一个技能操作正在进行，请等它结束',
    'no-claude-cli': '找不到 claude 命令',
    timeout: '命令超时，已结束它和它启动的子进程',
    'bad-id': '插件 id 不合法',
    'bad-source': '市场地址要写成 owner/repo 或 https:// 开头的网址',
    'bad-sha': 'sha256 不合法',
    'bad-scope': '安装范围不合法'
  };

  function authHeaders(json) {
    const base = (window.authManager && window.authManager.getAuthHeaders) ? window.authManager.getAuthHeaders() : {};
    return json ? Object.assign({ 'Content-Type': 'application/json' }, base) : base;
  }

  function fmtCount(n) {
    const v = Number(n) || 0;
    if (v >= 10000) return `${Math.round(v / 1000)}k`;
    return String(v);
  }

  class SkillsPanel {
    constructor() {
      this.pane = 'installed';
      this.installed = null;
      this.catalog = null;
      this.query = '';
      this.expanded = new Set();
      this.running = false;
      this.bound = false;
    }

    el(id) { return document.getElementById(id); }

    sessionId() {
      const app = window.app;
      return (app && app.sessionTabManager && app.sessionTabManager.activeTabId) || '';
    }

    // ── Talking to the server

    async get(path, params) {
      const qs = new URLSearchParams(Object.assign({ sessionId: this.sessionId() }, params || {}));
      const res = await fetch(`${path}?${qs}`, { headers: authHeaders(false) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }

    async act(action, target, extra) {
      if (this.running) { this.note('另一个操作还在进行', true); return null; }
      this.running = true;
      this.render();
      try {
        const res = await fetch('/api/skills/action', {
          method: 'POST',
          headers: authHeaders(true),
          body: JSON.stringify(Object.assign({ action, target, sessionId: this.sessionId() }, extra || {}))
        });
        return await res.json().catch(() => ({ ok: false, message: `HTTP ${res.status}` }));
      } catch (err) {
        return { ok: false, message: String(err && err.message ? err.message : err) };
      } finally {
        this.running = false;
      }
    }

    // ── Loading

    async load() {
      this.note('读取中…');
      try {
        this.installed = await this.get('/api/skills');
        this.note(PROBLEMS[this.installed.problem] || '', !!this.installed.problem);
      } catch (err) {
        this.installed = { plugins: [], skills: [] };
        this.note(`读取已安装的技能失败：${err.message}`, true);
      }
      this.render();
      // The catalogue is a second, slower call; the installed list should not
      // wait behind it.
      this.loadCatalog();
    }

    async loadCatalog() {
      try {
        this.catalog = await this.get('/api/skills/catalog', this.query ? { q: this.query } : {});
        if (this.catalog.problem) this.note(PROBLEMS[this.catalog.problem] || '', true);
      } catch (err) {
        this.catalog = { rows: [], recommended: [], marketplaces: [], total: 0 };
        this.note(`读取可安装列表失败：${err.message}`, true);
      }
      this.render();
    }

    // ── Rendering

    note(text, isError) {
      const box = this.el('skillsNote');
      if (!box) return;
      box.textContent = text || '';
      box.classList.toggle('error', !!isError);
      box.hidden = !text;
    }

    render() {
      for (const name of PANES) {
        const tab = this.el(`skillsTab${name[0].toUpperCase()}${name.slice(1)}`);
        const pane = this.el(`skillsPane${name[0].toUpperCase()}${name.slice(1)}`);
        if (tab) tab.classList.toggle('active', this.pane === name);
        if (pane) pane.hidden = this.pane !== name;
      }
      this.renderInstalled();
      this.renderDiscover();
      this.renderMarkets();
      const counts = this.el('skillsTabInstalled');
      if (counts && this.installed) {
        const n = (this.installed.plugins || []).length + (this.installed.skills || []).length;
        counts.textContent = `已安装 ${n}`;
      }
    }

    // A row: icon, title, one line of meta, and whatever buttons apply.
    row(opts) {
      const row = document.createElement('div');
      row.className = 'conv-row skills-row';
      const icon = document.createElement('span');
      icon.innerHTML = ICONS[opts.icon] || ICONS.skill;
      row.appendChild(icon.firstChild);

      const main = document.createElement('div');
      main.className = 'conv-main';
      const title = document.createElement('div');
      title.className = 'conv-title';
      title.textContent = opts.title;
      if (opts.badge) {
        const badge = document.createElement('span');
        badge.className = `skills-badge${opts.badgeKind ? ` ${opts.badgeKind}` : ''}`;
        badge.textContent = opts.badge;
        if (opts.badgeTitle) badge.title = opts.badgeTitle;
        title.appendChild(badge);
      }
      main.appendChild(title);
      const meta = document.createElement('div');
      meta.className = 'conv-meta';
      meta.textContent = opts.meta || '';
      main.appendChild(meta);
      row.appendChild(main);

      const actions = document.createElement('div');
      actions.className = 'conv-actions';
      for (const a of opts.actions || []) {
        const btn = document.createElement('button');
        btn.className = `btn btn-small ${a.primary ? 'btn-primary' : 'btn-secondary'}`;
        btn.textContent = a.label;
        if (a.disabled) { btn.disabled = true; btn.title = a.title || ''; }
        else if (a.title) btn.title = a.title;
        btn.addEventListener('click', (e) => { e.stopPropagation(); a.onClick(); });
        actions.appendChild(btn);
      }
      if (actions.children.length) row.appendChild(actions);
      if (opts.onClick) row.addEventListener('click', opts.onClick);
      return row;
    }

    group(text) {
      const g = document.createElement('div');
      g.className = 'conv-group';
      g.textContent = text;
      return g;
    }

    empty(text) {
      const e = document.createElement('div');
      e.className = 'conv-empty';
      e.textContent = text;
      return e;
    }

    renderInstalled() {
      const list = this.el('skillsInstalledList');
      if (!list) return;
      list.textContent = '';
      const data = this.installed;
      if (!data) { list.appendChild(this.empty('读取中…')); return; }

      const plugins = data.plugins || [];
      list.appendChild(this.group(`插件（${plugins.length}）`));
      if (!plugins.length) list.appendChild(this.empty('还没有装任何插件'));
      for (const p of plugins) {
        const skillNames = (p.skills || []).map((s) => s.name);
        const meta = [
          p.version ? `v${String(p.version).slice(0, 12)}` : null,
          `范围 ${p.scope}`,
          skillNames.length ? `技能：${skillNames.join('、')}` : '不带技能',
          p.enabled ? null : '已停用'
        ].filter(Boolean).join(' · ');
        list.appendChild(this.row({
          icon: 'plugin',
          title: p.name,
          badge: p.marketplace || undefined,
          meta,
          actions: [
            {
              label: p.enabled ? '停用' : '启用',
              onClick: () => this.runAction(p.enabled ? 'disable' : 'enable', p.id, { scope: p.scope })
            },
            { label: '卸载', onClick: () => this.uninstall(p) }
          ],
          onClick: () => this.toggleDetail(list, `plugin:${p.id}`, (p.skills || [])[0] && (p.skills || [])[0].file)
        }));
        if (this.expanded.has(`plugin:${p.id}`)) list.appendChild(this.detailBox(`plugin:${p.id}`));
      }

      const dirSkills = data.skills || [];
      list.appendChild(this.group(`技能目录（${dirSkills.length}）`));
      if (!dirSkills.length) list.appendChild(this.empty('~/.claude/skills 和项目的 .claude/skills 都是空的'));
      for (const s of dirSkills) {
        list.appendChild(this.row({
          icon: 'skill',
          title: s.name,
          badge: s.kind === 'user' ? '个人' : '本项目',
          badgeKind: s.kind === 'user' ? '' : 'project',
          meta: s.description || s.dir,
          actions: s.readOnly
            ? [{ label: '只读', disabled: true, title: `这个目录归别的用户所有，cc-web 删不掉：${s.dir}` }]
            : [],
          onClick: () => this.toggleDetail(list, `skill:${s.id}`, s.file)
        }));
        if (this.expanded.has(`skill:${s.id}`)) list.appendChild(this.detailBox(`skill:${s.id}`));
      }
    }

    renderDiscover() {
      const list = this.el('skillsDiscoverList');
      if (!list) return;
      list.textContent = '';
      const cat = this.catalog;
      if (!cat) { list.appendChild(this.empty('读取中…')); return; }

      if (!this.query && (cat.recommended || []).length) {
        list.appendChild(this.group('推荐给你'));
        for (const r of cat.recommended) list.appendChild(this.catalogRow(r, this.reasonText(r.reason)));
      }

      // Measured on 2.1.280: `list --available` leaves out what is already
      // installed (299 available against 15 installed, 2 of them overlapping —
      // and those two are project-scope). So searching for a plugin you already
      // have finds nothing, which reads as "it does not exist". Show the ones
      // already installed that match, right here, rather than leaving a person
      // to guess.
      if (this.query) {
        const needle = this.query.toLowerCase();
        const mine = (this.installed && this.installed.plugins || [])
          .filter((p) => `${p.name} ${p.marketplace || ''}`.toLowerCase().includes(needle));
        if (mine.length) {
          list.appendChild(this.group(`你已经装了（${mine.length}）`));
          for (const p of mine) {
            list.appendChild(this.row({
              icon: 'plugin',
              title: p.name,
              badge: '已安装',
              badgeKind: 'on',
              meta: `范围 ${p.scope}${p.enabled ? '' : ' · 已停用'} · 在「已安装」里管理它`,
              actions: [{ label: '去管理', onClick: () => { this.pane = 'installed'; this.render(); } }]
            }));
          }
        }
      }

      const rows = cat.rows || [];
      list.appendChild(this.group(this.query ? `搜索结果（${rows.length}）` : `全部可安装（${rows.length} / ${cat.total || rows.length}）`));
      if (!rows.length) list.appendChild(this.empty('没有匹配的技能'));
      for (const r of rows.slice(0, 100)) list.appendChild(this.catalogRow(r));
    }

    reasonText(reason) {
      if (!reason) return '';
      if (reason.kind === 'signal') return `你的项目里有 ${reason.file}`;
      return `已有 ${fmtCount(reason.installCount)} 人安装`;
    }

    catalogRow(r, reason) {
      const meta = [reason, r.description, r.source ? `来源：${r.source}` : null]
        .filter(Boolean).join(' · ');
      return this.row({
        icon: 'plugin',
        title: r.name,
        badge: r.installed ? '已安装' : (r.marketplace || undefined),
        badgeKind: r.installed ? 'on' : '',
        meta,
        actions: r.installed
          ? [{ label: '已安装', disabled: true, title: '在「已安装」里管理它' }]
          : [{ label: '安装', primary: true, onClick: () => this.install(r) }]
      });
    }

    renderMarkets() {
      const list = this.el('skillsMarketList');
      if (!list) return;
      list.textContent = '';
      const markets = (this.catalog && this.catalog.marketplaces) || [];
      list.appendChild(this.group(`已接入的市场（${markets.length}）`));
      if (!markets.length) list.appendChild(this.empty('还没有接入任何市场'));
      for (const m of markets) {
        list.appendChild(this.row({
          icon: 'market',
          title: m.name,
          meta: m.source || '',
          actions: [
            { label: '更新', onClick: () => this.runAction('marketplace-update', m.name) },
            { label: '移除', onClick: () => this.removeMarket(m) }
          ]
        }));
      }
    }

    // The SKILL.md itself, read on demand. textContent, never innerHTML: this
    // is someone else's file.
    detailBox(key) {
      const box = document.createElement('pre');
      box.className = 'skills-detail';
      box.textContent = this.details && this.details[key] !== undefined ? this.details[key] : '读取中…';
      return box;
    }

    async toggleDetail(list, key, file) {
      if (this.expanded.has(key)) { this.expanded.delete(key); this.render(); return; }
      this.expanded.add(key);
      this.details = this.details || {};
      if (this.details[key] === undefined) {
        if (!file) { this.details[key] = '这一项没有 SKILL.md 可以显示'; }
        else {
          this.render();
          try {
            const data = await this.get('/api/skills/file', { path: file });
            this.details[key] = data.text || '';
          } catch (err) {
            this.details[key] = `读取失败：${err.message}`;
          }
        }
      }
      this.render();
    }

    // ── Actions

    async runAction(action, target, extra) {
      const result = await this.act(action, target, extra);
      if (!result) return null;
      if (result.ok) {
        this.note(result.restartRequired
          ? '完成。已在运行的 Claude 不受影响，下次启动会话时生效。'
          : '完成。');
        await this.load();
      } else if (result.needsConfirmation && result.confirm) {
        this.confirmCommand(action, target, result.confirm, extra);
      } else {
        this.note(`失败：${FAILURES[result.failureCode] || result.message || '未知原因'}`, true);
        this.render();
      }
      return result;
    }

    // A plugin that installs by running a command the marketplace declared.
    // The command is shown exactly as the CLI reported it, with its sha, and
    // nothing is sent back unless a person agrees to that exact text.
    confirmCommand(action, target, confirm, extra) {
      const ok = window.confirm(
        `安装 ${target} 需要先运行市场声明的一条命令：\n\n${confirm.command}\n\nsha256: ${confirm.sha256}\n\n` +
        '这条命令会以你的身份在这台机器上运行。确认要继续吗？'
      );
      if (!ok) { this.note('已取消，没有运行任何命令。'); this.render(); return; }
      this.runAction(action, target, Object.assign({}, extra, { acceptSha: confirm.sha256 }));
    }

    install(r) {
      const where = r.source ? `\n\n来源：${r.source}` : '';
      if (!window.confirm(`安装 ${r.name}？${where}\n\n安装第三方技能等于把别人写的指令交给 Claude 去读，请确认来源可信。`)) return;
      this.note(`正在安装 ${r.name}…`);
      this.runAction('install', r.id);
    }

    uninstall(p) {
      if (!window.confirm(`卸载 ${p.name}？\n\n它带的技能会一起消失。已记录的对话不受影响。`)) return;
      this.note(`正在卸载 ${p.name}…`);
      this.runAction('uninstall', p.id, { scope: p.scope });
    }

    removeMarket(m) {
      if (!window.confirm(`移除市场 ${m.name}？\n\n已经装好的插件不会被删除，只是不再从这个市场看到新的。`)) return;
      this.runAction('marketplace-remove', m.name);
    }

    addMarket() {
      const input = this.el('skillsMarketInput');
      if (!input) return;
      const src = input.value.trim();
      if (!src) { this.note('填一个 owner/repo 或 https:// 网址', true); return; }
      this.note(`正在添加 ${src}…`);
      this.runAction('marketplace-add', src).then((r) => { if (r && r.ok) input.value = ''; });
    }

    // ── The modal

    bind() {
      if (this.bound) return;
      this.bound = true;
      const modal = this.el('skillsModal');
      if (!modal) return;
      const close = () => this.close();
      const closeBtn = this.el('closeSkillsBtn');
      if (closeBtn) closeBtn.addEventListener('click', close);
      const doneBtn = this.el('skillsDoneBtn');
      if (doneBtn) doneBtn.addEventListener('click', close);
      modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
      const refresh = this.el('skillsRefreshBtn');
      if (refresh) refresh.addEventListener('click', () => { this.catalog = null; this.details = {}; this.load(); });

      for (const name of PANES) {
        const tab = this.el(`skillsTab${name[0].toUpperCase()}${name.slice(1)}`);
        if (tab) tab.addEventListener('click', () => { this.pane = name; this.render(); });
      }

      const search = this.el('skillsSearchInput');
      if (search) {
        let timer = null;
        search.addEventListener('input', () => {
          // The catalogue is one CLI call; debounce so a typed word is not one
          // spawn per keystroke.
          clearTimeout(timer);
          timer = setTimeout(() => { this.query = search.value.trim(); this.loadCatalog(); }, 250);
        });
      }
      const addBtn = this.el('skillsMarketAddBtn');
      if (addBtn) addBtn.addEventListener('click', () => this.addMarket());
    }

    open(pane) {
      this.bind();
      const modal = this.el('skillsModal');
      if (!modal) return;
      if (pane && PANES.includes(pane)) this.pane = pane;
      modal.classList.add('active');
      this.render();
      this.load();
    }

    close() {
      const modal = this.el('skillsModal');
      if (modal) modal.classList.remove('active');
    }

    isOpen() {
      const modal = this.el('skillsModal');
      return !!(modal && modal.classList.contains('active'));
    }
  }

  window.skillsPanel = new SkillsPanel();
  document.addEventListener('DOMContentLoaded', () => window.skillsPanel.bind());
})();
