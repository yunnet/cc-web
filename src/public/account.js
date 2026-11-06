// Account and user management (M4).
//
// Two panels behind the menu: 「账号」 for everyone signed in (change your
// password, see and sign out your devices, sign out), and 「用户管理」 for
// administrators (users, roles, disable, one-time passwords, browse
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
      if (!res.ok) return { ok: false, status: res.status, error: zh(data.error || `请求失败（${res.status}）`) };
      return { ok: true, data };
    } catch (_) {
      return { ok: false, error: '连不上服务器' };
    }
  }

  function when(iso) {
    const t = Date.parse(iso);
    if (!t) return '—';
    const mins = Math.round((Date.now() - t) / 60000);
    if (mins < 1) return '刚刚';
    if (mins < 60) return `${mins} 分钟前`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} 小时前`;
    const days = Math.round(hours / 24);
    if (days < 30) return `${days} 天前`;
    return new Date(t).toLocaleDateString();
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
              : (s ? s.split(/[\s/]/)[0] : '未知浏览器');
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
      if (this.me) $('accountTitle').textContent = `账号：${this.me.username}`;
      modal.classList.add('active');
      await this.loadDevices();
    },

    async loadDevices() {
      const list = $('accountDeviceList');
      list.innerHTML = '<div class="account-hint">正在读取…</div>';
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
            <span class="users-row-name">${escapeHtml(deviceName(d.ua))}${d.current ? ' <span class="users-tag accent">本机</span>' : ''}</span>
            <span class="users-row-actions"></span>
          </div>
          <div class="users-row-meta">${escapeHtml(d.ip || '未知地址')} · 登录于 ${escapeHtml(when(d.createdAt))} · 最近使用 ${escapeHtml(when(d.lastSeenAt))}</div>`;
        if (!d.current) {
          const out = document.createElement('button');
          out.type = 'button';
          out.className = 'btn btn-secondary btn-small';
          out.textContent = '退出这台设备';
          out.addEventListener('click', async () => {
            out.disabled = true;
            const res = await api('DELETE', `/api/auth/devices/${encodeURIComponent(d.id)}`);
            if (!res.ok) { out.disabled = false; return setStatus('accountStatus', res.error, true); }
            setStatus('accountStatus', '那台设备已退出登录');
            this.loadDevices();
          });
          row.querySelector('.users-row-actions').appendChild(out);
        }
        list.appendChild(row);
      }
      if (!r.data.devices.length) list.innerHTML = '<div class="account-hint">没有登录中的设备</div>';
    },

    async changePassword(e) {
      e.preventDefault();
      const current = $('accountCurrentPassword').value;
      const next = $('accountNewPassword').value;
      if (!current || !next) return setStatus('accountStatus', '请填写当前密码和新密码', true);
      if (next !== $('accountNewPassword2').value) return setStatus('accountStatus', '两次输入的新密码不一致', true);
      const btn = $('accountChangePasswordBtn');
      btn.disabled = true;
      const r = await api('POST', '/api/auth/password', { current, next });
      btn.disabled = false;
      if (!r.ok) return setStatus('accountStatus', r.error, true);
      ['accountCurrentPassword', 'accountNewPassword', 'accountNewPassword2'].forEach((id) => { $(id).value = ''; });
      const n = r.data.signedOut || 0;
      setStatus('accountStatus', n ? `密码已修改，其他 ${n} 台设备已退出登录` : '密码已修改');
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
      box.innerHTML = `${escapeHtml(what)}：<strong>${escapeHtml(username)}</strong> 的临时密码 <code>${escapeHtml(password)}</code>`
        + '<button type="button" class="btn btn-secondary btn-small">复制</button>'
        + '<div class="account-hint">只显示这一次。把它交给对方，对方第一次登录时必须改成自己的密码。</div>';
      box.querySelector('button').addEventListener('click', async (e) => {
        e.target.textContent = (await copyText(password)) ? '已复制' : '请手动选中复制';
      });
    },

    async loadUsers() {
      const list = $('usersList');
      list.innerHTML = '<div class="account-hint">正在读取…</div>';
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
        u.role === 'admin' ? '<span class="users-tag accent">管理员</span>' : '<span class="users-tag">普通用户</span>',
        me ? '<span class="users-tag">你</span>' : '',
        u.disabled ? '<span class="users-tag">已停用</span>' : '',
        u.mustChangePassword ? '<span class="users-tag">待改密码</span>' : '',
      ].join(' ');
      const roots = u.effectiveRoots ? u.effectiveRoots.join('；') : '不限';
      row.innerHTML = `
        <div class="users-row-head">
          <span class="users-row-name">${escapeHtml(u.username)} ${tags}</span>
          <span class="users-row-actions"></span>
        </div>
        <div class="users-row-meta">可浏览目录：${escapeHtml(roots)}</div>
        <div class="users-row-meta">登录设备 ${u.devices} · 运行中会话 ${u.runningSessions} · 最近使用 ${escapeHtml(u.lastSeenAt ? when(u.lastSeenAt) : '—')} · 创建于 ${escapeHtml(when(u.createdAt))}</div>`;
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

      if (u.role !== 'admin') button('目录', () => this.editRoots(row, u));
      if (!me) {
        button(u.role === 'admin' ? '设为普通用户' : '设为管理员', () => this.patch(u, { role: u.role === 'admin' ? 'user' : 'admin' }));
        button(u.disabled ? '启用' : '停用', async () => {
          if (!u.disabled && !(await confirmAsk({
            title: `停用 ${u.username}？`,
            body: '对方的所有登录会立即退出，正在运行的 Claude 会停止。会话和数据都保留，重新启用后可以继续使用。',
            confirmText: '停用', danger: true,
          }))) return;
          await this.patch(u, { disabled: !u.disabled });
        });
        button('重置密码', async () => {
          if (!(await confirmAsk({
            title: `重置 ${u.username} 的密码？`,
            body: '会生成一个临时密码；对方的所有登录会立即退出，正在运行的 Claude 会停止。下次登录时必须改密码。',
            confirmText: '重置',
          }))) return;
          const r = await api('POST', `/api/admin/users/${encodeURIComponent(u.id)}/reset-password`);
          if (!r.ok) return setStatus('usersStatus', r.error, true);
          this.showSecret(u.username, r.data.password, '已重置');
          this.loadUsers();
        });
        button('删除', async () => {
          if (!(await confirmAsk({
            title: `删除 ${u.username}？`,
            body: `删除账号后对方不能再登录，正在运行的 Claude 会停止。对方的会话、空间和 Claude 记录保留在服务器的数据目录（${u.id}/）里，不会被删除。`,
            confirmText: '删除', danger: true,
          }))) return;
          const r = await api('DELETE', `/api/admin/users/${encodeURIComponent(u.id)}`);
          if (!r.ok) return setStatus('usersStatus', r.error, true);
          setStatus('usersStatus', `已删除 ${u.username}，数据保留在 ${r.data.dataDir}`);
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
        <textarea spellcheck="false" placeholder="每行一个绝对路径；留空 = 默认的 ${escapeHtml(u.id)}/workspace"></textarea>
        <div class="users-row-actions" style="margin-top: 6px;"></div>`;
      const area = box.querySelector('textarea');
      area.value = (u.rootDirs || []).join('\n');
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'btn btn-primary btn-small';
      save.textContent = '保存目录';
      save.addEventListener('click', async () => {
        const dirs = area.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        save.disabled = true;
        const ok = await this.patch(u, { rootDirs: dirs });
        save.disabled = false;
        if (ok) setStatus('usersStatus', `已更新 ${u.username} 的可浏览目录`);
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
      if (!username) return setStatus('usersStatus', '请填写用户名', true);
      const btn = $('usersCreateBtn');
      btn.disabled = true;
      const r = await api('POST', '/api/admin/users', { username, role: $('usersNewRole').value });
      btn.disabled = false;
      if (!r.ok) return setStatus('usersStatus', r.error, true);
      $('usersNewName').value = '';
      setStatus('usersStatus', '');
      this.showSecret(r.data.user.username, r.data.password, '已创建');
      this.loadUsers();
    },

    inviteLink(code) {
      return `${window.location.origin}/?invite=${encodeURIComponent(code)}`;
    },

    async loadInvites() {
      const list = $('invitesList');
      list.innerHTML = '<div class="account-hint">正在读取…</div>';
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
          <div class="users-row-meta">注册后为${inv.role === 'admin' ? '管理员' : '普通用户'} · ${escapeHtml(inv.createdBy || '')} 创建于 ${escapeHtml(when(inv.createdAt))} · ${escapeHtml(new Date(inv.expiresAt).toLocaleString())} 过期 · 只能用一次</div>`;
        const actions = row.querySelector('.users-row-actions');
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'btn btn-secondary btn-small';
        copy.textContent = '复制链接';
        copy.addEventListener('click', async () => { copy.textContent = (await copyText(link)) ? '已复制' : '请手动选中复制'; });
        const revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.className = 'btn btn-danger btn-small';
        revoke.textContent = '作废';
        revoke.addEventListener('click', async () => {
          const res = await api('DELETE', `/api/admin/invites/${encodeURIComponent(inv.code)}`);
          if (!res.ok) return setStatus('usersStatus', res.error, true);
          this.loadInvites();
        });
        actions.append(copy, revoke);
        list.appendChild(row);
      }
      if (!r.data.invites.length) list.innerHTML = '<div class="account-hint">没有可用的邀请码</div>';
    },

    async createInvite(e) {
      e.preventDefault();
      const r = await api('POST', '/api/admin/invites', { role: $('invitesRole').value, days: Number($('invitesDays').value) || 7 });
      if (!r.ok) return setStatus('usersStatus', r.error, true);
      const link = this.inviteLink(r.data.invite.code);
      const copied = await copyText(link);
      setStatus('usersStatus', copied ? '邀请链接已生成并复制' : '邀请链接已生成');
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
    on('accountBtnMobile', 'click', () => { closeMenu(); account.open(); });
    on('usersBtnMobile', 'click', () => { closeMenu(); users.open(); });

    // Only a signed-in platform user has an account to show. With the token
    // only, or auth off, the menu stays as it was.
    // /auth-status rather than /api/auth/me: it answers 200 signed in or not,
    // so the login page does not log a 401 on every load.
    const r = await api('GET', '/auth-status');
    if (!r.ok || !r.data.user) return;
    const me = r.data.user;
    account.me = me;
    const label = $('menuUser');
    if (label) {
      label.innerHTML = `已登录：<strong>${escapeHtml(me.username)}</strong>（${me.role === 'admin' ? '管理员' : '普通用户'}）`;
      label.hidden = false;
    }
    if ($('accountBtnMobile')) $('accountBtnMobile').hidden = false;
    if ($('usersBtnMobile')) $('usersBtnMobile').hidden = me.role !== 'admin';
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.ccwAccount = { account, users, deviceName };
})();
