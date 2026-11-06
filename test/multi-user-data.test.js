const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const { ClaudeCodeWebServer } = require('../src/server');
const { useTempDataDir, signIn } = require('./helpers/auth');

// M2: every session, space and per-user setting belongs to one user. Another
// user's ids behave as if they did not exist, over REST and the WebSocket.
describe('per-user data (M2)', function () {
  let server;
  let listener;
  let port;
  let dir;
  let work;
  let alice;
  let bob;

  beforeEach(async function () {
    server = new ClaudeCodeWebServer({ auth: 'tok-m2', folderMode: false, port: 40124 });
    dir = useTempDataDir(server);
    await server._initialLoad;
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-work-'));
    alice = await signIn(server, { username: 'alice', role: 'admin' });
    bob = await signIn(server, { username: 'bob', role: 'user' });
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

  function request(method, p, { body, cookie, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const req = http.request({
        host: '127.0.0.1', port, path: p, method,
        headers: {
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
      }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch (_) { /* not json */ }
          resolve({ status: res.statusCode, json });
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  async function createAs(who, name = 'task') {
    const r = await request('POST', '/api/sessions/create', { cookie: who.cookie, body: { name, workingDir: work } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    return r.json.sessionId;
  }

  it('a new session belongs to its creator and only they can see or touch it', async function () {
    const id = await createAs(alice);
    assert.strictEqual(server.claudeSessions.get(id).ownerId, alice.user.id);

    const mine = await request('GET', '/api/sessions/list', { cookie: alice.cookie });
    assert.deepStrictEqual(mine.json.sessions.map((s) => s.id), [id]);
    const theirs = await request('GET', '/api/sessions/list', { cookie: bob.cookie });
    assert.deepStrictEqual(theirs.json.sessions, []);

    const asBob = { cookie: bob.cookie };
    assert.strictEqual((await request('GET', `/api/sessions/${id}`, asBob)).status, 404);
    assert.strictEqual((await request('GET', `/api/sessions/${id}/prompts`, asBob)).status, 404);
    assert.strictEqual((await request('PATCH', `/api/sessions/${id}`, { ...asBob, body: { name: 'mine now' } })).status, 404);
    assert.strictEqual((await request('DELETE', `/api/sessions/${id}`, asBob)).status, 404);
    assert.strictEqual((await request('GET', `/api/plan-dirs?sessionId=${id}`, asBob)).status, 400);
    assert.strictEqual((await request('POST', '/api/plan-dirs', { ...asBob, body: { sessionId: id, dirs: [] } })).status, 400);
    assert.strictEqual((await request('POST', `/api/hooks/${id}/answer`, { ...asBob, body: { call_id: 'x', decision: 'allow' } })).status, 404);
    assert.strictEqual((await request('POST', `/api/upload-image?sessionId=${id}`, asBob)).status, 404);
    assert.ok(server.claudeSessions.has(id), 'still there');
    assert.strictEqual(server.claudeSessions.get(id).name, 'task');

    assert.strictEqual((await request('GET', `/api/sessions/${id}`, { cookie: alice.cookie })).status, 200);
    assert.strictEqual((await request('DELETE', `/api/sessions/${id}`, { cookie: alice.cookie })).status, 200);
    assert.ok(!server.claudeSessions.has(id));
  });

  it('health and persistence counts are the caller\'s own', async function () {
    await createAs(alice);
    await createAs(alice);
    await createAs(bob);
    assert.strictEqual((await request('GET', '/api/health', { cookie: alice.cookie })).json.claudeSessions, 2);
    assert.strictEqual((await request('GET', '/api/health', { cookie: bob.cookie })).json.claudeSessions, 1);
    assert.strictEqual((await request('GET', '/api/sessions/persistence', { cookie: bob.cookie })).json.currentSessions, 1);
  });

  it('spaces are per user', async function () {
    const made = await request('POST', '/api/spaces', { cookie: alice.cookie, body: { name: 'proj', dir: work } });
    assert.strictEqual(made.status, 200);
    const spaceId = made.json.space.id;
    assert.strictEqual((await request('GET', '/api/spaces', { cookie: bob.cookie })).json.spaces.length, 0);
    assert.strictEqual((await request('PATCH', `/api/spaces/${spaceId}`, { cookie: bob.cookie, body: { name: 'x' } })).status, 404);
    assert.strictEqual((await request('DELETE', `/api/spaces/${spaceId}`, { cookie: bob.cookie })).status, 404);

    // Bob's task in the same folder does not land in Alice's space, and he
    // cannot move a task of his into it.
    const bobTask = await createAs(bob);
    assert.strictEqual(server.claudeSessions.get(bobTask).spaceId || null, null);
    assert.strictEqual((await request('PATCH', `/api/sessions/${bobTask}`, { cookie: bob.cookie, body: { spaceId } })).status, 400);
    const aliceTask = await createAs(alice);
    assert.strictEqual(server.claudeSessions.get(aliceTask).spaceId, spaceId);

    assert.ok(fs.existsSync(path.join(dir, alice.user.id, 'spaces.json')));
    assert.ok(!fs.existsSync(path.join(dir, bob.user.id, 'spaces.json')));
  });

  it('sessions are saved into, and loaded back from, their owner\'s folder', async function () {
    const a = await createAs(alice);
    const b = await createAs(bob);
    await server.saveSessionsToDisk();
    assert.ok(fs.existsSync(path.join(dir, alice.user.id, 'sessions', `${a}.json`)));
    assert.ok(fs.existsSync(path.join(dir, bob.user.id, 'sessions', `${b}.json`)));
    assert.ok(!fs.existsSync(path.join(dir, 'sessions', `${a}.json`)));

    const again = new ClaudeCodeWebServer({ auth: 'tok-m2', folderMode: false });
    again.sessionStore.storageDir = dir;
    again.spaceStore.storageDir = dir;
    again.userStore.users = null;
    await again._initialLoad;
    assert.strictEqual(again.claudeSessions.get(a).ownerId, alice.user.id);
    assert.strictEqual(again.claudeSessions.get(b).ownerId, bob.user.id);
    again.dispose();
  });

  it('scrollback is a per-user setting', async function () {
    const before = (await request('GET', '/api/settings/scrollback', { cookie: bob.cookie })).json.bytes;
    const set = await request('POST', '/api/settings/scrollback', { cookie: alice.cookie, body: { bytes: 4 * 1024 * 1024 } });
    assert.strictEqual(set.status, 200);
    assert.strictEqual((await request('GET', '/api/settings/scrollback', { cookie: alice.cookie })).json.bytes, 4 * 1024 * 1024);
    assert.strictEqual((await request('GET', '/api/settings/scrollback', { cookie: bob.cookie })).json.bytes, before);
    assert.ok(fs.existsSync(path.join(dir, alice.user.id, 'scrollback.json')));
  });

  it('a conversation held by another user is refused without naming their session', async function () {
    const convId = uuidv4();
    server.claudeSessions.set(convId, {
      id: convId, ownerId: alice.user.id, name: 'held', workingDir: work,
      connections: new Set(), outputBuffer: [], active: false,
    });
    const byBob = await request('POST', '/api/sessions/create', { cookie: bob.cookie, body: { workingDir: work, resumeId: convId } });
    assert.strictEqual(byBob.status, 409);
    assert.strictEqual(byBob.json.sessionId, undefined);
    assert.ok(/其他用户/.test(byBob.json.message));
    const byAlice = await request('POST', '/api/sessions/create', { cookie: alice.cookie, body: { workingDir: work, resumeId: convId } });
    assert.strictEqual(byAlice.status, 409);
    assert.strictEqual(byAlice.json.sessionId, convId, 'her own tab is still offered');
  });

  it('the WebSocket only joins, auto-joins and stops the user\'s own sessions', async function () {
    const id = await createAs(alice);
    const sent = [];
    const fakeWs = { readyState: 1, send: (m) => sent.push(JSON.parse(m)), close() {} };
    server.webSocketConnections.set('ws-bob', { id: 'ws-bob', ws: fakeWs, claudeSessionId: null, userId: bob.user.id });
    await server.handleMessage('ws-bob', { type: 'join_session', sessionId: id });
    assert.strictEqual(server.webSocketConnections.get('ws-bob').claudeSessionId, null);
    assert.ok(sent.some((m) => m.type === 'error' && /Session not found/.test(m.message)));
    assert.ok(!server.claudeSessions.get(id).connections.has('ws-bob'));

    server.webSocketConnections.set('ws-alice', { id: 'ws-alice', ws: fakeWs, claudeSessionId: null, userId: alice.user.id });
    await server.handleMessage('ws-alice', { type: 'join_session', sessionId: id });
    assert.strictEqual(server.webSocketConnections.get('ws-alice').claudeSessionId, id);

    // A socket created over the WebSocket belongs to that socket's user.
    await server.handleMessage('ws-bob', { type: 'create_session', name: 'ws task', workingDir: work });
    const created = server.webSocketConnections.get('ws-bob').claudeSessionId;
    assert.strictEqual(server.claudeSessions.get(created).ownerId, bob.user.id);
  });

  it('plan links only search the caller\'s own sessions', async function () {
    const plans = path.join(work, '.claude', 'plans');
    fs.mkdirSync(plans, { recursive: true });
    fs.writeFileSync(path.join(plans, 'p.md'), '# plan');
    const id = await createAs(alice);
    const file = encodeURIComponent(path.join(plans, 'p.md'));
    assert.strictEqual((await request('GET', `/api/plan/-/-/${file}`, { cookie: alice.cookie })).status, 200);
    assert.strictEqual((await request('GET', `/api/plan/-/${id}/${file}`, { cookie: alice.cookie })).status, 200);
    assert.strictEqual((await request('GET', `/api/plan/-/-/${file}`, { cookie: bob.cookie })).status, 404);
    assert.strictEqual((await request('GET', `/api/plan/-/${id}/${file}`, { cookie: bob.cookie })).status, 404);
  });
});

describe('handing single-user data to the first administrator (M2)', function () {
  let server;
  let dir;

  beforeEach(async function () {
    server = new ClaudeCodeWebServer({ auth: 'tok-mig', folderMode: false, port: 40125 });
    dir = useTempDataDir(server);
    await server._initialLoad;
  });

  afterEach(function () {
    if (server) server.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Data written the way a single-user install has it: at the data dir root.
  function seedLegacy() {
    const id = uuidv4();
    const session = { id, name: 'old', workingDir: os.tmpdir(), created: new Date(), lastActivity: new Date(), connections: new Set(), outputBuffer: [] };
    server.claudeSessions.set(id, session);
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sessions', `${id}.json`), JSON.stringify({ id, name: 'old', workingDir: os.tmpdir() }));
    fs.writeFileSync(path.join(dir, 'spaces.json'), '[]');
    fs.writeFileSync(path.join(dir, 'scrollback.json'), JSON.stringify({ bytes: 1024 * 1024 }));
    server.spaces = [{ id: uuidv4(), name: 'old space', dir: os.tmpdir() }];
    return id;
  }

  it('does nothing while there is no administrator', async function () {
    seedLegacy();
    assert.strictEqual(await server.migrateUnownedToAdmin(), false);
    assert.ok(fs.existsSync(path.join(dir, 'sessions')));
  });

  it('moves files into the admin\'s folder, keeps a copy of scrollback, and assigns the sessions', async function () {
    const id = seedLegacy();
    const { user } = await signIn(server, { username: 'root', role: 'admin' });
    assert.strictEqual(await server.migrateUnownedToAdmin(), true);

    const target = path.join(dir, user.id);
    assert.ok(fs.existsSync(path.join(target, 'sessions', `${id}.json`)));
    assert.ok(!fs.existsSync(path.join(dir, 'sessions', `${id}.json`)), 'moved, not copied');
    assert.ok(fs.existsSync(path.join(target, 'spaces.json')));
    assert.ok(fs.existsSync(path.join(dir, 'scrollback.json')), 'scrollback original kept');
    assert.ok(fs.existsSync(path.join(target, 'scrollback.json')));
    assert.ok(fs.existsSync(path.join(dir, 'migrated-to-admin.json')));

    assert.strictEqual(server.claudeSessions.get(id).ownerId, user.id);
    assert.strictEqual(server.tenant(user.id).spaces[0].name, 'old space');
    assert.strictEqual(server.spaces.length, 0);
    assert.strictEqual(await server.migrateUnownedToAdmin(), false, 'once');
  });

  it('after the hand-over the root is not read again, so a legacy sessions.json cannot bring sessions back', async function () {
    seedLegacy();
    await signIn(server, { username: 'root', role: 'admin' });
    await server.migrateUnownedToAdmin();
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({ sessions: [{ id: uuidv4(), name: 'ghost' }] }));

    const again = new ClaudeCodeWebServer({ auth: 'tok-mig', folderMode: false });
    again.sessionStore.storageDir = dir;
    again.spaceStore.storageDir = dir;
    again.userStore.users = null;
    await again._initialLoad;
    const names = [...again.claudeSessions.values()].map((s) => s.name);
    assert.deepStrictEqual(names, ['old']);
    again.dispose();
  });

  it('never runs with authentication off', async function () {
    const off = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
    const offDir = useTempDataDir(off);
    await off._initialLoad;
    await signIn(off, { username: 'root', role: 'admin' });
    assert.strictEqual(await off.migrateUnownedToAdmin(), false);
    off.dispose();
    fs.rmSync(offDir, { recursive: true, force: true });
  });
});
