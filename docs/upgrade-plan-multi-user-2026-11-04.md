# 升级计划：cc-web 平台级多用户（账号 / 空间 / 会话历史独立）

日期：2026-11-04
基线（回滚锚点）：main `99aa26f`
适用：先改 dev(32353)，每阶段独立 git 提交、可单独回滚；dev 验证通过后 fast-forward 部署到 stable(32352)。
状态：**评审通过，M1 待确认功能变更后开工**（决策见第 14 节）

## 1. 背景 / 根因

现状：未指定 `--auth-file` / `CCWEB_AUTH` 时，每次启动随机生成 token；换机器、关标签页、重启服务都要回服务器上找 token。多人使用时也没有"谁是谁"，所有人共享同一组 Spaces 和会话。

根因：**一个会变的共享密钥，同时充当了身份、登录凭证、请求凭证三种角色。**

| 问题 | 位置 | 后果 |
|---|---|---|
| 无 token 参数时每次启动随机生成 | `bin/cc-web.js:89` | 重启 → 所有浏览器失效 |
| 前端 token 存 `sessionStorage` | `src/public/auth.js:8,24` | 关标签页 / 新标签页都要重输 |
| 登录密钥 = 请求凭证 | `src/server.js:446-455` | 无"登录一次、记住设备" |
| 主 token 进入 URL 路径 | `/api/plan/:token/...`、`/api/fs/file/:token/...` | 浏览器历史、代理日志、Referer 泄露 |
| `===` 比较 token | `src/server.js:406,455` | 时序侧信道 |
| token 明文写入实例锁 | `src/server.js:259`（`publishInstanceLock`） | 落盘扩大泄露面 |
| 无用户概念 | 整体 | 会话、Spaces、设置、Claude 历史全员共享 |

## 2. 目标 / 成功判据

- 账号密码登录；重启服务、新开标签页、换浏览器重开后**无需重新登录**（30 天滑动有效期）。
- 用户 A 在 REST 与 WebSocket 上都**看不到、操作不了** B 的 Space、Session、设置、Claude 对话历史；越权访问一律返回 404。
- 每人独立的 Claude 登录状态、对话历史与 resume 列表（按用户注入 `CLAUDE_CONFIG_DIR`）。
- 管理员可增删 / 停用用户、重置密码、发放邀请码、吊销设备。
- 现有单用户部署**自动迁移、零数据丢失、可回滚**。

## 3. 非目标 / 已知限制（2026-11-04 评审：已接受）

- **无执行隔离。** 所有用户的 Claude 仍以同一个 OS 用户运行，可通过 Bash / Read 等工具读到他人工作区、`~/.cc-web/data/platform/`（含密码哈希、登录会话、平台 API key）、他人 `CLAUDE_CONFIG_DIR` 下的内容。
- `rootDirs` 只是 UI / API 层的范围约束，**不是安全边界**。
- 适用前提：**互相信任的团队**。需要真隔离时按第 11 节演进到容器。

## 4. 核心概念 / 数据模型

| 实体 | 字段 | 说明 |
|---|---|---|
| `User` | `id, username, passwordHash, role(admin/user), rootDirs[], claudeConfigDir(可空), disabled, createdAt` | 平台用户；`passwordHash` 为 scrypt + 盐；`id` 形如 `u-<8位hex>`，与数据目录里已有的名字（`sessions`、`instances`、`platform` 等）不会冲突，改用户名也不用搬目录 |
| `LoginSession` | `id(只存 sha256), userId, ua, ip, createdAt, lastSeenAt, expiresAt` | 一台设备一条，可单独吊销 |
| `Invite` | `code, role, expiresAt, usedBy` | 管理员发放，自助注册用 |
| `Space` | 现有字段 + `ownerId` | 按用户存储 |
| `Session` | 现有字段 + `ownerId` | 按用户存储 |
| `UserSettings` | `scrollback, planDirs` | 原全局设置下放到用户 |

## 5. 存储布局

