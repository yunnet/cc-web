# Changelog

## [Unreleased]

### Added
- **A background tab says when it has finished, or needs your approval.**
  When Claude finishes answering in a tab you are not looking at, the tab's
  dot becomes a ✓ that flashes a few times, the browser tab's title gets a ✓
  in front while the page is hidden, and a notification carries Claude's
  topic. It waits 8 seconds first: waiting for a permission answer also looks
  like finishing, and Claude's permission request only arrives about 6 seconds
  later (measured on 2.1.278). That request — a new `Notification` hook with
  matcher `permission_prompt` — turns the tab's dot amber with a small 待批准
  label and sends its own notification. Both come off when you open the tab,
  when Claude works again, or when you return to the page with the tab on
  screen. The bell still rings, but no longer notifies a second time for a tab
  already marked; the 90-second "appears finished" guess is gone.
- **Tabs show when Claude is working.** While Claude answers, its tab's status
  dot turns into a spinning half-filled ball, like the one Warp shows, and goes
  back to the dot when it is done — on background tabs and split panes too, so
  you can see from one tab that another has finished. It follows Claude's own
  terminal title, which leads with ◐/◑ while it works and ✳ when idle
  (measured on 2.1.278); the topic Claude names the task with joins the
  folder in the tab's tooltip. Stopping or exiting mid-answer stops the ball.
  The ball holds still under "reduce motion".
- **Delete from the file explorer.** Every row but `..` has a red trash button
  that asks first (a folder: "and everything inside it"), then calls the new
  `POST /api/fs/delete`. The server refuses `/`, the home directory, the launch
  folder and any session's working folder — and anything above them — compared
  on real paths so a symlinked alias is caught; a symlink is removed as a link,
  never its target. Deletion is async so a large tree does not stall the server.
  On a phone the size column gives way so a file's name keeps some room.
- **New folder from the file explorer drawer.** A button next to Upload opens
  an inline name field (Enter creates, Esc closes the field, not the drawer).
  It creates in the folder on screen through the existing
  `/api/create-folder`, so the server's path checks apply unchanged; the
  request is shared with the new tab dialog's own new-folder button. On a
  390px screen the path field now shrinks so the new button stays on screen.
- **Ctrl+Enter sends now.** Claude Code 2.1.275 added "send now": interrupt the
  turn and send the queued messages at once. Its Ctrl+Enter never reached
  Claude through xterm (every Enter chord is `\r`), so cc-web maps it to Ctrl+X
  Ctrl+S, the same action in any terminal — measured on 2.1.278 to interrupt
  the turn and deliver the queue, with a control run showing nothing happens
  without it. Main terminal and split panes.
- **A tab you name keeps that name in Claude.** A name typed in the new tab
  dialog, or a tab renamed later, is passed as `claude --name`: it shows on the
  prompt box and in the terminal title, and `/resume` and the history list show
  it. Only typed names — with `--name` set Claude stops writing its own title,
  so a folder name or a clipped conversation title is never passed. A rename
  applies from the next start.

### Security
- **The browser could override server-owned launch fields.** `start_claude`
  options were spread last over the bridge call, so a client could replace
  `workingDir` (skipping the path check) or `hookScript` (a file node would run
  as the hook). Only `model`, `permissionMode`, `effort` and
  `dangerouslySkipPermissions` are taken from the browser now, and they cannot
  shadow anything the server sets.

### Added
- **Launch options for Claude Code 2.1.278.** Model *Fable*; permission modes
  *auto*, *manual* (ask each time) and *dontAsk*; and a new effort level
  (`--effort` low … max). In the new tab dialog and the Start prompt; the
  dialog remembers the last choice. A test reads the installed `claude --help`
  so a renamed mode shows up as a failure, not as a tab that will not start.

### Fixed
- **Conversation titles in the history list.** Claude no longer writes
  `summary` records; it writes `ai-title` and rewrites it as the conversation
  goes. The list now shows that title — the latest one, read from the end of
  the transcript — instead of the first prompt cut to length (measured: 41 of
  50 conversations in one project had one going unused).
- **A deleted folder stayed in the new tab dialog's recent list.** It is
  dropped the first time it fails to open, and the dialog falls through to the
  next recent folder instead of the launch directory.

### Changed
- **One dialog to open a tab, not three.** Opening a tab used to walk through
  the folder browser, then Create New Session, then the Start Claude prompt.
  They are now one dialog, 新建标签页 (`#newTabModal`), and it arrives filled
  in — the active tab's folder, a name taken from it, the launch options used
  last — so another tab on the project you are in is `+` then Enter.
  - The folder tree is folded behind 浏览…, with recently used folders one click
    away; a path typed into the bar counts even without pressing Enter.
  - 新对话 / 继续之前的对话 sits in the same dialog, and the conversation list
    follows the folder as you change it.
  - 启动 and 危险模式启动 create the session and start Claude in one step; the
    Start Claude prompt no longer appears for a new tab, only to restart a
    stopped one.
  - Nothing the three dialogs enforced was dropped: the launch folder, home and
    `/` are refused with the reason shown in the dialog, a double click still
    creates one session, a conversation open in another tab is greyed out (and a
    409 switches to it), and skipping permissions is never remembered.

### Added
- **Insert a path into the terminal from the file explorer.** Every row — files
  and folders alike — gets an at-sign button next to the download one. Clicking
  it types `@<absolute path>` plus a space into the terminal input and closes the
  explorer, leaving the cursor after the path so you write the prompt yourself.
  No newline is ever sent: pressing Enter for you would fire a half-written
  message.
  - `@` with an **absolute** path, measured against Claude Code 2.1.266 driving a
    real pty: Claude reads the file even when it sits outside the session's
    working directory (a relative path breaks the moment you browse out of the
    project), the trailing space dismisses the `@` autocomplete popup so the
    keystrokes after it are not eaten, and a path containing spaces needs no
    quoting.
  - A folder row had no button at all until now; handing Claude a directory is at
    least as common as handing it one file.

### Fixed
- **A new session opened a blank, dead tab.** Reported as "can't create a
  session" against a particular working directory; the directory was a red
  herring — every new session was hit, and the ones already open were not,
  because they resume into an already-running Claude.
  - `showSession()` awaits `openViewSocket()` the first time a view is built.
    The server's `session_joined` lands *during* that await and, for a session
    whose Claude has not started, raises the "Start Claude" prompt. The line
    after the await then hid the overlay unconditionally — wiping the prompt and
    leaving an empty terminal with no way to start anything.
  - Console from the reproduction on :32352, the two lines back to back:
    `[session_joined] New session detected, showing start prompt` /
    `[hideOverlay] Hiding overlay, current display: flex`. The session itself was
    healthy throughout: re-showing the overlay by hand and clicking Start logged
    `Starting Claude session … [fresh] cwd=/home/myhi/gongxinyun/ts` →
    `started successfully`.
  - Both cleanup-time hides now ask `startPromptVisible()` first. The bootstrap
    path had grown this guard inline already; it is one helper now, so a third
    caller cannot quietly copy the check and let it drift.

## [4.11.1] - 2026-09-11

### Fixed
- **Typing on a phone hid the input box.** A regression from v4.11.0, reported
  within the hour of deploying it.
  - The soft-keyboard mode (v4.7.0) works by letting the grid stay tall and
    turning the frame into a short scrolling window onto it, parked at the
    bottom so the input box sits just above the keyboard. v4.11.0 gave every tab
    its own terminal, stacked as `position: absolute` views — and an absolutely
    positioned child contributes **no height to its parent**. So `#terminal`
    collapsed, the frame had nothing to scroll, and the bottom of the grid — the
    input box — was clipped away.
  - While the keyboard is open the visible view goes back into normal flow and
    carries its height again. The hidden views are `display: none`, so there is
    nothing left to overlap and no reason to keep them positioned.
  - Measured on a phone-sized viewport with the keyboard simulated: frame
    **746px of content in a 395px window, scrollTop 351** (parked at the end) —
    against **395 / 395, nothing to scroll** with the fix reverted. Screenshots
    of both: the input box sits above the keyboard, or is gone entirely.

## [4.11.0] - 2026-09-10

### Changed
- **Each tab keeps its own terminal, so switching tabs no longer throws the
  history away.** Reported: inside one tab history scrolls back a long way, but
  switch to another tab and back and only one screen is left.
  - Switching used to call `joinSession()`, which reset the terminal and replayed
    the server's buffer. The thousands of lines the browser had built up went in
    that reset, and the replay could not put them back: the server keeps a
    rolling window of raw chunks, and most chunks are Claude's in-place repaint
    frames (measured on a live session: 500 chunks, only 136 distinct, rebuilding
    to 39 lines).
  - Now every open tab owns a terminal **and its own socket** — the shape
    splits.js has used per pane since it was written, so the server already
    handled several clients on different sessions. A background tab stays
    connected and keeps filling; switching is only a question of which view is
    visible. `this.terminal` / `this.socket` still mean "the one on screen", so
    the rest of the client is unchanged.
  - Measured on two live sessions: A at 167 lines / 122 scrollback → switch to B
    → **back to A at 167 / 122**, unchanged, five switches running. With output
    produced by A *while it was in the background*, coming back showed 174 / 129
    — the new lines at the bottom, the old ones still above.
  - A background view withdraws its pty size vote (`detach_size`). The pty runs
    at the minimum across attached clients, so a hidden view holding a stale size
    would pin it smaller than the window: measured, 168 → 218 columns on
    enlarging the window with a background tab open. `detachClientSize` has been
    in the server since v4.5.0 with nothing calling it; this is its caller.
