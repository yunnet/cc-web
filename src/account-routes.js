const fs = require('fs');
const path = require('path');
const UserStore = require('./utils/user-store');

// Accounts (M4): signing up with an invite, changing your own password, your
// signed-in devices, and the administrator's user and invite management.
//
// Split out of server.js, which was already long; every route here goes
// through the server's own auth helpers (cookieLogin, sameOrigin,
// allowLoginAttempt, startLoginSession) rather than re-implementing them.

const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch((error) => {
    console.error('[async route]', req.method, req.originalUrl, error);
    if (!res.headersSent) res.status(error.status || 500).json({ error: error.message || 'Internal error' });
  });
};

const MAX_ROOT_DIRS = 20;

// What a device row shows. `current` marks the browser that is asking.
function deviceView(record, currentId) {
  return {
    id: record.id,
    ua: record.ua || '',
    ip: record.ip || '',
    createdAt: record.createdAt,
    lastSeenAt: record.lastSeenAt,
    current: record.id === currentId,
  };
}

// Routes reachable with a login cookie but registered BEFORE the global auth
// middleware, so a user who must change their password can still reach them.
function registerAccountRoutes(server) {
  const { app, userStore } = server;

  // The signed-in browser, or a 401 already sent.
  const requireLogin = (req, res) => {
    if (!server.authEnabled()) {
      res.status(400).json({ error: 'Authentication is disabled' });
      return null;
    }
    const login = server.cookieLogin(req, res);
    if (!login) {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    }
    if (req.method !== 'GET' && !server.sameOrigin(req)) {
      res.status(403).json({ error: 'Cross-origin request refused' });
      return null;
    }
    return login;
  };

  // Sign up with an invite code, then signed straight in.
  app.post('/api/auth/register', asyncRoute(async (req, res) => {
    if (!server.authEnabled()) return res.status(400).json({ error: 'Authentication is disabled' });
    if (!server.sameOrigin(req)) return res.status(403).json({ error: 'Cross-origin request refused' });
    const { invite, username, password } = req.body || {};
    if (!server.allowLoginAttempt(req, `register:${username}`)) {
      return res.status(429).json({ error: 'Too many attempts. Please wait a minute and try again.' });
    }
    let user;
    try {
      user = await userStore.registerWithInvite(invite, { username, password });
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message });
    }
    console.log(`[auth] user "${user.username}" registered with an invite`);
    server.startLoginSession(req, res, user);
    res.json({ user: UserStore.publicUser(user) });
  }));

  // Change your own password. Your other devices are signed out; this one
  // stays. Also how a forced first-login change is completed.
  app.post('/api/auth/password', asyncRoute(async (req, res) => {
    const login = requireLogin(req, res);
    if (!login) return;
    const { current, next } = req.body || {};
    if (!server.allowLoginAttempt(req, login.user.username)) {
      return res.status(429).json({ error: 'Too many attempts. Please wait a minute and try again.' });
    }
    const ok = await userStore.verifyLogin(login.user.username, current);
    if (!ok || ok.id !== login.user.id) return res.status(401).json({ error: 'Current password is incorrect' });
    if (current === next) return res.status(400).json({ error: 'The new password must be different' });
    let removed;
    try {
      removed = await userStore.setPassword(login.user.id, next, { keepLoginId: login.session.id });
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message });
    }
    server.closeLoginSockets(removed, 'Password changed');
    res.json({ ok: true, user: UserStore.publicUser(userStore.getUser(login.user.id)), signedOut: removed.length });
  }));

  app.get('/api/auth/devices', (req, res) => {
    const login = requireLogin(req, res);
    if (!login) return;
    res.json({ devices: userStore.listLoginSessions(login.user.id).map((d) => deviceView(d, login.session.id)) });
  });

  // Sign one of your devices out (closing its terminals). Signing out the
  // browser that asks is what /api/auth/logout is for.
  app.delete('/api/auth/devices/:id', (req, res) => {
    const login = requireLogin(req, res);
    if (!login) return;
    if (req.params.id === login.session.id) return res.status(400).json({ error: 'Use sign out for this device' });
    if (!userStore.deleteLoginSessionById(login.user.id, req.params.id)) {
      return res.status(404).json({ error: 'No such device' });
    }
    server.closeLoginSockets([req.params.id], 'Signed out from another device');
    res.json({ ok: true });
  });
}

