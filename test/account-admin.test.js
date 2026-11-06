const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { ClaudeCodeWebServer } = require('../src/server');
const UserStore = require('../src/utils/user-store');
const userCli = require('../src/user-cli');
const { useTempDataDir, signIn } = require('./helpers/auth');

// M4: user management, invites, forced password change, devices, browse
// roots and the `cc-web user` CLI.

describe('user store additions (M4)', function () {
  let dir;
  let store;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-m4-store-'));
    store = new UserStore(() => dir);
  });

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('makes readable one-time passwords', function () {
    const p = UserStore.tempPassword();
    assert.strictEqual(p.length, 12);
    assert.match(p, /^[a-km-zA-HJ-NP-Z2-9]+$/);
    assert.notStrictEqual(p, UserStore.tempPassword());
  });

  it('sees a user another process wrote, without a restart', async function () {
    assert.strictEqual(store.hasUsers(), false);
    const other = new UserStore(() => dir);
    await other.createUser({ username: 'carol', password: 'password-123' });
    // Directory mtime granularity: make sure the change is visible as one.
    const t = new Date(Date.now() + 2000);
    fs.utimesSync(path.join(dir, 'users'), t, t);
    assert.ok(store.findByUsername('carol'));
  });

  it('voids logins issued before a reset, and keeps the asking browser on a self-change', async function () {
    const u = await store.createUser({ username: 'dave', password: 'password-123' });
    const a = store.createLoginSession(u.id);
    const b = store.createLoginSession(u.id);
    const keep = store.getLoginSession(a).session.id;
    const removed = await store.setPassword(u.id, 'password-456', { keepLoginId: keep });
    assert.strictEqual(removed.length, 1);
    assert.ok(store.getLoginSession(a));
    assert.strictEqual(store.getLoginSession(b), null);

    await new Promise((r) => setTimeout(r, 5));
    await store.setPassword(u.id, 'password-789', { mustChangePassword: true, revokeAll: true });
    assert.strictEqual(store.getLoginSession(a), null);
    assert.strictEqual(store.getUser(u.id).mustChangePassword, true);
    assert.ok(await store.verifyLogin('dave', 'password-789'));
  });

  it('a login issued before sessionsValidAfter is refused even if still in memory', async function () {
    const u = await store.createUser({ username: 'erin', password: 'password-123' });
    const sid = store.createLoginSession(u.id);
    await new Promise((r) => setTimeout(r, 5));
    // What `cc-web user passwd` does from another process.
    const other = new UserStore(() => dir);
    await other.setPassword(u.id, 'password-456', { revokeAll: true });
    const t = new Date(Date.now() + 2000);
    fs.utimesSync(path.join(dir, 'users'), t, t);
    assert.strictEqual(store.getLoginSession(sid), null);
  });

  it('invites: one use, expire, and come back when the sign-up fails', async function () {
    await store.createUser({ username: 'frank', password: 'password-123' });
    const inv = store.createInvite({ role: 'user', days: 7, createdBy: 'admin' });
    assert.match(inv.code, /^[A-Za-z0-9_-]{12}$/);
    await assert.rejects(store.registerWithInvite(inv.code, { username: 'frank', password: 'password-123' }), /already exists/);
    assert.ok(store.listInvites().some((i) => i.code === inv.code), 'a failed sign-up does not spend the invite');
    const user = await store.registerWithInvite(inv.code, { username: 'gina', password: 'password-123' });
    assert.strictEqual(user.role, 'user');
    await assert.rejects(store.registerWithInvite(inv.code, { username: 'hank', password: 'password-123' }), /invalid or has expired/);

    const old = store.createInvite({ days: 1 });
    old.expiresAt = new Date(Date.now() - 1000).toISOString();
    assert.ok(!store.listInvites().some((i) => i.code === old.code));
    assert.ok(!fs.existsSync(path.join(dir, 'invites', `${old.code}.json`)));
  });
});

