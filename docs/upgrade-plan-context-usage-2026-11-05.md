# 上下文与用量洞察（借鉴 dsh-context）— 实施计划

## Context

cc-web 现在只把 Claude 的 PTY 字节原样转发，用户看不到**上下文用了多少、Token 花在哪、何时被压缩、跨会话总用量**。dsh-context 是 DeepSeek Harness 专用插件，代码没法复用，但它的产品思路值得借鉴：上下文占用、组成、逐请求趋势、压缩事件、工具和命令统计、跨会话总览。

用户已确认（2026-11-05）：**三层全做**；成本**显示，并标注「API 折算」**。

数据源都已就位：
- **实时**：Claude 的 `statusLine` 命令每次刷新时会在 stdin 收到 JSON，里面有 `context_window`（`used_percentage`、`context_window_size`、`current_usage`）、`cost.total_cost_usd`、`model`。cc-web 已经能用 `--settings` 注入配置（`ClaudeBridge.buildInjectedSettings`，`src/claude-bridge.js:561`），也已有带令牌的回环中继 `bin/cc-hook.js` → `POST /api/hooks/:sessionId`。
- **历史**：`~/.claude/projects/<dir>/<uuid>.jsonl`。已在本机 2.1.304 的真实文件上实测：每条 assistant 记录带 `message.usage`（`input_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens`、`output_tokens`），以及 `message.id`、`requestId`、`timestamp`；同一个响应会拆成多条记录，`usage` 会重复出现。压缩记录是 `type:"system", subtype:"compact_boundary"`，带 `compactMetadata.preTokens` 和 `trigger`。单个文件最大有 41MB。`src/utils/claude-history.js` 已能定位项目目录（`projectDirFor`、`projectsRoot`）和标题（`titleFor`）。

## 第 0 步：先实测再写代码（结果写进代码注释，沿用本项目「Measured on 2.1.x」的惯例）

1. 在 2.1.304 上实测 `statusLine` 能否用 exec 形式（`command` + `args`）。hooks 能用，但 Windows 下 statusLine 可能只接受 shell 字符串。如果不能，Windows 下改为生成 `.cmd` 包装文件，或者写进 shell 字符串时做好转义。
2. 实测 `--settings` 里的 `statusLine` 会不会覆盖用户在 `~/.claude/settings.json` 和项目 settings 里配置的 statusLine（预期会覆盖，所以需要「包装」用户自己的 statusLine，见下文）。
3. 实测 statusLine 的触发频率，以及 stdin JSON 的字段全集，存为 `test/fixtures/statusline-input.json`。
4. 确认子 Agent 的记录位置（预期是 `<projectDir>/<uuid>/subagents/*.jsonl`），以及 `isSidechain` 怎么用。

### 第 0 步实测结果（2026-11-05，Claude Code 2.1.304，Windows，真实 PTY）
- **statusLine 不支持 exec 形式**（`command` + `args`）：配置后完全不会被调用。
- **statusLine 由 PowerShell 5.1 执行**，即使装了 Git Bash 也一样（`echo $PSVersionTable.PSVersion` 输出 5.1.26100）。因此 `"C:/Program Files/nodejs/node.exe" "x.js"`（带引号路径加参数）会解析失败，而且是静默失败。可用的写法：
  - `& "<execPath>" "<script>" ...`（PowerShell 调用运算符），已实测可用
  - `node "<script>" ...`（不加引号的程序名），已实测可用
  - Windows 分支采用 `& "<execPath>"`；POSIX 沿用 relay 的单引号写法。中继在 Windows 上运行用户自己的 statusLine 时，也用 `powershell -NoProfile -Command`。
- **调用时机**：启动时调用一次，每轮结束时调用一次。频率很低，不需要担心性能。
- **stdin JSON 比预期丰富**，已保存样本的结构：`session_id`、`transcript_path`（直接给出 jsonl 路径，第 2 层可以优先用它）、`model{id,display_name}`、`cost{total_cost_usd,total_duration_ms,total_api_duration_ms,total_lines_added,total_lines_removed}`、`context_window{total_input_tokens,total_output_tokens,context_window_size,current_usage{input,output,cache_creation,cache_read},used_percentage,remaining_percentage}`、`exceeds_200k_tokens`、`prompt_cache{hit_ratio,ttl,expires_at,warm,misses,...}`、`rate_limits{five_hour{used_percentage,resets_at},seven_day{...}}`、`effort.level`、`session_name`。**额外收获**：可以在 tooltip 和总览里显示 5 小时和 7 天的额度占用。
- **子 Agent 的记录**在 `<projectDir>/<uuid>/subagents/agent-*.jsonl`（`isSidechain:true`），主 jsonl 里没有 sidechain 记录。
- 测量用的快照已存为 `test/fixtures/statusline-input.json`（路径已脱敏）。
- **进度（2026-11-06）**：多用户 M1–M4 已提交到 `feat/multi-user-m4`，本功能在其上开分支 `feat/context-usage`（工作目录 `cc-web-ctx`）。第 1 层已完成并通过端到端验证（见 `test/SMOKE.md` S48）。与计划的出入：① 不新增 `usage_update` 消息，复用 `hook_event`（event 为 `ccweb_statusline`），两个视图原有的分发直接可用；② 不做每秒节流，因为实测每轮只调用一次，只保留「数值变了才推送」；③ 分屏窗格没有单独的标题条圆环，标签上的圆环已覆盖分屏里的会话；④ 实测 `total_cost_usd` 只计当前这个 Claude 进程，恢复对话后从 $0.00 算起，所以提示写「本次运行」，整段对话的总花费放到第 2 层（从 jsonl 计算）。