```
~/.cc-web/data/
  platform/
    users/<uid>.json
    login-sessions/<sidHash>.json
    invites/<code>.json
    server-secret                 # 0600，持久化签名密钥
    anthropic-key                 # 0600，平台统一 API key（决策 4）
  <uid>/                          # 每个用户一个目录（决策 3）
    spaces.json                   # 原 spaces.json
    sessions/<id>.json            # 原 sessions/
    settings.json                 # 原 scrollback.json / plan-dirs.json
    claude/                       # 该用户的 CLAUDE_CONFIG_DIR
    workspace/                    # 默认 rootDir
```

决策 3 定的是 `~/.cc-web/data/<uid>`，这里理解为：用户目录 = `~/.cc-web/data/<uid>/`，默认文件浏览根 = 其中的 `workspace/`，元数据和工作文件分开放。如果希望浏览根就是 `<uid>/` 本身，评审时说明。

- 延续"一实体一文件、显式删除"原则（理由见 `src/utils/session-store.js` 头注释：整体重写的共享文件在多写者下会静默丢数据）。
- `src/utils/data-dir.js` 新增 `platformDir()`、`userDataDir(uid)`，仍是"数据在哪"的唯一答案。
- `SessionStore` / `SpaceStore` 改为构造时注入目录（二者已支持替换 `storageDir`，改动小）。

## 6. 认证设计

- **密码**：`crypto.scrypt` + 随机盐，比较用 `crypto.timingSafeEqual`；不引入新依赖。登录接口限速复用 `AuthManager.rateLimit`（`src/utils/auth.js`），按 IP + 用户名两个维度。注意：这个限速器目前没有被任何代码引用（FEATURES.md `GAP-01`），所以这里是第一次真正接上，属于对已登记条目的改动，需要确认。
- **会话**：服务端会话（而非无状态 JWT，以便吊销与设备列表）。登录后下发 Cookie `ccw_sid`：`HttpOnly; SameSite=Strict; Path=/`，HTTPS 下加 `Secure`；30 天滑动续期。服务端只存 sid 的 sha256；内存 Map 缓存 + 文件持久化，重启后仍有效。
- **CSRF**：`SameSite=Strict` + 所有写请求与 WS 升级校验 `Origin` 与 Host 一致。
- **WebSocket**：`verifyClient`（`src/server.js:1063`）改为解析 Cookie → 得到用户 → 挂到 `ws.user`；去掉 `?token=`。
- **URL-token 路由**：`/api/plan/...`、`/api/fs/file/...` 是浏览器导航，会自动携带 Cookie → 新增不带 token 段、用 Cookie 认证的路径，前端改用新路径。**旧路径和旧 token 认证在 M1–M4 期间继续可用**，等全部验证通过后，单独在 M5 中移除（决策 6）。单次票据 `createFileTicket` / `takeFileTicket` 保留，并绑定 `userId`。
- **Hook 回调** `/api/hooks/:sessionId`：沿用每会话 hookToken（CLI 进程调用，与用户登录无关），不变。
- **实例锁**：`publishInstanceLock` 不再写 `authToken`。
- **首次引导**：无任何用户时，终端打印一次性 `/setup?code=xxxx`（10 分钟有效、一次性）用于创建管理员。CLI：`cc-web user add <name> [--admin]`、`cc-web user passwd <name>`、`cc-web user disable <name>`、`cc-web user list`。
- **旧参数**：
  - `--disable-auth` → 决策 5 定为移除。M1–M4 期间暂时保留，语义为"所有请求视为默认 admin"，保证过渡期测试和现有用法不坏；M5 中移除。
  - `--auth` / `--auth-file` / `CCWEB_AUTH` → M1–M4 期间继续作为 admin 的旧 token 登录方式可用；同时作为迁移时 admin 的初始密码。是否在 M5 中废弃，到时单独确认（决策 6、7）。

## 7. 授权改造（服务端核心）

**运行时结构**：PTY 与 WS 路由仍用全局 `this.claudeSessions`（会话 id 为 UUID，全局唯一），每个会话增加 `ownerId`。`broadcastToSession`、流控（pause/resume）、hook 转发都不动。持久化按 `ownerId` 写入对应用户目录。

