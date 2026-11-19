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

    select(sha) {
      this.selectedSha = sha;
      const list = this.el('gitIdeList');
      for (const row of list.querySelectorAll('.git-ide-row')) {
        row.classList.toggle('selected', row.dataset.sha === sha);
      }
      // The detail pane (task 5) renders from this.selectedSha.
    }

    loadMore() {
      if (!this.hasMore || this.loading > 0) return;
      this.loadLog(false);
    }

    async loadLog(reset) {
      if (!this.repoPath) return;
      if (reset) { this.logOffset = 0; this.commits = []; }
      const list = this.el('gitIdeList');
      if (reset) {
        list.textContent = '';
        list.appendChild(this.skeletons(10));
      }
      this.beginLoad();
      const q = new URLSearchParams({
        path: this.repoPath, scope: this.scope, offset: String(this.logOffset)
      });
      if (this.text) q.set('text', this.text);
      if (this.author) q.set('author', this.author);
      const { status, data } = await this.get(`/api/git/ide/log?${q}`);
      this.endLoad();
      if (status !== 200) {
        if (reset) {
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
      this.reload();
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
    }

    async loadSummary() {
      this.beginLoad();
      const { status, data } = await this.get(
        `/api/git/ide/summary?path=${encodeURIComponent(this.repoPath)}`);
      this.endLoad();
      const pill = this.el('gitIdeBranchPill');
      const counts = this.el('gitIdeCounts');
      if (status !== 200) {
        pill.hidden = false;
        pill.textContent = (data && data.error) || 'Cannot read this repository';
        pill.classList.add('git-ide-pill-error');
        counts.hidden = true;
        this.summary = null;
        return;
      }
      this.summary = data;
      pill.classList.remove('git-ide-pill-error');
      pill.hidden = false;
      pill.textContent = data.detached ? `detached @ ${data.branch}` : data.branch;
      pill.title = data.branch || '';
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
