// spaces.js — the spaces sidebar: 空间 (named working-directory groups) with
// 任务 (the session tabs) nested under each.
//
// Division of labour with session-manager.js is deliberate: the tab manager
// stays the single owner of the .session-tab rows — marks, rename, drag,
// context menu, keyboard shortcuts all keep working where they always lived —
// and this module owns everything AROUND them: the space groups they sit in,
// the 未分组 pseudo-group at the bottom, the header breadcrumb, the narrow-
// screen drawer and the space CRUD (rename / delete / create-a-task-here).
//
// Spaces come from the server (GET /api/spaces, persisted in spaces.json) so
// every device sees the same groups; a session's group comes with its row in
// GET /api/sessions/list (spaceId), so a tab opened on one device lands in the
// right space on another. Which groups are expanded stays in this browser's
// localStorage — like tab order (TAB-10), that is a per-device view thing.

class SpacesSidebar {
    constructor(claudeInterface) {
        this.app = claudeInterface;
        this.spaces = [];
        // sessionId → spaceId (null = 未分组). Filled from /api/sessions/list
        // rows, create responses and PATCH moves — one index every call site
        // shares, so addTab callers never have to know about spaces.
        this.sessionSpaces = new Map();
        this.expanded = this.loadExpanded();
        this.setupDom();
    }

    // ---- persistence of the per-device bits (expanded groups) -------------

    static STATE_KEY = 'cc-web-sidebar-state';

    loadExpanded() {
        try {
            const raw = JSON.parse(localStorage.getItem(SpacesSidebar.STATE_KEY) || '{}');
            return new Set(Array.isArray(raw.expanded) ? raw.expanded : []);
        } catch (_) {
            return new Set(); // TAB-25's rule: no localStorage, no crash
        }
    }

    saveExpanded() {
        try {
            localStorage.setItem(SpacesSidebar.STATE_KEY, JSON.stringify({ expanded: [...this.expanded] }));
        } catch (_) { /* ignore */ }
    }

    // ---- data -----------------------------------------------------------

    async load() {
        const [spacesRes, sessionsRes] = await Promise.all([
            this.app.authFetch('/api/spaces'),
            this.app.authFetch('/api/sessions/list'),
        ]);
        if (spacesRes && spacesRes.ok) {
            const data = await spacesRes.json();
            this.spaces = Array.isArray(data.spaces) ? data.spaces : [];
        }
        if (sessionsRes && sessionsRes.ok) {
            const data = await sessionsRes.json();
            this.sessionSpaces.clear();
            (data.sessions || []).forEach(s => this.sessionSpaces.set(s.id, s.spaceId || null));
        }
        this.render();
    }

    async reloadSpaces() {
        const res = await this.app.authFetch('/api/spaces');
        if (res && res.ok) {
            const data = await res.json();
            this.spaces = Array.isArray(data.spaces) ? data.spaces : [];
            // A deleted space leaves sessions pointing at a ghost; fold them
            // back into 未分组 so they never disappear from the sidebar.
            const live = new Set(this.spaces.map(s => s.id));
            for (const [sessionId, spaceId] of this.sessionSpaces) {
                if (spaceId && !live.has(spaceId)) this.sessionSpaces.set(sessionId, null);
            }
            this.render();
        }
    }

    spaceById(id) {
        return this.spaces.find(s => s.id === id) || null;
    }

    sessionSpace(sessionId) {
        const id = this.sessionSpaces.get(sessionId) || null;
        return (id && this.spaceById(id)) ? id : null;
    }

    // A freshly created / moved session announces its group here (create
    // response, WS session_created, PATCH move) — one index, every entry point.
    noteSession(sessionId, spaceId) {
        this.sessionSpaces.set(sessionId, spaceId || null);
    }

    // The tab manager drops a closed session from the index; its group's
    // 未分组 visibility may change with it.
    forgetSession(sessionId) {
        this.sessionSpaces.delete(sessionId);
        this.updateUngroupedVisibility();
        this.updateBreadcrumb();
    }

