const assert = require('assert');
const hibernation = require('../src/hibernation');

const MIN = 60 * 1000;
const NOW = 10 * 60 * MIN;
const config = { ...hibernation.DEFAULTS, idleMs: 60 * MIN, maxRunning: 3, quietMs: 2 * MIN };

// A running session last used `ago` ms before NOW.
function run(id, ago, extra = {}) {
  return { id, viewed: false, awaiting: false, startedAt: 0, lastOutputAt: NOW - ago, ...extra };
}

describe('hibernation policy', function () {
  it('stops a Claude idle past the limit, and nothing younger', function () {
    const picks = hibernation.pickHibernations([run('old', 61 * MIN), run('young', 59 * MIN)], NOW, config);
    assert.deepStrictEqual(picks.map((p) => [p.id, p.reason]), [['old', 'idle']]);
  });

  it('counts input and a viewer as use, not only output', function () {
    const picks = hibernation.pickHibernations([
      run('typed', 90 * MIN, { lastInputAt: NOW - MIN }),
      run('looked', 90 * MIN, { lastViewedAt: NOW - MIN }),
    ], NOW, config);
    assert.deepStrictEqual(picks, []);
  });

  it('never stops one somebody is looking at or one waiting for an answer', function () {
    const picks = hibernation.pickHibernations([
      run('viewed', 5 * 60 * MIN, { viewed: true }),
      run('asking', 5 * 60 * MIN, { awaiting: true }),
    ], NOW, config);
    assert.deepStrictEqual(picks, []);
  });

  it('over the cap, stops the least recently used quiet ones first', function () {
    const picks = hibernation.pickHibernations([
      run('a', 10 * MIN), run('b', 30 * MIN), run('c', 20 * MIN), run('d', 5 * MIN), run('e', 3 * MIN),
    ], NOW, config);
    assert.deepStrictEqual(picks.map((p) => [p.id, p.reason]), [['b', 'cap'], ['c', 'cap']]);
  });

  it('lets the cap be exceeded rather than stop a Claude that is working', function () {
    // Five running, cap three, but only one has been quiet for two minutes.
    const picks = hibernation.pickHibernations([
      run('busy1', 0), run('busy2', 30 * 1000), run('busy3', MIN), run('busy4', MIN), run('quiet', 10 * MIN),
    ], NOW, config);
    assert.deepStrictEqual(picks.map((p) => p.id), ['quiet']);
  });

  it('counts idle stops toward the cap instead of stopping twice as many', function () {
    const picks = hibernation.pickHibernations([
      run('idle', 2 * 60 * MIN), run('a', 10 * MIN), run('b', 20 * MIN), run('c', 5 * MIN),
    ], NOW, config);
    assert.deepStrictEqual(picks.map((p) => p.id), ['idle']);
  });

  it('turns each rule off at zero', function () {
    const sessions = [run('a', 5 * 60 * MIN), run('b', 4 * 60 * MIN), run('c', 3 * 60 * MIN), run('d', 2 * 60 * MIN)];
    assert.deepStrictEqual(hibernation.pickHibernations(sessions, NOW, { ...config, idleMs: 0, maxRunning: 0 }), []);
    assert.strictEqual(hibernation.pickHibernations(sessions, NOW, { ...config, idleMs: 0 }).length, 1);
  });

  it('reads its settings from the environment', function () {
    const saved = { ...process.env };
    try {
      process.env.CCW_HIBERNATE_IDLE_MIN = '15';
      process.env.CCW_MAX_RUNNING_CLAUDE = '0';
      const c = hibernation.configFromEnv();
      assert.strictEqual(c.idleMs, 15 * MIN);
      assert.strictEqual(c.maxRunning, 0);
      process.env.CCW_HIBERNATE_IDLE_MIN = 'nonsense';
      delete process.env.CCW_MAX_RUNNING_CLAUDE;
      assert.strictEqual(hibernation.configFromEnv().idleMs, 60 * MIN);
      assert.strictEqual(hibernation.configFromEnv().maxRunning, 6);
    } finally {
      process.env = saved;
    }
  });
});

