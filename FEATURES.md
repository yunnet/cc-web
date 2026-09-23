# 功能清单

cc-web 里**每一项用户能感知到的功能**都登记在这里。规则：

- **未经用户明确同意，不得删除或弱化任何一项。** 删除一行，或者把某行的「功能」描述改弱，都必须在对应的开发计划里**原样引用用户的原话并注明日期**作为同意记录。发布脚本 `deploy-32352.sh` 会对比线上版本与待发布版本的清单：有条目被删就中止发布，描述有改动就列出来给用户看。
- **新增功能必须在同一个提交里登记一行。** `test/features.test.js` 会双向核对：代码里新增的入口没有登记，测试失败；登记过的入口在代码里找不到了，测试也失败。
- **ID 永不复用。** 删掉的 ID 不再分配给别的功能。
- 「入口」一栏是 `scripts/feature-surfaces.js` 能扫描出的键（`kind:key`），或 `file:<路径>`（这个功能所在的文件，没有更具体的入口时用）。`手工` 表示扫描不到，只能靠人和冒烟清单（`test/SMOKE.md`）来守。
- 「守卫」一栏是守住这项功能的测试文件；`—` 表示还没有，待补。

查某个文件上挂着哪些功能：`node scripts/feature-surfaces.js --file <path>`，再在本文件里搜索对应的键。

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
| TERM-33 | 终端向上翻看历史时，右下角出现一个圆形按钮，点一下回到最新一屏并把键盘焦点还给终端；回到底部后按钮自动消失。主终端和分屏窗格都有，按钮作用于当前在看的那个终端；手机上按钮更大并让开右边的悬浮按钮 | `control:scrollBottomBtn` | `test/feature-guards.test.js` |
| TERM-32 | Claude 输出的超链接（OSC 8）可以点击：网址在新标签页打开，计划文件按计划链接打开，其他本机文件用文件浏览器预览；`javascript:`、`data:`、外部主机的 `file:` 等一律不响应；不弹 xterm 的「危险链接」确认框。Markdown 链接只显示链接文字、不再显示「(url)」（用户 2026-09-22 同意：「链接也同意」） | `env:FORCE_HYPERLINK` `xterm:app.js:linkHandler` `xterm:splits.js:linkHandler` `file:src/public/terminal-links.js` | `test/terminal-links.test.js` `test/claude-bridge.test.js` |
| TERM-15 | 桌面鼠标滚轮平滑滚动；按住 Shift 滚轮时 5 倍速 | `setting:smoothScrollDuration` | — |
| TERM-16 | 光标像原生终端一样闪烁；字体为本地托管的 JetBrains Mono，默认字号桌面 14、手机 12 | `setting:fontSize` | — |
| TERM-17 | 使用 Unicode 11 宽度表，emoji 和制表符与原生终端对齐 | 手工 | — |
| TERM-18 | 优先用 WebGL 渲染，不行退到 Canvas，再退到 DOM；GPU 上下文丢失时自动切换，终端不会冻结 | 手工 | `test/renderer-mode.test.js` |
| TERM-19 | 大量输出按动画帧合并写入；积压过多时暂停该会话的 PTY，消化完再恢复，各标签分别限流 | `ws-server:pause` `ws-server:resume` | — |
| TERM-20 | 过滤焦点上报序列（^[[I / ^[[O），不会作为乱码出现 | 手工 | — |
| TERM-21 | 终端自动适配容器大小并同步给 PTY；窗口缩放、旋转、字体加载完成后重新适配并滚到底 | `ws-server:resize` | `test/pty-size-negotiation.test.js` |
| TERM-22 | 多个设备共享同一个 PTY 时取最小尺寸；切走的标签撤回尺寸投票，不会把 PTY 压小；加入正在运行的会话时同步为本机宽度 | `ws-server:detach_size` `ws-server:resize` | `test/pty-size-negotiation.test.js` `test/session-views.test.js` |
| TERM-23 | 终端响铃时播放一声短提示音，后台标签响铃也会响 | `xterm:app.js:onBell` | `test/feature-guards.test.js` |
| TERM-24 | 页面在后台时，响铃会弹出系统通知「Claude needs your attention」，同一会话的通知替换而不叠加；标签在「待批准」时只响铃不重复通知，已有 ✓ 时照常提醒（答完约 60 秒后的那次响铃） | `xterm:app.js:onBell` | `test/claude-title.test.js` |
| TERM-25 | Claude 设置的终端标题去掉前面的动画符号后，作为浏览器标签标题；只有正在看的会话会改标题 | `xterm:app.js:onTitleChange` `file:src/public/claude-title.js` | `test/claude-title.test.js` |
| TERM-26 | 切到某个标签后终端自动获得焦点；开始或加入会话时不自动聚焦 | 手工 | — |
| TERM-27 | 连接意外断开时指数退避自动重连，最多 5 次，之后显示「Connection lost」和 Retry 按钮；单个标签连接 8 秒无响应不会卡住切换；每 30 秒心跳 | `control:retryBtn` `ws-server:ping` `ws-client:app.js:pong` `ws-client:app.js:connected` | — |
| TERM-28 | Claude 停止或退出时终端写一行黄色提示；非 0 退出码把标签标成错误；只有可见会话弹出 Start 面板 | `ws-client:app.js:claude_stopped` `ws-client:app.js:exit` `ws-client:app.js:error` `ws-server:stop` | — |
| TERM-29 | Claude 的输出实时广播给同一会话的所有设备；浏览器断开后 Claude 继续运行 | `ws-client:app.js:output` | — |
| TERM-30 | 终端滚动条细窄、跟随主题，不出现横向滚动条 | 手工 | — |
| TERM-31 | 覆盖层（加载、Start、错误）打开时，标签栏和菜单仍可点击 | 手工 | `test/overlay-stacking.test.js` `test/start-prompt-overlay.test.js` |

## 标签页与标签标记

| ID | 功能 | 入口 | 守卫 |
|---|---|---|---|
| TAB-01 | 每个会话在标签栏显示为一个标签；默认名是目录名，自定义名优先；悬停显示完整路径 | `file:src/public/session-manager.js` | `test/tab-working-dir.test.js` |
| TAB-02 | 当前标签整块填充强调色、白色粗体 | 手工 | — |
| TAB-03 | 标签的 × 关闭按钮（悬停时出现），点了关闭标签并删除会话，停掉其中的 Claude，不确认 | `js-control:session-manager.js:Close tab` | `test/session-views.test.js` |
| TAB-04 | 中键点击标签关闭它 | 手工 | — |
| TAB-05 | 右键标签弹出菜单「Close Others」，点菜单外关闭 | 手工 | — |
| TAB-06 | 双击标签名原地重命名：回车或失焦保存，Esc 恢复，清空保留原名；名字写到服务器，所有设备可见；只有真的改了才算自定义名 | `key:session-manager.js:Enter` `key:session-manager.js:Escape` `route:PATCH /api/sessions/:sessionId` | `test/session-rename.test.js` |
| TAB-07 | 拖动标签调整顺序；顺序变化时分屏窗格跟着换边；标签可以拖进分屏区域 | 手工 | — |
| TAB-08 | 切换到的标签不在可视区时，标签栏自动滚动把它露出来 | 手工 | — |
| TAB-09 | 关闭当前标签后自动切到最近用过的标签；关掉最后一个时显示 Start 面板而不是空终端 | 手工 | — |
| TAB-10 | 标签顺序和当前标签存在浏览器里，刷新后原样恢复 | 手工 | — |
| TAB-11 | Ctrl/Cmd+T 打开新建标签对话框；Ctrl/Cmd+W 关闭当前标签（删除会话，不确认） | `key:session-manager.js:t` `key:session-manager.js:w` | — |
| TAB-12 | Ctrl/Cmd+Tab 切到最近用过的标签，Ctrl/Cmd+Shift+Tab 切到左边一个（循环）；Alt+1…9 按位置跳转 | `key:session-manager.js:Tab` | — |
| TAB-13 | 标签状态圆点：运行中绿色脉冲，空闲蓝色呼吸，断开或出错红色 | 手工 | — |
| TAB-14 | 后台标签从运行转为空闲时标为未读（圆点变蓝闪烁、名字蓝色粗体），切过去后清除 | 手工 | — |
| TAB-15 | Claude 工作时标签圆点变成旋转的半实心小球（后台标签和分屏也生效；减少动效时不转）；停止或退出时立即消失；提示框追加 Claude 的任务主题 | `state:working` `ws-client:splits.js:exit` | `test/claude-title.test.js` |
| TAB-16 | Claude 在没人看的标签里答完后，圆点变成绿色 ✓ 并闪 3 下：收到 Stop hook 时立即标；没有 Stop 时（旧会话、hook 失效）按标题等 8 秒宽限期再标，宽限期内有新工作、出现权限请求或打开该标签都会取消；Stop 和标题先后到达都只标一次、只通知一次；进程停止或退出不算答完 | `state:done` | `test/claude-title.test.js` |
| TAB-17 | Claude 在没人看的标签里等待权限批准（包括用提问框问你、在计划模式里等你批准计划，2.1.278 实测这两种也发 permission_prompt）时，圆点变成琥珀色慢脉冲，名字后出现「待批准」徽章，优先于 ✓；只有权限请求触发，空闲提醒不触发 | `state:awaiting` `ws-client:app.js:hook_event` `ws-client:splits.js:hook_event` | `test/claude-title.test.js` |
| TAB-18 | 只有「没人在看」的标签才打 ✓ 和「待批准」；切到标签、Claude 重新开始工作、页面回到前台且标签在眼前时清除 | 手工 | `test/claude-title.test.js` |
| TAB-19 | 页面在后台且有标签带 ✓ 时，浏览器标签标题前加「✓ 」，回到页面后去掉 | 手工 | `test/claude-title.test.js` |

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

## 新建标签对话框

| ID | 功能 | 入口 | 守卫 |
|---|---|---|---|
| NEW-01 | 标签栏 +、Ctrl+T、Sessions 面板和菜单里的 New Session、恢复对话框、首次运行，都打开同一个「新建标签页」对话框 | `control:tabNewBtn` `control:conversationsNewBtn` `control:newSessionBtnMobile` | `test/new-tab-dialog.test.js` |
| NEW-02 | 工程目录默认选当前标签的目录，其次是其他已开标签，再其次是最近用过的目录；最近目录打不开（403/404）时自动忘掉并试下一个，断网或未登录时保留 | 手工 | `test/new-tab-dialog.test.js` |
| NEW-03 | 打开时焦点落在「启动」上，直接回车即可启动；由危险模式进入时焦点在「危险模式启动」上 | `control:newTabStartBtn` | — |
| NEW-04 | 模型、权限模式、思考强度默认沿用上次启动的选择；「跳过权限」从不记住；每次都默认「新对话」模式 | `control:newTabModelSelect` `control:newTabPermissionSelect` `control:newTabEffortSelect` | `test/new-tab-dialog.test.js` |
| NEW-05 | 名称框没手动输入时自动填文件夹名，选了要继续的对话时填对话标题（超 40 字截断）；手动输入的不被覆盖；回车即启动；只有手动输入的名称才作为自定义名传给 Claude | `control:sessionName` | `test/new-tab-dialog.test.js` `test/start-options.test.js` |
| NEW-06 | 路径栏可直接输入，回车跳转，Esc 恢复当前路径（不关闭对话框）；输入了路径没回车就启动时先跳过去再启动；路径长时滚到末尾露出文件夹名 | `control:currentPathInput` | — |
| NEW-07 | 「上一级」（根目录时禁用）和「回到起始目录」按钮；「浏览…」展开或收起目录树 | `control:folderUpBtn` `control:folderHomeBtn` `control:newTabBrowseBtn` | — |
| NEW-08 | 路径栏下方显示最多 8 个最近目录，当前目录高亮，点击跳转；非工程目录不显示也不预选 | 手工 | `test/new-tab-dialog.test.js` |
| NEW-09 | 目录树顶部有「..」，点文件夹进入，符号链接文件夹标 ↗；空目录和打不开的目录有中文提示；遇到 401 弹出登录框 | `js-control:app.js:Symbolic link` `route:GET /api/folders` | — |
| NEW-10 | 「显示隐藏文件夹」复选框（默认不勾），切换后刷新 | `control:showHiddenFolders` | — |
| NEW-11 | 「新建文件夹」输入条：回车创建、Esc 取消；名称为空、含 / 或 \\、已存在等情况有中文提示；成功后刷新目录树 | `control:createFolderBtn` `control:newFolderNameInput` `control:confirmCreateFolderBtn` `control:cancelCreateFolderBtn` `route:POST /api/create-folder` | — |
| NEW-12 | 「新对话 / 继续之前的对话」切换；继续模式列出该目录下 Claude 记录过的对话（标题、相对时间、id），已在别的标签打开的灰掉不能选；换目录时列表跟着刷新 | `js-control:conversations.js:Already open in a tab` `route:GET /api/claude-sessions` | `test/claude-history.test.js` `test/claude-resume.test.js` |
| NEW-13 | 「启动」创建会话并直接启动 Claude，不再弹 Start 面板；「危险模式启动」以跳过权限的方式启动 | `control:newTabStartBtn` `control:newTabDangerousBtn` `route:POST /api/sessions/create` | `test/new-tab-dialog.test.js` `test/session-create-guard.test.js` |
| NEW-14 | 启动请求进行中两个按钮都禁用，显示「启动中…」，防止连点建出多个会话 | 手工 | `test/session-create-guard.test.js` |
| NEW-15 | 拒绝把服务启动目录、主目录、根目录 / 当作工程目录，分别给出中文原因；没选目录、继续模式没选对话时也有中文提示 | 手工 | `test/new-tab-dialog.test.js` |
| NEW-16 | 要继续的对话已在别的标签打开时提示并切过去；对话在该目录下已不存在时提示；网络失败提示「创建会话失败，请检查连接后重试」 | 手工 | `test/new-tab-dialog.test.js` `test/claude-resume.test.js` |
| NEW-17 | 创建成功后把目录记到最近目录最前面（最多 8 个），并记住本次的模型、权限、强度 | 手工 | `test/new-tab-dialog.test.js` |
| NEW-18 | 取消、×、点背景、Esc 都能关闭对话框；一个标签都没有时取消，会留下 Start 面板 | `control:cancelNewTabBtn` `control:closeNewTabBtn` `key:app.js:Escape` | `test/new-tab-dialog.test.js` |
| NEW-19 | 因拒绝原因打开对话框时（例如在主目录里点 Start），顶部红字显示原因 | 手工 | `test/new-tab-dialog.test.js` |

## Start 面板与会话恢复

| ID | 功能 | 入口 | 守卫 |
|---|---|---|---|
| START-01 | 页面加载时显示「Connecting to Claude Code...」 | 手工 | — |
| START-02 | Start 面板：模型、权限模式、思考强度三个下拉（选 Default 时用 Claude 自己的默认值），「Start Claude」和「Dangerous Claude」两个按钮，按钮文字随别名变化 | `control:claudeModelSelect` `control:claudePermissionSelect` `control:claudeEffortSelect` `control:startBtn` `control:dangerousSkipBtn` `ws-server:start_claude` `ws-client:app.js:claude_started` | `test/start-options.test.js` |
| START-03 | 当前会话没有可用的工程目录时，按 Start 改为打开新建对话框，并带上已选选项和拒绝原因 | 手工 | `test/new-tab-dialog.test.js` |
| START-04 | 本地标签与服务器会话一致时原样恢复；首次使用时采用服务器上的全部会话；服务器上没有会话时直接打开新建对话框；拉取列表失败时不清空本地标签并给出提示 | `route:GET /api/sessions/list` | — |
| START-05 | 本地标签与服务器不一致时弹出「Restore sessions」对话框：每行可勾选打开、选为当前、删除（先确认）；没勾的记为已忽略，以后不再为它弹窗；「+ New session」打开新建对话框 | `js-control:app.js:Make this the active session` `js-control:app.js:Delete session` | — |
| START-06 | 新会话或 Claude 未运行的会话，加入时显示 Start 面板；加入 Claude 已停止的旧会话时终端打印黄色提示 | 手工 | `test/start-prompt-overlay.test.js` |
| START-07 | 会话在别的窗口或设备被删除时，自动关掉本地对应的标签并提示 | `ws-client:app.js:session_deleted` | — |
| START-08 | 离开会话时终端清空、状态点变红；没有任何标签时显示 Start 面板 | `ws-client:app.js:session_left` `ws-server:leave_session` | — |
| START-09 | 连续启动失败熔断：短时间内多次非零退出后，拒绝自动重试并提示新建会话 | 手工 | `test/start-circuit.test.js` |
| START-10 | 通过 WebSocket 新建并加入会话 | `ws-server:create_session` `ws-client:app.js:session_created` | — |

## Sessions 面板（会话与对话）

| ID | 功能 | 入口 | 守卫 |
|---|---|---|---|
| SES-01 | 工具栏的对话气泡按钮打开 Sessions 面板，头部显示当前目录（长路径截掉前面） | `control:historyBtn` `file:src/public/conversations.js` | — |
| SES-02 | 「Sessions (N)」列出服务器上所有会话：运行状态、名称、文件夹、是否在本浏览器打开、id；当前标签高亮 | `route:GET /api/sessions/list` | — |
| SES-03 | 点会话行：已开标签的切过去，没开的新开一个标签 | 手工 | — |
| SES-04 | 会话行的垃圾桶删除会话，先确认「…This stops any running Claude process.」；删除不删对话记录，对应对话会出现在下方可再继续 | `js-control:conversations.js:Delete session` `route:DELETE /api/sessions/:sessionId` | — |
| SES-05 | 「Conversations in this folder (N)」只列出没有会话占用的历史对话，点击在新标签里继续；被拒绝后自动刷新重开 | `route:GET /api/claude-sessions` | `test/claude-resume.test.js` |
| SES-06 | 空状态和出错提示：No sessions yet. / No previous conversations in this folder. / Every conversation here is already open. / Could not load sessions. / No folder selected | 手工 | — |
| SES-07 | Refresh、Close、New Session 按钮，× 或点背景关闭 | `control:conversationsRefreshBtn` `control:conversationsDoneBtn` `control:closeConversationsBtn` | — |
| SES-08 | 菜单里的 Sessions 弹窗显示同一份列表，两个同时打开时一起刷新；底部 New Session 打开新建对话框；手机上打开时锁住页面滚动 | `control:sessionsBtnMobile` `control:closeMobileSessionsModal` | — |
| SES-09 | 历史对话标题的优先级：手动命名 > Claude 自动标题（取最后一条）> summary > 第一条真实用户输入，超过 80 字截断 | `file:src/utils/claude-history.js` | `test/claude-history.test.js` |

## 文件浏览器

| ID | 功能 | 入口 | 守卫 |
|---|---|---|---|
| FILE-01 | 工具栏的文件按钮打开右侧抽屉；打开时回到本会话上次浏览的位置，没有则用会话工作目录 | `control:explorerBtn` `file:src/public/file-explorer.js` | — |
| FILE-02 | 拖动抽屉左边缘调整宽度（最小 300px，触屏也能拖），宽度记住 | `js-control:file-explorer.js:Drag to resize` | — |
| FILE-03 | ×、点背景、Esc 关闭抽屉 | `control:explorerCloseBtn` `key:file-explorer.js:Escape` | — |
| FILE-04 | 「上一级」「主目录」按钮；路径栏回车跳转；列表顶部「..」；点文件夹进入 | `control:explorerUpBtn` `control:explorerHomeBtn` `control:explorerPathInput` `key:file-explorer.js:Enter` | — |
| FILE-05 | 「Show hidden items」默认勾选，切换后立即重新加载 | `control:explorerShowHidden` | — |
| FILE-06 | 列出文件和文件夹（文件夹在前，带大小）；超过 2000 项截断并提示；加载中、空目录、无权限、打不开都有提示 | `route:GET /api/fs/list` | `test/fs-browse.test.js` |
| FILE-07 | 点可预览的文件（文本、代码、图片、PDF 等）在新标签页打开；.html/.svg 用一次性票据渲染，拿不到票据时显示源码 | `route:GET /api/fs/file/:token/:file` `route:POST /api/fs/ticket` | `test/fs-browse.test.js` `test/fs-render-inline.test.js` |
| FILE-08 | 点不可预览的文件直接下载；行内下载按钮用一次性票据下载，有「Downloading X」和失败提示 | `js-control:file-explorer.js:Download` | `test/fs-browse.test.js` |
| FILE-09 | 行内 @ 按钮把「@绝对路径 」输入终端（不回车），关闭抽屉并提示；未启动 Claude 时提示先启动 | `js-control:file-explorer.js:Insert path into the terminal` | `test/insert-path.test.js` |
| FILE-10 | 行内红色删除按钮，先弹确认（文件夹注明连同内容一起删除）；成功刷新，失败显示原因 | `js-control:file-explorer.js:Delete` `route:POST /api/fs/delete` | `test/fs-delete.test.js` |
| FILE-11 | 服务器拒绝删除根目录、主目录、启动目录、任一会话的工作目录及其上级（按真实路径比较，识破符号链接别名）；符号链接只删链接本身 | `route:POST /api/fs/delete` | `test/fs-delete.test.js` |
| FILE-12 | 行内按钮（@、下载、删除）一直显示不靠悬停，与悬停高亮一致；手机上点击区域放大到 44px | 手工 | `test/hover-latency.test.js` |
| FILE-13 | 符号链接在名称后标 ↗ | `js-control:file-explorer.js:Symlink` | — |
| FILE-14 | 上传按钮选多个文件上传到当前目录；也可以拖文件到列表上传（拖入的文件夹跳过并提示）；逐个上传，同名不覆盖，结果汇总提示 | `control:explorerUploadBtn` `control:explorerFileInput` `route:POST /api/fs/upload` | `test/fs-upload.test.js` |
| FILE-15 | 新建文件夹：输入栏自动聚焦，Create 或回车创建，Cancel 或 Esc 收起；失败时保留输入栏以便改名 | `control:explorerNewFolderBtn` `control:explorerNewFolderInput` `control:explorerCreateFolderBtn` `control:explorerCancelFolderBtn` | — |
| FILE-16 | 悬停某行时整行变为强调色蓝底白字 | 手工 | `test/hover-latency.test.js` |

## 分支面板

| ID | 功能 | 入口 | 守卫 |
|---|---|---|---|
| GIT-01 | 分支按钮打开或收起面板，列出当前标签工作目录下每个子项目的 git 分支；点面板外或 Esc 关闭 | `control:branchBtn` `key:git-branches.js:Escape` `route:GET /api/git/branches` `file:src/public/git-branches.js` `file:src/git-branches.js` | `test/git-branches.test.js` |
| GIT-02 | 刷新按钮；「Check changes」查询未提交改动、领先、落后（查询中禁用） | `control:branchRefreshBtn` `control:branchStatusBtn` | `test/git-branches.test.js` `test/async-route-safety.test.js` |
| GIT-03 | 同一分支的多个仓库用同一种颜色标出（最多 6 组），深浅主题各一套；状态徽章 ● N、↑N、↓N | 手工 | `test/git-branches.test.js` |
| GIT-04 | 每行拉取按钮（悬停出现）执行 `git pull --ff-only`；进行中旋转，结果和失败原因显示在该行，成功后自动刷新；有未提交改动、无上游、需合并、超时都有明确原因；不弹凭据提示，错误里的凭据打码 | `route:POST /api/git/pull` | `test/git-branches.test.js` |
| GIT-05 | 面板底部统计仓库和分支数；空状态和错误提示；窄屏上面板对齐右侧不出屏 | 手工 | — |

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

## 设置与菜单

| ID | 功能 | 入口 | 守卫 |
|---|---|---|---|
| SET-01 | 工具栏齿轮按钮打开侧滑菜单（打开时齿轮高亮）；点菜单外任意处关闭，那一下点击照常生效；× 关闭 | `control:hamburgerBtn` `control:closeMenuBtn` | — |
| SET-02 | 菜单里「Settings」打开设置（唯一入口），「Sessions」打开会话弹窗 | `control:settingsBtnMobile` | — |
| SET-03 | 菜单底部显示「v版本 · :端口 · 构建号」，区分 dev 和 stable | `route:GET /api/config` | — |
| SET-04 | 设置标题显示「Settings — 会话名」；字号 10–24、主题 Dark/Light、滚动动画 0–200ms，按会话分别保存，新会话继承最近保存的设置；切主题不刷新页面 | `control:fontSize` `control:themeSelect` `control:smoothScroll` `control:saveSettingsBtn` `setting:theme` | `test/light-contrast.test.js` `test/feature-guards.test.js` |
| SET-05 | 显示 Claude Code 已安装版本、最新版、稳定版，以及是否有更新 | `route:GET /api/version` | `test/version-info.test.js` |
| SET-06 | 历史保留量（MB，0.25–16，默认 2），服务器端设置对所有会话生效；超出范围时提示实际生效值 | `control:scrollbackChunks` `route:GET /api/settings/scrollback` `route:POST /api/settings/scrollback` | `test/scrollback-setting.test.js` |
| SET-07 | 计划目录：列出本会话的额外目录（可 × 删除）和全局目录（只读）；输入后 Add 或回车提交，被拒绝的目录弹出原因 | `control:planDirInput` `control:planDirAddBtn` `js-control:app.js:Remove` `route:GET /api/plan-dirs` `route:POST /api/plan-dirs` | `test/plan-dirs.test.js` |
| SET-08 | 设置弹窗 × 或点背景关闭，不保存；手机上打开时锁住页面滚动 | `control:closeSettingsBtn` | — |
| SET-09 | 「Reset button position」让浮动按钮恢复自动跟随输入框（只在手机上显示） | `control:fabResetBtn` | `test/fab-position.test.js` |

## 界面、主题与 PWA

| ID | 功能 | 入口 | 守卫 |
|---|---|---|---|
| UI-01 | 工具栏图标悬停时不出现底框，只把图标变成强调色；统一 44×44 点击区域 | 手工 | — |
| UI-02 | 深色和浅色两套配色；浅色主题下 Claude 的输入框边线、消息底色都看得清（高对比 ANSI 配色 + 最低对比度校正） | `file:src/public/style.css` | `test/light-contrast.test.js` |
| UI-03 | 页面加载时提前应用已保存的主题，避免闪烁，并设置浏览器 theme-color | `file:src/public/index.html` | — |
| UI-04 | 计划模式：Claude 提交计划时弹出「Claude's Plan」弹窗，渲染 Markdown 并播放提示音；Accept 发回车批准，Reject 发 Esc 留在计划模式，× 只关闭弹窗 | `control:acceptPlanBtn` `control:rejectPlanBtn` `control:closePlanBtn` `ws-client:app.js:hook_event` | `test/hook-endpoint.test.js` `test/feature-guards.test.js` |
| UI-05 | 可安装为 PWA（CC Web，绿色机器人图标），浏览器允许时出现「Install App」按钮 | `route:GET /manifest.json` `file:src/public/icons.js` `file:src/public/icon-generator.js` | — |
| UI-06 | Service Worker 每分钟检查更新，有新版本时询问刷新；离线时静态资源读缓存，API 返回 503 提示 | `file:src/public/service-worker.js` | — |
| UI-07 | 标签页图标由服务器按尺寸动态生成 | `route:GET /` | — |

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
| MOB-11 | 窄屏（≤768px）只显示前 2 个标签，其余收进「⋮」溢出按钮（显示数量），下拉里可切换或 × 关闭；切到第 3 个以后的标签时按最近访问排序 | `control:tabOverflowBtn` | — |
| MOB-12 | 齿轮按钮在手机上放在最左边，桌面放在右侧 | 手工 | — |
| MOB-13 | 手机上各弹窗改为顶部对齐、可滚动的全宽卡片，标题栏和底部按钮固定，按钮至少 44px；新建标签对话框全屏 | 手工 | — |
| MOB-14 | 窄屏上文件浏览器占满屏幕；超小屏（≤480px）隐藏文件大小给文件名让位 | 手工 | — |
| MOB-15 | 整页禁用下拉刷新和横向滚动；点按没有灰色高亮；iOS 主屏启动全屏 | 手工 | — |

## Claude 集成

| ID | 功能 | 入口 | 守卫 |
|---|---|---|---|
| CLA-01 | 自动查找 claude 可执行文件（多个常见位置），找不到时退回 PATH 上的 `claude` | `file:src/claude-bridge.js` | `test/claude-bridge.test.js` |
| CLA-02 | 启动参数：模型、权限模式、思考强度按白名单传给 Claude，不在白名单的丢弃；可选跳过权限；浏览器只能传这四个选项，不能覆盖工作目录或 hook 脚本 | `ws-server:start_claude` | `test/start-options.test.js` `test/claude-bridge.test.js` |
| CLA-03 | 手动命名的会话名以 `--name` 传给 Claude（显示在输入框、终端标题并作为对话标题）；自动生成的名字不传 | 手工 | `test/start-options.test.js` |
| CLA-04 | 首次启动用 `--session-id` 绑定对话，之后（包括服务重启后）都用 `--resume` 接续；自己会话的 resume 失败时用同一 id 重建；从历史里选中的对话恢复失败时红字说明，不静默新建 | 手工 | `test/claude-resume.test.js` |
| CLA-05 | 自动确认「是否信任此文件夹」提示 | 手工 | `test/claude-bridge.test.js` |
| CLA-06 | 注入设置：通知走终端响铃（terminal_bell），强制经典渲染器以保留滚动历史 | `env:CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` | `test/renderer-mode.test.js` `test/claude-bridge.test.js` |
| CLA-07 | Claude 主题跟随 UI 的深浅色，使用 cc-web 自带的高对比主题 | `file:src/utils/claude-theme.js` | `test/claude-theme.test.js` |
| CLA-08 | 子进程环境：彩色终端（TERM、FORCE_COLOR、COLORTERM）、同步输出减少闪烁、强制保存对话以便恢复 | `env:TERM` `env:FORCE_COLOR` `env:COLORTERM` `env:CLAUDE_CODE_FORCE_SYNC_OUTPUT` `env:CLAUDE_CODE_FORCE_SESSION_PERSISTENCE` | `test/claude-bridge.test.js` |
| CLA-09 | Hook：ExitPlanMode 计划弹窗、SessionStart 跟踪 /clear 后的新对话、Notification 权限请求触发「待批准」、Stop 报告一轮回答结束（带最后一句回复的前 300 字）；由 `bin/cc-hook.js` 转发，任何失败都不阻塞 Claude | `hook:PreToolUse` `hook:SessionStart` `hook:Notification` `hook:Stop` `bin:cc-hook.js` `route:POST /api/hooks/:sessionId` | `test/hook-endpoint.test.js` `test/session-start-hook.test.js` |
| CLA-10 | Hook 端点只接受本机回环地址，并校验每个会话单独的令牌；令牌经环境变量传递，不出现在命令行 | `env:CCWEB_HOOK_TOKEN` | `test/hook-endpoint.test.js` |

## 服务端、安全与持久化

| ID | 功能 | 入口 | 守卫 |
|---|---|---|---|
| SRV-01 | 首页和静态资源无需认证即可加载 | `route:GET /` | — |
| SRV-02 | 认证默认开启：REST 只认 Authorization 请求头，WebSocket 用 URL 里的令牌；`/auth-status` 查询是否需要令牌，`/auth-verify` 校验令牌 | `route:GET /auth-status` `route:POST /auth-verify` | `test/feature-guards.test.js` |
| SRV-03 | 登录框：密码型输入框，空值、验证中、令牌无效都有提示；成功后刷新；令牌只存在当前浏览器标签；`?token=` 链接登录后立即从地址栏去掉；任何接口 401 时清除令牌并弹出登录框 | `file:src/public/auth.js` | — |
| SRV-04 | 异步路由出错返回 500，不会让服务崩溃带走所有终端 | 手工 | `test/async-route-safety.test.js` |
| SRV-05 | 会话按每个一个文件保存，每 30 秒自动保存；服务重启后自动恢复；7 天没有活动的会话自动清除；损坏文件跳过不影响其他；写入用临时文件加原子重命名 | `route:GET /api/sessions/persistence` `file:src/utils/session-store.js` | `test/session-store.test.js` |
| SRV-06 | 同一数据目录已有别的实例在运行时拒绝启动；实例锁文件权限 0600，退出时删除 | `file:src/instance-lock.js` | `test/instance-lock.test.js` |
| SRV-07 | 新建会话：名称、工作目录可选；`resumeId` 接续已有对话（非法 UUID 400，已在别的标签 409，不存在 404） | `route:POST /api/sessions/create` | `test/claude-resume.test.js` `test/session-create-guard.test.js` |
| SRV-08 | 查看会话详情、健康检查 | `route:GET /api/sessions/:sessionId` `route:GET /api/health` | — |
| SRV-09 | 删除会话：停止 Claude，通知所有连接的客户端，删除上传图片目录和会话文件，不删 Claude 自己的对话记录 | `route:DELETE /api/sessions/:sessionId` | — |
| SRV-10 | 计划文件服务：令牌放在 URL 里，以 text/plain 返回便于 Markdown 插件渲染；白名单为 `.claude/plans/` 与全局或会话计划目录中的 .md，按真实路径校验，上限 2MB | `route:GET /api/plan` `route:GET /api/plan/:token/:file` `route:GET /api/plan/:token/:session/:file` | `test/plan-file.test.js` `test/plan-dirs.test.js` |
| SRV-11 | 文件服务的安全：.html/.svg 默认只显示源码，渲染需一次性票据（30 秒、用一次即失效）；渲染时放进无网络的沙箱；统一 nosniff、no-referrer；中文文件名 | `route:GET /api/fs/file/:token/:file` `route:POST /api/fs/ticket` `file:src/utils/inline-assets.js` | `test/fs-browse.test.js` `test/inline-assets.test.js` |
| SRV-12 | 选择或设置工作目录、清除已选目录（旧接口） | `route:POST /api/set-working-dir` `route:POST /api/folders/select` `route:POST /api/close-session` | — |
| SRV-13 | 加入会话不再强制重绘，避免出现两个输入框 | 手工 | `test/pty-repaint.test.js` |
| SRV-14 | 服务端入口与会话多路复用：Express + WebSocket 服务 | `file:src/server.js` | — |

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
| CLI-09 | `CCW_DATA_DIR` 指定数据目录，两个实例靠它隔离 | 手工 | `test/instance-lock.test.js` |
| CLI-10 | Ctrl+C / SIGTERM 优雅退出：保存会话、撤下实例锁、关闭隧道 | 手工 | — |

## 已知缺陷与未接入（只登记，未修；修不修由用户决定）

| ID | 功能 | 入口 | 守卫 |
|---|---|---|---|
| GAP-01 | CLAUDE.md 说有按 IP 限流，但限流中间件所在的 `src/utils/auth.js` 没有被任何代码引用，实际不限流 | `file:src/utils/auth.js` | — |
| GAP-02 | 令牌来自 `--auth-file` 或 `CCWEB_AUTH` 时，控制台仍把它当作「生成的令牌」打印出来 | 手工 | — |
| GAP-03 | 菜单里的「Clear Terminal」没有绑定事件，点了没反应；「Reconnect」一直禁用；「Close Session」一直隐藏 | `control:clearBtnMobile` `control:reconnectBtnMobile` `control:closeSessionBtnMobile` | — |
| GAP-04 | 设置里历史保留量的单位文字仍写着「chunks」，和标签上的 MB 对不上 | 手工 | — |
| GAP-05 | 分屏时图片粘贴或拖放不生效 | 手工 | — |
| GAP-06 | CLAUDE.md 的 WebSocket 协议里列了 `close_session`，但代码里没有这个消息（文档与代码不符，不影响使用） | 手工 | — |
| GAP-07 | 设置弹窗不支持 Esc 关闭 | 手工 | — |
| GAP-08 | 分屏窗格没有响铃声和通知，也不做写入合并和限流 | 手工 | — |
| GAP-09 | **已修复（2026-09-23）**：原来切换标签后，设置弹窗标题仍显示上一个会话的名字；现在标题取自标签栏里当前会话的名字，切换和重命名后都正确 | 手工 | `test/feature-guards.test.js` |
| GAP-10 | **已修复（2026-09-23）**：原来计划弹窗的提示音从来不响（内嵌的 wav 数据被截断，浏览器无法解码）；现在改用与终端响铃相同的 WebAudio 提示音（660Hz，比响铃低一些以便区分） | 手工 | `test/feature-guards.test.js` |

## 建清单的比对记录

2026-09-22 首版，由两路独立来源合并：

- **路线 A**：`scripts/feature-surfaces.js` 扫出 203 个入口，加上 code-graph 从 `buildView`、`setupTerminal`、`handleMessage`、`init`、`createTerminal`、`addTab`、`switchToTab`、`closeSession`、`openNewTabDialog`、`setupSettings` 往下查到的调用，以及约 440 个函数的清单。
- **路线 B**：5 个只读子代理按区域逐个文件读代码（终端 90 条、标签/会话 120 条、面板 95 条、服务端 110 条、手机 80 条，互有重叠）。
- **只有一路发现的项**：
  - 只在 A：WebSocket 的 `detach_size`（TERM-22）、`pause`/`resume`（TERM-19）、`wire:registerPlanLinks` 两处调用点（TERM-13）。
  - 只在 B：中键关闭标签（TAB-04）、右键「Close Others」（TAB-05）、Alt+1…9（TAB-12）、通知权限提示（NOTI-01）、完成字样通知（NOTI-07）、焦点序列过滤（TERM-20）、离线 503（UI-06）、GAP-01～08 这 8 项缺陷。
  - 以上各项都已逐条回到代码复核，确认存在。
- **还没做到的**：第一版仍可能漏掉「没有明显入口」的行为，需要用户过目补充。
