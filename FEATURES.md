# 功能清单

cc-web 里**每一项用户能感知到的功能**都登记在这里。规则：

- **未经用户明确同意，不得删除或弱化任何一项。** 删除一行，或者把某行的「功能」描述改弱，都必须在对应的开发计划里**原样引用用户的原话并注明日期**作为同意记录。发布脚本 `deploy-32352.sh` 会对比线上版本与待发布版本的清单：有条目被删就中止发布，描述有改动就列出来给用户看。
- **新增功能必须在同一个提交里登记一行。** `test/features.test.js` 会双向核对：代码里新增的入口没有登记，测试失败；登记过的入口在代码里找不到了，测试也失败。
- **ID 永不复用。** 删掉的 ID 不再分配给别的功能。
- 「入口」一栏是 `scripts/feature-surfaces.js` 能扫描出的键（`kind:key`），或 `file:<路径>`（这个功能所在的文件，没有更具体的入口时用）。`手工` 表示扫描不到，只能靠人和冒烟清单（`test/SMOKE.md`）来守。
- 「守卫」一栏是守住这项功能的测试文件；`—` 表示还没有，待补。

查某个文件上挂着哪些功能：`node scripts/feature-surfaces.js --file <path>`，再在本文件里搜索对应的键。

**完整性说明（2026-09-23 复查）**：第一版主要来自「能被扫描器找到入口」的代码，所以漏掉了不少没有入口的行为。这次按区域重新逐个文件复查，补了 107 条，主要是：错误和拒绝时你看到的文案、默认值、上限和到了上限的表现、兜底路径、动画与配色的用意、手机和窄屏下的差别。同时新登记了 20 项缺陷（GAP-11 起）。每条补充都对应到了具体代码位置。仍需注意：清单描述的是**当前代码的行为**，不代表这些行为都经过人工确认好用。

## 终端

