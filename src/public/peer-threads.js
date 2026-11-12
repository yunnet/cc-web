// Peer threads: tasks handed from one Claude session to another through
// Claude Code's own cross-session messages (SendMessage), as the
// ccweb-companion mod reports them to the server (src/peer-messages.js).
//
// One card per hand-off, the same card on both ends: what was sent, the
// status chain (sent → delivered → held → processing → idle → replied), the
// reply underneath, file:line references clickable. Nothing here approves
// or refuses a message — a held message is answered in the recipient's own
// terminal, and the card only takes you there.
(function () {
  'use strict';

  var CHAIN = [
    ['sent', 'Sent'],
    ['delivered', 'Delivered'],
    ['held', 'Waiting for approval'],
    ['processing', 'Working'],
    ['idle', 'Idle'],
    ['replied', 'Replied'],
  ];
  var ORDER = ['sent', 'delivered', 'held', 'released', 'processing', 'idle', 'replied'];
  var FINAL_LABEL = { denied: 'Refused by the recipient', expired: 'Expired undelivered', failed: 'Not delivered' };
  // Statuses worth telling the sender about.
  var NOTIFY = { held: 'is waiting for approval', idle: 'is idle', replied: 'replied', denied: 'refused the message', expired: 'let the message expire', failed: 'could not be reached' };
  // path.ext:line, absolute (C:\..., /...) or relative (src/x.js).
  var FILE_LINE = /((?:[A-Za-z]:[\\/]|\/)?(?:[\w.@-]+[\\/])*[\w.@-]+\.[A-Za-z0-9]{1,8}):(\d{1,6})/g;

  function PeerThreads(app) {
    this.app = app;
    this.threads = new Map();
    this.unread = new Set();
    this.scope = 'task';
    this.bound = false;
  }

  PeerThreads.prototype.el = function (id) { return document.getElementById(id); };

  PeerThreads.prototype.tabs = function () { return this.app && this.app.sessionTabManager; };

  PeerThreads.prototype.headers = function () {
    return (window.authManager && window.authManager.getAuthHeaders()) || {};
  };

  PeerThreads.prototype.bind = function () {
    if (this.bound) return;
    this.bound = true;
    var self = this;
    var on = function (id, fn) { var e = self.el(id); if (e) e.addEventListener('click', fn); };
    on('peerThreadsBtn', function () { self.open(); });
    on('closePeerThreadsBtn', function () { self.close(); });
    on('peerScopeTask', function () { self.scope = 'task'; self.render(); });
    on('peerScopeAll', function () { self.scope = 'all'; self.render(); });
    on('closeHandoffBtn', function () { self.closeHandoff(); });
    on('cancelHandoffBtn', function () { self.closeHandoff(); });
    on('sendHandoffBtn', function () { self.sendHandoff(); });
    var modal = this.el('peerThreadsModal');
    if (modal) modal.addEventListener('click', function (ev) { if (ev.target === modal) self.close(); });
    var body = this.el('peerThreadsBody');
    if (body) body.addEventListener('click', function (ev) { self.onBodyClick(ev); });
  };

  // Threads already on the server: badges right after a reload.
  PeerThreads.prototype.load = function () {
    var self = this;
    this.bind();
    return fetch('/api/peer-threads', { headers: this.headers() })
      .then(function (r) { return r.ok ? r.json() : { threads: [] }; })
      .then(function (data) {
        (data.threads || []).forEach(function (t) { self.store(t); });
        self.render();
        self.updateBadges();
      })
      .catch(function () { /* nothing to show */ });
  };

  PeerThreads.prototype.store = function (t) {
    var old = this.threads.get(t.id);
    if (old && (old.updatedAt || '') > (t.updatedAt || '')) return old;
    this.threads.set(t.id, t);
    return old || null;
  };

  // hook_event ccweb_peer_thread: every socket of this user gets it, so the
  // same update can arrive several times — only a newer copy counts.
  PeerThreads.prototype.onThread = function (t) {
    if (!t || !t.id) return;
    var known = this.threads.get(t.id);
    if (known && (known.updatedAt || '') >= (t.updatedAt || '')) return;
    var before = known ? known.status : null;
    this.store(t);
    if (t.status !== before && NOTIFY[t.status] && t.fromSessionId) this.notify(t);
    this.render();
    this.updateBadges();
  };

  PeerThreads.prototype.notify = function (t) {
    this.unread.add(t.id);
    var who = t.toName || 'The other task';
    var what = who + ' ' + NOTIFY[t.status];
    var tabs = this.tabs();
    if (document.visibilityState === 'visible') {
      if (this.app && this.app.showToast) this.app.showToast(what, t.status === 'denied' || t.status === 'expired' || t.status === 'failed', 3500);
    } else if (tabs && tabs.sendNotification) {
      // sendNotification skips the active tab; the hand-off is news anyway.
      var keep = tabs.activeTabId;
      tabs.activeTabId = null;
      try { tabs.sendNotification('Hand-off: ' + (t.fromName || 'task'), what, t.fromSessionId); } finally { tabs.activeTabId = keep; }
    }
  };

  // The header button's count, and a mark on each sender's task row.
  PeerThreads.prototype.updateBadges = function () {
    var count = this.unread.size;
    var badge = this.el('peerThreadsBadge');
    if (badge) { badge.textContent = count > 9 ? '9+' : String(count); badge.hidden = count === 0; }
    var marked = {};
    var self = this;
    this.unread.forEach(function (id) { var t = self.threads.get(id); if (t && t.fromSessionId) marked[t.fromSessionId] = true; });
    document.querySelectorAll('.session-tab[data-session-id]').forEach(function (tab) {
      if (marked[tab.dataset.sessionId]) tab.dataset.peer = '';
      else delete tab.dataset.peer;
    });
  };

  PeerThreads.prototype.currentSessionId = function () {
    var tabs = this.tabs();
    return (tabs && tabs.activeTabId) || (this.app && this.app.currentClaudeSessionId) || null;
  };

  PeerThreads.prototype.open = function (scope) {
    this.bind();
    if (scope) this.scope = scope;
    var modal = this.el('peerThreadsModal');
    if (!modal) return;
    modal.classList.add('active');
    this.render();
    this.load();
  };

  PeerThreads.prototype.close = function () {
    var modal = this.el('peerThreadsModal');
    if (modal) modal.classList.remove('active');
  };

  PeerThreads.prototype.isOpen = function () {
    var modal = this.el('peerThreadsModal');
    return !!(modal && modal.classList.contains('active'));
  };

  PeerThreads.prototype.visibleThreads = function () {
    var sid = this.currentSessionId();
    var all = Array.from(this.threads.values());
    if (this.scope === 'task' && sid) all = all.filter(function (t) { return t.fromSessionId === sid || t.toSessionId === sid; });
    return all.sort(function (a, b) { return (b.updatedAt || '').localeCompare(a.updatedAt || ''); });
  };

  PeerThreads.prototype.render = function () {
    var body = this.el('peerThreadsBody');
    if (!body || !this.isOpen()) return;
    var a = this.el('peerScopeTask'), b = this.el('peerScopeAll');
    if (a) a.classList.toggle('active', this.scope === 'task');
    if (b) b.classList.toggle('active', this.scope === 'all');
    var list = this.visibleThreads();
    body.textContent = '';
    if (!list.length) {
      var empty = document.createElement('p');
      empty.className = 'peer-empty';
      empty.textContent = this.scope === 'task'
        ? 'No hand-offs for this task yet. Right-click a task and choose "Hand off to…", or ask Claude to SendMessage another task.'
        : 'No hand-offs yet.';
      body.appendChild(empty);
      return;
    }
    var sid = this.currentSessionId();
    var self = this;
    list.forEach(function (t) {
      body.appendChild(self.card(t, sid));
      // Seen: the drawer is open on it.
      self.unread.delete(t.id);
    });
    this.updateBadges();
  };

  PeerThreads.prototype.when = function (iso) {
    var d = iso ? new Date(iso) : null;
    if (!d || isNaN(d)) return '';
    var same = d.toDateString() === new Date().toDateString();
    return same ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  PeerThreads.prototype.card = function (t, sid) {
    var outgoing = sid ? t.fromSessionId === sid : !!t.fromSessionId;
    var card = document.createElement('div');
    card.className = 'peer-card' + (FINAL_LABEL[t.status] ? ' peer-final' : '');
    card.dataset.thread = t.id;

    var head = document.createElement('div');
    head.className = 'peer-head';
    var dir = document.createElement('span');
    dir.className = 'peer-dir';
    dir.textContent = outgoing ? '↗ To ' + (t.toName || 'another task') : '↘ From ' + (t.fromName || 'another session');
    var at = document.createElement('span');
    at.className = 'peer-time';
    at.textContent = this.when(t.createdAt);
    head.appendChild(dir);
    head.appendChild(at);
    card.appendChild(head);

    card.appendChild(this.textBlock(t.text, outgoing ? t.toSessionId : t.toSessionId));
    card.appendChild(this.chain(t));

    var actions = document.createElement('div');
    actions.className = 'peer-actions';
    var add = function (label, act, primary) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-small ' + (primary ? 'btn-primary' : 'btn-secondary');
      btn.textContent = label;
      btn.dataset.act = act;
      actions.appendChild(btn);
    };
    if (t.status === 'held') {
      var hint = document.createElement('span');
      hint.className = 'peer-hint';
      hint.textContent = outgoing
        ? 'The recipient has to approve it in its own terminal.'
        : 'Approve or refuse it in this task\'s terminal.';
      actions.appendChild(hint);
    }
    if (outgoing && t.toSessionId) add('Go to recipient', 'goto-to', t.status === 'held');
    if (!outgoing && t.toSessionId) add('Show terminal', 'goto-self', t.status === 'held');
    if (!outgoing && t.fromSessionId) add('Go to sender', 'goto-from');
    add('Copy as prompt', 'copy');
    card.appendChild(actions);

    (t.replies || []).forEach(function (r) {
      var reply = document.createElement('div');
      reply.className = 'peer-reply';
      var rh = document.createElement('div');
      rh.className = 'peer-head';
      var rd = document.createElement('span');
      rd.className = 'peer-dir';
      rd.textContent = '↩ Reply' + (outgoing ? ' from ' + (t.toName || 'the recipient') : '');
      var rt = document.createElement('span');
      rt.className = 'peer-time';
      rt.textContent = this.when(r.at);
      rh.appendChild(rd);
      rh.appendChild(rt);
      reply.appendChild(rh);
      reply.appendChild(this.textBlock(r.text, t.toSessionId));
      card.appendChild(reply);
    }, this);
    return card;
  };

  // The message text, long ones folded, file:line turned into links. Built
  // with text nodes only: the text is another session's model's words.
  PeerThreads.prototype.textBlock = function (text, sessionForPaths) {
    var box = document.createElement('div');
    box.className = 'peer-text';
    text = String(text || '');
    var last = 0;
    FILE_LINE.lastIndex = 0;
    var m;
    while ((m = FILE_LINE.exec(text))) {
      if (m.index > last) box.appendChild(document.createTextNode(text.slice(last, m.index)));
      var link = document.createElement('a');
      link.href = '#';
      link.className = 'peer-file';
      link.textContent = m[0];
      link.dataset.path = m[1];
      if (sessionForPaths) link.dataset.session = sessionForPaths;
      box.appendChild(link);
      last = m.index + m[0].length;
    }
    if (last < text.length) box.appendChild(document.createTextNode(text.slice(last)));
    if (text.split('\n').length > 8 || text.length > 600) {
      box.classList.add('folded');
      var more = document.createElement('button');
      more.type = 'button';
      more.className = 'peer-more';
      more.textContent = 'Show all';
      more.dataset.act = 'unfold';
      var wrap = document.createElement('div');
      wrap.appendChild(box);
      wrap.appendChild(more);
      return wrap;
    }
    return box;
  };

  PeerThreads.prototype.chain = function (t) {
    var row = document.createElement('div');
    row.className = 'peer-chain';
    if (FINAL_LABEL[t.status]) {
      var bad = document.createElement('span');
      bad.className = 'peer-step bad';
      bad.textContent = FINAL_LABEL[t.status] + (t.failReason ? ': ' + t.failReason : '');
      row.appendChild(bad);
      return row;
    }
    var at = ORDER.indexOf(t.status);
    var wasHeld = t.status === 'held' || (t.notices || []).some(function (n) { return n.kind === 'held'; });
    CHAIN.forEach(function (step) {
      if (step[0] === 'held' && !wasHeld) return;
      var i = ORDER.indexOf(step[0]);
      var s = document.createElement('span');
      s.className = 'peer-step' + (i < at ? ' done' : i === at ? ' now' : '');
      if (step[0] === 'held' && t.status !== 'held') s.className = 'peer-step done';
      s.textContent = step[1];
      row.appendChild(s);
    });
    return row;
  };

  PeerThreads.prototype.onBodyClick = function (ev) {
    var target = ev.target;
    var card = target.closest && target.closest('.peer-card');
    var t = card ? this.threads.get(card.dataset.thread) : null;
    if (target.classList.contains('peer-file')) {
      ev.preventDefault();
      this.openFile(target.dataset.path, target.dataset.session);
      return;
    }
    var act = target.dataset && target.dataset.act;
    if (!act) return;
    if (act === 'unfold') {
      var box = target.previousSibling;
      if (box) box.classList.remove('folded');
      target.remove();
      return;
    }
    if (!t) return;
    if (act === 'goto-to') this.goTo(t.toSessionId, t.toName);
    else if (act === 'goto-self') this.goTo(t.toSessionId, t.toName, true);
    else if (act === 'goto-from') this.goTo(t.fromSessionId, t.fromName);
    else if (act === 'copy') this.copy(t);
  };

  // Absolute paths open as they are; a relative one is resolved against the
  // working directory of the task it was written for.
  PeerThreads.prototype.openFile = function (p, sessionId) {
    if (!window.fileExplorer) return;
    var abs = /^([A-Za-z]:[\\/]|\/)/.test(p);
    if (!abs && sessionId) {
      var self = this;
      fetch('/api/sessions/list', { headers: this.headers() })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var s = (data.sessions || []).find(function (x) { return x.id === sessionId; });
          var dir = s && s.workingDir;
          window.fileExplorer.openFile(dir ? dir.replace(/[\\/]+$/, '') + (dir.indexOf('\\') >= 0 ? '\\' : '/') + p : p);
        })
        .catch(function () { window.fileExplorer.openFile(p); });
      return;
    }
    window.fileExplorer.openFile(p);
  };

  PeerThreads.prototype.goTo = function (sessionId, name, focus) {
    var tabs = this.tabs();
    if (!sessionId || !tabs) return;
    this.close();
    if (tabs.tabs && tabs.tabs.has(sessionId)) {
      tabs.switchToTab(sessionId);
    } else if (this.app && this.app.attachSessionTab) {
      this.app.attachSessionTab(sessionId, name || 'task');
    }
    if (focus && this.app && this.app.terminal) {
      setTimeout(function () { try { window.app.terminal.scrollToBottom(); window.app.terminal.focus(); } catch (_) {} }, 300);
    }
  };

  // The whole hand-off as a prompt someone can paste into the other terminal
  // when the message cannot get through.
  PeerThreads.prototype.copy = function (t) {
    var text = 'Task handed over from the session "' + (t.fromName || 'another session') + '":\n\n' + (t.text || '') +
      '\n\nWhen you are done, reply to that session with what you changed and how you verified it.';
    var done = function () { if (window.app && window.app.showToast) window.app.showToast('Copied'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { window.prompt('Copy this:', text); });
    } else {
      window.prompt('Copy this:', text);
    }
  };

  // --- Hand off to… (tab menu) ------------------------------------------------
  // Picks a target and hands the text to THIS task's own Claude, which sends it
  // with SendMessage — its permissions, its judgement; the page sends nothing
  // to the other session itself.
  PeerThreads.prototype.openHandoff = function (fromSessionId) {
    this.bind();
    var modal = this.el('handoffModal');
    if (!modal) return;
    this.handoffFrom = fromSessionId;
    var select = this.el('handoffTarget');
    var err = this.el('handoffError');
    if (err) { err.hidden = true; err.textContent = ''; }
    select.textContent = '';
    var self = this;
    var tabs = this.tabs();
    Promise.all([
      fetch('/api/sessions/list', { headers: this.headers() }).then(function (r) { return r.json(); }),
      fetch('/api/spaces', { headers: this.headers() }).then(function (r) { return r.ok ? r.json() : { spaces: [] }; }).catch(function () { return { spaces: [] }; }),
    ]).then(function (res) {
      var spaces = {};
      (res[1].spaces || []).forEach(function (s) { spaces[s.id] = s.name; });
      var mine = (res[0].sessions || []).find(function (s) { return s.id === fromSessionId; });
      self.handoffFromMode = mine && mine.permissionMode;
      (res[0].sessions || []).filter(function (s) { return s.id !== fromSessionId; })
        .sort(function (a, b) { return String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')); })
        .forEach(function (s) {
          var tab = tabs && tabs.tabs && tabs.tabs.get(s.id);
          var state = !s.active ? 'stopped' : (tab && tab.hasAttribute('data-working') ? 'busy' : 'idle');
          var opt = document.createElement('option');
          opt.value = s.id;
          opt.dataset.name = s.name;
          opt.dataset.dir = s.workingDir || '';
          opt.dataset.mode = s.permissionMode || '';
          opt.textContent = s.name + ' — ' + (spaces[s.spaceId] || 'Ungrouped') + ' · ' + state + (s.permissionMode ? ' · ' + s.permissionMode : '');
          select.appendChild(opt);
        });
      self.updateHandoffHint();
    });
    select.onchange = function () { self.updateHandoffHint(); };
    modal.classList.add('active');
    var text = this.el('handoffText');
    if (text) setTimeout(function () { text.focus(); }, 50);
  };

  PeerThreads.prototype.updateHandoffHint = function () {
    var hint = this.el('handoffHint');
    var opt = this.el('handoffTarget').selectedOptions[0];
    if (!hint) return;
    var a = this.handoffFromMode === 'bypass', b = opt && opt.dataset.mode === 'bypass';
    hint.hidden = !(opt && opt.dataset.mode && this.handoffFromMode && a !== b);
    hint.textContent = 'The two tasks run in different permission modes, so the recipient will hold the message until someone approves it in its terminal.';
  };

  PeerThreads.prototype.closeHandoff = function () {
    var modal = this.el('handoffModal');
    if (modal) modal.classList.remove('active');
  };

  PeerThreads.prototype.sendHandoff = function () {
    var opt = this.el('handoffTarget').selectedOptions[0];
    var text = (this.el('handoffText').value || '').trim();
    var notify = this.el('handoffNotify').checked;
    var err = this.el('handoffError');
    var fail = function (m) { if (err) { err.textContent = m; err.hidden = false; } };
    if (!opt) return fail('Pick a task to hand this to.');
    if (!text) return fail('Write what the other task should do.');
    var prompt = 'Use the SendMessage tool to send the message below, verbatim, to the Claude session named "' + opt.dataset.name + '"' +
      (opt.dataset.dir ? ' (working directory ' + opt.dataset.dir + '; if that name does not match exactly one session, use ListAgents and pick the one in that directory)' : '') +
      (notify ? ', with notify_when_idle: true' : '') + '. Do not do the task yourself.\n\n---\n' + text + '\n---';
    var app = this.app;
    var sid = this.handoffFrom;
    // Bracketed paste keeps the newlines inside one prompt; Enter submits it.
    if (!app.sendInput('\x1b[200~' + prompt + '\x1b[201~', sid)) return fail('This task is not connected. Start its Claude first.');
    setTimeout(function () { app.sendInput('\r', sid); }, 300);
    this.el('handoffText').value = '';
    this.closeHandoff();
    if (app.showToast) app.showToast('Handed to this task\'s Claude to send');
  };

  window.PeerThreads = PeerThreads;
})();
