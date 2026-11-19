// Single-repository deep reads for the Git IDE panel: refs, paged history, one
// commit's detail, one file's diff. The sibling module git-branches.js is
// breadth — every repo under a folder, driven by cheap .git file reads. This
// one is depth on a repository the user explicitly opened, so every call shells
// out through git-branches' runGit: no shell, no credential prompt, timeouts,
// scrubbed output. Writes (stage/commit/history ops) arrive with phase C/D and
// will go through server.queueGitJob like every other git fork.

const fs = require('fs');
const path = require('path');
const { runGit, readHead, redactCredentials } = require('./git-branches');

// Local history walks pay one fork per page; 120 is the lane graph's natural
// screenful (dsh-ide-git ships the same number) and keeps a 10k-commit repo to
// a sub-second `git log --skip` walk.
const LOG_PAGE = 120;
const LOG_PAGE_MAX = 500;
// A `--skip` deep enough to be O(seconds) means the user is digging further
// back than any panel should scroll; refuse and let the UI offer a filter
// (author/date/path) instead of a slower pager.
const LOG_SKIP_MAX = 10000;
// One file's diff, not the whole patch series: past this the JSON payload stops
// being worth it and the panel offers the terminal instead.
const DIFF_MAX_BYTES = 512 * 1024;
// All of these are local plumbing reads; none has a network round trip in it,
// so the branch-op ceiling (15s) is generous. A repo slow enough to hit it is
// broken and deserves the timeout, not a longer wait.
const IDE_TIMEOUT_MS = 20000;

// ── input gates ────────────────────────────────────────────────────────────
// Every parameter below ends up on a git command line, so each is checked as a
// shape, never trusted: a sha is hex, a ref is one token that can never be
// read as an option, a file filter is one repo-relative path with no `..`.

const SHA_RE = /^[0-9a-f]{4,40}$/i;
function isSha(v) {
  return typeof v === 'string' && SHA_RE.test(v);
}

// A ref the log can start from: branch, tag or remote name. One token, cannot
// start with `-` (option injection), no `..` (range semantics), no `.lock`
// (which git refuses anyway and would only produce a confusing error).
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/@+-]{0,199}$/;
function isRefToken(v) {
  return typeof v === 'string' && REF_RE.test(v) && !v.includes('..') && !v.endsWith('.lock');
}

function isRelPath(v) {
  if (typeof v !== 'string' || !v || v.length > 512) return false;
  // Git addresses paths with '/', so a backslash is never a separator here —
  // reject it rather than let a Windows-shaped `..\..` slip past the split.
  if (v.includes('\\') || path.isAbsolute(v) || v === '.') return false;
  return v.split('/').every((p) => p && p !== '..');
}

function clampInt(v, lo, hi, dflt) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

// ── summary: the panel header pill ─────────────────────────────────────────

// Which half-finished git operation owns this repo, if any. Every GUI write
// command is refused while one of these is present (phase D disables the
// buttons on it), because git's own answer to "commit during a rebase" is a
// wrecked rebase. Plain fs checks on the git dir, the same way git itself
// decides what to print in `git status`.
function inProgress(gitDir) {
  const has = (p) => fs.existsSync(path.join(gitDir, p));
  if (has('rebase-merge') || has('rebase-apply')) return 'rebase';
  if (has('MERGE_HEAD')) return 'merge';
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (has('REVERT_HEAD')) return 'revert';
  if (has('BISECT_LOG')) return 'bisect';
  return null;
}

async function summary(repoPath) {
  // Three forks: status (branch + counts), stash depth, and HEAD/git-dir in a
  // single rev-parse (both print, one per line, in argument order).
  const st = await runGit(repoPath, ['status', '--porcelain=v1', '--branch'], IDE_TIMEOUT_MS);
  if (!st.ok) return { error: redactCredentials(st.out || 'git status failed').split('\n')[0] };

  const lines = st.stdout.split('\n').filter(Boolean);
  const header = lines[0] && lines[0].startsWith('## ') ? lines.shift().slice(3) : '';
  const dirty = lines.length;
  const ahead = (header.match(/ahead (\d+)/) || [0, 0])[1];
  const behind = (header.match(/behind (\d+)/) || [0, 0])[1];
  const detached = /^HEAD \(no branch\)/.test(header);

  const stashList = await runGit(repoPath, ['stash', 'list', '--format=%H'], IDE_TIMEOUT_MS);
  const stashes = stashList.ok ? stashList.stdout.split('\n').filter(Boolean).length : 0;

  const rp = await runGit(repoPath, ['rev-parse', 'HEAD', '--git-dir'], IDE_TIMEOUT_MS);
  const [headSha, gitDirRaw] = rp.ok ? rp.stdout.split('\n') : [];
  const gitDir = gitDirRaw ? path.resolve(repoPath, gitDirRaw.trim()) : null;

  const head = readHead(repoPath);
  return {
    branch: detached ? (headSha ? headSha.slice(0, 7) : head && head.branch) : (head && head.branch) || header.split('...')[0],
    detached,
    ahead: Number(ahead),
    behind: Number(behind),
    dirty,
    stashes,
    head: headSha ? headSha.trim() : null,
    inProgress: gitDir ? inProgress(gitDir) : null
  };
}