| ID | 功能 | 入口 | 守卫 |
|---|---|---|---|
| TERM-01 | 每个标签各有一个常驻终端和独立连接；切换标签只切换显示，不清屏、不重放，滚动历史完整保留；后台标签的输出照常增长 | `file:src/public/app.js` | `test/session-views.test.js` |
| TERM-02 | 打开标签或刷新页面时回放服务器保存的输出，恢复历史；回放前先重置终端，救回卡在备用屏幕的页面 | `ws-client:app.js:session_joined` `ws-server:join_session` | `test/terminal-reset-on-join.test.js` `test/pty-repaint.test.js` |
| TERM-03 | 键盘输入发给 Claude；Claude 未运行时提示「Claude is not running」 | `ws-server:input` `ws-client:app.js:info` | — |
| TERM-04 | Shift+Enter 或 Alt/Option+Enter 在输入框里换行，不提交 | `xterm:app.js:attachCustomKeyEventHandler` `key:app.js:Enter` | `test/mobile-keys.test.js` |
| TERM-05 | Ctrl+Enter 发送 Ctrl+X Ctrl+S，即 Claude 的「立即发送」 | `xterm:app.js:attachCustomKeyEventHandler` | `test/mobile-keys.test.js` |
| TERM-06 | 有选中文本时 Ctrl/Cmd+C 复制并取消选区；没有选区时 Ctrl+C 照常作为中断发给程序 | `xterm:app.js:attachCustomKeyEventHandler` | — |
| TERM-07 | Mac 的 Option 键当作 Meta，Claude 的 Option 快捷键（如 Option+P 切换模型）可用 | 手工 | — |
| TERM-08 | 程序通过 OSC 52 写剪贴板时真正写入浏览器剪贴板，支持中文；查询请求和格式错误的内容被静默忽略 | `xterm:app.js:registerOscHandler(52)` | `test/feature-guards.test.js` |
| TERM-09 | 普通 HTTP 下或剪贴板 API 被拒时，退回 execCommand 复制，局域网 HTTP 下复制照样能用 | 手工 | — |
| TERM-10 | 在终端粘贴或拖入图片（可多张），上传后把绝对路径加空格插入输入框，不自动回车；图片存到工作目录的 `.ccw-uploads`，并自动写入 `.gitignore` | `route:POST /api/upload-image` | — |
| TERM-11 | 图片粘贴的提示：未启动会话时「Start Claude before pasting an image」，失败显示错误，成功显示「Image inserted」；类型不支持、过大、为空分别有明确报错 | `route:POST /api/upload-image` | — |
| TERM-12 | 输出里的 http(s) 网址可以点击，点了在新标签页打开 | 手工 | — |
| TERM-13 | 输出里 `.claude/plans/*.md` 形式的计划文件路径可以点击，在新浏览器标签打开（URL 以 .md 结尾，方便 Markdown 插件渲染）；中文、emoji、路径前面紧贴文字时，下划线也对得准；按该终端所属的会话解析 | `wire:app.js:registerPlanLinks` `wire:splits.js:registerPlanLinks` `xterm:splits.js:registerLinkProvider` | `test/feature-guards.test.js` |
| TERM-14 | 每个终端在本地保留 5 万行滚动历史 | 手工 | — |
| TERM-33 | 终端向上翻看历史时，右下角出现一个圆形按钮，点一下回到最新一屏并把键盘焦点还给终端；回到底部后按钮自动消失。单屏时在页面右下角；分屏时每个窗格右下角各有一个，只看自己翻没翻上去（不管聚焦在哪个窗格），点哪个回哪个，并让开安装按钮和右侧悬浮按钮；手机上按钮更大并让开右边的悬浮按钮 | `control:scrollBottomBtn` `js-control:splits.js:Jump to latest` | `test/feature-guards.test.js` `test/split-views.test.js` |
| TERM-32 | Claude 输出的超链接（OSC 8）可以点击：网址在新标签页打开，计划文件按计划链接打开，其他本机文件用文件浏览器预览；`javascript:`、`data:`、外部主机的 `file:` 等一律不响应；不弹 xterm 的「危险链接」确认框。Markdown 链接只显示链接文字、不再显示「(url)」（用户 2026-09-22 同意：「链接也同意」） | `env:FORCE_HYPERLINK` `xterm:app.js:linkHandler` `xterm:splits.js:linkHandler` `file:src/public/terminal-links.js` | `test/terminal-links.test.js` `test/claude-bridge.test.js` |
| TERM-15 | 桌面鼠标滚轮平滑滚动；按住 Shift 滚轮时 5 倍速 | `setting:smoothScrollDuration` | — |
| TERM-16 | 光标像原生终端一样闪烁；字体为本地托管的 JetBrains Mono，默认字号桌面 14、手机 12 | `setting:fontSize` | — |
| TERM-17 | 使用 Unicode 11 宽度表，emoji 和制表符与原生终端对齐 | 手工 | — |
| TERM-18 | 优先用 WebGL 渲染，不行退到 Canvas，再退到 DOM；GPU 上下文丢失时自动切换，终端不会冻结 | 手工 | `test/renderer-mode.test.js` |
| TERM-19 | 大量输出按动画帧合并写入；积压过多时暂停该会话的 PTY，消化完再恢复，各标签分别限流 | `ws-server:pause` `ws-server:resume` | — |
| TERM-20 | 过滤焦点上报序列（^[[I / ^[[O），不会作为乱码出现 | 手工 | — |
| TERM-21 | 终端自动适配容器大小并同步给 PTY；窗口缩放、旋转、字体加载完成后重新适配并滚到底 | `ws-server:resize` | `test/pty-size-negotiation.test.js` |
| TERM-22 | 同一用户的多个设备共享同一个 PTY 时取最小尺寸；切走的标签、切到后台或锁屏的页面撤回尺寸投票，回到前台重新上报（断掉的连接顺带重连），不会把 PTY 压小；服务端每 30 秒心跳，掉线不回应的设备被断开并让出尺寸；加入正在运行的会话时同步为本机宽度 | `ws-server:detach_size` `ws-server:resize` | `test/pty-size-negotiation.test.js` `test/session-views.test.js` |
| TERM-23 | 终端响铃时播放一声短提示音，后台标签响铃也会响 | `xterm:app.js:onBell` | `test/feature-guards.test.js` |
| TERM-24 | 页面在后台时，响铃会弹出系统通知「Claude needs your attention」，同一会话的通知替换而不叠加；标签在「待批准」时只响铃不重复通知，已有 ✓ 时照常提醒（答完约 60 秒后的那次响铃） | `xterm:app.js:onBell` | `test/claude-title.test.js` |
| TERM-25 | Claude 设置的终端标题去掉前面的动画符号后，作为浏览器标签标题；只有正在看的会话会改标题 | `xterm:app.js:onTitleChange` `file:src/public/claude-title.js` | `test/claude-title.test.js` |
| TERM-26 | 切到某个标签后终端自动获得焦点；开始或加入会话时不自动聚焦 | 手工 | — |
| TERM-27 | 连接意外断开时指数退避自动重连，最多 5 次，之后显示「Connection lost」和 Retry 按钮；单个标签连接 8 秒无响应不会卡住切换；每 30 秒心跳 | `control:retryBtn` `ws-server:ping` `ws-client:app.js:pong` `ws-client:app.js:connected` | — |
| TERM-28 | Claude 停止或退出时终端写一行黄色提示；非 0 退出码把标签标成错误；只有可见会话弹出 Start 面板 | `ws-client:app.js:claude_stopped` `ws-client:app.js:exit` `ws-client:app.js:error` `ws-server:stop` | — |
| TERM-29 | Claude 的输出实时广播给同一会话的所有设备（只有会话所有者能加入，所以都是自己的设备）；浏览器断开后 Claude 继续运行 | `ws-client:app.js:output` | — |
| TERM-30 | 终端滚动条细窄、跟随主题，不出现横向滚动条 | 手工 | — |
| TERM-31 | 覆盖层（加载、Start、错误）打开时，标签栏和菜单仍可点击 | 手工 | `test/overlay-stacking.test.js` `test/start-prompt-overlay.test.js` |
| TERM-34 | 全站轻提示条：屏幕底部居中弹出，成功绿色、失败红色，约 2.2 秒淡出，且不挡鼠标点击（粘贴图片、文件操作、设置都用它） | 手工 | — |
| TERM-35 | 启动 Claude 时把当前终端的行列数一起发过去，PTY 直接按真实尺寸创建，不会先 80×24 再跳一下 | 手工 | `test/start-options.test.js` |
| TERM-36 | 服务器回「Claude is not running」时（停止状态下输入）自动按默认启动选项重启，不再弹 Start 面板（2026-10-28 随 START-06 一并调整，默认值可在设置面板编辑） | `ws-client:app.js:info` | — |
| TERM-37 | 后台标签加入会话时只默默收下回放：不改顶部工作目录、不套用它的视觉设置、不动覆盖层 | 手工 | `test/session-views.test.js` |
| TERM-38 | 终端四周留边：桌面 20px、窄屏 8px、超小屏 4px（留在外框上，避免算错行数把底部输入框挤出屏幕） | 手工 | — |
| TERM-39 | 浏览器在首次交互前拦掉提示音时静默忽略，不报错也不弹窗 | 手工 | `test/feature-guards.test.js` |
| TERM-40 | 粘贴纯文本照常交给终端，只有剪贴板里含图片才拦截上传；拖进来的不是文件就不接管，拖标签分屏的手势不受影响 | 手工 | — |
| TERM-41 | 关闭标签时连同它的终端和连接一起销毁，所以关掉标签的浏览器自己不会再弹「会话已被删除」 | 手工 | `test/session-views.test.js` |
| TERM-42 | 连接 URL 带 `?sessionId=` 时直接自动加入该会话（只限自己的会话；`join_session` 加入别人的会话一律答「Session not found」，`stop` 也只对自己加入着的会话生效） | 手工 | — |
| TERM-43 | 为慢客户端暂停的 PTY 最多停 5 秒就强制恢复；暂停的页面断开时自动解除，终端不会被永久卡住 | `ws-server:pause` | — |
| TERM-44 | 协商出的 PTY 尺寸与当前相同时不重新下发（一台设备重连不会让其他设备整屏重绘）；非法尺寸直接忽略 | 手工 | `test/pty-size-negotiation.test.js` |
| TERM-45 | 回放用的字节预算与落盘用的是同一个（都是会话所有者自己的历史保留量）：最新的一段即使单独超预算也一定保留，最后一屏不会丢 | 手工 | `test/scrollback-setting.test.js` |
| TERM-46 | WebSocket 收到解析不了的消息时只回一条错误，不断线 | 手工 | — |
| TERM-48 | **回合轨道**：终端右缘透明轨道，每个提交过的问题一枚刻度（minimap 式、点击跳行）；**悬停轨道弹出提问列表**——全部提问成行、当前视野所在提问高亮并在列表居中（点行跳转、移开自动收起、列表内悬停不收）；「当前」= 视口中线以上最近的提问。**锚点即终端**：TUI 把每个提问渲染成 `❯ `/`> ` 开头的行，轨道直接扫缓冲取这些行——不存在匹配失败（首版对照转录清单匹配，在老回合已被输出缓冲裁掉的长会话上全数落空，实测 4.7MB 会话 0 锚点，改为扫行后同会话 3 锚点）；重复渲染的同一问只留最后一处；终端区 ≤900px 隐藏；触屏加宽命中区。**诚实限制**：刷新后不在重建缓冲内的老提问无刻度；进行中回合不出刻度 | `file:src/public/turn-rail.js` | — |
| TERM-49 | 会话提问清单接口 `GET /api/sessions/:id/prompts`（只限自己的会话，别人的返回 404）：按序返回该会话转录（在 `~/.claude` 里，所有用户共用）里的真实用户提问（每条 ≤200 字单行 + 时间戳；过滤命令/系统包装、tool_result、子代理与 meta 记录——与 extractTitle 同一过滤）；**增量解析**——每文件缓存 {offset, prompts} 只读上次之后的完整行（首读全量、之后只读新增；半行写跨界续读；文件变小视为同 id 新对话重置），长会话结尾全是工具链也能拿到全部提问；无转录/非法 id/未知目录返回空清单不抛错；符号链接目录按真实路径回退 | `route:GET /api/sessions/:sessionId/prompts` | `test/claude-history.test.js` |
## 标签页与标签标记

| ID | 功能 | 入口 | 守卫 |
|---|---|---|---|
| TAB-01 | 每个会话在侧边栏显示为所属空间下的一行任务；默认名是目录名，自定义名优先；悬停显示完整路径（2026-10-26 由顶部标签栏迁入侧边栏，行为不变） | `file:src/public/session-manager.js` | `test/tab-working-dir.test.js` |
| TAB-02 | 当前任务整行填充强调色、白色粗体 | 手工 | — |
| TAB-03 | 任务行只有一个 ⋯ 按钮（用户 2026-11-14：「把置顶、关闭按钮，都移到三个点里面去。会话只保留三个点的按钮」），删除任务在其菜单「Delete task」里（原行尾 ×）；点了先弹确认框（用户 2026-10-26：「删除时，要有确认弹窗」），确认后删除任务并停止其中的 Claude；取消则不动；提示对话记录保留；中键点行仍删除（同样先确认） | 手工 | `test/session-views.test.js` `test/feature-guards.test.js` |
| TAB-04 | 中键点击标签关闭它 | 手工 | — |
| TAB-05 | 右键标签弹出菜单「Close Others」，点菜单外关闭 | 手工 | — |
| TAB-06 | 双击标签名原地重命名：回车或失焦保存，Esc 恢复，清空保留原名；名字写到服务器，自己的所有设备可见；只有真的改了才算自定义名 | `key:session-manager.js:Enter` `key:session-manager.js:Escape` `route:PATCH /api/sessions/:sessionId` | `test/session-rename.test.js` |
| TAB-07 | 拖动标签调整顺序；顺序变化时分屏窗格跟着换边；标签可以拖进分屏区域 | 手工 | — |
| TAB-08 | 切换到的任务不在侧边栏可视区时，侧边栏自动滚动把它露出来 | 手工 | — |
| TAB-09 | 关闭当前标签后自动切到最近用过的标签；关掉最后一个时显示 Start 面板而不是空终端 | 手工 | — |
| TAB-10 | 标签顺序和当前标签存在浏览器里，刷新后原样恢复 | 手工 | — |
| TAB-11 | Ctrl/Cmd+T 打开新建标签对话框；Ctrl/Cmd+W 删除当前任务（删除会话，带确认弹窗——2026-10-26 用户要求「删除时，要有确认弹窗」；无任务时拦下不误关浏览器标签） | `key:session-manager.js:t` `key:session-manager.js:w` | — |
| TAB-12 | Ctrl/Cmd+Tab 切到最近用过的标签，Ctrl/Cmd+Shift+Tab 切到左边一个（循环）；Alt+1…9 按位置跳转 | `key:session-manager.js:Tab` | — |
| TAB-13 | 标签状态圆点：运行中绿色脉冲，空闲蓝色呼吸，断开或出错红色 | 手工 | — |
| TAB-14 | 后台标签从运行转为空闲时标为未读（圆点变蓝闪烁、名字蓝色粗体），切过去后清除 | 手工 | — |
| TAB-15 | Claude 工作时标签圆点变成旋转的半实心小球（后台标签和分屏也生效；减少动效时不转）；停止或退出时立即消失；提示框追加 Claude 的任务主题 | `state:working` `ws-client:splits.js:exit` | `test/claude-title.test.js` |
| TAB-16 | Claude 在没人看的标签里答完后，圆点变成绿色 ✓ 并闪 3 下：收到 Stop hook 时立即标；没有 Stop 时（旧会话、hook 失效）按标题等 8 秒宽限期再标，宽限期内有新工作、出现权限请求或打开该标签都会取消；Stop 和标题先后到达都只标一次、只通知一次；进程停止或退出不算答完 | `state:done` | `test/claude-title.test.js` |
| TAB-17 | Claude 在没人看的标签里等待权限批准（包括用提问框问你、在计划模式里等你批准计划，2.1.278 实测这两种也发 permission_prompt）时，圆点变成琥珀色慢脉冲，名字后出现「待批准」徽章，优先于 ✓；只有权限请求触发，空闲提醒不触发 | `state:awaiting` `ws-client:app.js:hook_event` `ws-client:splits.js:hook_event` | `test/claude-title.test.js` |
| TAB-18 | 只有「没人在看」的标签才打 ✓ 和「待批准」；切到标签、Claude 重新开始工作、页面回到前台且标签在眼前时清除 | 手工 | `test/claude-title.test.js` |
| TAB-19 | 页面在后台且有标签带 ✓ 时，浏览器标签标题前加「✓ 」，回到页面后去掉 | 手工 | `test/claude-title.test.js` |
| TAB-20 | 右键菜单的「Close Others」把其它任务删除前弹**一次**批量确认（显示数量与运行中的 Claude 数），确认后逐个删除；不再逐个弹、也不无确认（2026-10-26 布局改造随删除确认一并调整） | 手工 | — |
| TAB-21 | 关掉当前标签时若没有最近访问记录（例如刚刷新过），改为切到被关标签原位置上的标签 | 手工 | — |
| TAB-22 | 最近使用顺序最多记 50 个且不落盘：刷新后 Ctrl/Cmd+Tab 退化为按可视顺序切换 | 手工 | — |
| TAB-23 | 即使一个标签都没有，Ctrl/Cmd+W 也会被拦下，不会误关浏览器标签页 | `key:session-manager.js:w` | — |
| TAB-24 | 侧边栏任务列表纵向滚动条为 4px 细条，颜色跟随主题 | 手工 | — |
| TAB-25 | 浏览器禁用本地存储时，标签顺序、当前标签、最近目录、上次启动选项都不记住，但不报错 | 手工 | — |
## 空间与任务（侧边栏）

| ID | 功能 | 入口 | 守卫 |
|---|---|---|---|
| SPACE-01 | 空间清单服务端持久化（`spaces.json`，单文件原子整写；每个平台用户一份，在 `<uid>/spaces.json`）：空间 = 名字 + 绑定目录；坏 JSON 降级为空清单不抛错，畸形条目跳过并计数 | `file:src/utils/space-store.js` | `test/space-store.test.js` |
| SPACE-02 | 空间 CRUD（只限自己的空间，别人的按不存在处理返回 404）：GET 列出自己的全部；POST 建（名字 1-200 字、目录经路径校验越界 403、**必须是真实存在的目录**否则 400 中文提示——手滑路径建出的空间会让其下任务无处启动）；PATCH 改名/改目录（同样校验；改目录只影响之后新建任务的默认目录，不动已有任务的工作目录）；DELETE 删空间——**任务保留**，其会话（只动自己的）转为未分组（普通用户只限自己的可浏览目录，越界 403，见 ACC-07） | `route:GET /api/spaces` `route:POST /api/spaces` `route:PATCH /api/spaces/:id` `route:DELETE /api/spaces/:id` | `test/space-store.test.js` |
| SPACE-03 | 一次性迁移（每个用户各自按自己的会话执行）：首次启动时 `spaces.json` 不存在而已有会话，按工作目录去重自动建空间（名字=目录名，重名加父目录前缀），并把每个会话归入其目录的空间；文件损坏同样触发重建 | 手工 | `test/space-store.test.js` |
| SPACE-04 | 任务（会话）带 `spaceId` 归属：创建时可指定空间，未知 spaceId（包括别的用户的空间）降级为其目录所绑空间（只找自己的空间）、再降为未分组而不是拒绝；PATCH 会话可在空间间移动（null=未分组）；列表与 WS session_created 都带 spaceId | `route:POST /api/sessions/create` `route:PATCH /api/sessions/:sessionId` `ws-server:create_session` | `test/space-store.test.js` |
| SPACE-05 | 侧边栏布局：左侧空间+任务树、右侧终端区（用户 2026-10-26：「左边是空间+任务，右边是session+console」）；任务行沿用原标签的全部行为（状态点、✓/待批准/旋转球 marks、双击改名、拖拽排序、右键菜单、中键关闭、Alt+1..9）；桌面可收起为图标轨道，窄屏（≤768px）变左滑抽屉带遮罩；头部 #sidebarToggleBtn 是唯一的开关，两个方向都管（桌面展开⇄收起、窄屏抽屉开⇄关，aria-expanded 与提示随状态变）。侧栏内的收起按钮 #sidebarCollapseBtn 已移除（用户 2026-11-04：「sidebarToggleBtn这个图标按钮做成双重开关，可以开，也可以关。 sidebarCollapseBtn按钮，不要了。」） | `control:sidebarToggleBtn` `file:src/public/spaces.js` | `test/features.test.js` |
| SPACE-06 | 空间行：悬停浮现「+ 新建任务」与「× 删除空间」；双击就地改名（回车/失焦保存、Esc 恢复，写到服务器，自己的所有设备可见）；点行折叠/展开并记住；底部常驻「未分组」伪分组收纳无空间任务（空且存在真空间时隐藏） | `js-control:spaces.js:New task in this space` `js-control:spaces.js:Delete space (tasks are kept and move to Ungrouped)` `key:spaces.js:Enter` `key:spaces.js:Escape` | — |
| SPACE-07 | 通用确认弹窗：删除任务/删除空间前弹出（用户 2026-10-26：「删除时，要有确认弹窗」），确认/取消/×/Esc/点遮罩五种关闭方式，只有确认键返回真；同一时刻只保留一问 | `control:confirmOkBtn` `control:confirmCancelBtn` `control:confirmCancelX` | — |
| SPACE-08 | 侧边栏底部「＋ 新建空间」（640px 宽卡）：名字（留空自动取目录名）+ 工作目录——可手填/粘贴，也可点「浏览…」展开目录选择器（与新建标签对话框同一 /api/folders 数据、同款 .folder-item 大行：点行进入、符号链接标 ↗、显示隐藏目录开关、空目录提示「可直接选定」）；**面包屑导航**显示当前路径、每段可点跳转、自动滚到末段、当前段加粗；「选定此目录」为面板底部主操作；最近目录一键填入；路径服务端校验（越界 403、不存在 400，均中文提示）；重复目录拒绝（只和自己的空间比）；Enter 创建、Esc 取消（普通用户只限自己的可浏览目录，越界 403，见 ACC-07） | `control:newSpaceBtn` `control:newSpaceName` `control:newSpaceDir` `control:newSpaceBrowseBtn` `control:newSpaceUpBtn` `control:newSpacePickBtn` `control:newSpaceHiddenToggle` `js-control:spaces.js:Symbolic link` `control:newSpaceCreateBtn` `control:newSpaceCancelBtn` `control:newSpaceCloseX` | `test/space-store.test.js` |
| SPACE-09 | 空间下新建任务：对话框目录预填并**锁定**为空间目录（隐藏上一级/回到起始/浏览/最近目录/路径输入，NEW-06 的路径跳转随锁失效），默认名 `task N`（取该空间已用最大编号 +1，派生名不算自定义名）；「继续之前的对话」对该目录照常可用；**空间目录打不开时禁用两个启动键并给出中文原因与补救指引**（防止任务静默落到其它目录/错误空间） | `file:src/public/app.js` | — |
| SPACE-10 | 每空间任务**水位线渐显**（借鉴 DSH）：默认只列前 5 个任务，超出部分隐藏（DOM 保留不丢）；正在运行/待批准/未读 ✓/当前任务自动抬升水位线保证可见（扫描前 50）；组尾「显示更多（还有 N 个）」每次 +5（剩 ≤5 全显）、「收起」复位；折叠空间即复位；不持久化（刷新重置） | `file:src/public/spaces.js` | — |
| SPACE-11 | 侧栏**搜索**（借鉴 DSH）：标题行搜索图标展开输入框；非空查询把分组树替换为平铺命中列表（任务名/空间名子串、大小写不敏感；行内带状态点 + `任务名 · 空间名`）；点结果=清空收起搜索、切到该任务、展开所属空间并滚动到行；Esc 收起；无结果显示「没有匹配的任务」 | `control:sidebarSearchBtn` `control:sidebarSearchInput` | — |
| SPACE-12 | 任务行**行尾相对时间**（刚刚/N 分钟/N 小时/N 天/M/D，三级灰字，悬停 title 见绝对时刻，60 秒粒度统一刷新、页面隐藏时跳过）；**超宽标题悬停滚动**到尾部完整显示、移开回到省略号截断（借鉴 DSH） | `file:src/public/session-manager.js` | — |
| SPACE-13 | 任务行内 **⋯ 菜单按钮**：桌面悬停显示、触屏（hover:none）常显，点开与右键相同的菜单（Close Others / 移动到空间…）——触屏原先只能靠右键，无从打开 | `js-control:session-manager.js:Task menu` | — |
| SPACE-14 | 空态：全新安装（无空间无任务）侧栏显示居中引导「还没有空间 → 点下方＋新建空间」；展开的空间若无任务显示灰字「（空）」；搜索无结果有专属空态 | `file:src/public/spaces.js` | — |
| SPACE-15 | **置顶任务**（借鉴 DSH）：置顶在 ⋯ 菜单的「Pin / Unpin」里（用户 2026-11-14：「把置顶、关闭按钮，都移到三个点里面去」，原行内图钉按钮已撤）；已置顶任务行尾常亮一个强调色图钉标记（不可点，悬停时把位置让给 ⋯），时间常隐；置顶任务排其空间最前（两种排序模式下皆然，组内相对序保持）；取消置顶回原位；按设备记忆（localStorage） | 手工 | — |
| SPACE-16 | **排序模式**（借鉴 DSH）：侧栏头切换按钮「手动（默认，现有拖拽序）/ 最近更新（各组按最后活动严格倒序、只读）」；最近模式下拖拽不重排（dragover 直接忽略）；置顶恒排最前；按钮显示当前模式（最近=强调色）、选择按设备记忆 | `control:sidebarSortBtn` | — |
| SPACE-17 | **折叠为 56px 图标轨道**（借鉴 DSH）：侧栏收起时不再整条消失——每空间一枚圆形字徽（名字首字），当前任务所在空间填充强调色，含运行中/待批准/未读 ✓ 任务的空间带状态点（待批准琥珀优先）；点徽标=展开侧栏+展开该空间+滚动定位；底部「＋」=展开并打开新建空间；宽度 0.2s 过渡（reduced-motion 关） | `control:railAddBtn` `file:src/public/spaces.js` | — |
| SPACE-18 | **安静滚动条**（借鉴 DSH）：侧栏任务树与搜索结果的滚动条拇指默认透明（4px 轨道恒定预留，行永不位移）；指针进入列内拇指现形，离开后残留 2 秒 | `file:src/public/spaces.js` | — |
| SPACE-19 | **本机未打开的任务以淡色行显示在所属空间下**（用户 2026-11-07：手机上「有两个空间丢失会话」——任务是在 PC 上建的，手机恢复时没勾选，空间看起来是空的）：服务器上属于本用户、但本设备没有标签的任务，按 lastActivity 新→旧列在空间的任务之后，虚线圆点 + 名字 + 「未在本设备打开」；点一下即作为任务打开（与 Sessions 面板同一路径，并从本机忽略名单移除）；空间只有这类任务时不显示（空）；折叠空间时一起收起；搜索也能找到（标「未在本设备打开」）；删除空间对话框里的任务数按服务器上的全部任务计；页面回到前台和每 60 秒重新拉取任务列表，其他设备新建/删除的任务无需刷新即出现/消失；手机上行高 44px；没有「在本设备隐藏」操作（用户 2026-11-07：「不要」） | `file:src/public/spaces.js` | `test/feature-guards.test.js` |
## 通知与提醒

| ID | 功能 | 入口 | 守卫 |
|---|---|---|---|
| NOTI-01 | 启动约 2 秒后，如果还没决定过通知权限，右上角提示「Enable Desktop Notifications?」（Enable / Not Now），10 秒后自动消失；权限为默认时直接请求授权 | 手工 | — |
| NOTI-02 | 通知只在页面处于后台、且不是当前标签时发；已授权时发系统通知（同一会话替换），5 秒后关闭，点击通知切到该标签 | 手工 | — |
| NOTI-03 | 没有系统通知时的兜底：浏览器标题闪「• 标题」约 7 秒、Android 振动、顶部滑出蓝色提示条（5 秒收回，点击切到该标签，文字按纯文本显示）、800Hz 提示音 | 手工 | `test/claude-title.test.js` |
| NOTI-04 | 后台标签答完时通知「<标签名> 答完了」，正文为 Claude 最后一句回复的第一行（最多 100 字）；拿不到回复时用 Claude 的任务主题 | 手工 | `test/claude-title.test.js` |
| NOTI-05 | 后台标签等待权限时通知「<标签名> 待批准」，正文为 Claude 的提示消息 | 手工 | `test/claude-title.test.js` |
| NOTI-06 | 后台标签 90 秒没有新输出时，通知「<标签名> — Claude appears finished」，正文「No output for 90 seconds (worked for Ns)」，并把标签标为空闲、未读 | 手工 | `test/claude-title.test.js` |
| NOTI-07 | 后台标签输出中出现 build successful、tests passed、deployment complete、Done in X.Xs 等字样时，标为未读并通知对应结果 | 手工 | — |
| NOTI-08 | 出错时通知「Error in <标签名>」 | 手工 | — |
| NOTI-09 | 设置了 `--claude-alias` 后，通知和提示里的「Claude」换成别名 | `cli:--claude-alias` | `test/server-alias.test.js` |
| NOTI-10 | 通知标题用的是会话名：没手动命名过的会话会显示成「Session <时间>」这种默认名 | 手工 | `test/claude-title.test.js` |
| NOTI-11 | 输出里出现完成字样但不属于 build/tests/deployment 三类时，通知正文用「Task completed successfully」 | 手工 | — |
| NOTI-12 | 页面在后台响铃时，如果通知权限还没决定，会顺手弹出浏览器的授权请求 | `xterm:app.js:onBell` | `test/claude-title.test.js` |
## 新建标签对话框

| ID | 功能 | 入口 | 守卫 |
|---|---|---|---|
| NEW-01 | 头部「＋任务」、空间行的 +、Ctrl+T、Sessions 面板和菜单里的 New Session、恢复对话框、首次运行，都打开同一个「新建标签页」对话框 | `control:headerNewTaskBtn` `control:conversationsNewBtn` `control:newSessionBtnMobile` | `test/new-tab-dialog.test.js` |
| NEW-02 | 工程目录默认选当前标签的目录，其次是其他已开标签，再其次是最近用过的目录；最近目录打不开（403/404）时自动忘掉并试下一个，断网或未登录时保留；都没有时用自己的第一个可浏览目录（普通用户，见 ACC-07） | 手工 | `test/new-tab-dialog.test.js` |
| NEW-03 | 打开时焦点落在「启动」上，直接回车即可启动；由危险模式进入时焦点在「危险模式启动」上 | `control:newTabStartBtn` | — |
| NEW-04 | 模型、权限模式、思考强度默认沿用上次启动的选择（可在设置面板「任务默认启动选项」直接编辑，同一份记录）；「跳过权限」从不记住；每次都默认「新对话」模式 | `control:newTabModelSelect` `control:newTabPermissionSelect` `control:newTabEffortSelect` | `test/new-tab-dialog.test.js` |
| NEW-05 | 名称框没手动输入时自动填文件夹名，选了要继续的对话时填对话标题（超 40 字截断）；手动输入的不被覆盖；回车即启动；只有手动输入的名称才作为自定义名传给 Claude | `control:sessionName` | `test/new-tab-dialog.test.js` `test/start-options.test.js` |
| NEW-06 | 路径栏可直接输入，回车跳转，Esc 恢复当前路径（不关闭对话框）；输入了路径没回车就启动时先跳过去再启动；路径长时滚到末尾露出文件夹名 | `control:currentPathInput` | — |
| NEW-07 | 「上一级」（根目录时禁用）和「回到起始目录」按钮；「浏览…」展开或收起目录树 | `control:folderUpBtn` `control:folderHomeBtn` `control:newTabBrowseBtn` | — |
| NEW-08 | 路径栏下方显示最多 8 个最近目录，当前目录高亮，点击跳转；非工程目录不显示也不预选 | 手工 | `test/new-tab-dialog.test.js` |
| NEW-09 | 目录树顶部有「..」，点文件夹进入，符号链接文件夹标 ↗；空目录和打不开的目录有中文提示；遇到 401 弹出登录框（普通用户只限自己的可浏览目录，越界 403，见 ACC-07） | `js-control:app.js:Symbolic link` `route:GET /api/folders` | — |
| NEW-10 | 「显示隐藏文件夹」复选框（默认不勾），切换后刷新 | `control:showHiddenFolders` | — |
| NEW-11 | 「新建文件夹」输入条：回车创建、Esc 取消；名称为空、含 / 或 \\、已存在等情况有中文提示；成功后刷新目录树（普通用户只限自己的可浏览目录，越界 403，见 ACC-07） | `control:createFolderBtn` `control:newFolderNameInput` `control:confirmCreateFolderBtn` `control:cancelCreateFolderBtn` `route:POST /api/create-folder` | — |
| NEW-12 | 「新对话 / 继续之前的对话」切换；继续模式列出该目录下 Claude 记录过的对话（标题、相对时间、id），已在别的标签打开的灰掉不能选（被其他用户占用的同样灰掉，标「其他用户正在使用」，悬停提示「其他用户正在使用这个对话」）；换目录时列表跟着刷新 | `js-control:conversations.js:Already open in a tab` `route:GET /api/claude-sessions` `js-control:conversations.js:Another user is using this conversation` | `test/claude-history.test.js` `test/claude-resume.test.js` |
| NEW-13 | 「启动」创建会话并直接启动 Claude，不再弹 Start 面板；「危险模式启动」以跳过权限的方式启动 | `control:newTabStartBtn` `control:newTabDangerousBtn` `route:POST /api/sessions/create` | `test/new-tab-dialog.test.js` `test/session-create-guard.test.js` |
| NEW-14 | 启动请求进行中两个按钮都禁用，显示「启动中…」，防止连点建出多个会话 | 手工 | `test/session-create-guard.test.js` |
| NEW-15 | 拒绝把服务启动目录、主目录、根目录 / 当作工程目录，分别给出中文原因；没选目录、继续模式没选对话时也有中文提示 | 手工 | `test/new-tab-dialog.test.js` |
| NEW-16 | 要继续的对话已在别的标签打开时提示并切过去（被其他用户占用时只提示「其他用户正在使用这个对话」，不切换）；对话在该目录下已不存在时提示；网络失败提示「创建会话失败，请检查连接后重试」 | 手工 | `test/new-tab-dialog.test.js` `test/claude-resume.test.js` |
| NEW-17 | 创建成功后把目录记到最近目录最前面（最多 8 个），并记住本次的模型、权限、强度 | 手工 | `test/new-tab-dialog.test.js` |
| NEW-18 | 取消、×、点背景、Esc 都能关闭对话框；一个标签都没有时取消，会留下 Start 面板 | `control:cancelNewTabBtn` `control:closeNewTabBtn` `key:app.js:Escape` | `test/new-tab-dialog.test.js` |
| NEW-19 | 因拒绝原因打开对话框时（例如在主目录里点 Start），顶部红字显示原因 | 手工 | `test/new-tab-dialog.test.js` |
| NEW-20 | 从「继续之前的对话」切回「新对话」会清掉已选中的对话，并把名称框改回文件夹名（前提是没手动输入过） | 手工 | `test/new-tab-dialog.test.js` |
| NEW-21 | 还没选定目录时切到「继续之前的对话」，列表不会加载，显示为空 | 手工 | — |
| NEW-22 | 下拉里的具体选项：模型 Opus/Sonnet/Haiku/Fable；权限 自动/逐项确认/计划模式/自动接受编辑/不询问；强度 低到最高 | 手工 | `test/new-tab-dialog.test.js` |
| NEW-23 | 最近目录全都打不开时自动展开目录树回到起始目录；若因未登录（401）失败则不再重试，只留登录框 | 手工 | `test/new-tab-dialog.test.js` |
| NEW-24 | 对话列表的相对时间：1 分钟内显示 just now，超过 30 天改显示本地日期 | 手工 | — |
## Start 面板与会话恢复

| ID | 功能 | 入口 | 守卫 |
|---|---|---|---|
| START-01 | 页面加载时显示「Connecting to Claude Code...」 | 手工 | — |
| START-02 | Start 面板：模型、权限模式、思考强度三个下拉（选 Default 时用 Claude 自己的默认值），「Start Claude」和「Dangerous Claude」两个按钮，按钮文字随别名变化 | `control:claudeModelSelect` `control:claudePermissionSelect` `control:claudeEffortSelect` `control:startBtn` `control:dangerousSkipBtn` `ws-server:start_claude` `ws-client:app.js:claude_started` | `test/start-options.test.js` |
| START-03 | 当前会话没有可用的工程目录时，按 Start 改为打开新建对话框，并带上已选选项和拒绝原因 | 手工 | `test/new-tab-dialog.test.js` |
| START-04 | 本地标签与服务器会话一致时原样恢复；首次使用时采用服务器上自己的全部会话；服务器上没有会话时直接打开新建对话框；拉取列表失败时不清空本地标签并给出提示 | `route:GET /api/sessions/list` | — |
| START-05 | 本地标签与服务器不一致时弹出「恢复任务」对话框（原「Restore sessions」，2026-11-07 改中文）：每行可勾选打开、选为当前、删除（先确认）；本机原有的和**其他设备新建的**任务都默认勾选（用户 2026-11-07 同意：手机上新任务默认不勾，确认后整个空间看起来是空的），后者带「其他设备新建」标记；没勾的记为已忽略，以后不再为它弹窗，但仍以淡色行显示在所属空间下（SPACE-19）；×、Esc、点背景可关闭——关闭只恢复本机原有标签，不把任何任务记为忽略；「+ 新建任务」打开新建对话框；手机上勾选框、当前、删除、× 的触控区放大 | `js-control:app.js:Make this the current task` `js-control:app.js:Delete task` | `test/feature-guards.test.js` |
| START-06 | 新会话或 Claude 未运行的会话加入时**不再弹 Start 面板**，终端打印黄色提示后直接按默认启动选项自动启动（平台用户第一次启动也不会停在 Claude 的主题选择和「是否使用这个 API key」上，见 CLA-19）（用户 2026-10-28：「这个弹窗能不能去掉，都使用默认值。在session管理中，给个地方设置默认值」）；默认值即「上次启动的选择」，可在设置面板编辑（SET-17）；正在看着的会话中 Claude 停止仍弹面板（见 TERM-28） | 手工 | `test/start-prompt-overlay.test.js` |
| START-07 | 会话在自己的别的窗口或设备上被删除时，自动关掉本地对应的标签并提示 | `ws-client:app.js:session_deleted` | — |
| START-08 | 离开会话时终端清空、状态点变红；没有任何标签时显示 Start 面板 | `ws-client:app.js:session_left` `ws-server:leave_session` | — |
| START-09 | 连续启动失败熔断：短时间内多次非零退出后，拒绝自动重试并提示新建会话 | 手工 | `test/start-circuit.test.js` |
| START-10 | 通过 WebSocket 新建并加入会话（新会话归这个连接的登录用户所有） | `ws-server:create_session` `ws-client:app.js:session_created` | — |
| START-11 | 恢复对话框顶部说明为什么弹出，并按情况补一句有几个标签指向已不存在的会话、有几个会话是本浏览器没见过的 | 手工 | — |
| START-12 | 恢复对话框默认勾选上次开着的会话、默认选中上次的当前会话；确认后按原标签顺序排列，新勾的排在后面 | 手工 | — |
| START-13 | 服务器上一个会话都没有时，本地记住的标签集合会被就地清空，下次刷新不再提示恢复 | 手工 | — |
| START-14 | 已选好目录但当前没有任何会话时按 Start，会自动新建一个以时间命名的会话再启动 Claude | 手工 | `test/session-create-guard.test.js` |
| START-15 | 会话 id 被占用（卡死的幽灵会话）时终端黄字提示，服务端删掉空转录（在 `~/.claude` 里）并自动重开一次 | 手工 | `test/claude-resume.test.js` |
| START-16 | 同一会话里 Claude 已在运行时再点 Start，返回「Claude is already running」，不会起第二个进程；没加入会话就启动则提示 No session joined | 手工 | — |
| START-17 | 闲置休眠：Claude 空闲、没人在看（后台标签不算）、没在等权限确认、没在跑命令，超过 1 小时就由服务端停掉以省内存；同时运行的 Claude 超过 6 个时，先停最久没用、且已安静 2 分钟以上的；正在工作的永不停。被停的任务终端里写一行灰色「[已休眠]…」，不弹 Start 面板、不标错误；切回该任务时打印「正在恢复…」并用默认选项自动 `--resume`。阈值可用环境变量 `CCW_HIBERNATE_IDLE_MIN`（0 关闭）、`CCW_MAX_RUNNING_CLAUDE`（0 不限）调整（用户 2026-11-07 定：1 小时、6 个） | `ws-client:app.js:claude_hibernated` `file:src/hibernation.js` | `test/hibernation.test.js` |
| START-18 | 页面加载后，在浏览器空闲时逐个把其他**正在运行**的会话在后台连上并回放好（按可见终端的尺寸排版、不上报尺寸、不启动 Claude），第一次点开也是立即显示；分屏模式下不做 | 手工 | — |
## Sessions 面板（会话与对话）

| ID | 功能 | 入口 | 守卫 |
|---|---|---|---|
| SES-01 | 工具栏的对话气泡按钮打开 Sessions 面板，头部显示当前目录（长路径截掉前面） | `control:historyBtn` `file:src/public/conversations.js` | — |
| SES-02 | 「Sessions (N)」列出服务器上自己的所有会话（看不到别的用户的）：运行状态、名称、文件夹、是否在本浏览器打开、id；当前标签高亮 | `route:GET /api/sessions/list` | — |
| SES-03 | 点会话行：已开标签的切过去，没开的新开一个标签 | 手工 | — |
| SES-04 | 会话行的垃圾桶删除会话（只能是自己的），先弹统一确认框（2026-10-26 起与任务删除共用一个弹窗）；删除不删对话记录，对应对话会出现在下方可再继续 | `js-control:conversations.js:Delete session` `route:DELETE /api/sessions/:sessionId` | — |
| SES-05 | 「Conversations in this folder (N)」列出 `~/.claude` 里（所有用户共用）、没有会话占用的历史对话（被其他用户的会话占用的也算占用，不列出），点击在新标签里继续；被拒绝后自动刷新重开 | `route:GET /api/claude-sessions` | `test/claude-resume.test.js` |
| SES-06 | 空状态和出错提示：No sessions yet. / No previous conversations in this folder. / Every conversation here is already open. / Could not load sessions. / No folder selected | 手工 | — |
| SES-07 | Refresh、Close、New Session 按钮，× 或点背景关闭 | `control:conversationsRefreshBtn` `control:conversationsDoneBtn` `control:closeConversationsBtn` | — |
| SES-08 | 菜单里的 Sessions 弹窗显示同一份列表，两个同时打开时一起刷新；底部 New Session 打开新建对话框；手机上打开时锁住页面滚动 | `control:sessionsBtnMobile` `control:closeMobileSessionsModal` | — |
| SES-09 | 历史对话标题的优先级：手动命名 > Claude 自动标题（取最后一条）> summary > 第一条真实用户输入，超过 80 字截断 | `file:src/utils/claude-history.js` | `test/claude-history.test.js` |
| SES-10 | 每个会话行右侧除垃圾桶外还有「→」按钮（切过去或开成标签），当前标签那一行不显示它（按钮在 conversations.js，标题是运行时拼的；此前误挂在恢复对话框「Make this the active session」上，2026-11-07 改挂文件） | `file:src/public/conversations.js` | — |
| SES-11 | 会话没名字时显示「Session <id 前 8 位>」，对话没标题时显示「Conversation <id 前 8 位>」 | 手工 | — |
| SES-12 | 删除会话后底部弹出「Session deleted」并自动刷新列表；面板还没确定目录时头部显示 current folder | 手工 | — |
| SES-13 | 面板里只有列表滚动、弹窗本身不滚（避免嵌套滚动），列表随窗口高度伸缩且至少留 120px | 手工 | — |
## 文件浏览器

| ID | 功能 | 入口 | 守卫 |
|---|---|---|---|
| FILE-01 | 工具栏的文件按钮打开右侧抽屉；打开时回到本会话上次浏览的位置，没有则用会话工作目录 | `control:explorerBtn` `file:src/public/file-explorer.js` | — |
| FILE-02 | 拖动抽屉左边缘调整宽度（最小 300px，触屏也能拖），宽度记住 | `js-control:file-explorer.js:Drag to resize` | — |
| FILE-03 | ×、点背景、Esc 关闭抽屉 | `control:explorerCloseBtn` `key:file-explorer.js:Escape` | — |
| FILE-04 | 「上一级」「主目录」按钮；路径栏回车跳转；列表顶部「..」；点文件夹进入；「主目录」是自己的第一个可浏览目录，普通用户到了可浏览目录的顶层就没有「上一级」（见 ACC-07） | `control:explorerUpBtn` `control:explorerHomeBtn` `control:explorerPathInput` `key:file-explorer.js:Enter` | — |
| FILE-05 | 「Show hidden items」默认勾选，切换后立即重新加载 | `control:explorerShowHidden` | — |
| FILE-06 | 列出文件和文件夹（文件夹在前，带大小）；超过 2000 项截断并提示；加载中、空目录、无权限、打不开都有提示（普通用户只限自己的可浏览目录，越界 403，见 ACC-07） | `route:GET /api/fs/list` | `test/fs-browse.test.js` |
| FILE-07 | 点可预览的文件（文本、代码、图片、PDF 等）在新标签页打开；.html/.svg 用一次性票据渲染，拿不到票据时显示源码（普通用户只限自己的可浏览目录，越界 403，见 ACC-07） | `route:GET /api/fs/file/:token/:file` `route:POST /api/fs/ticket` | `test/fs-browse.test.js` `test/fs-render-inline.test.js` |
| FILE-08 | 点不可预览的文件直接下载；行内下载按钮用一次性票据下载，有「Downloading X」和失败提示 | `js-control:file-explorer.js:Download` | `test/fs-browse.test.js` |
| FILE-09 | 行内 @ 按钮把「@绝对路径 」输入终端（不回车），关闭抽屉并提示；未启动 Claude 时提示先启动 | `js-control:file-explorer.js:Insert path into the terminal` | `test/insert-path.test.js` |
| FILE-10 | 行内红色删除按钮，先弹确认（文件夹注明连同内容一起删除）；成功刷新，失败显示原因（普通用户只限自己的可浏览目录，越界 403，见 ACC-07） | `js-control:file-explorer.js:Delete` `route:POST /api/fs/delete` | `test/fs-delete.test.js` |
| FILE-11 | 服务器拒绝删除根目录、主目录、启动目录、任一会话的工作目录及其上级（按真实路径比较，识破符号链接别名）；符号链接只删链接本身；普通用户还只能删自己可浏览目录里的东西（见 ACC-07） | `route:POST /api/fs/delete` | `test/fs-delete.test.js` |
| FILE-12 | 行内按钮（@、下载、删除）一直显示不靠悬停，与悬停高亮一致；手机上点击区域放大到 44px | 手工 | `test/hover-latency.test.js` |
| FILE-13 | 符号链接在名称后标 ↗ | `js-control:file-explorer.js:Symlink` | — |
| FILE-14 | 上传按钮选多个文件上传到当前目录；也可以拖文件到列表上传（拖入的文件夹跳过并提示）；逐个上传，同名不覆盖，结果汇总提示（普通用户只限自己的可浏览目录，越界 403，见 ACC-07） | `control:explorerUploadBtn` `control:explorerFileInput` `route:POST /api/fs/upload` | `test/fs-upload.test.js` |
| FILE-15 | 新建文件夹：输入栏自动聚焦，Create 或回车创建，Cancel 或 Esc 收起；失败时保留输入栏以便改名 | `control:explorerNewFolderBtn` `control:explorerNewFolderInput` `control:explorerCreateFolderBtn` `control:explorerCancelFolderBtn` | — |
| FILE-16 | 悬停某行时整行变为强调色蓝底白字 | 手工 | `test/hover-latency.test.js` |
| FILE-17 | 操作结果都有提示：删除成功「Deleted <名字>」、新建成功「Created folder <名字>」、失败时原样显示服务器给的理由 | 手工 | — |
| FILE-18 | 还没打开任何目录就上传或新建文件夹时提示「Open a folder first」；下载拿不到票据时提示「Could not download <名字>」 | 手工 | — |
| FILE-19 | 文件行的悬停提示直接说明点下去会发生什么：可预览的写「Open in a new tab」，不可预览的写「Download」 | 手工 | — |
| FILE-20 | 删除确认框里写出完整路径并加一句「This cannot be undone.」 | 手工 | `test/fs-delete.test.js` |
| FILE-21 | 拖文件悬停到列表上方时整块列表出现蓝色内描边并变底色，拖走即恢复 | 手工 | — |
| FILE-22 | 抽屉从右侧滑入（0.22 秒）并带左侧阴影，默认宽 440px；宽度上限为窗口宽减 40px 且不超过 95vw，永远留一条可点来关闭的背景 | 手工 | — |
| FILE-23 | 「空目录」「只显示前 2000 项」这类说明行不跟随悬停变色，保持灰字不可点 | 手工 | — |
| FILE-24 | 删除按钮的红色在浅色主题下换成更深的一档，避免在白底上发飘 | 手工 | — |
| FILE-25 | 未启动会话、Start 覆盖层还盖着时，文件抽屉照样能打开并浮在覆盖层之上 | 手工 | `test/overlay-stacking.test.js` |
| FILE-26 | 打开超过 10MB 的文件时新标签页显示「File too large」；下载没有大小上限且是流式发送，下大文件不卡别的标签（普通用户只限自己的可浏览目录，越界 403，见 ACC-07） | `route:GET /api/fs/file/:token/:file` | `test/fs-browse.test.js` |
| FILE-27 | 上传单个文件上限 50MB；同名文件一律不覆盖（409）；文件名带路径、无写权限分别被拒（普通用户只限自己的可浏览目录，越界 403，见 ACC-07） | `route:POST /api/fs/upload` | `test/fs-upload.test.js` |
## 分支面板

| ID | 功能 | 入口 | 守卫 |
|---|---|---|---|
| GIT-01 | 分支按钮打开或收起面板（右侧抽屉，标题 Branches + ×；用户 2026-11-09：「把右上角弹窗都改为抽屉弹窗，要统一UI」），列出当前标签工作目录下每个子项目的 git 分支；点面板外、× 或 Esc 关闭（普通用户只限自己的可浏览目录，越界 403，见 ACC-07） | `control:branchBtn` `control:branchCloseBtn` `key:git-branches.js:Escape` `route:GET /api/git/branches` `file:src/public/git-branches.js` `file:src/git-branches.js` | `test/git-branches.test.js` |
| GIT-02 | 刷新按钮；「Check changes」查询未提交改动、领先、落后（查询中禁用） | `control:branchRefreshBtn` `control:branchStatusBtn` | `test/git-branches.test.js` `test/async-route-safety.test.js` |
| GIT-03 | 同一分支的多个仓库用同一种颜色标出（最多 6 组），深浅主题各一套；状态徽章 ● N、↑N、↓N | 手工 | `test/git-branches.test.js` |
| GIT-04 | 每行拉取按钮（悬停出现）执行 `git pull --ff-only`；进行中旋转，结果和失败原因显示在该行，成功后自动刷新；不相关的未提交改动（含未跟踪文件）不阻止快进，会覆盖本地改动时由 git 拒绝且不动任何文件，该行列出冲突文件名（悬停看全部）；无上游、需合并、超时都有明确原因；不弹凭据提示，错误里的凭据打码（普通用户只限自己的可浏览目录，越界 403，见 ACC-07） | `route:POST /api/git/pull` | `test/git-branches.test.js` |
| GIT-05 | 面板底部统计仓库和分支数；空状态和错误提示；窄屏上面板对齐右侧不出屏 | 手工 | — |
| GIT-06 | 面板顶部显示当前工程目录名（悬停看完整路径）；工作目录自身是仓库时那一行显示「(this directory)」 | 手工 | — |
| GIT-07 | 游离 HEAD 显示「detached @ <短 sha>」，用琥珀色斜体，浅色主题另用更深的琥珀 | 手工 | `test/git-branches.test.js` |
| GIT-08 | 「Check changes」查询期间按钮变成「Checking...」并禁用，完成后恢复 | `control:branchStatusBtn` | — |
| GIT-09 | 拉取失败的原因在该行停 6 秒后自动换回分支名；拉取成功 1.2 秒后自动刷新整个面板 | 手工 | — |
| GIT-10 | 状态徽章有悬停说明（未提交数、领先数、落后数）；拉取结果用绿/红，且各有一套浅色主题配色 | 手工 | `test/git-branches.test.js` |
| GIT-11 | 只有被两个以上仓库共用的分支才上色；只有一个仓库在用的分支和游离 HEAD 不上色 | 手工 | `test/git-branches.test.js` |
| GIT-12 | 分支列表最高 60vh、内部自己滚动，仓库再多面板也不会顶穿屏幕 | 手工 | — |
| GIT-13 | 扫描上限：最多 50 个仓库（多出的写「+N not shown」）、最多看 2000 个子目录（没看到的写「N dirs not examined」）；一个都没扫到时有专门的说明文案 | `route:GET /api/git/branches` | `test/git-branches.test.js` |
| GIT-14 | 拉取 60 秒超时后连同子进程按进程树杀掉，不留后台僵尸；状态查询每仓库 10 秒超时、最多 4 个并发；所有 git 操作在服务端排队执行 | `route:POST /api/git/pull` | `test/git-branches.test.js` `test/async-route-safety.test.js` |
| GIT-15 | 对不是 git 仓库的目录点拉取，服务端先拒绝、根本不执行 git；仓库名必须是单段路径（普通用户只限自己的可浏览目录，越界 403，见 ACC-07） | `route:POST /api/git/pull` | `test/git-branches.test.js` |
| GIT-16 | 点某行分支名（或聚焦后回车）在该行下方展开分支列表：先本地，再「远程」里本地还没有的分支；点一项就切过去（远程分支切换时自动建跟踪分支），当前分支打勾不可点；再点一次或 Esc 收起 | `key:git-branches.js:Enter` `route:POST /api/git/refs` | `test/git-branches.test.js` |
| GIT-17 | 每行左侧勾选框，头部「全选」（部分选中时显示半选）；勾选至少一个时出现操作栏「已选 N 个 · 切换分支 · 新建分支 · 改名」；重新加载后仍在的仓库保持勾选；表单打开时 Esc 先关表单再关面板 | `control:branchSelectAll` `control:branchOpSwitch` `control:branchOpCreate` `control:branchOpRename` `control:branchFormCancel` `control:branchFormSubmit` | 手工 |
| GIT-18 | 批量切换：把勾选的仓库切到同一个分支，候选列出各仓库分支的并集并标「N/M 个仓库有」，也可直接输入；用 `git switch`，不冲突的未提交改动随之带过去，会被覆盖时 git 拒绝、该行显示「会覆盖未提交改动」，不丢改动 | `control:branchFormInput` `route:POST /api/git/switch` | `test/git-branches.test.js` |
| GIT-19 | 批量新建：基于各仓库当前分支，在勾选的仓库里新建同名分支；「创建后切换过去」默认勾上，取消则只建不切；已存在的仓库报「分支已存在」，其他照常 | `control:branchCheckout` `route:POST /api/git/create` | `test/git-branches.test.js` |
| GIT-20 | 改名：把勾选仓库各自的当前分支改成新名字（`git branch -m`），只改本地、远程不动；所选仓库都在同一分支时预填该名；游离 HEAD 报「游离 HEAD 无法改名」，重名报「分支已存在」 | `route:POST /api/git/rename` | `test/git-branches.test.js` |
| GIT-21 | 分支操作的安全约束：分支名先在服务端校验（git 引用规则、不能以 `-` 开头、不能是 HEAD/@），不合法直接 400、表单提示「分支名不合法」且不执行 git；仓库名必须是单段路径；逐仓库执行并在该行显示结果，一个失败不影响其他，失败原因停 6 秒（刷新后仍保留）；全部只动本地，不推送（普通用户只限自己的可浏览目录，越界该行报「无权访问」，见 ACC-07） | `route:POST /api/git/switch` `route:POST /api/git/create` `route:POST /api/git/rename` | `test/git-branches.test.js` |
| GIT-22 | 面板底部「Fetch」按钮：对勾选的仓库（没勾选时为全部仓库）执行 `git fetch origin --recurse-submodules=no --progress --prune`，最多 4 个并发、每仓库 60 秒超时并按进程树杀掉；只更新远程分支引用，不动本地分支和文件；进行中按钮变「Fetching...」、各行显示 fetching...，完成后自动「Check changes」刷新领先/落后；失败行显示原因（无 origin、超时、失败）停 6 秒（用户 2026-11-11：「当前git图标，是同步当前分支吗？如果不是……做一下」；普通用户只限自己的可浏览目录，见 ACC-07） | `control:branchFetchBtn` `route:POST /api/git/fetch` | `test/git-branches.test.js` |
## 分屏

| ID | 功能 | 入口 | 守卫 |
|---|---|---|---|
| SPLIT-01 | 工具栏分屏按钮弹出布局菜单：单屏 / 左右 / 上下，当前项带 ✓，点菜单外关闭 | `control:layoutBtn` `file:src/public/splits.js` | — |
| SPLIT-02 | Ctrl/Cmd+\ 切换分屏；Ctrl/Cmd+1/2 按屏幕位置聚焦窗格 | `key:splits.js:\\` `key:splits.js:1` `key:splits.js:2` | — |
| SPLIT-03 | 窗口宽度小于 700px 时隐藏分屏入口，已开的分屏自动收起 | 手工 | — |
| SPLIT-04 | 把标签拖到终端右边缘或底边创建分屏，拖动中显示放置提示 | 手工 | — |
| SPLIT-05 | 拖动分隔条调整比例（20%–80%），比例和方向记住 | 手工 | — |
| SPLIT-06 | 点击窗格聚焦（高亮边框），标签栏同步；分屏时点其他标签加载进聚焦窗格，已显示的只聚焦不重复挂载 | 手工 | — |
| SPLIT-07 | 右侧窗格的 × 关闭分屏 | `js-control:splits.js:Close Split (Ctrl+\\)` | — |
| SPLIT-08 | 窗口或容器尺寸变化时窗格重新适配并同步 PTY，状态栏不被截掉 | 手工 | — |
| SPLIT-09 | 分屏窗格同样支持 Shift/Alt+Enter 换行、Ctrl+Enter 立即发送、有选区时 Ctrl+C 复制、OSC 52 复制、计划文件链接、标题转球 | `xterm:splits.js:attachCustomKeyEventHandler` `xterm:splits.js:registerOscHandler(52)` `xterm:splits.js:onTitleChange` `key:splits.js:Enter` | `test/claude-title.test.js` `test/mobile-keys.test.js` |
| SPLIT-10 | 分屏窗格进程退出时显示「[Process exited]」，出错显示红字 | `ws-client:splits.js:output` `ws-client:splits.js:session_joined` `ws-client:splits.js:claude_started` `ws-client:splits.js:error` | — |
| SPLIT-11 | 从布局菜单或快捷键开分屏时，第二个窗格自动装入标签栏里的另一个标签；只有一个标签时右窗格是空白 | 手工 | — |
| SPLIT-12 | 已经分屏时再选另一个方向只改变排列，不断开连接、不重新回放 | 手工 | — |
| SPLIT-13 | 关闭分屏后回到你当时聚焦的那个窗格的会话（和点标签一样切过去：标签高亮、侧边栏同步），并清空两个窗格；那个会话原来的终端直接显示、不重新回放，滚动历史还在；下次分屏靠服务器回放重新填满窗格 | 手工 | `test/split-views.test.js` |
| SPLIT-14 | 进入分屏时主终端撤回自己的尺寸（不再离开会话），避免同一会话被两个客户端占住而把 PTY 尺寸压小；它转为后台继续接收输出，当前会话不会被清空 | 手工 | `test/pty-size-negotiation.test.js` `test/split-views.test.js` |
| SPLIT-15 | 交换窗格位置后，× 关闭按钮跟着那个窗格走，不固定在右窗格 | 手工 | — |
| SPLIT-16 | 拖标签分屏：只有离右边或下边 120px 以内才出现放置提示；两边都近时优先上下分屏；拖当前已显示的标签则不分屏；窗口窄于 700px 时连提示都不出 | 手工 | — |
| SPLIT-17 | 分隔条悬停变亮；拖动过程中整页指针变成调整箭头 | 手工 | — |
| SPLIT-18 | 分屏窗格用 Canvas 渲染（不走 WebGL 那一档），Canvas 不可用时退到 DOM | 手工 | `test/renderer-mode.test.js` |
| SPLIT-19 | 分屏时工具栏的 ESC、模式切换（Shift+Tab）、→ 键、计划弹窗的批准/拒绝，以及粘贴或拖入图片，都作用于对应的窗格会话（工具栏按键给聚焦窗格，图片给放进去的那个窗格，计划弹窗给提出计划的会话） | 手工 | `test/split-views.test.js` |
| SPLIT-20 | 窗格里的会话没在运行时自动按默认选项启动（分屏时新建的任务按新建对话框选的选项启动）；Claude 停止时显示「stopped」；被休眠时显示说明，聚焦该窗格即恢复；在别的窗口被删除时关掉它的标签；窗格里的会话被关闭时分屏收起到另一个窗格 | `ws-client:splits.js:claude_stopped` `ws-client:splits.js:claude_hibernated` `ws-client:splits.js:info` `ws-client:splits.js:session_deleted` | `test/split-views.test.js` |
## 设置与菜单

| ID | 功能 | 入口 | 守卫 |
|---|---|---|---|
| SET-01 | 页头右端（账号按钮左边）的齿轮按钮打开从右侧滑出的菜单（打开时齿轮高亮）；点菜单外任意处关闭，那一下点击照常生效；× 关闭 | `control:hamburgerBtn` `control:closeMenuBtn` | — |
| SET-02 | 菜单里「Settings」打开设置（唯一入口），「Sessions」打开会话弹窗 | `control:settingsBtnMobile` | — |
| SET-03 | 菜单底部显示「v版本 · :端口 · 构建号」，区分 dev 和 stable | `route:GET /api/config` | — |
| SET-04 | 设置标题显示「Settings — 会话名」；字号 10–24、主题 Dark/Light、滚动动画 0–200ms，按会话分别保存，新会话继承最近保存的设置；切主题不刷新页面 | `control:fontSize` `control:themeSelect` `control:smoothScroll` `control:saveSettingsBtn` `setting:theme` | `test/light-contrast.test.js` `test/feature-guards.test.js` |
| SET-05 | 显示 Claude Code 已安装版本、最新版、稳定版，以及是否有更新 | `route:GET /api/version` | `test/version-info.test.js` |
| SET-06 | 历史保留量（MB，0.25–16，默认 2），服务器端按用户保存的设置，对自己的所有会话生效、不影响别的用户；超出范围时提示实际生效值 | `control:scrollbackChunks` `route:GET /api/settings/scrollback` `route:POST /api/settings/scrollback` | `test/scrollback-setting.test.js` |
| SET-07 | 计划目录：列出本会话的额外目录（可 × 删除，只能改自己的会话）和全局目录（实例级，只读）；输入后 Add 或回车提交，被拒绝的目录弹出原因 | `control:planDirInput` `control:planDirAddBtn` `js-control:app.js:Remove` `route:GET /api/plan-dirs` `route:POST /api/plan-dirs` | `test/plan-dirs.test.js` |
| SET-08 | 设置弹窗 × 或点背景关闭，不保存；手机上打开时锁住页面滚动 | `control:closeSettingsBtn` | — |
| SET-09 | 「Reset button position」让浮动按钮恢复自动跟随输入框（只在手机上显示） | `control:fabResetBtn` | `test/fab-position.test.js` |
| SET-10 | 版本行带颜色：有更新橙色、已是最新绿色；三种降级文案分别是「Checking…」「latest unknown (no network?)」「Could not read the version」 | 手工 | `test/version-info.test.js` |
| SET-11 | 历史保留量保存失败时红色提示「Could not save the scrollback setting」；填非整数被服务器拒绝；设置先落盘（写进自己的 `<uid>/scrollback.json`）再生效，存盘失败则运行中的值不变 | `route:POST /api/settings/scrollback` | `test/scrollback-setting.test.js` |
| SET-12 | 计划目录区的文案会列出自动覆盖的目录（只算自己的会话）；没有会话时提示先开会话；没有额外目录时明说「No extra directories for this session.」 | 手工 | `test/plan-dirs.test.js` |
| SET-13 | 全局计划目录（实例级，所有用户共用、只读）行带 GLOBAL 标签、整行半透明且没有删除按钮；路径过长时从左边省略，保证结尾目录名看得见 | 手工 | — |
| SET-14 | 被拒绝的计划目录以右上角卡片提示，3 秒后自动滑走；点「Reset button position」后弹出确认提示 | 手工 | `test/fab-position.test.js` |
| SET-15 | 拖动字号、滚动动画滑块时旁边数字实时变化，但要按「Save Settings」才真正生效 | `control:fontSize` `control:smoothScroll` | — |
| SET-16 | 菜单底部的版本行可以选中复制，悬停提示解释「build id 相同 = 两个实例代码相同」 | 手工 | — |
| SET-17 | 设置面板「任务默认启动选项」：模型/权限/强度三个下拉，读写与「上次启动的选择」同一份记录（localStorage `cc-web-last-start-options`）；点未运行任务自动启动（START-06）与新建对话框预填（NEW-04）都用它；跳过权限不出现在默认里 | `control:settingsDefaultModel` `control:settingsDefaultPermission` `control:settingsDefaultEffort` | — |
| SET-18 | 页头齿轮左边的主题按钮：一键切换 Dark/Light（深色显示月亮，浅色显示太阳），和设置里的 Theme 是同一个设置——写入全局默认和当前会话，设置弹窗的下拉同步，不刷新页面 | `control:themeToggleBtn` | — |
## 技能管理

> 技能有三种来源，只有插件有目录、安装器和开关，所以**安装的单位是插件**，面板把每个插件带的技能名列出来。
> 2026-09-26 在 Claude Code 2.1.280 实测：`plugin list --json` 0.34s，`list --available --json` 0.44s / 180KB / 299 个可装项。

| ID | 功能 | 入口 | 守卫 |
|---|---|---|---|
| SKILL-01 | 菜单里的「Skills」和设置里的「Manage skills」打开同一个技能面板（和 Sessions 的双入口同理，两处渲染同一份列表，不会互相矛盾） | `control:skillsBtnMobile` `control:skillsOpenBtn` | `test/skills-panel.test.js` |
| SKILL-02 | 面板分三页：已安装、发现、市场；页签高 44px，同一时刻只显示一页 | `control:skillsTabInstalled` `control:skillsTabDiscover` `control:skillsTabMarkets` | `test/skills-panel.test.js` |
| SKILL-03 | 「已安装」列出 `~/.claude` 装的插件（所有用户共用）（版本、范围、启用状态、它带的技能名）和两个技能目录（个人：`~/.claude/skills`；本项目 `.claude/skills`） | `route:GET /api/skills` `file:src/skills.js` | `test/skills-read.test.js` `test/skills-routes.test.js` |
| SKILL-04 | 点任意一行展开它的 SKILL.md 正文（只读、按纯文本渲染，最大 256KB） | `route:GET /api/skills/file` | `test/skills-routes.test.js` |
| SKILL-05 | 插件可以「停用 / 启用」和「卸载」（动的是共用的 `~/.claude`，所有用户都受影响），都带二次确认，卸载说明「它带的技能会一起消失，已记录的对话不受影响」 | `route:POST /api/skills/action` | `test/skills-write.test.js` |
| SKILL-06 | 本进程删不掉的技能目录（属主是别的用户）显示「只读」且卸载按钮禁用，悬停说明是哪个目录 | `file:src/skills.js` | `test/skills-read.test.js` |
| SKILL-07 | 「发现」列出自己接入的市场里可安装的插件，按安装量排序，带描述和来源（git 地址 + 固定 sha） | `route:GET /api/skills/catalog` | `test/skills-routes.test.js` |
| SKILL-08 | 搜索框按名字和描述过滤（防抖 250ms，一个词只发一次请求） | `control:skillsSearchInput` | `test/skills-read.test.js` |
| SKILL-09 | 搜到的若是自己已经装好的插件，单独分组「你已经装了」并给「去管理」——因为 CLI 的可装列表本就不含已装项，否则会像「搜不到」 | `file:src/public/skills.js` | `test/skills-panel.test.js` |
| SKILL-10 | 「推荐给你」最多 8 条，每条写明理由：命中当前项目里的文件（package.json、go.mod、.git…）或安装量；自己已装的不推荐 | `route:GET /api/skills/catalog` | `test/skills-routes.test.js` |
| SKILL-11 | 安装前二次确认，列出来源，并提示「安装第三方技能等于把别人写的指令交给 Claude 去读」 | `file:src/public/skills.js` | `test/skills-panel.test.js` |
| SKILL-12 | 插件若要求先运行市场声明的命令，**绝不替用户同意**（安装进的是共用的 `~/.claude`）：把命令原文和 sha256 原样弹给用户看，确认后才以 `--accept-command` 重跑 | `file:src/skills.js` | `test/skills-write.test.js` |
| SKILL-13 | 「市场」列出 `~/.claude` 已接入的市场（来源、可更新、可移除），底部可按 `owner/repo` 或 https 网址添加 | `control:skillsMarketInput` `control:skillsMarketAddBtn` | `test/skills-write.test.js` |
| SKILL-14 | 同一时刻只允许一个写操作，第二个直接拒绝（409「另一个技能操作正在进行」），不排队 | `route:POST /api/skills/action` | `test/skills-write.test.js` `test/skills-routes.test.js` |
| SKILL-15 | 成功后提示「已在运行的 Claude 不受影响，下次启动会话时生效」（只对自己的会话生效）——面板不自动重启任何会话 | `file:src/public/skills.js` | `test/skills-write.test.js` |
| SKILL-16 | 面板底部一行状态：正在安装 / 失败原因 / 「找不到 claude 命令，插件部分无法读取（技能目录仍然正常）」；常见失败码译成中文 | `file:src/public/skills.js` | `test/skills-panel.test.js` |
| SKILL-17 | 刷新按钮丢掉缓存重新读取；× 、「关闭」、点背景都能关闭面板 | `control:skillsRefreshBtn` `control:skillsDoneBtn` `control:closeSkillsBtn` | `test/skills-panel.test.js` |
| SKILL-18 | 插件 id、市场地址、sha256、安装范围都先过白名单再交给 CLI；不合法的直接 400，一个进程都不会启动 | `file:src/skills.js` | `test/skills-write.test.js` `test/skills-routes.test.js` |
| SKILL-19 | CLI 卡住时按时限结束它**和它启动的全部子进程**（安装 90s，其余 30s）——实测 `install` 一个不存在的 id 会挂满 90 秒 | `file:src/skills.js` | `test/skills-read.test.js` |
| SKILL-20 | SKILL.md 只能从三个技能根目录（自己的个人技能目录、本项目技能目录、自己的插件目录）下读取，走 realpath 所以符号链接跳不出去；文件名必须是 SKILL.md | `route:GET /api/skills/file` | `test/skills-routes.test.js` |
| SKILL-21 | 可装列表缓存 30 秒（双击不会启动两个 CLI），每个用户的 Claude 各一份，失败不缓存；写操作成功后立刻作废这个用户的缓存 | `file:src/skills.js` | `test/skills-read.test.js` `test/skills-write.test.js` |
| SKILL-22 | 面板是固定高度的一列：页签和底部按钮不动，只有列表滚动，手机 390 宽下不横向溢出、添加按钮 44px 高 | `file:src/public/skills.js` | `test/skills-panel.test.js` |
| SKILL-23 | 读取文件头部时只读前 4KB，所以超大的 SKILL.md 和正常的一样快 | `file:src/utils/read-prefix.js` | `test/skills-read.test.js` |

## 界面、主题与 PWA

| ID | 功能 | 入口 | 守卫 |
|---|---|---|---|
| UI-01 | 工具栏图标悬停时不出现底框，只把图标变成强调色；统一 44×44 点击区域 | 手工 | — |
| UI-02 | 深色和浅色两套配色；浅色主题下 Claude 的输入框边线、消息底色都看得清（高对比 ANSI 配色 + 最低对比度校正） | `file:src/public/style.css` | `test/light-contrast.test.js` |
| UI-03 | 页面加载时提前应用已保存的主题，避免闪烁，并设置浏览器 theme-color | `file:src/public/index.html` | — |
| UI-04 | 计划模式：Claude 提交计划时（只在会话所有者的设备上）弹出「Claude's Plan」弹窗，渲染 Markdown 并播放提示音；Accept 发回车批准，Reject 发 Esc 留在计划模式，× 只关闭弹窗 | `control:acceptPlanBtn` `control:rejectPlanBtn` `control:closePlanBtn` `ws-client:app.js:hook_event` | `test/hook-endpoint.test.js` `test/feature-guards.test.js` |
| UI-05 | 可安装为 PWA（CC Web，绿色机器人图标），浏览器允许时出现「Install App」按钮 | `route:GET /manifest.json` `file:src/public/icons.js` `file:src/public/icon-generator.js` | — |
| UI-06 | Service Worker 每分钟检查更新，有新版本时询问刷新；离线时静态资源读缓存，API 返回 503 提示 | `file:src/public/service-worker.js` | — |
| UI-07 | 标签页图标由服务器按尺寸动态生成 | `route:GET /` | — |
| UI-08 | 计划弹窗只渲染标题、粗体、斜体、行内代码和代码块；列表、表格、链接按纯文本显示 | 手工 | — |
| UI-09 | 批准或拒绝计划后右上角滑出提示，3 秒后自动消失；计划弹窗的标题会跟随 `--claude-alias` 别名 | `control:acceptPlanBtn` | — |
| UI-10 | Start 或错误覆盖层开着时，新建标签对话框和设置弹窗被抬到覆盖层之上，否则点了像没反应 | 手工 | `test/overlay-stacking.test.js` |
| UI-11 | 弹窗遮罩刻意不用毛玻璃：终端在背后刷屏时仍能保持流畅（实测有毛玻璃 24–36fps，无毛玻璃 58–60fps） | 手工 | — |
| UI-12 | 离线且资源不在缓存里时：页面导航回落到缓存的首页，其他请求返回「Resource not available offline」；新版 Service Worker 装好后立即接管已打开的页面 | 手工 | — |
| UI-13 | 「Install App」按钮固定在右下角，点完或安装完成后自己消失；安装后的 PWA 以独立窗口打开，长按图标有「New Session」快捷方式 | 手工 | — |
| UI-14 | 界面字体与终端字体都本地托管，整站不发任何外部请求；中日韩字符退回系统字体 | 手工 | — |
| UI-15 | 输入框聚焦时去掉系统默认焦点框，改用强调色边框 | 手工 | — |
| UI-16 | 页头左上角是 cc-web 标志：六边形轮廓（青到紫渐变）里一个终端提示符 `>` 和闪烁的光标，两个角上各一个电路节点，后面跟渐变色的「cc-web」字样；手机上只留图形；浅色主题换成更深的一对颜色；系统设置减少动效时光标不闪；只是装饰，不能点（用户 2026-11-06：「帮我设计一个cc-web的图标放那里，要求要有科技感」） | 手工 | — |
## 手机

| ID | 功能 | 入口 | 守卫 |
|---|---|---|---|
| MOB-01 | 「手机模式」判定：有触屏，并且 UA 是手机/平板或窗口宽度 ≤1024px | 手工 | — |
| MOB-02 | 单指上下滑动滚动终端（即使 Claude 开了鼠标跟踪）；小于 8px 算轻点；快速一划带惯性，再按即停；全屏界面里转成滚轮事件；分屏窗格同样可滑；滑动时页面不回弹 | 手工 | — |
| MOB-03 | 悬浮按钮组 ESC（红）、MODE（绿）、→（蓝）：手机上三个都显示，桌面只显示 ESC | `js-control:app.js:Send the Esc key` `js-control:app.js:Cycle permission mode (Shift+Tab)` `js-control:app.js:Send the Right arrow key` | `test/fab-position.test.js` `test/mobile-keys.test.js` |
| MOB-04 | ESC 发送 Esc（点两下即清空输入）；桌面点完焦点回终端，手机不回焦以免弹键盘 | `js-control:app.js:Send the Esc key` | — |
| MOB-05 | MODE 发送 Shift+Tab 切换 Claude 的权限模式，带脉冲动画 | `js-control:app.js:Cycle permission mode (Shift+Tab)` | — |
| MOB-06 | → 发送右方向键（按终端的光标键模式选择序列），用于接受补全或移动光标，替代手机键盘坏掉的右键 | `js-control:app.js:Send the Right arrow key` | `test/mobile-keys.test.js` |
| MOB-07 | 按钮组自动停在 Claude 输入框上方，随输出、键盘、字号变化重新定位；找不到输入框时至少让开最后两行 | 手工 | — |
| MOB-08 | 按住按钮组可以拖动，松手吸附到左或右边；不会盖住标签栏和底部安全区；小于 8px 算点按，拖动后不误触；位置按高度比例记住，旋转后仍在屏幕内；拖过后不再跟随输入框 | `file:src/public/fab-position.js` | `test/fab-position.test.js` |
| MOB-09 | 应用高度跟随可见视口；弹出软键盘时终端不改行数，外框变成停在底部的小窗口，输入框和状态行留在键盘上方；旋转屏幕按真实尺寸变化重新适配 | `file:src/public/viewport-mode.js` | `test/keyboard-viewport.test.js` |
| MOB-10 | 终端比屏幕宽时自动减少列数；强制等于屏宽，不横向滚动 | 手工 | — |
| MOB-11 | 窄屏（≤768px）侧边栏收为左滑抽屉：头部按钮开合、遮罩点击关闭、切到某任务后自动收起；任务列表整列滚动，不再截成两格 + 溢出下拉（2026-10-26 布局改造，用户原话「左边是空间+任务，右边是session+console」） | `control:sidebarToggleBtn` | — |
| MOB-12 | 齿轮按钮在页头右侧（手机和桌面相同；原描述「手机上放在最左边」与实现不符，2026-11-07 按实测更正） | 手工 | — |
| MOB-13 | 手机上各弹窗改为顶部对齐、可滚动的全宽卡片，标题栏和底部按钮固定，按钮至少 44px；新建标签对话框全屏 | 手工 | — |
| MOB-14 | 窄屏上文件浏览器占满屏幕；超小屏（≤480px）隐藏文件大小给文件名让位 | 手工 | — |
| MOB-15 | 整页禁用下拉刷新、横向滚动和浏览器缩放手势（双指捏合、双击放大都不生效）；iOS 加到主屏时全屏显示、状态栏半透明；终端里的数字不会被识别成电话号码；齿轮和弹窗关闭按钮点按时没有灰色高亮（其余元素见 GAP-30） | 手工 | — |
| MOB-16 | 软键盘弹出后终端外框变成可用手指上下滑的小窗口，能把被键盘挡住的行拉出来看，滑到头也不会把整页从键盘下拖走 | 手工 | `test/keyboard-viewport.test.js` |
| MOB-17 | 悬浮键的显隐由屏幕断点决定而非设备判定：把桌面窗口拉窄到 768px 以下，MODE 和 → 也会出现 | 手工 | `test/fab-position.test.js` |
| MOB-18 | 整页禁用浏览器手势：终端上双指捏合不缩放、双击不放大，只允许平移 | 手工 | — |
| MOB-19 | ESC 和 → 按下时也有缩放反馈动画（不只是 MODE 有） | 手工 | `test/mobile-keys.test.js` |
| MOB-20 | 手机上滑动合成的滚轮事件带着手指实际坐标，全屏界面才知道该滚哪一块；拿不到坐标时退到终端正中 | 手工 | — |
| MOB-21 | ≤480px 时 Start 面板的两个按钮改为竖排占满整行；齿轮为 44px 触控区（原 40px，2026-11-07 随 MOB-25 统一）；弹窗最高 85vh；文件行隐藏大小列 | 手工 | — |
| MOB-22 | 手机弹窗里的长列表使用 iOS 惯性滚动；目录列表限 40vh、会话列表限 50vh、每行至少 44px 高 | 手工 | — |
| MOB-23 | 窄屏上文件浏览器的输入框会让位收缩，保证上一级/主页/创建/取消按钮不被挤出屏幕 | 手工 | — |
| MOB-24 | 侧滑菜单 0.3 秒从左滑出并带右侧投影；手机上打开新建标签对话框时锁住页面滚动 | 手工 | — |
| MOB-25 | **手机页头（≤480px）**：一行 `[≡] 任务名/空间名 [＋][💬][⚙]`——隐藏 logo；面包屑两行（上：当前任务名加粗，下：空间名），点它开合任务抽屉；「＋任务」只留图标；所有按钮 44px 触控区；页头固定 48px 高，左右留出刘海屏安全区。文件、分支、账号三个按钮移进 ⚙ 菜单最上方（「账号（用户名）」只在登录时出现），点菜单项等于点原按钮（用户 2026-11-07 同意：「1,同意」——计划第 E 节第 1 项「手机上把 文件 / 分支 / 账号 收进 ⚙ 菜单」）。≤768px 不再显示面包屑里的目录。实测改前：360px 宽账号按钮在屏外、齿轮被截，390px 面包屑宽 0 | `control:accountBtnMenu` `control:explorerBtnMenu` `control:branchBtnMenu` | `test/feature-guards.test.js` |
## Claude 集成

| ID | 功能 | 入口 | 守卫 |
|---|---|---|---|
| CLA-01 | 自动查找 claude 可执行文件（多个常见位置），找不到时退回 PATH 上的 `claude` | `file:src/claude-bridge.js` | `test/claude-bridge.test.js` |
| CLA-02 | 启动参数：模型、权限模式、思考强度按白名单传给 Claude，不在白名单的丢弃；可选跳过权限；浏览器只能传这四个选项，不能覆盖工作目录或 hook 脚本 | `ws-server:start_claude` | `test/start-options.test.js` `test/claude-bridge.test.js` |
| CLA-03 | 手动命名的会话名以 `--name` 传给 Claude（显示在输入框、终端标题并作为对话标题）；自动生成的名字不传 | 手工 | `test/start-options.test.js` |
| CLA-04 | 首次启动用 `--session-id` 绑定对话，之后（包括服务重启后）都用 `--resume` 接续；自己会话的 resume 失败时用同一 id 重建；从历史里选中的对话恢复失败时红字说明，不静默新建；平台用户以前记在自己 Claude 目录（`<数据目录>/<uid>/claude`）里的会话，下次启动时先把这一条对话复制回 `~/.claude` 再接续（只复制不移动，已有的不覆盖） | 手工 | `test/claude-resume.test.js` |
| CLA-05 | 自动确认「是否信任此文件夹」提示 | 手工 | `test/claude-bridge.test.js` |
| CLA-06 | 注入设置：通知走终端响铃（terminal_bell），强制经典渲染器以保留滚动历史 | `env:CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` | `test/renderer-mode.test.js` `test/claude-bridge.test.js` |
| CLA-07 | Claude 主题跟随 UI 的深浅色，使用 cc-web 自带的高对比主题 | `file:src/utils/claude-theme.js` | `test/claude-theme.test.js` |
| CLA-08 | 子进程环境：彩色终端（TERM、FORCE_COLOR、COLORTERM）、同步输出减少闪烁、强制保存对话以便恢复 | `env:TERM` `env:FORCE_COLOR` `env:COLORTERM` `env:CLAUDE_CODE_FORCE_SYNC_OUTPUT` `env:CLAUDE_CODE_FORCE_SESSION_PERSISTENCE` | `test/claude-bridge.test.js` |
| CLA-09 | Hook：ExitPlanMode 计划弹窗、SessionStart 跟踪 /clear 后的新对话、Notification 权限请求触发「待批准」、Stop 报告一轮回答结束（带最后一句回复的前 300 字）；由 `bin/cc-hook.js` 转发，只推送给会话所有者的设备，任何失败都不阻塞 Claude | `hook:PreToolUse` `hook:SessionStart` `hook:Notification` `hook:Stop` `bin:cc-hook.js` `route:POST /api/hooks/:sessionId` | `test/hook-endpoint.test.js` `test/session-start-hook.test.js` |
| CLA-10 | Hook 端点只接受本机回环地址，并校验每个会话单独的令牌；令牌经环境变量传递，不出现在命令行 | `env:CCWEB_HOOK_TOKEN` | `test/hook-endpoint.test.js` |
| CLA-11 | 关闭 Claude 时先发 SIGTERM，5 秒还不退出才 SIGKILL，卡死的进程最终一定被结束 | `ws-server:stop` | — |
| CLA-12 | 信任文件夹的提示不是盲按回车：先读出光标离「Yes, I trust this folder」差几行再按方向键确认；读不出来就把选择留给你（盲按会选中 No 直接退出） | 手工 | `test/claude-bridge.test.js` |
| CLA-13 | 传给 Claude 的标签名先去掉控制字符并截断到 80 字，超长或带控制符的名字不会弄坏终端标题 | 手工 | `test/start-options.test.js` |
| CLA-14 | 注入 `tui: default` 会压过该用户自己 Claude 设置里的 fullscreen，并让 Claude 不再反复询问是否切换渲染器 | `env:CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` | `test/renderer-mode.test.js` |
| CLA-18 | 网页权限卡片（ccweb-companion mod 配套）：mod 把待执行的 Bash 命令 POST 到 hook 端点并挂起等待；网页弹出「Claude 想执行一条命令」卡片，允许/拒绝经 answer 端点回传（只接受会话所有者的应答，别人的返回 404），超时 120 秒自动放行（回退到终端流程）；端口经环境变量告知 mod | `route:POST /api/hooks/:sessionId/answer` `env:CCWEB_HOOK_PORT` `ws-client:app.js:hook_event` | `test/permission-card.test.js` |
| CLA-19 | 所有平台用户（含管理员）的 Claude 都直接用 `~/.claude`，和单用户版一样（用户 2026-11-06：「能不能和main分支一样，共用吗？」，选「完全和 main 一样」）：登录、设置、对话记录、技能、插件、主题全部共用，不设 `CLAUDE_CONFIG_DIR`、不注入任何凭证、不预置 `.claude.json`；以前每人一个目录（`<数据目录>/<uid>/claude`，M3）的做法取消，那里的对话在会话下次启动时复制回 `~/.claude`（见 CLA-04）；`CLAUDE_CONFIG_DIR` 的注入代码保留但不再使用 | `env:CLAUDE_CONFIG_DIR` `file:src/utils/claude-config.js` | `test/claude-config.test.js` |
| CLA-20 | **已停用**（用户 2026-11-06：「能不能和main分支一样，共用吗？」，选「完全和 main 一样」，见 CLA-19：不再给任何用户注入）平台 key：读 `CCW_ANTHROPIC_API_KEY` 环境变量，没有就读 `<数据目录>/platform/anthropic-key` 第一行，每次启动 Claude 时现读（改了文件下次启动就生效，不用重启 cc-web）；注入给每个有自己 Claude 目录的用户（含管理员，用户 2026-11-05「管理员也用平台key」）；服务进程继承来的 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN` 对这些用户一律清掉；没配 key 时不注入，用户在终端里自己 `/login`；配置了平台订阅令牌时改用令牌、不再注入 key（见 CLA-21） | `env:ANTHROPIC_API_KEY` | `test/claude-config.test.js` |
| CLA-21 | **已停用**（用户 2026-11-06：「能不能和main分支一样，共用吗？」，选「完全和 main 一样」，见 CLA-19：所有人直接共用 `~/.claude` 的登录，令牌文件不再读取）所有平台用户共用同一个订阅账号（用户 2026-11-06：「不把个人订阅登录分给平台用户, 这个地方改一下，当前所有人使用同一个订阅用户。」）：管理员用 `claude setup-token` 生成长期令牌，写进 `<数据目录>/platform/claude-oauth-token` 第一行（或环境变量 `CCW_CLAUDE_OAUTH_TOKEN`），每次启动 Claude 时现读，以 `CLAUDE_CODE_OAUTH_TOKEN` 注入给每个有自己 Claude 目录的用户（含管理员），不用 `/login`、额度算在这个订阅上；令牌和平台 key 同时配置时只用令牌（两个都给 Claude 会优先用 key、改按 API 计费）；每人的 Claude 目录、对话记录、技能仍各自独立；令牌和 key 一样，用户在自己终端里能看到 | `env:CLAUDE_CODE_OAUTH_TOKEN` | `test/claude-config.test.js` |
| CLA-15 | 从一个 Claude 会话里启动 cc-web 时会清掉继承来的子会话标记，否则转录不保存、`--resume` 找不到对话 | 手工 | `test/claude-bridge.test.js` |
| CLA-16 | cc-web 自带的两套 Claude 主题写入 `~/.claude/themes/`，平台用户的写入各自 Claude 目录的 `themes/`（第一次为这个用户启动 Claude 时写，原子写）；写不进去就退回内置主题 | 手工 | `test/claude-theme.test.js` |
| CLA-17 | Hook 中继的自保上限：stdin 4 秒不来就放弃、请求 3 秒超时、事件超过 2MB 立即发出，任何情况都以 0 退出，绝不阻塞 Claude | `bin:cc-hook.js` | `test/hook-endpoint.test.js` |
| CLA-23 | 每个 cc-web 启动的 Claude 默认加载仓库自带的 ccweb-companion mod（`mods/ccweb-companion`，`--plugin-dir` 传入；mod 目录不在时不加，Claude 照常启动）。mod 只观察会话间消息（SendMessage）并给正文加/剥线程标记 `[ccw:t=…]`，经 hook 端点上报；不批准、不拒绝、不扣住任何消息；上报失败时消息照常收发（用户 2026-11-11：选「同意，默认开启」）。cc-web 会话 id 经环境变量告知 mod | `env:CCWEB_SESSION_ID` | `test/claude-bridge.test.js` |
| CLA-22 | 共享 Playwright MCP：cc-web 启动时（之后每分钟检查一次）若本机 8931 端口没人监听，就脱离自身起一个 `npx @playwright/mcp --port 8931 --isolated`，所有 Claude 通过用户级 HTTP MCP（`http://localhost:8931/mcp`）共用这一个进程，每个连接各自独立的浏览器上下文；cc-web 重启不影响它，32352/32353 谁先起谁负责；端口可用 `CCW_SHARED_PLAYWRIGHT_PORT` 改（0 关闭）。Claude 一侧的配置（关掉 playwright 插件、加用户级 http 条目）不在 cc-web 代码里（用户 2026-11-07） | `file:src/shared-mcp.js` | `test/shared-mcp.test.js` |

## 会话间派活

| ID | 用户能看到的 | 入口 | 守护测试 |
|---|---|---|---|
| PEER-01 | 派活线程：一个任务用 SendMessage 交给另一个任务的活，按 owner 存成一条线程（`<数据目录>/<uid>/peer-threads.json`，最多 200 条），状态链 已发送 → 已送达 → 等待批准 → 处理中 → 空闲 → 已回复，只进不退；被拒、过期、送不到为终态；对方用 SendMessage 回给发送方（按会话、名字或消息带来的 from 地址认）挂在原线程下；"等待批准 / 空闲"由 Claude 自己发给发送方的 delivery / idle 通知识别；只看得到自己的线程 | `route:GET /api/peer-threads` `file:src/peer-messages.js` | `test/peer-messages.test.js` |
| PEER-02 | 页头「Hand-offs」按钮（带未读数；≤480px 移进 ⚙ 菜单）打开右侧抽屉，"This task / All tasks" 两档；发送方和接收方看到同一张卡片：全文（长的折叠可展开）、状态链、回复挂在下面、文件:行号可点（相对路径按接收任务的工作目录解析，用文件浏览器打开）；按钮只有「Go to recipient / Show terminal / Go to sender / Copy as prompt」——批准只在接收方自己的终端里做，网页不提供任何批准/拒绝入口（用户 2026-11-11：选「留在接收方终端」） | `control:peerThreadsBtn` `control:peerThreadsBtnMenu` `control:closePeerThreadsBtn` `control:peerScopeTask` `control:peerScopeAll` `file:src/public/peer-threads.js` | `test/feature-guards.test.js` |
| PEER-03 | 派活有进展（等待批准、对方空闲、已回复、被拒、过期、送不到）时提醒发送方：页面在前台弹 toast，在后台发浏览器通知，发送方任务行上出现「Hand-off」标记，抽屉打开看过后消失 | `state:peer` | `test/feature-guards.test.js` |
| PEER-04 | 任务菜单「Hand off to…」：选目标任务（显示空间、空闲/忙/已停、权限模式；两边模式不同会提示"对方会扣住等批准"），写要做的事，勾「Notify me when it is idle」；发送时把内容交给**本任务自己的 Claude** 用 SendMessage 发出（用户 2026-11-11：选「交给发送方自己的 Claude 发」），网页自己不向对方发任何东西；菜单里还有「Hand-offs」直接打开本任务的线程 | `control:handoffTarget` `control:handoffText` `control:handoffNotify` `control:sendHandoffBtn` `control:cancelHandoffBtn` `control:closeHandoffBtn` | `test/feature-guards.test.js` |

## 上下文与用量

| ID | 功能 | 入口 | 守卫 |
|---|---|---|---|
| CTX-01 | 标签名前的小圆环显示 Claude 上下文窗口的占用：低于 60% 绿、60–85% 琥珀、85% 及以上红；悬停显示占用百分比、已用与窗口 Token、本次运行 Claude 的花费（Claude 自己的计数，每次启动或恢复从 0 算起；标注「API 折算」）、模型、5 小时与 7 天额度；还没有数据时不显示；刷新页面、重开标签或重启服务后立即恢复上次的值；分屏窗格里的会话同样更新 | `file:src/public/context-ring.js` | `test/context-ring.test.js` `test/statusline.test.js` |
| CTX-02 | Claude 的 statusLine 由 cc-web 注入的中继接管，每次刷新（启动时与每轮结束时）把快照回传给服务器，数值变了才推给浏览器；用户自己配置的 statusLine（项目 `settings.local.json`、项目 `settings.json`、用户 Claude 目录的 `settings.json`，取最具体的那个）照常运行，输出原样显示在终端底部，`padding` 保留 | `bin:cc-statusline.js` `env:CCWEB_USER_STATUSLINE` | `test/statusline.test.js` `test/claude-bridge.test.js` |
| CTX-04 | 「上下文与用量」面板：点标签上的圆环或标签右键菜单「上下文与用量」打开「本标签」页（菜单里的「用量」打开「总览」页，两页可切换，「本标签」是当前标签）；读这个标签当前对话的记录（`/clear` 后跟到新对话），显示请求数、总 Token（悬停看输入/缓存读/缓存写/输出）、缓存命中率、估算花费（标注「API 折算」，模型没有价格的请求不计入并注明）、时长、子 Agent 个数与用量；还没有对话记录时说明原因；可刷新，点遮罩或关闭按钮关闭 | `control:usageBtnMobile` `control:closeUsageBtn` `control:usageRefreshBtn` `control:usageDoneBtn` `control:usageTabSession` `route:GET /api/sessions/:sessionId/usage` `file:src/public/usage-panel.js` | `test/usage-panel.test.js` `test/claude-usage.test.js` |
| CTX-05 | 面板里的「当前上下文」条：最近一次请求的上下文按缓存读/缓存写/新输入分色，知道窗口大小时按窗口比例画并显示剩余与百分比；「每个请求的上下文」趋势图：每个请求一根柱，「总量」按来源堆叠、「增量」显示比上一个请求涨了或缩了多少（缩为红色向下）；压缩处画红色虚线和 ✂，悬停显示自动或手动与压缩前大小；悬停柱子看该请求的时间、各部分 Token、输出与模型；超过 2000 个请求只画最近的并注明；打开或刷新时滚到最新一端，切换总量与增量时保持阅读位置 | `file:src/public/usage-panel.js` | `test/usage-panel.test.js` |
| CTX-06 | 面板里的排行：工具、Bash 程序（跳过 `cd`、环境变量与 sudo，带空格的带引号路径也认得）、读改写过的文件（显示末两级路径，悬停看全路径与读/改/写次数）、技能与斜杠命令，各取前 15 | `file:src/public/usage-panel.js` | `test/claude-usage.test.js` `test/usage-panel.test.js` |
| CTX-07 | 读对话记录的方式：同一个响应拆成多条记录时按消息 id 只算一次；只解析可能有用的行，几十 MB 的记录也只要零点几秒（41MB 实测约 0.2 秒）；记录只会增长，之后只读新增部分（实测约 1 毫秒），被替换或变短时从头读；子 Agent 记录（`<对话>/subagents/`）单独汇总；读 `~/.claude`（所有用户共用）；历史对话也可按 `GET /api/claude-sessions/:id/usage?dir=` 读取，目录按浏览范围校验 | `route:GET /api/claude-sessions/:conversationId/usage` `file:src/utils/claude-usage.js` | `test/claude-usage.test.js` |
| CTX-08 | 「总览」页：`~/.claude` 下的全部对话（所有用户共用；只能浏览部分目录的普通用户只看到这些目录里的对话，用户 2026-11-06：「能不能和main分支一样，共用吗？」，选「完全和 main 一样」），可选 7 天 / 30 天 / 全部；对话数、请求、Token、缓存命中、估算花费（API 折算）；每日用量柱状图（7 天按天、30 天与全部为最近 30 天，悬停看 Token、请求数与花费），按请求发生的那天（浏览器本地日期）计，不按文件修改时间；最近 8 周的热力图（按周一到周日排，按活跃日四分位分四档，悬停看当天用量）；这些对话累计的工具、Bash 程序、技能与斜杠命令排行 | `control:usageTabOverview` `route:GET /api/usage/overview` | `test/usage-overview.test.js` |
| CTX-09 | 「总览」里的对话列表：标题（自己起的名字优先，其次 Claude 的标题，再次第一句提问）、目录、多久以前、Token、花费；可按最近 / Token / 花费排序，搜索框即输即筛（标题或目录），刷新与轮询时保留搜索和滚动位置；已在标签中打开的标「已打开」，点击切换过去；没打开的点击在新标签中继续这段对话（与 Sessions 面板同一方式）；超过 300 个只列前 300 并注明 | `file:src/public/usage-panel.js` | `test/usage-overview.test.js` |
| CTX-10 | 第一次扫描很大的 Claude 目录时先返回已读完的部分并显示「正在读取对话记录（已读 / 总数）」，每 1.5 秒再取一次直到读完；之后只读新增部分（本机 157 个、332MB 记录实测：冷读约 1.1 秒，再读约 30 毫秒）；关掉面板就停止轮询 | `route:GET /api/usage/overview` | `test/usage-overview.test.js` |
| CTX-11 | 「总览」按账号统计（用户 2026-11-06：「加上按账号统计」）：「按账号」一栏列出每个 cc-web 账号在所选时间内的对话数、Token（带占比条）和花费（API 折算），按 Token 从大到小；`全部 / 我的` 切换，管理员还能点某个账号（或「不在 cc-web 里」）只看它，页面其余部分随之筛选，「全部」时对话行标出所属账号；普通用户只看到自己和合并的「其他账号」，不能选别的账号。对话属于哪个账号由 cc-web 记录：会话每次启动 Claude 和切换对话（/clear）时把对话 id 和会话所有者写进 `<数据目录>/platform/conversation-owners.json`（先记的为准，关掉标签也保留）；没记录的按当前占用它的会话；都没有的（本机命令行、32352、记录之前就关掉的标签）算「不在 cc-web 里」 | `route:GET /api/usage/overview` `file:src/utils/conversation-owners.js` | `test/usage-overview.test.js` `test/claude-config.test.js` |
| CTX-03 | statusLine 中继的自保上限：回传 1 秒超时、用户命令 5 秒超时、整体 6 秒内必定结束，任何失败都以 0 退出、不输出 cc-web 自己的内容，绝不拖住 Claude 的界面 | `bin:cc-statusline.js` | `test/statusline.test.js` |

## 服务端、安全与持久化

| ID | 功能 | 入口 | 守卫 |
|---|---|---|---|
| SRV-01 | 首页和静态资源无需认证即可加载 | `route:GET /` | — |
| SRV-02 | 认证默认开启：REST 认登录 Cookie 或 Authorization 请求头里的启动令牌（不认查询参数里的令牌），WebSocket 认同源的登录 Cookie 或 URL 里的令牌；`/auth-status` 查询是否需要认证、是否已登录、当前用户、是否还需创建管理员，`/auth-verify` 校验启动令牌，已有管理员时同时以管理员身份签发登录 Cookie；启动令牌（请求头、WebSocket、链接、`/auth-verify`）同一地址一分钟内猜错 10 次后，这一分钟内连正确的令牌也拒绝（REST 返回 429，WebSocket 拒绝连接），不带令牌或链接里的 `-` 不计数 | `route:GET /auth-status` `route:POST /auth-verify` | `test/feature-guards.test.js` |
| SRV-03 | 登录框：用户名 + 密码登录，可切换为「用访问令牌登录」；还没有任何用户时先输启动令牌，再设置管理员用户名和密码（两次密码须一致）；空值、验证中、密码或令牌错误都有提示；成功后刷新；登录靠 HttpOnly Cookie 保持，页面里不保存令牌，重启服务、新开标签页都不用重新登录；`?token=` 链接仍可登录并立即从地址栏去掉；任何接口 401 时弹出登录框 | `file:src/public/auth.js` | — |
| SRV-04 | 异步路由出错返回 500，不会让服务崩溃带走所有终端 | 手工 | `test/async-route-safety.test.js` |
| SRV-05 | 会话按每个一个文件保存（平台用户的会话存在 `<数据目录>/<uid>/sessions/`，按归属分别保存与恢复；还没有管理员时仍在数据目录根下），每 30 秒自动保存；服务重启后自动恢复；7 天没有活动的会话自动清除；损坏文件跳过不影响其他；写入用临时文件加原子重命名 | `route:GET /api/sessions/persistence` `file:src/utils/session-store.js` | `test/session-store.test.js` |
| SRV-06 | 同一数据目录已有别的实例在运行时拒绝启动；实例锁文件权限 0600，退出时删除 | `file:src/instance-lock.js` | `test/instance-lock.test.js` |
| SRV-07 | 新建会话：名称、工作目录可选（不给时用自己的第一个可浏览目录；普通用户的工作目录必须在可浏览目录内，见 ACC-07）；`resumeId` 接续已有对话（在 `~/.claude` 里找；非法 UUID 400，已在别的标签 409，不存在 404）；新会话归创建者所有；要接续的对话正被其他用户的会话占用时同样 409，但不返回对方的会话 id，提示「其他用户正在使用这个对话」 | `route:POST /api/sessions/create` | `test/claude-resume.test.js` `test/session-create-guard.test.js` |
| SRV-08 | 查看会话详情（只限自己的会话，别人的按不存在处理返回 404）、健康检查（会话数与连接数只算自己的） | `route:GET /api/sessions/:sessionId` `route:GET /api/health` | — |
| SRV-09 | 删除会话（只能删自己的，别人的返回 404）：停止 Claude，通知连着这个会话的客户端（都是会话所有者自己的设备），删除上传图片目录和会话文件，不删 Claude 自己的对话记录 | `route:DELETE /api/sessions/:sessionId` | — |
| SRV-10 | 计划文件服务：已登录的浏览器靠 Cookie 认证，URL 里的令牌段为 `-`；仍接受 URL 里带启动令牌的旧链接；以 text/plain 返回便于 Markdown 插件渲染；白名单为 `.claude/plans/` 与全局或会话计划目录中的 .md，按真实路径校验，上限 2MB | `route:GET /api/plan` `route:GET /api/plan/:token/:file` `route:GET /api/plan/:token/:session/:file` | `test/plan-file.test.js` `test/plan-dirs.test.js` |
| SRV-11 | 文件服务的安全：.html/.svg 默认只显示源码，渲染需一次性票据（30 秒、用一次即失效）；渲染时放进无网络的沙箱；统一 nosniff、no-referrer；中文文件名 | `route:GET /api/fs/file/:token/:file` `route:POST /api/fs/ticket` `file:src/utils/inline-assets.js` | `test/fs-browse.test.js` `test/inline-assets.test.js` |
| SRV-12 | 选择或设置工作目录、清除已选目录（旧接口）（普通用户只限自己的可浏览目录，越界 403，见 ACC-07） | `route:POST /api/set-working-dir` `route:POST /api/folders/select` `route:POST /api/close-session` | — |
| SRV-13 | 加入会话不再强制重绘，避免出现两个输入框 | 手工 | `test/pty-repaint.test.js` |
| SRV-14 | 服务端入口与会话多路复用：Express + WebSocket 服务 | `file:src/server.js` | — |
| SRV-15 | 会话文件损坏时改名留档而不是删除，同时跳过它继续恢复其他会话（在各用户自己的会话目录里同样如此） | 手工 | `test/session-store.test.js` |
| SRV-16 | 从旧版升级时单文件的 sessions.json 自动拆成每会话一个文件，原文件原样保留可回退；交给管理员之后（见 SRV-28）不再读取数据目录根下的旧文件，已删除的会话不会被它带回来 | 手工 | `test/session-store.test.js` |
| SRV-17 | 会话数据目录按 0700 创建（每个平台用户的 `<uid>/` 目录也是），同机其他用户看不到你的会话内容和滚动历史；认证令牌写进 0600 的实例锁文件而不是命令行 | 手工 | `test/instance-lock.test.js` |
| SRV-18 | 自动保存只写自己认识的会话、并写进会话所有者自己的目录，从不删除数据目录里别人的会话文件（别的实例的、别的用户的都一样）；上次崩溃留下的实例锁下次启动自动清理 | 手工 | `test/session-store.test.js` `test/instance-lock.test.js` |
| SRV-19 | 撞上同数据目录的其他实例时，控制台列出对方端口、pid、启动时间并提示设 `CCW_DATA_DIR`，然后退出 | 手工 | `test/instance-lock.test.js` |
| SRV-20 | 一次性票据最多同时保留 200 个，超出丢弃最旧的；每张 30 秒过期且用一次即失效 | `route:POST /api/fs/ticket` | `test/fs-browse.test.js` |
| SRV-21 | 计划链接只在自己的会话范围内查找：指定会话时必须是自己的会话，不指定时只合并自己会话的工作目录；计划链接里的 `~/…` 会展开成家目录绝对路径；不在白名单、超过 2MB 或不是 .md 的一律 404（不泄露文件存不存在） | `route:GET /api/plan` | `test/plan-file.test.js` |
| SRV-22 | 退出时除保存会话（各自写进所有者的目录）外，还会停掉所有正在跑的 Claude 进程并清理定时器 | 手工 | — |
| SRV-23 | 数据目录默认在 `~/.cc-web/data`（`~/.cc-web` 按 0700 创建）；首次启动把旧布局的 `~/.claude-code-web` 一次性原子迁入，迁移失败则继续用原目录、绝不抛错；有平台用户后，每个用户的数据在其中的 `<uid>/` 子目录（会话、空间、历史保留量），用户与登录会话在 `platform/` | `file:src/utils/data-dir.js` | `test/data-dir.test.js` |
| SRV-24 | 用户名 + 密码登录：成功后签发 HttpOnly、SameSite=Strict 的登录 Cookie，30 天有效、使用中自动续期（服务端续期时同时重发 Cookie），服务重启后仍然有效；经 https 访问（含 ngrok 或本机代理转发的 https）时 Cookie 带 Secure；密码错误、用户不存在、账号停用一律答「Invalid username or password」；同一地址每分钟最多 10 次、同一用户名每分钟最多 50 次（被地址限流挡下的请求不计入用户名），超出返回 429；经 ngrok 或本机反向代理访问时按 X-Forwarded-For 识别地址；`/api/auth/me` 返回当前用户（含是否必须先改密码）；用临时密码登录后，在改掉密码之前除 `/api/auth/*` 外的请求一律 403、WebSocket 拒连（见 ACC-03） | `route:POST /api/auth/login` `route:GET /api/auth/me` `file:src/utils/password.js` `file:src/utils/cookies.js` | `test/auth-login.test.js` |
| SRV-25 | 退出登录：服务端作废这个登录会话并清除 Cookie，同时关闭用这个登录打开的 WebSocket（其他标签页里的终端随之断开）；入口在菜单「账号」里的「退出登录」（见 ACC-05）| `route:POST /api/auth/logout` | `test/auth-login.test.js` |
| SRV-26 | 首次创建管理员：还没有任何用户时，凭启动令牌设置第一个账号（用户名 2–32 位字母数字 `_ . -`，密码至少 8 位），它就是管理员并直接登录；已有用户后此接口返回 409；启动时控制台提示「用这个令牌创建管理员」 | `route:POST /api/auth/setup` | `test/auth-login.test.js` |
| SRV-27 | 用户与登录会话的存储：`<数据目录>/platform/` 下每个用户、每个登录会话各一个文件（0600，原子写）；密码只存 scrypt 加盐哈希，登录会话只存 Cookie 值的 SHA-256；Cookie 名带端口（`ccw_sid_<端口>`），同机的 stable 和 dev 互不顶掉登录；带 Cookie 的跨站写请求和跨站 WebSocket 一律拒绝（403）；邀请码在 `platform/invites/` 每个一个文件；用户目录有变化（`cc-web user` 在服务运行时改的）就重读，不用重启；改密码 / 重置 / 停用时记下 `sessionsValidAfter`，之前签发的登录一律失效，它们打开的 WebSocket 在 30 秒内（随自动保存）断开、停用用户的 Claude 停止 | `file:src/utils/user-store.js` | `test/auth-login.test.js` |
| SRV-28 | 单用户数据交给第一个管理员：有管理员后（服务启动时，或第一个管理员刚建好时），数据目录根下原有的会话文件逐个 rename 进管理员的 `<uid>/sessions/`、`spaces.json` 一并移过去、`scrollback.json` 复制过去（原文件保留），内存里的会话与空间改归管理员；只移不删，移不动的留在原处、下次自动保存照样写进管理员目录；写 `migrated-to-admin.json` 标记，只做一次；关闭认证（`--disable-auth`）时不做 | 手工 | `test/multi-user-data.test.js` |
## 账号与用户管理

| ID | 功能 | 入口 | 守卫 |
|---|---|---|---|
| ACC-01 | 页头最右边显示当前用户（只有人像图标，44px 触控区、24px 图标，和旁边图标一样大；用户名在悬停提示里——用户 2026-11-09：「把用户图标+admin中的admin去掉。只要用户图标，注意图标大小要一致」；≤480px 移进 ⚙ 菜单的「账号（用户名）」，见 MOB-25），点它弹出「账号」窗口（标题带用户名，下面写角色）；管理员的菜单里有「用户管理」；用令牌访问或关闭认证时都不显示（用户 2026-11-06：「个人账号，不应该放在setting弹窗，应该在Header的右上角」） | `control:accountHeaderBtn` `control:usersBtnMobile` `file:src/public/account.js` | 手工 |
| ACC-02 | 用户管理（管理员）：列出所有用户（角色、停用、待改密码、可浏览目录、登录设备数、运行中会话数、最近使用）；新建用户时选角色，服务端生成一次性临时密码，只在这一次显示、可复制；设为管理员 / 普通用户、停用 / 启用、重置密码（新临时密码）、删除都带确认；非管理员调 `/api/admin/*` 一律 403 | `control:closeUsersBtn` `control:usersTabUsers` `control:usersNewName` `control:usersNewRole` `control:usersCreateBtn` `key:account.js:Escape` `route:GET /api/admin/users` `route:POST /api/admin/users` `route:PATCH /api/admin/users/:id` `route:POST /api/admin/users/:id/reset-password` `route:DELETE /api/admin/users/:id` `file:src/account-routes.js` | `test/account-admin.test.js` |
| ACC-03 | 首次登录强制改密码：管理员新建或重置出来的临时密码登录后，弹出不能关闭的「请先修改密码」框（当前密码 + 新密码两次，可选退出登录）；改好之前服务端拒绝其他所有请求和 WebSocket | `route:POST /api/auth/password` | `test/account-admin.test.js` |
| ACC-04 | 停用、删除、重置密码立即生效：吊销对方全部登录、断开对方的 WebSocket、停止对方正在运行的 Claude（会话本身保留）；删除账号只删账号，数据目录 `<uid>/` 留在磁盘上；不能停用、删除、降级、重置自己，也不能让系统里没有可用的管理员 | `route:DELETE /api/admin/users/:id` | `test/account-admin.test.js` |
| ACC-05 | 账号（每个登录用户）：修改密码（当前密码 + 新密码两次；成功后其他设备退出，这台保持登录）；登录设备列表（浏览器 · 系统、地址、登录时间、最近使用，标出「本机」），可单独退出别的设备并断开它的终端；退出登录 | `control:closeAccountBtn` `control:accountCurrentPassword` `control:accountNewPassword` `control:accountNewPassword2` `control:accountChangePasswordBtn` `control:accountLogoutBtn` `route:GET /api/auth/devices` `route:DELETE /api/auth/devices/:id` | `test/account-admin.test.js` |
| ACC-06 | 邀请码：管理员选注册后的角色和有效天数（默认 7 天，1–90）生成邀请链接 `/?invite=<码>`（生成后自动复制）；列表可复制、作废；对方打开链接看到「注册账号」，填用户名和两次密码后直接登录；每个码只能用一次，用户名被占用等失败时码不作废；过期的自动清掉；注册与登录同样限流 | `control:usersTabInvites` `control:invitesRole` `control:invitesDays` `control:invitesCreateBtn` `route:GET /api/admin/invites` `route:POST /api/admin/invites` `route:DELETE /api/admin/invites/:code` `route:POST /api/auth/register` | `test/account-admin.test.js` |
| ACC-07 | 可浏览目录（rootDirs）：管理员不限；普通用户只能在自己的可浏览目录里浏览、建会话 / 空间、建文件夹、上传、删除、打开文件、拉取 git（按真实路径判断，符号链接跳不出去），越界一律 403「超出你可以访问的目录范围」；管理员没给设置时默认 `<数据目录>/<uid>/workspace`（第一次用到时创建）；管理员在用户管理里按行编辑（必须是存在的绝对路径目录）。这只是界面上的范围，不是安全边界：Claude 本身仍能访问整台机器（已接受，见升级计划第 3 节） | 手工 | `test/account-admin.test.js` |

## 命令行

| ID | 功能 | 入口 | 守卫 |
|---|---|---|---|
| CLI-01 | `cc-web` 启动服务，默认端口 32352；端口非法时报错退出 | `cli:--port` `bin:cc-web.js` | — |
| CLI-02 | 默认启动后打开浏览器，`--no-open` 关闭 | `cli:--no-open` | — |
| CLI-03 | 令牌来源：`--auth-file`（推荐）> 环境变量 `CCWEB_AUTH` > `--auth`（会警告 /proc 可见）；都没有时自动生成随机令牌，认证保持开启 | `cli:--auth` `cli:--auth-file` | `test/instance-lock.test.js` |
| CLI-04 | `--disable-auth` 关闭认证，并打印警告 | `cli:--disable-auth` | — |
| CLI-05 | `--https --cert --key` 启用 HTTPS | `cli:--https` `cli:--cert` `cli:--key` | — |
| CLI-06 | `--dev` 输出更多日志 | `cli:--dev` | — |
| CLI-07 | `--ngrok-auth-token` 与 `--ngrok-domain` 一起开启公网隧道；只给一个时报错；隧道失败不影响服务 | `cli:--ngrok-auth-token` `cli:--ngrok-domain` | — |
| CLI-08 | `--plans-dir` 或环境变量 `CCW_PLANS_DIR` 预置全局计划目录 | `cli:--plans-dir` | `test/plan-dirs.test.js` |
| CLI-09 | `CCW_DATA_DIR` 指定数据目录，两个实例靠它隔离（目录里各平台用户的数据在 `<uid>/` 子目录） | 手工 | `test/instance-lock.test.js` |
| CLI-10 | Ctrl+C / SIGTERM 优雅退出：保存会话（各自写进所有者的目录）、撤下实例锁、关闭隧道 | 手工 | — |
| CLI-11 | `--https` 只给一个证书参数时启动失败并说明原因；`--auth-file` 指向的文件读不了或为空时打印原因退出，不会悄悄改用随机令牌 | `cli:--https` `cli:--auth-file` | `test/instance-lock.test.js` |
| CLI-12 | 版本查询的耐用性：`claude --version` 5 秒超时、npm 查询 8 秒超时且最多读 64KB、结果缓存 6 小时而失败不缓存；查不出来时显示未知而不是谎报已是最新 | `route:GET /api/version` | `test/version-info.test.js` |
| CLI-13 | `cc-web user list|add|passwd|disable|enable|role` 管理平台用户（`--data-dir` 或 `CCW_DATA_DIR` 指定实例）；`add` 和 `passwd` 打印一次性临时密码、第一次登录必须改；服务运行中也能用，改动立即生效（见 SRV-27）；不能停用或降级最后一个可用的管理员 | `file:src/user-cli.js` | `test/account-admin.test.js` |
## 已知缺陷与未接入（只登记，未修；修不修由用户决定）

| ID | 功能 | 入口 | 守卫 |
|---|---|---|---|
| GAP-01 | （2026-11-05 部分修复）`src/utils/auth.js` 的限流器已接到登录和创建管理员接口（同一地址每分钟 10 次、同一用户名每分钟 50 次，超出返回 429 和提示）；其余接口仍不限流，与 CLAUDE.md 说的「按 IP 限流」不符 | `file:src/utils/auth.js` | — |
| GAP-02 | 令牌来自 `--auth-file` 或 `CCWEB_AUTH` 时，控制台仍把它当作「生成的令牌」打印出来 | 手工 | — |
| GAP-03 | 菜单里的「Clear Terminal」没有绑定事件，点了没反应；「Reconnect」一直禁用；「Close Session」一直隐藏 | `control:clearBtnMobile` `control:reconnectBtnMobile` `control:closeSessionBtnMobile` | — |
| GAP-04 | 设置里历史保留量的单位文字仍写着「chunks」，和标签上的 MB 对不上 | 手工 | — |
| GAP-05 | 分屏时图片粘贴或拖放不生效 | 手工 | — |
| GAP-06 | CLAUDE.md 的 WebSocket 协议里列了 `close_session`，但代码里没有这个消息（文档与代码不符，不影响使用） | 手工 | — |
| GAP-07 | 设置弹窗不支持 Esc 关闭 | 手工 | — |
| GAP-08 | 分屏窗格没有响铃声和通知，也不做写入合并和限流 | 手工 | — |
| GAP-09 | **已修复（2026-09-23）**：原来切换标签后，设置弹窗标题仍显示上一个会话的名字；现在标题取自标签栏里当前会话的名字，切换和重命名后都正确 | 手工 | `test/feature-guards.test.js` |
| GAP-10 | **已修复（2026-09-23）**：原来计划弹窗的提示音从来不响（内嵌的 wav 数据被截断，浏览器无法解码）；现在改用与终端响铃相同的 WebAudio 提示音（660Hz，比响铃低一些以便区分） | 手工 | `test/feature-guards.test.js` |
| GAP-11 | 后台标签或分屏窗格里的会话报错时，会弹出全屏错误覆盖层打断你，而且「出错」标记打在**当前**标签上，不是真正出错的那个 | `ws-client:app.js:error` | — |
| GAP-12 | 后台会话的 Claude 被停止时，黄色的「Claude stopped」写进你正在看的那个终端，并强行弹出 Start 面板 | `ws-client:app.js:claude_stopped` | — |
| GAP-13 | 计划弹窗的 Accept/Reject 把回车或 Esc 发给**当前可见**会话：计划来自后台标签或分屏窗格时，按键会打进错误的会话 | 手工 | — |
| GAP-14 | 计划弹窗只能用 × 关闭，按 Esc 或点背景都没反应 | `control:closePlanBtn` | — |
| GAP-15 | **已修复（2026-11-07）**：原来「Restore sessions」对话框没有任何关闭方式（没有 ×、点背景和 Esc 都不关），只能点 Open 或「+ New session」；现在三种方式都能关，关闭不改变任何任务的打开/忽略状态（见 START-05） | 手工 | `test/feature-guards.test.js` |
| GAP-16 | 重命名标签或关闭标签时，发给服务器的请求失败没有任何提示：界面已经改了，刷新后又变回去 | 手工 | — |
| GAP-17 | （已随 2026-10-26 侧边栏布局消亡）原缺陷：收进「⋮」溢出菜单的标签只剩名字和 ×，看不到状态圆点、未读、✓ 答完和「待批准」徽章。溢出菜单被空间侧边栏取代（MOB-11），任务行整列显示全部 marks，缺陷不复存在 | `手工` | — |
| GAP-18 | 标签的 × 和分支行的拉取按钮都是悬停才显形，触屏没有悬停：手机上标签还能从溢出菜单关掉，拉取按钮则完全点不到 | 手工 | — |
| GAP-19 | 系统开启「减少动效」后，运行中的绿色脉冲、未读蓝闪、加载转圈仍在动（只覆盖了转球、✓、待批准和拉取图标） | 手工 | — |
| GAP-20 | 计划弹窗声明了 fadeIn 淡入动画，但样式表里没有这个关键帧，淡入从未发生过 | 手工 | — |
| GAP-21 | 服务端对所有来源开放跨域访问，且校验令牌的接口没有任何限速或失败锁定 | 手工 | — |
| GAP-22 | 全局计划目录实际上只能靠 `--plans-dir` / 环境变量或手工改文件：代码只读 `plan-dirs.json`、从不写它（CLAUDE.md 里「运行时可编辑」的说法与代码不符） | 手工 | — |
| GAP-23 | 分屏窗格的连接断掉后没有任何提示，也不自动重连，窗格就停在那里 | 手工 | — |
| GAP-24 | 分屏窗格加入会话时不重置终端（卡在备用屏幕的会话在窗格里救不回来）、不过滤焦点上报序列、右键会选中单词 | 手工 | — |
| GAP-25 | 切回一个已经打开过的标签时，不会重新套用该会话保存的字号和主题（只有首次加入会话才套用） | 手工 | — |
| GAP-26 | 点分屏窗格把它变成当前标签时不写入标签状态，刷新后当前标签仍是原来那个 | 手工 | — |
| GAP-27 | Sessions 面板里「本目录下的对话」加载失败时不报错，直接显示成「没有历史对话」，看不出是失败了 | 手工 | — |
| GAP-28 | 双击标签不改名直接回车，也会把标签上显示的文件夹名保存成「自定义名」，此后会以 `--name` 传给 Claude | 手工 | — |
| GAP-29 | 标签快捷键在输入框里也生效：在重命名框或新建对话框的名称框里按 Ctrl/Cmd+W，会关掉并删除当前会话 | 手工 | — |
| GAP-30 | 「点按没有灰色高亮」只加在齿轮按钮和弹窗关闭按钮上，标签、列表行、悬浮键在 Android 上点按仍会闪灰底（MOB-15 的描述过宽，已改窄） | 手工 | — |
## 建清单的比对记录

2026-09-22 首版，由两路独立来源合并：

- **路线 A**：`scripts/feature-surfaces.js` 扫出 203 个入口，加上 code-graph 从 `buildView`、`setupTerminal`、`handleMessage`、`init`、`createTerminal`、`addTab`、`switchToTab`、`closeSession`、`openNewTabDialog`、`setupSettings` 往下查到的调用，以及约 440 个函数的清单。
- **路线 B**：5 个只读子代理按区域逐个文件读代码（终端 90 条、标签/会话 120 条、面板 95 条、服务端 110 条、手机 80 条，互有重叠）。
- **只有一路发现的项**：
  - 只在 A：WebSocket 的 `detach_size`（TERM-22）、`pause`/`resume`（TERM-19）、`wire:registerPlanLinks` 两处调用点（TERM-13）。
  - 只在 B：中键关闭标签（TAB-04）、右键「Close Others」（TAB-05）、Alt+1…9（TAB-12）、通知权限提示（NOTI-01）、完成字样通知（NOTI-07）、焦点序列过滤（TERM-20）、离线 503（UI-06）、GAP-01～08 这 8 项缺陷。
  - 以上各项都已逐条回到代码复核，确认存在。
- **还没做到的**：第一版仍可能漏掉「没有明显入口」的行为，需要用户过目补充。
