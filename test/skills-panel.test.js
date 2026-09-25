// Guards for the skills panel — the behaviour that can break while every id in
// FEATURES.md is still present, which the two-way check cannot see.
//
// The panel runs in a browser, so the guards here are assertions over the
// sources plus the one piece of logic worth running on its own. What a browser
// had to confirm (geometry, hit testing) is in test/SMOKE.md instead.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const JS = read('src', 'public', 'skills.js');
const CSS = read('src', 'public', 'style.css');
const HTML = read('src', 'public', 'index.html');
const APP = read('src', 'public', 'app.js');

describe('SKILL-01 one panel, two entry points', function () {
  it('the menu button and the Settings button both go through app.openSkillsPanel', function () {
    assert.ok(/openSkillsPanel\s*\(pane\)\s*\{/.test(APP), 'openSkillsPanel is gone');
    // Both listeners must call it: two entry points rendering one list is the
    // whole reason the Sessions panel was unified, and this copies that.
    const menu = /skillsBtnMobile[\s\S]{0,300}?openSkillsPanel\(\)/.test(APP);
    const settings = /skillsOpenBtn[\s\S]{0,300}?openSkillsPanel\(\)/.test(APP);
    assert.ok(menu, 'the menu button no longer opens the panel');
    assert.ok(settings, 'the Settings button no longer opens the panel');
  });

  it('opening from Settings closes Settings first, so two modals do not stack', function () {
    assert.ok(/skillsOpenBtn[\s\S]{0,300}?hideSettings\(\)/.test(APP));
  });
});

describe('SKILL-02 / SKILL-22 the panel is a fixed-height column', function () {
  it('only one pane shows at a time — an explicit display would beat [hidden]', function () {
    // display:flex on .skills-pane overrides the hidden attribute unless this
    // rule exists. Without it every pane renders at once.
    assert.ok(/#skillsModal\s+\.skills-pane\[hidden\]\s*\{\s*display:\s*none/.test(CSS),
      'the [hidden] rule is gone, so all three panes would be visible together');
  });

  it('header and footer stay put while the list scrolls', function () {
    assert.ok(/#skillsModal\s+\.modal-content\s*\{[^}]*flex-direction:\s*column/.test(CSS));
    assert.ok(/#skillsModal\s+\.modal-body\s*\{[^}]*min-height:\s*0/.test(CSS),
      'without min-height:0 a flex child will not shrink and the body grows past the dialog');
    assert.ok(/#skillsModal\s+\.conv-list\s*\{[^}]*flex:\s*1 1 auto/.test(CSS));
  });

  it('keeps the add row and the search box out of the scroller', function () {
    // Measured at 780x493: with the add row inside the scroll, its bottom edge
    // sat 16px past the dialog and elementFromPoint stopped finding it.
    assert.ok(/#skillsModal \.skills-add-market,[\s\S]{0,120}flex-shrink:\s*0/.test(CSS));
  });

  it('gives the phone layout a full-width 44px add button', function () {
    const media = CSS.slice(CSS.indexOf('@media (max-width: 700px)', CSS.indexOf('.skills-tabs')));
    assert.ok(/\.skills-add-market \.btn\s*\{[^}]*min-height:\s*44px/.test(media));
  });
});

describe('SKILL-09 a plugin you already have is not "not found"', function () {
  it('searching also looks through what is installed', function () {
    // The CLI's available list leaves installed plugins out (measured: 299
    // available, 15 installed, 2 overlapping), so a search for one you have
    // would otherwise come back empty.
    assert.ok(/你已经装了/.test(JS), 'the "already installed" group is gone');
    assert.ok(/this\.installed\s*&&\s*this\.installed\.plugins/.test(JS));
  });
});

describe('SKILL-11 / SKILL-12 nothing is installed without a person agreeing', function () {
  it('asks before installing, and names the risk', function () {
    assert.ok(/window\.confirm\([^)]*安装/.test(JS) || /install\(r\)\s*\{[\s\S]{0,400}window\.confirm/.test(JS));
    assert.ok(/把别人写的指令交给 Claude/.test(JS), 'the warning about third-party instructions is gone');
  });

  it('shows a marketplace-declared command verbatim, with its sha, before running it', function () {
    assert.ok(/confirmCommand\s*\(/.test(JS));
    assert.ok(/confirm\.command/.test(JS) && /confirm\.sha256/.test(JS),
      'the command and sha must both be shown — a sha alone is not reviewable');
    // The accept only ever travels after that confirm.
    // Anchor on the DEFINITION, not the call site: both read
    // `confirmCommand(action` and the call comes first in the file.
    const start = JS.indexOf('\n    confirmCommand(action, target, confirm, extra) {');
    const end = JS.indexOf('\n    install(r) {');
    assert.ok(start > 0 && end > start, 'confirmCommand is gone — this guard is measuring nothing');
    const fn = JS.slice(start, end);
    assert.ok(/acceptSha:\s*confirm\.sha256/.test(fn));
    assert.ok(/if \(!ok\)/.test(fn), 'declining must not fall through to the install');
  });

  it('never sends -y from the browser either', function () {
    assert.ok(!/['"]-y['"]/.test(JS), "the panel must not be able to ask for -y");
  });
});

describe('SKILL-15 the panel does not restart anything', function () {
  it('says when a change takes effect instead of acting on it', function () {
    assert.ok(/下次启动会话时生效/.test(JS));
    // Nothing here may stop or start a session.
    assert.ok(!/startClaude|stopSession|closeSession/.test(JS));
  });
});

describe('SKILL-16 the panel says why a half of it is empty', function () {
  it('translates the two problems the server reports', function () {
    assert.ok(/'no-claude-cli':\s*'找不到 claude 命令/.test(JS));
    assert.ok(/timeout:\s*'claude 命令没有在限定时间内返回'/.test(JS));
  });

  it('writes the status with textContent, never innerHTML', function () {
    const note = JS.slice(JS.indexOf('note(text, isError)'), JS.indexOf('render() {'));
    assert.ok(/textContent/.test(note) && !/innerHTML/.test(note));
  });

  it('renders a SKILL.md as text — it is someone else\'s file', function () {
    const detail = JS.slice(JS.indexOf('detailBox(key)'), JS.indexOf('async toggleDetail'));
    assert.ok(/textContent/.test(detail), 'a SKILL.md must never be set as innerHTML');
    assert.ok(/createElement\('pre'\)/.test(detail));
  });
});

describe('SKILL-08 searching does not spawn a CLI per keystroke', function () {
  it('debounces the search box', function () {
    const bind = JS.slice(JS.indexOf('const search = this.el(\'skillsSearchInput\')'));
    assert.ok(/clearTimeout\(timer\)/.test(bind) && /setTimeout\([\s\S]{0,120}?250\)/.test(bind));
  });
});

describe('SKILL-17 the panel closes every way a modal should', function () {
  it('binds the close button, the done button and the backdrop', function () {
    assert.ok(/closeSkillsBtn[\s\S]{0,120}addEventListener/.test(JS));
    assert.ok(/skillsDoneBtn[\s\S]{0,120}addEventListener/.test(JS));
    assert.ok(/e\.target === modal/.test(JS), 'clicking the scrim no longer closes it');
  });

  it('refresh drops the cached catalogue and the read SKILL.md bodies', function () {
    assert.ok(/skillsRefreshBtn[\s\S]{0,200}this\.catalog = null[\s\S]{0,80}this\.details = \{\}/.test(JS));
  });
});

describe('the panel markup', function () {
  it('has the eleven controls FEATURES.md lists, once each', function () {
    for (const id of ['skillsBtnMobile', 'skillsOpenBtn', 'closeSkillsBtn', 'skillsTabInstalled',
      'skillsTabDiscover', 'skillsTabMarkets', 'skillsSearchInput', 'skillsMarketInput',
      'skillsMarketAddBtn', 'skillsRefreshBtn', 'skillsDoneBtn']) {
      const n = HTML.split(`id="${id}"`).length - 1;
      assert.strictEqual(n, 1, `${id} appears ${n} times in index.html`);
    }
  });

  it('is loaded by the page', function () {
    assert.ok(/<script src="skills\.js"><\/script>/.test(HTML));
  });

  it('reuses the session-modal shell, so it stacks like the Sessions panel', function () {
    assert.ok(/<div class="session-modal" id="skillsModal">/.test(HTML));
  });
});