// ── refs: the branch tree ──────────────────────────────────────────────────

// ahead/behind per branch comes from for-each-ref's %(upstream:track), which
// git computes from the tracking config — no per-branch rev-list round trips.
async function refs(repoPath) {
  const r = await runGit(repoPath,
    ['for-each-ref', '--format=%(refname)%00%(upstream:short)%00%(upstream:track,nobracket)',
      'refs/heads', 'refs/remotes', 'refs/tags'], IDE_TIMEOUT_MS);
  if (!r.ok) return { error: redactCredentials(r.out || 'git for-each-ref failed').split('\n')[0] };

  const head = readHead(repoPath);
  const current = head && !head.detached ? head.branch : null;
  const local = [];
  const remote = [];
  const tags = [];
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const [refname, upstream, track] = line.split('\0');
    if (refname.startsWith('refs/heads/')) {
      const name = refname.slice('refs/heads/'.length);
      const ahead = (track.match(/ahead (\d+)/) || [0, 0])[1];
      const behind = (track.match(/behind (\d+)/) || [0, 0])[1];
      local.push({ name, current: name === current, upstream, ahead: Number(ahead), behind: Number(behind) });
    } else if (refname.startsWith('refs/remotes/') && !refname.endsWith('/HEAD')) {
      remote.push({ name: refname.slice('refs/remotes/'.length) });
    } else if (refname.startsWith('refs/tags/')) {
      tags.push(refname.slice('refs/tags/'.length));
    }
  }
  return { current, detached: !!(head && head.detached), local, remote, tags };
}

// ── log: the commit history, one page at a time ────────────────────────────

// Field order is the panel's column order (date → author → graph → refs →
// subject) plus the parents the lane graph needs. %D gives the refs as git
// decorates them ("HEAD -> main, origin/main, tag: v1").
const LOG_FMT = '%H%x1f%h%x1f%P%x1f%an%x1f%aI%x1f%s%x1f%D%x1e';

async function log(repoPath, opts) {
  const o = opts || {};
  const limit = clampInt(o.limit, 1, LOG_PAGE_MAX, LOG_PAGE);
  const skip = clampInt(o.offset, 0, LOG_SKIP_MAX, 0);
  const args = ['log', `--format=${LOG_FMT}`, `--max-count=${limit + 1}`, `--skip=${skip}`];

  // Scope: the current branch by default, every ref for "all", or one named
  // ref. A ref is a validated token — it can never be read as an option — and
  // git's own failure on a name that doesn't exist comes back as a 4xx below.
  if (o.scope === 'all') {
    args.push('--branches', '--remotes');
  } else if (o.scope && o.scope !== 'current') {
    if (!isRefToken(o.scope)) return { error: 'invalid ref' };
    args.push(o.scope);
  }

  if (o.text) {
    if (typeof o.text !== 'string' || o.text.length > 200) return { error: 'invalid text filter' };
    args.push(`--grep=${o.text}`, '-i', '--extended-regexp');
  }
  if (o.author) {
    if (typeof o.author !== 'string' || o.author.length > 200) return { error: 'invalid author filter' };
    args.push(`--author=${o.author}`, '--extended-regexp');
  }
  if (o.file) {
    if (!isRelPath(o.file)) return { error: 'invalid file filter' };
    args.push('--', o.file);
  }

  const r = await runGit(repoPath, args, IDE_TIMEOUT_MS);
  if (!r.ok) {
    // git's wording for a scope ref that does not exist — a filter typo, not a
    // server fault, so the panel shows it instead of an error card.
    return { error: redactCredentials(r.out || 'git log failed').split('\n')[0] };
  }

  const commits = [];
  for (const row of r.stdout.split('\x1e')) {
    const rec = row.split('\x1f');
    if (rec.length < 7) continue;
    commits.push({
      // Each record after the first begins with the newline git prints between
      // entries; the sha is hex, so trimming touches nothing else.
      sha: rec[0].trim(), short: rec[1],
      parents: rec[2] ? rec[2].split(' ') : [],
      author: rec[3], date: rec[4], subject: rec[5],
      refs: rec[6] ? rec[6].split(', ').map((s) => s.trim()).filter(Boolean) : []
    });
  }
  // One extra row is fetched past the page (max-count = limit + 1) just to see
  // whether more history exists; the extra never reaches the caller.
  return { commits: commits.slice(0, limit), hasMore: commits.length > limit, nextOffset: skip + limit };
}