    // "task N": one more than the highest N already used in this space, so
    // closing task 2 of three and adding another does not collide with task 3.
    nextTaskName(spaceId) {
        let max = 0;
        const tabs = this.app.sessionTabManager;
        for (const [sessionId, session] of tabs.activeSessions) {
            if (this.sessionSpace(sessionId) !== spaceId) continue;
            const m = /^task (\d+)$/.exec(session.name || '');
            if (m) max = Math.max(max, parseInt(m[1], 10));
        }
        return `task ${max + 1}`;
    }

    // ---- DOM ------------------------------------------------------------

    setupDom() {
        const toggle = document.getElementById('sidebarToggleBtn');
        toggle?.addEventListener('click', () => this.toggleDrawer());

        const collapse = document.getElementById('sidebarCollapseBtn');
        collapse?.addEventListener('click', () => {
            document.body.classList.add('sidebar-hidden');
            // Returning needs a control that is not inside the thing that
            // disappeared — the header toggle serves for both widths.
        });

        document.getElementById('sidebarBackdrop')?.addEventListener('click', () => this.closeDrawer());
        document.getElementById('newSpaceBtn')?.addEventListener('click', () => this.openNewSpaceDialog());
        document.getElementById('newSpaceBrowseBtn')?.addEventListener('click', () => this.toggleNewSpaceBrowser());
        document.getElementById('newSpaceUpBtn')?.addEventListener('click', () => this.nsUp());
        document.getElementById('newSpacePickBtn')?.addEventListener('click', () => this.nsPick());
        document.getElementById('newSpaceHiddenToggle')?.addEventListener('change', () => {
            if (this._nsPath) this.nsBrowse(this._nsPath);
        });
    }

    // The folder picker inside #newSpaceModal: the same /api/folders data and
    // the same .folder-item rows as the new-tab dialog's browser (so it reads
    // as one control in two places), with its own state so the two never
    // fight over currentFolderPath. Click a row = enter it; 选定此目录 fills
    // the dir input.
    toggleNewSpaceBrowser() {
        const box = document.getElementById('newSpaceBrowser');
        if (!box) return;
        const opening = box.hidden;
        box.hidden = !opening;
        if (opening) {
            const typed = document.getElementById('newSpaceDir').value.trim();
            // No path → the server answers with its base folder, same as the
            // new-tab dialog's 回到起始目录.
            this.nsBrowse(typed || null);
        }
    }

    async nsBrowse(path) {
        const list = document.getElementById('newSpaceList');
        if (!list) return;
        const hidden = document.getElementById('newSpaceHiddenToggle')?.checked;
        const params = new URLSearchParams();
        if (path) params.append('path', path);
        if (hidden) params.append('showHidden', 'true');
        list.innerHTML = '<div class="nsb-empty">加载中…</div>';
        try {
            const res = await this.app.authFetch(`/api/folders?${params}`);
            if (!res || !res.ok) {
                if (res && res.status === 401 && window.authManager) { window.authManager.showLoginPrompt(); return; }
                list.innerHTML = '<div class="nsb-empty">无法打开这个目录</div>';
                return;
            }
            const data = await res.json();
            this._nsPath = data.currentPath;
            document.getElementById('newSpaceUpBtn').disabled = !data.parentPath;
            this.renderNsCrumbs(data.currentPath);
            const pickBtn = document.getElementById('newSpacePickBtn');
            if (pickBtn) pickBtn.title = data.currentPath;

            list.innerHTML = '';
            if (!data.folders || data.folders.length === 0) {
                // An empty folder is a perfectly good project dir — say so,
                // or "empty" reads as "wrong place".
                list.innerHTML = '<div class="nsb-empty">这个目录是空的。如果它就是你要绑定的目录，直接点「选定此目录」。</div>';
                return;
            }
            data.folders.forEach(folder => {
                const row = document.createElement('div');
                row.className = 'folder-item';
                row.title = folder.path;
                row.innerHTML = `
                    <svg class="folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                    </svg>
                    <span class="folder-name">${escapeHtml(folder.name)}</span>
                    ${folder.isSymlink ? '<span class="folder-symlink" title="Symbolic link">↗</span>' : ''}
                `;
                row.addEventListener('click', () => this.nsBrowse(folder.path));
                list.appendChild(row);
            });
        } catch (error) {
            list.innerHTML = '<div class="nsb-empty">无法打开这个目录</div>';
        }
    }

