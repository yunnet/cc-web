const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const claudeTheme = require('../src/utils/claude-theme');

// cc-web ships Claude Code theme files so the input box border and the status
// line rule can be named directly instead of reached at through an ANSI slot
// Claude also uses as a background. The light border was "fixed" a dozen times
// without sticking, so the contrast of what we ship is asserted here: invisible
// should fail a test run, not wait to be noticed on a phone.
//
// Every test runs against a temp HOME — os.homedir() honours $HOME on Linux —
// so nothing here can touch the real ~/.claude/themes/.
function withHome(dir, fn) {
  const prev = process.env.HOME;
  process.env.HOME = dir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
}

const lum = (hex) => {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.substr(i, 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => {
  const l1 = lum(a);
  const l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

describe('cc-web Claude themes', function () {
  let home;

  beforeEach(function () {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-theme-'));
    claudeTheme._reset();
  });

  afterEach(function () {
    claudeTheme._reset();
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  });

  const themesDir = () => path.join(home, '.claude', 'themes');
  const read = (slug) => JSON.parse(fs.readFileSync(path.join(themesDir(), `${slug}.json`), 'utf8'));

  it('writes both theme files where Claude looks for them', function () {
    const written = withHome(home, () => claudeTheme.ensureThemes());
    assert.deepStrictEqual(written, { light: 'cc-web-light', dark: 'cc-web-dark' });
    assert.ok(fs.existsSync(path.join(themesDir(), 'cc-web-light.json')));
    assert.ok(fs.existsSync(path.join(themesDir(), 'cc-web-dark.json')));
  });

  it('builds each theme on the right preset', function () {
    withHome(home, () => claudeTheme.ensureThemes());
    // Light stays on an -ansi base so Claude's chrome keeps coming through OUR
    // palette, which is what minimumContrastRatio corrects at draw time. Dark
    // stays on the built-in preset: moving dark onto ANSI slots is a separate
    // call, and it would need that correction turned on for dark too.
    assert.strictEqual(read('cc-web-light').base, 'light-ansi');
    assert.strictEqual(read('cc-web-dark').base, 'dark');
  });

  it('names every border a mode can draw, not just the Manual one', function () {
    // The failure this guards: the instance runs in auto mode, whose border is
    // `warning` — overriding `promptBorder` alone changes a line nobody is
    // looking at and reads as "the fix did nothing".
    const light = read.bind(null, 'cc-web-light');
    withHome(home, () => claudeTheme.ensureThemes());
    for (const token of ['promptBorder', 'warning', 'planMode', 'autoAccept', 'bashBorder']) {
      assert.ok(light().overrides[token], `light theme must name ${token}`);
    }
  });

  it('names the hairlines and the message band', function () {
    withHome(home, () => claudeTheme.ensureThemes());
    const light = read('cc-web-light').overrides;
    assert.ok(light.subtle, 'the status-line rule is `subtle`');
    assert.ok(light.inactive, 'status-line text is `inactive`');
    // The other half of the ANSI 7 double-booking. Naming it is what frees the
    // border colour from having to also work as a background.
    assert.ok(light.userMessageBackground, 'the band behind your own messages');
  });

  it('keeps every named colour readable on its own background', function () {
    // The whole point of the change. A future edit that picks a prettier grey
    // fails here rather than shipping another invisible border.
    for (const spec of Object.values(claudeTheme.THEMES)) {
      for (const [token, colour] of Object.entries(spec.theme.overrides)) {
        if (token === 'userMessageBackground') {
          // A background, so the text ON it is what has to read. Claude draws
          // ANSI 0 there, which in the light palette is #0d1117.
          assert.ok(contrast('#0d1117', colour) >= 4.5,
            `${token} ${colour}: text on it is ${contrast('#0d1117', colour).toFixed(2)}:1`);
          continue;
        }
        const ratio = contrast(colour, spec.background);
        assert.ok(ratio >= 4.5,
          `${spec.theme.name} ${token} ${colour} is ${ratio.toFixed(2)}:1 on ${spec.background}`);
      }
    }
  });

  it('points Claude at the custom themes once they are on disk', function () {
    withHome(home, () => {
      claudeTheme.ensureThemes();
      assert.strictEqual(claudeTheme.themeForUi('light'), 'custom:cc-web-light');
      assert.strictEqual(claudeTheme.themeForUi('dark'), 'custom:cc-web-dark');
    });
  });

  it('falls back to the built-ins before anything has been written', function () {
    // themeForUi can be reached before ensureThemes() (an early spawn, a test).
    // Naming a theme that is not there is the one outcome that must not happen.
    assert.strictEqual(claudeTheme.themeForUi('light'), 'light-ansi');
    assert.strictEqual(claudeTheme.themeForUi('dark'), 'dark');
  });

  it('falls back rather than throwing when the home directory is read-only', function () {
    const locked = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-theme-ro-'));
    fs.chmodSync(locked, 0o555);
    try {
      const written = withHome(locked, () => claudeTheme.ensureThemes());
      assert.deepStrictEqual(written, {}, 'nothing should be reported as written');
      assert.strictEqual(claudeTheme.themeForUi('light'), 'light-ansi');
      // Measured on a real claude: `custom:` naming a theme that does not
      // resolve does not degrade gracefully — it silently drops to the DARK
      // preset, i.e. a dark theme on a white terminal. Falling back to
      // `light-ansi` is the only safe answer, so this is the load-bearing test.
      assert.notStrictEqual(claudeTheme.themeForUi('light'), 'custom:cc-web-light');
    } finally {
      fs.chmodSync(locked, 0o755);
      try { fs.rmSync(locked, { recursive: true, force: true }); } catch (_) {}
    }
  });

  it('writes atomically and leaves no temp files behind', function () {
    withHome(home, () => claudeTheme.ensureThemes());
    const strays = fs.readdirSync(themesDir()).filter((f) => f.includes('.tmp'));
    assert.deepStrictEqual(strays, [], `left temp files: ${strays}`);
  });

  it('leaves other themes in the directory alone', function () {
    fs.mkdirSync(themesDir(), { recursive: true });
    const mine = path.join(themesDir(), 'dracula.json');
    fs.writeFileSync(mine, '{"name":"Dracula"}');

    withHome(home, () => claudeTheme.ensureThemes());

    assert.strictEqual(fs.readFileSync(mine, 'utf8'), '{"name":"Dracula"}');
    assert.deepStrictEqual(fs.readdirSync(themesDir()).sort(),
      ['cc-web-dark.json', 'cc-web-light.json', 'dracula.json']);
  });

  it('is what the bridge injects', function () {
    // The bridge is the only caller that matters; a module that is correct but
    // unwired would pass every test above.
    const m = require('../src/claude-bridge.js');
    const Bridge = m.ClaudeBridge || m;
    withHome(home, () => {
      claudeTheme.ensureThemes();
      const settings = Object.create(Bridge.prototype).buildInjectedSettings('sid', { uiTheme: 'light' });
      assert.strictEqual(settings.theme, 'custom:cc-web-light');
      // The renderer choice must have survived sharing the object.
      assert.strictEqual(settings.tui, 'default');
    });
  });
});
