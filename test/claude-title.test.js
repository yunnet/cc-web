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

// "Finished" is held back: waiting for a permission answer turns the title to
// ✳ as well, and the permission_prompt hook follows ~6s later (measured on
// 2.1.278). Runs the real SessionTabManager methods against stub tabs, with
// fake timers.
describe('tab finished (✓)', function () {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'session-manager.js'), 'utf8');

  function setup({ hidden = false } = {}) {
    const timers = [];
    const notes = [];
    const doc = { hidden };
    const ctx = vm.createContext({
      window: {}, document: doc, console, navigator: {},
      ClaudeTitle: { DONE_GRACE_MS: 8000 },
      setTimeout: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
      clearTimeout: (t) => { if (t) t.live = false; }
    });
    vm.runInContext(`${SRC}\nthis.M = SessionTabManager;`, ctx);
    const m = Object.create(ctx.M.prototype);
    Object.assign(m, { tabs: new Map(), activeSessions: new Map(), activeTabId: 'a', claudeInterface: null });
    m.sendNotification = (title, body, id) => notes.push({ title, body, id });
    const tab = () => ({ dataset: {}, hasAttribute(n) { return n.slice(5) in this.dataset; }, querySelector: () => null });
    for (const id of ['a', 'b']) {
      m.tabs.set(id, tab());
      m.activeSessions.set(id, { name: id.toUpperCase() });
    }
    const fire = () => timers.filter(t => t.live).forEach(t => { t.live = false; t.fn(); });
    return { m, doc, timers, notes, fire, done: (id) => m.tabs.get(id).hasAttribute('data-done') };
  }

  it('marks a background tab and notifies with the topic, after the grace period', function () {
    const { m, notes, fire, done, timers } = setup();
    m.setTabWorking('b', true, 'Fix bug');
    m.setTabWorking('b', false, 'Fix bug');
    assert.strictEqual(done('b'), false, 'not before the grace period');
    assert.strictEqual(timers.find(t => t.live).ms, 8000);
    fire();
    assert.strictEqual(done('b'), true);
    assert.deepStrictEqual(notes, [{ title: 'B 答完了', body: 'Fix bug', id: 'b' }]);
  });

  it('leaves the tab being looked at alone, but not when the page is hidden', function () {
    let s = setup();
    s.m.setTabWorking('a', true, 'x'); s.m.setTabWorking('a', false, 'x'); s.fire();
    assert.strictEqual(s.done('a'), false);
    s = setup({ hidden: true });
    s.m.setTabWorking('a', true, 'x'); s.m.setTabWorking('a', false, 'x'); s.fire();
    assert.strictEqual(s.done('a'), true);
  });

  it('is called off by new work, a permission request or opening the tab', function () {
    for (const interrupt of [
      (m) => m.setTabWorking('b', true, 'x'),
      (m) => { m.tabs.get('b').dataset.awaiting = ''; },
      (m) => m.setTabDone('b', false)
    ]) {
      const { m, notes, fire, done } = setup();
      m.setTabWorking('b', true, 'x'); m.setTabWorking('b', false, 'x');
      interrupt(m);
      fire();
      assert.strictEqual(done('b'), false);
      assert.deepStrictEqual(notes, []);
    }
  });

  it('does not call a stopped or exited process an answer', function () {
    const { m, fire, done } = setup();
    m.setTabWorking('b', true, 'x');
    m.setTabWorking('b', false);
    fire();
    assert.strictEqual(done('b'), false);
  });

  it('clears when the tab is opened and when Claude works again', function () {
    const MANAGER = SRC;
    assert.ok(/async switchToTab\(sessionId[\s\S]*?this\.setTabDone\(sessionId, false\)/.test(MANAGER), 'switchToTab');
    const { m, fire, done } = setup();
    m.setTabWorking('b', true, 'x'); m.setTabWorking('b', false, 'x'); fire();
    m.setTabWorking('b', true, 'y');
    assert.strictEqual(done('b'), false);
  });

  it('never puts the topic into markup', function () {
    // The mobile fallback shows the notification body; the topic is terminal text.
    const fn = /showMobileNotification\(title, body, sessionId\) \{([\s\S]*?)\n    \}\n/.exec(SRC);
    assert.ok(fn, 'showMobileNotification is gone');
    assert.ok(!/innerHTML/.test(fn[1]), 'title/body must go in as textContent');
  });
});

