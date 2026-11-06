const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { hashPassword, verifyPassword, safeEqual } = require('../src/utils/password');
const { parseCookies, serializeCookie } = require('../src/utils/cookies');
const UserStore = require('../src/utils/user-store');
const { useTempDataDir, signIn } = require('./helpers/auth');

describe('password hashing', function () {
  it('verifies the right password and refuses a wrong one', async function () {
    const stored = await hashPassword('correct horse');
    assert.ok(stored.startsWith('scrypt$'));
    assert.strictEqual(await verifyPassword('correct horse', stored), true);
    assert.strictEqual(await verifyPassword('wrong horse', stored), false);
  });

  it('salts every hash', async function () {
    assert.notStrictEqual(await hashPassword('same'), await hashPassword('same'));
  });

  it('reads a malformed hash as a wrong password instead of throwing', async function () {
    assert.strictEqual(await verifyPassword('x', 'garbage'), false);
    assert.strictEqual(await verifyPassword('x', null), false);
    assert.strictEqual(await verifyPassword('x', 'scrypt$1$1$1$$'), false);
  });

  it('compares secrets of different lengths without throwing', function () {
    assert.strictEqual(safeEqual('abc', 'abc'), true);
    assert.strictEqual(safeEqual('abc', 'abcd'), false);
    assert.strictEqual(safeEqual('abc', undefined), false);
  });
});

describe('cookies', function () {
  it('parses a Cookie header and ignores junk', function () {
    assert.deepStrictEqual(parseCookies('a=1; b=two%20words; junk; c="q"'), { a: '1', b: 'two words', c: 'q' });
    assert.deepStrictEqual(parseCookies(undefined), {});
  });

  it('writes an HttpOnly, SameSite=Strict cookie', function () {
    const c = serializeCookie('n', 'v', { maxAge: 60, secure: true });
    assert.strictEqual(c, 'n=v; Path=/; Max-Age=60; HttpOnly; SameSite=Strict; Secure');
  });
});

describe('UserStore', function () {
  let dir;
  let store;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-users-'));
    store = new UserStore(() => dir);
  });

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates a user on disk without the plain password', async function () {
    const u = await store.createUser({ username: 'alice', password: 'password-1', role: 'admin' });
    assert.ok(/^u-[0-9a-f]{8}$/.test(u.id));
    const raw = fs.readFileSync(path.join(dir, 'users', `${u.id}.json`), 'utf8');
    assert.ok(!raw.includes('password-1'));
    const fresh = new UserStore(() => dir);
    assert.strictEqual(fresh.findByUsername('ALICE').id, u.id, 'usernames match case-insensitively');
    assert.strictEqual(fresh.firstAdmin().id, u.id);
  });

  it('refuses a duplicate username, a bad username and a short password', async function () {
    await store.createUser({ username: 'alice', password: 'password-1' });
    await assert.rejects(store.createUser({ username: 'Alice', password: 'password-1' }), /already exists/);
    await assert.rejects(store.createUser({ username: '../x', password: 'password-1' }), /Username/);
    await assert.rejects(store.createUser({ username: 'bob', password: 'short' }), /at least 8/);
  });

  it('verifies a login, and refuses unknown users and disabled users', async function () {
    const u = await store.createUser({ username: 'alice', password: 'password-1' });
    assert.strictEqual((await store.verifyLogin('alice', 'password-1')).id, u.id);
    assert.strictEqual(await store.verifyLogin('alice', 'nope-nope'), null);
    assert.strictEqual(await store.verifyLogin('nobody', 'password-1'), null);
    u.disabled = true;
    assert.strictEqual(await store.verifyLogin('alice', 'password-1'), null);
  });

  it('keeps login sessions across a reload, stored by hash only', async function () {
    const u = await store.createUser({ username: 'alice', password: 'password-1' });
    const sid = store.createLoginSession(u.id, { ua: 'ua' });
    const files = fs.readdirSync(path.join(dir, 'login-sessions'));
    assert.strictEqual(files.length, 1);
    assert.ok(!files[0].includes(sid) && !fs.readFileSync(path.join(dir, 'login-sessions', files[0]), 'utf8').includes(sid));
    const fresh = new UserStore(() => dir);
    assert.strictEqual(fresh.getLoginSession(sid).user.id, u.id);
    assert.strictEqual(fresh.getLoginSession('not-a-session'), null);
  });

  it('drops expired sessions and deleted ones', async function () {
    const u = await store.createUser({ username: 'alice', password: 'password-1' });
    const sid = store.createLoginSession(u.id);
    const [record] = [...store.loginSessions.values()];
    record.expiresAt = new Date(Date.now() - 1000).toISOString();
    assert.strictEqual(store.getLoginSession(sid), null);
    assert.strictEqual(fs.readdirSync(path.join(dir, 'login-sessions')).length, 0);

    const sid2 = store.createLoginSession(u.id);
    assert.ok(store.getLoginSession(sid2));
    store.deleteLoginSession(sid2);
    assert.strictEqual(store.getLoginSession(sid2), null);
  });

  it('slides the expiry forward on use', async function () {
    const u = await store.createUser({ username: 'alice', password: 'password-1' });
    const sid = store.createLoginSession(u.id);
    const [record] = [...store.loginSessions.values()];
    const old = new Date(Date.now() - UserStore.TOUCH_EVERY_MS - 1000).toISOString();
    record.lastSeenAt = old;
    record.expiresAt = new Date(Date.now() + 1000).toISOString();
    store.getLoginSession(sid);
    assert.ok(Date.parse(record.expiresAt) > Date.now() + UserStore.SESSION_TTL_MS - 60000);
  });
});