// ── commit detail ──────────────────────────────────────────────────────────

// Metadata and files come from three forks of `git show`: -s for the full
// message (the list only carried the subject), then --numstat (adds/dels per
// file) and --name-status (the A/M/D/R letter) zipped by line order, which is
// stable across both. --first-parent makes a merge show its diff against the
// first parent — the only reading that is never empty.
async function commitDetail(repoPath, sha) {
  if (!isSha(sha)) return { error: 'invalid sha' };
  const meta = await runGit(repoPath, ['show', '-s', '--format=%H%x1f%an%x1f%aI%x1f%B', sha], IDE_TIMEOUT_MS);
  if (!meta.ok) return { error: redactCredentials(meta.out || 'no such commit').split('\n')[0] };
  const [full, author, date, ...rest] = meta.stdout.split('\x1f');
  const message = rest.join('\x1f').replace(/\n$/, '');

  const num = await runGit(repoPath, ['show', '--first-parent', '--numstat', '--format=', sha], IDE_TIMEOUT_MS);
  const status = await runGit(repoPath, ['show', '--first-parent', '--name-status', '--format=', sha], IDE_TIMEOUT_MS);
  const numLines = num.ok ? num.stdout.split('\n').filter(Boolean) : [];
  const statusLines = status.ok ? status.stdout.split('\n').filter(Boolean) : [];

  const files = numLines.map((line, i) => {
    const cols = line.split('\t');
    const stCols = (statusLines[i] || '').split('\t');
    // numstat prints "-" for a binary file's counts; keep that shape.
    // name-status prints R100\told\tnew for a rename — the new path is the
    // one a diff opens, and the old one rides along as renameFrom.
    const renamed = stCols[0] && stCols[0][0] === 'R' && stCols.length >= 3;
    return {
      path: renamed ? stCols[2] : cols.slice(2).join('\t'),
      renameFrom: renamed ? stCols[1] : null,
      status: stCols[0] ? stCols[0][0] : 'M',
      add: cols[0], del: cols[1]
    };
  });
  return { commit: { sha: full.trim(), author, date, message }, files };
}

// ── diff: one file, working tree or any commit ─────────────────────────────

async function diff(repoPath, target, file) {
  if (!isRelPath(file)) return { error: 'invalid file' };
  const args = ['diff'];
  if (target === 'worktree') {
    args.push('--', file);
  } else if (target === 'staged') {
    args.push('--cached', '--', file);
  } else {
    if (!isSha(target)) return { error: 'invalid commit' };
    // `git show` (not diff sha^ sha) so a root commit's creation patch — the
    // one with no parent to diff against — comes out whole.
    args.length = 0;
    args.push('show', '--format=', target, '--', file);
  }
  const r = await runGit(repoPath, args, IDE_TIMEOUT_MS);
  if (!r.ok) return { error: redactCredentials(r.out || 'git diff failed').split('\n')[0] };
  const bytes = Buffer.byteLength(r.stdout, 'utf8');
  return {
    diff: bytes > DIFF_MAX_BYTES ? r.stdout.slice(0, DIFF_MAX_BYTES) : r.stdout,
    truncated: bytes > DIFF_MAX_BYTES
  };
}

module.exports = { summary, refs, log, commitDetail, diff, isSha, isRefToken, isRelPath,
  LOG_PAGE, LOG_PAGE_MAX, LOG_SKIP_MAX, DIFF_MAX_BYTES,
  statusDetail, stageFiles, unstageFiles, discardFiles, commit };

// ── writes (phase C): stage / unstage / discard / commit ───────────────────
//
// Every write is local (no push in this phase), goes through the server's
// git job queue (one fork at a time), and is REFUSED while a merge/rebase/
// cherry-pick/revert/bisect owns the repo — git's answer to "commit during a
// rebase" is a wrecked rebase, so the panel never gets the chance to ask.

const WRITE_MAX_FILES = 50;

function validFileList(files) {
  if (!Array.isArray(files) || !files.length || files.length > WRITE_MAX_FILES) return null;
  const seen = new Set();
  for (const f of files) {
    if (!isRelPath(f) || seen.has(f)) return null;
    seen.add(f);
  }
  return [...seen];
}

