const assert = require('assert');
const net = require('net');
const { SharedPlaywright, isListening, playwrightArgs, portFromEnv, DEFAULT_PORT } = require('../src/shared-mcp');

describe('shared Playwright MCP', function () {
  it('serves HTTP on the port, one isolated context per client', function () {
    assert.deepStrictEqual(playwrightArgs(8931), ['-y', '@playwright/mcp@latest', '--port', '8931', '--isolated']);
    assert.ok(!playwrightArgs(8931).includes('--shared-browser-context'),
      'tasks must not share one browser context');
  });

  it('starts it only when nothing answers on the port', async function () {
    const spawned = [];
    const fake = () => ({ pid: 1, unref() {} });
    const down = new SharedPlaywright({ port: 9, log: () => {}, isListeningFn: async () => false,
      spawnFn: (...a) => { spawned.push(a); return fake(); } });
    assert.strictEqual(await down.ensure(), 'started');
    assert.strictEqual(spawned.length, 1);
    assert.strictEqual(spawned[0][2].detached, true, 'outlives a cc-web restart');

    const up = new SharedPlaywright({ port: 9, log: () => {}, isListeningFn: async () => true,
      spawnFn: () => { throw new Error('must not spawn'); } });
    assert.strictEqual(await up.ensure(), 'running');
  });

  it('never starts two at once', async function () {
    let spawns = 0;
    const sp = new SharedPlaywright({ port: 9, log: () => {},
      isListeningFn: () => new Promise((r) => setTimeout(() => r(false), 20)),
      spawnFn: () => { spawns++; return { pid: 1, unref() {} }; } });
    await Promise.all([sp.ensure(), sp.ensure(), sp.ensure()]);
    assert.strictEqual(spawns, 1);
  });

  it('is off at port 0', async function () {
    const sp = new SharedPlaywright({ port: 0, spawnFn: () => { throw new Error('no'); } });
    assert.strictEqual(await sp.ensure(), 'off');
    sp.start();
    assert.strictEqual(sp.timer, null);
  });

  it('reads the port from the environment', function () {
    const saved = process.env.CCW_SHARED_PLAYWRIGHT_PORT;
    try {
      process.env.CCW_SHARED_PLAYWRIGHT_PORT = '0';
      assert.strictEqual(portFromEnv(), 0);
      process.env.CCW_SHARED_PLAYWRIGHT_PORT = 'x';
      assert.strictEqual(portFromEnv(), DEFAULT_PORT);
    } finally {
      if (saved === undefined) delete process.env.CCW_SHARED_PLAYWRIGHT_PORT;
      else process.env.CCW_SHARED_PLAYWRIGHT_PORT = saved;
    }
  });

  it('tells a listening port from a closed one', async function () {
    const server = net.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address();
    try {
      assert.strictEqual(await isListening(port), true);
    } finally {
      await new Promise((r) => server.close(r));
    }
    assert.strictEqual(await isListening(port), false);
  });
});
