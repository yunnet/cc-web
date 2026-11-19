// Commit-graph lane assignment for the Git IDE panel's history column.
//
// Pure data in, data out — no DOM — so the same file runs in the browser (as
// window.GitIdeGraph, loaded before git-ide.js) and under Node in the mocha
// suite. The design brief is dsh-ide-git's: one column per concurrent line of
// history, rows a fixed height so adjacent rows' SVG cells line up pixel for
// pixel, and the whole loaded list recomputed at once.
//
// Input: commits in display order (newest first), each { sha, parents[] } —
// parents full shas, exactly what /api/git/ide/log returns. Output: one row
// per commit:
//   {
//     lane,        // column of this commit's dot
//     mergesIn,    // columns above that bend into this dot (same commit was
//                  // expected by several columns — a merge knot converging)
//     mergeOut,    // columns this commit's extra parents continue into below
//     activeAfter  // column indices still alive below this row, in order —
//                  // the verticals to draw in the gap under this row
//   }
//
// The state machine keeps one "expected sha" per column (the commit that
// column is waiting for next, older). Columns are never compacted: indices
// only grow, which keeps every edge stable while pages append — recomputing
// the full loaded list (capped by the panel's row limit) costs microseconds
// against a page size of 120.
var GitIdeGraph = (function () {
  'use strict';

  function computeLanes(commits) {
    const lanes = [];  // lanes[k] = sha column k waits for, or null when ended
    const rows = [];
    const waitingFor = (sha) => lanes.indexOf(sha);

    for (const c of commits) {
      const parents = (c && c.parents) || [];

      let lane = waitingFor(c.sha);
      if (lane === -1) {
        lanes.push(c.sha);
        lane = lanes.length - 1;
      }

      // Any OTHER column waiting on this same sha converges here: the knot
      // the graph draws as a bend into the dot. Converged columns are
      // retired — left holding their old sha they would wait forever and
      // draw a ghost vertical below the last commit that ever needs them.
      const mergesIn = [];
      for (let k = 0; k < lanes.length; k++) {
        if (k !== lane && lanes[k] === c.sha) {
          mergesIn.push(k);
          lanes[k] = null;
        }
      }

      // First parent continues this column; a parentless commit ends it.
      lanes[lane] = parents[0] || null;

      // Additional parents: join a column already waiting for them, or open
      // a new one — that column starts below this row (a bend out).
      const mergeOut = [];
      for (let i = 1; i < parents.length; i++) {
        let k = waitingFor(parents[i]);
        if (k === -1) {
          lanes.push(parents[i]);
          k = lanes.length - 1;
        }
        if (k !== lane) mergeOut.push(k);
      }

      const activeAfter = [];
      for (let k = 0; k < lanes.length; k++) {
        if (lanes[k] !== null) activeAfter.push(k);
      }

      rows.push({ lane, mergesIn, mergeOut, activeAfter });
    }
    return rows;
  }

  // A commit's refs decorate its row as badges; the colors are the panel's
  // business. Lane color just cycles: lane % 6.
  return { computeLanes };
})();

if (typeof module !== 'undefined') module.exports = GitIdeGraph;
