// Reads the current branch of every git repository sitting one level under a
// directory — the shape of a "big directory" holding many sub-projects.
//
// The design turns on one measurement. A branch name lives in `.git/HEAD`, a
// one-line file, so a whole tree costs a readdir plus one small read each:
// 17ms for 11 repos. Anything about the *working tree* — dirty files, ahead /
// behind — needs a real `git` process per repo, and that same tree measured
// 1814ms. A hundred times more.
//
// So the two are split. The branch scan is cheap, synchronous, and always runs.
// The status scan is asynchronous, concurrency-bounded, and only runs when the
// caller explicitly asks for it. Nothing here polls: this server has already
// been brought to its knees once by a background scan on a timer.

const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
// Shared with src/skills.js, which reads a SKILL.md frontmatter the same way.
const { readPrefix } = require('./utils/read-prefix');

// Bounds the per-entry cost so a directory with thousands of children can't
// stall the shared single-threaded server.
const MAX_REPOS = 50;
// 2000 matches listDirectory's MAX_ITEMS, which already accepts one stat per
// entry at this size — measured at 40ms for 2001 entries here. The old 500 was
// low enough that an ordinary directory could push a real repository past it
// and lose it without saying so.
const MAX_ENTRIES = 2000;
// A HEAD file is one short line. Reading a fixed prefix means a bogus (or
// hostile) multi-gigabyte file at `.git/HEAD` costs the same as a real one.
const HEAD_BYTES = 512;
const STATUS_CONCURRENCY = 4;
const STATUS_TIMEOUT_MS = 10000;
const STATUS_MAX_BUFFER = 8 * 1024 * 1024;
// Pull gets far longer than a status check. Measured across 11 real repos, a
// fetch settles in ~1.6s — except one that had not finished after 120s with an
// identical remote, helper and credential file, and a 3.5 MB .git. Slow is not
// the same as broken, and a 15s ceiling would report it as broken.
const PULL_TIMEOUT_MS = 60000;

// Resolve a repo's git directory. Normally `.git` is a directory, but for a
// worktree or a submodule it is a FILE holding `gitdir: <path>` — miss that and
// every worktree silently reads as "not a repository".
function resolveGitDir(repoDir) {
  const dotGit = path.join(repoDir, '.git');
  let st;
  try {
    st = fs.statSync(dotGit);
  } catch (_) {
    return null;
  }
  if (st.isDirectory()) return dotGit;
  if (!st.isFile()) return null;

  const text = readPrefix(dotGit, 4096);
  const m = text && text.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!m) return null;
  // The recorded path may be relative to the repo directory, and may also be
  // absolute and point anywhere — that is git's own format, and following it is
  // the only way a worktree or submodule resolves. A crafted `.git` file could
  // therefore aim this at an arbitrary directory, and the caller would learn
  // whether <that>/HEAD parses as a ref or a sha. That matches the scope the
  // rest of this server already grants (isPathWithinBase allows any resolvable
  // path — a local, single-user, auth-protected tool), and it requires the
  // hostile file to already sit inside a directory the user is browsing.
  const target = path.resolve(repoDir, m[1]);
  try {
    return fs.statSync(target).isDirectory() ? target : null;
  } catch (_) {
    return null;
  }
}

// The current branch of one repository, or null if it isn't one.
// A detached HEAD holds a raw sha instead of a symbolic ref; report it as such
// rather than pretending there is no branch.
function readHead(repoDir) {
  const gitDir = resolveGitDir(repoDir);
  if (!gitDir) return null;

  const text = readPrefix(path.join(gitDir, 'HEAD'), HEAD_BYTES);
  if (!text) return null;

  const ref = text.match(/^ref:\s*refs\/heads\/(.+?)\s*$/m);
  if (ref) return { branch: ref[1], detached: false };

  const sha = text.trim().match(/^([0-9a-f]{7,64})$/i);
  if (sha) return { branch: sha[1].slice(0, 7), detached: true };

  return null;
}