describe('accounts and administration (M4)', function () {
  let server;
  let listener;
  let port;
  let dir;
  let work;
  let admin;

  beforeEach(async function () {
    server = new ClaudeCodeWebServer({ auth: 'tok-m4', folderMode: false, port: 40126 });
    dir = useTempDataDir(server);
    await server._initialLoad;
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-m4-work-')));
    admin = await signIn(server, { username: 'root', role: 'admin' });
    await new Promise((resolve) => {
      listener = http.createServer(server.app).listen(0, '127.0.0.1', () => {
        port = listener.address().port;
        resolve();
      });
    });
  });

  afterEach(function () {
    listener.close();
    if (server && typeof server.dispose === 'function') server.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  });

  function request(method, p, { body, cookie } = {}) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const req = http.request({
        host: '127.0.0.1', port, path: p, method,
        headers: {
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
      }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch (_) { /* not json */ }
          const set = res.headers['set-cookie'];
          resolve({ status: res.statusCode, json, cookie: set ? String(set[0]).split(';')[0] : null });
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  const login = (username, password) => request('POST', '/api/auth/login', { body: { username, password } });

  it('keeps /api/admin to administrators', async function () {
    const bob = await signIn(server, { username: 'bob', role: 'user' });
    assert.strictEqual((await request('GET', '/api/admin/users', { cookie: bob.cookie })).status, 403);
    assert.strictEqual((await request('POST', '/api/admin/invites', { cookie: bob.cookie, body: {} })).status, 403);
    const list = await request('GET', '/api/admin/users', { cookie: admin.cookie });
    assert.strictEqual(list.status, 200);
    assert.deepStrictEqual(list.json.users.map((u) => u.username), ['root', 'bob']);
    assert.ok(!('passwordHash' in list.json.users[0]));
  });

  it('a created user must change the one-time password before anything else', async function () {
    const created = await request('POST', '/api/admin/users', { cookie: admin.cookie, body: { username: 'newbie', role: 'user' } });
    assert.strictEqual(created.status, 200);
    const temp = created.json.password;
    assert.strictEqual(created.json.user.mustChangePassword, true);

    const signed = await login('newbie', temp);
    assert.strictEqual(signed.status, 200);
    assert.strictEqual(signed.json.user.mustChangePassword, true);
    const blocked = await request('GET', '/api/sessions/list', { cookie: signed.cookie });
    assert.strictEqual(blocked.status, 403);
    assert.strictEqual(blocked.json.code, 'password_change_required');
    assert.strictEqual(server.verifyWebSocketClient({ req: { headers: { cookie: signed.cookie, host: 'x' }, url: '/' } }), false);

    assert.strictEqual((await request('POST', '/api/auth/password', { cookie: signed.cookie, body: { current: 'wrong-pass', next: 'mine-12345' } })).status, 401);
    const changed = await request('POST', '/api/auth/password', { cookie: signed.cookie, body: { current: temp, next: 'mine-12345' } });
    assert.strictEqual(changed.status, 200);
    assert.strictEqual(changed.json.user.mustChangePassword, false);
    assert.strictEqual((await request('GET', '/api/sessions/list', { cookie: signed.cookie })).status, 200);
  });

  it('lists your devices and signs one out', async function () {
    const other = await login('root', 'password-123');
    const devices = await request('GET', '/api/auth/devices', { cookie: admin.cookie });
    assert.strictEqual(devices.json.devices.length, 2);
    const mine = devices.json.devices.find((d) => d.current);
    const theirs = devices.json.devices.find((d) => !d.current);
    assert.ok(mine && theirs);
    assert.strictEqual((await request('DELETE', `/api/auth/devices/${mine.id}`, { cookie: admin.cookie })).status, 400);
    assert.strictEqual((await request('DELETE', `/api/auth/devices/${theirs.id}`, { cookie: admin.cookie })).status, 200);
    assert.strictEqual((await request('GET', '/api/auth/me', { cookie: other.cookie })).status, 401);
    // Someone else's device id is not yours to end.
    const bob = await signIn(server, { username: 'bob', role: 'user' });
    const bobDevice = server.userStore.listLoginSessions(bob.user.id)[0].id;
    assert.strictEqual((await request('DELETE', `/api/auth/devices/${bobDevice}`, { cookie: admin.cookie })).status, 404);
  });

  it('changing your own password signs out your other devices only', async function () {
    const other = await login('root', 'password-123');
    const r = await request('POST', '/api/auth/password', { cookie: admin.cookie, body: { current: 'password-123', next: 'password-456' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.signedOut, 1);
    assert.strictEqual((await request('GET', '/api/auth/me', { cookie: admin.cookie })).status, 200);
    assert.strictEqual((await request('GET', '/api/auth/me', { cookie: other.cookie })).status, 401);
  });

  it('reset, disable and delete end the user\'s access; the data stays', async function () {
    const bob = await signIn(server, { username: 'bob', role: 'user' });
    const reset = await request('POST', `/api/admin/users/${bob.user.id}/reset-password`, { cookie: admin.cookie });
    assert.strictEqual(reset.status, 200);
    assert.strictEqual((await request('GET', '/api/auth/me', { cookie: bob.cookie })).status, 401);
    assert.strictEqual((await login('bob', reset.json.password)).json.user.mustChangePassword, true);

    const again = await login('bob', reset.json.password);
    const off = await request('PATCH', `/api/admin/users/${bob.user.id}`, { cookie: admin.cookie, body: { disabled: true } });
    assert.strictEqual(off.status, 200);
    assert.strictEqual(off.json.user.disabled, true);
    assert.strictEqual((await request('GET', '/api/auth/me', { cookie: again.cookie })).status, 401);
    assert.strictEqual((await login('bob', reset.json.password)).status, 401);

    fs.mkdirSync(path.join(dir, bob.user.id, 'sessions'), { recursive: true });
    const del = await request('DELETE', `/api/admin/users/${bob.user.id}`, { cookie: admin.cookie });
    assert.strictEqual(del.status, 200);
    assert.strictEqual(server.userStore.getUser(bob.user.id), null);
    assert.ok(fs.existsSync(path.join(dir, bob.user.id, 'sessions')), 'the data directory is kept');
  });

  it('never leaves the instance without an administrator, and not by your own hand', async function () {
    const self = admin.user.id;
    assert.strictEqual((await request('PATCH', `/api/admin/users/${self}`, { cookie: admin.cookie, body: { disabled: true } })).status, 400);
    assert.strictEqual((await request('PATCH', `/api/admin/users/${self}`, { cookie: admin.cookie, body: { role: 'user' } })).status, 400);
    assert.strictEqual((await request('DELETE', `/api/admin/users/${self}`, { cookie: admin.cookie })).status, 400);
    assert.strictEqual((await request('POST', `/api/admin/users/${self}/reset-password`, { cookie: admin.cookie })).status, 400);

    const second = await signIn(server, { username: 'second', role: 'admin' });
    // The other admin can demote root now that a second admin exists...
    assert.strictEqual((await request('PATCH', `/api/admin/users/${self}`, { cookie: second.cookie, body: { role: 'user' } })).status, 200);
    // ...but not then disable the last one standing (itself excluded above).
    const third = await signIn(server, { username: 'third', role: 'admin' });
    assert.strictEqual((await request('PATCH', `/api/admin/users/${third.user.id}`, { cookie: second.cookie, body: { disabled: true } })).status, 200);
  });

  it('validates rootDirs: existing absolute directories only', async function () {
    const bob = await signIn(server, { username: 'bob', role: 'user' });
    const bad = await request('PATCH', `/api/admin/users/${bob.user.id}`, { cookie: admin.cookie, body: { rootDirs: [work, 'relative/dir', path.join(work, 'missing')] } });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.json.rejected.length, 2);
    const ok = await request('PATCH', `/api/admin/users/${bob.user.id}`, { cookie: admin.cookie, body: { rootDirs: [work, work] } });
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(ok.json.user.rootDirs, [work]);
    assert.deepStrictEqual(ok.json.user.effectiveRoots, [work]);
  });

  it('a regular user browses only their own directories; an admin anywhere', async function () {
    const bob = await signIn(server, { username: 'bob', role: 'user' });
    const workspace = path.join(dir, bob.user.id, 'workspace');

    const config = await request('GET', '/api/config', { cookie: bob.cookie });
    assert.strictEqual(config.json.homeDir, workspace);
    assert.ok(fs.existsSync(workspace), 'the default workspace is made on first use');

    const inside = await request('GET', `/api/fs/list?path=${encodeURIComponent(workspace)}`, { cookie: bob.cookie });
    assert.strictEqual(inside.status, 200);
    assert.strictEqual(inside.json.parent, null, 'no way up out of the root');
    const outside = await request('GET', `/api/fs/list?path=${encodeURIComponent(work)}`, { cookie: bob.cookie });
    assert.strictEqual(outside.status, 403);
    const create = await request('POST', '/api/sessions/create', { cookie: bob.cookie, body: { workingDir: work } });
    assert.strictEqual(create.status, 403);
    const createHome = await request('POST', '/api/sessions/create', { cookie: bob.cookie, body: {} });
    assert.strictEqual(createHome.status, 200);
    assert.strictEqual(server.claudeSessions.get(createHome.json.sessionId).workingDir, workspace);

    assert.strictEqual((await request('GET', `/api/fs/list?path=${encodeURIComponent(work)}`, { cookie: admin.cookie })).status, 200);

    server.userStore.updateUser(bob.user.id, { rootDirs: [work] });
    assert.strictEqual((await request('GET', `/api/fs/list?path=${encodeURIComponent(work)}`, { cookie: bob.cookie })).status, 200);
    assert.strictEqual((await request('GET', `/api/fs/list?path=${encodeURIComponent(workspace)}`, { cookie: bob.cookie })).status, 403);
  });

  it('signs up with an invite link and is signed in', async function () {
    const inv = await request('POST', '/api/admin/invites', { cookie: admin.cookie, body: { role: 'user', days: 3 } });
    assert.strictEqual(inv.status, 200);
    const code = inv.json.invite.code;
    assert.strictEqual((await request('GET', '/api/admin/invites', { cookie: admin.cookie })).json.invites.length, 1);

    const reg = await request('POST', '/api/auth/register', { body: { invite: code, username: 'joiner', password: 'password-123' } });
    assert.strictEqual(reg.status, 200);
    assert.strictEqual(reg.json.user.role, 'user');
    assert.strictEqual((await request('GET', '/api/auth/me', { cookie: reg.cookie })).status, 200);
    assert.strictEqual((await request('POST', '/api/auth/register', { body: { invite: code, username: 'twice', password: 'password-123' } })).status, 400);
    assert.strictEqual((await request('GET', '/api/admin/invites', { cookie: admin.cookie })).json.invites.length, 0);

    const revoked = await request('POST', '/api/admin/invites', { cookie: admin.cookie, body: {} });
    assert.strictEqual((await request('DELETE', `/api/admin/invites/${revoked.json.invite.code}`, { cookie: admin.cookie })).status, 200);
    assert.strictEqual((await request('POST', '/api/auth/register', { body: { invite: revoked.json.invite.code, username: 'late', password: 'password-123' } })).status, 400);
  });

  it('closes the sockets of a login the CLI revoked, within one sweep', async function () {
    const bob = await signIn(server, { username: 'bob', role: 'user' });
    const loginId = server.userStore.listLoginSessions(bob.user.id)[0].id;
    let closed = null;
    server.webSocketConnections.set('ws-test', { id: 'ws-test', userId: bob.user.id, loginId, ws: { close: (code) => { closed = code; } } });
    server.sweepRevokedAccess();
    assert.strictEqual(closed, null);
    await new Promise((r) => setTimeout(r, 5));
    const cli = new UserStore(() => path.join(dir, 'platform'));
    await cli.setPassword(bob.user.id, 'password-999', { revokeAll: true });
    const t = new Date(Date.now() + 2000);
    fs.utimesSync(path.join(dir, 'platform', 'users'), t, t);
    server.sweepRevokedAccess();
    assert.strictEqual(closed, 4001);
    server.webSocketConnections.delete('ws-test');
  });
});

describe('cc-web user (M4)', function () {
  let dir;
  const run = async (...argv) => {
    const out = [];
    const err = [];
    const code = await userCli.main([...argv, '--data-dir', dir], { out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  beforeEach(function () { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-m4-cli-')); });
  afterEach(function () { fs.rmSync(dir, { recursive: true, force: true }); });

  it('adds, lists, resets, disables and changes roles', async function () {
    const added = await run('add', 'alice', '--admin');
    assert.strictEqual(added.code, 0);
    const temp = added.out.match(/临时密码：(\S+)/)[1];
    const store = new UserStore(() => path.join(dir, 'platform'));
    assert.ok(await store.verifyLogin('alice', temp));
    assert.strictEqual(store.findByUsername('alice').mustChangePassword, true);

    assert.strictEqual((await run('add', 'bob')).code, 0);
    assert.match((await run('list')).out, /alice\tu-[0-9a-f]{8}\t管理员，待改密码\nbob\t/);

    const disableLast = await run('disable', 'alice');
    assert.strictEqual(disableLast.code, 1);
    assert.match(disableLast.err, /至少要保留一个可用的管理员/);
    assert.strictEqual((await run('role', 'bob', 'admin')).code, 0);
    assert.strictEqual((await run('disable', 'alice')).code, 0);
    assert.strictEqual((await run('enable', 'alice')).code, 0);

    const reset = await run('passwd', 'bob');
    assert.strictEqual(reset.code, 0);
    assert.match(reset.out, /临时密码：\S+/);
    assert.strictEqual((await run('passwd', 'nobody')).code, 1);
    assert.strictEqual((await run('frobnicate')).code, 1);
  });
});