## 第 1 层：标签上的实时上下文占用环

**新文件 `bin/cc-statusline.js`**（和 cc-hook.js 是同类中继）：
- 读 stdin JSON，加上 `hook_event_name: 'ccweb_statusline'` 后 POST 到 `/api/hooks/:sid`。令牌放在 `CCWEB_HOOK_TOKEN` 环境变量里，和 cc-hook 相同；超时 500ms，**不等待返回**，失败时静默。
- **包装用户原来的 statusLine**：claude-bridge 把用户原来的配置通过环境变量 `CCWEB_USER_STATUSLINE`（JSON）传进来。中继用同一份 stdin 运行它，原样输出它的 stdout，所以用户原来的状态栏不受影响。没有配置时就什么都不输出。
- 和 cc-hook 一样尽力而为：任何失败都 exit 0。

**`src/claude-bridge.js`**
- `buildInjectedSettings` 增加 `statusLine`。Windows 和 POSIX 的分支照抄现有 `relay` 的写法，等第 0 步实测后再定。
- 新增 `userStatusLine(workingDir)`：按 local > project > user 的优先级读三个 settings 文件里的 `statusLine`，结果放进 spawn 的 env。

**`src/server.js` → `handleHookEvent`（:1931）**
- 新增 `ccweb_statusline` 分支，归一化为 `{ ctxPct, ctxUsed, ctxSize, costUsd, model, durationMs, linesAdded, linesRemoved, at }`，存到 `session.liveUsage`。
- 只有数值变化时才广播 `usage_update`，同一会话每秒最多一次。
- `liveUsage` 随 sessions.json 持久化，`session_joined` 时一并下发，这样重连后环立刻有值。

**新文件 `src/public/context-ring.js`**
- 在 `session-manager.js:646` 的 `.tab-content` 里、`.tab-name` 之前插入一个 SVG 小环。占用低于 60% 为绿色，60–85% 为琥珀色，85% 以上为红色。
- 按本项目惯例，状态用 `data-ctx` 属性表示，而不是 class，因为 `updateTabStatus` 会整体重写 className。
- tooltip 内容如「上下文 62% · 124k / 200k · $1.23（API 折算）· claude-opus-5-5」。点击环会打开第 2 层面板。分屏窗格的标题条也显示同样的环。

## 第 2 层：单会话用量面板

**新文件 `src/utils/claude-usage.js`**：纯解析，可用测试数据测试。
- `summarizeTranscript(file)`：用 readline 流式读取。先做子串预筛，只解析包含 `"usage"`、`compact_boundary` 或 `"tool_use"` 的行，避免 41MB 文件逐行全量 parse。
  - 请求：按 `message.id` 去重（同一 id 取最后一条）→ `{ t, model, input, cacheRead, cacheCreate, output, ctx = input + cacheRead + cacheCreate }`
  - 压缩：`{ t, trigger, preTokens }`
  - 工具：按名称计数；Bash 命令取首个程序名计数；Skill 按 `input.skill` 计数；Read/Edit/Write 按 `file_path` 计数
  - 子 Agent 文件单独汇总，标注为「子 Agent」
- **增量缓存**：jsonl 只会追加，所以缓存 `{ size, mtime, offset, partialSummary }`，文件变大时从 offset 接着读。整体是一个 LRU Map，并写入 `<dataDir>/usage-cache.json`，服务重启后不用全量重扫。数据目录用 `src/utils/data-dir.js`。
- `PRICES`：按模型族列出每百万 Token 单价（input、output、cache read、cache write），**只用于历史与跨会话的估算**，界面标注「API 折算估算」。未知模型的成本显示 `—`。实时数字优先用 statusLine 的 `total_cost_usd`。

**路由**（放在全局 auth 中间件之后，即普通 header 或 Cookie 认证）
- `GET /api/sessions/:id/usage`：用 `session.claudeConversationId` 加 `projectDirFor(workingDir)` 定位 jsonl。
- `GET /api/claude-sessions/:convId/usage?dir=`：给历史对话用，复用现有的 `validatePath`。

