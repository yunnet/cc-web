# 修复计划：分屏时每个窗格各有自己的「回到最新」按钮（2026-11-09）

分支：`feat413`（`cc-web-dev`），在 32353 上做和验证；32352 不动。
用户 2026-11-09：「当向上翻行，右下方会显示一键到光标行。现在问题是，当是分屏时，各屏有没有正常显示各屏的」→ 看了实测结果后「好，按这个方案改」。

## 0. 实测（32353，左右分屏，聚焦右屏）

| 操作 | 按钮 | 问题 |
|---|---|---|
| 向上翻**未聚焦**的左屏（滚轮不改聚焦） | 不出现 | 翻上去了没有按钮 |
| 向上翻聚焦的右屏 | 出现在页面右下角 | 正常 |
| 右屏回到底部，左屏仍在上面 | 消失 | 左屏没回到底部 |
| 点左屏让它聚焦 | 出现，但在页面右下角，也就是**右屏**里面 | 看着像右屏的，点了作用于左屏 |

原因：页面只有一个 `#scrollBottomBtn`（`position: fixed`，页面右下角），`updateScrollBottom(term)` 只认 `currentTerminal()`（聚焦的窗格）。

## 1. 改法

### 1.1 每个窗格自带按钮（splits.js）
- `Split.createTerminal` 建一个按钮 `.scroll-bottom-btn.pane-jump-btn`（同一个图标，`title="Jump to latest"`，初始 `hidden`），挂在窗格容器 `.split-pane` 里（它已经是 `position: relative`）。
- `Split.updateJump()`：本窗格 `baseY - viewportY > 0` 就显示，否则隐藏；只在状态变化时改 DOM（和主按钮一样）。终端的 `onScroll` / `onRender` 改为调用它，不再调 `app.updateScrollBottom`。
- 点击：本窗格 `scrollToBottom()`、`terminal.focus()`、`updateJump()`；点击会冒泡到窗格的 click，顺带聚焦这个窗格（期望行为）。
- `closeSplit` 清空窗格时调用 `updateJump()`（终端已清空，按钮随之隐藏）；容器本身也会被隐藏。

### 1.2 主按钮只管单屏（app.js）
- `updateScrollBottom(term)`：分屏开着时把全局按钮隐藏并返回。
- `refreshScrollBottom()`：分屏开着时隐藏全局按钮，并让每个窗格 `updateJump()`；否则照旧。
- `currentTerminal()` 不变（ESC / → 等还要用它）。

### 1.3 不压住悬浮按钮
- 窗格按钮在窗格内 `position: absolute; right: 16px; bottom: 16px;`；手机/触屏下 44px（沿用现有媒体查询的尺寸）。
- 贴着页面右边的窗格（左右分屏的右屏、上下分屏的两个屏）会和右侧悬浮按钮组 `#modeSwitcher`（ESC/MODE/→，可拖动）以及 PWA 安装按钮 `#installBtn` 重叠。显示时由 `app.keepPaneJumpClear(btn)` 测量：先复位，再看是否与这两个元素（可见时）的矩形相交，相交就向左移到它们左边 8px。

## 2. 功能清单
TERM-33 改写为：单屏时页面右下角一个按钮作用于当前终端；**分屏时每个窗格右下角各有一个，只看自己翻没翻上去，点哪个回哪个**，避开右侧悬浮按钮与安装按钮；手机上更大。只增强，不删功能。若 `scripts/feature-surfaces.js` 把 splits.js 里新建的按钮识别为 `js-control`，在 TERM-33 的入口里登记。

## 3. 测试
- `test/feature-guards.test.js` 里「分屏时答聚焦窗格」那条改为：分屏时全局按钮隐藏。
- 新增（放 `test/split-views.test.js`）：vm 里构造 Split，假终端 `buffer.active.baseY/viewportY`，验证 `updateJump` 显示/隐藏只看本窗格；点击按钮滚动本窗格；`onScroll/onRender` 接的是 `updateJump`。
- `keepPaneJumpClear`：给定相交的障碍矩形，按钮被移到其左侧；不相交不动。

## 4. 浏览器验证（32353）
左右、上下分屏各一次：只翻未聚焦的屏 → 该屏右下角出现按钮、另一屏没有；两屏都翻 → 两个按钮；点左屏按钮 → 左屏到底、右屏不动；右屏按钮不压 ESC 悬浮按钮；关分屏后单屏按钮照旧。

## 5. 评审结论与修订（2026-11-09，独立评审）

方向成立，以下全部采纳：

| # | 意见 | 处理 |
|---|---|---|
| 1 | `feature-guards.test.js:299` 要求窗格接 `app.updateScrollBottom`，`split-views` 的假窗格没有 `updateJump` | 守卫改为断言接 `updateJump`；调用处写 `split.updateJump && split.updateJump()`，`updateJump` 内先判 `jumpBtn` |
| 2 | 开分屏时 `focusSplit` 可能早退，全局按钮留在屏上 | `createSplit` 置 `enabled = true` 后显式 `app.refreshScrollBottom()` |
| 3 | 避让只在显示瞬间算一次 | 新增 `app.reclearPaneJumps()`，挂到 FAB 位置变化（`applyFabPosition`）、`scheduleRefit` 回调（覆盖窗口缩放、拖分隔条、换方向、交换窗格）、安装按钮出现/消失 |
| 4 | 算法要写清、防出界、两个窗格都查 | 换算到窗格坐标；与 `#installBtn`、`#modeSwitcher` 相交就**向上让**到其上方 8px，最高不超出窗格；两个窗格都检查 |
| 5 | CSS 优先级 | 新规则 `.split-pane > .scroll-bottom-btn` 只写 `position/right/bottom/z-index`，不写宽高和 display，手机 44px 与 `[hidden]` 照常生效 |
| 6 | z-index 900 太高 | 窗格内用 20（高于 xterm 与 `.split-close` 的 10） |
| 7 | 一定会被识别成 `js-control:splits.js:Jump to latest` | TERM-33 入口登记；按钮加 `aria-label` |
| 8 | `Split.clear()` 也要刷新 | 加 `updateJump()` |

## 6. 开发结果（2026-11-09）

按 §1 + §5 实现。浏览器复测时发现一处计划没覆盖的：悬浮按钮默认跟着输入框走（`positionModeSwitcher`），它移动时窗格按钮没重算，左右分屏的右屏按钮和 ESC 重叠了 7px。已在 `positionModeSwitcher` 末尾也调用 `reclearPaneJumps()`。

- 测试：`split-views` 新增 6 条，`feature-guards` 新增 1 条、改 1 条接线断言；TERM-33 入口登记 `js-control:splits.js:Jump to latest`。全量结果见下。
- 32353 实测（左右、上下各一次）：只翻未聚焦的屏 → 只有该屏出现按钮，页面按钮不出现；两屏都翻 → 两个按钮各在自己窗格右下角；点第一屏的按钮 → 第一屏到底、第二屏不动、焦点到第一屏；四个按钮位置都在各自窗格内，不压 ESC 悬浮按钮和安装按钮。