describe('page title and bell, next to the ✓', function () {
  const fs = require('fs');
  const path = require('path');
  const APP = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'app.js'), 'utf8');
  const body = (name) => {
    const m = new RegExp(`\\n    ${name}\\([^)]*\\) \\{([\\s\\S]*?)\\n    \\}`).exec(APP);
    assert.ok(m, `${name} is gone`);
    return m[1];
  };

  it('puts ✓ in front of the browser tab title only while the page is hidden', function () {
    assert.ok(/document\.hidden && document\.querySelector\('\.session-tab\[data-done\]'\)/.test(body('updatePageTitle')));
    assert.ok(/addEventListener\('visibilitychange', \(\) => \{[\s\S]*?this\.updatePageTitle\(\);\s*\}\)/.test(APP), 'coming back takes it off');
    // One writer: the title handler goes through it rather than setting document.title itself.
    assert.ok(!/document\.title = topic/.test(APP));
  });

  it('rings but does not notify twice for a tab awaiting approval', function () {
    assert.ok(/term\.onBell\(\(\) => this\.handleBell\(view\.sessionId\)\)/.test(APP));
    const src = body('handleBell');
    assert.ok(/const told = tab && tab\.hasAttribute\('data-awaiting'\);/.test(src));
    assert.ok(/document\.hidden && !told/.test(src));
    assert.ok(/\{ tag: sessionId \}/.test(src), 'same tag as sendNotification, so one replaces the other');
  });

  it('still reminds a finished tab when Claude rings a minute later', function () {
    // The user asked for this back (2026-09-22): v4.11.9 had dropped the
    // idle_prompt bell's notification for a tab already showing ✓.
    const src = body('handleBell');
    assert.ok(!/data-done/.test(src), 'a ✓ must not silence the reminder');
  });
});

describe('mobile notification title flash', function () {
  it('ends on the current title, not the one it started from', function () {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'public', 'session-manager.js'), 'utf8');
    const fn = /showMobileNotification\(title, body, sessionId\) \{([\s\S]*?)\n    \}\n/.exec(src)[1];
    assert.ok(!/originalTitle/.test(fn), 'a title saved before the flash goes stale');
    assert.ok(/clearInterval\(flashInterval\);\s*restore\(\);/.test(fn));
  });
});