- **History retention is counted in megabytes, not "chunks".** A chunk is
  whatever one read off the pty returned, so the old unit could not express the
  thing being configured — 500 of them measured 50 KB. Default **2 MB**, range
  256 KB – 16 MB, and the Settings panel now says MB. This is what an **F5** has
  to rebuild from; a tab you merely switch away from keeps its own scrollback and
  never comes through here.
  - Measured: a fresh page load rebuilt the full history, earlier lines and all,
    in ~60ms. xterm absorbs 2 MB / 19066 lines in 271ms and 8 MB / 76261 lines in
    998ms, which is why the replay is sent in one go.
  - An existing `{chunks: N}` settings file is migrated rather than reset. A file
    holding the old *default* (500) is given the new default: converting it
    literally would clamp to the 256 KB floor and hand every existing install the
    smallest history possible on upgrade.

### Notes
- Keeping N terminals alive costs memory — a full 50000-line scrollback is on the
  order of ten megabytes each. That is the trade for not losing history.
- Session files on disk grow with the retention setting (~300 KB → ~2 MB each),
  and `SessionStore.writeOne` rewrites a session's file whole on each autosave.
- xterm 6 has **no** API for prepending to scrollback (checked: no `prepend`, no
  `loadHistory`), so "scroll up to fetch older output" cannot be done inside the
  terminal — it would need re-rendering from an earlier point, which jumps. What
  is here instead is a bigger single replay.

## [4.10.0] - 2026-09-10

