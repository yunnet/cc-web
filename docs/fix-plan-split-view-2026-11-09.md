# 修复计划：分屏与「每个标签一个终端」脱节（2026-11-09）

分支：`feat413`（`cc-web-dev`），在开发实例 32353 上做和验证；32352 不动，合并部署由用户决定。
用户 2026-11-09：「检查当前的分屏功能，是否有问题」→「好，在 cc-web-dev 里修，先写计划，再评审，再开发」。

## 0. 根因

主终端已经改成「每个标签一个终端、一条 socket」（`app.views`、`showSession`、`openViewSocket`），
`splits.js` 进出分屏仍然用旧的单 socket 接口：进入时 `app.leaveSession()`，关闭时 `app.joinSession(id)`。
这两个调用作用在「当前视图」的 socket 上，于是会话和视图串了。

## 1. 已确认的问题

| # | 问题 | 证据 |
|---|---|---|
| P1 | 关闭分屏时聚焦的是 B 窗格 → `joinSession(B)` 在 A 视图的 socket 上发 join，`views` 里键为 A 的视图从此挂在 B 上；点 A 标签显示 B、输入进 B；会话 A 没人看。刷新前一直错 | 32353 实测：`views: [[f446→fa4e],[fa4e→fa4e]]` |
| P2 | 即使回到 A，`joinSession` 也会 reset+回放，滚动历史丢掉（正是 per-tab 视图要消灭的） | 代码：`session_joined` 分支 `reset()` |
| P3 | 进分屏后 `currentClaudeSessionId` 为 null：`focusSplit(1)` 先设成 B，随后 `leave_session` 的回执 `session_left` 把它清空；再点已聚焦的窗格因 `focusSplit` 早退也救不回 | 32353 实测 `s1.cur / s2.cur = null` |
| P4 | 分屏时工具栏 ESC、Shift+Tab 切模式、→ 键、粘贴图片后插入路径、计划弹窗的拒绝，都走 `this.socket`（已离开会话的主视图），服务器丢弃 | 代码：`app.js` `sendEscape/switchMode/sendRightArrow/uploadAndInsertImage/rejectPlan` |
| P5 | 粘贴/拖入图片只绑在 `#terminal` / `#terminalContainer`，分屏窗格里粘贴图片不会上传 | 代码：`setupImagePaste` |
| P6 | 窗格不处理 `session_deleted`、`claude_stopped`、`claude_hibernated`、`info`（not running）。关闭一个在窗格里的任务，窗格还挂着已删会话；别处删除的会话若只在窗格里打开，标签也不会关；在窗格里新建任务（`pendingStart`）或会话没在跑时，窗格不启动 Claude | 代码：`Split.handleMessage`；`closeSession` 不通知分屏 |
| P7 | 任何视图收到 `session_joined` 都会调 `splitContainer.onTabSwitch(id)`；分屏中后台视图重连（断网、服务重启）会把它的会话塞进聚焦窗格 | 代码：`app.js` `session_joined` |
| P8 | （与分屏相关的后台问题）`claude_stopped` 不看 `forActive`：后台标签的 Claude 停了，会在当前画面上弹 Start 面板。`exit` 已经按 `forActive` 拦了，这里漏了 | 代码对比 `case 'exit'` |

## 2. 修法

### 2.1 进入分屏：主视图变成普通后台视图（修 P1 P3，配合 P7）
`createSplit` 不再 `leaveSession`，改为新方法 `app.parkActiveView()`：
- `sendOn(activeView, {type:'detach_size'})` 撤回尺寸票（服务器 `detachClientSize`，SPLIT-14 要防的 PTY 被压小照样防住）；
- 去掉该视图的 `active` 类，`adoptView(idleView)`。

于是 A 视图和其他后台标签完全一样：保持连接、继续积累滚动历史、`forActive` 为 false，不会在分屏背后弹面板或自启动。
`currentClaudeSessionId` 不再被 `session_left` 清掉；由 `focusSplit` / `onTabSwitch` 维护。
`createSplit` 改为在挂好两个窗格后直接把当前会话设为聚焦窗格的会话（不依赖 `focusSplit` 是否早退）。