    // The breadcrumb: every segment is a jump, the last one is where you are.
    // A scrollable strip rather than middle-truncation — the tail (the part
    // that differs between sibling projects) stays visible, same reasoning as
    // the new-tab dialog's path bar.
    renderNsCrumbs(path) {
        const box = document.getElementById('newSpaceCrumbs');
        if (!box) return;
        box.innerHTML = '';
        const parts = String(path || '').split('/').filter(Boolean);

        const seg = (label, target, current) => {
            const el = document.createElement('button');
            el.type = 'button';
            el.className = 'crumb' + (current ? ' current' : '');
            el.textContent = label;
            el.title = target;
            el.addEventListener('click', () => this.nsBrowse(target));
            return el;
        };

        box.appendChild(seg('/', '/', parts.length === 0));
        let acc = '';
        parts.forEach((name, i) => {
            acc += '/' + name;
            const sep = document.createElement('span');
            sep.className = 'crumb-sep';
            sep.textContent = '/';
            box.appendChild(sep);
            box.appendChild(seg(name, acc, i === parts.length - 1));
        });
        box.scrollLeft = box.scrollWidth;
    }

    async nsUp() {
        if (!this._nsPath) return;
        const parent = this._nsPath.split('/').slice(0, -1).join('/') || '/';
        await this.nsBrowse(parent);
    }

    nsPick() {
        if (!this._nsPath) return;
        document.getElementById('newSpaceDir').value = this._nsPath;
        const nameInput = document.getElementById('newSpaceName');
        if (!nameInput.value.trim()) {
            nameInput.value = this._nsPath.split('/').pop() || this._nsPath;
        }
        document.getElementById('newSpaceBrowser').hidden = true;
        this.setNewSpaceError(null);
        document.getElementById('newSpaceName').focus();
    }

    // ---- new space dialog (#newSpaceModal) --------------------------------
    //
    // Name + working directory. The recent dirs (the new-tab dialog's own
    // list, cc-web-recent-dirs) are offered as one-tap fills; the path itself
    // is validated server-side on create — a 403 names the real reason, which
    // beats re-implementing the folder browser a second time for a field most
    // often filled by paste or recents anyway.

    openNewSpaceDialog() {
        const modal = document.getElementById('newSpaceModal');
        if (!modal) return;
        this.closeDrawer();
        document.getElementById('newSpaceName').value = '';
        document.getElementById('newSpaceDir').value = '';
        this.setNewSpaceError(null);
        // Folder picker: fresh state per open.
        this._nsPath = null;
        const browser = document.getElementById('newSpaceBrowser');
        if (browser) browser.hidden = true;
        const listEl = document.getElementById('newSpaceList');
        if (listEl) listEl.innerHTML = '';
        const crumbsEl = document.getElementById('newSpaceCrumbs');
        if (crumbsEl) crumbsEl.innerHTML = '';
        const hiddenToggle = document.getElementById('newSpaceHiddenToggle');
        if (hiddenToggle) hiddenToggle.checked = false;
        this.renderNewSpaceRecents();
        modal.classList.add('active');

        const close = () => this.closeNewSpaceDialog();
        const cancel = document.getElementById('newSpaceCancelBtn');
        const closeX = document.getElementById('newSpaceCloseX');
        const create = document.getElementById('newSpaceCreateBtn');
        const name = document.getElementById('newSpaceName');
        const dir = document.getElementById('newSpaceDir');
        // Rebind per open: the listeners below read the current input values.
        create.onclick = () => this.submitNewSpace();
        cancel.onclick = close;
        closeX.onclick = close;
        name.onkeydown = dir.onkeydown = (e) => {
            if (e.key === 'Enter') { e.preventDefault(); this.submitNewSpace(); }
            if (e.key === 'Escape') close();
        };
        modal.onmousedown = (e) => { if (e.target === modal) close(); };
        setTimeout(() => name.focus(), 0);
    }

    closeNewSpaceDialog() {
        document.getElementById('newSpaceModal')?.classList.remove('active');
    }

    setNewSpaceError(message) {
        const el = document.getElementById('newSpaceError');
        if (!el) return;
        el.hidden = !message;
        el.textContent = message || '';
    }

