// Sessions and conversations, in one panel.
//
// Two things used to be listed in two places that could never agree: the menu's
// Sessions modal listed cc-web sessions (the tabs, including ones that have
// never started Claude), while the toolbar listed Claude's recorded
// conversations for the folder. A session with no transcript appeared only in
// the first; a closed conversation only in the second. Both entry points now
// render THIS panel, so the two lists are the same list:
//
//   Sessions      — every cc-web session (what the tabs are). Click to switch,
//                   or open it as a tab if it isn't one. Trash deletes it.
//   Conversations — Claude conversations recorded for the folder that no session
//                   holds. Click to open one in a new tab, resumed.
//
// Resuming is `POST /api/sessions/create {resumeId}`: the new session takes the
// conversation's uuid as its own id, so everything said from then on is appended
// to that same transcript, across restarts too. One conversation can only be
// open in one tab — two Claude processes on one transcript would corrupt it —
// which is why a conversation a session already holds is listed under Sessions
// instead, and why the server refuses the second attempt.
//
// The New Session modal's "Continue previous" picker uses renderPicker: the same
// rows, minus the actions, with a click meaning "select".

(function () {
  const ICONS = {
    chat: '<svg class="conv-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/></svg>',
    terminal: '<svg class="conv-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3"/><path d="M13 15h4"/></svg>',
    // Two explicit actions per session row. The switch action was originally
    // only the row's own click; it is a button as well because "click the row"
    // is invisible — nothing on screen says the row is a control.
    enter: '<svg class="conv-act-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13"/><path d="M12 5l7 7-7 7"/></svg>',
    trash: '<svg class="conv-act-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
  };

  // Parse each icon once; rows clone the node.
  const nodes = {};
  for (const [key, svg] of Object.entries(ICONS)) {
    const t = document.createElement('template');
    t.innerHTML = svg;
    nodes[key] = t.content.firstElementChild;
  }
  const icon = (key) => nodes[key].cloneNode(true);

  const toast = (msg, err) => { try { window.app && window.app.showToast(msg, err); } catch (_) {} };

  // "3m ago" — these lists are read by recency, and a full timestamp on every
  // row is noise at that job.
  function relativeTime(iso) {
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return '';
    const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (secs < 60) return 'just now';
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(then).toLocaleDateString();
  }

  const folderName = (dir) => (dir ? dir.split('/').filter(Boolean).pop() || '/' : '');

  class SessionsPanel {
    constructor() {
      this.bound = false;
      this.modalDir = null;
    }

    el(id) { return document.getElementById(id); }

    async get(url) {
      const app = window.app;
      if (!app) throw new Error('app not ready');
      const res = await app.authFetch(url);
      if (!res.ok) throw new Error(`${url} -> ${res.status}`);
      return res.json();
    }

    fetchSessions() {
      return this.get('/api/sessions/list').then(d => d.sessions || []);
    }

    fetchConversations(dir) {
      const url = `/api/claude-sessions${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`;
      return this.get(url).then(d => d.conversations || []);
    }

    // ── The full panel: sessions first, then the folder's unopened conversations.
    async renderPanel(container, { dir } = {}) {
      if (!container) return;
      this.busy(container, 'Loading sessions…');

      let sessions = [];
      let conversations = [];
      try {
        [sessions, conversations] = await Promise.all([
          this.fetchSessions(),
          this.fetchConversations(dir).catch(() => []) // history is the optional half
        ]);
      } catch (err) {
        console.warn('[sessions] list failed:', err);
        this.busy(container, 'Could not load sessions.');
        return;
      }

      container.textContent = '';
      const app = window.app;
      const tabs = (app && app.sessionTabManager && app.sessionTabManager.tabs) || new Map();
      const activeId = (app && app.sessionTabManager && app.sessionTabManager.activeTabId) || null;

      container.appendChild(this.groupHeader('Sessions', sessions.length));
      if (!sessions.length) {
        container.appendChild(this.note('No sessions yet.'));
      } else {
        for (const session of sessions) {
          container.appendChild(this.sessionRow(session, {
            isTab: tabs.has(session.id),
            isActive: session.id === activeId,
            dir
          }));
        }
      }

      // Only conversations no session holds: the rest are above, where they can
      // be switched to rather than opened a second time.
      const free = conversations.filter(c => !c.openInTab);
      container.appendChild(this.groupHeader('Conversations in this folder', free.length));
      if (!free.length) {
        container.appendChild(this.note(conversations.length
          ? 'Every conversation here is already open.'
          : 'No previous conversations in this folder.'));
        return;
      }
      for (const conv of free) {
        container.appendChild(this.conversationRow(conv, { onPick: () => this.resume(conv, dir) }));
      }
    }

    // ── The New Session modal's picker: history only, click = select.
    async renderPicker(container, { dir, onPick } = {}) {
      if (!container) return;
      this.busy(container, 'Loading conversations…');

      let conversations;
      try {
        conversations = await this.fetchConversations(dir);
      } catch (err) {
        console.warn('[conversations] list failed:', err);
        this.busy(container, 'Could not read Claude\'s conversation history.');
        return;
      }

      container.textContent = '';
      if (!conversations.length) {
        container.appendChild(this.note('No previous conversations in this folder.'));
        return;
      }
      for (const conv of conversations) {
        container.appendChild(this.conversationRow(conv, { onPick, selectable: true, container }));
      }
    }

    busy(container, text) {
      container.textContent = '';
      container.appendChild(this.note(text));
    }

    note(text) {
      const el = document.createElement('div');
      el.className = 'conv-empty';
      el.textContent = text;
      return el;
    }

    groupHeader(label, count) {
      const el = document.createElement('div');
      el.className = 'conv-group';
      el.textContent = count ? `${label} (${count})` : label;
      return el;
    }

    // Shared row skeleton: icon, title + meta.
    buildRow(className, { iconKey, title, meta }) {
      const row = document.createElement('div');
      row.className = className;
      row.appendChild(icon(iconKey));

      const main = document.createElement('div');
      main.className = 'conv-main';
      const titleEl = document.createElement('div');
      titleEl.className = 'conv-title';
      // Names and titles come from the user's own sessions and transcripts —
      // textContent, never innerHTML.
      titleEl.textContent = title;
      const metaEl = document.createElement('div');
      metaEl.className = 'conv-meta';
      metaEl.textContent = meta;
      main.appendChild(titleEl);
      main.appendChild(metaEl);
      row.appendChild(main);
      return row;
    }

    sessionRow(session, { isTab, isActive, dir }) {
      const row = this.buildRow('conv-row' + (isActive ? ' current' : ''), {
        iconKey: 'terminal',
        title: session.name || `Session ${session.id.slice(0, 8)}`,
        meta: [
          session.active ? 'running' : 'stopped',
          folderName(session.workingDir),
          isActive ? 'current tab' : (isTab ? 'open in a tab' : 'not open here'),
          session.id.slice(0, 8)
        ].filter(Boolean).join(' · ')
      });

      const dot = document.createElement('span');
      dot.className = 'conv-dot' + (session.active ? ' on' : '');
      row.insertBefore(dot, row.firstChild);

      row.title = isTab ? 'Switch to this session' : 'Open this session in a tab';
      row.addEventListener('click', () => this.openSession(session, isTab, dir));

      const actions = document.createElement('div');
      actions.className = 'conv-actions';

      // Not on the current tab: switching to where you already are is a button
      // that does nothing, and one that looks enabled is worse than none.
      if (!isActive) {
        const go = document.createElement('button');
        go.className = 'conv-act';
        go.title = isTab ? 'Switch to this session' : 'Open this session in a tab';
        go.setAttribute('aria-label', `${go.title}: ${session.name || session.id.slice(0, 8)}`);
        go.appendChild(icon('enter'));
        go.addEventListener('click', (e) => {
          e.stopPropagation(); // the row click means the same thing; don't run it twice
          this.openSession(session, isTab, dir);
        });
        actions.appendChild(go);
      }

      const del = document.createElement('button');
      del.className = 'conv-act';
      del.title = 'Delete session';
      del.setAttribute('aria-label', `Delete session ${session.name || ''}`.trim());
      del.appendChild(icon('trash'));
      del.addEventListener('click', (e) => {
        e.stopPropagation(); // the row itself means "switch"
        this.deleteSession(session);
      });
      actions.appendChild(del);
      row.appendChild(actions);
      return row;
    }

    conversationRow(conv, { onPick, selectable = false, container = null }) {
      const row = this.buildRow('conv-row' + (conv.openInTab ? ' open' : ''), {
        iconKey: 'chat',
        title: conv.title || `Conversation ${conv.id.slice(0, 8)}`,
        meta: [
          relativeTime(conv.updatedAt),
          conv.id.slice(0, 8),
          conv.openInTab ? 'open in a tab' : ''
        ].filter(Boolean).join(' · ')
      });

      if (conv.openInTab) {
        row.title = 'Already open in a tab';
        return row; // not selectable: one conversation, one tab
      }

      row.title = selectable ? 'Continue this conversation' : 'Open this conversation in a new tab';
      row.addEventListener('click', () => {
        if (selectable && container) {
          container.querySelectorAll('.conv-row.selected').forEach(r => r.classList.remove('selected'));
          row.classList.add('selected');
        }
        if (onPick) onPick(conv);
      });
      return row;
    }

    // ── Actions. The app owns tabs and sessions; this only asks.

    async openSession(session, isTab, dir) {
      const app = window.app;
      if (!app) return;
      this.close();
      if (isTab && app.sessionTabManager) {
        await app.sessionTabManager.switchToTab(session.id);
        return;
      }
      // A session with no tab here (another device opened it, or this browser
      // closed the tab without deleting the session) — give it one.
      await app.attachSessionTab(session.id, session.name, session.workingDir || dir);
    }

    async deleteSession(session) {
      const app = window.app;
      if (!app) return;
      if (!confirm(`Delete session "${session.name || session.id.slice(0, 8)}"? This stops any running Claude process.`)) return;
      // Closing the tab is what deletes the session server-side; with no tab
      // here, ask the server directly. Either way the transcript is untouched —
      // the conversation reappears below, ready to be resumed again.
      if (app.sessionTabManager && app.sessionTabManager.tabs.has(session.id)) {
        app.sessionTabManager.closeSession(session.id);
      } else {
        await app.deleteSession(session.id, { skipConfirm: true });
      }
      toast('Session deleted');
      this.reload();
    }

    async resume(conv, dir) {
      const app = window.app;
      if (!app) return;
      this.close();
      const ok = await app.openConversationInTab(conv, dir || this.modalDir);
      if (!ok) this.open(); // refused — put the refreshed list back up
    }

    // ── The toolbar modal.

    bind() {
      if (this.bound) return;
      this.bound = true;
      const modal = this.el('conversationsModal');
      if (!modal) return;
      const close = () => this.close();
      const closeBtn = this.el('closeConversationsBtn');
      if (closeBtn) closeBtn.addEventListener('click', close);
      const doneBtn = this.el('conversationsDoneBtn');
      if (doneBtn) doneBtn.addEventListener('click', close);
      modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
      const refresh = this.el('conversationsRefreshBtn');
      if (refresh) refresh.addEventListener('click', () => this.reload());
      const newBtn = this.el('conversationsNewBtn');
      if (newBtn) newBtn.addEventListener('click', () => {
        this.close();
        if (window.app && window.app.sessionTabManager) window.app.sessionTabManager.createNewSession();
      });
    }

    // Opens on the directory the active session works in (falling back to the
    // selected project folder).
    open() {
      this.bind();
      const app = window.app;
      const dir = (app && (app.currentWorkingDir || app.selectedWorkingDir)) || null;
      this.modalDir = dir;
      const modal = this.el('conversationsModal');
      if (!modal) return;
      const dirEl = this.el('conversationsDir');
      if (dirEl) {
        // The row is right-to-left so a long path truncates at the front (the
        // tail identifies the folder), but the path itself must stay ltr or its
        // leading slash is reordered to the end.
        dirEl.textContent = '';
        const inner = document.createElement('span');
        inner.dir = 'ltr';
        inner.textContent = dir || 'current folder';
        dirEl.appendChild(inner);
      }
      modal.classList.add('active');
      this.reload();
    }

    reload() {
      const modal = this.el('conversationsModal');
      if (modal && modal.classList.contains('active')) {
        this.renderPanel(this.el('conversationsList'), { dir: this.modalDir });
      }
      // The menu's Sessions modal shows the same panel; keep it in step when
      // both happen to be open.
      const mobile = this.el('mobileSessionsModal');
      if (mobile && mobile.classList.contains('active')) {
        this.renderPanel(this.el('mobileSessionList'), { dir: this.modalDir });
      }
    }

    close() {
      const modal = this.el('conversationsModal');
      if (modal) modal.classList.remove('active');
    }
  }

  window.conversationList = new SessionsPanel();
  window.sessionsPanel = window.conversationList;
  document.addEventListener('DOMContentLoaded', () => window.conversationList.bind());
})();
