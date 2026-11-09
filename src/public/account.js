// Account and user management (M4).
//
// Two panels: 「账号」 for everyone signed in, opened from the name at the
// right of the header (change your password, see and sign out your devices,
// sign out), and 「用户管理」 in the menu for administrators (users, roles, disable, one-time passwords, browse
// directories, invite links). Both only talk to /api/auth/* and /api/admin/*;
// the server decides who may do what, the buttons only follow.
(function () {
  const $ = (id) => document.getElementById(id);

  const escapeHtml = (text) => String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // Server messages in the words these panels use.
  // (A top-level class is global but not a property of window.)
  // eslint-disable-next-line no-undef
  const zh = (message) => (typeof AuthManager !== 'undefined' && AuthManager.zh ? AuthManager.zh(message) : String(message || ''));

  async function api(method, url, body) {
    try {
      const res = await fetch(url, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, status: res.status, error: zh(data.error || `Request failed (${res.status})`) };
      return { ok: true, data };
    } catch (_) {
      return { ok: false, error: 'Could not reach the server' };
    }
  }

  function when(iso) {
    const t = Date.parse(iso);
    if (!t) return '—';
    const mins = Math.round((Date.now() - t) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.round(hours / 24);
    if (days < 30) return `${days} d ago`;
    return new Date(t).toLocaleDateString('en-US');
  }

  // "Chrome · Windows" from a user-agent string; good enough to tell your
  // phone from your laptop.
  function deviceName(ua) {
    const s = String(ua || '');
    const browser = /Edg\//.test(s) ? 'Edge'
      : /OPR\//.test(s) ? 'Opera'
        : /Firefox\//.test(s) ? 'Firefox'
          : /Chrome\//.test(s) ? 'Chrome'
            : /Safari\//.test(s) ? 'Safari'
              : (s ? s.split(/[\s/]/)[0] : 'Unknown browser');
    const os = /Windows/.test(s) ? 'Windows'
      : /iPhone|iPad/.test(s) ? 'iOS'
        : /Android/.test(s) ? 'Android'
          : /Mac OS X/.test(s) ? 'macOS'
            : /Linux/.test(s) ? 'Linux' : '';
    return os ? `${browser} · ${os}` : browser;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      return false;
    }
  }

  function setStatus(id, message, isError) {
    const el = $(id);
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('error', !!isError);
  }

  function closeMenu() {
    if (window.app && typeof window.app.closeMobileMenu === 'function') window.app.closeMobileMenu();
  }

  function confirmAsk(options) {
    if (window.app && typeof window.app.confirmDialog === 'function') return window.app.confirmDialog(options);
    return Promise.resolve(window.confirm(`${options.title}\n\n${options.body || ''}`));
  }

  function wireModal(modalId, closeId, onClose) {
    const modal = $(modalId);
    if (!modal) return;
    const close = () => { modal.classList.remove('active'); if (onClose) onClose(); };
    const btn = $(closeId);
    if (btn) btn.addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.classList.contains('active')) close();
    });
  }

  // --- 账号 ------------------------------------------------------------------

  const account = {
    me: null,

    async open() {
      const modal = $('accountModal');
      if (!modal) return;
      setStatus('accountStatus', '');
      if (this.me) {
        $('accountTitle').textContent = `Account: ${this.me.username}`;
        $('accountRole').textContent = this.me.role === 'admin' ? 'Admin' : 'Member';
      }
      modal.classList.add('active');
      await this.loadDevices();
    },

    async loadDevices() {
      const list = $('accountDeviceList');
      list.innerHTML = '<div class="account-hint">Loading…</div>';
      const r = await api('GET', '/api/auth/devices');
      if (!r.ok) {
        list.innerHTML = `<div class="account-hint">${escapeHtml(r.error)}</div>`;
        return;
      }
      list.innerHTML = '';
      for (const d of r.data.devices) {
        const row = document.createElement('div');
        row.className = 'users-row';
        row.innerHTML = `
          <div class="users-row-head">
            <span class="users-row-name">${escapeHtml(deviceName(d.ua))}${d.current ? ' <span class="users-tag accent">This device</span>' : ''}</span>
            <span class="users-row-actions"></span>
          </div>
          <div class="users-row-meta">${escapeHtml(d.ip || 'Unknown address')} · Signed in ${escapeHtml(when(d.createdAt))} · Last used ${escapeHtml(when(d.lastSeenAt))}</div>`;
        if (!d.current) {
          const out = document.createElement('button');
          out.type = 'button';
          out.className = 'btn btn-secondary btn-small';
          out.textContent = 'Sign out this device';
          out.addEventListener('click', async () => {
            out.disabled = true;
            const res = await api('DELETE', `/api/auth/devices/${encodeURIComponent(d.id)}`);
            if (!res.ok) { out.disabled = false; return setStatus('accountStatus', res.error, true); }
            setStatus('accountStatus', 'That device is signed out');
            this.loadDevices();
          });
          row.querySelector('.users-row-actions').appendChild(out);
        }
        list.appendChild(row);
      }
      if (!r.data.devices.length) list.innerHTML = '<div class="account-hint">No signed-in devices</div>';
    },

    async changePassword(e) {
      e.preventDefault();
      const current = $('accountCurrentPassword').value;
      const next = $('accountNewPassword').value;
      if (!current || !next) return setStatus('accountStatus', 'Enter your current password and a new password', true);
      if (next !== $('accountNewPassword2').value) return setStatus('accountStatus', 'The new passwords do not match', true);
      const btn = $('accountChangePasswordBtn');
      btn.disabled = true;
      const r = await api('POST', '/api/auth/password', { current, next });
      btn.disabled = false;
      if (!r.ok) return setStatus('accountStatus', r.error, true);
      ['accountCurrentPassword', 'accountNewPassword', 'accountNewPassword2'].forEach((id) => { $(id).value = ''; });
      const n = r.data.signedOut || 0;
      setStatus('accountStatus', n ? `Password changed; ${n} other ${n === 1 ? 'device was' : 'devices were'} signed out` : 'Password changed');
      this.loadDevices();
    },
  };

  // --- 用户管理 ----------------------------------------------------------------

  const users = {
    pane: 'users',
    editingRoots: null, // uid whose directory editor is open

    open() {
      const modal = $('usersModal');
      if (!modal) return;
      setStatus('usersStatus', '');
      modal.classList.add('active');
      this.show(this.pane);
    },

    show(pane) {
      this.pane = pane;
      $('usersTabUsers').classList.toggle('active', pane === 'users');
      $('usersTabInvites').classList.toggle('active', pane === 'invites');
      $('usersPaneUsers').hidden = pane !== 'users';
      $('usersPaneInvites').hidden = pane !== 'invites';
      if (pane === 'users') this.loadUsers();
      else this.loadInvites();
    },

    // A one-time password, shown once with a copy button.
    showSecret(username, password, what) {
      const box = $('usersSecret');
      box.hidden = false;
      box.innerHTML = `${escapeHtml(what)}: temporary password for <strong>${escapeHtml(username)}</strong> <code>${escapeHtml(password)}</code>`
        + '<button type="button" class="btn btn-secondary btn-small">Copy</button>'
        + '<div class="account-hint">Shown only once. Give it to them; they must change it to their own password when they first sign in.</div>';
      box.querySelector('button').addEventListener('click', async (e) => {
        e.target.textContent = (await copyText(password)) ? 'Copied' : 'Select and copy it by hand';
      });
    },

    async loadUsers() {
      const list = $('usersList');
      list.innerHTML = '<div class="account-hint">Loading…</div>';
      const r = await api('GET', '/api/admin/users');
      if (!r.ok) {
        list.innerHTML = `<div class="account-hint">${escapeHtml(r.error)}</div>`;
        return;
      }
      list.innerHTML = '';
      for (const u of r.data.users) list.appendChild(this.userRow(u));
    },

    userRow(u) {
      const me = account.me && account.me.id === u.id;
      const row = document.createElement('div');
      row.className = `users-row${u.disabled ? ' disabled' : ''}`;
      const tags = [
        u.role === 'admin' ? '<span class="users-tag accent">Admin</span>' : '<span class="users-tag">Member</span>',
        me ? '<span class="users-tag">You</span>' : '',
        u.disabled ? '<span class="users-tag">Disabled</span>' : '',
        u.mustChangePassword ? '<span class="users-tag">Must change password</span>' : '',
      ].join(' ');
      const roots = u.effectiveRoots ? u.effectiveRoots.join('; ') : 'Anywhere';
      row.innerHTML = `
        <div class="users-row-head">
          <span class="users-row-name">${escapeHtml(u.username)} ${tags}</span>
          <span class="users-row-actions"></span>
        </div>
        <div class="users-row-meta">Folder access: ${escapeHtml(roots)}</div>
        <div class="users-row-meta">Devices ${u.devices} · Running sessions ${u.runningSessions} · Last used ${escapeHtml(u.lastSeenAt ? when(u.lastSeenAt) : '—')} · Created ${escapeHtml(when(u.createdAt))}</div>`;
      const actions = row.querySelector('.users-row-actions');
      const button = (label, handler, danger) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `btn btn-small ${danger ? 'btn-danger' : 'btn-secondary'}`;
        b.textContent = label;
        b.addEventListener('click', async () => {
          b.disabled = true;
          try { await handler(); } finally { b.disabled = false; }
        });
        actions.appendChild(b);
      };

      if (u.role !== 'admin') button('Folder access', () => this.editRoots(row, u));
      if (!me) {
        button(u.role === 'admin' ? 'Make member' : 'Make admin', () => this.patch(u, { role: u.role === 'admin' ? 'user' : 'admin' }));
        button(u.disabled ? 'Enable' : 'Disable', async () => {
          if (!u.disabled && !(await confirmAsk({
            title: `Disable ${u.username}?`,
            body: 'All their sign-ins end now and their running Claude stops. Their sessions and data are kept; enable them again to carry on.',
            confirmText: 'Disable', danger: true,
          }))) return;
          await this.patch(u, { disabled: !u.disabled });
        });
        button('Reset password', async () => {
          if (!(await confirmAsk({
            title: `Reset the password for ${u.username}?`,
            body: 'A temporary password is generated. All their sign-ins end now and their running Claude stops. They must change the password at their next sign-in.',
            confirmText: 'Reset',
          }))) return;
          const r = await api('POST', `/api/admin/users/${encodeURIComponent(u.id)}/reset-password`);
          if (!r.ok) return setStatus('usersStatus', r.error, true);
          this.showSecret(u.username, r.data.password, 'Reset');
          this.loadUsers();
        });
        button('Delete', async () => {
          if (!(await confirmAsk({
            title: `Delete ${u.username}?`,
            body: `They can no longer sign in and their running Claude stops. Their sessions, spaces and Claude history stay in the server's data folder (${u.id}/) and are not deleted.`,
            confirmText: 'Delete', danger: true,
          }))) return;
          const r = await api('DELETE', `/api/admin/users/${encodeURIComponent(u.id)}`);
          if (!r.ok) return setStatus('usersStatus', r.error, true);
          setStatus('usersStatus', `Deleted ${u.username}; their data is kept in ${r.data.dataDir}`);
          this.loadUsers();
        }, true);
      }
      return row;
    },

    editRoots(row, u) {
      const existing = row.querySelector('textarea');
      if (existing) { existing.parentElement.remove(); return; }
      const box = document.createElement('div');
      box.innerHTML = `
        <textarea spellcheck="false" placeholder="One absolute path per line; leave empty for the default ${escapeHtml(u.id)}/workspace"></textarea>
        <div class="users-row-actions" style="margin-top: 6px;"></div>`;
      const area = box.querySelector('textarea');
      area.value = (u.rootDirs || []).join('\n');
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'btn btn-primary btn-small';
      save.textContent = 'Save';
      save.addEventListener('click', async () => {
        const dirs = area.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        save.disabled = true;
        const ok = await this.patch(u, { rootDirs: dirs });
        save.disabled = false;
        if (ok) setStatus('usersStatus', `Updated folder access for ${u.username}`);
      });
      box.querySelector('.users-row-actions').appendChild(save);
      row.appendChild(box);
      area.focus();
    },

    async patch(u, body) {
      const r = await api('PATCH', `/api/admin/users/${encodeURIComponent(u.id)}`, body);
      if (!r.ok) { setStatus('usersStatus', r.error, true); return false; }
      setStatus('usersStatus', '');
      this.loadUsers();
      return true;
    },

    async create(e) {
      e.preventDefault();
      const username = $('usersNewName').value.trim();
      if (!username) return setStatus('usersStatus', 'Enter a username', true);
      const btn = $('usersCreateBtn');
      btn.disabled = true;
      const r = await api('POST', '/api/admin/users', { username, role: $('usersNewRole').value });
      btn.disabled = false;
      if (!r.ok) return setStatus('usersStatus', r.error, true);
      $('usersNewName').value = '';
      setStatus('usersStatus', '');
      this.showSecret(r.data.user.username, r.data.password, 'Created');
      this.loadUsers();
    },

    inviteLink(code) {
      return `${window.location.origin}/?invite=${encodeURIComponent(code)}`;
    },

    async loadInvites() {
      const list = $('invitesList');
      list.innerHTML = '<div class="account-hint">Loading…</div>';
      const r = await api('GET', '/api/admin/invites');
      if (!r.ok) {
        list.innerHTML = `<div class="account-hint">${escapeHtml(r.error)}</div>`;
        return;
      }
      list.innerHTML = '';
      for (const inv of r.data.invites) {
        const link = this.inviteLink(inv.code);
        const row = document.createElement('div');
        row.className = 'users-row';
        row.innerHTML = `
          <div class="users-row-head">
            <span class="users-row-name"><code>${escapeHtml(link)}</code></span>
            <span class="users-row-actions"></span>
          </div>
          <div class="users-row-meta">Signs up as ${inv.role === 'admin' ? 'Admin' : 'Member'} · Created by ${escapeHtml(inv.createdBy || '')} ${escapeHtml(when(inv.createdAt))} · Expires ${escapeHtml(new Date(inv.expiresAt).toLocaleString('en-US'))} · Single use</div>`;
        const actions = row.querySelector('.users-row-actions');
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'btn btn-secondary btn-small';
        copy.textContent = 'Copy link';
        copy.addEventListener('click', async () => { copy.textContent = (await copyText(link)) ? 'Copied' : 'Select and copy it by hand'; });
        const revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.className = 'btn btn-danger btn-small';
        revoke.textContent = 'Revoke';
        revoke.addEventListener('click', async () => {
          const res = await api('DELETE', `/api/admin/invites/${encodeURIComponent(inv.code)}`);
          if (!res.ok) return setStatus('usersStatus', res.error, true);
          this.loadInvites();
        });
        actions.append(copy, revoke);
        list.appendChild(row);
      }
      if (!r.data.invites.length) list.innerHTML = '<div class="account-hint">No active invite links</div>';
    },

    async createInvite(e) {
      e.preventDefault();
      const r = await api('POST', '/api/admin/invites', { role: $('invitesRole').value, days: Number($('invitesDays').value) || 7 });
      if (!r.ok) return setStatus('usersStatus', r.error, true);
      const link = this.inviteLink(r.data.invite.code);
      const copied = await copyText(link);
      setStatus('usersStatus', copied ? 'Invite link created and copied' : 'Invite link created');
      this.loadInvites();
    },
  };

  // --- 菜单 ------------------------------------------------------------------

  async function init() {
    wireModal('accountModal', 'closeAccountBtn');
    wireModal('usersModal', 'closeUsersBtn');
    const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
    on('accountPasswordForm', 'submit', (e) => account.changePassword(e));
    on('accountLogoutBtn', 'click', () => window.authManager && window.authManager.logout());
    on('usersTabUsers', 'click', () => users.show('users'));
    on('usersTabInvites', 'click', () => users.show('invites'));
    on('usersCreateForm', 'submit', (e) => users.create(e));
    on('invitesCreateForm', 'submit', (e) => users.createInvite(e));
    on('accountHeaderBtn', 'click', () => account.open());
    on('usersBtnMobile', 'click', () => { closeMenu(); users.open(); });

    // Only a signed-in platform user has an account to show. With the token
    // only, or auth off, the menu stays as it was.
    // /auth-status rather than /api/auth/me: it answers 200 signed in or not,
    // so the login page does not log a 401 on every load.
    const r = await api('GET', '/auth-status');
    if (!r.ok || !r.data.user) return;
    const me = r.data.user;
    account.me = me;
    const headerBtn = $('accountHeaderBtn');
    if (headerBtn) {
      $('accountHeaderName').textContent = me.username;
      headerBtn.setAttribute('aria-label', `Account: ${me.username}`);
      headerBtn.title = `Account: ${me.username}`;
      headerBtn.hidden = false;
    }
    if ($('usersBtnMobile')) $('usersBtnMobile').hidden = me.role !== 'admin';
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.ccwAccount = { account, users, deviceName };
})();