// Administrator routes, registered AFTER the global auth middleware (req.user
// is set). Every one of them answers 403 to anyone but an admin.
function registerAdminRoutes(server) {
  const { app, userStore } = server;

  const requireAdmin = (req, res, next) => {
    if (!server.authEnabled()) return res.status(400).json({ error: 'Authentication is disabled' });
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Administrators only' });
    next();
  };
  app.use('/api/admin', requireAdmin);

  // Active admins other than `exceptId`: the instance must keep one.
  const otherActiveAdmins = (exceptId) => userStore.listUsers()
    .filter((u) => u.role === 'admin' && !u.disabled && u.id !== exceptId).length;

  const userRow = (u) => {
    const devices = userStore.listLoginSessions(u.id);
    let running = 0;
    for (const s of server.claudeSessions.values()) {
      if ((s.ownerId || null) === u.id && s.active) running += 1;
    }
    return {
      ...UserStore.adminUser(u),
      devices: devices.length,
      lastSeenAt: devices.length ? devices[0].lastSeenAt : null,
      runningSessions: running,
      // What browsing is limited to right now (null = anywhere).
      effectiveRoots: server.browseRoots(u),
    };
  };

  app.get('/api/admin/users', (req, res) => {
    const users = userStore.listUsers()
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .map(userRow);
    res.json({ users });
  });

  // A new account with a one-time password, shown only in this response.
  app.post('/api/admin/users', asyncRoute(async (req, res) => {
    const { username, role } = req.body || {};
    const password = UserStore.tempPassword();
    let user;
    try {
      user = await userStore.createUser({ username, password, role: role === 'admin' ? 'admin' : 'user', mustChangePassword: true });
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message });
    }
    console.log(`[auth] ${req.user.username} created user "${user.username}" (${user.role})`);
    res.json({ user: userRow(user), password });
  }));

  // role, disabled, rootDirs.
  app.patch('/api/admin/users/:id', asyncRoute(async (req, res) => {
    const target = userStore.getUser(req.params.id);
    if (!target) return res.status(404).json({ error: 'No such user' });
    const body = req.body || {};
    const patch = {};
    const self = target.id === req.user.id;

    if (body.role !== undefined) {
      if (body.role !== 'admin' && body.role !== 'user') return res.status(400).json({ error: 'role is admin or user' });
      if (body.role !== target.role) {
        if (self) return res.status(400).json({ error: 'You cannot change your own role' });
        if (target.role === 'admin' && !target.disabled && otherActiveAdmins(target.id) === 0) {
          return res.status(400).json({ error: 'At least one active admin must remain' });
        }
        patch.role = body.role;
      }
    }
    if (body.disabled !== undefined) {
      if (typeof body.disabled !== 'boolean') return res.status(400).json({ error: 'disabled is true or false' });
      if (body.disabled !== !!target.disabled) {
        if (self) return res.status(400).json({ error: 'You cannot disable yourself' });
        if (body.disabled && target.role === 'admin' && otherActiveAdmins(target.id) === 0) {
          return res.status(400).json({ error: 'At least one active admin must remain' });
        }
        patch.disabled = body.disabled;
      }
    }
    if (body.rootDirs !== undefined) {
      if (!Array.isArray(body.rootDirs) || body.rootDirs.length > MAX_ROOT_DIRS) {
        return res.status(400).json({ error: `rootDirs is a list of at most ${MAX_ROOT_DIRS} directories` });
      }
      const dirs = [];
      const rejected = [];
      for (const raw of body.rootDirs) {
        const d = typeof raw === 'string' ? raw.trim() : '';
        if (!d) continue;
        let ok = path.isAbsolute(d);
        try { ok = ok && fs.statSync(d).isDirectory(); } catch (_) { ok = false; }
        if (!ok) { rejected.push(d); continue; }
        const resolved = path.resolve(d);
        if (!dirs.includes(resolved)) dirs.push(resolved);
      }
      if (rejected.length) {
        return res.status(400).json({ error: `Not existing absolute folder paths: ${rejected.join(', ')}`, rejected });
      }
      patch.rootDirs = dirs;
    }

    const updated = Object.keys(patch).length ? userStore.updateUser(target.id, patch) : target;
    if (patch.disabled === true) {
      userStore.revokeUserSessions(target.id);
      await server.endUserAccess(target.id, 'Account disabled');
    }
    res.json({ user: userRow(updated) });
  }));

  // A new one-time password; every login of theirs ends, and so do their
  // running sessions.
  app.post('/api/admin/users/:id/reset-password', asyncRoute(async (req, res) => {
    const target = userStore.getUser(req.params.id);
    if (!target) return res.status(404).json({ error: 'No such user' });
    if (target.id === req.user.id) return res.status(400).json({ error: 'To change your own password, use Change password under Account' });
    const password = UserStore.tempPassword();
    await userStore.setPassword(target.id, password, { mustChangePassword: true, revokeAll: true });
    await server.endUserAccess(target.id, 'Password reset');
    res.json({ user: userRow(userStore.getUser(target.id)), password });
  }));

  // Deletes the account only: <dataDir>/<uid>/ stays on disk.
  app.delete('/api/admin/users/:id', asyncRoute(async (req, res) => {
    const target = userStore.getUser(req.params.id);
    if (!target) return res.status(404).json({ error: 'No such user' });
    if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot delete yourself' });
    if (target.role === 'admin' && !target.disabled && otherActiveAdmins(target.id) === 0) {
      return res.status(400).json({ error: 'At least one active admin must remain' });
    }
    userStore.deleteUser(target.id);
    await server.endUserAccess(target.id, 'Account deleted');
    console.log(`[auth] ${req.user.username} deleted user "${target.username}"; data kept in ${target.id}/`);
    res.json({ ok: true, dataDir: path.join(server.sessionStore.storageDir, target.id) });
  }));

  app.get('/api/admin/invites', (req, res) => {
    res.json({ invites: userStore.listInvites() });
  });

  app.post('/api/admin/invites', (req, res) => {
    const { role, days } = req.body || {};
    res.json({ invite: userStore.createInvite({ role, days, createdBy: req.user.username }) });
  });

  app.delete('/api/admin/invites/:code', (req, res) => {
    if (!userStore.deleteInvite(req.params.code)) return res.status(404).json({ error: 'No such invite' });
    res.json({ ok: true });
  });
}

module.exports = { registerAccountRoutes, registerAdminRoutes };