**统一入口**，替换请求路径上所有直接的 `this.claudeSessions.get(id)`：

```js
getOwnedSession(user, id) {
  const s = this.claudeSessions.get(id);
  return s && s.ownerId === user.id ? s : null;   // 非本人 → 404，不暴露存在性
}
```

**Tenant 缓存**：`tenants.get(uid) → { spaceStore, sessionStore, spaces, settings }`，首次请求时懒加载。

**接口改动**：

| 范围 | 改动 |
|---|---|
| `/api/sessions/*`、`/api/close-session`、`/api/hooks/:id/answer` | 经 `getOwnedSession`；`list` 只返回本人会话 |
| WS `create_session` | 写入 `ownerId = ws.user.id` |
| WS `join_session` / `start_claude` / `input` / `resize` / `stop` / `pause` / `resume`（`server.js:1173-1258`） | 先校验归属；`join` 是关口，守住它广播即只到本人 |
| `/api/spaces*` | 读写 `tenant.spaces`；现有按目录迁移逻辑（`server.js:102-145`）改为按用户执行 |
| `/api/folders`、`/api/fs/*`、`create-folder`、`set-working-dir`、`folders/select`、`git/*`、`plan*` | 路径须落在 `user.rootDirs` 内；`baseFolder` 与 `/api/config` 的 `homeDir` 改为用户首个 rootDir |
| `/api/settings/scrollback`、`/api/plan-dirs` | 存用户 `settings.json`；admin 维护全局默认值 |
| `/api/upload-image` | 写入用户目录下的临时区 |
| `/api/skills*` | 按用户的 `CLAUDE_CONFIG_DIR` 扫描 |

## 8. Claude 按用户隔离

当前所有人共用 `~/.claude`：登录态、`projects/` 下的对话记录（resume 列表）、skills、plugins 都是同一份。

- spawn 时注入 `CLAUDE_CONFIG_DIR=userClaudeDir(ownerId)`（`src/claude-bridge.js:162` 的 childEnv）。
- 硬编码 `~/.claude` 的位置改为接收 configDir 参数：
  - `src/utils/claude-history.js`：`listConversations`、`hasConversation`、`listUserPrompts`
  - `src/claude-bridge.js:440`：`session-env` 清理路径
  - `src/server.js:2910`：plugins 路径；以及 skills 扫描
- 迁移来的 admin：`claudeConfigDir` 为空 → 不注入，继续使用 `~/.claude`，老历史可见。

### 8.1 平台统一 API key（决策 4）

- 管理员在 `platform/anthropic-key`（0600）或环境变量 `CCW_ANTHROPIC_API_KEY` 中配置一个 Anthropic Console API key（按量计费）。不使用个人订阅的登录态让多人共用。
- **M3 的做法：直接注入。** spawn 时设置 `ANTHROPIC_API_KEY=<平台 key>`。用户不需要 `/login`，打开终端就能用。代价：用户在自己的终端里 `echo $ANTHROPIC_API_KEY` 就能看到真实 key（属于第 3 节已接受的限制）；也没有按人统计用量。
- **建议的 M6：LLM 网关**（可选，决策 8）。cc-web 内置一个 `/llm/*` 反向代理：
  - 子进程拿到 `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/llm` 和 `ANTHROPIC_API_KEY=<该用户的虚拟 key>`；
  - 代理用虚拟 key 识别用户，换成真实 key 再转发（流式透传）；从响应的 `usage` 字段记录每人的 token 用量；
  - 可以设每人的日/月限额，超限返回 429；停用用户 = 虚拟 key 立即失效；
  - 真实 key 不再出现在任何用户进程的环境变量里（但磁盘上仍然可读，同属第 3 节的限制）。
- 首次启动时 Claude 会做一次性的初始化（主题选择、是否信任该目录、是否使用环境变量里的 API key 等）。M3 中实测后，预先写好每个用户 `CLAUDE_CONFIG_DIR` 的初始配置，让用户直接进入可用状态。

