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
| S25 | SKILL-01、SKILL-02 | 菜单点「Skills」（或设置里「Manage skills」） | `#skillsModal` 带 `.active`；三个页签各高 44px，命中测试命中自己；同一时刻只有一个 `.skills-pane` 的 `display` 不是 `none` |
| S26 | SKILL-03、SKILL-06 | 打开面板等两次请求回来 | 「插件（N）」「技能目录（M）」两个分组都在；属主不是当前用户的技能行上，按钮文字为「只读」且 `disabled === true`，`title` 里带该目录路径 |
| S27 | SKILL-07、SKILL-10 | 切到「发现」 | 出现「推荐给你」分组；每条推荐的 `.conv-meta` 以「你的项目里有 <文件>」或「已有 N 人安装」开头；整页没有 `[object` |
| S28 | SKILL-09 | 在搜索框输入一个**已安装**插件的名字 | 出现「你已经装了（N）」分组，该行带「已安装」徽章——CLI 的可装列表本就不含已装项，没有这一组会显示成「搜索结果（0）」 |
| S29 | SKILL-22 | 切到「市场」，量添加行 | `#skillsMarketAddBtn` 和 `#skillsMarketInput` 的底边都在 `.modal-content` 内，且命中测试命中自己；390 宽时按钮高 ≥ 44px，`document.documentElement.scrollWidth <= innerWidth` |
| S30 | SKILL-04 | 点一行技能展开 | 出现 `pre.skills-detail`，内容以 `---` 开头（SKILL.md 的 frontmatter），长度 > 100 |
| S31 | SPACE-05、TAB-01 | 建两个空间各带任务，量 `.spaces-sidebar` 与 `.app-header` | 侧边栏宽 264±6、Header 高 44±6、`.main` 的 x 等于侧边栏右缘；任务行宽 > 180 |
| S32 | SPACE-05、TAB-02 | 点非当前任务 | 该行 `backgroundColor` 等于 `--accent`（数值对比，注意 rgb/hex 归一），其余无 `.active` |
| S33 | SPACE-06 | 双击空间名改名；点空间行折叠/展开 | 改名后 PATCH 落服务器（另一窗口刷新可见）；折叠后 `.space-tasks` 的 `display === 'none'`，展开恢复 |
| S34 | SPACE-07、TAB-03、TAB-11 | 点任务 ×、按 Ctrl+W | `#confirmModal` 打开且标题「删除任务」；点取消任务仍在；点确认任务数 -1；两路都只弹一次 |
| S35 | SPACE-08、SPACE-02 | 点「＋ 新建空间」→「浏览…」→ 面包屑点中间段跳转 → 点行进入目标目录 → 「选定此目录」 | 弹窗内容宽 ≈640px、列表高 ≥360px；面包屑末段加粗（`.crumb.current`）；选定后目录输入框=所选目录、名字自动=目录名；再手填一个不存在路径点创建 → 中文报错「工作目录不存在或不是目录」且模态不关；390 宽无横向溢出 |
| S36 | SPACE-09 | 空间行「+」打开新建任务对话框 | 路径栏 readOnly 且值=空间目录；#folderUpBtn/#newTabBrowseBtn/#newTabRecent 都 `display:none`；名称框预填 `task N` 且 `dataset.userEdited === 'false'` |
| S37 | SPACE-05、MOB-11 | 390 宽视口点 #sidebarToggleBtn | 抽屉 transform 从 `matrix(1,0,0,1,-300,0)` 变 `matrix(1,0,0,1,0,0)`，#sidebarBackdrop 可见；点任一任务后 transform 回 -300 且遮罩隐藏 |
| S38 | SPACE-05、TERM-31 | Start 覆盖层打开时（会话未启动）点侧边栏任务 | 点击生效（`elementFromPoint` 命中任务行而非遮罩）；390 宽时抽屉同样可点 |
| S39 | SPACE-10 | 12 任务×3 空间种子，量每组可见行数 | 每组默认 5 行可见（其余 `.wm-hidden` 存在但 `display:none`）；对第 8 行任务 `setTabWorking(id,true,'x')` 后该行变为可见；点「显示更多」后行数 +5 或全显；「收起」回到 5；折叠再展开回到 5 |
| S40 | SPACE-11 | 点搜索图标输入子串 | 输入框展开；非空时 `.spaces-tree` 隐藏、`.search-hit` 平铺且每行含 `任务名 · 空间名` 与状态点；点一行后搜索收起、该任务为 active、其空间展开且行在可视区（`ensureTabVisible` 后 `getBoundingClientRect` 在树容器内）；Esc 收起；乱串无结果显示「没有匹配的任务」 |
| S41 | SPACE-12 | 量任务行 `.tab-time` 与超宽标题 | 每行 `.tab-time` 非空且匹配 /刚刚\|分钟\|小时\|天\|^\d+\/\d+$/，title 为本地时间串；构造超长名任务，静止时 `.tab-name` `clientWidth < scrollWidth`，`mouseenter` 后 `scrollLeft > 0`，`mouseleave` 后回到 0 |
| S42 | SPACE-13、SPACE-14 | 触屏模拟点 ⋯；空态 | `(hover:none)` 下 `.tab-menu` `opacity ≥ .5` 可点开 `.pane-session-menu`；全新数据（无空间无任务）`#sidebarEmpty` 可见且 `.spaces-tree` 隐藏 |
| S43 | SPACE-15 | 对组内第 3 个任务点行内图钉 | 该任务 DOM 序变组内第 1、`.pinned` 类 + 图钉强调色常亮、时间 opacity 0；悬停另一任务：其 `.tab-time` opacity 0→悬停前 .75 与 `.tab-pin` 0→.6 互换且行宽/行高 rect 逐值不变；再点取消回原位 |
| S44 | SPACE-16 | 点 #sidebarSortBtn 切「最近」 | 按钮带 .active；修改某任务 lastActivity 为最新后该任务（非置顶时）排组首；对行派发 dragover 事件后 DOM 序不变；切回手动恢复拖拽序；刷新后模式保持 |
| S45 | SPACE-17 | 点 #sidebarCollapseBtn 收起 | `.spaces-sidebar` 宽 56±2px；`.rail-badge` 数=空间数且首字符=空间名首字；当前任务徽标 .current 填充强调色；带运行任务的徽标有 .rail-dot；点徽标后侧栏展开、目标空间展开且组顶在树可视区 |
| S46 | SPACE-18 | 指针移入/移出任务树，量滚动条 | 指针在外 `::-webkit-scrollbar-thumb` 不可见（用 `.scroll-active` 类断言：无类）；pointerenter 后有类；pointerleave 后 2s 内仍有、2.5s 后无；树内容宽度全程不变 |

## 基线结果

2026-09-22 首次全套运行的结果，记在 `ts/.claude/plans/2026-09-22-防止遗漏现有功能.md` 的「实测记录」一节。

S25–S30（技能面板）于 2026-09-26 在一次性实例（32354）上跑过一遍：19 行（15 插件 + 4 技能目录）、3 个市场、299 个可装项；三个只读技能正确禁用卸载；390 宽无横向溢出。过程记在 `ts/.claude/plans/2026-09-26-技能管理.md`。

S31–S38（空间侧边栏）于 2026-10-26 在一次性实例（32354，`CCW_DATA_DIR` 临时目录、每轮重新播种）上以 Playwright 量化跑过：布局套件 16/17（1 项为脚本 rgb/hex 同色对比假阴性）、交互套件 15/15。过程与两个真实层叠缺陷的修复记在 `ts/.claude/plans/2026-10-26-空间任务侧边栏布局.md` 的「实测记录」。