### 2.2 关闭分屏：走 showSession（修 P1 P2）
`closeSplit({ rejoin = true } = {})`：
- 先断开窗格、清空、`enabled=false`、显示主容器；
- `rejoin` 时目标 = 聚焦窗格的会话，否则另一个窗格，否则 `currentClaudeSessionId`；
  有标签管理器则 `sessionTabManager.switchToTab(id)`（标签高亮、侧边栏、`showSession` 一起走），否则 `app.showSession(id)`。
  已有视图直接显示，不回放；`showSession` 末尾重新上报尺寸，补回进入时撤掉的那票。
- 删除 `joinSession` / `connect` 回退。

### 2.3 工具栏按键发往聚焦窗格（修 P4）
`app.js` 新增 `inputSocket()`（分屏时 = 聚焦窗格的 socket，否则 `this.socket`）和 `sendInput(data)`。
`sendEscape / switchMode / sendRightArrow / uploadAndInsertImage / rejectPlan`（以及 `acceptPlan` 若同样直发）改用它；
`sendRightArrow` 的 DECCKM 判断、`sendEscape` 的回焦改用 `currentTerminal()`。

### 2.4 窗格也接图片（修 P5）
把 `setupImagePaste` 里的粘贴/拖入处理抽成 `wireImageInput(pasteEl, dropEl)`，主终端照旧调用一次，
`SplitContainer.createSplitElements` 对 `splitContainerEl` 再调用一次。只拦含图片的粘贴、只接文件拖入（TERM-40 不变）。

### 2.5 窗格补齐消息（修 P6）
`Split.handleMessage` 新增：
- `session_joined` 且 `!msg.active`：`app.pendingStart` 存在时用它的选项并清空，否则写提示并用 `startDefaultsOptions()` 启动——与主视图同一规则（2026-10-28）。启动经窗格自己的 socket 发 `start_claude`（带 `uiTheme` 和窗格尺寸）。
- `info` 含 `not running`：同上用默认选项启动。
- `claude_stopped`：停转球、写「Claude stopped」。
- `claude_hibernated`：写与主视图相同的灰字说明、标签设 idle、记 `hibernated`；聚焦窗格时（`focusSplit`，或已聚焦且页面可见时立即）用默认选项恢复。
- `session_deleted`：若标签还在，`sessionTabManager.closeSession(id, {skipServerRequest:true})` 并 toast（与主视图相同文案）。

`SessionTabManager.closeSession` 在 `disposeView` 之后调用 `splitContainer.onSessionClosed(id)`：
窗格里有这个会话就收起分屏——关的是聚焦窗格则 `closeSplit({rejoin:false})`（随后 `closeSession` 自己的 `switchToTab(fallback)` 负责显示），
否则 `closeSplit()` 回到聚焦窗格的会话。避免两个 `showSession` 并发。

### 2.6 去掉 session_joined → onTabSwitch（修 P7）
标签切换一律经过 `switchToTab → onTabSwitch`，`session_created` 也走 `switchToTab`，这条旁路只在旧单 socket 时代有用。删除。

### 2.7 claude_stopped 按 forActive 拦（修 P8）
写到该视图自己的终端；只有 `forActive` 才弹 Start 面板，与 `exit` 一致。

## 3. 不在本次范围
- 窗格里 ExitPlanMode 的计划弹窗（窗格的 `hook_event` 只交给标签管理器）——原来就没有，不是回归，记为 GAP 由用户定。
- 标签切进窗格时窗格会回放（不像主视图保留历史）——设计限制，不改。

## 4. 功能清单（FEATURES.md）
不删除、不削弱任何条目。改写措辞：
- SPLIT-13：关闭分屏后回到聚焦窗格的会话，该会话已有的终端直接显示、不回放，滚动历史保留。
- SPLIT-14：进入分屏时主终端撤回尺寸（不再离开会话），继续在后台接收输出。
新增条目（或并入 SPLIT-09/10）：分屏时工具栏 ESC / 模式切换 / → / 粘贴图片作用于聚焦窗格；窗格里会话未运行时自动启动、休眠后聚焦恢复、被删除时收起分屏。
`ws-client:splits.js:*` 新增的消息类型要在清单里登记（`test/features.test.js` 会要求）。