**新文件 `src/public/usage-panel.js`**，以及 index.html 里的 `#usageModal`（照抄 `#skillsModal` 和 `src/public/skills.js` 的模态写法），纯 SVG，不引入图表库：
- KPI 行：请求数、总 Token、缓存命中率（cacheRead ÷ 总输入）、估算成本（API 折算）、时长
- 当前上下文条：以窗口大小为分母，分成 cache read、cache write、新输入和剩余空间；数据取最近一次请求和 liveUsage
- 趋势图：每个请求一根柱子，可切换 Total 和 Delta；压缩点用 ✂ 标在柱上；悬停显示明细；可横向滚动
- 排行：工具、Bash 程序、涉及的文件、Skill，各取前 10
- 入口：点上下文环、标签的「任务菜单」里新增「上下文与用量」、Sessions 面板里对话行上的图标

## 第 3 层：跨会话总览

- `GET /api/usage/overview?range=7d|30d|all&tz=<offset>`：扫描 `projectsRoot()` 下 mtime 落在范围内的 jsonl，复用第 2 层的缓存，并发 4。按**请求的 timestamp**（而不是文件 mtime）归到某一天，返回：
  - 汇总 KPI
  - 每日 Token 和成本（柱状图）
  - 8 周热力图
  - 按会话的列表：标题（`titleFor`）、cwd、Token、成本、最后活动时间，可排序和搜索
  - 工具和命令的全局排行
- **多用户隔离**：非管理员只能看到 cwd 在自己允许目录内的项目（复用 `validatePath` 的判断），管理员看全部。依据是 `docs/upgrade-plan-multi-user-2026-11-04.md` 里的约定。
- 首次冷扫描如果超过约 3 秒，先返回已完成的部分并带上 `scanning: true`，前端轮询直到扫描完成。
- **UI**：`usage-panel.js` 加一个「总览」视图，入口是汉堡菜单里新增的「用量」按钮（`#usageBtnMobile`，紧挨 `#skillsBtnMobile`，`index.html:236`）。点击会话行：已经打开的就切换到该标签，否则用现有的 `POST /api/sessions/create {resumeId}` 打开。

## 登记与守卫（CLAUDE.md 的硬性规则）

- 在 `FEATURES.md` 新增「上下文与用量」区，ID 为 `CTX-01…`，每个新入口（路由、ws 消息、控件、bin 脚本、env）都要在**同一个提交**里登记。`node scripts/feature-surfaces.js` 能扫描到它们。
- 不删除、不弱化任何已有功能。statusLine 采用包装方式，正是为了不破坏用户自己的状态栏。
- 开发计划另存一份到 `docs/upgrade-plan-context-usage-2026-11-05.md`。

## 测试（Mocha + node:assert，不访问网络，不调用真实 CLI）

- `test/claude-usage.test.js`：基于真实 jsonl 裁出的测试数据（`test/fixtures/transcript-usage.jsonl`），覆盖 message.id 去重、compact_boundary、工具、Bash 程序名、增量 offset 续读、子 Agent、未知模型成本为 null。
- `test/statusline-relay.test.js`：中继能 POST，能包装用户命令并原样输出，没有用户命令时输出为空，服务器不在时 exit 0。
- `test/claude-bridge.test.js` 补测：注入的 settings 包含 statusLine，`userStatusLine` 的优先级正确。
- `test/hook-endpoint.test.js` 补测：`ccweb_statusline` 的归一化、节流、非回环地址返回 403。
- `test/usage-routes.test.js`：两个 usage 路由加 overview，包括 range、按天归属（时区）、非管理员只能看到自己目录。都用 `test/helpers/auth.js` 的 `useTempDataDir` 和 `signIn`，再用临时 projects 根目录。

## 验证（端到端）

1. `npm test` 全部通过，其中 `features.test.js` 双向核对通过。
2. 在 dev 实例（`npm run dev -- --port 32353`，用 `CCW_DATA_DIR` 指向临时目录）上开一个标签，发两轮消息：环出现，百分比和 Claude 的 `/context` 一致；tooltip 的成本和 `/cost` 一致。
3. 在 `~/.claude/settings.json` 配一个测试用 statusLine：cc-web 终端底部仍显示它的输出。
4. 执行 `/compact`：面板的趋势图出现 ✂ 标记，柱子明显下降。
5. 打开 41MB 的 `D--fanxua/8e79…jsonl` 对应的对话：首次解析耗时可接受，记录下来；第二次打开在 100ms 以内，因为命中缓存。
6. 用 Playwright 截图检查总览页的桌面版和手机版（375px），确认不出现横向滚动。
7. 把新增条目补进 `test/SMOKE.md` 的冒烟清单。**不要动 32352 稳定实例。**

## 实施顺序

第 0 步实测 → 第 1 层（中继、bridge、server、环，加测试和 FEATURES）→ 第 2 层（claude-usage、路由、面板）→ 第 3 层（overview、多用户过滤、总览视图）。每层单独提交（`feat:`），每层都可以单独发布。
