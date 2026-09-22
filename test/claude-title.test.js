const assert = require('assert');
const { claudeTitleState } = require('../src/public/claude-title');

// Claude Code's terminal title is how a tab can tell it is working. The
// samples are the titles a real 2.1.278 set during one answer.
describe('claude terminal title', function () {
  it('reads the real titles of one answer', function () {
    assert.deepStrictEqual(claudeTitleState('✳ Claude Code'), { working: false, topic: 'Claude Code' });
    assert.deepStrictEqual(claudeTitleState('◐ Claude Code'), { working: true, topic: 'Claude Code' });
    assert.deepStrictEqual(claudeTitleState('◐ Count 1 to 30'), { working: true, topic: 'Count 1 to 30' });
    assert.deepStrictEqual(claudeTitleState('◑ Count 1 to 30'), { working: true, topic: 'Count 1 to 30' });
    assert.deepStrictEqual(claudeTitleState('✳ Count 1 to 30'), { working: false, topic: 'Count 1 to 30' });
  });

  it('knows the other two quarter-turns too', function () {
    assert.strictEqual(claudeTitleState('◒ x').working, true);
    assert.strictEqual(claudeTitleState('◓ x').working, true);
  });

  it('keeps a Chinese topic and treats a plain or missing title as idle', function () {
    assert.deepStrictEqual(claudeTitleState('◐ 修复标签页状态'), { working: true, topic: '修复标签页状态' });
    assert.deepStrictEqual(claudeTitleState('bash'), { working: false, topic: 'bash' });
    assert.deepStrictEqual(claudeTitleState(''), { working: false, topic: '' });
    assert.deepStrictEqual(claudeTitleState(undefined), { working: false, topic: '' });
    // A ball later in the title is text, not a status.
    assert.strictEqual(claudeTitleState('Fix ◐ glyph').working, false);
  });
});

// The wiring. Static, like session-views.test.js: it was measured against a
// live Claude on a throwaway instance; these keep it from quietly regressing.
describe('tabs show Claude working', function () {
  const fs = require('fs');
  const path = require('path');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'public', f), 'utf8');
  const APP = read('app.js');
  const SPLITS = read('splits.js');
  const MANAGER = read('session-manager.js');
  const CSS = read('style.css');
  const HTML = read('index.html');

  it('updates the tab from every view, not only the visible one', function () {
    const fn = /term\.onTitleChange\(\(title\) => \{([\s\S]*?)\n        \}\);/.exec(APP);
    assert.ok(fn, 'the main terminal no longer listens to its title');
    const setAt = fn[1].indexOf('setTabWorking(view.sessionId');
    const guardAt = fn[1].indexOf('if (this.activeView !== view) return;');
    assert.ok(setAt > -1, 'the title must reach the tab');
    assert.ok(guardAt === -1 || setAt < guardAt, 'a background tab must be updated before the visible-only guard');
  });

  it('listens in split panes too', function () {
    assert.ok(/this\.terminal\.onTitleChange\([\s\S]*?setTabWorking\(this\.sessionId/.test(SPLITS));
  });

  it('stops the ball when Claude exits or is stopped', function () {
    assert.ok(/case 'claude_stopped': \{[\s\S]*?setTabWorking\(stoppedId, false\)/.test(APP), 'claude_stopped');
    assert.ok(/case 'exit': \{[\s\S]*?setTabWorking\(exitId, false\)/.test(APP), 'exit, main terminal');
    assert.ok(/case 'exit':[\s\S]{0,200}setTabWorking\(this\.sessionId, false\)/.test(SPLITS), 'exit, split pane');
  });

  it('marks working with an attribute updateTabStatus cannot wipe', function () {
    // updateTabStatus rewrites the dot's className on every status change.
    assert.ok(/tab\.dataset\.working = ''/.test(MANAGER), 'data-working on the tab');
    assert.ok(/\.session-tab\[data-working\] \.tab-status \{/.test(CSS), 'styled off the attribute');
    assert.ok(/prefers-reduced-motion: reduce\)[\s\S]{0,120}data-working\][\s\S]{0,60}animation: none/.test(CSS), 'still ball, no spin, for reduced motion');
  });

  it('loads the parser before the scripts that use it', function () {
    const at = (f) => HTML.indexOf(`<script src="${f}"></script>`);
    assert.ok(at('claude-title.js') > -1 && at('claude-title.js') < at('splits.js') && at('claude-title.js') < at('app.js'));
  });
});