## 9. 管理功能

- `GET/POST/PATCH/DELETE /api/admin/users`：创建、角色、rootDirs、重置密码、停用 / 删除。停用或删除时：吊销其全部 LoginSession、断开其 WS、停止其 PTY。
- 两种开户方式都提供（决策 2）：
  - 管理员直接创建：管理页或 `cc-web user add`，设置初始密码，用户首次登录强制修改密码。
  - 邀请码自助注册：`POST /api/admin/invites` 生成邀请码（可设角色、有效期、一次性），用户打开 `/register?invite=` 自己设用户名和密码。
- `GET /api/admin/sessions`：所有用户在线会话数与资源占用的只读总览。
- 所有 `/api/admin/*` 要求 `role === 'admin'`。

## 10. 前端

- `src/public/auth.js`：token 弹窗 → 登录页（用户名 + 密码）；删除 `sessionStorage` 中的 token 逻辑；`fetch` 依赖同源 Cookie，不再带 Authorization 头；WS URL 去掉 `token`；401 统一跳登录页，登录后回到原会话。
- 用户菜单：当前用户、修改密码、已登录设备（可吊销）、退出。
- admin：用户管理页（列表、新建、停用、重置密码、邀请码）。

## 11. 迁移与回滚

**自动迁移**（首次以新版本启动，检测到"存在旧数据且无任何用户"）：
1. 创建 `admin` 用户；初始密码依次取 `--auth-file` → `CCWEB_AUTH` → `--auth`，都没有则走 setup 链接。
2. `data/sessions/`、`spaces.json`、`scrollback.json`、`plan-dirs.json` rename 到 `<adminUid>/`（后两者合并进 `settings.json`，原文件保留）；所有会话补 `ownerId=<adminUid>`。
3. admin 的 `claudeConfigDir` 置空，继续用 `~/.claude`。
4. 遵循 `data-dir.js` 原则：同文件系统 rename、不删除、失败回退原位、best-effort 不阻塞启动；幂等，重复启动不重复迁移。

**回滚**：
1. 代码回退到基线 `99aa26f`（或上一阶段提交）。
2. 数据还原：
   ```bash
   D=~/.cc-web/data   # 或实例的 CCW_DATA_DIR
   A=u-xxxxxxxx       # admin 的 uid，见 $D/platform/users/
   mv "$D/$A/sessions" "$D/sessions"
   mv "$D/$A/spaces.json" "$D/spaces.json"
   # scrollback.json / plan-dirs.json 迁移时未删除，无需处理
   ```
3. 回滚后旧版本忽略 `platform/` 与其他用户目录，不受影响。

**演进到真隔离**：每用户数据已集中在 `<uid>/`、Claude 配置经 `CLAUDE_CONFIG_DIR` 注入、运行时经 `ownerId` 路由。上容器时只需把 `<uid>/` 挂卷、把"spawn PTY"换成"在用户容器内 exec"，认证、数据模型、前端不变。

## 进度

- ✅ M1 — 认证（2026-11-05，分支 `feat/multi-user-m1`，未提交）：全量测试 676 通过（原 646 + 新增 30，`test/auth-login.test.js`；含 /code-review 10 条意见的处理：8 条修复、#5 令牌猜错限流、#8 反向代理写进 README）；在临时实例（32354，临时数据目录）上用浏览器实测：令牌 → 建管理员 → 登录、页面不存令牌且 Cookie 对 JS 不可见、**重启服务后刷新仍保持登录**、WebSocket 用 Cookie 连通、`-` 令牌段的 plan 链接走 Cookie、退出后回到登录框、错误密码提示、正确密码登录。FEATURES.md 实际改动 SRV-02/03/10、GAP-01，新增 SRV-24~27；SRV-11、FILE-07、FILE-26 描述里没有提到令牌，未改。待你验证后部署 dev(32353)。
- ✅ M2 — 数据归属（2026-11-05，分支 `feat/multi-user-m2`，未提交）：全量测试 688 通过（M1 的 676 + 新增 12，`test/multi-user-data.test.js`）；用 stable 真实数据的副本在临时实例上实测：建第一个管理员时 7 个会话和空间自动移进管理员目录、重启后不再读根目录；第二个用户 REST 看不到也碰不到管理员的会话和空间（列表空、详情 404、计数 0），WebSocket 自动加入被忽略、join 答「Session not found」，管理员自己 join 正常。
- ⏳ M3 — Claude 按用户隔离
- ⏳ M4 — 管理与体验
- ⏳ M5 — 移除旧 token 路径与参数（全部验证通过后，逐项确认）
- ⏳ M6 — LLM 网关：按人计量与限额