describe('hibernation busy check', function () {
  const table = [
    { pid: 10, ppid: 1, startedMs: 1000 },          // claude
    { pid: 11, ppid: 10, startedMs: 3000 },         // an MCP server, started with it
    { pid: 12, ppid: 11, startedMs: 3100 },         // ...and its own child
  ];

  it('calls a Claude with only its startup children idle', function () {
    assert.strictEqual(hibernation.isBusy(table, 10, 60000), false);
  });

  it('calls a Claude running a command started later busy', function () {
    assert.strictEqual(hibernation.isBusy([...table, { pid: 13, ppid: 10, startedMs: 500000 }], 10, 60000), true);
  });

  it('treats anything it cannot check as busy, so a failed check stops nothing', function () {
    assert.strictEqual(hibernation.isBusy(null, 10), true);
    assert.strictEqual(hibernation.isBusy(table, null), true);
    assert.strictEqual(hibernation.isBusy(table, 999), true);
  });

  it('parses a process table, dropping lines it cannot read', function () {
    const rows = hibernation.parseTable('10 1 1000\r\n\r\n11 10 3000\r\nbad line\n', (t) => t);
    assert.deepStrictEqual(rows, [{ pid: 10, ppid: 1, startedMs: 1000 }, { pid: 11, ppid: 10, startedMs: 3000 }]);
  });
});

describe('server: sweepHibernation', function () {
  this.timeout(20000);
  const { ClaudeCodeWebServer } = require('../src/server');

  let server;
  let stopped;
  let sent;
  let savedRead;

  function addSession(id, fields = {}) {
    const session = {
      id, name: id, active: true, connections: new Set(), outputBuffer: [],
      startedAt: Date.now() - 3 * 60 * MIN, lastOutputAt: Date.now() - 2 * 60 * MIN, ...fields,
    };
    server.claudeSessions.set(id, session);
    server.claudeBridge.sessions.set(id, { process: { pid: 10 }, active: true });
    return session;
  }

  beforeEach(function () {
    server = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
    server.hibernation = { ...hibernation.DEFAULTS, idleMs: 60 * MIN, maxRunning: 6 };
    stopped = [];
    sent = [];
    server.claudeBridge.stopSession = async (id) => { stopped.push(id); };
    server.broadcastToSession = (id, msg) => sent.push([id, msg.type, msg.reason]);
    savedRead = hibernation.readProcessTable;
    hibernation.readProcessTable = async () => [{ pid: 10, ppid: 1, startedMs: 0 }];
  });

  afterEach(function () {
    hibernation.readProcessTable = savedRead;
    if (server && typeof server.dispose === 'function') server.dispose();
  });

  it('stops an idle, unseen Claude and tells its browsers why', async function () {
    const s = addSession('idle-one');
    await server.sweepHibernation();
    assert.deepStrictEqual(stopped, ['idle-one']);
    assert.strictEqual(s.active, false);
    assert.strictEqual(s.hibernating, true, 'onExit must stay quiet for a stop we caused');
    // The notice waits for the process to be gone (onExit), so Claude's own
    // exit output cannot land after it.
    assert.deepStrictEqual(sent, []);
    assert.deepStrictEqual([s.hibernationNotice.type, s.hibernationNotice.reason], ['claude_hibernated', 'idle']);
  });

  it('keeps one that a browser has on screen', async function () {
    const s = addSession('watched');
    server.webSocketConnections.set('ws1', { cols: 120, rows: 40 });
    s.connections.add('ws1');
    await server.sweepHibernation();
    assert.deepStrictEqual(stopped, []);
    assert.ok(s.lastViewedAt > 0);
  });

  it('stops one only attached by a background view', async function () {
    const s = addSession('background');
    server.webSocketConnections.set('ws2', {});
    s.connections.add('ws2');
    await server.sweepHibernation();
    assert.deepStrictEqual(stopped, ['background']);
  });

  it('keeps one that is running a command', async function () {
    addSession('building');
    hibernation.readProcessTable = async () => [
      { pid: 10, ppid: 1, startedMs: 0 },
      { pid: 20, ppid: 10, startedMs: 30 * 60 * MIN },
    ];
    await server.sweepHibernation();
    assert.deepStrictEqual(stopped, []);
  });

  it('keeps one waiting on a permission answer, until the answer comes', async function () {
    const s = addSession('asking', { awaitingPermission: true });
    await server.sweepHibernation();
    assert.deepStrictEqual(stopped, []);
    s.awaitingPermission = false;
    await server.sweepHibernation();
    assert.deepStrictEqual(stopped, ['asking']);
  });
});