describe('tab awaiting approval', function () {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'public', f), 'utf8');
  const SRC = read('session-manager.js');

  function setup({ hidden = false } = {}) {
    const timers = [];
    const notes = [];
    const ctx = vm.createContext({
      window: {}, document: { hidden }, console, navigator: {},
      ClaudeTitle: { DONE_GRACE_MS: 8000 },
      setTimeout: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
      clearTimeout: (t) => { if (t) t.live = false; }
    });
    vm.runInContext(`${SRC}\nthis.M = SessionTabManager;`, ctx);
    const m = Object.create(ctx.M.prototype);
    Object.assign(m, { tabs: new Map(), activeSessions: new Map(), activeTabId: 'a', claudeInterface: null });
    m.sendNotification = (title, body, id) => notes.push({ title, body, id });
    for (const id of ['a', 'b']) {
      m.tabs.set(id, { dataset: {}, hasAttribute(n) { return n.slice(5) in this.dataset; }, querySelector: () => null });
      m.activeSessions.set(id, { name: id.toUpperCase() });
    }
    const fire = () => timers.filter(t => t.live).forEach(t => { t.live = false; t.fn(); });
    const has = (id, a) => m.tabs.get(id).hasAttribute(`data-${a}`);
    return { m, notes, fire, has, ctx };
  }

  it('marks a background tab and notifies, instead of calling it finished', function () {
    // The real order: the title turns ✳, the request follows ~6s later.
    const { m, notes, fire, has } = setup();
    m.setTabWorking('b', true, 'Touch x'); m.setTabWorking('b', false, 'Touch x');
    m.permissionRequested('b', 'Claude needs your permission');
    fire();
    assert.strictEqual(has('b', 'awaiting'), true);
    assert.strictEqual(has('b', 'done'), false);
    assert.deepStrictEqual(notes, [{ title: 'B 待批准', body: 'Claude needs your permission', id: 'b' }]);
  });

  it('does not mark the tab being looked at, nor let it turn into ✓ once the page is left', function () {
    const s = setup();
    s.m.setTabWorking('a', true, 'x'); s.m.setTabWorking('a', false, 'x');
    s.m.permissionRequested('a', 'm');
    s.ctx.document.hidden = true;   // the user walks away without answering
    s.fire();
    assert.strictEqual(s.has('a', 'awaiting'), false);
    assert.strictEqual(s.has('a', 'done'), false);
    assert.deepStrictEqual(s.notes, []);
  });

  it('comes off when the tab is opened, when Claude works again, or when the page is back', function () {
    let s = setup();
    s.m.permissionRequested('b', 'm');
    s.m.setTabWorking('b', true, 'x');
    assert.strictEqual(s.has('b', 'awaiting'), false, 'working again');

    s = setup({ hidden: true });
    s.m.permissionRequested('a', 'm');
    assert.strictEqual(s.has('a', 'awaiting'), true, 'hidden page: even the active tab');
    s.ctx.document.hidden = false;
    s.m.clearSeenMarks();
    assert.strictEqual(s.has('a', 'awaiting'), false, 'back on the page');

    assert.ok(/async switchToTab\(sessionId[\s\S]*?this\.setTabAwaiting\(sessionId, false\)/.test(SRC), 'switchToTab');
    assert.ok(/visibilitychange', \(\) => \{[\s\S]*?clearSeenMarks\(\)/.test(read('app.js')), 'visibilitychange');
  });

  it('hears the request from the main view and from a split pane', function () {
    const cond = /event === 'Notification' && m\w*\.notification_type === 'permission_prompt'/;
    assert.ok(cond.test(read('app.js')) && /permissionRequested\(message\.sessionId, message\.message\)/.test(read('app.js')));
    assert.ok(cond.test(read('splits.js')) && /permissionRequested\(this\.sessionId, msg\.message\)/.test(read('splits.js')));
  });

  it('is styled off an attribute, with the label after the name', function () {
    const CSS = read('style.css');
    assert.ok(/\.session-tab\[data-awaiting\] \.tab-status \{/.test(CSS));
    assert.ok(/\.session-tab\[data-awaiting\] \.tab-content::after \{[\s\S]*?content: '待批准';[\s\S]*?flex-shrink: 0;/.test(CSS));
  });
});

// The 90-second fallback: a background tab whose output went quiet after
// working says so. v4.11.9 removed it as a duplicate of ✓; the user asked for
// it back (2026-09-22). Runs the real markSessionActivity with fake timers.
describe('90-second "appears finished" notification', function () {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'session-manager.js'), 'utf8');

  it('notifies a background tab that worked and then went quiet for 90s', function () {
    const timers = [];
    const notes = [];
    const ctx = vm.createContext({
      window: {}, document: { hidden: false }, console, navigator: {}, ClaudeTitle: { DONE_GRACE_MS: 8000 },
      setTimeout: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
      clearTimeout: (t) => { if (t) t.live = false; }
    });
    vm.runInContext(`${SRC}\nthis.M = SessionTabManager;`, ctx);
    const m = Object.create(ctx.M.prototype);
    Object.assign(m, { tabs: new Map(), activeSessions: new Map([['b', { name: 'B' }]]), activeTabId: 'a', claudeInterface: null });
    m.updateTabStatus = (id, status) => { m.activeSessions.get(id).status = status; };
    m.updateUnreadIndicator = () => {};
    m.sendNotification = (title, body, id) => notes.push({ title, body, id });
    m.markSessionActivity('b', true);   // becomes active
    m.markSessionActivity('b', true);   // still active: this is the one whose quiet counts
    const t = timers.filter(x => x.live && x.ms === 90000).pop();
    assert.ok(t, 'the 90s timer is gone');
    t.fn();
    assert.strictEqual(notes.length, 1);
    assert.strictEqual(notes[0].title, 'B — Claude appears finished');
    assert.ok(/^No output for 90 seconds \(worked for \d+s\)$/.test(notes[0].body), notes[0].body);
    assert.strictEqual(notes[0].id, 'b');
  });
});
