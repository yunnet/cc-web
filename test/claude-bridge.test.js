const assert = require('assert');
const ClaudeBridge = require('../src/claude-bridge');

describe('ClaudeBridge', function() {
  let bridge;

  beforeEach(function() {
    bridge = new ClaudeBridge();
  });

  describe('constructor', function() {
    it('should initialize with a Map for sessions', function() {
      assert(bridge.sessions instanceof Map);
      assert.strictEqual(bridge.sessions.size, 0);
    });

    it('should find a claude command on initialization', function() {
      assert(typeof bridge.claudeCommand === 'string');
      assert(bridge.claudeCommand.length > 0);
    });
  });

  describe('commandExists', function() {
    it('should return true for existing commands like "ls"', function() {
      const result = bridge.commandExists('ls');
      assert.strictEqual(result, true);
    });

    it('should return false for non-existent commands', function() {
      const result = bridge.commandExists('nonexistentcommand12345');
      assert.strictEqual(result, false);
    });

    it('should handle command names with special characters safely', function() {
      // This tests the security fix - commands with shell metacharacters should not break
      const result = bridge.commandExists('ls; echo "injected"');
      assert.strictEqual(result, false);
    });
  });

  describe('getSession', function() {
    it('should return undefined for non-existent session', function() {
      const result = bridge.getSession('nonexistent');
      assert.strictEqual(result, undefined);
    });
  });

  describe('getAllSessions', function() {
    it('should return empty array when no sessions exist', function() {
      const result = bridge.getAllSessions();
      assert(Array.isArray(result));
      assert.strictEqual(result.length, 0);
    });
  });

  describe('launchArgs', function() {
    const args = (o) => ClaudeBridge.launchArgs(o);

    it('passes every whitelisted value through as its flag', function() {
      assert.deepStrictEqual(args({ model: 'fable', permissionMode: 'auto', effort: 'xhigh' }),
        ['--model', 'fable', '--permission-mode', 'auto', '--effort', 'xhigh']);
      assert.deepStrictEqual(args({}), []);
    });

    it('drops unknown values instead of handing them to the CLI', function() {
      assert.deepStrictEqual(args({ model: 'gpt', permissionMode: 'bypassPermissions', effort: 'ludicrous' }), []);
      assert.deepStrictEqual(args({ model: '--help' }), []);
    });

    it('lets skipping permissions win over a permission mode', function() {
      assert.deepStrictEqual(args({ dangerouslySkipPermissions: true, permissionMode: 'plan', effort: 'low' }),
        ['--dangerously-skip-permissions', '--effort', 'low']);
    });

    it('passes a name as one --name=value argument, cleaned', function() {
      assert.deepStrictEqual(args({ name: '  发布前检查 ' }), ['--name=发布前检查']);
      // A leading dash stays a value because it is glued to the flag.
      assert.deepStrictEqual(args({ name: '--help' }), ['--name=--help']);
      assert.deepStrictEqual(args({ name: 'a\x1b]0;evil\x07b\r\n' }), ['--name=a]0;evilb']);
      assert.strictEqual(args({ name: 'x'.repeat(200) })[0].length, '--name='.length + 80);
      assert.deepStrictEqual(args({ name: '' }), []);
      assert.deepStrictEqual(args({ name: '\x07\x1b' }), []);
    });

    it('offers nothing the installed claude would reject', function() {
      // The whitelists are ours; the choices are Claude's. Read them off the
      // real CLI so an upgrade that renames a mode fails here, not in a tab.
      // ponytail: the one deliberate exception to "no real CLI calls" — `--help`
      // is offline and local, and skips where claude is not installed.
      let help;
      try {
        help = require('child_process').execFileSync('claude', ['--help'], { encoding: 'utf8', timeout: 20000 });
      } catch (_) {
        this.skip(); // no claude on this machine
      }
      const flat = help.replace(/\s+/g, ' ');
      const choices = /--permission-mode <mode>.*?\(choices: ([^)]*)\)/.exec(flat);
      assert.ok(choices, '--permission-mode choices not found in claude --help');
      const modes = choices[1].match(/"([^"]+)"/g).map(q => q.slice(1, -1));
      for (const m of ClaudeBridge.PERMISSION_MODES.filter(m => m !== 'default')) {
        assert.ok(modes.includes(m), `claude no longer accepts --permission-mode ${m}`);
      }
      const efforts = /--effort <level>.*?\(([^)]*)\)/.exec(flat);
      assert.ok(efforts, '--effort levels not found in claude --help');
      for (const e of ClaudeBridge.EFFORTS) assert.ok(efforts[1].split(/,\s*/).includes(e), `claude no longer accepts --effort ${e}`);
    });
  });

  describe('buildInjectedSettings', function() {
    it('should always route notifications to the terminal bell', function() {
      const s = bridge.buildInjectedSettings('sess-1', {});
      assert.strictEqual(s.preferredNotifChannel, 'terminal_bell');
    });

    it('should NOT register hooks when relay params are missing', function() {
      assert.strictEqual(bridge.buildInjectedSettings('sess-1', {}).hooks, undefined);
      assert.strictEqual(
        bridge.buildInjectedSettings('sess-1', { hookScript: '/x/cc-hook.js', hookPort: 0, hookToken: 't' }).hooks,
        undefined
      );
    });

    it('should register a PreToolUse(ExitPlanMode) hook when relay params are present', function() {
      const s = bridge.buildInjectedSettings('sess-abc', {
        hookScript: '/opt/app/bin/cc-hook.js',
        hookPort: 32353,
        hookToken: 'tok-xyz'
      });
      assert(s.hooks && Array.isArray(s.hooks.PreToolUse));
      const group = s.hooks.PreToolUse[0];
      assert.strictEqual(group.matcher, 'ExitPlanMode');
      const cmd = group.hooks[0].command;
      assert.strictEqual(group.hooks[0].type, 'command');
      // The command relays this session's plan event with the right args.
      assert(cmd.includes('/opt/app/bin/cc-hook.js'), 'command includes hook script path');
      assert(cmd.includes('--port 32353'), 'command includes port');
      assert(cmd.includes('sess-abc'), 'command includes session id');
      // The token must NOT be on the command line — it travels via the
      // CCWEB_HOOK_TOKEN env var so it can't leak through /proc/<pid>/cmdline.
      assert(!cmd.includes('tok-xyz'), 'command must NOT include the hook token');
      assert(!cmd.includes('--token'), 'command must NOT carry a --token flag');
    });

    it('should hear about permission requests, and only those', function() {
      const s = bridge.buildInjectedSettings('sess-abc', {
        hookScript: '/opt/app/bin/cc-hook.js', hookPort: 32353, hookToken: 'tok-xyz'
      });
      assert.strictEqual(s.hooks.Notification.length, 1);
      const group = s.hooks.Notification[0];
      // Not '*': idle_prompt fires a minute after every answer.
      assert.strictEqual(group.matcher, 'permission_prompt');
      assert.strictEqual(group.hooks[0].command, s.hooks.PreToolUse[0].hooks[0].command, 'the same relay');
    });

    it('should ask Claude for clickable links', function() {
      // Without it Claude prints no OSC 8 hyperlinks in a PTY (2.1.278).
      const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'claude-bridge.js'), 'utf8');
      assert.ok(/const childEnv = \{[\s\S]*?FORCE_HYPERLINK: '1'[\s\S]*?\};/.test(src));
    });

    it('should hear when a turn ends', function() {
      const s = bridge.buildInjectedSettings('sess-abc', {
        hookScript: '/opt/app/bin/cc-hook.js', hookPort: 32353, hookToken: 'tok-xyz'
      });
      assert.strictEqual(s.hooks.Stop.length, 1);
      assert.strictEqual(s.hooks.Stop[0].hooks[0].command, s.hooks.PreToolUse[0].hooks[0].command, 'the same relay');
      // The hooks that were there stay.
      assert.deepStrictEqual(Object.keys(s.hooks).sort(), ['Notification', 'PreToolUse', 'SessionStart', 'Stop']);
    });

    it('should single-quote-escape argv to avoid shell injection', function() {
      const s = bridge.buildInjectedSettings("a'b; rm -rf /", {
        hookScript: '/bin/cc-hook.js', hookPort: 1, hookToken: 't'
      });
      const cmd = s.hooks.PreToolUse[0].hooks[0].command;
      // The dangerous session id is wrapped/escaped, not left bare.
      assert(!cmd.includes("a'b; rm -rf /"), 'raw dangerous string is not present unescaped');
      assert(cmd.includes(`'a'\\''b; rm -rf /'`), 'session id is single-quote escaped');
    });
  });

  describe('theme injection', function() {
    // The browser terminal is the background Claude draws on, so Claude's theme
    // has to follow the UI's, not the user's global settings.json.
    //
    // These now assert the FALLBACK, which is what this process sees: the custom
    // themes are written by server.start(), which the tests never call, so
    // themeForUi answers with the built-in presets. That is the safe half of the
    // contract and worth pinning here — naming a `custom:` theme that is not on
    // disk drops Claude to the dark preset, i.e. a dark theme on a white
    // terminal. The custom path is covered in claude-theme.test.js against a
    // temp HOME, so neither test writes into the real ~/.claude/themes/.
    it('falls back to the built-in Claude themes when ours are not on disk', function() {
      assert.strictEqual(ClaudeBridge.themeForUi('light'), 'light-ansi');
      assert.strictEqual(ClaudeBridge.themeForUi('dark'), 'dark');
    });

    it('uses light-ansi, not light — light rules its input box at 2.85:1 on white', function() {
      const s = bridge.buildInjectedSettings('sid', { uiTheme: 'light' });
      assert.strictEqual(s.theme, 'light-ansi');
    });

    it('injects the dark theme for a dark UI', function() {
      assert.strictEqual(bridge.buildInjectedSettings('sid', { uiTheme: 'dark' }).theme, 'dark');
    });

    it('injects no theme when the UI did not report one (older client)', function() {
      assert.ok(!('theme' in bridge.buildInjectedSettings('sid', {})));
      assert.ok(!('theme' in bridge.buildInjectedSettings('sid', { uiTheme: 'nonsense' })));
    });

    it('keeps the notification channel and hooks alongside the theme', function() {
      const s = bridge.buildInjectedSettings('sid', {
        uiTheme: 'light', hookScript: '/bin/cc-hook.js', hookPort: 1, hookToken: 't'
      });
      assert.strictEqual(s.preferredNotifChannel, 'terminal_bell');
      assert.strictEqual(s.theme, 'light-ansi');
      assert.ok(s.hooks.PreToolUse[0].hooks[0].command.includes('cc-hook.js'));
    });
  });

  describe('looksLikeTrustPrompt', function() {
    it('matches the old wording', function() {
      assert.strictEqual(
        ClaudeBridge.looksLikeTrustPrompt('Do you trust the files in this folder?'),
        true
      );
    });

    // Verbatim from a captured PTY stream (v2.1.247). Every word carries its own
    // cursor-column escape, so with the escapes gone the words run together —
    // which is why a substring match on the sentence found nothing and new
    // sessions sat on the prompt.
    it('matches the real stream, where each word is cursor-positioned', function() {
      const real =
        '\u001b[2GQuick\u001b[8Gsafety\u001b[15Gcheck:\u001b[22GIs\u001b[25Gthis\u001b[30Ga' +
        '\u001b[32Gproject\u001b[40Gyou\u001b[44Gcreated\u001b[52Gor\u001b[55Gone\u001b[59Gyou' +
        '\u001b[63Gtrust?\r\r\n';
      assert.strictEqual(ClaudeBridge.looksLikeTrustPrompt(real), true);
    });

    it('matches the accept option in the same shape', function() {
      const option =
        '\u001b[2G\u001b[38;2;87;105;247m\u276f\u001b[4G\u001b[38;2;102;102;102m1.' +
        '\u001b[7G\u001b[38;2;87;105;247mYes,\u001b[12GI\u001b[14Gtrust\u001b[20Gthis' +
        '\u001b[25Gfolder\u001b[39m';
      assert.strictEqual(ClaudeBridge.looksLikeTrustPrompt(option), true);
    });

    it('does not fire on ordinary output', function() {
      assert.strictEqual(ClaudeBridge.looksLikeTrustPrompt('Reply with one word: PINEAPPLE7'), false);
      assert.strictEqual(ClaudeBridge.looksLikeTrustPrompt(''), false);
      assert.strictEqual(ClaudeBridge.looksLikeTrustPrompt(undefined), false);
    });
  });

  // Which option starts highlighted is Claude's choice, and it has changed. The
  // old prompt opened on "1. Yes, I trust this folder", so a bare Enter
  // accepted; today's opens on "No, exit", so the same Enter QUITS — one second
  // into every session in a folder Claude had not seen before. These pin the
  // cursor arithmetic that replaced the blind Enter.
  describe('trustPromptCursorDelta', function() {
    const currentPrompt =
      '\u001b[2G\u001b[38;2;210;153;34m\u001b[1mAccessing\u001b[12Gworkspace:\u001b[22m\u001b[39m\r\r\n\r\r\n\u001b[2G\u001b[1m/data/work/gongxinyun/dataset\u001b[22m\r\r\n\r\r\n\u001b[2GQuick\u001b[8Gsafety\u001b[15Gcheck:\u001b[22GIs\u001b[25Gthis\u001b[30Ga\u001b[32Gproject\u001b[40Gyou\u001b[44Gcreated\r\r\n\r\r\n\u001b[2G\u001b[38;2;139;148;158mSecurity\u001b[11Gguide\u001b[39m\r\r\n\r\r\n\u001b[2G\u001b[38;2;177;185;249m\u276f\u001b[4GNo,\u001b[8Gexit\u001b[39m\r\r\n\u001b[4GYes,\u001b[9GI\u001b[11Gtrust\u001b[17Gthis\u001b[22Gfolder\r\r\n\r\r\n\u001b[2G\u001b[38;2;139;148;158mEnter\u001b[8Gto\u001b[11Gconfirm\u001b[19G\u00b7\u001b[21GEsc\u001b[25Gto\u001b[28Gcancel\u001b[39m\r\r\n';

    it('measures one row down to the accept option on the current prompt', function() {
      assert.strictEqual(ClaudeBridge.trustPromptCursorDelta(currentPrompt), 1);
    });

    it('returns 0 when the cursor already sits on the accept option', function() {
      const old =
        '\u001b[2G\u001b[38;2;87;105;247m\u276f\u001b[4G1.\u001b[7GYes,\u001b[12GI\u001b[14Gtrust' +
        '\u001b[20Gthis\u001b[25Gfolder\u001b[39m\r\r\n' +
        '\u001b[4G2.\u001b[7GNo,\u001b[11Gexit\r\r\n';
      assert.strictEqual(ClaudeBridge.trustPromptCursorDelta(old), 0);
    });

    it('reads the LAST frame, not an earlier repaint', function() {
      // Claude repaints the whole prompt on every resize. An older frame with the
      // cursor elsewhere must not decide where we move now.
      const stale = currentPrompt.replace('\u276f\u001b[4GNo,', '\u001b[4GNo,')
        .replace('\u001b[4GYes,', '\u276f\u001b[4GYes,');
      assert.strictEqual(ClaudeBridge.trustPromptCursorDelta(stale + currentPrompt), 1);
    });

    it('refuses to guess when the accept option is not on screen', function() {
      // Nothing is sent in that case: leaving the prompt up beats quitting for
      // the user.
      assert.strictEqual(ClaudeBridge.trustPromptCursorDelta('Quick safety check: ...'), null);
      assert.strictEqual(ClaudeBridge.trustPromptCursorDelta(''), null);
      assert.strictEqual(ClaudeBridge.trustPromptCursorDelta(undefined), null);
    });

    it('ignores a lone marker far from the options', function() {
      const withInputBox = '\u276f\u001b[4Gsome typed text\r\n'.repeat(6) + currentPrompt;
      assert.strictEqual(ClaudeBridge.trustPromptCursorDelta(withInputBox), 1);
    });
  });

  describe('clearEmptyTranscript', function() {
    // The id is interpolated into paths this deletes — one of them recursively,
    // inside the user's home. Anything that isn't a uuid must be refused before
    // a single fs call happens.
    it('refuses ids that are not uuids', function() {
      const bad = ['../../..', '.', '..', '', null, undefined, 'a/b', 'not-a-uuid',
                   '../../../.claude', '3f389a10-7fe6-42ed-81fc-ada46a5f4232/../..'];
      for (const id of bad) {
        assert.strictEqual(bridge.clearEmptyTranscript(id), false, `must refuse ${JSON.stringify(id)}`);
      }
    });

    it('accepts a well-formed uuid (and reports false when nothing matches)', function() {
      assert.strictEqual(bridge.clearEmptyTranscript('3f389a10-7fe6-42ed-81fc-ada46a5f4232'), false);
    });
  });
});