## 12. 阶段

### M1 — 认证（后端 + 前端 · 中风险 · 约 2–3 天）

开工前细化（2026-11-05），范围收窄为"只加不减"，旧行为全部保留：

- **新文件**：`src/utils/password.js`（scrypt 哈希 / 校验）、`src/utils/user-store.js`（`platform/users/`、`platform/login-sessions/` 的一实体一文件存储，内存缓存）、`src/utils/cookies.js`（解析 / 生成 Cookie，不引入 cookie-parser）。
- **Cookie 名带端口**：`ccw_sid_<port>`。Cookie 不按端口隔离，stable(32352) 和 dev(32353) 在同一主机上会互相覆盖同名 Cookie。
- **统一的身份解析** `resolveAuth(req)`：先看 Cookie 会话 → 用户；再看旧 token（请求头 / WS 查询参数）→ 视为 admin。REST 中间件、WS `verifyClient`、plan / file 路由都走它。Cookie 认证的写请求和 WS 升级校验 `Origin`。比较一律 `timingSafeEqual`。
- **首次建管理员 = 用启动令牌**：没有任何用户时，登录框先要启动令牌（就是现在打印 / `--auth-file` 里的那个），验证通过后设置管理员用户名和密码，同时签发 Cookie。不另设 setup code。
- **旧 token 登录换成 Cookie**：`/auth-verify` 验证成功时同时签发 admin 的 Cookie 会话，之后浏览器不再保存 token，重启也免登录。
- **新接口**（在全局认证中间件之前注册）：`POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/auth/me`、`POST /api/auth/setup`。`/auth-status` 增加 `user`、`setupRequired` 字段（原字段不变）。
- **登录限速**：接上 `AuthManager.rateLimit`（`src/utils/auth.js`，GAP-01），按 IP 和用户名各 10 次 / 分钟。
- **plan / file 链接**：URL 形状不变，Cookie 登录时 token 段填已有的占位符 `-`，服务端用 Cookie 认证；带 token 的旧链接继续可用。
- **前端** `src/public/auth.js`：登录框改为用户名 + 密码，保留"用访问令牌登录"切换；首次无用户时显示建管理员表单；`getAuthHeaders` / `getWebSocketUrl` 在 Cookie 登录时不带 token。其余文件基本不用改（`fetch` 默认带同源 Cookie）。
- **测试辅助**：`test/helpers/auth.js`，在临时数据目录建用户并签发 Cookie（为 M5 移除 `--disable-auth` 做准备）。
- **推迟**：`cc-web user` 命令行子命令、邀请码、改密码界面 → M4；实例锁里的 token（SRV-17）→ M5 再议。
- 产出：此时仍只有一个用户（admin），但已"重启免登录、换标签页免登录"。

### M2 — 数据归属（后端为主 · 高风险 · 约 3–4 天）
- 会话 `ownerId`、`getOwnedSession`、Tenant 缓存、按用户存储。
- REST 与 WS 全量归属校验（第 7 节表格）。
- 自动迁移逻辑与回滚说明验证。
- 产出：多用户可用，Spaces / 会话互不可见。
- 风险点：遗漏某个直接访问 `claudeSessions` 的路径 → 用越权测试矩阵兜底。

开工前细化（2026-11-05，基于对 `src/server.js` 的逐处梳理）：