// Group a porcelain line's XY into the change list's buckets.
function parseStatus(out) {
  const conflicts = [], staged = [], changed = [], untracked = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const x = line[0], y = line[1];
    const path = line.slice(3);
    if (y === '?' && x === '?') { untracked.push(path); continue; }
    // Renames print "old -> new"; the list shows the new name (what a diff
    // opens) with the old one attached.
    const arrow = path.indexOf(' -> ');
    const name = arrow >= 0 ? path.slice(arrow + 4) : path;
    const from = arrow >= 0 ? path.slice(0, arrow) : null;
    if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
      conflicts.push({ path: name });
    } else {
      if (x !== ' ' && x !== '?') staged.push({ path: name, renameFrom: from, status: x });
      if (y !== ' ') changed.push({ path: name, status: y });
    }
  }
  return { conflicts, staged, changed, untracked };
}

async function statusDetail(repoPath) {
  const r = await runGit(repoPath, ['status', '--porcelain=v1'], IDE_TIMEOUT_MS);
  if (!r.ok) return { error: redactCredentials(r.out || 'git status failed').split('\n')[0] };
  return parseStatus(r.stdout);
}

// Writes share one guard: refuse while a half-finished operation owns the
// repo, and validate the file list once, up front.
async function writeGuard(repoPath) {
  const s = await summary(repoPath);
  if (s.error) return { error: s.error };
  if (s.inProgress) return { error: `a ${s.inProgress} is in progress` };
  return null;
}

async function stageFiles(repoPath, files) {
  const list = validFileList(files);
  if (!list) return { error: 'invalid file list' };
  const guard = await writeGuard(repoPath);
  if (guard) return guard;
  const r = await runGit(repoPath, ['add', '--', ...list], IDE_TIMEOUT_MS);
  return r.ok ? { ok: true } : { error: redactCredentials(r.out || 'git add failed').split('\n')[0] };
}

async function unstageFiles(repoPath, files) {
  const list = validFileList(files);
  if (!list) return { error: 'invalid file list' };
  const guard = await writeGuard(repoPath);
  if (guard) return guard;
  // `git reset -- <paths>` unstages; before the first commit exists there is
  // no HEAD to reset from, and git rm --cached is the only way back.
  const r = await runGit(repoPath, ['reset', '-q', '--', ...list], IDE_TIMEOUT_MS);
  if (r.ok) return { ok: true };
  if (/ambiguous argument 'HEAD'|unknown revision/i.test(r.out)) {
    const r2 = await runGit(repoPath, ['rm', '-q', '--cached', '--', ...list], IDE_TIMEOUT_MS);
    if (r2.ok) return { ok: true };
    return { error: redactCredentials(r2.out || 'git rm failed').split('\n')[0] };
  }
  return { error: redactCredentials(r.out || 'git reset failed').split('\n')[0] };
}

// Discard works-tree changes, per file, by what the file actually is:
// tracked modifications are checked out from the index; untracked files are
// removed with clean scoped to exactly that path. Never a bare `checkout -- .`.
async function discardFiles(repoPath, files) {
  const list = validFileList(files);
  if (!list) return { error: 'invalid file list' };
  const guard = await writeGuard(repoPath);
  if (guard) return guard;
  const st = await runGit(repoPath, ['status', '--porcelain=v1', '--', ...list], IDE_TIMEOUT_MS);
  if (!st.ok) return { error: redactCredentials(st.out || 'git status failed').split('\n')[0] };
  const tracked = [], untracked = [];
  for (const line of st.stdout.split('\n').filter(Boolean)) {
    const path = line.slice(3).split(' -> ').pop();
    if (line.startsWith('??')) untracked.push(path);
    else tracked.push(path);
  }
  if (tracked.length) {
    const r = await runGit(repoPath, ['checkout', '-q', '--', ...tracked], IDE_TIMEOUT_MS);
    if (!r.ok) return { error: redactCredentials(r.out || 'git checkout failed').split('\n')[0] };
  }
  for (const f of untracked) {
    const r = await runGit(repoPath, ['clean', '-q', '-f', '--', f], IDE_TIMEOUT_MS);
    if (!r.ok) return { error: redactCredentials(r.out || 'git clean failed').split('\n')[0] };
  }
  return { ok: true };
}

async function commit(repoPath, message, amend) {
  if (typeof message !== 'string' || !message.trim() || message.length > 8000 || message.includes('\0')) {
    return { error: 'invalid commit message' };
  }
  const guard = await writeGuard(repoPath);
  if (guard) return guard;
  const args = ['commit', '-m', message];
  if (amend) args.push('--amend', '--no-edit');
  const r = await runGit(repoPath, args, IDE_TIMEOUT_MS);
  if (!r.ok) {
    // git's own wording for "nothing staged" is what the panel should show.
    return { error: redactCredentials(r.out || 'git commit failed').split('\n')[0] };
  }
  const head = await runGit(repoPath, ['rev-parse', '--short', 'HEAD'], IDE_TIMEOUT_MS);
  return { ok: true, head: head.ok ? head.stdout.trim() : null };
}
