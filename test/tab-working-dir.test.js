const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The working directory belongs to the SESSION, not to the app.
//
// It used to be a plain field written only on session_created / session_joined.
// But switching tabs goes through showSession(), and switching split panes goes
// through focusSplit() — both move currentClaudeSessionId without either message
// ever arriving. The field then still pointed at whichever project was last
// joined, and the branch panel (which asks app.currentWorkingDir) answered for
// the wrong tab: come back to the "ts" tab, open the branch panel, see "PMS".
//
// Deriving it from the active session is the fix, so this exercises the accessor
// itself rather than asserting on the source text.
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

function loadAccessor() {
  const src = read('src', 'public', 'app.js');
  const start = src.indexOf('    get currentWorkingDir()');
  assert.ok(start > 0, 'app.js must define a currentWorkingDir getter');
  const setter = src.indexOf('    set currentWorkingDir(', start);
  assert.ok(setter > start, 'app.js must define a currentWorkingDir setter');
  const end = src.indexOf('\n    }', setter);
  assert.ok(end > setter, 'the setter must be a complete method');
  const block = src.slice(start, end + '\n    }'.length);
  return vm.runInNewContext(`(class Sub { ${block} })`);
}

function appWith(sessions) {
  const Sub = loadAccessor();
  const app = new Sub();
  app.currentClaudeSessionId = null;
  app.sessionTabManager = { activeSessions: new Map(Object.entries(sessions)) };
  return app;
}

describe('the working directory follows the active tab', function () {
  it('answers for the session on screen, not the one last joined', function () {
    const app = appWith({ ts: { workingDir: '/w/ts' }, pms: { workingDir: '/w/pms' } });

    // Joined PMS first: session_joined wrote the field.
    app.currentClaudeSessionId = 'pms';
    app.currentWorkingDir = '/w/pms';
    assert.strictEqual(app.currentWorkingDir, '/w/pms');

    // Now switch tabs the way showSession() does — session id only, no message.
    app.currentClaudeSessionId = 'ts';
    assert.strictEqual(app.currentWorkingDir, '/w/ts',
      'switching to the ts tab must not keep answering with PMS');
  });

  it('follows a split pane focus too', function () {
    const app = appWith({ a: { workingDir: '/w/a' }, b: { workingDir: '/w/b' } });
    app.currentClaudeSessionId = 'a';
    assert.strictEqual(app.currentWorkingDir, '/w/a');
    app.currentClaudeSessionId = 'b';   // focusSplit() does exactly this
    assert.strictEqual(app.currentWorkingDir, '/w/b');
  });

  it('never falls back to another project when the tab has no directory', function () {
    const app = appWith({ pms: { workingDir: '/w/pms' }, blank: {} });
    app.currentClaudeSessionId = 'pms';
    app.currentWorkingDir = '/w/pms';
    app.currentClaudeSessionId = 'blank';
    assert.strictEqual(app.currentWorkingDir, null,
      'an unknown directory is null — PMS is a worse answer than no answer');
  });

  it('still remembers what was written when there is no session at all', function () {
    // session_created writes the dir before addTab() has registered the tab, and
    // the pre-session state has no record to read from either.
    const app = appWith({});
    app.currentWorkingDir = '/w/fresh';
    assert.strictEqual(app.currentWorkingDir, '/w/fresh');
    app.currentClaudeSessionId = 'not-a-tab';
    assert.strictEqual(app.currentWorkingDir, '/w/fresh');
  });
});
