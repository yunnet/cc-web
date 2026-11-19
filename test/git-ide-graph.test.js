const assert = require('assert');
const { computeLanes } = require('../src/public/git-ide-graph');

// Rows are asserted by their essentials (dot lane + knots), because that is
// what the renderer draws and what a wrong algorithm breaks: a misplaced dot
// shifts an entire history line, a missed mergesIn drops a merge's bend and
// the graph silently lies about the topology.
function row(commits, i) {
  const rows = computeLanes(commits);
  const r = rows[i];
  return {
    lane: r.lane,
    mergesIn: r.mergesIn,
    mergeOut: r.mergeOut,
    alive: r.activeAfter
  };
}

describe('git-ide-graph', function () {
  it('a straight line lives in one column', function () {
    const commits = [
      { sha: 'c3', parents: ['c2'] },
      { sha: 'c2', parents: ['c1'] },
      { sha: 'c1', parents: [] }
    ];
    const rows = computeLanes(commits);
    assert.deepStrictEqual(rows.map((r) => r.lane), [0, 0, 0]);
    assert.deepStrictEqual(rows[0].mergesIn, []);
    assert.deepStrictEqual(rows[1].activeAfter, [0]);
  });

  it('a side branch opens a second column and knots back at the fork point', function () {
    // main: m1 <- m2 ; side: b1 off m1. Display order (newest first) is what
    // /api/git/ide/log?scope=all produces: m2, b1, m1.
    const commits = [
      { sha: 'm2', parents: ['m1'] },
      { sha: 'b1', parents: ['m1'] },
      { sha: 'm1', parents: [] }
    ];
    const rows = computeLanes(commits);
    assert.strictEqual(rows[0].lane, 0);            // m2 opens column 0
    assert.strictEqual(rows[1].lane, 1);            // b1 opens column 1
    assert.deepStrictEqual(rows[1].activeAfter, [0, 1]); // both wait on m1
    assert.strictEqual(rows[2].lane, 0);            // m1 takes the first column
    assert.deepStrictEqual(rows[2].mergesIn, [1]);  // b1's line bends into it
    assert.deepStrictEqual(rows[2].activeAfter, []); // root: nothing below
  });

  it('a merge commit routes its extra parent out to that parent\'s column', function () {
    // m1 <- m2 <- b2 (branch) and m3 = merge(b2, m2) back on main.
    const commits = [
      { sha: 'm3', parents: ['b2', 'm2'] },  // the merge, first parent b2
      { sha: 'b2', parents: ['b1'] },
      { sha: 'm2', parents: ['m1'] },
      { sha: 'b1', parents: ['m1'] },
      { sha: 'm1', parents: [] }
    ];
    const rows = computeLanes(commits);
    // m3: dot in column 0 (waiting-for-m3 none → new); first parent b2 keeps
    // column 0; second parent m2 must open column 1 as a bend out.
    assert.strictEqual(rows[0].lane, 0);
    assert.deepStrictEqual(rows[0].mergeOut, [1]);
    assert.deepStrictEqual(rows[0].activeAfter, [0, 1]);
    // The knot at the fork: both columns wait on m1 — the fifth row.
    assert.deepStrictEqual(rows[2].mergesIn, []);
    assert.strictEqual(rows[3].lane, 0);
    assert.strictEqual(rows[4].lane, 0);
    assert.deepStrictEqual(rows[4].mergesIn, [1]);
    assert.deepStrictEqual(rows[4].activeAfter, []);
  });

  it('a parentless commit ends its column (shallow boundary and true root)', function () {
    const commits = [
      { sha: 'a', parents: [] },
      { sha: 'b', parents: ['a'] }   // synthetic order where b is older — the
                                      // algorithm still assigns columns sanely
    ];
    const rows = computeLanes(commits);
    assert.strictEqual(rows[0].activeAfter.length, 0);
    assert.strictEqual(rows[0].lane, 0);
  });

  it('an octopus merge converges however many columns wait on it', function () {
    // head has three parents p1, p2, p3; each parent chain is a column.
    const commits = [
      { sha: 'h', parents: ['p1', 'p2', 'p3'] },
      { sha: 'p3', parents: ['base'] },
      { sha: 'p2', parents: ['base'] },
      { sha: 'p1', parents: ['base'] },
      { sha: 'base', parents: [] }
    ];
    const rows = computeLanes(commits);
    assert.deepStrictEqual(rows[0].mergeOut, [1, 2]);
    const base = rows[4];
    assert.strictEqual(base.lane, 0);
    assert.deepStrictEqual(base.mergesIn.sort(), [1, 2]);
    assert.deepStrictEqual(base.activeAfter, []);
  });

  it('columns never compact: appending a page keeps earlier rows identical', function () {
    // The panel loads 120 rows, then appends more; recomputing must not move
    // a dot the user is already looking at.
    const page1 = [
      { sha: 'm2', parents: ['m1'] },
      { sha: 'b1', parents: ['m1'] }
    ];
    const page2 = page1.concat([{ sha: 'm1', parents: [] }]);
    const r1 = computeLanes(page1);
    const r2 = computeLanes(page2);
    assert.deepStrictEqual(r2.slice(0, page1.length), r1);
  });

  it('a commit expected by no column (unrelated tip) still draws', function () {
    const commits = [
      { sha: 'x', parents: ['q'] },
      { sha: 'y', parents: ['q'] },
      { sha: 'q', parents: [] }
    ];
    const rows = computeLanes(commits);
    assert.deepStrictEqual(rows.map((r) => r.lane), [0, 1, 0]);
    assert.deepStrictEqual(rows[2].mergesIn, [1]);
  });

  it('empty and degenerate inputs produce empty output, not a crash', function () {
    assert.deepStrictEqual(computeLanes([]), []);
    assert.deepStrictEqual(computeLanes([{ sha: 'z' }])[0].lane, 0);
  });
});
