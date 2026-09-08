const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Creating a session used to be re-entrant: the dialog stayed open and its
// button stayed live until the POST came back, so an impatient second click was
// a second session and a second tab. Reproduced in a browser — three clicks,
// three sessions on disk, three tabs — and reported from the dev instance as
// "it keeps creating tabs".
//
// A static assertion over the source, like overlay-stacking.test.js: the guard
// cannot be exercised without a DOM, but it can be kept from silently
// disappearing.
describe('new session: no duplicate creates', function () {
  const APP = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'app.js'), 'utf8');
  const fn = /async createNewSession\s*\([^)]*\)\s*\{([\s\S]*?)\n    \}/.exec(APP);

  it('still has the function this guards', function () {
    assert.ok(fn, 'createNewSession is gone — this guard is measuring nothing');
  });

  it('refuses to run while a create is already in flight', function () {
    assert.ok(/if \(this\._creatingSession\) return;/.test(fn[1]),
      'the in-flight guard is missing');
  });

  it('takes the guard before awaiting the request, not after', function () {
    // A flag set after the await is no flag at all: the second click happens
    // during the await, which is exactly the window being closed.
    const body = fn[1];
    const guard = body.indexOf('this._creatingSession = true');
    const request = body.indexOf('await this.requestSession');
    assert.ok(guard > -1 && request > -1, 'guard or request call is gone');
    assert.ok(guard < request, 'the guard must be taken before the request is issued');
  });

  it('releases the guard on every path, including refusal', function () {
    // The refusal path returns early. Without a finally, one refused create
    // would leave the button dead for the rest of the page's life.
    assert.ok(/\}\s*finally\s*\{[\s\S]*_creatingSession = false/.test(fn[1]),
      'the guard must be released in a finally, not only on success');
    assert.ok(/finally\s*\{[\s\S]*disabled = false/.test(fn[1]),
      'the button must be re-enabled in the same finally');
  });
});