- **身份**：`actorOf(req)` = 请求上的用户（Cookie 用户；令牌 = 第一个管理员）。还没有任何用户时为 `null`，对应"无主"桶 = 现在的数据目录根，行为与现在完全相同（测试和未建管理员的实例不受影响）。WebSocket 连接记录 `wsInfo.userId`。
  - **实现时调整（2026-11-05）**：`--disable-auth` 时也用无主桶，而**不是**第一个管理员。原因：现有测试都以关闭认证的方式、对着真实数据目录构造服务器；一旦 stable 建了管理员，按"视为第一个管理员"就会让 `npm test` 读写真实管理员的目录。`--disable-auth` 本身在 M5 移除，这个调整不影响平台用户。同理，单用户数据交给管理员（SRV-28）只在服务真正启动（`start()`）和建好第一个管理员时执行，不在构造函数里执行，关闭认证时也不执行。
- **存储**：用户桶 = `<dataDir>/<uid>/`，内含 `sessions/`、`spaces.json`、`scrollback.json`；无主桶 = `<dataDir>/` 根。每个桶一个 `SessionStore` + `SpaceStore`（两者已支持改 `storageDir`），懒加载缓存在 `tenants` 里。运行时 PTY 仍在全局 `claudeSessions`，会话带 `ownerId`，保存时按 `ownerId` 写进各自的桶。
- **迁移**：有管理员且根目录有旧数据时（启动时，或 setup 建好第一个管理员后立即），把根目录的 `sessions/`、`spaces.json` rename 到 `<adminUid>/`，`scrollback.json` 复制过去（原文件保留），内存里的无主会话补 `ownerId`。只 rename、不删除，失败则原地继续用。
- **统一入口**：`getOwnedSession(actor, id)`，非本人 → REST 404 / WS「Session not found」。覆盖：会话详情、改名、删除、提问清单、图片上传、计划目录读写、权限应答、技能面板的 sessionId、WS 自动加入 / join / stop（stop 补上原来缺的连接检查）。
- **列表与计数**：会话列表、空间列表、`/api/sessions/persistence`、`/api/health` 的会话数，只算自己的。
- **空间**：增删改查都在自己的桶里；重名 / 重复目录检查只在自己的空间里；删除空间只清自己会话的 `spaceId`；按目录的一次性空间迁移按桶分别执行。
- **设置**：历史保留量（scrollback）按用户；修改时只调整自己会话的缓冲。全局计划目录保持实例级（`plan-dirs.json` 在根目录，`--plans-dir` 照旧预置；设置面板里本来就是只读）；会话计划目录照旧按会话。
- **计划文件链接**：带会话的形式要求是自己的会话；不带会话的形式只合并自己会话的工作目录。
- **工作目录选择**（`selectedWorkingDir`、`/api/config`）：按用户分开。
- **对话占用（409）**：M2 里 Claude 的对话记录仍是共享的，两个会话写同一个对话会损坏记录，所以别人占用的对话照样拒绝（409），但**不返回对方的会话 id**，提示「其他用户正在使用这个对话」；对话列表里显示为不可选。
- **不变**：文件删除保护所有用户会话的工作目录（更安全）；hook 回调（每会话 hookToken）；文件浏览范围（rootDirs 在 M4）；Claude 对话记录（M3）。

### M3 — Claude 按用户隔离 + 平台 key（后端 · 中风险 · 约 2 天）
- 注入 `CLAUDE_CONFIG_DIR`；改造 claude-history、session-env、plugins、skills 路径。
- 平台 key 配置与注入 `ANTHROPIC_API_KEY`；预置每个用户的 Claude 初始配置，跳过首次引导。
- 产出：对话历史、resume 列表各自独立；新用户不需要 `/login` 就能用。

### M4 — 管理与体验（前端为主 · 低风险 · 约 2–3 天）
- `/api/admin/*` 与管理页、管理员创建 + 邀请码注册、首次登录强制改密码、设备列表与吊销、rootDirs 约束、用户菜单。

