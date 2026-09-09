const fs = require('fs');
const os = require('os');
const path = require('path');

// cc-web ships its own Claude Code themes.
//
// The light theme's input-box border and status-line rule were fixed a dozen
// times without sticking, because the only lever cc-web had was an ANSI SLOT,
// and Claude double-books ANSI 7 as both the border foreground and the
// background of your own message band. `contrast(7,bg) x contrast(0,7)` is a
// constant, so no single value satisfies both — see the light-contrast work in
// v4.6.x, which papered over it with xterm's minimumContrastRatio.
//
// Claude supports naming the colour instead. A theme file in ~/.claude/themes/
// takes a `base` preset plus `overrides` keyed by TOKEN — `promptBorder` is the
// input box border, `subtle` is the hairlines — and `theme: "custom:<slug>"`
// selects it through the --settings channel cc-web already uses. Measured on a
// real claude: an overridden promptBorder appears in the output as exactly the
// colour asked for. That is the whole point — one named line, one colour, no
// slot shared with something else.
//
// Colours come from the same GitHub-style palettes the terminal itself uses
// (see getTerminalTheme in public/splits.js), so Claude's chrome and the
// terminal's own colours stay one family.

const THEMES_DIR = () => path.join(os.homedir(), '.claude', 'themes');

// Backgrounds the ratios below are computed against: white for light, and the
// terminal's own #0d1117 for dark. Kept next to the colours so a future edit
// can re-check the contrast rather than trust the comment.
const LIGHT_BG = '#ffffff';
const DARK_BG = '#0d1117';

// Every token here is something that has actually been reported invisible, or
// sits in the same failure (a border in a mode we do not happen to run today).
// The border tokens are split by MODE: `promptBorder` is Manual only, and the
// running instance sits in auto mode, whose border is `warning`. Overriding
// promptBorder alone looks like "the change did nothing".
const THEMES = {
  light: {
    slug: 'cc-web-light',
    background: LIGHT_BG,
    theme: {
      name: 'cc-web (light)',
      base: 'light-ansi',
      overrides: {
        promptBorder: '#57606a',   // 6.39:1 — Manual mode input box border
        warning: '#9a6700',        // 4.87:1 — auto mode border, and warnings
        planMode: '#0550ae',       // 7.59:1 — plan mode border
        autoAccept: '#116329',     // 7.39:1 — accept-edits border
        bashBorder: '#6639ba',     // 7.34:1 — `!` shell command border
        subtle: '#6e7781',         // 4.55:1 — hairlines, the status-line rule
        inactive: '#6e7781',       // 4.55:1 — hints, timestamps
        // The other half of the double-booking: the band behind your own
        // messages. Naming it means the band no longer has to be whatever the
        // border colour happens to be. ANSI 0 (#0d1117) on it reads 16.23:1.
        userMessageBackground: '#eaeef2'
      }
    }
  },
  dark: {
    slug: 'cc-web-dark',
    background: DARK_BG,
    theme: {
      name: 'cc-web (dark)',
      // Stays on the built-in `dark` preset: this change is about naming the
      // lines, not about moving dark onto ANSI slots (that is a separate call,
      // and it would need minimumContrastRatio turned on for dark too).
      base: 'dark',
      overrides: {
        promptBorder: '#8b949e',   // 6.15:1
        warning: '#d29922',        // 7.60:1
        planMode: '#79c0ff',       // 9.73:1
        autoAccept: '#56d364',     // 9.82:1
        bashBorder: '#d2a8ff',     // 9.72:1
        subtle: '#8b949e',         // 6.15:1
        inactive: '#8b949e'        // 6.15:1
      }
    }
  }
};

// Built-in presets to fall back on — what cc-web injected before this module.
const BUILT_IN = { light: 'light-ansi', dark: 'dark' };

// Which slugs are actually on disk. Populated by ensureThemes(); empty until
// then, so themeForUi() answers with the built-ins rather than pointing Claude
// at a file that may not exist.
let available = {};

function themeFile(slug) {
  return path.join(THEMES_DIR(), `${slug}.json`);
}

// Write both theme files. Best-effort per theme: a failure on one must not cost
// the other, and neither may throw — a home directory that cannot be written is
// a reason to fall back, not a reason for the server to fail to start.
//
// Call this BEFORE the first Claude spawn. Claude watches ~/.claude/themes/ and
// hot-reloads edits, but only if the directory existed when it started; created
// later, it takes one restart to be noticed.
function ensureThemes() {
  const result = {};
  for (const [ui, spec] of Object.entries(THEMES)) {
    const target = themeFile(spec.slug);
    // pid in the temp name so two servers cannot clobber each other's partial
    // write, then rename to swap atomically — same shape as the scrollback
    // setting in server.js and SessionStore.writeOne.
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, `${JSON.stringify(spec.theme, null, 2)}\n`);
      fs.renameSync(tmp, target);
      result[ui] = spec.slug;
    } catch (_) {
      try { fs.unlinkSync(tmp); } catch (_e) { /* nothing to clean up */ }
    }
  }
  available = result;
  return result;
}

// The value for the injected `theme` setting.
//
// Only ever names a custom theme we have confirmed on disk. A `custom:<slug>`
// that does not resolve does NOT fall back to something sensible — measured,
// Claude silently drops to the DARK preset, which in light mode is a dark theme
// on a white terminal. Worse than never having tried.
function themeForUi(uiTheme) {
  const key = uiTheme === 'light' ? 'light' : 'dark';
  return available[key] ? `custom:${available[key]}` : BUILT_IN[key];
}

module.exports = {
  ensureThemes,
  themeForUi,
  // Exported for the tests: they assert the shape and the contrast of what we
  // ship, so "invisible" fails a test run instead of waiting to be noticed.
  THEMES,
  BUILT_IN,
  THEMES_DIR,
  themeFile,
  _reset: () => { available = {}; }
};
