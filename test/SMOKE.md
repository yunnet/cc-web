# 回归冒烟清单

守的是「入口还在、但行为坏了」——`test/features.test.js` 的双向核对看不到这种情况。每一项写清**怎么做 → 量什么 → 什么数值算通过**，并对应 `FEATURES.md` 的功能 ID。

**什么时候跑**：`/dev` 改到 `src/` 时，完成前在**一次性实例**上用 Playwright 跑相关的项；改动面大时跑全套。结果写进计划的「实测记录」。
- 一次性实例：`CCW_DATA_DIR=<临时目录> node bin/cc-web.js --no-open --port 32354 --auth-file <临时令牌文件>`，浏览器用 `/?token=<临时令牌>` 登录。
- 用 `POST /api/sessions/create` 建两个会话（A、B），页面上用 `sessionTabManager.addTab` 挂成标签。
- 跑完关掉实例，删掉临时目录。**绝不碰 32352，也不碰 32353 的数据。**

**准备工作的坑**：手动 `addTab` 挂上的标签和浏览器里保存的标签对不上时，页面会弹出「Restore sessions」对话框（START-05，这是正常功能），它会挡住所有点击。先点它的 Open（什么都不勾时会转而打开新建对话框，再用 × 关掉），然后再做命中测试。

**只做能量化的部分**：量几何（`getBoundingClientRect`）、命中（`elementFromPoint`）、算出来的样式（`getComputedStyle`），以及拦截到的调用参数。手感、观感归人工验证。

| # | 功能 ID | 怎么做 | 量什么 → 通过条件 |
|---|---|---|---|
| S01 | NEW-01、NEW-03、NEW-18 | 点标签栏 `+` | `#newTabModal` 可见；`document.activeElement` 是 `#newTabStartBtn`；按 Esc 后对话框隐藏 |
| S02 | TAB-01、TAB-02 | 点非当前标签 | 被点的标签带 `.active`，背景色等于 `--accent`，其余标签没有 `.active` |
| S03 | TERM-04、TERM-05 | 在终端 textarea 上分别派发 Shift+Enter、Ctrl+Enter | 拦截 `app.sendOn` 发出的 input：依次是 `\n` 和 `\x18\x13` |
| S04 | TERM-08 | 往当前终端写入 `ESC]52;c;<"复制测试" 的 base64>BEL` | 拦截 `copyToClipboard`：收到 `复制测试` |
| S05 | TERM-12、TERM-13 | 查看当前终端注册的链接识别器 | 至少 2 个（网址识别、计划文件链接） |
| S06 | TAB-15 | 对后台标签调用 `setTabWorking(id, true, 'x')` | 标签带 `data-working`，`.tab-status` 为 10×10 |
| S07 | TAB-16、TAB-19 | 把 `DONE_GRACE_MS` 设为 50，模拟页面隐藏，让后台标签从工作转为空闲 | 标签带 `data-done`，`::after` 内容为 `"✓"`；`document.title` 以 `✓ ` 开头；页面恢复可见后前缀去掉 |
| S08 | TAB-17 | 对后台标签调用 `handleMessage({type:'hook_event', event:'Notification', notification_type:'permission_prompt'})` | 带 `data-awaiting`，`.tab-content::after` 的内容为「待批准」；换成 `idle_prompt` 时**不**标记；切到该标签后清除 |
| S09 | NOTI-03 | 页面隐藏、没有通知权限时，让后台标签答完 | 出现 `.mobile-notification`，文字是「<名> 答完了」加话题；话题里的 `<b>` 按纯文本显示 |
| S10 | FILE-01、FILE-05、FILE-06 | 点 `#explorerBtn` | 抽屉可见；`#explorerShowHidden` 默认勾选；列表行数 > 0 |
| S11 | FILE-08、FILE-09、FILE-10、FILE-12 | 看任意一个文件行 | 有下载、@、删除三个按钮，都可见且宽高 ≥ 24px |
| S12 | FILE-03 | 在抽屉里按 Esc | 抽屉隐藏 |
| S13 | GIT-01 | 点 `#branchBtn`，再按 Esc | 面板可见；Esc 后隐藏 |
| S14 | SPLIT-01 | 窗口宽度 ≥ 700 时点 `#layoutBtn` | 弹出 `.pane-session-menu`，有 3 个 `.pane-session-item`，当前布局前带 ✓ |
| S15 | SET-01、SET-02 | 点 `#hamburgerBtn`，再点菜单外 | 菜单打开（`.active`）；点外面后关闭 |
| S16 | SET-04 | 从菜单进入 Settings，字号改为 18 并保存 | 当前终端 `options.fontSize === 18`；标题包含「Settings — 」 |
| S17 | SES-01、SES-02 | 点 `#historyBtn` | Sessions 弹窗可见，会话行数 ≥ 2 |
| S18 | UI-01、TERM-31 | 量工具栏图标按钮，并做命中测试 | `#explorerBtn`、`#branchBtn`、`#historyBtn`、`#hamburgerBtn`、`#layoutBtn` 都是 44×44，内部 svg 宽度 > 0；Start 面板显示时，按钮和标签的中心点仍命中它们自己 |
| S19 | UI-04 | 调用 `handleMessage({type:'hook_event', tool_name:'ExitPlanMode', tool_input:{plan:'# P'}})` | 计划弹窗可见，内容里有「P」 |
| S20 | MOB-03 | 窗口调到 390×844 | `.mode-switcher` 可见，内有 ESC、MODE、→ 三个按钮，各自宽度 ≥ 44 |
| S21 | MOB-11 | 390 宽、标签 ≥ 3 个时 | `#tabOverflowBtn` 可见，只显示 2 个标签 |
| S22 | MOB-12、SET-01 | 390 宽时 | `#hamburgerBtn` 位于标签栏最左侧（它的 left 小于第一个标签的 left） |
| S23 | UI-02 | 调用 `applyTheme('light')` | `dataset.theme === 'light'`，终端 `options.theme.background` 从 `#0d1117` 变为 `#ffffff` |
| S24 | TERM-33 | 让终端有足够多的历史，向上滚一屏 | `#scrollBottomBtn` 从 hidden 变为可见，位置在终端区右下角，命中测试命中自己；点它后终端回到底部（`buffer.baseY === buffer.viewportY`）且按钮重新隐藏；手机尺寸（390 宽）下按钮 ≥44px，且与 `.mode-switcher` 不重叠 |

## 基线结果

2026-09-22 首次全套运行的结果，记在 `ts/.claude/plans/2026-09-22-防止遗漏现有功能.md` 的「实测记录」一节。