### M5 — 移除旧 token 路径与参数（低风险 · 约 0.5 天）
- 前提：M1–M4 全部在 stable 上验证通过（决策 6）。
- 候选移除项：`/api/plan/:token/...`、`/api/fs/file/:token/...` 的 token 段，WS `?token=`，token 登录框，`--auth` / `--auth-file` / `CCWEB_AUTH` 的 token 登录语义。
- **每一项单独列出、经你确认后才移除**（决策 7）；未确认的保留。
- **已确认移除：`--disable-auth`（CLI-04，决策 5）。** 配套工作：
  - M1 先提供测试辅助函数：在临时数据目录里直接创建用户、签发登录 Cookie，测试不经过登录页也能拿到合法身份；
  - M1–M4 期间把依赖 `--disable-auth` / `noAuth` 的 10 个测试文件（`fs-browse`、`fs-delete`、`fs-upload`、`fs-render-inline`、`hook-endpoint`、`claude-resume`、`instance-lock`、`git-branches`、`permission-card`、`async-route-safety`）逐个改用这个辅助函数，每改一个跑一次全量测试；
  - M5 删除参数和服务端所有 `noAuth` 分支；`test/SMOKE.md` 的临时实例改为"启动后用 `cc-web user add` 建测试用户"；同步更新 CLAUDE.md 和 README 里提到 `--disable-auth` 的地方（如文件票据"在 `--disable-auth` 模式下同样适用"一句）；
  - 部署时用 `--allow-removal CLI-04` 放行。

### M6 — LLM 网关（后端 · 中风险 · 约 2–3 天）
- 见 8.1。决策 8 已定：做。

## 13. 测试 / 验证

扩展 `test/*.test.js`（沿用现有 Mocha + `node:assert`、临时目录、不起真实 CLI 的风格；参考 `test/session-store.test.js`）：

- **认证**：错误密码；限速触发；Cookie 过期 / 吊销后 401；`Origin` 不符拒绝；WS 无 Cookie / 无效 Cookie 拒绝；setup code 一次性、过期失效。
- **越权矩阵**：用户 B 携带 A 的 sessionId / spaceId，对每个 REST 接口与每种 WS 消息类型发起请求 → 全部 404 / 拒绝。
- **迁移**：旧布局 fixture → 新布局，会话 / Spaces / 设置完整；重复启动幂等；rename 失败时回退原位且服务正常启动。
- **Claude 隔离**：spawn env 含正确 `CLAUDE_CONFIG_DIR`；claude-history 读取对应目录；admin 未设置时不注入。

手工验证（dev 32353）：
- 两个浏览器分别登录 alice / bob：会话、Spaces、resume 列表互不可见。
- 重启服务后两个浏览器均免登录。
- admin 停用 bob → bob 的页面立即掉线、PTY 停止。

## 部署节奏

M1 → 你验证登录体验 → M2 → M3 → M4。
每阶段：dev 提交 → 32353 验证 → ff 部署 32352（`ts/deploy-32352.sh`，过 `features-gate.sh`）→ 记录回滚锚点。M2 部署前先备份 `~/.cc-web/data`。

**与 FEATURES.md 规则的关系**（决策 7）：已登记的功能**不论改还是移除，都要先经你确认**。执行方式：
- 每个阶段动手前，先列出这个阶段会改动或移除的 FEATURES.md 条目（ID + 改成什么），你确认后再写代码；你的确认原话和日期记在本文档第 15 节。
- 实现时在同一个提交里更新 FEATURES.md；部署时如有移除，用 `--allow-removal <IDs>` 精确放行。
- 新增的入口（登录、登出、setup、注册、`/api/admin/*`、`cc-web user` 子命令、用户菜单等）在同一个提交里登记。

预计受影响的已登记条目（每个阶段开工前再逐条核对）：

