const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Creating a tab used to take three dialogs in a row: the folder browser, then
// Create New Session, then the Start Claude prompt. They were folded into one
// (#newTabModal) that arrives prefilled, so the common case is + then Enter.
// Folding them is where rules get lost, so the rules each of the three used to
// enforce are pinned here.
//
// Static assertions over the source, like session-create-guard.test.js: the
// flow cannot be exercised without a DOM and a live socket (it was measured in
// a browser against :32353 instead), but its guards can be kept from silently
// disappearing.
describe('new tab dialog', function () {
  const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  const APP = read('src', 'public', 'app.js');
  const HTML = read('src', 'public', 'index.html');
  const TABS = read('src', 'public', 'session-manager.js');

  function body(name) {
    const m = new RegExp(`\\n    (?:async )?${name}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n    \\}`).exec(APP);
    assert.ok(m, `${name} is gone — this guard is measuring nothing`);
    return m[1];
  }

  it('has no duplicate ids, now that two dialogs were merged into one', function () {
    // The merge moved the folder browser's controls in by id; a leftover copy
    // would make getElementById answer for the wrong one.
    const ids = (HTML.match(/\sid="[^"]+"/g) || []).map(s => s.trim());
    const dups = ids.filter((id, i) => ids.indexOf(id) !== i);
    assert.deepStrictEqual(dups, []);
  });

  it('keeps the folder controls inside the dialog', function () {
    const a = HTML.indexOf('id="newTabModal"');
    const b = HTML.indexOf('id="newTabStartBtn"');
    assert.ok(a > -1 && b > a, '#newTabModal and its start button');
    const dialog = HTML.slice(a, b);
    for (const id of ['currentPathInput', 'folderList', 'folderUpBtn', 'folderHomeBtn', 'createFolderBtn',
                      'showHiddenFolders', 'sessionModeToggle', 'newSessionConversations', 'sessionName',
                      'newTabModelSelect', 'newTabPermissionSelect']) {
      assert.ok(dialog.includes(`id="${id}"`), `#${id} must live in the new tab dialog`);
    }
  });

  it('offers the same launch options as the Start prompt', function () {
    // Two lists of the same values: the dialog's are labelled in Chinese, the
    // Start prompt's in English. The values are what reach `claude`.
    const values = (id) => {
      const m = new RegExp(`<select id="${id}">([\\s\\S]*?)</select>`).exec(HTML);
      assert.ok(m, `#${id} is gone`);
      return (m[1].match(/value="([^"]*)"/g) || []);
    };
    assert.deepStrictEqual(values('newTabModelSelect'), values('claudeModelSelect'));
    assert.deepStrictEqual(values('newTabPermissionSelect'), values('claudePermissionSelect'));
    assert.deepStrictEqual(values('newTabEffortSelect'), values('claudeEffortSelect'));
    // And nothing on offer that the bridge would silently drop.
    const Bridge = require('../src/claude-bridge');
    const offered = (id) => values(id).map(v => v.slice(7, -1)).filter(Boolean);
    for (const [id, list] of [['newTabModelSelect', Bridge.MODELS], ['newTabPermissionSelect', Bridge.PERMISSION_MODES],
                              ['newTabEffortSelect', Bridge.EFFORTS]]) {
      for (const v of offered(id)) assert.ok(list.includes(v), `#${id} offers "${v}", which the bridge drops`);
    }
  });

  describe('starting', function () {
    const fn = () => body('createNewSession');

    it('refuses a folder that is not a project, before creating anything', function () {
      const src = fn();
      const check = src.indexOf('this.nonProjectDirReason(workingDir)');
      const request = src.indexOf('await this.requestSession');
      assert.ok(check > -1, 'the launch dir / home / root check is missing');
      assert.ok(check < request, 'the check must run before the session is created');
    });

    it('will not continue a conversation that was not picked', function () {
      assert.ok(/resuming && !this\.selectedConversation/.test(fn()));
    });

    it('arms the auto-start before the tab exists, not after', function () {
      // session_joined arrives while attachSessionTab is still awaiting. Armed
      // after, the join finds nothing and raises the Start prompt instead — the
      // third dialog this whole change exists to remove.
      const src = fn();
      const arm = src.indexOf('this.pendingStart = { options }');
      const attach = src.indexOf('await this.attachSessionTab');
      assert.ok(arm > -1 && attach > -1, 'pendingStart or attachSessionTab is gone');
      assert.ok(arm < attach, 'pendingStart must be set before attachSessionTab');
    });

    it('tells the server only when the name was typed', function () {
      // A typed name goes to `claude --name`; a derived one must not (it would
      // freeze the conversation's title) — see test/start-options.test.js.
      assert.ok(/customName = document\.getElementById\('sessionName'\)\.dataset\.userEdited === 'true'/.test(fn()));
      assert.ok(/customName/.test(body('requestSession')), 'requestSession must send customName');
    });

    it('never remembers skipping permissions', function () {
      const src = body('rememberNewTab');
      assert.ok(!/dangerouslySkipPermissions/.test(src), 'dangerous mode must be asked for every time');
    });
  });

  it('still spells out the resume refusals', function () {
    const src = body('requestSession');
    assert.ok(/response\.status === 409/.test(src), 'one conversation, one tab');
    assert.ok(/response\.status === 404/.test(src), 'a conversation that is gone');
  });

  it('is where every "new" entry point lands', function () {
    // + in the tab bar, Ctrl+T and the Sessions panel go through the tab
    // manager; the rest call the dialog directly. The old chain's openers must
    // not come back as a second road.
    assert.ok(/createNewSession\(\)\s*\{[\s\S]*?openNewTabDialog\(\)/.test(TABS), 'tab manager → dialog');
    assert.ok(/ensureProjectFolder\(options\)\s*\{[\s\S]*?openNewTabDialog\(\{ reason/.test(APP),
      'a refused folder reopens the dialog with its reason');
    for (const gone of ['showFolderBrowser', 'showNewSessionModal', 'selectCurrentFolder', 'isCreatingNewSession']) {
      assert.ok(!APP.includes(gone) && !TABS.includes(gone), `${gone} belongs to the old three-dialog chain`);
    }
  });

  it('leaves a way forward when cancelled with no tab open', function () {
    const src = body('hideNewTabDialog');
    assert.ok(/cancelled && [\s\S]*?tabs\.size === 0[\s\S]*?showOverlay\('startPrompt'\)/.test(src),
      'with nothing behind the dialog, cancelling must leave the Start prompt up');
  });
});