// Every git repository directly under `dir`, plus `dir` itself when it is one
// (a single-repo project, where there are no sub-projects to list).
function scanBranches(dir) {
  const repos = [];

  const self = readHead(dir);
  if (self) repos.push({ name: '.', path: dir, ...self });

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return { path: dir, repos, truncated: 0, unexamined: 0, error: error.code || 'EACCES' };
  }

  let scanned = 0;
  let truncated = 0;
  let unexamined = 0;
  for (const entry of entries) {
    // `.git` itself, plus editor/tool dot-directories, are never sub-projects.
    if (entry.name.startsWith('.')) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

    // MAX_ENTRIES bounds the stat calls, and it used to silently eat real
    // repositories: 600 plain directories ahead of one repo meant the repo was
    // never examined and the caller was told "0 repos, 101 truncated" — a
    // number that counted plain directories, which were never candidates. A
    // panel whose whole job is "list every sub-project" must not lose one
    // quietly, so the two counts are now kept apart: `truncated` is repos that
    // were found and dropped, `unexamined` is directories never looked at.
    if (++scanned > MAX_ENTRIES) { unexamined++; continue; }

    const child = path.join(dir, entry.name);
    const head = readHead(child);
    if (!head) continue;
    if (repos.length >= MAX_REPOS) { truncated++; continue; }
    repos.push({ name: entry.name, path: child, ...head });
  }

  repos.sort((a, b) => (a.name === '.' ? -1 : b.name === '.' ? 1 : a.name.localeCompare(b.name)));
  return { path: dir, repos, truncated, unexamined };
}

// `git status --porcelain -b` answers both questions in ONE process: the `## `
// header carries ahead/behind, and every remaining line is a changed path. Two
// separate git calls would double the expensive part for no extra information.
function readStatus(repoPath) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', repoPath, 'status', '--porcelain', '-b'],
      { timeout: STATUS_TIMEOUT_MS, maxBuffer: STATUS_MAX_BUFFER, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(null);
        const lines = String(stdout).split('\n').filter(Boolean);
        const header = lines[0] && lines[0].startsWith('## ') ? lines.shift() : '';
        const ahead = header.match(/ahead (\d+)/);
        const behind = header.match(/behind (\d+)/);
        resolve({
          dirty: lines.length,
          ahead: ahead ? Number(ahead[1]) : 0,
          behind: behind ? Number(behind[1]) : 0
        });
      }
    );
  });
}

// Every descendant of a pid, deepest last.
//
// Linux reads /proc. macOS has no /proc, so it asks `ps` once for the whole
// pid→ppid table; Windows asks CIM for the same table plus each process's
// start time, because Windows recycles pids freely and a long-dead parent's
// pid may now be ours — a "child" older than its parent is someone else's.
// If none of that works this returns just the pid, and the caller degrades to
// killing the direct child.
function processTree(pid) {
  const childrenOf = fs.existsSync('/proc/self/task') ? procChildren : tableChildren(readProcessTable());
  const found = [pid];
  const queue = [pid];
  while (queue.length) {
    const kids = childrenOf(queue.shift());
    for (const kid of kids) {
      if (Number.isInteger(kid) && kid > 0 && !found.includes(kid)) {
        found.push(kid);
        queue.push(kid);
      }
    }
  }
  return found;
}

function procChildren(pid) {
  let kids = [];
  try {
    // One entry per thread; a process's children can be listed under any of
    // them, so read them all.
    for (const task of fs.readdirSync(`/proc/${pid}/task`)) {
      const raw = fs.readFileSync(`/proc/${pid}/task/${task}/children`, 'utf8');
      kids = kids.concat(raw.split(/\s+/).filter(Boolean).map(Number));
    }
  } catch (_) {
    // Process exited between listing and reading.
  }
  return kids;
}

