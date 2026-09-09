const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Claude's default renderer draws on the terminal's ALTERNATE screen buffer,
// the way vim does — and that buffer has no scrollback by design. In a browser
// terminal that means history does not exist: there is nothing above the screen
// to scroll to. Measured on a real claude process: the default emits zero
// newlines and enters the alternate buffer, while CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1
// stays in the main buffer and emits lines that land in scrollback.
//
// Static assertions over the sources, like overlay-stacking.test.js: the spawn
// environment is a contract, and one that can be checked without spawning
// anything is one that stays checked.
describe('terminal renderer mode', function () {
  const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  const BRIDGE = read('src', 'claude-bridge.js');

  it('forces the classic renderer, so the conversation lands in scrollback', function () {
    assert.ok(/CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN:\s*'1'/.test(BRIDGE),
      'the spawn env must force the classic renderer');
  });

  it('asks for the classic renderer through Claude\'s own tui setting', function () {
    // The supported route: `tui` is what `/tui` writes, and injecting it means a
    // cc-web session behaves exactly like a user who ran `/tui default`. Values
    // are exactly ["default","fullscreen"] — "default" IS classic, there is no
    // "classic" value to pick. Measured: this overrides a global
    // `"tui": "fullscreen"` in ~/.claude/settings.json.
    const m = require('../src/claude-bridge.js');
    const Bridge = m.ClaudeBridge || m;
    const settings = Object.create(Bridge.prototype).buildInjectedSettings('sid', { uiTheme: 'light' });
    assert.strictEqual(settings.tui, 'default');
    // Injecting settings must not have cost us the ones already there.
    assert.strictEqual(settings.preferredNotifChannel, 'terminal_bell');
    assert.strictEqual(settings.theme, 'light-ansi');
  });

  it('keeps the env var as the backstop the setting cannot be', function () {
    // The setting loses to a `/tui fullscreen` typed inside a cc-web tab; the
    // env var beats even an explicit `"tui": "fullscreen"` (measured). Dropping
    // it as "redundant" would put history one slash-command away from gone.
    assert.ok(/CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN:\s*'1'/.test(BRIDGE));
    assert.ok(/tui:\s*'default'/.test(BRIDGE), 'both layers must be present');
  });

  it('keeps synchronized output', function () {
    // Orthogonal to the renderer: sync output is about how a frame is
    // delivered, not where it is drawn. Removing it while changing renderers
    // would reintroduce tearing and look like the renderer's fault.
    assert.ok(/CLAUDE_CODE_FORCE_SYNC_OUTPUT:\s*'1'/.test(BRIDGE),
      'synchronized output must survive the renderer change');
  });

  it('still drops the child-session marker', function () {
    // Inherited, it turns transcript saving OFF, which breaks --resume. An
    // edit to this env block must not lose it.
    assert.ok(/delete\s+childEnv\.CLAUDE_CODE_CHILD_SESSION/.test(BRIDGE),
      'CLAUDE_CODE_CHILD_SESSION must still be deleted');
  });

  it('gives both terminals the same scrollback depth', function () {
    // History now actually accumulates, and a split pane that remembers less
    // than the main terminal would silently lose the older half.
    const grab = (src) => {
      const m = /scrollback:\s*(\d+)/.exec(src);
      return m ? Number(m[1]) : null;
    };
    const main = grab(read('src', 'public', 'app.js'));
    const split = grab(read('src', 'public', 'splits.js'));
    assert.ok(main, 'main terminal has no scrollback setting');
    assert.strictEqual(split, main, `split (${split}) must match the main terminal (${main})`);
    assert.ok(main >= 10000, `scrollback ${main} is below what it was before this change`);
  });
});
