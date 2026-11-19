// Git IDE panel — single-repository depth for cc-web (dsh-ide-git port).
//
// This file owns the SHELL: the right drawer (open/close, remembered width,
// click-outside deliberately does NOT close — a work panel stays open while
// you type in the terminal), the ResizeObserver-driven layout switch
// (≥620px three columns, narrower a single stack), tiered loading feedback,
// and the summary fetch that paints the header pill. The branch tree, history
// list and detail panes render into this shell's containers and arrive with
// their own tasks; nothing here knows how a commit row is drawn.
//
// Data comes from the /api/git/ide/* routes (src/git-ide.js server module).
// No polling anywhere: refresh happens on open, on the ⟳ button, and after
// writes — the server has a history of being brought down by timers.
(function () {
  'use strict';

  const DEFAULT_WIDTH = 680;
  const MIN_WIDTH = 480;
  const STACK_BREAKPOINT = 620;   // panel-body px: below this, one column
  const STATE_KEY = 'cc-web-git-ide-state';

  function readState() {
    try { return JSON.parse(localStorage.getItem(STATE_KEY) || '{}') || {}; }
    catch (_) { return {}; }
  }
  function writeState(patch) {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(Object.assign(readState(), patch)));
    } catch (_) { /* private mode etc. — the panel still works, just forgets */ }
  }

  // Relative age, the sidebar's convention: 42m / 3h / 2d, falling back to the
  // date once "days" stops being glanceable. Absolute time rides in the title.
  function relTime(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return `${Math.floor(s)}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400 * 14) return `${Math.floor(s / 3600)}h`;
    if (s < 86400 * 90) return `${Math.floor(s / 86400)}d`;
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // "HEAD -> main, origin/main, tag: v1" → up to three badges in the panel's
  // colour language: HEAD green, local blue, remote purple, tag yellow.
  function refBadges(refs) {
    const out = [];
    for (const raw of refs || []) {
      if (raw.startsWith('HEAD ->')) {
        out.push({ kind: 'head', text: 'HEAD' });
        out.push({ kind: 'local', text: raw.split('->')[1].trim() });
      } else if (raw === 'HEAD') {
        out.push({ kind: 'head', text: 'HEAD' });
      } else if (raw.startsWith('tag: ')) {
        out.push({ kind: 'tag', text: raw.slice(5) });
      } else if (raw.includes('/')) {
        out.push({ kind: 'remote', text: raw });
      } else {
        out.push({ kind: 'local', text: raw });
      }
      if (out.length >= 3) break;
    }
    return out;
  }

  class GitIdePanel {
    constructor() {
      this.bound = false;
      this.open = false;
      this.repoPath = null;
      this.repoName = '';
      this.mode = null;          // 'cols' | 'stack'
      this.width = readState().width || null;
      this.summary = null;
      this.loading = 0;          // in-flight request counter for the progress line
      this.loadTimer = null;     // >2s: progress line gains its staged text
      // History pane state (task 4): commits accumulate across pages, lanes
      // recompute over the whole loaded list (indices never shift — the
      // algorithm's no-compaction guarantee), and rows append without a
      // rebuild.
      this.commits = [];
      this.lanes = [];
      this.logOffset = 0;
      this.hasMore = false;
      this.scope = 'current';
      this.text = '';
      this.author = '';
      this.selectedSha = null;
      this.refs = null;          // last /refs answer, the branch tree's data
      this.treeCollapsed = readState().treeCollapsed || [];
      // Per-repo first-paint cache: filled by hover prewarm or a previous
      // visit, consumed by openRepo. Keyed by absolute path.
      this.cache = {};
      this.prewarming = null;
    }

    el(id) { return document.getElementById(id); }

    auth() {
      return (window.authManager && window.authManager.getAuthHeaders()) || {};
    }

    async get(path) {
      const res = await fetch(path, { headers: this.auth() });
      const data = await res.json().catch(() => ({}));
      return { status: res.status, data };
    }

    bind() {
      if (this.bound) return;
      const panel = this.el('gitIdePanel');
      if (!panel) return;
      this.bound = true;

      this.el('gitIdeCloseBtn').addEventListener('click', () => this.close());
      this.el('gitIdeBackBtn').addEventListener('click', (e) => {
        // Without this, the same click keeps bubbling to the document, where
        // the branch panel's outside-click listener sees a freshly shown
        // popover whose wrapper does not contain the click — and hides it in
        // the same tick it opened.
        e.stopPropagation();
        this.close();
        if (window.branchPanel) window.branchPanel.show();
      });
      this.el('gitIdeRefreshBtn').addEventListener('click', () => this.reload());
      this.el('gitIdeMask').addEventListener('click', () => this.close());

      // Esc closes the panel (later layers — open diff, menus — peel first).
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.open) this.close();
      });

      this.setupResize();
      this.observeLayout();
      this.bindHistory();
      this.bindContextMenu();
      this.el('gitIdeTabChanges').addEventListener('click', () => this.showDetailTab('changes'));
      this.el('gitIdeTabDetail').addEventListener('click', () => this.showDetailTab('detail'));
      this.el('gitIdeCommitBtn').addEventListener('click', () => this.doCommit());
      this.el('gitIdeCommitMsg').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          this.doCommit();
        }
      });
      this.bindPushToggle();
    }

    // ── push gate (phase E): a Settings switch, default off, admin-only ────

    async bindPushToggle() {
      const box = this.el('gitIdePushToggle');
      if (!box) return;
      this.pushEnabled = false;
      this.pushCanSet = false;
      box.addEventListener('change', async () => {
        const wanted = box.checked;
        const { status, data } = await fetch('/api/git/ide/push-enabled', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...this.auth() },
          body: JSON.stringify({ enabled: wanted })
        }).then((r) => r.json().then((d) => ({ status: r.status, data: d }))).catch(() => ({ status: 0, data: {} }));
        if (status !== 200) {
          box.checked = !wanted;
          window.app.showToast((data && data.error) || '无法保存该设置', true);
          return;
        }
        this.pushEnabled = !!data.enabled;
        window.app.showToast(data.enabled ? 'Git IDE 推送已开启' : 'Git IDE 推送已关闭');
      });
      const { data } = await this.get('/api/git/ide/push-enabled');
      if (data) {
        this.pushEnabled = !!data.enabled;
        this.pushCanSet = !!data.canSet;
        box.checked = this.pushEnabled;
        box.disabled = !this.pushCanSet;
      }
    }

    // ── right-click references + send-to-conversation (phase B) ───────────

    bindContextMenu() {
      const panel = this.el('gitIdePanel');
      panel.addEventListener('contextmenu', (e) => {
        if (!e.target.closest) return;
        const items = this.menuItemsFor(e);
        if (!items) return;                 // no target row → browser default
        e.preventDefault();
        // While a merge/rebase owns the repo, every menu leads with the way
        // out — the state that blocks all writes must be reachable to clear.
        if (this.summary && this.summary.inProgress) {
          items.unshift(
            { sep: true },
            { label: `中止进行中的 ${this.summary.inProgress}`, danger: true, act: () => this.runOp('abort', {}, `已中止 ${this.summary.inProgress}`) }
          );
        }
        this.openMenu(e.clientX, e.clientY, items);
      });
      // Any click or panel scroll dismisses the menu; the shell's Escape
      // peels the menu before closing the panel.
      panel.addEventListener('click', () => this.closeMenu(), true);
      panel.addEventListener('scroll', () => this.closeMenu(), true);
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.menu) {
          e.stopPropagation();
          this.closeMenu();
        }
      }, true);
    }

    // What the menu offers, by what was under the pointer. Every entry is one
    // short, self-describing reference (plan §3.6) — the point is that the
    // conversation (Claude) can act on it without more context.
    menuItemsFor(e) {
      const repo = this.repoName;
      const diffRow = e.target.closest('.git-ide-dl');
      const diffBody = e.target.closest('.git-ide-diff-body');
      const file = e.target.closest('.git-ide-file');
      const ref = e.target.closest('.git-ide-ref');
      const commit = e.target.closest('.git-ide-row');

      if (diffBody) {
        const sel = this.diffSelection(diffBody);
        const path = diffRow && diffRow.closest('.git-ide-diff');
        const fileRow = path && path.previousElementSibling;
        const fileName = fileRow && fileRow.dataset.path;
        if (sel && fileName) {
          const items = [];
          if (sel.from) {
            const where = this.selectedCommit ? `（提交 ${this.selectedCommit.short}「${this.selectedCommit.subject}」@ ${this.summary && this.summary.branch || ''}）` : '';
            const text = `@${fileName} 第 ${sel.from}–${sel.to} 行${sel.oldLines ? '（旧行号）' : ''}${where}`;
            items.push({ label: '发送选中行到对话', act: () => this.sendToConversation(text) });
            items.push({ label: '复制选中引用', act: () => this.copyText(text, '引用已复制') });
          } else {
            const frag = String(sel.text || '').slice(0, 600);
            items.push({ label: '发送选中片段到对话', act: () => this.sendToConversation(frag) });
            items.push({ label: '复制选中片段', act: () => this.copyText(frag, '片段已复制') });
          }
          return items;
        }
        return null;
      }
      if (file) {
        const p = file.dataset.path;
        return [
          { label: '发送到对话（@文件）', act: () => this.sendToConversation(this.atPath(p)) },
          { label: '发送到对话（路径）', act: () => this.sendToConversation(p) },
          { label: '复制路径', act: () => this.copyText(p, '路径已复制') }
        ];
      }
      if (ref) {
        const name = ref.dataset.ref === 'current' ? (this.summary && this.summary.branch) : ref.dataset.ref;
        if (!name) return null;
        const items = [
          { label: '发送到对话', act: () => this.sendToConversation(`git 分支 ${name}（仓库 ${repo}）`) },
          { label: '复制分支名', act: () => this.copyText(name, '分支名已复制') }
        ];
        // Phase D: the tree's branch actions. The current branch leads with
        // merge/rebase; every other branch offers checkout and delete.
        if (ref.dataset.ref !== 'current') {
          items.unshift(
            { label: `签出 ${name}`, act: () => this.runOp('checkout', { ref: name }, `已签出 ${name}`) },
            { label: `合并 ${name} 到当前分支`, act: () => this.runOp('merge', { name, mode: 'default' }, `已合并 ${name}`) },
            { label: `变基当前分支到 ${name}`, act: () => this.confirmRun(`把当前分支变基到 ${name}？`, { label: '变基' }, 'rebase', { onto: name }, `已变基到 ${name}`) },
            { label: `删除分支 ${name}`, act: () => this.deleteBranchFlow(name) }
          );
        } else if (this.pushEnabled) {
          // Push is gated twice: the server flag AND this menu entry only
          // existing for the current branch with an upstream to push to.
          const s = this.summary || {};
          if (s.ahead) {
            items.unshift(
              { label: `推送 ${name}（领先 ${s.ahead} 个提交）`, act: () => this.confirmRun(
                `推送 ${name} 到它的上游？将使用服务器的 git 凭据，提交不可轻易撤回。`,
                { label: '推送', danger: true }, 'push', {}, '已推送') }
            );
          }
        }
        return items;
      }
      if (commit) {
        const sha = commit.dataset.sha;
        const c = this.commits.find((x) => x.sha === sha);
        const short = sha.slice(0, 7);
        const subject = c ? c.subject : '';
        const quote = subject ? `「${subject}」` : '';
        return [
          { label: '发送到对话', act: () => this.sendToConversation(`git 提交 ${short}${quote}（仓库 ${repo}）`) },
          { label: '复制修订号', act: () => this.copyText(short, '修订号已复制') },
          { label: '复制引用', act: () => this.copyText(`git 提交 ${short}${quote}（仓库 ${repo}）`), },
          { sep: true },
          { label: '在此新建分支…', act: () => this.promptName('新分支名', 'branch', sha) },
          { label: '新建标签…', act: () => this.promptName('新标签名', 'tag', sha) },
          { sep: true },
          { label: `优选（cherry-pick）${short}`, act: () => this.runOp('cherry-pick', { sha }, `已优选 ${short}`) },
          { label: `还原提交 ${short}`, act: () => this.runOp('revert', { sha }, `已还原 ${short}`) },
          { sep: true },
          { label: '重置到此（保留更改）', act: () => this.confirmRun(`把当前分支重置到 ${short}？工作区更改保留（变为未暂存）。`, { label: '重置', danger: true }, 'reset', { sha, mode: 'keep' }, `已重置到 ${short}`) },
          { label: '重置到此（丢弃更改）', act: () => this.confirmRun(`把当前分支重置到 ${short}，并丢弃之后的提交与未提交更改？`, { label: '丢弃并重置', danger: true }, 'reset', { sha, mode: 'discard' }, `已重置到 ${short}`) }
        ];
      }
      return null;
    }

    // `@路径` with quoting when the path has spaces (Claude's own @ syntax).
    atPath(p) {
      return /\s/.test(p) ? `@"${p}"` : `@${p}`;
    }

    // The selected diff rows → a line range. New-file numbers unless every
    // selected row is a deletion (then old numbers, marked). Returns null
    // when the selection cannot be tied to rows; the caller then degrades
    // to the raw fragment — a fabricated range would be worse than none.
    diffSelection(diffBody) {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
      const text = sel.toString();
      if (!text.trim()) return null;
      const rows = diffBody.querySelectorAll('.git-ide-dl:not(.hunk)');
      let touched = [];
      for (const row of rows) {
        if (sel.containsNode(row, true)) touched.push(row);
      }
      if (!touched.length) return { text };
      const num = (row, idx) => {
        const spans = row.querySelectorAll('.git-ide-dl-num');
        return spans[idx] && spans[idx].textContent.trim();
      };
      const isNew = (row) => !row.classList.contains('del');
      let from = Infinity, to = -Infinity, olds = [], allDel = touched.every((r) => r.classList.contains('del'));
      for (const row of touched) {
        const v = allDel ? num(row, 0) : num(row, isNew(row) ? 1 : 0);
        const n = Number(v);
        if (!v || !Number.isFinite(n)) continue;
        from = Math.min(from, n); to = Math.max(to, n); olds.push(v);
      }
      if (to < 0) return { text };
      return { from, to, oldLines: allDel, text };
    }

    get selectedCommit() {
      return this.commits.find((c) => c.sha === this.selectedSha) || null;
    }

    openMenu(x, y, items) {
      this.closeMenu();
      const menu = document.createElement('div');
      menu.className = 'git-ide-menu';
      for (const item of items) {
        if (item.sep) {
          const sep = document.createElement('div');
          sep.className = 'git-ide-menu-sep';
          menu.appendChild(sep);
          continue;
        }
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = item.label;
        if (item.danger) btn.classList.add('danger');
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.closeMenu();
          item.act();
        });
        menu.appendChild(btn);
      }
      document.body.appendChild(menu);
      const rect = menu.getBoundingClientRect();
      // Keep the menu inside the window (an IDE menu never opens off-screen).
      menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
      menu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
      this.menu = menu;
    }

    closeMenu() {
      if (this.menu) { this.menu.remove(); this.menu = null; }
    }

    // ── phase D flows: run / confirm / prompt / delete / undo ─────────────

    // Every history operation ends the same way: POST, toast the outcome in
    // git's own words on failure, refresh whatever could have moved, and if
    // the answer carries an undo id, put the net up.
    async runOp(op, body, okMessage) {
      this.beginLoad();
      const { status, data } = await fetch(`/api/git/ide/${op}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.auth() },
        body: JSON.stringify({ path: this.repoPath, ...body })
      }).then((r) => r.json().then((d) => ({ status: r.status, data: d }))).catch(() => ({ status: 0, data: {} }));
      this.endLoad();
      if (status !== 200) {
        window.app.showToast((data && data.error) || '操作失败', true);
        return null;
      }
      window.app.showToast(okMessage || '完成');
      this.reload();
      return data;
    }

    confirmRun(body, opts, op, reqBody, okMessage) {
      const app = window.app;
      // go() awaits runOp so the undo id (delete/reset) can raise the net.
      const go = async () => {
        const r = await this.runOp(op, reqBody, okMessage);
        if (r && r.undoId) this.offerUndo(okMessage || '操作完成', r.undoId);
      };
      if (app && app.confirmDialog) {
        return app.confirmDialog({
          title: opts.label, body,
          confirmText: opts.label, cancelText: '取消', danger: !!opts.danger
        }).then((yes) => { if (yes) go(); });
      }
      if (window.confirm(`${opts.label}\n\n${body}`)) go();
      return Promise.resolve();
    }

    promptName(title, kind, sha) {
      const name = window.prompt(`${title}（基于 ${sha.slice(0, 7)}）：`, '');
      if (!name || !name.trim()) return;
      const clean = name.trim();
      if (kind === 'branch') {
        this.runOp('branch', { name: clean, from: sha, checkout: true }, `已创建并切换到 ${clean}`);
      } else {
        this.runOp('tag', { name: clean, sha }, `已打标签 ${clean}`);
      }
    }

    // Deleting main/master/trunk takes a typed name; an unmerged branch takes
    // a second, sterner confirmation (the undo net still catches it).
    async deleteBranchFlow(name) {
      const protectedNames = ['main', 'master', 'trunk'];
      if (protectedNames.includes(name)) {
        const typed = window.prompt(`删除受保护分支 ${name} 需要输入分支名确认：`, '');
        if (typed !== name) {
          window.app.showToast('输入的分支名不一致，未删除', true);
          return;
        }
      }
      const app = window.app;
      const go = async () => {
        const r = await this.runOp('delete-branch', { name }, `已删除 ${name}`);
        if (r && r.undoId) this.offerUndo(`已删除分支 ${name}`, r.undoId);
      };
      const okFn = app && app.confirmDialog
        ? app.confirmDialog({ title: '删除分支', body: `删除分支 ${name}？30 分钟内可撤回。`, confirmText: '删除', danger: true }).then((y) => { if (y) go(); })
        : (window.confirm(`删除分支 ${name}？`) ? go() : null);
      await okFn;
    }

    // The undo net: a small fixed toast inside the panel with one button.
    // One-shot by design — the server consumes the ledger entry.
    offerUndo(text, undoId) {
      this.dismissUndo();
      const bar = document.createElement('div');
      bar.className = 'git-ide-undo';
      const label = document.createElement('span');
      label.textContent = text;
      bar.appendChild(label);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '撤回';
      btn.addEventListener('click', async () => {
        const r = await this.runOp('undo', { id: undoId }, '已撤回');
        if (r) this.dismissUndo();
      });
      bar.appendChild(btn);
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'git-ide-undo-x';
      close.setAttribute('aria-label', 'Dismiss');
      close.textContent = '×';
      close.addEventListener('click', () => this.dismissUndo());
      bar.appendChild(close);
      this.el('gitIdePanel').appendChild(bar);
      this.undoBar = bar;
    }

    dismissUndo() {
      if (this.undoBar) { this.undoBar.remove(); this.undoBar = null; }
    }

    // Insert a reference into the ACTIVE task's Claude — bracketed paste, no
    // trailing Enter: the user reviews and submits (plan §3.4.8 — the panel
    // never pulls the trigger). No connected task → clipboard + a toast that
    // says so. A busy Claude is NOT a degrade case: queued PTY input is fine.
    sendToConversation(text) {
      const app = window.app;
      const sid = app && app.currentClaudeSessionId;
      const paste = '\x1b[200~' + text + '\x1b[201~';
      if (app && typeof app.sendInput === 'function' && sid && app.sendInput(paste, sid)) {
        let name = '';
        try {
          const tab = app.sessionTabManager && app.sessionTabManager.tabs.get(sid);
          name = (tab && tab.name) || sid.slice(0, 8);
        } catch (_) { name = sid.slice(0, 8); }
        app.showToast(`已插入「${name}」的输入框，检查后回车发送`);
      } else {
        this.copyText(text, '没有连接中的任务——已复制，请在终端粘贴');
      }
    }

    // ── branch tree (task 4) ──────────────────────────────────────────────

    async loadRefs() {
      this.beginLoad();
      const { status, data } = await this.get(
        `/api/git/ide/refs?path=${encodeURIComponent(this.repoPath)}`);
      this.endLoad();
      if (status !== 200) { this.refs = null; this.renderTree(); return; }
      this.refs = data;
      this.renderTree();
    }

    renderTree() {
      const tree = this.el('gitIdeTree');
      if (!tree) return;
      tree.textContent = '';
      if (!this.refs) {
        tree.appendChild(this.skeletons(6));
        return;
      }
      const r = this.refs;
      const groups = [
        { key: 'local', label: '本地', rows: (r.local || []).filter((b) => !b.current).map((b) => ({ name: b.name, ahead: b.ahead, behind: b.behind, kind: 'local' })) },
        { key: 'remote', label: '远程', rows: (r.remote || []).map((b) => ({ name: b.name, kind: 'remote' })) },
        { key: 'tags', label: '标签', rows: (r.tags || []).map((t) => ({ name: t, kind: 'tag' })) },
      ];
      // Current branch first, always expanded — it is the answer to "where am
      // I" and the row the eye looks for.
      const frag = document.createDocumentFragment();
      const head = document.createElement('div');
      head.className = 'git-ide-group';
      const headRow = document.createElement('button');
      headRow.type = 'button';
      headRow.className = 'git-ide-ref current' + (this.scope === 'current' ? ' active' : '');
      headRow.dataset.ref = 'current';
      const headName = document.createElement('span');
      headName.className = 'git-ide-ref-name';
      headName.textContent = r.detached ? `detached @ ${(r.current || '').slice(0, 7)}` : (r.current || '(无分支)');
      headRow.appendChild(headName);
      if (this.summary && (this.summary.ahead || this.summary.behind)) {
        const ab = document.createElement('span');
        ab.className = 'git-ide-ab';
        ab.textContent = `${this.summary.ahead ? '↑' + this.summary.ahead : ''}${this.summary.behind ? ' ↓' + this.summary.behind : ''}`;
        headRow.appendChild(ab);
      }
      head.appendChild(headRow);
      frag.appendChild(head);

      for (const g of groups) {
        if (!g.rows.length) continue;
        const collapsed = this.treeCollapsed.includes(g.key);
        const group = document.createElement('div');
        group.className = 'git-ide-group' + (collapsed ? ' collapsed' : '');
        const gh = document.createElement('button');
        gh.type = 'button';
        gh.className = 'git-ide-group-head';
        gh.dataset.group = g.key;
        gh.innerHTML = `<span class="git-ide-chevron">&#rsaquo;</span><span class="git-ide-group-label">${g.label}</span><span class="git-ide-group-count">${g.rows.length}</span>`;
        group.appendChild(gh);
        const list = document.createElement('div');
        list.className = 'git-ide-group-rows';
        for (const row of g.rows) {
          const b = document.createElement('button');
          b.type = 'button';
          // Browsing a branch's history, never checking it out (dsh rule).
          b.className = `git-ide-ref kind-${row.kind}` + (this.scope === row.name ? ' active' : '');
          b.dataset.ref = row.name;
          const nm = document.createElement('span');
          nm.className = 'git-ide-ref-name';
          nm.textContent = row.name;
          b.appendChild(nm);
          if (row.ahead || row.behind) {
            const ab = document.createElement('span');
            ab.className = 'git-ide-ab';
            ab.textContent = `${row.ahead ? '↑' + row.ahead : ''}${row.behind ? ' ↓' + row.behind : ''}`;
            b.appendChild(ab);
          }
          list.appendChild(b);
        }
        group.appendChild(list);
        frag.appendChild(group);
      }
      tree.appendChild(frag);
    }

    // ── history list (task 4) ─────────────────────────────────────────────

    bindHistory() {
      const list = this.el('gitIdeList');
      if (!list) return;

      this.el('gitIdeScope').addEventListener('change', (e) => {
        this.scope = e.target.value === 'all' ? 'all' : 'current';
        this.loadLog(true);
        this.renderTree();
      });

      // Debounced filters: typing fires at most one git log every 300ms —
      // the no-hammering counterpart of the server's no-polling rule.
      let deb = null;
      const debounced = () => {
        if (deb) clearTimeout(deb);
        deb = setTimeout(() => {
          const text = this.el('gitIdeText').value.trim();
          const author = this.el('gitIdeAuthor').value.trim();
          if (text === this.text && author === this.author) return;
          this.text = text;
          this.author = author;
          this.loadLog(true);
        }, 300);
      };
      this.el('gitIdeText').addEventListener('input', debounced);
      this.el('gitIdeAuthor').addEventListener('input', debounced);

      // Tree clicks: a ref row switches the history scope (browse, not
      // checkout); a group head collapses/expands. One delegated listener.
      this.el('gitIdeTree').addEventListener('click', (e) => {
        const head = e.target.closest('.git-ide-group-head');
        if (head) {
          const key = head.dataset.group;
          const group = head.closest('.git-ide-group');
          const collapsed = !group.classList.contains('collapsed');
          group.classList.toggle('collapsed', collapsed);
          // Single source of truth: the collapsed LIST drives the class, and
          // the class is the live copy (spaces.js lesson — never two writers).
          this.treeCollapsed = collapsed
            ? [...new Set([...this.treeCollapsed, key])]
            : this.treeCollapsed.filter((k) => k !== key);
          writeState({ treeCollapsed: this.treeCollapsed });
          return;
        }
        const ref = e.target.closest('.git-ide-ref');
        if (ref) {
          this.scope = ref.dataset.ref;   // 'current', a branch, remote or tag
          this.loadLog(true);
          this.renderTree();
          this.el('gitIdeList').focus({ preventScroll: true });
        }
      });

      list.addEventListener('click', (e) => {
        const row = e.target.closest('.git-ide-row');
        if (row) this.select(row.dataset.sha);
      });

      list.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          this.moveSelection(e.key === 'ArrowDown' ? 1 : -1);
        } else if (e.key === '/') {
          e.preventDefault();
          this.el('gitIdeText').focus();
        }
      });

      // Infinite scroll: a sentinel div at the list's end; when it scrolls
      // into view (and more pages exist), fetch the next 120. No timer.
      this.sentinel = document.createElement('div');
      this.sentinel.className = 'git-ide-more';
      this.sentinel.textContent = '';
      this.scrollIo = new IntersectionObserver((entries) => {
        if (entries.some((en) => en.isIntersecting)) this.loadMore();
      }, { root: list, rootMargin: '240px' });
      this.scrollIo.observe(this.sentinel);
    }

    moveSelection(delta) {
      const rows = [...this.el('gitIdeList').querySelectorAll('.git-ide-row')];
      if (!rows.length) return;
      const at = rows.findIndex((r) => r.dataset.sha === this.selectedSha);
      const next = Math.max(0, Math.min(rows.length - 1, (at < 0 ? 0 : at + delta)));
      this.select(rows[next].dataset.sha);
      rows[next].scrollIntoView({ block: 'nearest' });
      this.el('gitIdeList').focus({ preventScroll: true });
    }

    select(sha, opts) {
      this.selectedSha = sha;
      const list = this.el('gitIdeList');
      for (const row of list.querySelectorAll('.git-ide-row')) {
        row.classList.toggle('selected', row.dataset.sha === sha);
      }
      // Selection IS navigation: the detail pane follows the arrows too,
      // never only the mouse (plan §3.4.9) — but the SILENT auto-select of
      // the newest commit on open must not yank the tab out from under a
      // user looking at their changes.
      if (!opts || opts.switchTab !== false) this.showDetailTab('detail');
      this.loadDetail(sha);
    }

    // ── commit detail + inline diff (task 5) ──────────────────────────────

    async loadDetail(sha) {
      const pane = this.el('gitIdeCommitDetail');
      if (!pane || !sha) return;
      pane.textContent = '';
      pane.appendChild(this.skeletons(6));
      this.beginLoad();
      const { status, data } = await this.get(
        `/api/git/ide/commit?path=${encodeURIComponent(this.repoPath)}&sha=${encodeURIComponent(sha)}`);
      this.endLoad();
      if (this.selectedSha !== sha) return;  // a newer selection won the race
      pane.textContent = '';
      if (status !== 200) {
        const err = document.createElement('div');
        err.className = 'git-ide-empty';
        err.textContent = (data && data.error) || 'Cannot read this commit';
        pane.appendChild(err);
        return;
      }
      this.renderDetail(data, sha);
    }

    renderDetail(data, sha) {
      const pane = this.el('gitIdeCommitDetail');
      const frag = document.createDocumentFragment();
      const commit = data.commit || {};

      const head = document.createElement('div');
      head.className = 'git-ide-d-head';
      const shaEl = document.createElement('button');
      shaEl.type = 'button';
      shaEl.className = 'git-ide-d-sha';
      shaEl.textContent = sha.slice(0, 7);
      // A click copies the short sha — the panel's own clipboard path.
      shaEl.addEventListener('click', () => this.copyText(sha.slice(0, 7), '修订号已复制'));
      head.appendChild(shaEl);
      const who = document.createElement('span');
      who.className = 'git-ide-d-who';
      who.textContent = `${commit.author || ''} · ${commit.date ? new Date(commit.date).toLocaleString() : ''}`;
      head.appendChild(who);
      frag.appendChild(head);

      const msg = document.createElement('div');
      msg.className = 'git-ide-d-msg';
      msg.textContent = (commit.message || '').trim() || '(no message)';
      frag.appendChild(msg);

      const filesTitle = document.createElement('div');
      filesTitle.className = 'git-ide-d-files-title';
      const n = (data.files || []).length;
      filesTitle.textContent = n ? `变更 ${n} 个文件` : '没有文件变更';
      frag.appendChild(filesTitle);

      for (const f of data.files || []) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'git-ide-file';
        row.dataset.path = f.path;
        const st = document.createElement('span');
        st.className = 'git-ide-file-st ' + (f.status || 'M').toLowerCase();
        st.textContent = f.status || 'M';
        row.appendChild(st);
        const name = document.createElement('span');
        name.className = 'git-ide-file-name';
        name.textContent = f.renameFrom ? `${f.renameFrom} → ${f.path}` : f.path;
        name.title = name.textContent;
        row.appendChild(name);
        const counts = document.createElement('span');
        counts.className = 'git-ide-file-counts';
        counts.textContent = `+${f.add} −${f.del}`;
        counts.classList.add(f.add !== '0' ? 'has-add' : '');
        if (f.del !== '0') counts.classList.add('has-del');
        row.appendChild(counts);
        // Click a file → its diff expands under it, one at a time (an
        // accordion: an endless stack of open diffs is not a detail pane).
        row.addEventListener('click', () => this.toggleFileDiff(row, f.path, sha));
        frag.appendChild(row);
      }
      pane.appendChild(frag);
    }

    async toggleFileDiff(row, file, sha) {
      const existing = row.nextElementSibling;
      if (existing && existing.classList.contains('git-ide-diff')) {
        existing.remove();   // second click collapses
        return;
      }
      // Close any other open diff first (accordion).
      const pane = this.el('gitIdeCommitDetail');
      for (const open of pane.querySelectorAll('.git-ide-diff')) open.remove();

      const holder = document.createElement('div');
      holder.className = 'git-ide-diff loading';
      row.after(holder);
      this.beginLoad();
      const { status, data } = await this.get(
        `/api/git/ide/diff?path=${encodeURIComponent(this.repoPath)}&commit=${encodeURIComponent(sha)}&file=${encodeURIComponent(file)}`);
      this.endLoad();
      if (!holder.isConnected) return;  // collapsed while in flight
      holder.classList.remove('loading');
      if (status !== 200) {
        holder.textContent = (data && data.error) || 'Cannot read this diff';
        return;
      }
      this.renderDiff(holder, data.diff || '', !!data.truncated);
    }

    // A unified diff, parsed into typed rows. File-header lines (diff --git,
    // index, ---/+++) are dropped — the clicked file row already names the
    // file; the hunk headers carry the alignment that matters.
    renderDiff(holder, text, truncated) {
      const bar = document.createElement('div');
      bar.className = 'git-ide-diff-bar';
      const wrapBtn = document.createElement('button');
      wrapBtn.type = 'button';
      wrapBtn.className = 'git-ide-diff-btn';
      this.diffWrap = !!(readState().diffWrap);
      wrapBtn.textContent = this.diffWrap ? '自动换行：开' : '自动换行：关';
      wrapBtn.addEventListener('click', () => {
        this.diffWrap = !this.diffWrap;
        writeState({ diffWrap: this.diffWrap });
        holder.classList.toggle('wrapped', this.diffWrap);
        wrapBtn.textContent = this.diffWrap ? '自动换行：开' : '自动换行：关';
      });
      bar.appendChild(wrapBtn);
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'git-ide-diff-btn';
      copyBtn.textContent = '复制';
      copyBtn.addEventListener('click', () => this.copyText(text, 'diff 已复制'));
      bar.appendChild(copyBtn);
      if (truncated) {
        const note = document.createElement('span');
        note.className = 'git-ide-diff-note';
        note.textContent = '已截断（文件过大）';
        bar.appendChild(note);
      }
      holder.appendChild(bar);

      const body = document.createElement('div');
      body.className = 'git-ide-diff-body';
      if (this.diffWrap) holder.classList.add('wrapped');

      let oldNo = 0, newNo = 0;
      const frag = document.createDocumentFragment();
      for (const raw of String(text).split('\n')) {
        const line = document.createElement('div');
        line.className = 'git-ide-dl';
        const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunk) {
          oldNo = Number(hunk[1]);
          newNo = Number(hunk[2]);
          line.classList.add('hunk');
          const t = document.createElement('span');
          t.className = 'git-ide-dl-num';
          t.textContent = '…';
          line.appendChild(t.cloneNode(true));
          t.textContent = raw;
          line.appendChild(t);
          frag.appendChild(line);
          continue;
        }
        if (raw.startsWith('---') || raw.startsWith('+++') || raw.startsWith('diff ') || raw.startsWith('index ') || raw.startsWith('new file') || raw.startsWith('deleted file') || raw.startsWith('similarity')) {
          continue;  // header noise — the file row already names the file
        }
        const type = raw.startsWith('-') ? 'del' : raw.startsWith('+') ? 'add' : raw.startsWith('\\') ? 'meta' : 'ctx';
        line.classList.add(type);
        const oldEl = document.createElement('span');
        oldEl.className = 'git-ide-dl-num';
        oldEl.textContent = type === 'add' ? '' : String(oldNo++);
        const newEl = document.createElement('span');
        newEl.className = 'git-ide-dl-num';
        newEl.textContent = type === 'del' ? '' : String(newNo++);
        const txt = document.createElement('span');
        txt.className = 'git-ide-dl-txt';
        txt.textContent = raw;
        line.append(oldEl, newEl, txt);
        frag.appendChild(line);
      }
      body.appendChild(frag);
      holder.appendChild(body);
    }

    copyText(text, okMessage) {
      const done = () => {
        if (window.app && window.app.showToast) window.app.showToast(okMessage);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, () => window.prompt('Copy this:', text));
      } else {
        window.prompt('Copy this:', text);
      }
    }

    loadMore() {
      if (!this.hasMore || this.loading > 0) return;
      this.loadLog(false);
    }

    async loadLog(reset) {
      if (!this.repoPath) return;
      if (reset) { this.logOffset = 0; this.commits = []; }
      const list = this.el('gitIdeList');
      const q = this.logQuery(this.logOffset);
      // A refresh of the SAME query (⟳, reopen from cache) swaps rows in
      // place — the skeleton is for a genuinely new view, never a flash
      // between two renders of the same one.
      const sameQuery = q.toString() === this.lastQuery;
      this.lastQuery = q.toString();
      if (reset && !sameQuery) {
        list.textContent = '';
        list.appendChild(this.skeletons(10));
      }
      this.beginLoad();
      const { status, data } = await this.get(`/api/git/ide/log?${q}`);
      this.endLoad();
      if (status !== 200) {
        // A failed REFRESH keeps the rows already on screen; only a new view
        // that never loaded shows the error state.
        if (reset && !sameQuery) {
          list.textContent = '';
          const err = document.createElement('div');
          err.className = 'git-ide-empty';
          err.textContent = (data && data.error) || 'Cannot read history';
          list.appendChild(err);
        }
        return;
      }
      const start = this.commits.length;
      this.commits = this.commits.concat(data.commits || []);
      this.hasMore = !!data.hasMore;
      this.logOffset = data.nextOffset || this.logOffset + (data.commits || []).length;
      // Lanes recompute over the FULL list — the algorithm never compacts, so
      // the prefix keeps its lanes and only the new rows need rendering.
      this.lanes = window.GitIdeGraph.computeLanes(this.commits);
      if (reset) list.textContent = '';
      this.appendRows(start);
      if (!this.commits.length) {
        const empty = document.createElement('div');
        empty.className = 'git-ide-empty';
        empty.textContent = '没有匹配的提交';
        list.appendChild(empty);
      }
      list.appendChild(this.sentinel);
      this.sentinel.textContent = this.hasMore ? '↓ 滚动加载更多' : '';
      // First open: the newest commit is already the answer to "what just
      // happened" — select it (silently: no tab switch) so the detail tab is
      // never empty when the user lands on it.
      if (reset && !this.selectedSha && this.commits.length) this.select(this.commits[0].sha, { switchTab: false });
    }

    // Rows for commits[start..], each a fixed 24px so the lane cells stack
    // pixel-aligned (plan §3.4.11).
    appendRows(start) {
      const list = this.el('gitIdeList');
      const frag = document.createDocumentFragment();
      let maxLane = 0;
      for (const lane of this.lanes) maxLane = Math.max(maxLane, lane.lane, ...(lane.mergesIn || []), ...(lane.mergeOut || []));
      const cellW = Math.min(24 + maxLane * 12 + 10, 190);
      for (let i = start; i < this.commits.length; i++) {
        const c = this.commits[i];
        const row = document.createElement('div');
        row.className = 'git-ide-row' + (c.sha === this.selectedSha ? ' selected' : '');
        row.dataset.sha = c.sha;
        row.setAttribute('role', 'listitem');

        const time = document.createElement('span');
        time.className = 'git-ide-time';
        time.textContent = relTime(c.date);
        time.title = new Date(c.date).toLocaleString();
        row.appendChild(time);

        const author = document.createElement('span');
        author.className = 'git-ide-author';
        author.textContent = c.author;
        row.appendChild(author);

        row.appendChild(this.graphCell(i, cellW));

        const refs = document.createElement('span');
        refs.className = 'git-ide-refs';
        for (const badge of refBadges(c.refs)) {
          const b = document.createElement('span');
          b.className = 'git-ide-badge ' + badge.kind;
          b.textContent = badge.text;
          refs.appendChild(b);
        }
        if (c.refs && c.refs.length > 3) {
          const more = document.createElement('span');
          more.className = 'git-ide-badge more';
          more.textContent = '+' + (c.refs.length - 3);
          refs.appendChild(more);
        }
        row.appendChild(refs);

        const subject = document.createElement('span');
        subject.className = 'git-ide-subject';
        subject.textContent = c.subject;
        row.appendChild(subject);

        frag.appendChild(row);
      }
      list.appendChild(frag);
    }

    // One commit's graph cell: pass-through verticals for the gaps above and
    // below, bends for the knot (mergesIn above the dot, mergeOut below),
    // the dot itself — hollow when this row carries HEAD.
    graphCell(i, cellW) {
      const lane = this.lanes[i];
      const prev = i > 0 ? this.lanes[i - 1] : null;
      const x = (k) => 12 + k * 12;
      const H = 24;
      let svg = `<svg class="git-ide-graph" width="${cellW}" height="${H}" viewBox="0 0 ${cellW} ${H}" aria-hidden="true">`;
      const edge = (d, k) => `<path class="git-ide-edge gl${k % 6}" d="${d}"/>`;
      if (prev) {
        for (const k of prev.activeAfter) {
          if (lane.mergesIn.includes(k)) {
            svg += edge(`M ${x(k)} 0 C ${x(k)} 8, ${x(lane.lane)} 4, ${x(lane.lane)} 12`, lane.lane);
          } else {
            svg += edge(`M ${x(k)} 0 V 12`, k);
          }
        }
      }
      for (const k of lane.activeAfter) {
        if (lane.mergeOut.includes(k)) {
          svg += edge(`M ${x(lane.lane)} 12 C ${x(lane.lane)} 20, ${x(k)} 16, ${x(k)} 24`, k);
        } else {
          svg += edge(`M ${x(k)} 12 V ${H}`, k);
        }
      }
      const isHead = (this.commits[i].refs || []).some((r) => r.startsWith('HEAD'));
      svg += `<circle class="git-ide-dot gl${lane.lane % 6}${isHead ? ' head' : ''}" cx="${x(lane.lane)}" cy="12" r="3.4"/>`;
      svg += '</svg>';
      const cell = document.createElement('span');
      cell.className = 'git-ide-graph-cell';
      cell.innerHTML = svg;
      return cell;
    }

    skeletons(n) {
      const frag = document.createDocumentFragment();
      for (let i = 0; i < n; i++) {
        const s = document.createElement('div');
        s.className = 'git-ide-skel';
        frag.appendChild(s);
      }
      return frag;
    }

    // ── open / close ──────────────────────────────────────────────────────

    openRepo(repoPath, repoName) {
      this.bind();
      if (!repoPath) return;
      this.repoPath = repoPath;
      this.repoName = repoName || repoPath.split('/').pop() || repoPath;
      this.el('gitIdeRepoName').textContent = this.repoName;
      this.el('gitIdeRepoName').title = repoPath;
      this.open = true;
      this.el('gitIdePanel').classList.add('open');
      // The mask exists for the ≤768px fullscreen mode only; on desktop the
      // drawer shares the screen with the terminal.
      this.el('gitIdeMask').hidden = !window.matchMedia('(max-width: 768px)').matches;
      if (this.width) this.applyWidth(this.width);
      // Which tab opens first is decided once, by the tree's state: dirty →
      // 变更 (there is something to do), clean → 详情. Later refreshes never
      // yank the tab back out from under the user.
      this.justOpened = true;
      // First paint from cache when we have one (a hover prewarm or the
      // previous visit): the panel opens populated, then the reload below
      // refreshes the same panes in place. Never a blank-then-pop.
      const cached = this.cache[repoPath];
      if (cached) {
        this.summary = cached.summary || null;
        this.refs = cached.refs || null;
        this.commits = (cached.log && cached.log.commits) || [];
        this.lanes = window.GitIdeGraph.computeLanes(this.commits);
        this.hasMore = !!(cached.log && cached.log.hasMore);
        this.logOffset = (cached.log && cached.log.nextOffset) || 0;
        this.selectedSha = null;
        // Claim this query as current: the reload below then refreshes in
        // place instead of flashing a skeleton over the cached paint.
        this.lastQuery = this.logQuery().toString();
        this.applySummary(cached.summary);
        this.renderTree();
        const list = this.el('gitIdeList');
        list.textContent = '';
        if (this.commits.length) this.appendRows(0);
        list.appendChild(this.sentinel);
      }
      this.reload();
    }

    // The history query for the current filters at a given offset — one
    // builder so the cache-paint path and loadLog always agree on the string.
    logQuery(offset = 0) {
      const q = new URLSearchParams({
        path: this.repoPath, scope: this.scope, offset: String(offset)
      });
      if (this.text) q.set('text', this.text);
      if (this.author) q.set('author', this.author);
      return q;
    }

    // ── prewarm + cache (task 6) ──────────────────────────────────────────
    //
    // The prewarm trigger is intent, not a timer: hovering a row's deep-dive
    // button means the open is one click away, so the summary and the first
    // history page are fetched once per repo per 60s and cached. Nothing
    // polls, nothing warms repos nobody looked at.

    prewarm(repoPath) {
      if (!repoPath || this.cache[repoPath]) return;
      if (this.prewarming && this.prewarming.has(repoPath)) return;
      (this.prewarming = this.prewarming || new Set()).add(repoPath);
      const at = Date.now();
      Promise.all([
        this.get(`/api/git/ide/summary?path=${encodeURIComponent(repoPath)}`),
        this.get(`/api/git/ide/log?path=${encodeURIComponent(repoPath)}&offset=0`),
      ]).then(([s, l]) => {
        if (s.status === 200 || l.status === 200) {
          this.cache[repoPath] = { at, summary: s.status === 200 ? s.data : null, log: l.status === 200 ? l.data : null };
        }
      }).catch(() => {}).finally(() => this.prewarming.delete(repoPath));
    }

    close() {
      this.open = false;
      this.el('gitIdePanel').classList.remove('open');
      this.el('gitIdeMask').hidden = true;
    }

    // ── data ──────────────────────────────────────────────────────────────

    reload() {
      if (!this.repoPath) return;
      this.loadSummary();
      this.loadRefs();
      this.loadLog(true);
      this.loadStatus();
    }

    // ── change list + commit box (phase C) ────────────────────────────────

    async loadStatus() {
      const box = this.el('gitIdeChangeList');
      if (!box) return;
      box.textContent = '';
      const sk = document.createElement('div');
      sk.className = 'git-ide-skel';
      box.appendChild(sk);
      this.beginLoad();
      const { status, data } = await this.get(
        `/api/git/ide/status?path=${encodeURIComponent(this.repoPath)}`);
      this.endLoad();
      if (!box.isConnected) return;
      box.textContent = '';
      if (status !== 200) {
        const err = document.createElement('div');
        err.className = 'git-ide-empty';
        err.textContent = (data && data.error) || 'Cannot read the working tree';
        box.appendChild(err);
        return;
      }
      this.renderChanges(data);
    }

    renderChanges(st) {
      const box = this.el('gitIdeChangeList');
      const frag = document.createDocumentFragment();
      const groups = [
        { key: 'conflicts', label: '冲突', rows: st.conflicts, ops: false },
        { key: 'staged', label: '已暂存', rows: st.staged, ops: true, all: 'unstage', allLabel: '全部取消' },
        { key: 'changed', label: '更改', rows: st.changed, ops: true, all: 'stage', allLabel: '全部暂存' },
        { key: 'untracked', label: '未跟踪', rows: st.untracked.map((p) => ({ path: p })), ops: true, all: 'stage', allLabel: '全部暂存' },
      ];
      let any = false;
      for (const g of groups) {
        if (!g.rows.length) continue;
        any = true;
        const wrap = document.createElement('div');
        wrap.className = 'git-ide-cgroup';
        const head = document.createElement('div');
        head.className = 'git-ide-cgroup-head';
        const label = document.createElement('span');
        label.className = 'git-ide-cgroup-label' + (g.key === 'conflicts' ? ' conflict' : '');
        label.textContent = `${g.label} ${g.rows.length}`;
        head.appendChild(label);
        if (g.all) {
          const allBtn = document.createElement('button');
          allBtn.type = 'button';
          allBtn.className = 'git-ide-cgroup-all';
          allBtn.textContent = g.allLabel;
          allBtn.addEventListener('click', () => this.writeFiles(g.all, g.rows.map((r) => r.path)));
          head.appendChild(allBtn);
        }
        wrap.appendChild(head);
        for (const row of g.rows) {
          const item = document.createElement('div');
          item.className = 'git-ide-crow';
          const name = document.createElement('span');
          name.className = 'git-ide-file-name';
          name.textContent = row.renameFrom ? `${row.renameFrom} → ${row.path}` : row.path;
          name.title = name.textContent;
          item.appendChild(name);
          if (g.ops) {
            const acts = g.key === 'staged'
              ? [['unstage', '取消', '取消暂存'], ['discard', '丢弃', '丢弃更改']]
              : [['stage', '暂存', '暂存'], ['discard', '丢弃', '丢弃']];
            for (const [op, glyph, aria] of acts) {
              const b = document.createElement('button');
              b.type = 'button';
              b.className = `git-ide-cact ${op}` + (op === 'discard' ? ' danger' : '');
              b.textContent = glyph;
              b.setAttribute('aria-label', `${aria} ${row.path}`);
              b.addEventListener('click', () => {
                if (op === 'discard') {
                  this.confirmDiscard([row.path]).then((yes) => { if (yes) this.writeFiles('discard', [row.path]); });
                } else {
                  this.writeFiles(op, [row.path]);
                }
              });
              item.appendChild(b);
            }
          }
          wrap.appendChild(item);
        }
        frag.appendChild(wrap);
      }
      if (!any) {
        const clean = document.createElement('div');
        clean.className = 'git-ide-empty';
        clean.textContent = '工作区干净';
        frag.appendChild(clean);
      }
      box.appendChild(frag);
    }

    confirmDiscard(files) {
      const app = window.app;
      const one = files.length === 1 ? `「${files[0]}」` : `${files.length} 个文件`;
      if (app && app.confirmDialog) {
        return app.confirmDialog({
          title: '丢弃更改',
          body: `${one} 的未提交更改将被丢弃，此操作无法撤销。`,
          confirmText: '丢弃',
          cancelText: '取消',
          danger: true
        });
      }
      return Promise.resolve(window.confirm(`丢弃 ${one} 的更改？无法撤销。`));
    }

    // One POST for stage/unstage/discard, then the panes that could have
    // changed all refresh (status, summary pill, history's newest commit).
    async writeFiles(op, files) {
      this.beginLoad();
      const { status, data } = await fetch(`/api/git/ide/${op}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.auth() },
        body: JSON.stringify({ path: this.repoPath, files })
      }).then((r) => r.json().then((d) => ({ status: r.status, data: d }))).catch(() => ({ status: 0, data: {} }));
      this.endLoad();
      if (status !== 200) {
        if (window.app && window.app.showToast) {
          window.app.showToast((data && data.error) || '操作失败', true);
        }
        return;
      }
      this.loadStatus();
      this.loadSummary();
      this.loadLog(true);
    }

    async doCommit() {
      const msgEl = this.el('gitIdeCommitMsg');
      const message = msgEl.value.trim();
      if (!message) {
        window.app.showToast('写点提交信息再提交', true);
        msgEl.focus();
        return;
      }
      const btn = this.el('gitIdeCommitBtn');
      btn.disabled = true;
      const amend = this.el('gitIdeAmend').checked;
      this.beginLoad();
      const { status, data } = await fetch('/api/git/ide/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.auth() },
        body: JSON.stringify({ path: this.repoPath, message, amend })
      }).then((r) => r.json().then((d) => ({ status: r.status, data: d }))).catch(() => ({ status: 0, data: {} }));
      this.endLoad();
      btn.disabled = false;
      if (status !== 200) {
        window.app.showToast((data && data.error) || '提交失败', true);
        return;
      }
      msgEl.value = '';
      this.el('gitIdeAmend').checked = false;
      window.app.showToast(`已提交 ${data.head || ''}`);
      this.loadStatus();
      this.loadSummary();
      this.loadLog(true);
    }

    showDetailTab(which) {
      const isChanges = which === 'changes';
      this.el('gitIdeTabChanges').classList.toggle('active', isChanges);
      this.el('gitIdeTabDetail').classList.toggle('active', !isChanges);
      this.el('gitIdeChanges').hidden = !isChanges;
      this.el('gitIdeCommitDetail').hidden = isChanges;
    }

    async loadSummary() {
      this.beginLoad();
      const { status, data } = await this.get(
        `/api/git/ide/summary?path=${encodeURIComponent(this.repoPath)}`);
      this.endLoad();
      if (status !== 200) {
        this.summary = null;
        this.applySummary(null, (data && data.error) || 'Cannot read this repository');
        return;
      }
      this.summary = data;
      if (this.cache[this.repoPath]) this.cache[this.repoPath].summary = data;
      this.applySummary(data);
    }

    applySummary(data, error) {
      const pill = this.el('gitIdeBranchPill');
      const counts = this.el('gitIdeCounts');
      if (!data) {
        pill.hidden = false;
        pill.textContent = error || 'Cannot read this repository';
        pill.classList.add('git-ide-pill-error');
        counts.hidden = true;
        return;
      }
      pill.classList.remove('git-ide-pill-error');
      pill.hidden = false;
      pill.textContent = data.detached ? `detached @ ${data.branch}` : data.branch;
      pill.title = data.branch || '';
      if (this.justOpened) {
        this.justOpened = false;
        this.showDetailTab(data.dirty ? 'changes' : 'detail');
      }
      const bits = [];
      if (data.ahead) bits.push(`↑${data.ahead}`);
      if (data.behind) bits.push(`↓${data.behind}`);
      if (data.dirty) bits.push(`● ${data.dirty}`);
      if (data.stashes) bits.push(`◧ ${data.stashes}`);
      if (data.inProgress) bits.push(`${data.inProgress} 进行中`);
      counts.textContent = bits.join('  ');
      counts.hidden = !bits.length;
    }

    // ── tiered loading feedback (plan §3.4) ───────────────────────────────
    // Under 300ms: nothing. To 2s: skeletons (the panes' job). Past 2s: the
    // thin line under the header turns into a staged-progress note. Nothing
    // here spins a timer beyond the request's own lifetime.

    beginLoad() {
      this.loading++;
      const line = this.el('gitIdeProgress');
      line.hidden = false;
      line.classList.add('busy');
      line.textContent = '';
      if (!this.loadTimer) {
        this.loadTimer = setTimeout(() => {
          this.loadTimer = null;
          if (this.loading > 0) {
            const line2 = this.el('gitIdeProgress');
            line2.textContent = `读取 ${this.repoName} 中…（git 较慢时通常数秒内完成）`;
          }
        }, 2000);
      }
    }

    endLoad() {
      this.loading = Math.max(0, this.loading - 1);
      if (this.loading === 0) {
        if (this.loadTimer) { clearTimeout(this.loadTimer); this.loadTimer = null; }
        const line = this.el('gitIdeProgress');
        line.hidden = true;
        line.classList.remove('busy');
        line.textContent = '';
      }
    }

    // ── width: remembered, clamped to the window, 3px handle ──────────────

    applyWidth(px) {
      const max = Math.min(1100, Math.floor(window.innerWidth * 0.72));
      const w = Math.max(MIN_WIDTH, Math.min(max, Math.round(px)));
      this.width = w;
      this.el('gitIdePanel').style.setProperty('--git-ide-w', w + 'px');
    }

    setupResize() {
      const panel = this.el('gitIdePanel');
      // Right-edge handle, the sidebar's pattern (spaces.js) mirrored: JS
      // created, pointer events (touch drags too), double-click resets.
      const handle = document.createElement('div');
      handle.className = 'git-ide-resize';
      handle.title = 'Drag to resize';
      panel.appendChild(handle);

      let dragging = false;
      handle.addEventListener('pointerdown', (e) => {
        dragging = true;
        try { handle.setPointerCapture(e.pointerId); } catch (_) {}
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
      });
      document.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        e.preventDefault();
        // Right-anchored: the wider the panel, the smaller the pointer's x.
        this.applyWidth(window.innerWidth - e.clientX);
      });
      const end = () => {
        if (!dragging) return;
        dragging = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        writeState({ width: this.width });
      };
      document.addEventListener('pointerup', end);
      document.addEventListener('pointercancel', end);
      handle.addEventListener('dblclick', () => {
        this.applyWidth(DEFAULT_WIDTH);
        writeState({ width: DEFAULT_WIDTH });
      });
    }

    // ── adaptive layout: measure, never guess (dsh discipline) ────────────

    observeLayout() {
      const body = this.el('gitIdeBody');
      if (!body || typeof ResizeObserver === 'undefined') return;
      this.ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const w = entry.contentRect.width;
          const mode = w >= STACK_BREAKPOINT ? 'cols' : 'stack';
          if (mode === this.mode) return;
          this.mode = mode;
          body.classList.toggle('layout-cols', mode === 'cols');
          body.classList.toggle('layout-stack', mode === 'stack');
        }
      });
      this.ro.observe(body);
    }
  }

  window.gitIdePanel = new GitIdePanel();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => window.gitIdePanel.bind());
  } else {
    window.gitIdePanel.bind();
  }
})();
