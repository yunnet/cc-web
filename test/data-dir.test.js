const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The adoption move is the risky half of the ~/.cc-web layout: it relocates a
// user's sessions on first run, so each case pins one outcome — data intact,
// legacy gone, an existing target never overwritten, and a failed move falling
// back to the legacy directory rather than throwing the server out.
describe('data-dir', function () {
  let home;
  let dataDir;
  let realHome;

  beforeEach(function () {
    realHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-data-dir-'));
    process.env.HOME = home;
    delete process.env.CCW_DATA_DIR;
    // require caching would carry the previous test's failedMoves set; reload
    // so each case starts clean (same isolation as instance-lock.test.js).
    delete require.cache[require.resolve('../src/utils/data-dir')];
    dataDir = require('../src/utils/data-dir').dataDir;
  });

  afterEach(function () {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  });

  const target = () => path.join(home, '.cc-web', 'data');
  const legacy = () => path.join(home, '.claude-code-web');

  it('CCW_DATA_DIR wins verbatim, resolved, with no migration', function () {
    fs.mkdirSync(legacy(), { recursive: true });
    process.env.CCW_DATA_DIR = path.join(home, 'explicit');
    assert.strictEqual(dataDir(), path.join(home, 'explicit'));
    // The legacy directory was not touched: an explicit dir means hands off.
    assert.ok(fs.existsSync(legacy()));
  });

  it('defaults to ~/.cc-web/data and creates the base 0700', function () {
    assert.strictEqual(dataDir(), target());
    const mode = fs.statSync(path.join(home, '.cc-web')).mode & 0o777;
    assert.strictEqual(mode, 0o700, `expected base 0700, got ${mode.toString(8)}`);
  });

  it('adopts the legacy ~/.claude-code-web in one move, data intact', function () {
    fs.mkdirSync(path.join(legacy(), 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(legacy(), 'sessions', 'x.json'), '{"saved":true}');
    assert.strictEqual(dataDir(), target());
    assert.ok(!fs.existsSync(legacy()), 'legacy directory is gone');
    const moved = fs.readFileSync(path.join(target(), 'sessions', 'x.json'), 'utf8');
    assert.strictEqual(moved, '{"saved":true}');
  });

  it('never overwrites an existing target: legacy stays where it is', function () {
    fs.mkdirSync(path.join(target(), 'sessions'), { recursive: true });
    fs.mkdirSync(legacy(), { recursive: true });
    assert.strictEqual(dataDir(), target());
    assert.ok(fs.existsSync(legacy()), 'legacy is left alone');
  });

  it('adopts a dotted ~/.cc-web/.claude-code-web left by a hand move', function () {
    const dotted = path.join(home, '.cc-web', '.claude-code-web');
    fs.mkdirSync(dotted, { recursive: true });
    assert.strictEqual(dataDir(), target());
    assert.ok(!fs.existsSync(dotted), 'dotted copy is renamed away');
  });

  it('falls back to the legacy directory when the move fails, without throwing', function () {
    fs.mkdirSync(legacy(), { recursive: true });
    const realRename = fs.renameSync;
    fs.renameSync = () => { throw Object.assign(new Error('mocked'), { code: 'EXDEV' }); };
    try {
      assert.strictEqual(dataDir(), legacy());
    } finally {
      fs.renameSync = realRename;
    }
    // Still no throw, and the failure is remembered rather than retried on
    // every later call (writeLock asks on each write).
    assert.doesNotThrow(() => assert.strictEqual(dataDir(), legacy()));
  });
});