// [{pid, ppid, started}] for every process, or [] when it cannot be read.
// `started` is only known on Windows, where it is needed.
function readProcessTable() {
  try {
    if (process.platform === 'win32') {
      const script = "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.Ticks }";
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
      return parseTable(out);
    }
    return parseTable(execFileSync('ps', ['-A', '-o', 'pid=,ppid='],
      { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch (_) {
    return [];
  }
}

function parseTable(out) {
  return out.split(/\r?\n/).map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, ppid]) => Number.isInteger(pid) && Number.isInteger(ppid))
    .map(([pid, ppid, started]) => ({ pid, ppid, started: Number.isFinite(started) ? started : null }));
}

function tableChildren(table) {
  const byPid = new Map(table.map((p) => [p.pid, p]));
  return (pid) => {
    const parent = byPid.get(pid);
    return table
      .filter((p) => p.ppid === pid && p.pid !== pid)
      .filter((p) => !parent || parent.started == null || p.started == null || p.started >= parent.started)
      .map((p) => p.pid);
  };
}

// Kill a process and everything it spawned.
//
// Children first: killing the parent first can let a child be reparented to
// init before we get to it, and then it is no longer in the tree we collected.
let logKilledTree = () => {};
function setKilledTreeLogger(fn) { logKilledTree = fn; }

function killTree(pid) {
  const tree = processTree(pid);
  for (const target of tree.slice().reverse()) {
    try { process.kill(target, 'SIGKILL'); } catch (_) { /* already gone */ }
  }
  return tree;
}

// A remote URL can carry credentials — `http://user:pass@host/...` was sitting
// in two of these repos' .git/config. git echoes the URL back in its errors, so
// scrub before anything is handed to a browser.
function redactCredentials(text) {
  return String(text == null ? '' : text).replace(/\/\/[^\s/@]*:[^\s/@]*@/g, '//***:***@');
}

// git lists the files a pull would overwrite as tab-indented lines under
// "Your local changes to the following files would be overwritten by merge:"
// (or the untracked-files variant), ended by a non-indented line.
function overwrittenFiles(out) {
  const files = [];
  let inList = false;
  for (const line of String(out).split(/\r?\n/)) {
    if (/would be overwritten/i.test(line)) { inList = true; continue; }
    if (!inList) continue;
    if (/^\s+\S/.test(line)) files.push(line.trim());
    else inList = false;
  }
  return files;
}

/**
 * Fast-forward one repository from its upstream.
 *
 * --ff-only on purpose. A plain `git pull` builds a merge commit when the local
 * branch has its own work, and can fail halfway through with a dirty tree. This
 * either moves cleanly forward or does nothing and says why — which is the right
 * default for a button whose whole job is "sync me up". Real merges belong in a
 * terminal, where there is someone to answer the questions.
 *
 * @returns {Promise<{ok: boolean, reason: string, updated?: boolean, from?: string, to?: string, message?: string}>}
 */
async function pullRepo(repoPath) {
  const head = readHead(repoPath);
  if (!head) return { ok: false, reason: 'not-a-repo' };

  // No dirty-tree check up front. It used to refuse any uncommitted change —
  // an untracked file nobody pulls included — while git itself already does
  // the safe thing: a fast-forward that would overwrite a local change (tracked
  // or untracked) aborts before touching anything, and one that would not just
  // carries the change along. So git decides, and a refusal names the files.
  const before = readHead(repoPath);
  return new Promise((resolve) => {
    // Time it out by hand rather than with execFile's own `timeout`, and kill
    // the process TREE rather than the process.
    //
    // `git pull` is a wrapper: it forks `git fetch`, which forks
    // `git remote-http`. execFile's timeout signals only the wrapper, so both
    // children survive — measured against an unreachable remote.
    //
    // Process groups are not the way out here, and the experiment that proved
    // it is worth recording. `detached: true` did NOT make the child a group
    // leader: its pid was 2524895 while its pgid was 2524887, so
    // `process.kill(-child.pid)` raised ESRCH — killing a group that does not
    // exist. Reaching for the *real* pgid instead killed the test runner
    // itself, because without detach the child sits in its parent's group.
    // In the server that would mean a pull timeout taking cc-web down with it.
    //
    // So: walk the tree and kill exactly its members. No assumptions about
    // groups, and no way to reach anything outside this one process.
    let child;
    let timedOut = false;
    let timer = null;
    child = execFile(
      'git',
      // quotePath off so a Chinese filename in a refusal reads as itself, not as octal escapes.
      ['-c', 'core.quotePath=false', '-C', repoPath, 'pull', '--ff-only'],
      {
        maxBuffer: STATUS_MAX_BUFFER,
        windowsHide: true,
        // No terminal here, so a credential prompt would hang rather than ask.
        // LC_ALL=C: the refusals below are matched by their English text, and a
        // localized git would otherwise answer in Chinese.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      },
      (error, stdout, stderr) => {
        if (timer) clearTimeout(timer);
        const out = redactCredentials(`${stdout || ''}${stderr || ''}`).trim();
        // Already settled by the timer above; a late callback has nothing to say.
        if (timedOut) return;
        if (error) {
          if (error.killed || error.signal) {
            return resolve({ ok: false, reason: 'timeout', message: `no response after ${PULL_TIMEOUT_MS / 1000}s` });
          }
          if (/no tracking information|no upstream/i.test(out)) {
            return resolve({ ok: false, reason: 'no-upstream', message: 'this branch tracks nothing' });
          }
          if (/would be overwritten/i.test(out)) {
            const files = overwrittenFiles(out);
            return resolve({ ok: false, reason: 'would-overwrite', files, message: files.join(', ') || out.split('\n')[0] });
          }
          if (/not possible to fast-forward|diverge/i.test(out)) {
            return resolve({ ok: false, reason: 'not-fast-forward', message: 'local commits would need a merge' });
          }
          return resolve({ ok: false, reason: 'failed', message: out.split('\n')[0] || error.message });
        }
        const after = readHead(repoPath);
        const updated = !!(before && after && before.branch !== after.branch) || !/Already up to date/i.test(out);
        resolve({
          ok: true,
          reason: updated ? 'updated' : 'up-to-date',
          updated,
          from: before ? before.branch : null,
          to: after ? after.branch : null,
          message: out.split('\n')[0] || '',
        });
      },
    );
    timer = setTimeout(() => {
      timedOut = true;
      const killed = killTree(child.pid);
      if (killed.length > 1) {
        logKilledTree(killed);
      }
      // Resolve here rather than waiting for the exec callback. Killing the
      // group can leave that callback un-fired — the caller would then wait
      // forever on a promise that never settles, which is a worse failure than
      // the timeout it was meant to report.
      resolve({ ok: false, reason: 'timeout', message: `no response after ${PULL_TIMEOUT_MS / 1000}s` });
    }, PULL_TIMEOUT_MS);
  });
}

// Switching, creating and renaming are local ref moves — no network — so they
// get the status ceiling, not the pull one.
const BRANCH_OP_TIMEOUT_MS = 15000;

// One git call for the branch operations below. Never through a shell, never a
// credential prompt, and the output is scrubbed before anyone sees it.
function runGit(repoPath, args, timeout = BRANCH_OP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', repoPath, ...args],
      { timeout, maxBuffer: STATUS_MAX_BUFFER, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: String(stdout || ''),
          out: redactCredentials(`${stdout || ''}${stderr || ''}`).trim(),
          error,
        });
      },
    );
  });
}