describe('login over HTTP', function () {
  const { ClaudeCodeWebServer } = require('../src/server');
  let server;
  let listener;
  let port;
  let dir;

  beforeEach(function (done) {
    server = new ClaudeCodeWebServer({ auth: 'tok-start', folderMode: false, port: 40123 });
    dir = useTempDataDir(server);
    listener = http.createServer(server.app).listen(0, '127.0.0.1', () => {
      port = listener.address().port;
      done();
    });
  });

  afterEach(function () {
    listener.close();
    if (server && typeof server.dispose === 'function') server.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function request(method, p, { body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const req = http.request({
        host: '127.0.0.1', port, path: p, method,
        headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
      }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch (_) { /* not json */ }
          resolve({ status: res.statusCode, json, headers: res.headers });
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }
  const cookieOf = (res) => (res.headers['set-cookie'] || [])[0] || '';
  const pair = (setCookie) => setCookie.split(';')[0];

  it('reports setup as required until an administrator exists', async function () {
    let s = await request('GET', '/auth-status');
    assert.deepStrictEqual(s.json, { authRequired: true, authenticated: false, user: null, setupRequired: true });
    await signIn(server);
    s = await request('GET', '/auth-status');
    assert.strictEqual(s.json.setupRequired, false);
  });

  it('creates the first administrator only with the startup token, and only once', async function () {
    let r = await request('POST', '/api/auth/setup', { body: { token: 'wrong', username: 'root', password: 'password-123' } });
    assert.strictEqual(r.status, 401);
    r = await request('POST', '/api/auth/setup', { body: { token: 'tok-start', username: 'root', password: 'password-123' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.user.role, 'admin');
    const setCookie = cookieOf(r);
    assert.ok(setCookie.startsWith('ccw_sid_40123='), 'cookie name carries the port');
    assert.ok(/HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie) && /Max-Age=2592000/.test(setCookie));
    r = await request('POST', '/api/auth/setup', { body: { token: 'tok-start', username: 'second', password: 'password-123' } });
    assert.strictEqual(r.status, 409);
  });

  it('signs in with a password and the cookie opens the REST routes', async function () {
    await signIn(server, { username: 'alice', password: 'password-123' });
    let r = await request('POST', '/api/auth/login', { body: { username: 'alice', password: 'nope-nope' } });
    assert.strictEqual(r.status, 401);
    r = await request('POST', '/api/auth/login', { body: { username: 'alice', password: 'password-123' } });
    assert.strictEqual(r.status, 200);
    const cookie = pair(cookieOf(r));
    assert.strictEqual((await request('GET', '/api/health')).status, 401);
    assert.strictEqual((await request('GET', '/api/health', { headers: { Cookie: cookie } })).status, 200);
    const me = await request('GET', '/api/auth/me', { headers: { Cookie: cookie } });
    assert.strictEqual(me.json.user.username, 'alice');
    const status = await request('GET', '/auth-status', { headers: { Cookie: cookie } });
    assert.strictEqual(status.json.authenticated, true);
  });

  it('a cookie for another port does not count', async function () {
    const { sid } = await signIn(server);
    assert.strictEqual((await request('GET', '/api/health', { headers: { Cookie: `ccw_sid_32352=${sid}` } })).status, 401);
  });

  it('logout ends the session', async function () {
    const { cookie } = await signIn(server);
    const r = await request('POST', '/api/auth/logout', { headers: { Cookie: cookie } });
    assert.strictEqual(r.status, 200);
    assert.ok(/Max-Age=0/.test(cookieOf(r)));
    assert.strictEqual((await request('GET', '/api/health', { headers: { Cookie: cookie } })).status, 401);
  });

  it('refuses a cross-origin write that rides on the cookie', async function () {
    const { cookie } = await signIn(server);
    const evil = { Cookie: cookie, Origin: 'http://evil.example' };
    assert.strictEqual((await request('POST', '/api/spaces', { body: { name: 'x', dir: os.tmpdir() }, headers: evil })).status, 403);
    assert.strictEqual((await request('GET', '/api/health', { headers: evil })).status, 200, 'reads are not refused');
    const same = { Cookie: cookie, Origin: `http://127.0.0.1:${port}` };
    assert.notStrictEqual((await request('POST', '/api/spaces', { body: { name: 'x', dir: os.tmpdir() }, headers: same })).status, 403);
  });

  it('rate-limits login attempts', async function () {
    await signIn(server, { username: 'alice', password: 'password-123' });
    let last;
    for (let i = 0; i < 11; i++) {
      last = await request('POST', '/api/auth/login', { body: { username: 'alice', password: 'wrong-pass' } });
    }
    assert.strictEqual(last.status, 429);
  });

  it('the startup token keeps working and, once an admin exists, is exchanged for a cookie', async function () {
    assert.strictEqual((await request('GET', '/api/health', { headers: { Authorization: 'Bearer tok-start' } })).status, 200);
    let r = await request('POST', '/auth-verify', { body: { token: 'tok-start' } });
    assert.deepStrictEqual(r.json, { valid: true, session: false, setupRequired: true });
    assert.strictEqual(cookieOf(r), '');
    await signIn(server);
    r = await request('POST', '/auth-verify', { body: { token: 'tok-start' } });
    assert.strictEqual(r.json.session, true);
    const cookie = pair(cookieOf(r));
    assert.strictEqual((await request('GET', '/api/health', { headers: { Cookie: cookie } })).status, 200);
    assert.strictEqual((await request('POST', '/auth-verify', { body: { token: 'nope' } })).status, 401);
  });

  it('plan and file links authenticate by cookie with "-" in the token slot', async function () {
    const { cookie } = await signIn(server);
    const file = path.join(dir, 'note.txt');
    fs.writeFileSync(file, 'hi');
    const url = `/api/fs/file/-/${encodeURIComponent(file)}`;
    assert.strictEqual((await request('GET', url)).status, 401);
    assert.strictEqual((await request('GET', url, { headers: { Cookie: cookie } })).status, 200);
    assert.strictEqual((await request('GET', `/api/fs/file/tok-start/${encodeURIComponent(file)}`)).status, 200, 'token links still work');
    const plan = `/api/plan/-/-/${encodeURIComponent(path.join(dir, 'missing.md'))}`;
    assert.strictEqual((await request('GET', plan)).status, 401);
    assert.strictEqual((await request('GET', plan, { headers: { Cookie: cookie } })).status, 404, 'past auth, not on the allow-list');
  });

  it('two first-admin setups racing for different names: only one wins', async function () {
    const body = (username) => ({ body: { token: 'tok-start', username, password: 'password-123' } });
    const [a, b] = await Promise.all([request('POST', '/api/auth/setup', body('alice')), request('POST', '/api/auth/setup', body('bob'))]);
    assert.deepStrictEqual([a.status, b.status].sort(), [200, 409]);
    assert.strictEqual(server.userStore.listUsers().length, 1);
  });

  it('re-sends the cookie when the server slides the expiry, so the browser copy slides too', async function () {
    const { cookie } = await signIn(server);
    let r = await request('GET', '/api/health', { headers: { Cookie: cookie } });
    assert.strictEqual(cookieOf(r), '', 'not on every request');
    const [record] = [...server.userStore.loginSessions.values()];
    record.lastSeenAt = new Date(Date.now() - UserStore.TOUCH_EVERY_MS - 1000).toISOString();
    r = await request('GET', '/api/health', { headers: { Cookie: cookie } });
    assert.ok(cookieOf(r).startsWith(`${cookie};`) && /Max-Age=2592000/.test(cookieOf(r)));
  });

  it('a client the address limit refused does not lock the account for others', async function () {
    await signIn(server, { username: 'alice', password: 'password-123' });
    const from = (ip) => ({ 'X-Forwarded-For': ip });
    for (let i = 0; i < 15; i++) {
      await request('POST', '/api/auth/login', { body: { username: 'alice', password: 'wrong-pass' }, headers: from('10.0.0.1') });
    }
    const r = await request('POST', '/api/auth/login', { body: { username: 'alice', password: 'password-123' }, headers: from('10.0.0.2') });
    assert.strictEqual(r.status, 200);
  });

  it('marks the cookie Secure when a local proxy or tunnel says the request was https', async function () {
    await signIn(server, { username: 'alice', password: 'password-123' });
    const r = await request('POST', '/api/auth/login', { body: { username: 'alice', password: 'password-123' }, headers: { 'X-Forwarded-Proto': 'https' } });
    assert.ok(/; Secure/.test(cookieOf(r)));
    const plain = await request('POST', '/api/auth/login', { body: { username: 'alice', password: 'password-123' } });
    assert.ok(!/Secure/.test(cookieOf(plain)));
  });

  it('logout closes the sockets that login opened, and only those', async function () {
    const mine = await signIn(server);
    const other = await signIn(server);
    const closed = [];
    const fakeWs = (name) => ({ close: () => closed.push(name) });
    const idOf = (c) => server.cookieLogin({ headers: { cookie: c } }).session.id;
    server.webSocketConnections.set('a', { ws: fakeWs('a'), loginId: idOf(mine.cookie) });
    server.webSocketConnections.set('b', { ws: fakeWs('b'), loginId: idOf(other.cookie) });
    server.webSocketConnections.set('c', { ws: fakeWs('c'), loginId: null });
    await request('POST', '/api/auth/logout', { headers: { Cookie: mine.cookie } });
    assert.deepStrictEqual(closed, ['a']);
  });

  it('sweeps expired login sessions on the next sign-in', async function () {
    await signIn(server);
    const [record] = [...server.userStore.loginSessions.values()];
    record.expiresAt = new Date(Date.now() - 1000).toISOString();
    await signIn(server);
    assert.strictEqual(server.userStore.loginSessions.size, 1);
    assert.strictEqual(fs.readdirSync(path.join(dir, 'platform', 'login-sessions')).length, 1);
  });

  it('after 10 wrong tokens in a minute an address is refused, even the right token', async function () {
    const from = { 'X-Forwarded-For': '10.0.0.9' };
    for (let i = 0; i < 10; i++) {
      assert.strictEqual((await request('GET', '/api/health', { headers: { ...from, Authorization: 'Bearer nope' } })).status, 401);
    }
    assert.strictEqual((await request('GET', '/api/health', { headers: { ...from, Authorization: 'Bearer tok-start' } })).status, 429);
    assert.strictEqual((await request('POST', '/auth-verify', { body: { token: 'tok-start' }, headers: from })).status, 429);
    assert.strictEqual((await request('GET', '/api/fs/file/tok-start/x', { headers: from })).status, 429);
    assert.strictEqual(server.verifyWebSocketClient({ req: { url: '/?token=tok-start', headers: { host: 'h', 'x-forwarded-for': '10.0.0.9' }, socket: { remoteAddress: '127.0.0.1' } } }), false);
    assert.strictEqual((await request('GET', '/api/health', { headers: { 'X-Forwarded-For': '10.0.0.10', Authorization: 'Bearer tok-start' } })).status, 200, 'other addresses are unaffected');
  });

  it('no token and the "-" placeholder are not counted as guesses', async function () {
    const from = { 'X-Forwarded-For': '10.0.0.11' };
    for (let i = 0; i < 12; i++) {
      await request('GET', '/api/health', { headers: from });
      await request('GET', '/api/fs/file/-/x', { headers: from });
    }
    assert.strictEqual((await request('GET', '/api/health', { headers: { ...from, Authorization: 'Bearer tok-start' } })).status, 200);
  });

  it('the WebSocket accepts a same-origin cookie or the query token', async function () {
    const { cookie, user } = await signIn(server);
    const info = (url, headers) => ({ req: { url, headers: { host: 'h:1', ...headers } } });
    let i = info('/?sessionId=x', { cookie });
    assert.strictEqual(server.verifyWebSocketClient(i), true);
    assert.strictEqual(i.req.ccwUser.id, user.id);
    assert.strictEqual(server.verifyWebSocketClient(info('/', { cookie, origin: 'http://evil.example' })), false);
    assert.strictEqual(server.verifyWebSocketClient(info('/', { cookie, origin: 'http://h:1' })), true);
    assert.strictEqual(server.verifyWebSocketClient(info('/?token=tok-start', {})), true);
    assert.strictEqual(server.verifyWebSocketClient(info('/?token=nope', {})), false);
    assert.strictEqual(server.verifyWebSocketClient(info('/', {})), false);
  });
});
