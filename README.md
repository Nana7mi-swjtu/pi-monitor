# pi-monitor

跨会话、跨天的 pi 用量账本 + 本地浏览器仪表盘：**token 用量、人民币成本、每日热力图、多维分解、预算提醒**。

- **唯一入口**：在 pi / pi-web 里输入 `/tokens`，浏览器随即打开仪表盘。本插件不提供 CLI、不在终端里打印报表。
- **零第三方运行时依赖**：只用 Node 内置模块；`.ts` 源码由 pi 的 jiti 直接加载，无构建步骤。
- **数据全在本机**：`~/.pi/agent/pi-monitor/`，无遥测。唯一可选的出站请求是汇率查询（可在配置里关闭）。
- **货币**：账本里金额恒为美元（pi 的事实口径），展示层按汇率换算为人民币 `¥`；汇率可手动设置，也可自动联网获取（默认开启，12 小时最多取一次）。

---

## 目录

- [安装](#安装)
- [使用](#使用)
- [配置](#配置)
- [统计口径](#统计口径)
- [数据目录](#数据目录)
- [项目结构](#项目结构)
- [FAQ](#faq)
- [开发](#开发)

## 安装

发行名是 npm 包 **`@evan7der/pi-monitor`**（与仓库/插件名一致）。用 scoped 名是因为 npm 上不带 scope 的 `pi-monitor`
已被另一位作者占用（macOS 后台进程扩展），而不是本插件。扩展在**会话创建时加载**，因此任何方式安装后都要**重启 pi-web 进程或重开会话**。

### 一、pi CLI + npm（推荐）

```powershell
pi install npm:@evan7der/pi-monitor          # 最新版
pi install npm:@evan7der/pi-monitor@1.2.0    # 锁定版本
pi update --extensions                       # 升级（含本包在内的全部包）
pi remove npm:@evan7der/pi-monitor           # 卸载
```

### 二、pi-web「插件」面板

插件 → 添加包 → 填 `npm:@evan7der/pi-monitor`（面板同样支持 git 源与本地路径）。

### 三、git 源（不想经 npm，或想跟 `main`）

```powershell
pi install git:github.com/Nana7mi-swjtu/pi-monitor
```

### 四、本地路径（开发 / 离线）

```powershell
# 把 <本仓库路径> 换成本仓库在你机器上的实际目录（例如克隆后的目录）
pi install <本仓库路径>   # 绝对路径，也接受 ./相对路径
pi --no-extensions -e <本仓库路径>/extensions/pi-monitor/index.ts   # 临时试用，不改配置
```

> 注意：npm 上不带 scope 的 `pi-monitor` 是**别人的包**（macOS 后台进程扩展），不要用 `npm:pi-monitor`。

### 五、只用 npm 手工安装（等价于方式一）

pi 的 npm 包都落在 `<agentDir>/npm/`（默认 `~/.pi/agent/npm/`），它内部执行的就是下面这条命令
（`--legacy-peer-deps` 与 pi 一致，宿主包由 pi 自身提供）：

```powershell
npm install @evan7der/pi-monitor --prefix "$env:USERPROFILE\.pi\agent\npm" --legacy-peer-deps
```

再把包名写进 `~/.pi/agent/settings.json`：

```json
{ "packages": ["npm:@evan7der/pi-monitor"] }
```

安装后**重启 pi-web 进程或重开会话**（扩展在会话创建时加载）。

卸载：`pi remove npm:@evan7der/pi-monitor`（本地路径安装则 `pi remove <路径>`）。
数据目录不会自动删除，手动删除 `~/.pi/agent/pi-monitor/` 即可清空统计（重装后从零开始）。

## 使用

```
/tokens              # 启动/复用仪表盘并自动打开浏览器
/tokens --no-open    # 只启动/复用服务并给出 URL，不开浏览器
/tokens --port 8090  # 指定首选端口（1024..65535）
```

- 命令本身**不打印任何统计内容**，只给出一行 URL（可选再发一条 ≤ 300 字符的链接卡片）。
- 服务默认绑定 `127.0.0.1:30142`；端口被占用时顺延最多 18 个端口，再回退系统空闲端口。
- 同一进程内重复执行 `/tokens` 会**复用**现有服务（端口、进程、token 不变）。
- `session_shutdown` 时按 `dashboard.stopOnExit`（默认 `true`）关闭服务。

### 仪表盘

| 区块 | 内容 |
| --- | --- |
| 页头 | 窗口选择（今天/昨天/近 7 天/近 30 天/本周/本月/全部/自定义）、语言、主题、刷新（重新扫描 + 重载）、`revision`、汇率行（含来源） |
| 概览卡 | 计费 Token / 输入 / 输出 / 缓存读 / 缓存写 / 真实成本 / 估算成本 / 消息数 / 活跃天数 / 会话数，每张带环比 |
| 热力图 | 固定按计费 Token 统计；53 周 × 7 天（随 `weekStart` 对齐），上方月份标签行、左侧星期标签列（每隔一行）；年份选项卡（最近一年 / 各自然年）；格子可聚焦并带 `aria-label` |
| 每日趋势 | CSS 柱状图 + 可展开每日表格；列宽随天数与容器宽自适应，超出时横向滚动 |
| 分解表 | 模型 / Provider / 项目 / 会话 / 来源 / 类型，含占比 |
| 预算进度条 | 日/月各一条，超额变红并显示超支金额 |
| 操作区 | 重新扫描、重建索引（需输入 `REBUILD`）、导出 Markdown / JSON / CSV |
| 设置抽屉 | 汇率（手动值 + 自动获取开关 + 「立即更新」）、语言、主题、预算、页面自动刷新开关、局域网开关（部分键只读） |
| 自动刷新 | 页面打开期间每 30 秒增量扫描 + 重载；切回标签页时立即补一次；可由 `dashboard.autoRefresh` 关闭 |
| 健康面板 | 文件数、记录数、损坏行、无效会话、去重跳过、一致性不符、损坏成本、未知配置键、时区一致性、汇率来源与更新时间、上次扫描耗时、索引大小、数据目录（脱敏） |

导出的 Markdown / JSON / CSV 都在浏览器侧生成（`Blob` + `URL.createObjectURL`），不会写入服务器磁盘。

### 让 agent 用自然语言回答用量问题

插件注册了一个可关闭的工具 `token_stats`。你可以直接问：

> 我今天用了多少 token？这个月哪个模型最贵？

工具返回一句话 + 最多 5 行要点（≤ 1 KiB）与结构化 JSON（人民币金额 + 汇率字段）。

## 配置

`~/.pi/agent/pi-monitor/config.json`（受 `PI_CODING_AGENT_DIR` 影响）。文件缺失时使用默认值，**不会自动创建**；
只有在仪表盘里保存或手工编辑后才会写入。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `locale` | `"auto"` | `zh-CN` / `en-US` / `auto`（→ `PI_MONITOR_LOCALE` → `LANG`/`LC_ALL` → `en-US`） |
| `timezone` | `"local"` | `local` / `utc` / IANA 名称（如 `Asia/Shanghai`） |
| `weekStart` | `"monday"` | `monday` / `sunday` |
| `extraSessionDirs` | `[]` | 额外会话根目录 |
| `dedupe` | `"fingerprint"` | `fingerprint` / `off`（关闭时仪表盘显示警告） |
| `ephemeralCapture` | `true` | 临时会话（无文件）的用量在会话结束时落盘 |
| `defaultWindow` | `"last7d"` | 仪表盘默认窗口 |
| `tableLimit` | `20` | 分解表行数（1..200） |
| `tool.enabled` | `true` | 是否注册 `token_stats`（false 时不注册） |
| `currency.code` | `"CNY"` | 恒定 |
| `currency.rate` | `7.20` | USD → CNY（0.01..100.00，2 位小数）；手动设置的值 |
| `currency.autoRate` | `true` | 是否允许联网自动获取汇率；`false` = 零出站请求（手动「立即更新」仍可用） |
| `currency.rateSource` | `"manual"` | `manual` / `auto`；由插件维护（只读），页头汇率行据此标注来源 |
| `currency.rateFetchedAt` | `null` | 上次自动获取时间（ISO）；超过 12 小时视作过期，下次打开页面时重取 |
| `dashboard.enabled` | `true` | 是否允许 `/tokens` 启动服务 |
| `dashboard.port` | `30142` | 首选端口 |
| `dashboard.portRange` | `18` | 顺延尝试次数 |
| `dashboard.allowLan` | `false` | 绑定 `0.0.0.0`（强制 token 鉴权 + 页面警告，改后需重启服务） |
| `dashboard.stopOnExit` | `true` | `session_shutdown` 时关闭服务 |
| `dashboard.linkMessage` | `true` | `/tokens` 时是否发一条 ≤ 300 字符的链接卡片 |
| `dashboard.theme` | `"auto"` | `auto` / `light` / `dark` |
| `dashboard.autoRefresh` | `true` | 仪表盘页面存活时是否每 30 秒自动重扫 + 重载 |
| `budget.enabled` | `false` | 预算提醒总开关 |
| `budget.dailyCNY` / `budget.monthlyCNY` | `null` | 日/月预算（元） |
| `budget.warnAt` | `[0.5, 0.8, 1.0]` | 触发阈值（0 < w ≤ 1，升序） |
| `budget.includeEstimated` | `false` | 是否把估算成本计入预算 |
| `budget.injectMessage` | `false` | 超支时是否额外注入一条消息 |
| `logging.level` | `"error"` | `off` / `error` / `info` / `debug` |
| `logging.maxFiles` / `logging.maxBytes` | `7` / `5242880` | 日志轮转保留份数与单文件上限 |

仪表盘**可写**的键：`currency.rate`、`currency.autoRate`、`dashboard.theme`、`dashboard.allowLan`、`dashboard.autoRefresh`、`locale`、`budget.*`。
其余键只读（`PUT /api/config` 写入非白名单键返回 403）。未知键会被保留，不会被删除。

### 环境变量

| 变量 | 作用 |
| --- | --- |
| `PI_CODING_AGENT_DIR` | 配置与数据目录的根（默认 `~/.pi/agent`） |
| `PI_CODING_AGENT_SESSION_DIR` | 额外的会话根目录 |
| `PI_MONITOR_LOCALE` | 语言（`zh-CN` / `en-US`） |

## 统计口径

数据源是 pi 的会话文件（`<agentDir>/sessions/**/*.jsonl`），以下是几个容易误解的点：

- **计费 Token** = `input + output + cacheRead + cacheWrite`。`reasoning` **已包含在 `output` 中**，不重复累加。
- **计入用量的 entry**：`assistant` 消息、`toolResult` 消息（工具内的嵌套 LLM 调用）、`compaction`、`branch_summary`。
  `compaction.retainedTail[].usage` 是被保留的历史消息副本，**不计数**（否则会虚增）。
- **去重**：`/clone`、`pi --fork`、跨目录 `--session` 会把源会话 entry 原样复制到新文件，
  因此按 `sha1(entryId|timestamp|provider|model|四个分量)` 前 16 位去重，首见者胜（按时间升序，再按文件路径字典序）。
- **成本**：优先用 pi 记录的 `usage.cost.total`（真实成本）；缺失或为 0 时按
  `~/.pi/agent/models.json` 的定价估算（估算成本）。两者**分开显示，绝不合并**；都不知道时显示 `—`。
- **货币**：账本与 HTTP API 里的金额字段一律是美元；`¥` 金额 = 美元合计 × 汇率（先合计再换算，不逐条换算）。
- **汇率**：`currency.autoRate` 开启时（默认），插件在 `/tokens`、打开仪表盘或点击「立即更新」时按需联网取值，
  结果写回 `currency.rate` 并标注 `currency.rateSource: "auto"`；12 小时内不重复请求。
  取值失败只降级（保留上一次的汇率并在页面上提示），绝不阻塞仪表盘。关闭后零出站请求（NFR-7）。
- **临时会话**：`--no-session` 等无会话文件的会话不落盘，永久统计不可得；开启 `ephemeralCapture`（默认）时会在会话结束时把 usage 写入账本并标记 `ephemeral: true`。
- **没有「本会话（实时）」卡**：它需要一份与账本竞争的内存计数，而该计数只属于单个进程 / 最后启动的会话，
  在多会话与多进程（pi CLI + pi-web）下会长期显示 0；当天用量请看概览卡（页面默认每 30 秒自动重扫）。
- **时间**：以消息级 `message.timestamp` 定位日界；缺失时回退行级时间并在健康面板标记。
- **日界**：默认时区为系统本地时区，可配置为 `utc` 或任意 IANA 名称；“今天/本周/本月”均按该时区计算。
- **图表口径**：热力图与每日趋势固定使用**计费 Token**（不提供指标切换）；成本与消息数看概览卡、分解表与导出。
- **热力图网格**：“最近一年” = 统计末日所在周为末列、向前 53 周（统计范围就是这 53 周本身，范围内的空白日按 0 上色）；
  “年份” = 该自然年 1/1～12/31 对齐到整周（首尾多余日为无背景补齐格）。网格区间由服务端计算下发，前端不自行推导周对齐。

## 数据目录

```
~/.pi/agent/pi-monitor/
├─ config.json        # 用户配置（可缺失）
├─ cursor.json        # 每文件增量游标
├─ ledger.jsonl       # 账本：一条 usage 一行（去重后）
├─ meta.json          # schemaVersion / revision / 统计计数
├─ budget-state.json  # 预算提醒状态
├─ logs/              # 诊断日志（轮转）
└─ *.bak-<ts>         # 重建或修复时的备份
```

## FAQ

**Q：为什么 `/tokens` 第二次执行没有新开浏览器标签？**
按 AC-6.2，服务复用时只打开一次浏览器。第二次执行会在提示里给出完整 URL（含 token），可直接粘贴打开。

**Q：金额对不上账单？**
本插件只做展示层换算，不承诺与供应商账单一致。汇率可手动设置，也可自动联网获取（`currency.autoRate`，默认开启，12 小时最多取一次）。

**Q：自动汇率会联网请求什么？**
只在需要时向公开汇率接口发一个 `GET`（按序尝试 `open.er-api.com` → `api.frankfurter.dev` → `api.exchangerate-api.com`），
不携带任何本地信息；三个接口都失败就保留上次的值并提示。设 `currency.autoRate: false` 后完全不出站（可零出站运行）。

**Q：为什么点「刷新」之前数据没变？**
刷新会先做一次增量扫描再重载。页面打开期间默认每 30 秒也会自动扫描 + 重载，切回标签页时会立即补一次；
若同时开着 pi CLI 与 pi-web，两边的索引会互相同步（账本变化会被另一进程重新载入）。

**Q：页面提示「索引版本高于当前版本」？**
说明 `meta.json` 的 `schemaVersion` 比当前插件更新（例如你降级了插件）。此时插件只读运行，不会写入任何索引文件；
升级插件或点击「重建索引」即可恢复。

**Q：换了时区后日归属不对？**
聚合按当前时区重算日键，页面会提示「时区已变更」。点「重建索引」可把日键持久化重写一遍。

**Q：装了插件但 `/tokens` 不出现？**
扩展在会话创建时加载。重启 pi-web 进程或重开会话；也确认 `tool.enabled` / `dashboard.enabled` 没有被设为 `false`。

**Q：`data` 目录可以删吗？**
可以。删掉后下次 `/tokens` 会重新扫描会话日志重建索引（会丢失预算提醒状态与诊断计数）。

**Q：`pi install npm:pi-monitor` 装不到本插件？**
因为 npm 上不带 scope 的 `pi-monitor` 属于另一位作者；本插件的 npm 包名是 **`@evan7der/pi-monitor`**，请用 `pi install npm:@evan7der/pi-monitor`。

**Q：仓库里的 `node_modules/` 是什么？**
仅用于 `npm run typecheck` 的**开发期**类型检查（`devDependencies`）。运行时依赖为空（`dependencies: {}`），
纯逻辑测试不需要 `node_modules`。删掉它不影响插件运行。

## 项目结构

```
pi-monitor/
├─ package.json                    # pi manifest；dependencies 为空；files 白名单 = extensions/ + src/
├─ README.md / LICENSE
├─ .github/workflows/publish.yml   # 推送 v* 标签 → 校验 → npm publish
├─ extensions/pi-monitor/index.ts  # 唯一扩展入口：/tokens、token_stats、事件
├─ src/
│  ├─ scanner.ts                   # 编排：发现 → 解析 → 去重 → 落账 → 更新 meta
│  ├─ parser.ts / dedupe.ts / ledger.ts / discover.ts
│  ├─ aggregate.ts / money.ts / time.ts / cost.ts / format.ts / budget.ts
│  ├─ config.ts / paths.ts / pricing.ts / args.ts / i18n.ts / health.ts / opener.ts / rates.ts
│  ├─ types.ts                     # 全部类型定义（账本 / 聚合 schema）
│  └─ dashboard/                   # HTTP 服务、API 适配、内联单页应用
├─ test/
│  ├─ unit/ integration/ contract/ # 单元 / 集成 / 契约测试
│  ├─ fixtures/                    # 会话 fixture + 导出 JSON Schema + 生成器
│  ├─ golden/                      # 人工校对过的仪表盘文案期望值
│  └─ bench/                       # 性能基准（500 MiB 语料）
└─ tools/quality-gate.mjs          # 静态约束元测试（禁止“为过测试而实现”）
```

依赖方向（由质量门强制）：`extensions/**` 与 `src/dashboard/**` 可以依赖 `src/**`，
但 `src/**` 不得 import `@earendil-works/*` —— 核心逻辑必须能用纯 Node 测试。

## 开发

```powershell
npm install --include=dev   # 仅类型检查需要（npm 可能默认 omit=dev）
npm run check               # 质量门 + tsc --noEmit + 全部测试
npm run test                # 单元 + 集成 + 契约测试
npm run typecheck           # tsc --noEmit
npm run bench               # 性能基准（生成 500 MiB 语料，约 25 s）
npm run gate                # 静态约束元测试
npm run pack:dry            # 查看 npm 发布产物会包含哪些文件（不落盘、不跑脚本）
npm run fixtures            # 重新生成 test/fixtures/sessions/ 下的会话 fixture
```

### 发布

发布产物就是交付物（`extensions/` + `src/`，外加 npm 恒包含的 `package.json` / `README.md` / `LICENSE`），没有构建步骤。
`npm publish` 前必须 `npm run check` 全绿（`prepack` 已内置）；质量门的「可发布性」检查会执行 `npm pack --dry-run`，
确认打包产物真的包含扩展入口及其全部相对 import。

**第 1 步：首个版本手工发一次**（Trusted Publisher 只能给**已存在**的包配置，所以首次绕不过去）

> ⚠️ npm 现已强制：**发布必须走账号 2FA（模式 `auth-and-writes`，`auth-only` 不够）或 bypass-2FA 的 Granular token**。
> 两者都没有时会直接报 `E403 Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.`
> 另外 `npm login` 拿到的是 **2 小时会话 token**，过期后要重新登录。

```powershell
# 先在 npmjs.com → 头像 → Account settings → Two-Factor Authentication 开启 2FA（TOTP，模式 auth-and-writes）
npm login      # 浏览器 2FA；会话 token 2 小时有效
npm publish --access public   # 会提示 Enter one-time password: 输入有效期 6 位码
#   首次发布前可先干跑：npm publish --dry-run --access public
```

`npm publish` 会先跑 `prepack = npm run check`，全绿才发得出去。

**第 2 步（推荐）：改用 Trusted Publishing（OIDC），此后不需要任何 token**

1. 仓库设为 **public**（Trusted Publishing 与 provenance 都只支持公开仓库）
2. 打开 `https://www.npmjs.com/package/@evan7der/pi-monitor/access` → **Trusted Publisher** → **GitHub Actions**，填：
   - Organization or user：`Nana7mi-swjtu`
   - Repository：`pi-monitor`
   - Workflow filename：`publish.yml`（只填文件名，必须与 `.github/workflows/` 下的文件同名）
   - Environment name：留空
   - **Allowed actions：除了恒允许的 `npm stage publish`，必须再允许直接 `npm publish`**——
     只允许 stage 的话，每次发布会变成需要你人工 2FA 审批的 staged publishing
3. 以后 `npm version patch` + `git push --follow-tags`，由 `.github/workflows/publish.yml` 用 OIDC 发布
   （需要 npm ≥ 11.5.1，workflow 已自动升级；provenance 自动附带）

**备选：用 token 跑 CI**（仓库暂时私有、或不想改公开时）

旧版 Classic token 已于 2025-12-09 全部吊销，现在只能用 **Granular access token**：
头像 → **Access Tokens** → **Generate New Token**，然后

| 字段 | 选什么 | 为什么 |
| --- | --- | --- |
| Bypass two-factor authentication | **勾上** | 不勾则 CI 直接 E403，且不会提示 OTP |
| Permissions | **Read and write (publish and stage)** | `stage only` 只会暂存，需人工审批 |
| Select Packages | **All Packages**（或选中 scope `@evan7der`） | 首个版本前该包还不存在，选不了具体包 |
| Expiration | 最长 90 天 | 到期必须轮换；想免轮换就用 Trusted Publishing |

把它存成仓库 secret `NPM_TOKEN`（Settings → Secrets and variables → Actions → New repository secret）。
GitHub Secrets 不进 git、日志里会打码；**永远不要把 token 写进 workflow / README / `.npmrc` 并提交**。
不需要在 CI 里配 npm 用户名：token（或 OIDC）本身就是身份。

> **provenance**：GitHub 自 2023-07 起不支持“私有仓库源码 → 公开包”的 provenance，所以 workflow 默认
> 不传 `--provenance`；仓库公开后把 workflow 里的 `PROVENANCE` 改成 `"true"`（OIDC 方式会自动附带）。

### 约定

- `src/**` 禁止 import 任何 `@earendil-works/*` 宿主包（保证核心逻辑可用纯 Node 测试）。
- 出站网络只允许来自 `src/rates.ts` 的汇率查询（主机白名单由 `npm run gate` 强制），且必须受 `currency.autoRate` 把关。
- `aggregate.ts` / `money.ts` / `time.ts` / `cost.ts` / `format.ts` / `args.ts` / `dedupe.ts` / `i18n.ts` / `budget.ts` 必须是纯函数（无 IO）。
- 账本记录的字段集合是封闭的：新增字段属于破坏性变更，需要同时改读写两侧与 fixture 断言。
- 不要为了让测试通过而放宽断言或抽掉真实逻辑；`npm run gate` 会拦住这类改动。
- `test/fixtures/sessions/**` 必须保持字节精确（CRLF / BOM / 无尾换行），已在 `.gitattributes` 中标记为 `-text`。

### 提交信息

```
<type>(FR-x): <描述>
```

`type` 取 `feat` / `fix` / `docs` / `test` / `chore` / `refactor`；正文里带上对应的 FR/AC 编号，便于追溯。

## License

[MIT](./LICENSE) © 2026 KaaNoo
