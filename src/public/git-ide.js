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
      // The tree/list/detail panes hook their own reloads onto this event as
      // they land in later tasks; the shell only owns the header.
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
