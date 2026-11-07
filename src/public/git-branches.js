// Branch panel: the current git branch of every sub-project under the tab's
// working directory. Opens from the desktop toolbar button (#branchBtn).
//
// A "big directory" here holds many independent repos side by side (cgs-cloud,
// cgs-front, flow-backend, ...). Which branch each one sits on is the thing you
// need constantly while working a task and the thing that silently goes wrong —
// one repo left behind on dev while the rest moved to the task branch.
//
// Two-stage on purpose: branch names come from reading .git/HEAD and land in
// milliseconds, so the panel paints at once. Working-tree state needs a git
// process per repo (~18x the cost) and only runs when "Check changes" is
// clicked. Nothing polls.
//
// Tick repos to act on several at once — switch, create a branch from each
// one's current branch, or rename each one's current branch — or click a row's
// branch name to switch just that repo. All of it is local: nothing is pushed.

(function () {
  // Repos sharing a branch get the same accent, so "who moved to the task
  // branch and who didn't" is one glance instead of string comparison. A branch
  // only one repo is on gets no colour — there is nothing to compare it to.
  //
  // JS picks the GROUP, CSS picks the COLOUR. An inline style here cannot follow
  // the theme, and the dark-theme greens and blues measure 2.5:1 on the light
  // theme's white — worse than the muted text they were meant to stand out
  // from. So this hands out a class and lets the stylesheet answer per theme.
  // Past six shared branches the palette would wrap and hand two different
  // branches the same colour — precisely the misreading the colouring exists to
  // prevent. Groups beyond the sixth stay muted instead.
  const GROUP_COUNT = 6;

  // Same shape as the file explorer's row-download icon: a small outline glyph
  // parsed once and cloned per row, rather than re-running the HTML parser
  // eleven times.
  const PULL_ICON = '<svg class="pull-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M8 11l4 4 4-4"/><path d="M4 21h16"/></svg>';
  const pullIconNode = (() => {
    const t = document.createElement('template');
    t.innerHTML = PULL_ICON;
    return t.content.firstElementChild;
  })();

  class BranchPanel {
    constructor() {
      this.bound = false;
      this.open = false;
      this.dir = null;
      // Every load takes a ticket. A status scan runs ~18x longer than a plain
      // one, so a "Check changes" on project A could still be in flight when
      // the panel reopens on project B — and it would then repaint A's branches
      // under B's heading. Only the newest ticket is allowed to render.
      this.loadToken = 0;
      // Ticked repo names; survives reloads for the repos that are still there.
      this.selected = new Set();
      this.repos = [];
      // The open action form ('switch' | 'create' | 'rename') and row picker.
      this.formOp = null;
      this.picker = null;
      // Failure notes outlive the reload that follows an operation, so the
      // reason stays readable for its full 6 seconds. name -> {text, title, until}
      this.notes = new Map();
    }

    el(id) { return document.getElementById(id); }

    // The tab's own project directory — the same source the rest of the app
    // uses. Deliberately NOT the file explorer's remembered browsing location:
    // this panel always answers for the project, not for wherever you last
    // clicked in the tree.
    workingDir() {
      const app = window.app;
      if (!app) return null;
      return (app.currentClaudeSessionId ? app.currentWorkingDir : app.selectedWorkingDir) || null;
    }

    bind() {
      if (this.bound) return;
      this.bound = true;
      const btn = this.el('branchBtn');
      if (!btn) return;
      btn.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(); });
      this.el('branchRefreshBtn').addEventListener('click', () => this.load());
      this.el('branchStatusBtn').addEventListener('click', () => this.load(true));
      // Clicking anywhere else, or Escape, dismisses it — a glance panel should
      // never need a deliberate close.
      document.addEventListener('click', (e) => {
        if (!this.open) return;
        const wrap = this.el('branchWrapper');
        if (wrap && !wrap.contains(e.target)) this.hide();
      });
      // Escape peels one layer at a time: the form or picker first, then the panel.
      document.addEventListener('keydown', (e) => {
        if (!(e.key === 'Escape' && this.open)) return;
        if (this.formOp) this.closeForm();
        else if (this.picker) this.closePicker();
        else this.hide();
      });
      // One delegated listener for every row, the way the file explorer does it:
      // eleven rows would otherwise mean eleven closures, re-created on every
      // render. The target travels in dataset, never innerHTML.
      this.el('branchList').addEventListener('click', (e) => {
        if (!e.target.closest) return;
        const btn = e.target.closest('.row-pull');
        if (btn) {
          if (btn.disabled) return;
          e.stopPropagation();
          this.pull(btn);
          return;
        }
        const item = e.target.closest('.branch-pick-item');
        if (item) {
          if (item.disabled) return;
          // The picker is removed below, so by the time the document listener
          // sees this click its target is detached and would read as "outside".
          e.stopPropagation();
          this.runOp('switch', [item.dataset.repo], item.dataset.branch);
          this.closePicker();
          return;
        }
        const ref = e.target.closest('.branch-ref.switchable');
        if (ref) this.togglePicker(ref.closest('.branch-row'));
      });
      // The branch name is a button for the keyboard too.
      this.el('branchList').addEventListener('keydown', (e) => {
        const ref = e.target.closest && e.target.closest('.branch-ref.switchable');
        if (ref && e.key === 'Enter') {
          e.preventDefault();
          this.togglePicker(ref.closest('.branch-row'));
        }
      });
      this.el('branchList').addEventListener('change', (e) => {
        const box = e.target.closest && e.target.closest('.branch-check');
        if (!box) return;
        if (box.checked) this.selected.add(box.dataset.repo);
        else this.selected.delete(box.dataset.repo);
        this.updateSelection();
      });
      this.el('branchSelectAll').addEventListener('change', (e) => {
        this.selected = e.target.checked ? new Set(this.repos.map((r) => r.name)) : new Set();
        for (const box of this.el('branchList').querySelectorAll('.branch-check')) {
          box.checked = this.selected.has(box.dataset.repo);
        }
        this.updateSelection();
      });
      for (const b of this.opButtons()) {
        b.addEventListener('click', () => this.openForm(b.dataset.op));
      }
      this.el('branchFormCancel').addEventListener('click', () => this.closeForm());
      this.el('branchForm').addEventListener('submit', (e) => { e.preventDefault(); this.submitForm(); });
    }

    toggle() { this.open ? this.hide() : this.show(); }

    hide() {
      this.open = false;
      this.closeForm();
      this.closePicker();
      const panel = this.el('branchPanel');
      if (panel) panel.classList.remove('active');
    }

    show() {
      this.bind();
      const panel = this.el('branchPanel');
      if (!panel) return;
      this.open = true;
      panel.classList.add('active');
      this.load();
    }

    async load(withStatus = false) {
      const dir = this.workingDir();
      const list = this.el('branchList');
      const title = this.el('branchDir');
      if (!list) return;

      // With no session yet, hand the server no path and let it answer for its
      // own base folder — the same fallback the file explorer takes, so the two
      // never disagree about where "here" is.
      this.dir = dir;
      title.textContent = dir ? (dir.split(/[\\/]/).filter(Boolean).pop() || dir) : '';
      title.title = dir || '';

      if (withStatus) {
        const btn = this.el('branchStatusBtn');
        btn.disabled = true;
        btn.textContent = 'Checking...';
      } else {
        this.message('Loading...');
      }

      const token = ++this.loadToken;
      try {
        const query = [];
        if (dir) query.push('path=' + encodeURIComponent(dir));
        if (withStatus) query.push('status=1');
        const url = '/api/git/branches' + (query.length ? '?' + query.join('&') : '');
        const res = await fetch(url, { headers: window.authManager.getAuthHeaders() });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (token !== this.loadToken) return;   // a newer load already rendered
        if (!dir && data.path) {
          // No session yet: the server answered for its own base folder, and
          // the row actions (pull, switch, ...) must name that same folder.
          this.dir = data.path;
          title.textContent = data.path.split(/[\\/]/).filter(Boolean).pop() || data.path;
          title.title = data.path;
        }
        this.render(data);
      } catch (error) {
        if (token === this.loadToken) this.message('Could not read branches: ' + error.message);
      } finally {
        const btn = this.el('branchStatusBtn');
        btn.disabled = false;
        btn.textContent = 'Check changes';
      }
    }

    message(text) {
      const list = this.el('branchList');
      list.textContent = '';
      const div = document.createElement('div');
      div.className = 'branch-empty';
      div.textContent = text;
      list.appendChild(div);
      this.el('branchFooterInfo').textContent = '';
    }

    render(data) {
      const list = this.el('branchList');
      const repos = data.repos || [];
      list.textContent = '';
      this.picker = null;
      this.repos = repos;
      const names = new Set(repos.map((r) => r.name));
      for (const n of [...this.selected]) if (!names.has(n)) this.selected.delete(n);
      this.updateSelection();

      if (!repos.length) {
        this.message(data.error === 'ENOENT' ? 'That directory no longer exists.'
                   : data.error ? 'Cannot read that directory.'
                   : data.unexamined ? `No git repositories found, but ${data.unexamined} directories were not examined — this one is too large to scan in full.`
                   : 'No git repositories here.');
        return;
      }

      // Colour only branches that more than one repo shares.
      const counts = new Map();
      for (const r of repos) counts.set(r.branch, (counts.get(r.branch) || 0) + 1);
      const group = new Map();
      let next = 0;
      for (const r of repos) {
        if (counts.get(r.branch) > 1 && !group.has(r.branch) && next < GROUP_COUNT) {
          group.set(r.branch, next++);
        }
      }

      const frag = document.createDocumentFragment();
      for (const repo of repos) {
        const row = document.createElement('div');
        row.className = 'branch-row';
        row.dataset.repo = repo.name;

        const check = document.createElement('input');
        check.type = 'checkbox';
        check.className = 'branch-check';
        check.dataset.repo = repo.name;
        check.checked = this.selected.has(repo.name);
        check.setAttribute('aria-label', '选择 ' + repo.name);
        row.appendChild(check);

        const name = document.createElement('span');
        name.className = 'branch-name';
        // Repo names come off the filesystem: textContent, never innerHTML.
        name.textContent = repo.name === '.' ? '(this directory)' : repo.name;
        name.title = name.textContent;
        row.appendChild(name);

        const meta = document.createElement('span');
        meta.className = 'branch-meta';

        if (repo.dirty) meta.appendChild(this.badge('● ' + repo.dirty, 'branch-dirty', repo.dirty + ' uncommitted change(s)'));
        if (repo.ahead) meta.appendChild(this.badge('↑' + repo.ahead, 'branch-ahead', repo.ahead + ' commit(s) ahead of upstream'));
        if (repo.behind) meta.appendChild(this.badge('↓' + repo.behind, 'branch-behind', repo.behind + ' commit(s) behind upstream'));

        const pull = document.createElement('button');
        pull.className = 'row-pull';
        pull.type = 'button';
        pull.title = `Fast-forward ${repo.name} from its upstream`;
        pull.setAttribute('aria-label', `Pull ${repo.name}`);
        pull.dataset.repo = repo.name;
        pull.appendChild(pullIconNode.cloneNode(true));
        meta.appendChild(pull);

        const branch = document.createElement('span');
        branch.className = 'branch-ref switchable' + (repo.detached ? ' detached' : '');
        branch.textContent = repo.detached ? 'detached @ ' + repo.branch : repo.branch;
        branch.title = branch.textContent + '（点击切换分支）';
        branch.tabIndex = 0;
        branch.setAttribute('role', 'button');
        const g = group.get(repo.branch);
        if (g !== undefined && !repo.detached) branch.classList.add('branch-g' + g);
        meta.appendChild(branch);
        this.applyNote(repo.name, branch);

        row.appendChild(meta);
        frag.appendChild(row);
      }
      list.appendChild(frag);

      const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
      let info = plural(repos.length, 'repo') + ' · ' + plural(counts.size, 'branch').replace('branchs', 'branches');
      if (data.truncated) info += ' · +' + data.truncated + ' not shown';
      // A directory too large to scan in full is a PARTIAL answer, and a panel
      // whose job is "every sub-project" must say so rather than look complete.
      if (data.unexamined) info += ' · ' + data.unexamined + ' dirs not examined';
      this.el('branchFooterInfo').textContent = info;
    }

    // Fast-forward one repo, then show what happened on its own row.
    //
    // The result replaces the branch name in place rather than popping a toast:
    // the answer belongs next to the thing it is about, and eleven rows of
    // toasts would be unreadable.
    async pull(btn) {
      const row = btn.closest('.branch-row');
      const name = btn.dataset.repo;
      if (!row || !name) return;

      const note = row.querySelector('.branch-ref');
      const wasText = note ? note.textContent : '';
      const wasClass = note ? note.className : '';
      btn.disabled = true;
      row.classList.add('pulling');
      if (note) { note.textContent = 'pulling...'; note.className = 'branch-ref'; }

      let result;
      try {
        const res = await fetch('/api/git/pull', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...window.authManager.getAuthHeaders() },
          body: JSON.stringify({ path: this.dir, name }),
        });
        result = await res.json();
      } catch (error) {
        result = { ok: false, reason: 'failed', message: error.message };
      }

      row.classList.remove('pulling');
      btn.disabled = false;
      if (!note) return;

      if (result && result.ok && result.reason === 'up-to-date') {
        note.textContent = 'up to date';
        note.className = 'branch-ref pull-ok';
      } else if (result && result.ok) {
        note.textContent = 'updated';
        note.className = 'branch-ref pull-ok';
        // The branch may have moved; refresh so the panel is not left showing
        // what was true before the pull.
        setTimeout(() => this.load(), 1200);
      } else {
        const why = {
          dirty: 'uncommitted changes',
          'no-upstream': 'no upstream',
          'not-fast-forward': 'needs a merge',
          timeout: 'timed out',
          'not-a-repo': 'not a repository',
        }[result && result.reason] || 'failed';
        note.textContent = why;
        note.className = 'branch-ref pull-bad';
        note.title = (result && result.message) || why;
        // Put the branch name back once the reason has been read.
        setTimeout(() => {
          if (note.classList.contains('pull-bad')) {
            note.textContent = wasText;
            note.className = wasClass;
          }
        }, 6000);
      }
    }

    // ---- Selection, the per-row switch picker, the multi-repo form ----------

    opButtons() {
      return this.el('branchActions').querySelectorAll('.branch-actions-bar .branch-op-btn');
    }

    updateSelection() {
      const n = this.selected.size;
      const all = this.el('branchSelectAll');
      if (all) {
        all.checked = n > 0 && n === this.repos.length;
        all.indeterminate = n > 0 && n < this.repos.length;
      }
      const actions = this.el('branchActions');
      if (!actions) return;
      actions.hidden = n === 0;
      this.el('branchSelCount').textContent = '已选 ' + n + ' 个';
      if (n === 0) this.closeForm();
    }

    async post(url, body) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...window.authManager.getAuthHeaders() },
        body: JSON.stringify({ path: this.dir, ...body }),
      });
      const data = await res.json().catch(() => ({}));
      return { status: res.status, data };
    }

    closePicker() {
      if (this.picker) this.picker.remove();
      this.picker = null;
    }

    // One repo's branches, opened under its row: local first, then remote ones
    // with no local copy (switching to one creates a tracking branch).
    async togglePicker(row) {
      if (!row) return;
      const name = row.dataset.repo;
      const reopen = !this.picker || this.picker.dataset.repo !== name;
      this.closePicker();
      if (!reopen) return;

      const box = document.createElement('div');
      box.className = 'branch-picker';
      box.dataset.repo = name;
      box.textContent = '加载中...';
      row.after(box);
      this.picker = box;

      let refs;
      try {
        const { data } = await this.post('/api/git/refs', { names: [name] });
        refs = data.repos && data.repos[name];
      } catch (_) { /* reported below */ }
      if (this.picker !== box) return;
      box.textContent = '';
      if (!refs || refs.error) {
        box.textContent = '读不到分支列表';
        return;
      }

      const item = (branch, current) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'branch-pick-item' + (current ? ' current' : '');
        b.dataset.repo = name;
        b.dataset.branch = branch;
        b.textContent = (current ? '✓ ' : '') + branch;
        b.disabled = current;
        return b;
      };
      const head = (text) => {
        const h = document.createElement('div');
        h.className = 'branch-pick-head';
        h.textContent = text;
        return h;
      };
      if (refs.local.length) box.appendChild(head('本地'));
      for (const b of refs.local) box.appendChild(item(b, b === refs.current));
      if (refs.remote.length) box.appendChild(head('远程（切换时建跟踪分支）'));
      for (const b of refs.remote) box.appendChild(item(b, false));
      if (!refs.local.length && !refs.remote.length) box.textContent = '没有可切换的分支';
    }

    async openForm(op) {
      this.closePicker();
      this.formOp = op;
      const n = this.selected.size;
      const input = this.el('branchFormInput');
      const list = this.el('branchFormList');
      const hint = this.el('branchFormHint');
      this.el('branchForm').hidden = false;
      for (const b of this.opButtons()) b.classList.toggle('active', b.dataset.op === op);
      this.el('branchCheckoutWrap').hidden = op !== 'create';
      hint.classList.remove('error');
      hint.textContent = {
        switch: '把选中的 ' + n + ' 个仓库切换到：',
        create: '基于各仓库当前分支，在 ' + n + ' 个仓库新建分支：',
        rename: '把 ' + n + ' 个仓库的当前分支改名为（只改本地，远程不动）：',
      }[op];
      list.textContent = '';
      input.value = '';
      input.placeholder = op === 'switch' ? '输入或选择分支名' : '新分支名';

      if (op === 'rename') {
        // Prefill only when the answer is unambiguous: every ticked repo sits
        // on the same branch.
        const branches = new Set(this.repos
          .filter((r) => this.selected.has(r.name) && !r.detached).map((r) => r.branch));
        if (branches.size === 1) input.value = [...branches][0];
      }
      input.focus();
      if (input.value) input.select();

      if (op === 'switch') {
        // Candidates: every branch any ticked repo has, with how many have it.
        const names = [...this.selected];
        try {
          const { data } = await this.post('/api/git/refs', { names });
          if (this.formOp !== 'switch') return;
          const count = new Map();
          for (const refs of Object.values(data.repos || {})) {
            if (!refs || refs.error) continue;
            for (const b of new Set([...refs.local, ...refs.remote])) count.set(b, (count.get(b) || 0) + 1);
          }
          const sorted = [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
          for (const [b, c] of sorted) {
            const o = document.createElement('option');
            o.value = b;
            o.label = c + '/' + names.length + ' 个仓库有';
            list.appendChild(o);
          }
        } catch (_) { /* typing a name still works */ }
      }
    }

    closeForm() {
      this.formOp = null;
      const form = this.el('branchForm');
      if (form) form.hidden = true;
      if (this.el('branchActions')) for (const b of this.opButtons()) b.classList.remove('active');
    }

    async submitForm() {
      const op = this.formOp;
      const branch = this.el('branchFormInput').value.trim();
      const hint = this.el('branchFormHint');
      if (!op) return;
      if (!branch) {
        hint.textContent = '请输入分支名';
        hint.classList.add('error');
        return;
      }
      const done = await this.runOp(op, [...this.selected], branch, this.el('branchCheckout').checked);
      if (done) this.closeForm();
    }

    // Run one operation over some repos and show each one's outcome on its row.
    // Returns false when the request itself was refused (a bad name), so the
    // form stays open for a correction.
    async runOp(op, names, branch, checkout = true) {
      const submit = this.el('branchFormSubmit');
      submit.disabled = true;
      submit.textContent = '处理中...';
      const was = new Map();
      for (const name of names) {
        const ref = this.refFor(name);
        if (!ref) continue;
        was.set(ref, [ref.textContent, ref.className]);
        ref.textContent = '处理中...';
        ref.className = 'branch-ref';
      }

      let status = 0;
      let data;
      try {
        ({ status, data } = await this.post('/api/git/' + op, { names, branch, checkout }));
      } catch (error) {
        data = { error: error.message };
      } finally {
        submit.disabled = false;
        submit.textContent = '确认';
      }

      if (!data.results) {
        for (const [ref, [text, cls]] of was) { ref.textContent = text; ref.className = cls; }
        const hint = this.el('branchFormHint');
        hint.textContent = data.reason === 'invalid-name' ? '分支名不合法' : '操作失败：' + (data.error || 'HTTP ' + status);
        hint.classList.add('error');
        return false;
      }

      const until = Date.now() + 6000;
      for (const r of data.results) {
        if (r.ok) {
          const ref = this.refFor(r.name);
          if (!ref) continue;
          ref.textContent = r.reason === 'already' ? '已是该分支' : (op === 'create' ? '已新建 ' : '→ ') + branch;
          ref.className = 'branch-ref pull-ok';
        } else {
          const why = BranchPanel.REASONS[r.reason] || '失败';
          this.notes.set(r.name, { text: why, title: r.message || why, until });
          this.applyNote(r.name, this.refFor(r.name));
        }
      }
      // Branches moved: reload so the panel shows what is true now. Failure
      // notes are re-applied to the fresh rows until they expire.
      setTimeout(() => this.load(), 1500);
      return true;
    }

    refFor(name) {
      const row = [...this.el('branchList').querySelectorAll('.branch-row')].find((r) => r.dataset.repo === name);
      return row ? row.querySelector('.branch-ref') : null;
    }

    // Show a pending failure note on a row, then put the branch name back when
    // the note expires.
    applyNote(name, ref) {
      const note = this.notes.get(name);
      if (!note || !ref) return;
      const left = note.until - Date.now();
      if (left <= 0) { this.notes.delete(name); return; }
      const wasText = ref.textContent;
      const wasClass = ref.className;
      const wasTitle = ref.title;
      ref.textContent = note.text;
      ref.className = 'branch-ref pull-bad';
      ref.title = note.title;
      setTimeout(() => {
        if (this.notes.get(name) === note) this.notes.delete(name);
        if (ref.classList.contains('pull-bad')) {
          ref.textContent = wasText;
          ref.className = wasClass;
          ref.title = wasTitle;
        }
      }, left);
    }

    badge(text, cls, title) {
      const s = document.createElement('span');
      s.className = 'branch-badge ' + cls;
      s.textContent = text;
      s.title = title;
      return s;
    }
  }

  BranchPanel.REASONS = {
    'not-found': '分支不存在',
    'would-overwrite': '会覆盖未提交改动',
    exists: '分支已存在',
    'invalid-name': '分支名不合法',
    detached: '游离 HEAD 无法改名',
    'not-a-repo': '不是仓库',
    forbidden: '无权访问',
    failed: '失败',
  };

  window.branchPanel = new BranchPanel();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => window.branchPanel.bind());
  } else {
    window.branchPanel.bind();
  }
})();