| 阶段 | 条目 | 预计变化 |
|---|---|---|
| M1 | SRV-02 | 认证方式从"只有 token"扩展为"Cookie 会话 + 兼容 token"；新增登录、登出、setup 接口 |
| M1 | SRV-03 | 登录框从 token 输入改为用户名 + 密码；令牌不再只存在当前标签页 |
| M1 | SRV-10、SRV-11、FILE-07、FILE-26 | 新增 Cookie 认证的路径；旧的 token 路径保留（M5 再定） |
| M1 | CLI-03、CLI-11 | 旧 token 参数仍可用，另作为迁移时 admin 的初始密码；输出文案调整 |
| M1 | CLI-04 | 过渡期语义改为"所有请求视为默认 admin"；M5 移除（已确认） |
| M1 | GAP-01 | 限速器第一次真正接上（登录接口） |
| M1 | GAP-02 | 不动（M1 不改启动打印逻辑，只追加一行"首次用此令牌创建管理员"提示） |
| M2 | 会话、Spaces、文件浏览相关条目 | 列表和访问范围变为"只有自己的"。具体 ID 在 M2 开工前列出 |
| M3 | CLA-*、会话续接相关条目 | spawn 环境变量增加；对话历史改为按用户读取。具体 ID 在 M3 开工前列出 |
| M5 | SRV-02/03/10/11、FILE-07/26、CLI-03/04/11 | 逐项确认是否移除 |

## 14. 评审决策

| # | 决策点 | 结论（2026-11-04） |
|---|---|---|
| 1 | 是否接受第 3 节的已知限制 | ✅ 接受没有执行隔离 |
| 2 | 注册方式 | ✅ 管理员创建和邀请码注册都要 |
| 3 | 用户目录 / 默认 rootDir | ✅ `~/.cc-web/data/<uid>/`，默认浏览根为其中的 `workspace/`（2026-11-05 确认："按你理解的来"） |
| 4 | Claude 凭证 | ✅ 平台统一 key（见 8.1） |
| 5 | 是否保留 `--disable-auth` | ✅ 选 C：移除，一律要登录（M5 执行，见下） |
| 6 | 旧 URL-token 路由何时移除 | ✅ 当前全部验证通过后再移除（M5） |
| 7 | 已登记功能的改动 / 移除 | ✅ 不论改还是移除，都要逐项确认（见"部署节奏"） |
| 8 | 是否做 LLM 网关（按人计量与限额） | ✅ 做（2026-11-05："做网关"，见 8.1、M6） |

## 15. 已登记功能变更确认记录

> 2026-11-04 用户原话："已登记的功能，不管改还是移除，都要让我确认。"

| 日期 | 阶段 | 条目 | 变更 | 用户确认原话 |
|---|---|---|---|---|
| 2026-11-05 | M1 | SRV-02、SRV-03、SRV-10、SRV-11、FILE-07、FILE-26、GAP-01 | 按 M1 细化方案改动（只增不删：加 Cookie 会话、用户名密码登录、首次用启动令牌建管理员、链接令牌段用 `-` 走 Cookie、登录限流）；新增登录相关接口登记 | "确认，开始M1" |
| 2026-11-05 | M1 | SRV-02 | 启动令牌加猜错限流：同一地址一分钟猜错 10 次后，该分钟内拒绝（REST 429、WebSocket 拒连），覆盖请求头、WebSocket、plan / file 链接、`/auth-verify`（/code-review #5） | "5加限流，8写文档" |
| 2026-11-05 | M2 | SRV-05/07/08/09/10/15/16/17/18/21/22/23、CLI-09/10、TERM-22/29/42/45/49、START-04/07/10、SES-02/04/05、NEW-12/16、SPACE-01/02/03/04/06/08、TAB-06、SET-06/07/11/12/13、CLA-09/18、UI-04 | 按 M2 细化方案改为按用户归属（只看、只改自己的；存储进 `<uid>/`；scrollback 按用户；全局计划目录保持实例级；健康 / 持久化统计只算自己的；别人占用的对话照样 409 但不给对方会话 id）；新增「单用户数据迁移到第一个管理员」登记 | "确认，开始M2" |
| 2026-11-04 | M5 | CLI-04 `--disable-auth` | 移除：关闭认证的模式取消，所有访问都必须登录 | "选C"（针对"A 保留视为 admin / B 仅限 127.0.0.1 / C 移除"三个选项） |