## 5. 测试
新增 `test/split-views.test.js`（源码断言 + vm 抽函数，风格同 `session-views.test.js` / `feature-guards.test.js`）：
1. `createSplit` 不调用 `leaveSession`，调用 `parkActiveView`；`parkActiveView` 发 `detach_size` 并 `adoptView(this.idleView)`。
2. `closeSplit` 不调用 `joinSession` / `connect`，经 `switchToTab` 或 `showSession`。
3. `session_joined` 分支不再调用 `onTabSwitch`。
4. `inputSocket()`：vm 里构造分屏开/关两种 app，返回聚焦窗格 / 主 socket；五个按键方法不再出现 `this.send({ type: 'input'` / `this.socket.send(`。
5. `Split.handleMessage` 处理 `session_deleted / claude_stopped / claude_hibernated / info`；`closeSession` 调用 `onSessionClosed`。
6. `claude_stopped` 的 `showOverlay` 受 `forActive` 约束。
已有测试全绿：`npm test`。

## 6. 浏览器验证（32353）
1. A、B 两个标签，开左右分屏，`currentClaudeSessionId` 为聚焦窗格的会话（非 null）。
2. 聚焦 B，关分屏 → 显示 B；切 A → A 视图的 `sessionId` 是 A，滚动历史还在（行数不少于分屏前）。
3. 聚焦 A 关分屏 → A 不回放（buffer 行数不减）。
4. 分屏中按工具栏 ESC：用 socket 发送记录确认发到聚焦窗格的 socket。
5. 分屏中断开再连一个后台视图的 socket（`view.socket.close()` 触发重连路径若有）→ 聚焦窗格不被替换。
6. 不在 32353 上删除用户会话；`session_deleted` / 关闭标签路径只用单测覆盖，或在临时实例（`CCW_DATA_DIR` 临时目录、端口 32354）上测。

## 7. 收尾
CHANGELOG `[Unreleased]` 加 Fixed；版本号随用户下次 release 决定，本次不 bump。提交由用户要求时再做。

## 8. 评审结论与修订（2026-11-09，独立评审，只读代码）

核心思路（停放主视图 + 关闭时走 switchToTab/showSession）成立。采纳以下修订，开发按修订后的方案做：

| # | 评审意见 | 处理 |
|---|---|---|
| R1 | 视图 socket 断了不会重连；停放期间服务重启/断网，关分屏回到的是死终端（旧 joinSession 路径还会 connect） | `showSession`：已有视图的 socket 不是 OPEN/CONNECTING 时重新 `openViewSocket`（接受一次回放）。§6 第 5 条（重连劫持窗格）因此不存在该路径，改为只靠单测断言删除了 onTabSwitch 调用 |
| R2 | `view.hibernated` 不会在 `claude_started` 清掉；窗格恢复后，回到主视图会再次 start → "already running" 错误面板、标错标签 | `claude_started` 清该视图的 `hibernated`；`resumeHibernated` 在标签状态已是 active 时跳过 |
| R3 | 计划弹窗不按 forActive 拦，后台/停放视图也会弹，批准/拒绝却发到当前 socket——可能把回车发进别的会话（后台标签本来就有此问题）。窗格和停放视图都调 `hookEvent`，通知会重复 | 计划弹窗记住 `message.sessionId`，批准/拒绝经 `socketFor(sessionId)`（该会话的视图或窗格 socket）发送；窗格在 `app.views.has(sessionId)` 时不再调 `hookEvent`（由视图负责）。§3 里"窗格计划弹窗不在范围"作废：窗格会话若没有主视图，窗格也把 ExitPlanMode 交给 `app.showPlanModal` |
| R4 | 新标签 socket 还在打开时进入分屏，`showSession` 在 await 之后又上报尺寸，补回了刚撤掉的票 | `showSession` await 之后 `if (this.activeView !== view) return;` |
| R5 | `onSessionClosed` 用 `rejoin:false` 时，回退标签来自 tabHistory，可能不是剩下的窗格；聚焦窗格≠activeTabId 时会停在空白 idleView | 一律 `closeSplit({ target: 另一个窗格的会话 })`；`switchToTab` 在第一个 await 前就改了 activeTabId，所以 closeSession 自己的回退会跳过，不会并发 |
| R6 | 两处自动启动可能竞态（服务器 `session.active` 在多个 await 之后才置位），第二个以 error 面板收场 | 服务器 `startClaude` 加同步 `session.starting` 标志，进行中的第二次启动静默忽略 |
| R7 | 图片上传先取 `currentClaudeSessionId`、await 后再取 `inputSocket()`，焦点可能已变；拖到未聚焦窗格却发给聚焦窗格 | `wireImageInput` 接受"事件所在终端"的解析函数；上传前一次性取定 sessionId 和 socket |
| R8 | 心跳只 ping `this.socket`，分屏时它是 null，窗格和停放视图没有保活 | 心跳对所有视图 socket 和窗格 socket 发 ping |
| R9 | `claude_started` 用 `currentClaudeSessionId` 标状态、无条件 hideOverlay | 用 `view.sessionId`；hideOverlay 只在 forActive；`Split` 增加 `claude_started` 更新自己的标签 |
| R10 | 分屏期间改主题/字号不作用到停放视图 | `applySettings` / `applyTheme` 遍历 `this.views` |
| R11 | splits.js 新增的每个 `case` 都是 `ws-client:splits.js:<type>` 入口，必须登记 FEATURES.md；`pendingStart` 记录会话 id，只有加入该会话的窗格使用 | 照做 |