// A name git would accept as a branch, and one that can never be read as an
// option: every caller puts the name on a git command line, so a leading `-`
// is refused outright. The check is the pure syntax form
// (`check-ref-format refs/heads/<name>`), not `--branch`, which expands `@`
// and `@{-1}` against whatever repository the server happens to run in.
async function isValidBranchName(name) {
  if (typeof name !== 'string' || !name || name.length > 200 || name.startsWith('-') || name === 'HEAD' || name === '@') return false;
  if (/[\x00-\x20\x7f]/.test(name)) return false;
  const r = await runGit(process.cwd(), ['check-ref-format', `refs/heads/${name}`]);
  return r.ok;
}

function failure(reason, out, fallback) {
  return { ok: false, reason, message: (out || '').split('\n')[0] || fallback || reason };
}

// Local branches, plus remote branches with no local counterpart — the ones a
// `git switch <name>` would turn into a new tracking branch.
async function listRefs(repoPath) {
  const r = await runGit(repoPath, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']);
  if (!r.ok) return null;
  const local = [];
  const remote = new Set();
  for (const ref of r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
    if (ref.startsWith('refs/heads/')) {
      local.push(ref.slice('refs/heads/'.length));
    } else if (ref.startsWith('refs/remotes/')) {
      const rest = ref.slice('refs/remotes/'.length);
      const slash = rest.indexOf('/');
      if (slash < 0) continue;
      const name = rest.slice(slash + 1);
      if (name && name !== 'HEAD') remote.add(name);
    }
  }
  const head = readHead(repoPath);
  return {
    current: head && !head.detached ? head.branch : null,
    detached: !!(head && head.detached),
    local,
    remote: [...remote].filter((n) => !local.includes(n)).sort(),
  };
}

// `git switch` rather than checkout: it refuses to touch anything that would
// overwrite uncommitted work, and carries non-conflicting changes along — so
// the panel never needs its own dirty check here, and never loses work.
async function switchBranch(repoPath, branch) {
  const head = readHead(repoPath);
  if (!head) return { ok: false, reason: 'not-a-repo' };
  if (!(await isValidBranchName(branch))) return { ok: false, reason: 'invalid-name' };
  if (!head.detached && head.branch === branch) return { ok: true, reason: 'already', from: branch, to: branch };

  const r = await runGit(repoPath, ['switch', branch]);
  if (!r.ok) {
    if (/would be overwritten|overwritten by checkout/i.test(r.out)) return failure('would-overwrite', r.out);
    if (/invalid reference|did not match|not a commit|no such branch/i.test(r.out)) return failure('not-found', r.out);
    return failure('failed', r.out, r.error && r.error.message);
  }
  return { ok: true, reason: 'switched', from: head.branch, to: branch };
}

// A new branch from wherever HEAD is now. With `checkout` it also moves there,
// which is what "start the task branch" usually means.
async function createBranch(repoPath, branch, { checkout = true } = {}) {
  const head = readHead(repoPath);
  if (!head) return { ok: false, reason: 'not-a-repo' };
  if (!(await isValidBranchName(branch))) return { ok: false, reason: 'invalid-name' };

  const r = await runGit(repoPath, checkout ? ['switch', '-c', branch] : ['branch', branch]);
  if (!r.ok) {
    if (/already exists/i.test(r.out)) return failure('exists', r.out);
    return failure('failed', r.out, r.error && r.error.message);
  }
  return { ok: true, reason: 'created', from: head.branch, to: checkout ? branch : head.branch };
}

// Rename the CURRENT branch, locally only. Its upstream setting is left alone,
// so it keeps pulling from the old remote branch until someone pushes the new
// name — the panel says so up front.
async function renameBranch(repoPath, newName) {
  const head = readHead(repoPath);
  if (!head) return { ok: false, reason: 'not-a-repo' };
  if (head.detached) return { ok: false, reason: 'detached' };
  if (!(await isValidBranchName(newName))) return { ok: false, reason: 'invalid-name' };
  if (head.branch === newName) return { ok: true, reason: 'already', from: newName, to: newName };

  const r = await runGit(repoPath, ['branch', '-m', head.branch, newName]);
  if (!r.ok) {
    if (/already exists/i.test(r.out)) return failure('exists', r.out);
    return failure('failed', r.out, r.error && r.error.message);
  }
  return { ok: true, reason: 'renamed', from: head.branch, to: newName };
}

// Attach working-tree status to an already-scanned repo list. Bounded
// concurrency: 11 simultaneous `git status` runs on a cold cache is a real
// I/O spike, and this server shares its single thread with live terminals.
async function attachStatus(repos) {
  const queue = repos.slice();
  const workers = Array.from({ length: Math.min(STATUS_CONCURRENCY, queue.length) }, async () => {
    for (let repo = queue.shift(); repo; repo = queue.shift()) {
      const status = await readStatus(repo.path);
      if (status) Object.assign(repo, status);
    }
  });
  await Promise.all(workers);
  return repos;
}

module.exports = { scanBranches, attachStatus, readHead, readStatus, pullRepo, overwrittenFiles, redactCredentials,
  isValidBranchName, listRefs, switchBranch, createBranch, renameBranch, processTree, killTree, setKilledTreeLogger, MAX_REPOS, MAX_ENTRIES, PULL_TIMEOUT_MS };
