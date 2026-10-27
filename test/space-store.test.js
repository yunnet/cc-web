const assert = require('assert');
const fs = require('fs').promises;
const fsSync = require('fs');
const os = require('os');
const path = require('path');

const SpaceStore = require('../src/utils/space-store');
const { ClaudeCodeWebServer } = require('../src/server');

// Spaces are the sidebar's named working-directory groups; sessions point at
// one by id. These tests pin the store's file shape and the server's one-time
// migration (existing sessions grouped by their working dir) — the thing that
// decides what an upgrading install sees on day one.

const UUID = (n) => `0000000${n}-1111-2222-3333-444444444444`;

function withTempDir(prefix) {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const spaceOf = (over = {}) => ({
  id: UUID(1),
  name: 'cgs-master',
  dir: '/Users/dev/work/cgs-master',
  createdAt: '2026-10-26T00:00:00.000Z',
  updatedAt: '2026-10-26T00:00:00.000Z',
  ...over,
});

describe('SpaceStore', function () {
  let dir;
  let store;

  beforeEach(function () {
    dir = withTempDir('ccw-spaces-');
    process.env.CCW_DATA_DIR = dir;
    store = new SpaceStore();
  });

  afterEach(function () {
    delete process.env.CCW_DATA_DIR;
    try { fsSync.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  });

  it('round-trips a saved list', async function () {
    const spaces = [spaceOf(), spaceOf({ id: UUID(2), name: 'ts', dir: '/Users/dev/work/ai/ts' })];
    assert.strictEqual(await store.saveSpaces(spaces), true);
    const loaded = await store.loadSpaces();
    assert.deepStrictEqual(loaded, spaces);
    assert.strictEqual(store.fileExisted, true, 'a well-formed file counts as existing');
  });

  it('starts empty without the file, and migration is allowed', async function () {
    assert.deepStrictEqual(await store.loadSpaces(), []);
    assert.strictEqual(store.fileExisted, false);
  });

  it('degrades a corrupted file to an empty list instead of throwing', async function () {
    await fs.writeFile(store.spacesFile, '{not json', 'utf8');
    assert.deepStrictEqual(await store.loadSpaces(), []);
    // Corrupt counts as absent, so the one-time migration may rebuild the file.
    assert.strictEqual(store.fileExisted, false);
  });

  it('skips malformed entries but keeps the well-formed ones', async function () {
    await fs.writeFile(store.spacesFile, JSON.stringify([
      spaceOf(),
      { id: 'not-a-uuid', name: 'x', dir: '/y' },
      { id: UUID(2), name: '   ', dir: '/y' },   // blank name
      { id: UUID(3), name: 'ok', dir: 42 },      // dir not a string
    ]), 'utf8');
    const loaded = await store.loadSpaces();
    assert.strictEqual(loaded.length, 1);
    assert.strictEqual(loaded[0].name, 'cgs-master');
  });

  it('leaves no temp file behind on save', async function () {
    await store.saveSpaces([spaceOf()]);
    const leftovers = (await fs.readdir(dir)).filter(f => f.includes('.tmp'));
    assert.deepStrictEqual(leftovers, []);
  });

  describe('cleanName', function () {
    it('trims and bounds the name, sharing one answer with both routes', function () {
      assert.deepStrictEqual(SpaceStore.cleanName('  cgs  '), { name: 'cgs' });
      assert.ok(SpaceStore.cleanName('x').error === undefined);
      assert.ok(SpaceStore.cleanName(5).error, 'not a string');
      assert.ok(SpaceStore.cleanName('   ').error, 'blank');
      assert.ok(SpaceStore.cleanName('x'.repeat(201)).error, 'over 200 chars');
    });
  });
});

// The server half: routes + the one-time migration. Handlers are pulled off
// the router directly (the session-rename test's pattern) — the contract under
// test is the handler's, not Express's.
describe('spaces on the server', function () {
  function mockRes() {
    return {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(obj) { this.body = obj; return this; }
    };
  }

  let server;
  let dir;

  beforeEach(async function () {
    dir = withTempDir('ccw-spaces-srv-');
    process.env.CCW_DATA_DIR = dir;
    server = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
    // The constructor fires the initial load without awaiting; finish it
    // (against the empty temp dir) so it cannot race the scenarios below.
    await server._initialLoad;
  });

  afterEach(function () {
    delete process.env.CCW_DATA_DIR;
    if (server && typeof server.dispose === 'function') server.dispose();
    try { fsSync.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  });

  const route = (method, pathname) => {
    const layer = server.app._router.stack.find(
      l => l.route && l.route.path === pathname && l.route.methods[method]
    );
    assert.ok(layer, `${method.toUpperCase()} ${pathname} is registered`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  };

  const sessionOf = (id, over = {}) => ({
    id, name: `Session ${id}`, workingDir: '/Users/dev/work/cgs-master',
    created: new Date(), lastActivity: new Date(), connections: new Set(),
    outputBuffer: [], ...over,
  });

  describe('one-time migration (loadSpacesAndMigrate)', function () {
    it('groups existing sessions by working dir, one space per dir, and back-fills spaceId', async function () {
      server.claudeSessions.set(UUID(1), sessionOf(UUID(1)));
      server.claudeSessions.set(UUID(2), sessionOf(UUID(2), { workingDir: '/Users/dev/work/ai/ts' }));
      server.claudeSessions.set(UUID(3), sessionOf(UUID(3))); // same dir as s1

      await server.loadSpacesAndMigrate();

      assert.strictEqual(server.spaces.length, 2, 'one space per distinct dir');
      const byDir = new Map(server.spaces.map(s => [s.dir, s]));
      assert.strictEqual(byDir.get('/Users/dev/work/cgs-master').name, 'cgs-master');
      assert.strictEqual(byDir.get('/Users/dev/work/ai/ts').name, 'ts');
      assert.strictEqual(server.claudeSessions.get(UUID(1)).spaceId, byDir.get('/Users/dev/work/cgs-master').id);
      assert.strictEqual(server.claudeSessions.get(UUID(3)).spaceId, byDir.get('/Users/dev/work/cgs-master').id);
      assert.strictEqual(server.claudeSessions.get(UUID(2)).spaceId, byDir.get('/Users/dev/work/ai/ts').id);

      // And it landed on disk, so the next start does not migrate again.
      const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'spaces.json'), 'utf8'));
      assert.strictEqual(onDisk.length, 2);
    });

    it('disambiguates two dirs with the same basename', async function () {
      server.claudeSessions.set(UUID(1), sessionOf(UUID(1), { workingDir: '/a/work/cgs-master' }));
      server.claudeSessions.set(UUID(2), sessionOf(UUID(2), { workingDir: '/b/other/cgs-master' }));

      await server.loadSpacesAndMigrate();

      const names = server.spaces.map(s => s.name).sort();
      assert.strictEqual(server.spaces.length, 2);
      assert.notStrictEqual(names[0], names[1], 'the two checkouts read differently in the sidebar');
      assert.ok(names.some(n => n !== 'cgs-master'), 'the clash got a parent-prefixed name');
    });

    it('does not run when spaces.json already exists', async function () {
      // The real precondition: a saved list on disk, not poked-in memory —
      // loadSpacesAndMigrate reloads from disk as its first act.
      await fs.writeFile(path.join(dir, 'spaces.json'), JSON.stringify([spaceOf()]), 'utf8');
      server.claudeSessions.set(UUID(1), sessionOf(UUID(1)));

      await server.loadSpacesAndMigrate();

      assert.strictEqual(server.spaces.length, 1, 'the existing list is kept untouched');
      assert.strictEqual(server.spaces[0].name, 'cgs-master');
      assert.ok(!server.claudeSessions.get(UUID(1)).spaceId, 'no reassignment behind a saved list');
    });

    it('runs again when the file existed but was corrupted away', async function () {
      // fileExisted is false after a corrupt read — rebuild rather than
      // leaving every task in 未分组 because one write went bad.
      await fs.writeFile(path.join(dir, 'spaces.json'), 'not json', 'utf8');
      server.claudeSessions.set(UUID(1), sessionOf(UUID(1)));

      await server.loadSpacesAndMigrate();

      assert.strictEqual(server.spaces.length, 1);
      assert.ok(server.claudeSessions.get(UUID(1)).spaceId);
    });
  });

  describe('POST /api/spaces', function () {
    it('creates a space with a validated real dir', async function () {
      const real = path.join(dir, 'proj');
      await fs.mkdir(real);
      const res = mockRes();
      route('post', '/api/spaces')({ body: { name: ' 空间A ', dir: real } }, res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.space.name, '空间A');
      assert.strictEqual(res.body.space.dir, real);
      assert.strictEqual(server.spaces.length, 1);
    });

    it('refuses a dir that does not exist — a space on a typo\'d path would strand its tasks', async function () {
      const res = mockRes();
      route('post', '/api/spaces')({ body: { name: 'x', dir: path.join(dir, 'nope') } }, res);
      assert.strictEqual(res.statusCode, 400);
      assert.ok(res.body.message.includes('工作目录'), 'the refusal says so in Chinese');
      assert.strictEqual(server.spaces.length, 0);
    });

    it('refuses a path that exists but is not a directory', async function () {
      const file = path.join(dir, 'a-file');
      await fs.writeFile(file, 'x');
      const res = mockRes();
      route('post', '/api/spaces')({ body: { name: 'x', dir: file } }, res);
      assert.strictEqual(res.statusCode, 400);
    });

    it('rejects a bad name', function () {
      const res = mockRes();
      route('post', '/api/spaces')({ body: { name: '', dir: os.tmpdir() } }, res);
      assert.strictEqual(res.statusCode, 400);
    });
  });

  describe('PATCH /api/spaces/:id', function () {
    it('renames and re-points the dir', async function () {
      const real = path.join(dir, 'biding');
      await fs.mkdir(real);
      server.spaces = [spaceOf()];
      const res = mockRes();
      route('patch', '/api/spaces/:id')(
        { params: { id: UUID(1) }, body: { name: '投标', dir: real } }, res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(server.spaces[0].name, '投标');
      assert.strictEqual(server.spaces[0].dir, real);
    });

    it('refuses re-pointing at a dir that does not exist', async function () {
      server.spaces = [spaceOf()];
      const res = mockRes();
      route('patch', '/api/spaces/:id')(
        { params: { id: UUID(1) }, body: { dir: path.join(dir, 'gone') } }, res);
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(server.spaces[0].dir, spaceOf().dir, 'the space keeps its old dir');
    });

    it('404s for an unknown id', function () {
      const res = mockRes();
      route('patch', '/api/spaces/:id')({ params: { id: UUID(9) }, body: { name: 'x' } }, res);
      assert.strictEqual(res.statusCode, 404);
    });
  });

  describe('DELETE /api/spaces/:id', function () {
    it('keeps the tasks: they fall back to ungrouped', async function () {
      server.spaces = [spaceOf()];
      server.claudeSessions.set(UUID(1), sessionOf(UUID(1), { spaceId: UUID(1) }));
      const res = mockRes();
      await route('delete', '/api/spaces/:id')({ params: { id: UUID(1) } }, res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(server.spaces.length, 0);
      assert.strictEqual(res.body.orphaned, 1);
      assert.ok(server.claudeSessions.has(UUID(1)), 'the session itself survives');
      assert.ok(!server.claudeSessions.get(UUID(1)).spaceId, 'and is ungrouped');
    });
  });

  describe('PATCH /api/sessions/:sessionId with spaceId', function () {
    it('moves a session into a space, and null moves it out', function () {
      server.spaces = [spaceOf()];
      server.claudeSessions.set('s1', sessionOf('s1', { name: 'old' }));
      const patch = route('patch', '/api/sessions/:sessionId');

      let res = mockRes();
      patch({ params: { sessionId: 's1' }, body: { spaceId: UUID(1) } }, res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(server.claudeSessions.get('s1').spaceId, UUID(1));

      res = mockRes();
      patch({ params: { sessionId: 's1' }, body: { spaceId: null } }, res);
      assert.strictEqual(res.statusCode, 200);
      assert.ok(!server.claudeSessions.get('s1').spaceId);
    });

    it('rejects a spaceId no space has', function () {
      server.claudeSessions.set('s1', sessionOf('s1', { name: 'old' }));
      const res = mockRes();
      route('patch', '/api/sessions/:sessionId')({ params: { sessionId: 's1' }, body: { spaceId: UUID(9) } }, res);
      assert.strictEqual(res.statusCode, 400);
    });

    it('still 400s a body with nothing to update', function () {
      server.claudeSessions.set('s1', sessionOf('s1', { name: 'old' }));
      const res = mockRes();
      route('patch', '/api/sessions/:sessionId')({ params: { sessionId: 's1' }, body: {} }, res);
      assert.strictEqual(res.statusCode, 400);
    });
  });

  describe('POST /api/sessions/create with spaceId', function () {
    it('assigns a known space; defaults to the dir\'s space; else ungrouped', async function () {
      server.spaces = [spaceOf()]; // dir /Users/dev/work/cgs-master
      const create = route('post', '/api/sessions/create');

      let res = mockRes();
      await create({ body: { name: 'task 1', workingDir: '/Users/dev/work/cgs-master', spaceId: UUID(1) } }, res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.session.spaceId, UUID(1), 'explicit id wins');

      // A stale id from some other device: the dir is a space, so join that
      // rather than dropping to 未分组.
      res = mockRes();
      await create({ body: { name: 'task 2', workingDir: '/Users/dev/work/cgs-master', spaceId: UUID(8) } }, res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.session.spaceId, UUID(1), 'unknown id falls back to the dir\'s space');

      // A dir no space binds: genuinely ungrouped.
      res = mockRes();
      await create({ body: { name: 'task 3', workingDir: '/Users/dev/work/somewhere-else' } }, res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.session.spaceId, null);
    });
  });
});