## 9. 开发结果（2026-11-09）

按 §2 + §8 修订实现，R10 只做了主题（字号按会话各自设置，本来就不跨标签同步，不改）。

- 单测：新增 `test/split-views.test.js` 19 条全过；`claude-title`、`new-tab-dialog` 两条守卫的正则放宽为接受新写法（仍要求 ExitPlanMode 打开计划弹窗、pendingStart 在 attachSessionTab 之前设好）。
- 全量 `npm test`：859 通过、9 失败；这 9 条在 HEAD 上同样失败（Windows 建符号链接 EPERM、skills 相关，基线 HEAD 为 10 失败，多一条偶发 ClaudeBridge），与本次无关。
- 32353 实测（重启后新代码）：
  - 进分屏后 `currentClaudeSessionId` = 聚焦窗格会话，主视图停放（idleView 在前台，A 视图 socket 仍 OPEN、仍挂 A）。
  - 工具栏 ESC 发到聚焦窗格的 socket。
  - 聚焦 B 关分屏 → 显示 B；`views` = `[[B→B],[A→A]]`；切回 A 是同一个视图，行数 2103 → 2112（停放期间继续接收，没有回放清空）。
  - 上下分屏、聚焦 A 关闭 → 回到 A 视图，尺寸 170×43 与分屏前一致，只有一个 active 视图。
- 未在浏览器测：关闭/删除窗格里的任务、分屏时新建任务的自动启动、休眠恢复——会删改 32353 上的会话，由单测覆盖。

## 10. /code-review 结果与处理（2026-11-09）

| # | 发现 | 处理 |
|---|---|---|
| 1 | 窗格 `info`（not running）不看是否聚焦/休眠，xterm 自动发的焦点报告 ESC[O 会把休眠或手动停掉的会话拉起来 | 窗格输入像主视图一样过滤 ESC[I/ESC[O；`info` 只在聚焦且未休眠时启动 |
| 2 | 开分屏时窗格重新 join，`!active` 就自动启动——会把刚手动停掉的会话重启 | 页面里已有该会话视图时不自动启动（休眠的继承 hibernated，聚焦恢复）；只有 pendingStart 或从未打开过的会话才启动 |
| 3 | `views.has` 就丢 hook_event，视图 socket 断了以后计划/权限提醒全丢 | 只有视图 socket 是 OPEN 时才让给视图 |
| 4 | 窗格的 hook_event 只抄了一半（缺权限卡片、turn rail） | 抽出 `app.handleHookEvent(msg, sid)`，主视图和窗格共用 |
| 5 | `inputSocket(sid)` 找不到时返回 null，图片/计划回答丢了还提示成功 | 无标签旧路径回退到当前 socket（同一会话时）；发不出去时图片提示失败、计划弹窗不关并提示 |
| 6 | 第二个 start 被静默丢掉，第一个失败时第二个永远没回音 | 服务器记录所有请求方，失败时逐个回错误 |
| 7 | 图片拖到空窗格会落到另一个窗格的会话 | 空窗格返回 null，拒绝上传 |
| 8 | 窗格和后台视图都更新标签状态 | 幂等，不改 |
| 9 | 三处各自写 readyState+send | 统一为 `sendOnSocket` |

测试：`test/split-views.test.js` 增至 25 条；`claude-title` 两条守卫改为检查 `handleHookEvent`。全量 865 通过，9 条失败与 HEAD 相同（Windows 符号链接/skills 环境问题）。32353 重启后复测主流程通过。
