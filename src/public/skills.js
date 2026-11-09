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
    'no-claude-cli': 'claude command not found, plugins cannot be read (skill folders still work)',
    timeout: 'The claude command did not return in time'
  };

  // Failures the CLI reports often enough to be worth translating; anything
  // else falls through to the CLI's own message, unchanged.
  const FAILURES = {
    not_installed: 'This plugin is not installed in that scope',
    busy: 'Another skills operation is running, wait for it to finish',
    'no-claude-cli': 'claude command not found',
    timeout: 'Command timed out, it and its child processes were stopped',
    'bad-id': 'Invalid plugin id',
    'bad-source': 'Marketplace source must be owner/repo or a URL starting with https://',
    'bad-sha': 'Invalid sha256',
    'bad-scope': 'Invalid install scope'
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
      if (this.running) { this.note('Another operation is still running', true); return null; }
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
      this.note('Loading…');
      try {
        this.installed = await this.get('/api/skills');
        this.note(PROBLEMS[this.installed.problem] || '', !!this.installed.problem);
      } catch (err) {
        this.installed = { plugins: [], skills: [] };
        this.note(`Loading installed skills failed: ${err.message}`, true);
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
        this.note(`Loading the install list failed: ${err.message}`, true);
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
        counts.textContent = `Installed ${n}`;
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
      if (!data) { list.appendChild(this.empty('Loading…')); return; }

      const plugins = data.plugins || [];
      list.appendChild(this.group(`Plugins (${plugins.length})`));
      if (!plugins.length) list.appendChild(this.empty('No plugins installed yet'));
      for (const p of plugins) {
        const skillNames = (p.skills || []).map((s) => s.name);
        const meta = [
          p.version ? `v${String(p.version).slice(0, 12)}` : null,
          `Scope ${p.scope}`,
          skillNames.length ? `Skills: ${skillNames.join(', ')}` : 'No skills',
          p.enabled ? null : 'Disabled'
        ].filter(Boolean).join(' · ');
        list.appendChild(this.row({
          icon: 'plugin',
          title: p.name,
          badge: p.marketplace || undefined,
          meta,
          actions: [
            {
              label: p.enabled ? 'Disable' : 'Enable',
              onClick: () => this.runAction(p.enabled ? 'disable' : 'enable', p.id, { scope: p.scope })
            },
            { label: 'Uninstall', onClick: () => this.uninstall(p) }
          ],
          onClick: () => this.toggleDetail(list, `plugin:${p.id}`, (p.skills || [])[0] && (p.skills || [])[0].file)
        }));
        if (this.expanded.has(`plugin:${p.id}`)) list.appendChild(this.detailBox(`plugin:${p.id}`));
      }

      const dirSkills = data.skills || [];
      list.appendChild(this.group(`Skill folders (${dirSkills.length})`));
      if (!dirSkills.length) list.appendChild(this.empty('~/.claude/skills and the project\'s .claude/skills are both empty'));
      for (const s of dirSkills) {
        list.appendChild(this.row({
          icon: 'skill',
          title: s.name,
          badge: s.kind === 'user' ? 'Personal' : 'This project',
          badgeKind: s.kind === 'user' ? '' : 'project',
          meta: s.description || s.dir,
          actions: s.readOnly
            ? [{ label: 'Read-only', disabled: true, title: `This folder belongs to another user, cc-web cannot delete it: ${s.dir}` }]
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
      if (!cat) { list.appendChild(this.empty('Loading…')); return; }

      if (!this.query && (cat.recommended || []).length) {
        list.appendChild(this.group('Recommended for you'));
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
          list.appendChild(this.group(`Installed (${mine.length})`));
          for (const p of mine) {
            list.appendChild(this.row({
              icon: 'plugin',
              title: p.name,
              badge: 'Installed',
              badgeKind: 'on',
              meta: `Scope ${p.scope}${p.enabled ? '' : ' · Disabled'} · manage it under Installed`,
              actions: [{ label: 'Manage', onClick: () => { this.pane = 'installed'; this.render(); } }]
            }));
          }
        }
      }

      const rows = cat.rows || [];
      list.appendChild(this.group(this.query ? `Search results (${rows.length})` : `All installable (${rows.length} / ${cat.total || rows.length})`));
      if (!rows.length) list.appendChild(this.empty('No matching skills'));
      for (const r of rows.slice(0, 100)) list.appendChild(this.catalogRow(r));
    }

    reasonText(reason) {
      if (!reason) return '';
      if (reason.kind === 'signal') return `Your project has ${reason.file}`;
      return `${fmtCount(reason.installCount)} installs`;
    }

    catalogRow(r, reason) {
      const meta = [reason, r.description, r.source ? `Source: ${r.source}` : null]
        .filter(Boolean).join(' · ');
      return this.row({
        icon: 'plugin',
        title: r.name,
        badge: r.installed ? 'Installed' : (r.marketplace || undefined),
        badgeKind: r.installed ? 'on' : '',
        meta,
        actions: r.installed
          ? [{ label: 'Installed', disabled: true, title: 'Manage it under Installed' }]
          : [{ label: 'Install', primary: true, onClick: () => this.install(r) }]
      });
    }

    renderMarkets() {
      const list = this.el('skillsMarketList');
      if (!list) return;
      list.textContent = '';
      const markets = (this.catalog && this.catalog.marketplaces) || [];
      list.appendChild(this.group(`Marketplaces (${markets.length})`));
      if (!markets.length) list.appendChild(this.empty('No marketplaces added yet'));
      for (const m of markets) {
        list.appendChild(this.row({
          icon: 'market',
          title: m.name,
          meta: m.source || '',
          actions: [
            { label: 'Update', onClick: () => this.runAction('marketplace-update', m.name) },
            { label: 'Remove', onClick: () => this.removeMarket(m) }
          ]
        }));
      }
    }

    // The SKILL.md itself, read on demand. textContent, never innerHTML: this
    // is someone else's file.
    detailBox(key) {
      const box = document.createElement('pre');
      box.className = 'skills-detail';
      box.textContent = this.details && this.details[key] !== undefined ? this.details[key] : 'Loading…';
      return box;
    }

    async toggleDetail(list, key, file) {
      if (this.expanded.has(key)) { this.expanded.delete(key); this.render(); return; }
      this.expanded.add(key);
      this.details = this.details || {};
      if (this.details[key] === undefined) {
        if (!file) { this.details[key] = 'This item has no SKILL.md to show'; }
        else {
          this.render();
          try {
            const data = await this.get('/api/skills/file', { path: file });
            this.details[key] = data.text || '';
          } catch (err) {
            this.details[key] = `Loading failed: ${err.message}`;
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
          ? 'Done. Running Claude sessions are not affected; it takes effect the next time a session starts.'
          : 'Done');
        await this.load();
      } else if (result.needsConfirmation && result.confirm) {
        this.confirmCommand(action, target, result.confirm, extra);
      } else {
        this.note(`Failed: ${FAILURES[result.failureCode] || result.message || 'unknown reason'}`, true);
        this.render();
      }
      return result;
    }

    // A plugin that installs by running a command the marketplace declared.
    // The command is shown exactly as the CLI reported it, with its sha, and
    // nothing is sent back unless a person agrees to that exact text.
    confirmCommand(action, target, confirm, extra) {
      const ok = window.confirm(
        `Installing ${target} first runs a command declared by the marketplace:\n\n${confirm.command}\n\nsha256: ${confirm.sha256}\n\n` +
        'This command runs as you on this machine. Continue?'
      );
      if (!ok) { this.note('Cancelled, no command was run'); this.render(); return; }
      this.runAction(action, target, Object.assign({}, extra, { acceptSha: confirm.sha256 }));
    }

    install(r) {
      const where = r.source ? `\n\nSource: ${r.source}` : '';
      if (!window.confirm(`Install ${r.name}?${where}\n\nInstalling a third-party skill gives Claude instructions someone else wrote. Make sure you trust the source.`)) return;
      this.note(`Installing ${r.name}…`);
      this.runAction('install', r.id);
    }

    uninstall(p) {
      if (!window.confirm(`Uninstall ${p.name}?\n\nThe skills it carries go with it. Recorded conversations are not affected.`)) return;
      this.note(`Uninstalling ${p.name}…`);
      this.runAction('uninstall', p.id, { scope: p.scope });
    }

    removeMarket(m) {
      if (!window.confirm(`Remove marketplace ${m.name}?\n\nInstalled plugins are not deleted; you just stop seeing new ones from this marketplace.`)) return;
      this.runAction('marketplace-remove', m.name);
    }

    addMarket() {
      const input = this.el('skillsMarketInput');
      if (!input) return;
      const src = input.value.trim();
      if (!src) { this.note('Enter owner/repo or an https:// URL', true); return; }
      this.note(`Adding ${src}…`);
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