### Added
- **A rendered .html now carries its own images, so a page of screenshots
  actually shows them.** Opening `delegate-list-scope.visual-check.html` from
  the file explorer produced a page of broken images: four `<img>` blocked with
  *"violates the following Content Security Policy directive: img-src data:
  blob:"*, `naturalWidth` 0.
  - Relaxing the sandbox would not even have been enough. Two further breaks sit
    behind the CSP: the render URL keeps the whole absolute path in a **single**
    path segment, so a browser resolves `sibling.png` against the ticket rather
    than the directory (measured: 404); and the ticket is single-use, already
    spent by the page's own request (measured: second use → 401). `base-uri
    'none'` rules out a `<base href>` workaround.
  - `img-src data:` was always allowed, so the bytes now travel inside the page.
    Nothing about the sandbox moves: still an opaque origin, still
    `default-src 'none'`, still no host in `img-src`, still one spent ticket. A
    test asserts the CSP has not grown a `'self'`.
  - Scope is narrow: images only, only paths that resolve **inside the page's
    own directory** (realpath'd on both sides, so a symlink cannot climb out),
    only up to a 6 MB budget, and only when *rendering* — the source view stays
    byte-for-byte the file on disk. CSS `url()` is covered too, since the same
    directive governs background images.
  - Verified end to end on the real file: 1924 bytes in, 691228 out, four
    `data:image/png` inlined, zero relative links left, **zero CSP errors and
    zero failed requests** in the browser, all four screenshots at their full
    1440×900 / 2048×1320.

### Notes
- The `containment fail` caption on that page is **not** a cc-web symptom: it is
  static text the diagram generator wrote into the file (five occurrences), the
  verdict of its own automated layout check. cc-web's bug was only that the
  images did not load.

## [4.9.2] - 2026-09-10

### Fixed
- **Two input boxes after switching tabs, only one of them live.** Joining a
  session drew Claude's input box and status line twice: once from the replayed
  buffer, then a second copy underneath.
  - The duplicate came from cc-web manufacturing a resize. v4.6.3 nudged the pty
    down one row and back on every join, because Claude's *fullscreen* renderer
    drew that UI at the last rows of the pty and a client joining at a different
    row count saw nothing there. v4.8.0 forced the classic renderer, which draws
    the UI inline with the conversation — so the failure the nudge existed for
    cannot happen, while the nudge itself became the bug: Claude answers SIGWINCH
    by printing a *fresh* UI block at the cursor, which sits just below the one
    the replay drew.
  - Instrumented per write in the browser: the replay (49782 bytes) left **one**
    status bar; the repaint that arrived 95ms after the resize (2921 bytes) made
    it **two**. Replaying the same 500 chunks into an offline terminal with no
    resize produced one, which is what ruled out the recorded bytes.
  - The forced repaint is gone. A genuine size change still resizes the pty and
    still makes Claude reprint below the old block — the same thing a native
    terminal does, and only when the size really changed.

### Notes
- Server-side, so this one needs a restart to take effect (sessions resume; the
  page reload is not enough).

## [4.9.1] - 2026-09-10

### Fixed
- **A tab that was open before the renderer change could not scroll back, and
  its mouse wheel did nothing.** Reported on a PC after the v4.8.0 upgrade. The
  history was there and the wheel was not being swallowed — the page was stuck
  in the terminal's *alternate* screen buffer. A page attached while Claude ran
  the fullscreen renderer stays in that buffer when its Claude dies without
  emitting `ESC[?1049l`, and a killed process never emits it, so the upgrade
  restart left every open tab wedged. The alternate buffer has no scrollback by
  design and hands the wheel to the application, which explains both symptoms at
  once.
  - Reconnecting could not rescue it: the join path called `terminal.clear()`,
    which blanks the screen but resets no modes. Measured against a live
    session: normal buffer scrolled 456→453; after `ESC[?1049h` the wheel was
    dead; after `clear()` + replay it was **still** in the alternate buffer and
    still dead; `ESC[?1049l` restored the wheel and the 495 lines that had been
    sitting underneath the whole time.
  - Joining now calls `terminal.reset()`, and does so whether or not there is
    anything to replay — a session with an empty buffer is exactly the case
    where there is nothing to look at *and* no way to scroll. This also clears
    the rest of what a half-dead app leaves behind: scroll regions, application
    cursor keys, mouse tracking, bracketed paste.

### Notes
- Frontend-only, so the deploy needs no server restart and no session restart —
  but an already-open tab keeps the old script until it is reloaded. A wedged
  tab is fixed by reloading it once.

## [4.9.0] - 2026-09-09

### Added
- **cc-web ships its own Claude Code themes, so the input box border is finally
  a colour we choose by name.** The light border and the status-line rule were
  fixed a dozen times without sticking, because the only lever available was an
  ANSI *slot* and Claude double-books ANSI 7 as both that border's foreground
  and the background of your own message band — an identity that has no solution
  in a single value. Claude supports naming the colour instead: a theme file in
  `~/.claude/themes/` with a `base` preset plus `overrides` keyed by token,
  selected with `theme: "custom:<slug>"` through the `--settings` channel cc-web
  already used. Measured in the browser afterwards, the two rules around the
  input box render at exactly `#57606a` and the auto-mode line at `#9a6700` —
  the values cc-web asked for, not whatever a shared slot resolved to.
  - Named: `promptBorder`, `warning`, `planMode`, `autoAccept`, `bashBorder`
    (the input box border differs **by mode** — the auto mode most sessions run
    in draws it as `warning`, so naming `promptBorder` alone would have looked
    like the change did nothing), plus `subtle`, `inactive`, and
    `userMessageBackground`.
  - Every colour is asserted at ≥4.5:1 against its own background by a test, so
    "invisible" now fails a test run instead of waiting to be noticed.
  - Falls back to the previous built-in `light-ansi` / `dark` if the files cannot
    be written. Not optional: naming a `custom:` theme that is not on disk does
    not degrade gracefully — measured, Claude drops silently to the **dark**
    preset, i.e. a dark theme on a white terminal.
- **A newline key on mobile.** Enter submits, and a phone's soft keyboard has no
  Shift+Enter or Alt+Enter to reach the existing newline binding, so writing a
  two-line prompt on a phone was impossible. The floating stack gains a third
  key, `↵`, sending LF (Ctrl+J) — Claude Code's own documented newline, which
  works in every terminal with no setup. Verified on a phone-sized viewport:
  tapping it leaves both lines in the input box, unsent.

### Notes
- The theme files are written at server start, before anything can spawn Claude:
  Claude hot-reloads edits to `~/.claude/themes/`, but only notices the directory
  at all if it existed when it started. Deliberately not done in the constructor,
  so `npm test` cannot write into the real `~/.claude/themes/`.
- The theme name is chosen when Claude is spawned, so a running session keeps the
  old one until its Claude restarts.

## [4.8.1] - 2026-09-09

### Changed
- **The renderer is now requested through Claude's own `tui` setting**, not only
  the environment variable. `tui` is what the `/tui` command writes, so a cc-web
  session now behaves exactly like a user who ran `/tui default` — same code
  path, and with a choice on record Claude stops offering to switch to
  fullscreen. It goes through the `--settings` channel cc-web already uses for
  the theme and the plan-mode hook. Valid values are exactly
  `["default","fullscreen"]`: `"default"` **is** the classic renderer, and it is
  the only way to name it — there is no `"classic"` value.
- Worth knowing where this problem came from: `~/.claude/settings.json` here
  carries `"tui": "fullscreen"`, so the fullscreen renderer was a saved
  preference, not a default. The injected setting overrides it for cc-web
  sessions only and leaves the user's own terminal alone (`/tui default` fixes
  that one).

### Notes
- `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` stays, and is not redundant: the
  setting loses to a `/tui fullscreen` typed inside a cc-web tab, while the env
  var beats even an explicit `"tui": "fullscreen"` (measured). Without it,
  history would be one slash-command away from gone. The cost is that `/tui
  fullscreen` is a no-op inside cc-web — deliberate, since the alternate screen
  buffer has no scrollback to read.

## [4.8.0] - 2026-09-09

### Changed
- **The terminal has scrollback again: Claude now runs under its classic
  renderer.** History was not being lost on the way to the browser — it was
  never produced. Claude's default fullscreen renderer draws on the terminal's
  *alternate* screen buffer, the way vim does, and that buffer has no scrollback
  by design: there is nothing above the screen to scroll to. Measured on a real
  claude process, the default emits **zero** newlines and enters the alternate
  buffer (20 cursor-homes — pure in-place repaint); with
  `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` it never enters it and emits 117
  newlines that land in scrollback. In the browser the acceptance number went
  from **0 scrollback rows in every previous version** to 0 → 25 → 50, growing
  one prompt at a time, with the session's opening banner still reachable by
  scrolling to the top. This is why the earlier attempts at this symptom could
  not have worked — stripping the screen-clear produced 0 rows either way, and
  the size negotiation and repaint nudge were treating symptoms.
- Both terminals now keep **50000** lines of scrollback, up from 10000. Content
  actually accumulates now, so the old ceiling was tight for a long session; the
  cost is memory, which is the trade asked for by "don't limit how much I can
  read".

### Notes
- The renderer is chosen from the spawn environment, so **an already-running
  Claude keeps the old one** — each session's Claude has to be restarted (stop,
  then start/resume) after upgrading. Restarting cc-web alone is not enough.
- The classic renderer flickers more and grows in memory with the conversation,
  and gives up in-app mouse support and PgUp/PgDn. On a phone, native scrolling
  is what is used anyway, and being able to read history matters more than not
  flickering.

## [4.7.0] - 2026-09-09

### Changed
- **A soft keyboard no longer resizes the terminal.** Opening the keyboard on a
  phone shrank the viewport, which re-fitted the terminal, which sent the new
  row count to the pty — and Claude re-laid-out its whole UI for it. Measured on
  a phone: 38 rows became 21, and since Claude reserves about 7 rows for its own
  chrome that left a 14-row content area. Replies scrolled away after a dozen
  lines and every keyboard open/close broke the history in half.

  The terminal now keeps its size and the frame around it becomes a short
  scrolling window onto it, parked at the bottom so the input box and the status
  line sit just above the keyboard. Reading keeps the full content area; typing
  keeps the input box in view; the pty is never resized, so Claude never
  re-lays-out and the history stays continuous.

  Two things had to be established first, both by measurement rather than
  reasoning. xterm clips rather than scrolls when its own container is too short
  — its viewport never becomes scrollable and the last rows, where the input box
  lives, are simply unreachable — so the scroll has to be on the frame outside
  it. And a rotation must still re-fit, which is why the detector keys on the
  width being unchanged: a keyboard never changes it, a rotation always does.

## [4.6.4] - 2026-09-08

### Fixed
- **Creating a session no longer creates one per click.** Reported from the dev
  instance as "it keeps creating tabs". The dialog stayed open and its button
  stayed live until the POST came back, so a second click landed inside that
  window and was a second session and a second tab. Reproduced in a browser:
  three clicks, three sessions on disk, three tabs — and the same signature was
  on the dev instance, five `cc-web` sessions created three seconds apart.

  The button now disables and reads "Creating…" for the duration, and an
  in-flight flag closes the gap before the button can even repaint. Released in
  a `finally` so a refused create — a conversation already open in another tab —
  does not leave a dead button behind.

## [4.6.3] - 2026-09-08

### Fixed
- **Claude re-lays-out its UI whenever a client joins a session.** It draws the
  input box and the status line at the LAST rows of the pty, so a device that
  joins with a different row count than Claude last laid out for sees nothing
  there — the recurring "the input box border and the status bar are gone".

  Asking Claude to redraw would not help: it would repaint from the same stale
  idea of the size. The join now nudges the pty one row down and back, which is
  two SIGWINCHes and forces the recompute. Deferred 300ms past the join so the
  client's own size has landed first, and coalesced, because reconnects arrive
  in bursts and each one would otherwise repaint the whole UI.

  Verified against a live Claude process by watching the kernel's idea of the
  pty size during a join: 40 rows to 39 and back.

## [4.6.2] - 2026-09-08

### Fixed
- **The sessions list scrolls as one region instead of two.** Reported as the
  wheel feeling heavy in the panel. It was: the list carried its own height cap
  while the dialog also scrolled, so on a short window the wheel ran the list to
  its end, chained to the dialog, then to the page — nothing on screen says
  which layer is about to move. On a tall window the opposite: the list stopped
  growing at 460px while the dialog still had room, so 8 of 14 rows showed
  through a porthole in a half-empty box.

  The dialog is the fixed frame now and the list is the only thing that
  scrolls, taking whatever height is left. Measured at both 900px and 493px
  window heights: one scroll region, dialog inside the viewport, page still.

## [4.6.1] - 2026-09-07

### Changed
- **Session rows carry an explicit switch button again.** The rewrite left
  switching as the row's own click and only the trash as a visible control, so
  the action was there but nothing on screen said so. The arrow is back beside
  the trash — and only on rows that are not the current tab, since a button
  that switches you to where you already are is one that looks enabled and
  does nothing.

## [4.6.0] - 2026-09-07

### Added
- **A new tab can continue an existing Claude conversation.** The New Session
  modal gained a "Continue previous" mode listing the conversations Claude has
  recorded for the chosen folder, and the toolbar gained a history button
  (`#historyBtn`) showing the same list for the active session's folder. Picking
  one opens a tab resumed where it left off; everything said from then on is
  appended to that same transcript, across server restarts too.

  It needed no new plumbing: the cc-web session id already *is* the Claude
  conversation id, so `POST /api/sessions/create {resumeId}` simply creates the
  session under that uuid with `claudeStarted` already set. `GET
  /api/claude-sessions?dir=` lists the transcripts.

  The menu's Sessions modal and the toolbar's list are now one panel: sessions
  first, then the folder's unopened conversations. They were two renderers over
  two different sources, so a session that had never started Claude showed up in
  one and a closed conversation only in the other.

  One conversation, one tab — two Claude processes resuming one transcript would
  corrupt it, so a conversation a session already holds is listed under Sessions
  (switch to it) rather than offered again, and the server answers 409 with the
  id of the tab holding it. A conversation the user explicitly
  picked also loses the bridge's silent fall-back to a fresh launch: a failed
  `--resume` now says so in the terminal rather than leaving a tab that looks
  resumed while holding an empty conversation.

- **A pull button on each repository in the branch panel.** `git pull --ff-only`:
  it either fast-forwards cleanly or does nothing and says why. A plain pull
  would build a merge commit when the local branch has its own work, and can
  fail halfway with a dirty tree; real merges belong in a terminal.

  Refused outright over uncommitted changes, verified to leave the working tree
  byte-identical. Credentials are scrubbed from anything handed back — two of
  these repositories had `http://user:pass@host/...` in `.git/config`, and git
  echoes the remote URL back in its errors.

  `POST /api/git/pull` requires the target to be a git repository, not merely a
  readable path: it is the panel's only write, so `validatePath` alone would
  amount to "run git wherever you can name".

### Fixed
- **The trust prompt is auto-accepted again.** Starting a session in a folder
  Claude had not seen before sat on "Is this a project you created or one you
  trust?" until someone pressed Enter by hand.

  Two things had changed, and the second is the interesting one. The wording
  moved on from "Do you trust the files in this folder?" — but the match would
  have failed anyway: captured from the real PTY, v2.1.247 positions *every
  word* with its own cursor-column escape, so once the escapes are stripped the
  words run together with no spaces at all. The check now drops the escapes and
  all whitespace before looking for its fragments, and is tested against the
  captured bytes rather than a hand-typed sentence.

- **A pull that times out no longer leaves git processes behind.** `git pull`
  forks `git fetch`, which forks `git remote-http`; signalling the wrapper left
  both children running, measured against an unreachable remote.

  Process groups turned out to be the wrong tool, and dangerously so.
  `detached: true` did not make the child a group leader — pid 2524895 against
  pgid 2524887 — so `kill(-child.pid)` raised ESRCH against a group that never
  existed. Reaching for the real pgid instead killed the test runner, because
  without detach the child sits in its parent's group; in the server that is a
  pull timeout taking cc-web down with it.

  The timeout now walks `/proc/<pid>/task/*/children` and kills exactly that
  tree, deepest first. Measured: four processes killed, none left, caller alive.

## [4.5.0] - 2026-09-07

### Added
- **Upload files into the folder the explorer is showing.** A button in the path
  bar and a drop onto the listing. The button is not redundant: a phone has no
  drag source, so dropping alone would have shipped a desktop-only feature.

  The directory is as unrestricted as browsing is, which puts the whole burden
  on the filename — it must be a bare basename, so `name=../../.bashrc` cannot
  reach past the directory on screen. Existing files are refused by the kernel
  (`O_EXCL`), not by a stat-then-write check that could lose the race.

- **The scrollback depth is configurable, default 500.** It used to be three
  hard-coded numbers in two files — persist 100 chunks, replay 200, hold 1000 in
  memory — and the smallest won. Measured against real sessions the median chunk
  is 77-174 bytes, so 100 chunks came to 8-24 KB, much of it Claude's redraw
  escapes rather than text. That is why a restart came back nearly empty.

  One setting now drives all three. Replay is separately bounded at 512 KB
  because it is sent on every reconnect, for every device: at the 5000 maximum
  the payload measured ~1.75 MB, against 89 KB for the 200 it replaced.

- **Settings shows the installed Claude Code version and what npm publishes.**
  Display only. `claude --version` is 0.036s and the registry is 5.8s, so the
  local one runs per request and the remote is cached for six hours — a failure
  is deliberately not cached. Versions compare numerically: as strings, 2.1.9
  sorts above 2.1.10.

- **The mobile ESC/MODE buttons can be dragged out of the way.** Vertical is a
  free drag, horizontal snaps to the nearer edge, and the position is stored per
  browser as a side plus a ratio of viewport height, so a rotation lands it in
  the same visual place. Settings has a reset that returns them to following
  Claude's input box.

### Fixed
- **The light theme's input box rules and status line are visible again.** Third
  attempt, and the first two failed for the same reason: no such value exists.
  Claude's `light-ansi` theme double-books ANSI 7 — a foreground for the rules,
  a background for the band behind your echoed message — and the two ratios are
  locked together, `contrast(7,bg) x contrast(0,7) == contrast(0,bg)`. Both
  compromises shipped were reported invisible.

  `minimumContrastRatio` works on the rendered pair rather than the palette, so
  ANSI 7 can be dark enough for the rules while the band it also paints is fixed
  at draw time. Measured from rendered pixels: rules 3.73:1 -> 6.39:1.

- **A session open on several devices no longer blinds all but the last to
  join.** Every client forced the shared pty to its own size on join. Claude
  draws its input box and status line at absolute row numbers, so a device with
  fewer rows than the pty never rendered them — measured live at pty 49x250,
  browser 45 rows, input box addressed at row 46 and the status line at row 49.

  The smallest attached client now defines the canvas, the way tmux does it,
  recomputed on join, resize and leave.

## [4.4.0] - 2026-09-04

### Changed
- **Sessions are stored one file per session** — `<data dir>/sessions/<id>.json`
  instead of a single `sessions.json` rewritten in full every thirty seconds.

  That rewrite was quietly destructive with two servers: on 2026-09-03 a restart
  lost its `CCW_DATA_DIR`, the dev instance adopted stable's directory, and both
  rewrote the whole file on their own timers. Last writer won, and nothing
  errored.

  SQLite was tried first and racing two writers against it disproved the
  premise: the conflict was never about write atomicity. `saveSessions(map)`
  means "this is the complete set", so it deletes what it does not recognise —
  and an instance only recognises its own sessions. A transaction just makes the
  deletion atomic. Measured, 30 rounds each:

  | store | sessions left |
  |---|---|
  | single file | 1 of 2 — one silently gone |
  | SQLite | 0 of 2 — both processes died (`database is locked`) |
  | one file per session | **2 of 2** |

  This is how Claude Code itself handles many CLI instances sharing `~/.claude`
  (`sessions/<pid>.json`, one writer per file, aggregate on read), and the same
  shape as this project's own `instances/<port>.lock`.

  Two consequences worth knowing:
  - **Deleting a session is now explicit.** It used to be a side effect of
    rewriting the file without it — the very side effect that let two instances
    erase each other's work.
  - **Expiry is judged per session.** With one file there was a single
    `savedAt`, so one active tab kept every stale sibling alive.

  A corrupt file now costs one session instead of the whole list, and is moved
  aside rather than left to trip the next load. An existing `sessions.json` is
  split on first run and then **left exactly where it is** — reverting this is a
  git operation, not a data recovery.

### Added
- **A second server pointed at an occupied data directory refuses to start**,
  naming the port, pid and directory of the instance already there. This is the
  check that was missing on 2026-09-03. A stale lock from your own crashed run
  is not a conflict — refusing to restart after a crash would be worse than the
  problem.

### Fixed
- `SessionStore` derived its paths in the constructor, so redirecting
  `storageDir` afterwards silently kept writing to the real data directory. A
  test run migrated the live instance's sessions that way. The paths are getters
  now, and the tests set `CCW_DATA_DIR` on a temp dir instead of reaching in.

## [4.3.0] - 2026-09-03

Borrowed from how Claude Code's CLI and its editor extension find each other.

### Added
- **Instance registry.** Each server writes `<data dir>/instances/<port>.lock`,
  with the port as the filename so listing the directory *is* the discovery step.
  The record carries what previously took `/proc/<pid>/cwd`, `/proc/<pid>/environ`
  and `/proc/<pid>/maps` to reconstruct: which checkout the instance runs from,
  which data dir it owns, its version and build id. Removed on clean shutdown;
  a record orphaned by `kill -9` is pruned by the next instance to start.
  Writing it is best-effort — a registry that could refuse to start the server
  would be a worse trade than no registry.
- **`--auth-file <path>` and `CCWEB_AUTH`** as token sources, in that order of
  preference ahead of `--auth`.

### Security
- **The auth token no longer has to travel in argv.** `--auth <token>` lands in
  `/proc/<pid>/cmdline`, which is mode 444 — world-readable — and this is not
  hypothetical on any box with a second account. Measured on the three sources:

  | source | in `cmdline` (444) | in `environ` (600) |
  |---|---|---|
  | `--auth` | yes | no |
  | `CCWEB_AUTH` | no | yes |
  | `--auth-file` | no | no |

  `--auth` still works so no start script breaks; it now prints a note saying
  what it exposes. The lock file that holds the token is created `0600` inside a
  `0700` directory, from the moment it exists rather than by a later `chmod`.

  Default behaviour is unchanged and deliberately so: auth is still on, and
  giving no token still generates one.

### Fixed
- `cc-web --version` reported `3.4.0` regardless of the actual version. It now
  reads `package.json`.

## [4.2.1] - 2026-09-03

### Changed
- **node-pty 1.0.0 → 1.1.0.** Not for speed — for two rotting foundations.
  1.0.0 bound the V8 C++ ABI through `nan`, so every Node major needed the
  native module recompiled, and its read path went through
  `process.binding('pipe_wrap')`, an internal API Node has been deprecating and
  removing for years. 1.1.0 builds on `node-addon-api` (N-API), a stable ABI:
  the compiled `pty.node` went from **30 V8 symbols and 0 N-API symbols** to
  **0 and 40**, and `process.binding` is gone from `unixTerminal.js`.

  The public API did not move: only `useConptyDll` (Windows) was added and
  `write()` widened from `string` to `string | Buffer`. **`claude-bridge.js` is
  unchanged — not one line.**

  1.1.0 does rewrite the plumbing underneath, though: the read side moved from a
  `net.Socket` (`PipeSocket`) to a `tty.ReadStream`, and the write side to its
  own queued stream. Since this app drives `pause()`/`resume()` for WebSocket
  flow control, that path was verified specifically, on both versions.

### Added
- `test/pty-contract.test.js` — locks the terminal-byte-passthrough invariant
  against the library itself. A version bump can rewrite the plumbing under a
  stable-looking API, and only behaviour tests catch that. Covers every API
  `claude-bridge.js` uses (including `on('error')`, which is absent from the
  published typings but relied on here), 5000-line byte fidelity checked
  line-by-line for loss and reordering, resize reaching the child, the
  `pause()`/`resume()` contract, `onExit` after `kill()`, no surviving child,
  and a guard that the build never silently falls back to NAN.

## [4.2.0] - 2026-09-03

### Changed
- **The branch panel and the file explorer now show on a phone.** Both were
  desktop-only, hidden behind the same media query (which also covered touch
  tablets up to 1024px, not just phones). Neither restriction earned its keep:
  "did every repo move to the task branch?" gets asked more often away from the
  desk, and browsing the project's files matters more on a phone, where there is
  no second window to put an editor in. The toolbar on a 390px screen is now
  hamburger / tabs / `+` / branches / files, with no horizontal overflow and the
  tab still clickable.
  - The split-layout button stays hidden on a narrow screen, unchanged. That one
    was never a width guess in CSS — `syncSplitAvailability()` hides it when two
    panes genuinely don't fit.
  - Showing the branch panel exposed a latent overflow: it is 340px wide and
    right-anchored to its own 44px button, which put its left edge at -10px on a
    390px viewport. Below 480px the wrapper drops its positioning so the panel
    anchors to the tab bar instead (already `position: relative` with
    `overflow: visible`), same top, right-aligned to the bar — all 340px back on
    screen at x=40. Above 480px the button-anchored alignment is untouched.
  - `git-branches.test.js` asserted the opposite contract ("hides the panel on
    mobile with the same query as the file explorer") and had to be rewritten; it
    now pins the narrow-screen re-anchor and the tab bar's role in it.

## [4.1.3] - 2026-09-03

### Fixed
- **Creating a session did nothing while the "Start Claude" overlay was up.**
  On a phone: log in, tap `+`, pick a directory — and the screen just sat there
  showing the overlay. Every retry behaved the same, and the server never
  received a single `POST /api/sessions/create`. `#newSessionModal`
  (`.session-modal`) is z-index 2000 and the overlay is 5000, so the Create New
  Session dialog opened *underneath* it: a ghost outline behind a 95%-opaque
  scrim, with every tap landing on `.overlay-content`. Both modals that the
  overlay state can reach are now lifted above it (5004).
  - This was the leftover half of the 4.1.1 fix. That release lifted the two
    paths that *reach* a modal — the tab bar (5001) and the mobile menu (5002),
    plus the folder browser (5003) — but not the modal each path ends in. The
    defect only became reachable once 4.1.1 made the `+` clickable again; before
    that, the overlay swallowed the tab bar and nobody got this far.
  - `.settings-modal` (z-index 1000) was dead the same way: reachable from the
    lifted mobile menu, opening under the overlay. Lifted too.
  - `overlay-stacking.test.js` asserted the stacking contract for the tab bar,
    the mobile menu and the folder browser, and passed the whole time — it never
    named the modals. It does now, for both.

## [4.1.2] - 2026-09-02

Review of 4.1.0-4.1.1. Nine findings, all fixed.

### Fixed
- **One GET could kill the whole server.** `GET /api/git/branches?path=a&path=b`
  ended the process: a repeated query parameter arrives as an Array, `path.resolve`
  throws on it, and `listBranches` was the only `async` handler touching user
  input — Express 4 does not catch a rejected async handler, so it became an
  unhandledRejection and Node 22 exited, taking every live PTY with it. (The
  synchronous `/api/fs/list`, given the same input, answers 500 and lives.) The
  parameter shape is now rejected with a 400, and every async route goes through
  an `asyncRoute` wrapper so a throw ends as a 500. `/api/sessions/persistence`,
  which had the same unguarded shape, is wrapped too.
- **The directory-entry cap silently ate repositories.** 600 plain directories
  ahead of one repo reported `0 repos, truncated 101` — the repo was never
  examined, and 101 counted plain directories that were never candidates. The
  counts are now distinct (`truncated` = repositories dropped, `unexamined` =
  directories never looked at), the cap rose from 500 to 2000 to match
  `listDirectory`'s existing `MAX_ITEMS` (measured 40ms for 2001 entries), and
  the panel now says when a scan was partial instead of looking complete.
- **A slow branch response could repaint over a newer one.** Start a "Check
  changes" on one project, switch tabs, reopen: the fast scan rendered, then the
  slow one landed and drew the old project's branches under the new heading.
  Each load now carries a ticket and only the newest may render.
- **Renaming a tab now persists.** It used to write only into one browser's
  in-memory session map — the tab state in localStorage keeps ids and nothing
  else, so a reload dropped the rename, and it never reached `sessions.json`
  (which has had a `name` field all along) or any other device. New
  `PATCH /api/sessions/:sessionId {name}`, validated and written through.
- **Repeated status scans no longer pile up.** `status=1` forks a git process per
  repository; concurrent requests multiplied that across the shared
  single-threaded server. Scans are now serialised, and a failing scan no longer
  wedges the ones behind it.
- Branch group colours no longer wrap past six, which had handed two different
  branches the same colour — the exact misreading the colouring exists to prevent.
- Removed a dead `checking` field, and documented that `resolveGitDir` follows
  git's `gitdir:` pointer to an absolute path by design.

## [4.1.1] - 2026-09-02

### Fixed
- **The start overlay no longer swallows the whole tab bar.** `#overlay`
  (`.terminal-overlay`) is fixed, covers the full viewport, and sits at
  `z-index: 5000`; the tab bar sat below it. So any time a session was idle and
  the "Start Claude" prompt was up, every tab-bar control was dead: switching
  tabs, double-click rename, new tab, close tab, and all three toolbar buttons.
  `document.elementFromPoint` on the tab name returned `DIV#overlay`. The tab bar
  is app chrome and has nothing to do with what the overlay is gating, so it is
  now lifted above the overlay while the overlay is open.
  - The lift is scoped to `body.overlay-open`. Raising the tab bar
    unconditionally would invert two other stacks — the mobile side menu (3000)
    and the centered folder browser (2000) would fall behind it — so inside the
    scope those two come along above the bar, and outside it the normal stacking
    order is untouched.
  - This also completes a half-finished fix: `#fileExplorerModal` had already
    been lifted to 6000 "so it stays usable before a session is started", but the
    button that opens it was left under the overlay. The drawer was usable and
    unreachable.
- **Renaming a tab no longer throws.** `saveNewName` was bound to both `blur` and
  `keydown`, and replacing the focused input took it out of the DOM, which fired
  `blur`, which ran `replaceWith` again on a node that was no longer there —
  `NotFoundError`, once per rename. It now commits exactly once. Pre-existing;
  the overlay had been blocking the path that reaches it.

## [4.1.0] - 2026-09-02

### Added
- **Branch panel.** A new toolbar button next to the file explorer lists the
  current git branch of every sub-project under the tab's working directory —
  the "one big directory holding a dozen independent repos" layout, where the
  question "did every repo move to the task branch?" comes up constantly and
  the answer used to cost a shell command every time. Repos sharing a branch are
  coloured alike, so the one still sitting on `dev` stands out.
  - Branch names are read straight out of `.git/HEAD`, no `git` process at all:
    11 repos in ~13ms. Worktrees and submodules (whose `.git` is a *file*
    holding `gitdir:`) and detached HEADs are handled.
  - Working-tree state (uncommitted count, ahead/behind) costs a `git` process
    per repo — ~18x more — so it sits behind an explicit **Check changes**
    button and runs with bounded concurrency. Nothing polls on a timer.
  - New read-only endpoint `GET /api/git/branches?path=<dir>[&status=1]`, behind
    the same header auth and the same path policy as `/api/fs/list`.
  - Desktop only, hidden on mobile by the same media query as the file explorer.

## [4.0.0] - 2026-08-31

### Removed (breaking)
- **Codex and cursor-agent support is gone.** 3.20.4 removed their buttons but left
  the whole subsystem wired up and reachable over the WebSocket. `cli-bridge.js`,
  the `start_codex` / `start_agent` messages and their started/stopped events, and
  the `--codex-alias` / `--agent-alias` flags are all removed. This is a
  Claude-only tool now. **Passing `--codex-alias` or `--agent-alias` is now an
  error, not a no-op.**
- **Token-usage analytics removed.** `usage-reader.js` and `usage-analytics.js`
  (~1400 lines) were dead: their only consumer was a display function that
  returned immediately behind ~190 lines of unreachable code. With them go the
  `get_usage` / `usage_update` messages, the per-session usage counters, the
  "Show Token Stats" setting, `docs/ADVANCED_ANALYTICS.md`, and the `--plan` flag
  plus the `CLAUDE_PLAN` / `CLAUDE_COST_LIMIT` / `CLAUDE_SESSION_HOURS` env vars.
  **Passing `--plan` is now an error.** Side benefit: the browser no longer polls
  `get_usage` every 30s, so the server stops re-scanning `~/.claude` transcripts.

### Security
- **The auth token no longer rides a URL that a rendered page can read.** 3.20.5
  started rendering `.html`/`.svg` from the file explorer, but the explorer's URL
  carries the full auth token in its path — so a malicious file could read its own
  `location` and post the token anywhere, and that token grants a PTY on the host.
  Rendering now requires a single-use ticket (`POST /api/fs/ticket`): bound to one
  realpath, 30s TTL, spent on first read. A token URL serves `.html`/`.svg` as
  source, as it did before 3.20.5. Rendered files are additionally sandboxed into
  an opaque origin with `default-src 'none'` and no `allow-popups`; SVG gets no
  `allow-scripts` at all.

### Added
- **Refresh reconciles sessions instead of auto-adopting/creating.** The client now
  persists its tab set (ordered session-ids + active, + dismissed ids) in
  `localStorage['cc-web-tabs']`. On refresh it reconciles against the server: an
  exact match restores the tabs 1:1 (seamless, no prompt, never a stray new
  session); a mismatch (a tab's session is gone, or a session the user hasn't seen
  appeared) opens a picker to choose which sessions to open / delete / start new.
  Dismissed sessions are remembered so they don't re-prompt. Fixes refresh-time
  "new session created / tab shows the wrong content".

### Fixed
- **A failed session-list fetch no longer erases your tabs.** Reconcile treated a
  network error, a 401, or a malformed body as "the server has no sessions" and
  persisted an empty tab set, destroying the tab selection and order for good. It
  now reports the list as unavailable and leaves stored state untouched; a 401
  raises the login prompt like every other request.
- **Start no longer races the session join.** The client sent `join_session` and
  `start_claude` in the same tick, but the server does not serialize its async
  message handler, so the start could overtake the join and come back "No session
  joined". Starts now wait for the join acknowledgement.
- **The start circuit breaker no longer crashes the server on respawn.** The
  phantom-session retry and the resume fallback both call `spawn` from inside a
  PTY event handler, outside the enclosing try — a spawn failure surfaced as an
  uncaughtException. Both are guarded now.
- Session ids are validated as UUIDs before the bridge deletes a transcript or
  recursively removes a `session-env` directory under the user's home.
- Deleting a session from the reconcile picker asked for confirmation twice.
- `Cmd/Ctrl+1` / `Cmd/Ctrl+2` focus the first/second pane by position; after
  swapping panes they used to be backwards. Split state also saves in visual order.
- The file-explorer drawer resizes with pointer events, so it works on touch.

### Changed
- All UI strings are English; the reconcile picker, image-paste toasts and folder
  browser were partly Chinese.

## [3.20.7] - 2026-08-29

### Fixed
- **Stuck sessions self-heal.** A session whose id got registered but empty (an
  interrupted start) used to loop on start/exit or hit the circuit breaker; the
  bridge now clears that empty transcript and retries fresh so the session starts.

## [3.20.6] - 2026-08-29

### Fixed
- **No more start→exit→restart loop on a stuck session.** A session id that can
  neither `--resume` nor be claimed with `--session-id` (a phantom from an
  interrupted start) made Claude exit immediately and the UI kept retrying. A
  server-side circuit breaker now stops after 3 rapid post-start exits and shows a
  clear error (create a new session) instead of looping.

## [3.20.5] - 2026-08-29

### Added
- **Explorer renders HTML/SVG** (sandboxed) instead of showing source, so diagram
  pages open as the rendered page/graphic.

### Fixed
- **Plan links with a `~` path** now resolve (the leading ~ is expanded to home).
- **Split panes match the tab bar order** on entry, so tab labels line up with the
  left/right content.

## [3.20.4] - 2026-08-29

### Changed
- **Swap split panes by reordering tabs** instead of a menu item. Dragging a tab
  now swaps the panes to match the tab order; the redundant 交换左右/交换上下 layout-menu
  item is removed.

## [3.20.3] - 2026-08-28

### Added
- **Swap split panes.** While split, the layout menu offers 交换左右 / 交换上下 to
  swap the two panes' sides. It reorders the DOM nodes (no reconnect) and keeps
  the divider ratio, so content swaps sides while widths stay put.

## [3.20.2] - 2026-08-28

### Added
- **Resizable file explorer.** Drag the left edge of the file drawer to make it
  wider or narrower (clamped 300px..95vw); the chosen width persists.

### Fixed
- **Snappier file rows.** The explorer's rows used `transition: all 0.2s`, so the
  hover highlight faded over 200ms and trailed the cursor, feeling laggy. Now an
  80ms colour-only transition tracks the pointer.

## [3.20.1] - 2026-08-28

### Fixed
- **Clicking a tab while split no longer blanks the panes.** In split mode the
  tab bar routed through the hidden main terminal's `joinSession`; the hidden
  terminal collapses to ~10x5, so joining it resized the shared PTY to 10
  columns and the CLI redrew as garbage. A tab click now routes straight to the
  panes (focus the pane already showing that session, else load it into the
  active pane) and never re-attaches the hidden main terminal.

## [3.20.0] - 2026-08-28

### Added
- **Split-view orientation (left/right + top/bottom).** The split view is now a
  CSS grid whose orientation can be flipped between side-by-side (columns) and
  stacked (rows). A new **Split layout** button in the tab bar opens a
  单屏 / 左右 / 上下 menu; `Ctrl+\` enters a split; drag a tab to the terminal's
  **right** edge for a left/right split or the **bottom** edge for a top/bottom
  split; the divider drags along either axis; the orientation preference persists
  in `localStorage`.

### Fixed
- **Split panes now fill the pane.** The div passed to `terminal.open()` was
  `flex:0 1 auto` and collapsed to the xterm's content height (24 rows), so the
  CLI left the lower half of each pane blank. It now fills the pane height, and
  after any split/resize the pane re-fits and pushes the new `cols/rows` to the
  PTY so the CLI (a full-screen TUI) reflows to fill.
- Entering a split no longer double-attaches the current session (main terminal +
  pane) with two sizes fighting over the PTY resize; closing a split reliably
  rejoins the focused pane's session.
- The Split-layout button icon now matches the other tab-bar action icons in size.

## [3.19.0] - 2026-08-28

### Added
- **Per-session configuration.** Each session (tab) has its own config. Visual settings (font size, theme, Show Token Stats, scroll animation) are stored per session in `localStorage` (a new session inherits the latest default) and applied live when you switch tabs — theme now switches **without a page reload**. Plan directories are per session too (`session.planDirs`, persisted with the session), edited live from Settings via `GET/POST /api/plan-dirs?sessionId=`; the plan link URL carries the session (`/api/plan/<token>/<session>/<path>`) so the allow-list uses that session's working dir + its own plan dirs (plus the global `--plans-dir` base). This supersedes the previous global plan-dirs editing.
- **Plan directories are additive and runtime-editable.** `/api/plan` now serves plans from the union of auto-discovered roots (the current project's `.claude/plans`, always on) **and** configured plan dirs — so a plan link opens whether it's in the project you're working in or an extra directory you registered. The configured list is editable live from Settings (no restart) via `GET/POST /api/plan-dirs` (header auth; POST validates each is a real directory, dedupes, persists to `<dataDir>/plan-dirs.json`; the persisted list wins over the `--plans-dir` seed). Previously `--plans-dir` *replaced* auto-discovery (override), which hid plans from other active projects.
- **Configurable scroll animation.** Settings gains a "Scroll animation" slider (0–200 ms; `0` = instant, no damping) for the desktop terminal, persisted client-side and live-applied to the main terminal and all splits. Mobile stays instant (its touch-momentum handler owns scrolling).
- **File/folder explorer.** The toolbar's Settings gear is replaced by a folder button that opens a read-only, Windows-Explorer-style browser (`file-explorer.js`): navigate folders, and click a file to open it in a new tab. Two endpoints back it — `GET /api/fs/list` (files + folders with sizes; header auth) and `GET /api/fs/file/:token/:file` (serves a file's bytes; browser-nav token exception like `/api/plan`, Content-Type by extension, `.svg`/`.html` served as `text/plain` to avoid same-origin script execution, regular file ≤ 10 MB, realpath-resolved). Settings stays reachable from the hamburger menu.
- **Clickable plan links in the terminal.** Development-plan paths (`…/.claude/plans/*.md`) in terminal output are now clickable and open the markdown in a new browser tab via `GET /api/plan` (e.g. for a browser markdown extension). The endpoint authenticates with a query token (a new-tab navigation can't send a header, like the WebSocket) and strictly allow-lists the resolved real path to a `.md` under a `.claude/plans/` directory inside the base folder or an active session's working dir. Non-ASCII plan filenames use an RFC 5987 `filename*` Content-Disposition.
- **Plan links now render in browser Markdown extensions.** Plan links open at a URL that *ends in `.md`* (`/api/plan/<token>/<encoded-path>` — path as one segment, token in the path, no query string) and the response is served as `text/plain`. Extensions like Markdown Reader trigger on `.md` URLs and can only transform a rendered text page, so the old `/api/plan?path=…&token=…` (URL ended in the token; `text/markdown` got downloaded by Chrome) never activated them. The query form still works for backward compatibility.
- **Configurable plan directory for `/api/plan`.** New `--plans-dir <paths>` flag (comma-separated) and `CCW_PLANS_DIR` env var. When set they *override* the default project `.claude/plans` auto-discovery: only files under the configured directories are served and the `.claude/plans/` path segment is no longer required (so plans can live outside the served project, e.g. in a meta-repo). Path safety is unchanged — realpath containment still blocks `..`/symlink escapes, files must be `.md` ≤ 2 MB, and the query token is still required.

### Fixed
- **Plan links no longer swallow a label prefix.** The `registerPlanLinks` regex began with `[^\s"'`()]*`, so a label glued to the path with no space — e.g. `路径：/…/​.claude/plans/x.md` or `path:/…/plans/x.md` — was captured into the link, making `/api/plan?path=…` a non-existent relative path and 404-ing. The leading segment is now restricted to path-legal ASCII (`[A-Za-z0-9._~/-]`); the tail stays permissive so non-ASCII (Chinese) plan filenames still match.
- **Plan mode approval now works on current Claude versions.** The plan modal was driven by `plan-detector.js`, which scraped terminal output for markers like `## Plan:`/`###`. Current Claude renders plan markdown to styled ANSI, so those markers never appear in the byte stream and the modal silently stopped firing (verified 0/9 markers matched on Claude Code 2.1.218).
- **Plan modal markdown rendering.** The modal's ad-hoc regex mangled fenced code blocks (`` ``` ``) and didn't render `#` headings; plan text was also injected as HTML without escaping. Replaced with `renderPlanMarkdown()` which escapes HTML first, renders fenced code blocks as `<pre><code>` (protected from the inline bold/italic passes), and handles `#`/`##`/`###` headings, inline code, bold, and italics.
- **Rejecting a plan no longer approves it.** The modal sent `y\n`/`n\n`, but current Claude presents plan approval as a menu (❯1. Yes … / 2 / 3) where neither key does anything and the trailing newline selected the default "Yes" — so *both* Accept and Reject approved the plan. Accept now sends Enter (`\r`); Reject sends Escape (`\x1b`), which backs out and stays in plan mode.
- **Test run no longer hangs.** The server constructor registered a `beforeExit` listener that did async I/O and re-armed the event loop forever (plus leaked SIGINT/SIGTERM/beforeExit listeners per instance). Added `ClaudeCodeWebServer.dispose()` to release the auto-save timer and those listeners; tests call it in `afterEach`, and `npm test` now runs with `--exit` as a backstop.

### Security
- **Auth token is no longer accepted in the query string for REST routes.** It leaked into access logs, browser history, and the Referer header. All browser API calls already send the `Authorization` header; the WebSocket keeps its query token (browsers can't set headers on a WS). A `?token=…` in the page URL is now adopted into `sessionStorage` and immediately stripped via `history.replaceState`.
- **Hook relay token moved from argv to the environment.** `bin/cc-hook.js` reads `CCWEB_HOOK_TOKEN` instead of a `--token` flag, so the secret is no longer exposed through world-readable `/proc/<pid>/cmdline`.

### Changed
- Plan detection now uses Claude Code's native hooks. `claude-bridge.js` injects a `PreToolUse(ExitPlanMode)` hook via `--settings`; `bin/cc-hook.js` relays the event (with the full `tool_input.plan`) to the new `POST /api/hooks/:sessionId` endpoint, which broadcasts it to the browser as a `hook_event`. The endpoint authenticates with a per-session token and only accepts loopback callers.

### Removed
- `src/public/plan-detector.js` (185 lines of terminal-scraping regex) and its `index.html` / `service-worker.js` references.

## [3.4.0] - 2025-10-23

### Added
- **VS Code-Style Split View**: New working split view system that actually works!
  - Drag any tab to the right edge of the terminal to create a side-by-side split
  - Each split has its own independent terminal instance and WebSocket connection
  - Resizable divider between splits (drag to adjust width)
  - Keyboard shortcuts: `Ctrl+1`/`Ctrl+2` to focus splits, `Ctrl+\` to close split
  - Close button (X) in top-right of right split
  - Automatic session switching per split
  - Clean state management with localStorage persistence

### Removed
- **Broken panes.js system** (1018 lines of buggy code)
  - Removed complex grid-based tiling that had fundamental design flaws
  - Removed all pane manager code from app.js and session-manager.js
  - Removed tile HTML and CSS (~200 lines)
  - Removed "Add Pane" button from tab bar

### Fixed
- Sessions no longer get lost during split operations
- Panels can now be closed reliably
- Drag and drop now works correctly
- No more orphaned terminal instances
- No more WebSocket connection leaks
- Proper cleanup when closing splits

### Changed
- Simplified from complex N×M grid to simple 2-pane horizontal split
- Each split maintains its own terminal and connection (true independence)
- Split view is opt-in: create by dragging tabs, not auto-enabled
- Cleaner codebase: 400 lines of working code vs 1000+ lines of broken code

### Notes
- This is a complete rewrite of the split/pane system
- Much more reliable and matches VS Code behavior exactly
- All existing functionality (tabs, sessions, single-pane mode) unchanged
- Test suite: 12/12 passing

## [3.3.0] - 2025-10-23

### Fixed
- **Critical**: Fixed syntax error in `server.js` close() method causing improper indentation in agent session cleanup
- **Critical**: Fixed memory leaks in all three bridge files (claude-bridge.js, codex-bridge.js, agent-bridge.js) by properly tracking and clearing kill timeouts
- Fixed race condition in `session-store.js` where atomic rename could fail if directory was deleted between write and rename operations
- Fixed duplicate signal handlers in `server.js` that could cause double-shutdown attempts
- Removed call to undefined method `clearProcessedEntriesCache()` in `usage-reader.js`
- Removed unused `sessionCache` Map variable from `usage-reader.js`
- Added missing test coverage for agent alias in server alias tests
- Fixed test cleanup warnings by ensuring storage directory exists before save operations

### Changed
- Removed token usage top bar from UI - no longer displays real-time token statistics in the header
- Updated `applySettings()` to reflect removal of token stats visibility toggle
- Disabled `updateUsageDisplay()` and `startSessionTimerUpdate()` functions as UI elements no longer exist

### Notes
- All bug fixes are backward-compatible
- Usage statistics backend code still runs but is no longer displayed in the UI
- Test suite passing: 12/12 tests

## [3.2.2] - 2025-10-23

### Fixed
- Fixed loading spinner overlay remaining visible when showing folder browser
- Added proper overlay hiding before showing folder browser in all locations
- Resolves issue where users couldn't interact with folder browser due to stuck spinner

## [3.2.1] - 2025-10-23

### Fixed
- Corrected agent command from `claude-agent` to `cursor-agent` in AgentBridge
- Updated command search paths to use `~/.cursor/` instead of `~/.agent/`

## [3.2.0] - 2025-10-23

### Added
- Cursor Agent (`cursor-agent`) support as a third CLI option alongside Claude and Codex
- New CLI flag: `--agent-alias <name>` to customize the display name for Cursor Agent (default: "Cursor")
- New environment variable: `AGENT_ALIAS` for setting the agent alias
- "Start Cursor" button in assistant selection UI (main overlay and per-pane overlays)
- Full WebSocket message handling for `start_agent`, `agent_started`, and `agent_stopped` events
- Agent session management in `AgentBridge` with automatic command detection

### Changed
- Updated startup logs to display all three assistant aliases (Claude, Codex, Agent)
- Enhanced `/api/config` endpoint to include agent alias
- Extended session management to support three concurrent agent types per session

### Notes
- Backwards-compatible feature addition; existing Claude and Codex functionality unchanged
- Agent bridge searches for `cursor-agent` in standard paths (~/.cursor/local/cursor-agent, ~/.local/bin/cursor-agent, etc.)
- No special CLI flags required for agent (unlike Claude's `--dangerously-skip-permissions` or Codex's bypass flag)

## [3.1.0] - 2025-09-15

### Added
- Middle-click tab closing, inline rename styling, and automatic scroll-into-view for the active session tab to mirror VS Code ergonomics.

### Changed
- Session tabs now maintain explicit order and MRU history, improving Ctrl/Cmd+Tab navigation, drag reordering, and pane targeting parity with VS Code.
- Mobile overflow counters and menus refresh automatically on resize or drag, keeping hidden sessions reachable across devices.

### Fixed
- Tabs now disappear immediately when the backend deletes a session, preventing stale entries and redundant DELETE calls.

## [3.0.3] - 2025-09-14

### Fixed
- Single-pane and no-session states now use the full viewport width. Moved the global overlay out of the terminal container and made it `position: fixed` to prevent it from reserving layout space; ensured `.tile-grid` flexes to fill available width. This resolves the issue where, with zero tabs or a single pane, the pane did not span the full width.

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.10.0] - 2025-09-13

### Added
- Tiled View (MVP): view two sessions side‑by‑side with independent terminals and sockets.
- Resizable splitter between panes with persistent split position.
- Per‑pane session picker and close controls; layout and assignments persist in localStorage.

### Changed
- Settings font size now applies to all visible panes in tiled view.

### Notes
- Client‑side only; no server/CLI changes required. Default remains single‑pane; toggle via new tile button in the top bar.

## [2.9.0] - 2025-09-13

### Added
- Theme toggle in Settings with persistence (Dark/Light).
- Early theme application to avoid flash of incorrect theme on load.

### Changed
- Default theme set to Dark; Light can be selected in Settings.

### Notes
- UI-only change; no server/CLI APIs modified.

## [2.8.0] - 2025-09-13

### Added
- Inline SVG icon system across the UI to replace emojis for a premium, minimalist look.
- New icon helper at `src/public/icons.js` for consistent, dependency‑free icons.
- Subtle status indicators using CSS dots (active/idle/error) in place of emoji glyphs.

### Changed
- Refined visual design: cohesive light palette by default, improved spacing and rhythm, and cleaner typography (Inter for UI, JetBrains Mono for terminal/stats).
- Usage rate display now uses an icon + text rather than emoji; improved readability on mobile/desktop.
- Plan modal header and action buttons now include icons; tooltips and labels simplified.
- Notifications and headings no longer use emojis; copy updated for a professional tone.
- Auth prompt UI aligned with the new palette and iconography.

### Fixed
- Prevented potential null‑element errors in plan mode indicator updates.

### Notes
- No API or CLI changes. Dark theme variables remain; switch by removing `data-theme="light"` or adding a toggle.

## [2.5.0] - 2025-08-22

### Added
- ngrok tunnel integration with `--ngrok-auth-token` and `--ngrok-domain` CLI options
- Public tunnel support for remote access to Claude Code Web interface
- Enhanced shutdown handling to properly close ngrok tunnels
- Input validation to ensure both ngrok flags are provided together

### Changed
- Improved auto-open behavior to use ngrok public URL when tunnel is active
- Enhanced error handling for ngrok tunnel establishment

### Dependencies
- Added `@ngrok/ngrok` package for tunnel functionality

## [2.4.0] - 2025-08-22

### Added
- Custom command modal for multi-line message input via "Custom..." option in commands dropdown
- Keyboard shortcut (Ctrl/Cmd + Enter) to run custom commands from the modal
- Enhanced commands dropdown interface with better user experience

### Changed
- Commands menu button repositioned from floating to anchored within terminal container
- Improved commands menu positioning and z-index handling for better integration

## [2.3.0] - 2025-08-22

### Added
- Commands menu with floating "/" button in top-right corner
- Commands API for listing and serving markdown files from ~/.claude-code-web/commands directory
- Interactive dropdown interface for browsing and executing commands
- Support for nested command directories with automatic label generation
- Command content execution directly to active Claude/Codex session

### Changed
- Enhanced user interface with new commands functionality
- Improved accessibility with dedicated commands directory structure

## [2.2.2] - 2025-08-20

### Changed
- Updated Claude Code CLI flag from `--dangerously-skip-permissions` to `--dangerously-bypass-approvals-and-sandbox`
- Updated UI text and tooltips to reflect new flag name
- Updated loading messages to match new CLI flag terminology

## [2.2.1] - 2025-08-20

### Changed
- Improved start button layout and responsive design
- Simplified button styling for better mobile experience
- Increased dialog max-width from 400px to 520px for better button layout

### Fixed
- Mobile responsiveness issues with assistant selection buttons

## [2.2.0] - 2025-08-20

### Added
- Basic test infrastructure with Mocha and unit tests

### Fixed
- Command injection vulnerability in commandExists method
- Documentation discrepancy - added missing auth.js file to README structure

### Security
- Fixed command injection vulnerability that could potentially allow malicious command execution

## [2.5.1] - 2025-08-22

### Added
- CONTRIBUTING guide with setup, testing, and PR workflow
- MIT LICENSE file

### Changed
- Enhanced README with requirements, local dev/testing instructions, and links to CONTRIBUTING and LICENSE

## [2.5.2] - 2025-08-22

### Added
- GitHub Pages single-page marketing site under `/docs` (hero, features, quick start, security, FAQ)

### Notes
- No runtime or API changes; documentation/website only

## [2.5.3] - 2025-08-22

### Changed
- Docs site: replaced HTTPS guidance with accurate ngrok options

### Fixed
- Docs site: improved mobile responsiveness and removed horizontal scrolling

## [2.1.3] - Previous Release
- Previous version baseline
## [2.6.1] - 2025-08-29

### Added
- Assistant alias support across CLI, server, and UI.
  - New CLI flags: `--claude-alias <name>` and `--codex-alias <name>`.
  - New env vars: `CLAUDE_ALIAS`, `CODEX_ALIAS`.
  - `/api/config` now returns `aliases` for the frontend.
- UI now displays configured aliases in buttons, prompts, and messages.
- Tests: added `test/server-alias.test.js` to validate server alias configuration.

### Changed
- Startup logs show configured aliases.
- README updated with alias usage examples.
## [2.11.0] - 2025-09-13

### Added
- Up to 4 panes in Tiled View with an “Add Pane” control.
- Drag a tab onto any pane to attach that session to the pane.

### Changed
- Tiled layout now distributes widths dynamically across multiple panes; resizers adjust neighboring pane widths.

### Notes
- Client-side only; no server/CLI changes. Defaults to single‑pane; toggle and expand via the top‑bar grid/plus controls.
## [2.12.0] - 2025-09-13

### Added
- Per‑split tab bars (VS Code–style): each pane now has its own tab strip.
- Add tab per split (+ button) and attach existing sessions to a split by clicking global tabs while a pane is focused.
- Drag a global tab into a split to add/activate that session in the target pane.

### Changed
- Tiled view routing: in tiled mode, global tab clicks target the focused split; single‑pane behavior unchanged when tiles are off.

### Notes
- Client‑side feature; no API/CLI changes. State (pane tabs, active tab, widths) persists locally.

## [2.13.0] - 2025-09-13

### Added
- Close Pane control: remove a split entirely (sockets cleaned up, layout reflows); clears when only one pane remains.

### Changed
- Removed focused‑pane border highlight for a cleaner look.
- In tiled mode, the global top tab bar is hidden; manage tabs per split only.
- Pane removal re-normalizes widths and rebuilds grid for consistent resizing; state persists.

### Notes
- UI‑only changes; no server/CLI surface changes.
## [2.14.0] - 2025-09-13

### Changed
- Always-on multi‑pane mode: the tiled view is now the default and only mode.
- Global top tab bar is hidden in multi‑pane; manage tabs per split.
- Removed tile view toggle button.

### Fixed
- Pane “+” button now opens a reliable session picker menu and works in every pane.

### Notes
- UI/UX change only; no server/CLI API changes.
## [2.15.0] - 2025-09-13

### Added
- Drag a pane tab to the grid’s right edge to create a new split and move the tab (VS Code‑like “drag to split”).

### Changed
- Pane tab items are now draggable between splits; dropping on another split moves the tab there.
- Pane Add Tab button opens a session picker menu consistently across panes.

### Notes
- UI‑only; no server/CLI changes.
## [2.15.1] - 2025-09-13

### Fixed
- Start‑prompt (Claude/Codex) overlay now appears in multi‑pane mode: terminal container is kept available for overlays even when panes are active.
## [2.16.0] - 2025-09-13

### Added
- Per‑pane start prompt overlay: when a session is attached to a pane and hasn’t produced output yet, the pane shows a local dialog to pick the assistant (Claude/Codex), including dangerous variants.

### Changed
- Overlays no longer rely on the single‑pane terminal; the per‑pane overlay sits within each split.

### Notes
- UI‑only; no server/CLI changes.
## [2.17.0] - 2025-09-13

### Changed
- Closing a pane tab now fully closes the session (server DELETE), removes it from all panes, and cleans up sockets/terminals.
- Pane “+” button opens the folder picker directly to create a new session; session dropdown removed.
- Session deletion events now remove the session from all pane tab strips automatically.

### Notes
- UI/behavior change only; no server/CLI API changes.

## [2.18.0] - 2025-09-13

### Added
- Tab context menus for both global tabs and per‑pane tabs:
  - Close Others
  - Split Right
  - Move to Split (choose destination split)
- Drag‑to‑split in all directions (left/right/top/bottom) with visual drop hints.
- Ctrl/Cmd‑drag to copy a tab to another split; default drag moves the tab.

### Changed
- Vertical splits supported (up to 2 rows) with a horizontal resizer; sizes persist.
- Edge‑of‑grid drops create splits on that edge; drag cursor reflects copy vs move.
- Layout persistence now includes rows, cols, and heights in `cc-web-tiles`.

### Notes
- UI‑only features; no server/CLI API changes.

## [3.0.0] - 2025-09-13

### Removed
- Custom prompts dropdown UI ("/" button, commands list, and "Custom…" modal).
- Server endpoints `GET /api/commands/list` and `GET /api/commands/content`.

### Breaking Changes
- The commands dropdown system and its APIs are no longer available. Any external automation calling `/api/commands/*` must be migrated to send content directly to the active session via WebSocket input.

### Migration Notes
- To send predefined prompts, store them in your own UI or scripts and paste/send directly to the terminal. The app will forward input to the active session as before.

## [3.0.1] - 2025-09-13

### Fixed
- Remove an empty left column gap in tiled mode by hiding the single-pane container when tiles are enabled.
- Restore per-pane assistant chooser overlay by not treating 'idle' sessions as already running.

## [3.0.2] - 2025-09-13

### Fixed
- Stabilize tiled splitting: correct index math and use insertion helpers for columns/rows.
- Reattach active sessions to terminals after grid rebuilds so sessions no longer appear to vanish.
- Honor copy vs move when dragging tabs between splits and avoid removing from the wrong source pane.
- Improve edge-of-grid splits to consistently place the tab into the intended new split.
## [3.0.4] - 2025-09-14

### Fixed
- Restore VS Code-style tab workflow: global tabs are visible in both single and tiled modes; selecting a tab targets the active pane.
- Make tiled panes optional again (no auto-enable on load); preserve pane layout and assignments across refresh via localStorage.
- Pane “+” opens a reliable session picker (Shift+click opens folder browser to create a new one).
- When attaching an existing session to a split, replay recent output buffer so tabs don’t look like “new” empty sessions.
- Remove CSS that hid tabs in tiled mode; panes fill width without interfering with the tab bar.
