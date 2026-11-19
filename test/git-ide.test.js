const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const gitIde = require('../src/git-ide');

// Real git trees, not mocks, for the same reason as git-branches.test.js: the
// module's whole job is asking git and parsing the answer, and the cases that
// break it (decoration strings, rename lines, tracking ahead/behind) only
// exist once git has written them.
function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
}

function gitText(cwd, ...args) {
  return String(git(cwd, ...args)).trim();
}

function commitFile(repo, name, content, message) {
  fs.writeFileSync(path.join(repo, name), content);
  git(repo, 'add', name);
  git(repo, 'commit', '-qm', message);
}

function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir], { stdio: 'pipe' });
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  commitFile(dir, 'a.txt', 'one\n', 'initial');
  return dir;
}

describe('git-ide', function () {
  this.timeout(20000);

  let root;
  let repo;
  let defaultBranch;
  let firstSha;

  before(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-gitide-'));
    repo = makeRepo(path.join(root, 'repo'));
    defaultBranch = gitText(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
    firstSha = gitText(repo, 'rev-parse', 'HEAD');

    commitFile(repo, 'b.txt', 'two\n', 'second: beta feature');
    git(repo, 'tag', 'v1');
    commitFile(repo, 'c.txt', 'three\n', 'third commit');

    // A side branch whose commit is NOT an ancestor of the default branch:
    // scope=current must exclude it, scope=all must include it.
    git(repo, 'checkout', '-qb', 'side', firstSha);
    commitFile(repo, 'side.txt', 'side\n', 'side branch work');

    // Remote-tracking refs and upstream config without any network: status
    // then reports the default branch as ahead of origin. All three settings
    // matter — without remote.origin.fetch, git cannot map the merge ref to
    // refs/remotes/* and the upstream silently resolves to nothing (verified:
    // %(upstream:short) comes back empty and status -b prints no counts).
    git(repo, 'checkout', '-q', defaultBranch);
    git(repo, 'update-ref', `refs/remotes/origin/${defaultBranch}`, firstSha);
    git(repo, 'config', 'remote.origin.url', path.join(root, 'nowhere'));
    git(repo, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
    git(repo, 'config', `branch.${defaultBranch}.remote`, 'origin');
    git(repo, 'config', `branch.${defaultBranch}.merge`, `refs/heads/${defaultBranch}`);
  });

  after(function () {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('summary', function () {
    it('reports branch, dirty count and ahead/behind against upstream', async function () {
      fs.writeFileSync(path.join(repo, 'dirty.txt'), 'x\n');
      try {
        const s = await gitIde.summary(repo);
        assert.strictEqual(s.branch, defaultBranch);
        assert.strictEqual(s.dirty, 1);
        assert.strictEqual(s.ahead, 2); // two commits past the origin ref
        assert.strictEqual(s.behind, 0);
        assert.strictEqual(s.detached, false);
        assert.ok(/^[0-9a-f]{40}$/.test(s.head));
        assert.strictEqual(s.inProgress, null);
      } finally {
        fs.rmSync(path.join(repo, 'dirty.txt'));
      }
    });

    it('counts stashes', async function () {
      const before = await gitIde.summary(repo);
      // A modification to a TRACKED file: `git stash` without -u ignores
      // untracked files, so a brand-new file would stash nothing and the pop
      // below would have no entry to restore.
      fs.writeFileSync(path.join(repo, 'a.txt'), 'stashed\n');
      git(repo, 'stash', '-q');
      try {
        const s = await gitIde.summary(repo);
        assert.strictEqual(s.stashes, before.stashes + 1);
      } finally {
        git(repo, 'stash', 'pop', '-q');
      }
    });

    it('names the half-finished operation that owns the repo', async function () {
      const mergeHead = path.join(repo, '.git', 'MERGE_HEAD');
      fs.writeFileSync(mergeHead, firstSha + '\n');
      try {
        const s = await gitIde.summary(repo);
        assert.strictEqual(s.inProgress, 'merge');
      } finally {
        fs.rmSync(mergeHead);
      }
    });

    it('reports a detached HEAD without throwing', async function () {
      const other = makeRepo(path.join(root, 'detached'));
      git(other, 'checkout', '-q', '--detach');
      const s = await gitIde.summary(other);
      assert.strictEqual(s.detached, true);
      assert.match(s.branch, /^[0-9a-f]{7,40}$/);
    });
  });

  describe('refs', function () {
    it('groups local/remote/tags and marks the current branch', async function () {
      const r = await gitIde.refs(repo);
      const names = r.local.map((b) => b.name);
      assert.ok(names.includes(defaultBranch));
      assert.ok(names.includes('side'));
      const cur = r.local.find((b) => b.name === defaultBranch);
      assert.strictEqual(cur.current, true);
      assert.strictEqual(cur.upstream, `origin/${defaultBranch}`);
      assert.strictEqual(cur.ahead, 2);
      assert.strictEqual(r.remote.map((b) => b.name).includes(`origin/${defaultBranch}`), true);
      assert.ok(r.tags.includes('v1'));
    });

    it('says invalid for a directory that is not a repository', async function () {
      const plain = path.join(root, 'plain');
      fs.mkdirSync(plain);
      const r = await gitIde.refs(plain);
      assert.ok(r.error);
    });
  });

  describe('log', function () {
    it('pages forward with offset and reports hasMore', async function () {
      const page1 = await gitIde.log(repo, { limit: 2 });
      assert.strictEqual(page1.commits.length, 2);
      assert.strictEqual(page1.commits[0].subject, 'third commit');
      assert.strictEqual(page1.hasMore, true);
      assert.strictEqual(page1.nextOffset, 2);
      const page2 = await gitIde.log(repo, { offset: 2 });
      assert.strictEqual(page2.commits[0].subject, 'initial');
      assert.strictEqual(page2.hasMore, false);
      assert.ok(!page1.commits.some((c) => c.subject === 'side branch work'), 'scope=current excludes the side branch');
    });

    it('scope=all includes commits only reachable from other refs', async function () {
      const all = await gitIde.log(repo, { scope: 'all' });
      assert.ok(all.commits.some((c) => c.subject === 'side branch work'));
    });

    it('accepts a named ref as the scope', async function () {
      const side = await gitIde.log(repo, { scope: 'side' });
      assert.ok(side.commits.length >= 1);
      assert.strictEqual(side.commits[0].subject, 'side branch work');
    });

    it('rejects a scope that could be read as an option', async function () {
      const r = await gitIde.log(repo, { scope: '--upload-pack' });
      assert.strictEqual(r.error, 'invalid ref');
    });

    it('filters by message text and by author', async function () {
      const byText = await gitIde.log(repo, { text: 'beta' });
      assert.strictEqual(byText.commits.length, 1);
      assert.strictEqual(byText.commits[0].subject, 'second: beta feature');
      const byAuthor = await gitIde.log(repo, { author: 'Nobody' });
      assert.strictEqual(byAuthor.commits.length, 0);
    });

    it('filters by file path', async function () {
      const byFile = await gitIde.log(repo, { file: 'c.txt' });
      assert.strictEqual(byFile.commits.length, 1);
      assert.strictEqual(byFile.commits[0].subject, 'third commit');
    });

    it('rejects a file filter that escapes the repo', async function () {
      for (const bad of ['../outside.txt', '/etc/passwd', '.']) {
        const r = await gitIde.log(repo, { file: bad });
        assert.strictEqual(r.error, 'invalid file filter', bad);
      }
    });

    it('carries parents and ref decorations for the graph', async function () {
      const log = await gitIde.log(repo, { limit: 3 });
      const initial = log.commits.find((c) => c.subject === 'initial');
      assert.deepStrictEqual(initial.parents, []);
      const third = log.commits.find((c) => c.subject === 'third commit');
      assert.strictEqual(third.parents.length, 1);
      const tagged = log.commits.find((c) => c.subject === 'second: beta feature');
      assert.ok(tagged.refs.some((r) => r.includes('tag: v1')), `refs carry the tag: ${JSON.stringify(tagged.refs)}`);
    });
  });

  describe('commitDetail', function () {
    it('returns full message, author and per-file counts', async function () {
      const sha = gitText(repo, 'rev-parse', 'HEAD');
      const d = await gitIde.commitDetail(repo, sha);
      assert.strictEqual(d.commit.sha, sha);
      assert.strictEqual(d.commit.author, 'Test');
      assert.match(d.commit.message, /third commit/);
      const file = d.files.find((f) => f.path === 'c.txt');
      assert.strictEqual(file.status, 'A');
      assert.strictEqual(file.add, '1');
      assert.strictEqual(file.del, '0');
    });

    it('shows a rename with its old path', async function () {
      git(repo, 'mv', 'a.txt', 'renamed.txt');
      git(repo, 'commit', '-qm', 'rename a');
      try {
        const sha = gitText(repo, 'rev-parse', 'HEAD');
        const d = await gitIde.commitDetail(repo, sha);
        const f = d.files[0];
        assert.strictEqual(f.status, 'R');
        assert.strictEqual(f.renameFrom, 'a.txt');
        assert.strictEqual(f.path, 'renamed.txt');
      } finally {
        git(repo, 'reset', '-q', '--hard', 'HEAD~1');
      }
    });

    it('rejects a sha-looking option injection', async function () {
      const r = await gitIde.commitDetail(repo, '--amend');
      assert.strictEqual(r.error, 'invalid sha');
    });
  });

  describe('diff', function () {
    it('shows the working tree, the index, and any commit', async function () {
      fs.writeFileSync(path.join(repo, 'a.txt'), 'one\nchanged\n');
      try {
        const wt = await gitIde.diff(repo, 'worktree', 'a.txt');
        assert.match(wt.diff, /\+changed/);
        assert.strictEqual(wt.truncated, false);

        git(repo, 'add', 'a.txt');
        const st = await gitIde.diff(repo, 'staged', 'a.txt');
        assert.match(st.diff, /^\+\+\+ /m);

        const sha = gitText(repo, 'rev-parse', 'HEAD');
        const cm = await gitIde.diff(repo, sha, 'c.txt');
        assert.match(cm.diff, /\+three/);
      } finally {
        git(repo, 'reset', '-q', '--hard', 'HEAD');
      }
    });

    it('shows a root commit whole (no parent to diff against)', async function () {
      const rootRepo = makeRepo(path.join(root, 'rootonly'));
      const sha = gitText(rootRepo, 'rev-parse', 'HEAD');
      const d = await gitIde.diff(rootRepo, sha, 'a.txt');
      assert.match(d.diff, /\+one/);
    });

    it('rejects paths that are not one repo-relative file', async function () {
      assert.strictEqual((await gitIde.diff(repo, 'worktree', '../x')).error, 'invalid file');
      assert.strictEqual((await gitIde.diff(repo, 'worktree', '/etc/passwd')).error, 'invalid file');
      assert.strictEqual((await gitIde.diff(repo, 'HEAD~1;rm', 'a.txt')).error, 'invalid commit');
    });
  });
});

describe('server route: git ide', function () {
  this.timeout(20000);

  const { ClaudeCodeWebServer } = require('../src/server');

  function mockRes() {
    return {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(obj) { this.body = obj; return this; }
    };
  }

  let server;
  let root;
  let repo;

  before(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-gitideroute-'));
    repo = makeRepo(path.join(root, 'one'));
    commitFile(repo, 'second.txt', 'x\n', 'second'); // paging needs two commits
    fs.mkdirSync(path.join(root, 'plain'));
    server = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
  });

  after(function () {
    if (server && typeof server.dispose === 'function') server.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('summary answers 200 with the branch', async function () {
    const res = mockRes();
    await server.gitIdeSummary({ query: { path: repo } }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.branch);
    assert.strictEqual(res.body.inProgress, null);
  });

  it('log answers 200 and pages', async function () {
    const res = mockRes();
    await server.gitIdeLog({ query: { path: repo, limit: '1' } }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.commits.length, 1);
    assert.strictEqual(res.body.hasMore, true);
    assert.strictEqual(res.body.nextOffset, 1);
  });

  it('a non-repository path is refused before git runs', async function () {
    const res = mockRes();
    await server.gitIdeSummary({ query: { path: path.join(root, 'plain') } }, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.reason, 'not-a-repo');
  });

  it('a repeated query value is a 400, not a crash', async function () {
    const res = mockRes();
    await server.gitIdeSummary({ query: { path: [repo, repo] } }, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'path must be a single value');
  });

  it('a bad scope or file filter comes back as a plain 400', async function () {
    const badScope = mockRes();
    await server.gitIdeLog({ query: { path: repo, scope: '--exec' } }, badScope);
    assert.strictEqual(badScope.statusCode, 400);
    assert.strictEqual(badScope.body.error, 'invalid ref');

    const badFile = mockRes();
    await server.gitIdeDiff({ query: { path: repo, commit: 'worktree', file: '../x' } }, badFile);
    assert.strictEqual(badFile.statusCode, 400);
    assert.strictEqual(badFile.body.error, 'invalid file');
  });

  it('diff serves a real working-tree change', async function () {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'changed\n');
    try {
      const res = mockRes();
      await server.gitIdeDiff({ query: { path: repo, commit: 'worktree', file: 'a.txt' } }, res);
      assert.strictEqual(res.statusCode, 200);
      assert.match(res.body.diff, /\+changed/);
    } finally {
      git(repo, 'reset', '-q', '--hard', 'HEAD');
    }
  });
});

describe('git-ide writes (phase C)', function () {
  this.timeout(20000);

  let root;
  let repo;

  before(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-gitidew-'));
    repo = makeRepo(path.join(root, 'w'));
  });

  after(function () {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('statusDetail groups conflicts/staged/changed/untracked', async function () {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'modified\n');   // tracked → changed
    fs.writeFileSync(path.join(repo, 'new.txt'), 'x\n');        // staged
    fs.writeFileSync(path.join(repo, 'loose.txt'), 'x\n');      // untracked
    git(repo, 'add', 'new.txt');
    try {
      const s = await gitIde.statusDetail(repo);
      assert.ok(s.changed.some((f) => f.path === 'a.txt'));
      assert.ok(s.staged.some((f) => f.path === 'new.txt'));
      assert.ok(s.untracked.includes('loose.txt'));
    } finally {
      git(repo, 'reset', '-q');
      git(repo, 'checkout', '-q', '--', 'a.txt');
      git(repo, 'clean', '-qfd');
    }
  });

  it('stages, commits, and reports the new head', async function () {
    fs.writeFileSync(path.join(repo, 'c1.txt'), 'v\n');
    const st = await gitIde.stageFiles(repo, ['c1.txt']);
    assert.deepStrictEqual(st, { ok: true });
    const cm = await gitIde.commit(repo, 'phase c commit');
    assert.strictEqual(cm.ok, true);
    assert.match(cm.head, /^[0-9a-f]{7,}$/);
    assert.strictEqual(gitText(repo, 'log', '-1', '--format=%s'), 'phase c commit');
  });

  it('unstage removes from the index without touching the file', async function () {
    fs.writeFileSync(path.join(repo, 'u.txt'), 'keep\n');
    git(repo, 'add', 'u.txt');
    const r = await gitIde.unstageFiles(repo, ['u.txt']);
    assert.deepStrictEqual(r, { ok: true });
    assert.strictEqual(gitText(repo, 'status', '--porcelain', '--', 'u.txt'), '?? u.txt');
    assert.ok(fs.existsSync(path.join(repo, 'u.txt')), 'the file itself survives');
    git(repo, 'clean', '-qf');
  });

  it('unstage works before the first commit too (no HEAD yet)', async function () {
    const fresh = path.join(root, 'fresh');
    fs.mkdirSync(fresh);
    execFileSync('git', ['init', '-q', fresh], { stdio: 'pipe' });
    git(fresh, 'config', 'user.email', 't@e.c');
    git(fresh, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(fresh, 'a.txt'), 'x\n');
    git(fresh, 'add', 'a.txt');
    const r = await gitIde.unstageFiles(fresh, ['a.txt']);
    assert.deepStrictEqual(r, { ok: true });
    assert.strictEqual(gitText(fresh, 'status', '--porcelain'), '?? a.txt');
  });

  it('discard restores tracked modifications and removes untracked files', async function () {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'smashed\n');
    fs.writeFileSync(path.join(repo, 'junk.txt'), 'delete me\n');
    const r = await gitIde.discardFiles(repo, ['a.txt', 'junk.txt']);
    assert.deepStrictEqual(r, { ok: true });
    assert.strictEqual(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'one\n');
    assert.ok(!fs.existsSync(path.join(repo, 'junk.txt')), 'untracked file removed');
  });

  it('refuses every write while a merge is in progress', async function () {
    // Manufacture a merge-in-progress state without running a real merge:
    // MERGE_HEAD's presence is exactly what git itself checks.
    fs.writeFileSync(path.join(repo, '.git', 'MERGE_HEAD'), '0'.repeat(40) + '\n');
    try {
      const r = await gitIde.stageFiles(repo, ['a.txt']);
      assert.match(r.error, /merge is in progress/);
      const c = await gitIde.commit(repo, 'should fail');
      assert.match(c.error, /merge is in progress/);
    } finally {
      fs.rmSync(path.join(repo, '.git', 'MERGE_HEAD'));
    }
  });

  it('rejects an invalid file list and a bad message', async function () {
    assert.strictEqual((await gitIde.stageFiles(repo, ['../escape'])).error, 'invalid file list');
    assert.strictEqual((await gitIde.stageFiles(repo, [])).error, 'invalid file list');
    assert.strictEqual((await gitIde.commit(repo, '')).error, 'invalid commit message');
    assert.strictEqual((await gitIde.commit(repo, 'x\0y')).error, 'invalid commit message');
  });
});

describe('server route: git ide writes', function () {
  this.timeout(20000);

  const { ClaudeCodeWebServer } = require('../src/server');

  function mockRes() {
    return {
      statusCode: 200, body: null,
      status(code) { this.statusCode = code; return this; },
      json(obj) { this.body = obj; return this; }
    };
  }

  let server;
  let root;
  let repo;

  before(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-gitidewr-'));
    repo = makeRepo(path.join(root, 'one'));
    server = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
  });

  after(function () {
    if (server && typeof server.dispose === 'function') server.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('stages and commits through the queue', async function () {
    fs.writeFileSync(path.join(repo, 'r.txt'), 'route\n');
    const st = mockRes();
    await server.gitIdeWrite({ body: { path: repo, files: ['r.txt'] } }, st, 'stage');
    assert.strictEqual(st.statusCode, 200);

    const cm = mockRes();
    await server.gitIdeWrite({ body: { path: repo, message: 'via route' } }, cm, 'commit');
    assert.strictEqual(cm.statusCode, 200);
    assert.strictEqual(cm.body.ok, true);
    assert.strictEqual(gitText(repo, 'log', '-1', '--format=%s'), 'via route');
  });

  it('a non-repository path is a 400 before git runs', async function () {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    const res = mockRes();
    await server.gitIdeWrite({ body: { path: plain, files: ['x'] } }, res, 'stage');
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.reason, 'not-a-repo');
  });

  it('an unknown operation is a 400', async function () {
    const res = mockRes();
    await server.gitIdeWrite({ body: { path: repo } }, res, 'explode');
    assert.strictEqual(res.statusCode, 400);
  });
});

describe('git-ide history operations (phase D)', function () {
  this.timeout(30000);

  let root;
  let repo;
  let undoStore;

  before(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-gitided-'));
    repo = makeRepo(path.join(root, 'd'));
    undoStore = gitIde.makeUndoStore(path.join(root, 'ledger'));
    // A side branch with one commit, and a tag on the initial commit.
    commitFile(repo, 'side.txt', 'side\n', 'side work');
    git(repo, 'checkout', '-qb', 'topic', 'master');
    commitFile(repo, 'topic.txt', 'topic\n', 'topic work');
    git(repo, 'tag', 'v1', 'master');
  });

  after(function () {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('creates a branch (with or without checkout) and a tag', async function () {
    assert.deepStrictEqual(await gitIde.createBranch(repo, 'from-topic', { from: 'topic' }), { ok: true });
    assert.deepStrictEqual(await gitIde.createTag(repo, 'topic-tag', 'topic'), { ok: true });
    const branches = gitText(repo, 'branch', '--list', 'from-topic', 'topic');
    assert.ok(branches.includes('topic'));
  });

  it('rejects a branch name git would refuse', async function () {
    const r = await gitIde.createBranch(repo, '-u/x', {});
    assert.strictEqual(r.error, 'invalid branch name');
  });

  it('checks out a branch and a sha (detached)', async function () {
    assert.deepStrictEqual(await gitIde.checkoutRef(repo, 'topic'), { ok: true });
    assert.strictEqual(gitText(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'topic');
    const sha = gitText(repo, 'rev-parse', 'master');
    assert.deepStrictEqual(await gitIde.checkoutRef(repo, sha), { ok: true });
    assert.match(gitText(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), /^HEAD$/);
    git(repo, 'checkout', '-q', 'master');
  });

  it('deletes a branch and the ledger brings it back (one-shot)', async function () {
    const r = await gitIde.deleteBranch(repo, 'from-topic', undoStore);
    assert.strictEqual(r.ok, true);
    assert.ok(r.undoId, 'a delete without a recorded sha cannot be undone');
    assert.strictEqual(gitText(repo, 'branch', '--list', 'from-topic'), '');

    const again = await gitIde.undo(repo, r.undoId, undoStore);
    assert.strictEqual(again.ok, true);
    assert.ok(gitText(repo, 'branch', '--list', 'from-topic').includes('from-topic'));

    // One-shot: the second spend fails.
    const spent = await gitIde.undo(repo, r.undoId, undoStore);
    assert.strictEqual(spent.error, 'undo expired or unknown');
  });

  it('refuses to delete the current branch', async function () {
    const r = await gitIde.deleteBranch(repo, 'master', undoStore);
    assert.match(r.error, /current branch/);
  });

  it('cherry-picks a commit from another branch', async function () {
    const sha = gitText(repo, 'rev-parse', 'topic');
    const r = await gitIde.cherryPick(repo, sha);
    assert.strictEqual(r.ok, true);
    assert.match(gitText(repo, 'log', '-1', '--format=%s'), /topic work/);
    git(repo, 'reset', '-q', '--hard', 'master');
  });

  it('reverts a commit with a generated message', async function () {
    const sha = gitText(repo, 'rev-parse', 'HEAD');
    const r = await gitIde.revertCommit(repo, sha);
    assert.strictEqual(r.ok, true);
    assert.match(gitText(repo, 'log', '-1', '--format=%s'), /^Revert /);
    git(repo, 'reset', '-q', '--hard', 'master');
  });

  it('reset --hard records an undo point that moves the branch back', async function () {
    const before = gitText(repo, 'rev-parse', 'HEAD');
    commitFile(repo, 'gone.txt', 'x\n', 'to be reset away');
    const after = gitText(repo, 'rev-parse', 'HEAD');
    const r = await gitIde.resetTo(repo, before, 'discard', undoStore);
    assert.strictEqual(r.ok, true);
    assert.ok(r.undoId);
    assert.strictEqual(gitText(repo, 'rev-parse', 'HEAD'), before);

    // Put the branch forward again, then undo puts it back — but only while
    // it still points where the reset left it.
    const back = await gitIde.undo(repo, r.undoId, undoStore);
    assert.strictEqual(back.ok, true);
    assert.strictEqual(gitText(repo, 'rev-parse', 'HEAD'), after);
    git(repo, 'reset', '-q', '--hard', 'master');
  });

  it('merge supports the four modes; --no-commit leaves a merge to conclude', async function () {
    git(repo, 'checkout', '-q', 'master');
    const r = await gitIde.mergeBranch(repo, 'topic', 'no-ff-no-commit');
    assert.strictEqual(r.ok, true);
    // The merge is now in progress: writes refuse, abort exits it.
    const blocked = await gitIde.stageFiles(repo, ['side.txt']);
    assert.match(blocked.error, /merge is in progress/);
    const out = await gitIde.abortOp(repo);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.aborted, 'merge');
    assert.strictEqual(gitText(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'master');
  });

  it('rebases the current branch onto another ref', async function () {
    git(repo, 'checkout', '-q', 'topic');
    const r = await gitIde.rebaseOnto(repo, 'master');
    assert.strictEqual(r.ok, true);
    git(repo, 'checkout', '-q', 'master');
  });

  it('the undo ledger expires entries and caps its length', function () {
    const store = gitIde.makeUndoStore(path.join(root, 'ledger2'));
    for (let i = 0; i < 60; i++) store.record({ kind: 'branch-delete', repo: 'x', ref: `b${i}`, sha: '0'.repeat(40) });
    assert.strictEqual(store.list().length, 50);
  });
});

describe('server route: git ide push gate (phase E)', function () {
  this.timeout(30000);

  const { ClaudeCodeWebServer } = require('../src/server');

  function mockRes() {
    return {
      statusCode: 200, body: null,
      status(code) { this.statusCode = code; return this; },
      json(obj) { this.body = obj; return this; }
    };
  }
  function mockReq(body) { return { body: body || {}, user: undefined }; }

  let server;
  let root;
  let repo;
  let bare;

  before(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-gitidepush-'));
    repo = makeRepo(path.join(root, 'one'));
    // A local bare remote: push over the file transport, no network.
    bare = path.join(root, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', bare], { stdio: 'pipe' });
    git(repo, 'remote', 'add', 'origin', bare);
    git(repo, 'push', '-q', '-u', 'origin', 'HEAD');
    server = new ClaudeCodeWebServer({ noAuth: true, folderMode: false });
  });

  after(function () {
    if (server && typeof server.dispose === 'function') server.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('the gate reads off by default and blocks the push', async function () {
    const state = mockRes();
    server.gitIdePushState(mockReq(), state);
    assert.strictEqual(state.body.enabled, false);
    assert.strictEqual(state.body.canSet, true);

    const push = mockRes();
    await server.gitIdePush(mockReq({ path: repo }), push);
    assert.strictEqual(push.statusCode, 403);
    assert.match(push.body.error, /disabled/);
  });

  it('toggling persists and the push lands on the bare remote', async function () {
    const on = mockRes();
    await server.gitIdePushToggle(mockReq({ enabled: true }), on);
    assert.strictEqual(on.statusCode, 200);
    assert.strictEqual(server.gitIdePushEnabled, true);

    const before = gitText(bare, 'rev-parse', '--short', 'HEAD');
    commitFile(repo, 'pushed.txt', 'x\n', 'push me');
    const push = mockRes();
    await server.gitIdePush(mockReq({ path: repo }), push);
    assert.strictEqual(push.statusCode, 200, JSON.stringify(push.body));
    const after = gitText(bare, 'rev-parse', '--short', 'HEAD');
    assert.notStrictEqual(before, after, 'the bare remote moved');

    const off = mockRes();
    await server.gitIdePushToggle(mockReq({ enabled: false }), off);
    assert.strictEqual(server.gitIdePushEnabled, false);
  });
});