    renderNewSpaceRecents() {
        const box = document.getElementById('newSpaceRecents');
        if (!box) return;
        const dirs = (this.app.newTabRecentDirs ? this.app.newTabRecentDirs() : [])
            .filter(d => !this.spaces.some(s => s.dir === d));
        box.innerHTML = '';
        if (dirs.length === 0) return;
        dirs.forEach(dir => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'new-space-recent-chip';
            chip.textContent = dir.split('/').pop() || dir;
            chip.title = dir;
            chip.onclick = () => {
                document.getElementById('newSpaceDir').value = dir;
                const nameInput = document.getElementById('newSpaceName');
                // A dir you have worked in before probably names the space
                // for you; typing over it is one keystroke, not a punishment.
                if (!nameInput.value.trim()) nameInput.value = dir.split('/').pop() || dir;
            };
            box.appendChild(chip);
        });
    }

    async submitNewSpace() {
        const nameInput = document.getElementById('newSpaceName');
        const dirInput = document.getElementById('newSpaceDir');
        const dir = dirInput.value.trim();
        const name = nameInput.value.trim() || (dir ? (dir.split('/').pop() || dir) : '');
        this.setNewSpaceError(null);
        if (!dir) {
            this.setNewSpaceError('请填写工作目录。');
            dirInput.focus();
            return;
        }
        if (this.spaces.some(s => s.dir === dir)) {
            this.setNewSpaceError('这个目录已经是另一个空间的工作目录。');
            dirInput.focus();
            return;
        }
        const btn = document.getElementById('newSpaceCreateBtn');
        btn.disabled = true;
        try {
            const res = await this.app.authFetch('/api/spaces', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, dir })
            });
            if (!res || !res.ok) {
                const data = res ? await res.json().catch(() => ({})) : {};
                this.setNewSpaceError(data.message || data.error || '创建空间失败，请检查目录路径。');
                return;
            }
            this.closeNewSpaceDialog();
            await this.reloadSpaces();
            if (this.app.showToast) this.app.showToast(`空间「${name}」已创建`);
        } catch (error) {
            this.setNewSpaceError('创建空间失败，请检查连接后重试。');
        } finally {
            btn.disabled = false;
        }
    }

    isNarrow() {
        return window.innerWidth <= 768;
    }

    toggleDrawer() {
        const sidebar = document.getElementById('spacesSidebar');
        if (!sidebar) return;
        if (document.body.classList.contains('sidebar-hidden')) {
            // The header toggle is also how a hidden sidebar comes back.
            document.body.classList.remove('sidebar-hidden');
            return;
        }
        if (!this.isNarrow()) return;
        const opening = !sidebar.classList.contains('drawer-open');
        sidebar.classList.toggle('drawer-open', opening);
        const backdrop = document.getElementById('sidebarBackdrop');
        if (backdrop) backdrop.hidden = !opening;
    }

    closeDrawer() {
        const sidebar = document.getElementById('spacesSidebar');
        sidebar?.classList.remove('drawer-open');
        const backdrop = document.getElementById('sidebarBackdrop');
        if (backdrop) backdrop.hidden = true;
    }

    tree() {
        return document.getElementById('spacesTree');
    }

    // The container a session tab is appended to. Unknown space ids (a space
    // deleted since this device last synced) resolve to 未分组, never to null —
    // a task must always have somewhere to live.
    getTaskContainer(spaceId) {
        const tree = this.tree();
        if (!tree) return null;
        const effective = (spaceId && this.spaceById(spaceId)) ? spaceId : '';
        let container = tree.querySelector(`.space-tasks[data-space="${cssEscape(effective)}"]`);
        if (!container) {
            const group = this.buildGroup(effective === '' ? null : this.spaceById(effective));
            tree.appendChild(group);
            container = group.querySelector('.space-tasks');
        }
        return container;
    }

    // Rebuild the group shells. The .session-tab rows are NOT rebuilt — they
    // belong to session-manager; render() only re-parents them into the right
    // group, in their existing relative order.
    render() {
        const tree = this.tree();
        if (!tree) return;

        const wanted = [...this.spaces];
        const existing = new Map(
            [...tree.querySelectorAll('.space-group')].map(g => [g.dataset.space || '', g])
        );

        // Server order for groups; 未分组 always last; drop groups for spaces
        // the server no longer lists (their tabs re-parent to 未分组 below).
        const ordered = wanted.map(s => s.id);
        for (const id of ordered) {
            let group = existing.get(id);
            if (!group) {
                group = this.buildGroup(this.spaceById(id));
            } else {
                this.refreshGroupHead(group, this.spaceById(id));
            }
            tree.appendChild(group); // moves, never destroys, the tasks inside
        }
        const ungrouped = existing.get('') || this.buildGroup(null);
        tree.appendChild(ungrouped);

        // Remove stale groups (deleted spaces); their tabs move into 未分组.
        for (const [id, group] of existing) {
            if (id === '' || ordered.includes(id)) continue;
            group.remove();
        }

        // Re-parent every live tab into its group, preserving DOM order.
        const tabs = this.app.sessionTabManager;
        if (tabs) {
            for (const tab of tabs.getOrderedTabElements()) {
                const sid = tab.dataset.sessionId;
                const container = this.getTaskContainer(sid ? this.sessionSpace(sid) : null);
                if (container && tab.parentElement !== container) container.appendChild(tab);
            }
        }

        this.updateUngroupedVisibility();
        this.updateBreadcrumb();
    }

    buildGroup(space) {
        const group = document.createElement('div');
        group.className = 'space-group';
        group.dataset.space = space ? space.id : '';

        const head = document.createElement('div');
        head.className = 'space-head';
        this.fillGroupHead(head, space);
        group.appendChild(head);

        const tasks = document.createElement('div');
        tasks.className = 'space-tasks';
        tasks.dataset.space = space ? space.id : '';
        // session-manager owns the rows; it also owns the drag handlers, which
        // it attaches per container (attachTaskContainerDnd).
        if (this.app.sessionTabManager?.attachTaskContainerDnd) {
            this.app.sessionTabManager.attachTaskContainerDnd(tasks);
        }
        group.appendChild(tasks);

        this.applyCollapsed(group);
        return group;
    }

    refreshGroupHead(group, space) {
        const head = group.querySelector('.space-head');
        if (head) this.fillGroupHead(head, space);
        this.applyCollapsed(group);
    }

    fillGroupHead(head, space) {
        const id = space ? space.id : '';
        head.innerHTML = `
            <span class="space-chevron" aria-hidden="true">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="9 18 15 12 9 6"/>
                </svg>
            </span>
            <span class="space-name" title="${space ? escapeHtml(space.dir) : '不属于任何空间的任务'}">${space ? escapeHtml(space.name) : '未分组'}</span>
            <span class="space-dir" title="${space ? escapeHtml(space.dir) : ''}">${space ? escapeHtml(space.dir) : ''}</span>
            <span class="space-actions">
                <button class="space-action space-add-task" title="在这个空间新建任务">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                        <line x1="12" y1="5" x2="12" y2="19"/>
                        <line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                </button>
                ${space ? `
                <button class="space-action space-delete" title="删除空间（任务保留，转入未分组）">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                        <line x1="18" y1="6" x2="6" y2="18"/>
                        <line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                </button>` : ''}
            </span>
        `;

        // Chevron / body click: collapse & expand. Not on the name (double
        // click there renames) and not on the action buttons.
        head.addEventListener('click', (e) => {
            if (e.target.closest('.space-action') || e.target.closest('.space-name-input')) return;
            if (e.target.closest('.space-name')) return;
            this.toggleCollapsed(id);
        });
        head.addEventListener('dblclick', (e) => {
            if (!space) return;
            if (!e.target.closest('.space-name')) return;
            this.renameSpace(space, head);
        });

        head.querySelector('.space-add-task')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.closeDrawer();
            if (this.app.openNewTabDialog) this.app.openNewTabDialog({ space: space || null });
        });
        head.querySelector('.space-delete')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.deleteSpace(space);
        });
    }

    applyCollapsed(group) {
        const id = group.dataset.space || '';
        // 未分组 is never collapsed away — it is the fallback every task lands
        // in; hiding it could look like tasks vanished.
        if (id === '') return;
        const collapsed = !this.expanded.has(id) && this.hasEverRendered(id);
        // First render: spaces start expanded (an all-collapsed sidebar on
        // upgrade day reads as "my tasks are gone"). After a manual collapse
        // the id leaves `expanded` and gains a marker in localStorage.
        group.classList.toggle('collapsed', !this.expanded.has(id) && this.knownCollapsed(id));
    }

    hasEverRendered() { return this._rendered; }
    knownCollapsed(id) {
        try {
            const raw = JSON.parse(localStorage.getItem(SpacesSidebar.STATE_KEY) || '{}');
            return Array.isArray(raw.collapsed) && raw.collapsed.includes(id);
        } catch (_) { return false; }
    }

    toggleCollapsed(id) {
        if (!id) return;
        const group = this.tree()?.querySelector(`.space-group[data-space="${cssEscape(id)}"]`);
        const willCollapse = !this.expanded.has(id);
        if (willCollapse) this.expanded.delete(id); else this.expanded.add(id);
        group?.classList.toggle('collapsed', willCollapse);
        try {
            const raw = JSON.parse(localStorage.getItem(SpacesSidebar.STATE_KEY) || '{}');
            const collapsed = new Set(Array.isArray(raw.collapsed) ? raw.collapsed : []);
            if (willCollapse) collapsed.add(id); else collapsed.delete(id);
            raw.collapsed = [...collapsed];
            raw.expanded = [...this.expanded];
            localStorage.setItem(SpacesSidebar.STATE_KEY, JSON.stringify(raw));
        } catch (_) { /* ignore */ }
    }

    renameSpace(space, head) {
        const nameSpan = head.querySelector('.space-name');
        const currentName = space.name;
        const input = document.createElement('input');
        input.type = 'text';
        input.value = currentName;
        input.className = 'space-name-input';
        nameSpan.replaceWith(input);
        input.focus();
        input.select();

        // The same double-save guard as renameTab: replacing a focused input
        // fires blur and the second save would hit a detached node.
        let saved = false;
        const save = () => {
            if (saved) return;
            saved = true;
            const name = input.value.trim() || currentName;
            const span = document.createElement('span');
            span.className = 'space-name';
            span.textContent = name;
            input.replaceWith(span);
            if (name === currentName) return;
            this.app.authFetch(`/api/spaces/${encodeURIComponent(space.id)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            }).then(res => {
                if (res && res.ok) {
                    space.name = name;
                    span.textContent = name;
                    this.updateBreadcrumb();
                } else {
                    span.textContent = currentName;
                    if (this.app.showToast) this.app.showToast('空间改名失败', true);
                }
            }).catch(() => {
                span.textContent = currentName;
                if (this.app.showToast) this.app.showToast('空间改名失败', true);
            });
        };
        input.addEventListener('blur', save);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') save();
            else if (e.key === 'Escape') { input.value = currentName; save(); }
        });
    }

    async deleteSpace(space) {
        const count = this.countTasks(space.id);
        const ok = await this.app.confirmDialog({
            title: '删除空间',
            body: `删除空间「${space.name}」？其中的 ${count} 个任务会保留，转入「未分组」。`,
            confirmText: '删除空间',
            danger: true,
        });
        if (!ok) return;
        const res = await this.app.authFetch(`/api/spaces/${encodeURIComponent(space.id)}`, { method: 'DELETE' });
        if (!res || !res.ok) {
            if (this.app.showToast) this.app.showToast('删除空间失败', true);
            return;
        }
        await this.reloadSpaces();
        if (this.app.showToast) this.app.showToast(`空间已删除，${count} 个任务转入未分组`);
    }

    countTasks(spaceId) {
        const tabs = this.app.sessionTabManager;
        if (!tabs) return 0;
        let n = 0;
        for (const sessionId of tabs.tabs.keys()) {
            if (this.sessionSpace(sessionId) === spaceId) n++;
        }
        return n;
    }

    updateUngroupedVisibility() {
        const tree = this.tree();
        if (!tree) return;
        const ungrouped = tree.querySelector('.space-group[data-space=""]');
        if (!ungrouped) return;
        const has = ungrouped.querySelector('.session-tab') !== null;
        const spacesExist = this.spaces.length > 0;
        // Hidden when empty AND real spaces exist; when there are no spaces at
        // all the sidebar would otherwise be blank, so show it (tasks + the
        // 新建空间 button) instead.
        ungrouped.classList.toggle('hidden-group', !has && spacesExist);
    }

    // ---- breadcrumb -----------------------------------------------------

    // The header's 空间 · 任务 · 目录 line. One writer, called on tab switches
    // and status changes (the same discipline as app.updatePageTitle).
    updateBreadcrumb() {
        const tabs = this.app.sessionTabManager;
        const crumbSpace = document.getElementById('crumbSpace');
        const crumbTask = document.getElementById('crumbTask');
        const crumbDir = document.getElementById('crumbDir');
        const breadcrumb = document.getElementById('headerBreadcrumb');
        if (!breadcrumb || !tabs) return;

        const sessionId = tabs.activeTabId;
        const session = sessionId ? tabs.activeSessions.get(sessionId) : null;
        const tab = sessionId ? tabs.tabs.get(sessionId) : null;

        if (!session) {
            breadcrumb.classList.add('empty');
            return;
        }
        breadcrumb.classList.remove('empty');

        const spaceId = this.sessionSpace(sessionId);
        const space = spaceId ? this.spaceById(spaceId) : null;
        if (crumbSpace) {
            crumbSpace.textContent = space ? space.name : '未分组';
            crumbSpace.title = space ? `${space.name} · ${space.dir}` : '未分组';
            crumbSpace.classList.toggle('ungrouped', !space);
        }
        if (crumbTask) {
            const nameEl = tab?.querySelector('.tab-name');
            crumbTask.textContent = (nameEl && nameEl.textContent) || session.name || '';
            crumbTask.title = nameEl?.title || '';
        }
        if (crumbDir) {
            crumbDir.textContent = session.workingDir || '';
            crumbDir.title = session.workingDir || '';
        }

        // The status dot mirrors the active tab's own dot (working / done /
        // awaiting marks included) — one source of truth, copied.
        const dot = breadcrumb.querySelector('.crumb-dot');
        if (dot && tab) {
            const source = tab.querySelector('.tab-status');
            if (source) dot.className = `crumb-dot ${source.className.replace('tab-status', '').trim()}`;
            ['data-working', 'data-done', 'data-awaiting'].forEach(attr => {
                if (tab.hasAttribute(attr)) dot.setAttribute(attr, ''); else dot.removeAttribute(attr);
            });
        }
    }

    // Called by session-manager on every tab switch: expand the space the task
    // lives in (a task reached by Alt+N in a collapsed space must show), close
    // the drawer on narrow screens, refresh the breadcrumb.
    setActive(sessionId) {
        const spaceId = this.sessionSpace(sessionId);
        if (spaceId && !this.expanded.has(spaceId) && this.knownCollapsed(spaceId)) {
            this.toggleCollapsed(spaceId); // expand
        }
        if (this.isNarrow()) this.closeDrawer();
        this.updateBreadcrumb();
    }

    // Moving a task between spaces (context menu → 移动到空间…).
    async moveSession(sessionId, spaceId) {
        const res = await this.app.authFetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ spaceId: spaceId || null })
        });
        if (!res || !res.ok) {
            if (this.app.showToast) this.app.showToast('移动任务失败', true);
            return;
        }
        this.noteSession(sessionId, spaceId || null);
        this.render();
        const space = spaceId ? this.spaceById(spaceId) : null;
        if (this.app.showToast) this.app.showToast(spaceId ? `已移入「${space ? space.name : ''}」` : '已移入未分组');
    }

    // Where Ctrl+T / the header + create: the space of the active task, so a
    // new task joins what you are looking at.
    activeSpaceContext() {
        const tabs = this.app.sessionTabManager;
        if (!tabs || !tabs.activeTabId) return null;
        const id = this.sessionSpace(tabs.activeTabId);
        return id ? this.spaceById(id) : null;
    }
}

// attribute-value escape for the [data-space="…"] selectors (space ids are
// uuids today, but the selector must not rot the day they are not).
function cssEscape(value) {
    return String(value).replace(/["\\]/g, '\\$&');
}

function escapeHtml(text) {
    return String(text)
        .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

window.SpacesSidebar = SpacesSidebar;
