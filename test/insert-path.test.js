const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The explorer's per-row "insert path" button types a path into the terminal for
// you, the way pasting an image already does (app.js uploadAndInsertImage).
//
// The load-bearing detail is what it must NOT send: a newline. The payload goes
// straight into the pty as keystrokes, so a trailing \n would press Enter for the
// user and fire a half-written prompt. Everything else here is shaped by what was
// measured against Claude Code 2.1.266 driving a real pty: `@` + an ABSOLUTE path
// is read correctly even for a file outside the session's cwd, the trailing space
// dismisses the `@` autocomplete popup so the next keystrokes aren't eaten, and a
// path containing spaces needs no quoting.
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

// Run the real method, not an assertion about its source text.
function makeExplorer({ sessionId = 'sid' } = {}) {
  const src = read('src', 'public', 'file-explorer.js');
  const start = src.indexOf('    insertPath(path)');
  assert.ok(start > 0, 'file-explorer.js must define insertPath(path)');
  const end = src.indexOf('\n    }', start);
  assert.ok(end > start, 'insertPath must be a complete method');
  const block = src.slice(start, end + '\n    }'.length);

  const sent = [];
  const toasts = [];
  const ctx = {
    window: { app: sessionId ? { currentClaudeSessionId: sessionId, send: (m) => sent.push(m) } : null },
    toast: (msg, err) => toasts.push({ msg, err: !!err })
  };
  vm.createContext(ctx);
  const Sub = vm.runInContext(`(class Sub { ${block} })`, ctx);
  const explorer = new Sub();
  let closed = 0;
  explorer.close = () => { closed++; };
  return { explorer, sent, toasts, closed: () => closed };
}

describe('explorer: insert a path into the terminal input', function () {

  it('types the path as @ + absolute path + a space', function () {
    const { explorer, sent } = makeExplorer();
    explorer.insertPath('/data/work/proj/src/server.js');

    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].type, 'input');
    assert.strictEqual(sent[0].data, '@/data/work/proj/src/server.js ');
  });

  it('never presses Enter for the user', function () {
    const { explorer, sent } = makeExplorer();
    explorer.insertPath('/a/b.js');
    // The whole point: the user writes their prompt after the path and sends it
    // themselves. A newline here fires a half-written message.
    assert.ok(!/[\n\r]/.test(sent[0].data), 'the payload must carry no newline or carriage return');
  });

  it('leaves a path with spaces exactly as it is', function () {
    // Measured: Claude reads `@/out side/s p.txt` with and without quotes, so the
    // quoting branch this would otherwise need does not exist.
    const { explorer, sent } = makeExplorer();
    explorer.insertPath('/out side/s p.txt');
    assert.strictEqual(sent[0].data, '@/out side/s p.txt ');
  });

  it('gets out of the way once the path is in', function () {
    const { explorer, closed } = makeExplorer();
    explorer.insertPath('/a/b.js');
    assert.strictEqual(closed(), 1, 'the explorer must close so the cursor is back in the terminal');
  });

  it('says so instead of sending into nothing when Claude is not running', function () {
    const { explorer, sent, toasts, closed } = makeExplorer({ sessionId: null });
    explorer.insertPath('/a/b.js');

    assert.strictEqual(sent.length, 0, 'nothing to type into');
    assert.strictEqual(closed(), 0, 'and no reason to close the panel');
    assert.strictEqual(toasts.length, 1);
    assert.strictEqual(toasts[0].err, true, 'it is a failure, so it must read as one');
  });

  it('confirms the insert, the way an image paste does', function () {
    const { explorer, toasts } = makeExplorer();
    explorer.insertPath('/a/b.js');
    assert.strictEqual(toasts.length, 1);
    assert.strictEqual(toasts[0].err, false);
  });
});
