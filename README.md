# AI Video Production Workspace Beta

AI Video Production Workspace 是面向 Jenn 本地 Windows 生产环境的、治理优先的 AI 视频生产系统 Beta。

当前接受的 Jenn 本地运行版本为 `0.1.0-beta.5`，MCP service 版本为 `webgpt-v4.3.0`，Remote App service 为 `readonly-remote-v1.0.0`，数据库 schema 为 `workbench-v2-5`，活动库已验收至 migration ledger `0008`。Readonly ChatGPT MCP App 已完成 Jenn 单用户真实活动库验收；系统状态为 `JENN_SINGLE_USER_MCP_APP_PASS`、`MANUAL_PUBLISH_OPERATIONAL_READY` 和 `PARTIAL_MULTI_USER_GATE`。系统已经包含 Workbench V2、WebGPT V4、MCP App、真实 Provider 生成边界、审片、重生成、合成、交付、Memory 与媒体分析能力，但尚不是成熟的无人值守生产服务。

## 当前边界

- Workbench 是唯一允许确认费用、提交真实 Provider、采纳审片结果和交付资产的人类执行面。
- WebGPT V4 默认以 `readonly` profile 运行，只注册六个 `projects.read` 工具；现有有限写入和媒体能力只在显式 `full` profile 中注册。
- WebGPT 的大型读取默认返回 `compact` DTO，结构化结果上限为 128 KiB；超限会明确返回 `RESPONSE_BUDGET_EXCEEDED`，不会静默裁断业务对象。
- WebGPT V4 不得上传媒体、确认费用、提交 Provider、采纳审片、合成、交付或删除资产。
- 未配置 OAuth 时 MCP 必须 fail closed；本项目不提供匿名 MCP 模式。
- Readonly 候选运行时使用 provider-neutral Federated OAuth 与 issuer-bound opaque principal；只有本地显式注册、绑定当前 issuer 且持有 active production-project membership 的 principal 能读取项目。至少存在一个当前 issuer 的 active production owner 时服务才 ready。旧 Descope 配置仅保留一个版本周期的 legacy adapter，不代表通过 portability gate。
- Readonly request admission 固定为全局 8、每 principal 4；容量满时返回 retryable `WEBGPT_REQUEST_BUSY`。
- Provider 密钥、OAuth 配置、私有状态和本地媒体不进入 Git。

## 环境要求

- Windows 10/11
- Node.js `>=22.5.0`；稳定化 CI 目标为 Node.js 22
- npm 11 或兼容版本
- FFmpeg/FFprobe 8.1.2；两者必须可以从 PATH 或 `FFMPEG_PATH` / `FFPROBE_PATH` 解析
- SQLite 使用 Node.js 内置 `node:sqlite`

不要复制真实密钥到仓库。环境变量结构见 `.env.example`；该文件只包含名称和安全默认值。

## 当前可执行命令

```powershell
npm ci
npm run typecheck
npm run build
npm run dev:v2
npm run start:local
npm run windows:start
npm run windows:status
npm run windows:stop
npm run test:windows-runtime
npm run start:webgpt
npm run start:webgpt:cloud
npm run webgpt:publisher:keygen -- --profile <ignored-profile.json>
npm run preflight:webgpt:publisher -- --profile <ignored-profile.json>
npm run publish:webgpt:snapshot -- --profile <ignored-profile.json>
npm run db:backup
npm run db:check
npm run db:migrate
npm run auth:webgpt -- list --db <explicit-database-path>
npm run preflight
npm run preflight:webgpt:oauth
npm test
npm run test:v2
npm run test:v2:ui
npm run test:webgpt:v4
npm run test:webgpt:cloud
npm run test:webgpt:app
npm run smoke:webgpt:app
npm run test:webgpt:eval
npm run eval:webgpt:replay -- --input <sanitized-result.json>
npm run test:h1
npm run test:db
npm run test:v2:browser
npm run secret:scan
```

`start:local` 以前台方式启动本地 Workbench。`windows:start`、`windows:status`、`windows:stop` 提供普通用户权限的 Windows 受管启停入口，但不会创建 Task Scheduler 或配置自动启动。`start:webgpt` 默认只启动 Readonly MCP；只有显式设置 `WEBGPT_V4_PROFILE=full` 才会同时启动媒体网关和现有有限写入工具。`preflight` 默认检查本地 Workbench profile；WebGPT 使用 `npm run preflight -- --profile=webgpt` 并按 Readonly/Full 检查对应端口和依赖，OAuth 缺失时会明确失败并保持 fail closed。外部 Readonly 接线还必须单独运行 `preflight:webgpt:oauth`；该命令不打开数据库，通过 DNS-pinned HTTPS 依次验证 RFC 8414/OIDC metadata、精确 issuer/JWKS、PKCE S256、public-client auth，并按 `predefined | cimd | dcr` 检查对应注册能力。探针不跟随 redirect，也不输出 endpoint 或响应正文。若本机代理只返回 RFC 2544 `198.18.0.0/15` Fake-IP，OAuth discovery 与 JWKS transport 会使用固定、受限的公共 DoH 恢复真实地址；普通 private/mixed DNS 结果仍立即拒绝，恢复后的地址仍必须通过同一校验并被 TLS transport 固定。

Cloud MCP App 交付命令不会自动创建或修改 Render、DNS、Auth0 或 ChatGPT 对象。Publisher profile、DPAPI 私钥材料和脱敏 receipt 必须位于 Git 忽略的 `data/webgpt/publisher/`；`preflight:webgpt:publisher` 只读验证 ledger `0008`、投影和签名，`publish:webgpt:snapshot` 才执行经单独授权的远端 Snapshot 替换。当前 Render Free 实例可能休眠或重启，远端只保存内存 Snapshot；实例重启或 24 小时 TTL 到期后必须手动重新发布。Snapshot v3 已完成精确部署、旧 v2 拒绝、单次重新发布、七工具统一 fingerprint、共享派生状态和 Human Workbench 冷启动恢复真实验收。ChatGPT developer-mode 验收时平台 CSP enforcement 开关未启用，因此 CSP 仍保留为后续平台实测限制。完整边界见 [Readonly MCP App Delivery Runbook](docs/webgpt/READONLY_MCP_APP_DELIVERY_RUNBOOK.md)、[Stage 3 Acceptance](ops/reports/2026-07-17-readonly-mcp-app-stage3-acceptance.md)、[Owner-Only Operations Acceptance](ops/reports/2026-07-18-owner-only-operations-acceptance.md)、[Snapshot v3 Derived State Acceptance](ops/reports/2026-07-19-snapshot-v3-derived-state-acceptance.md) 和 [Snapshot v3 Human Workbench Recovery Acceptance](ops/reports/2026-07-19-snapshot-v3-human-workbench-recovery-acceptance.md)。

本地 Workbench 的“系统 → 只读 App 发布”将上述命令收敛为受 action nonce 和人工确认保护的日常操作面：状态读取不会打开业务行或 DPAPI 私钥，预检不会写 receipt 或远端状态，“预检并发布”才执行一次签名 Snapshot 替换。浏览器不能传入 profile、数据库路径或远端 URL；Workbench 只使用 `WEBGPT_READONLY_PUBLISHER_PROFILE_PATH` 指定的 Git-ignored profile，未设置时使用 `data/webgpt/publisher/profile.json`。该入口已在 Windows Node `22.23.1`、真实活动库 ledger `0008` 和 Provider 关闭条件下完成真实一键发布、Render restart 后 `no_snapshot → 单次确认发布 → 七工具恢复` 及最终 `db:check`。它仍是人工操作，不会创建计划任务、自动发布或自动续期 Snapshot。

### 多用户只读授权

`0.1.0-beta.4` 建立了 Descope 多用户只读服务边界；`0.1.0-beta.5` 接受 provider-neutral Federated OAuth/issuer binding、Auth0 predefined public-client 和 Jenn 单用户 ChatGPT MCP App 路线。旧 Descope principal、membership 和事件继续保留并绑定原 issuer；Jenn 已将第二真实用户路径延期，因此多用户正式验收仍为 `PARTIAL_MULTI_USER_GATE`，但不影响已接受的 owner-only 手动发布基线。完整边界见 [Readonly Federated OAuth Portability v1](docs/READONLY_FEDERATED_OAUTH_PORTABILITY.md)。授权管理命令必须显式提供数据库路径，不会默认写入 `data/app.sqlite`：

```powershell
npm run auth:webgpt -- bootstrap-owner --db <path> --principal <opaque-sha256> --issuer <https-issuer> --project <production-project-id>
npm run auth:webgpt:bootstrap-owner -- -DatabasePath <path> -Issuer <https-issuer> -ProjectId <production-project-id>
npm run auth:webgpt -- register --db <path> --principal <opaque-sha256>
npm run auth:webgpt:bind-principal -- -DatabasePath <path> -Issuer <https-issuer>
npm run auth:webgpt -- grant --db <path> --principal <opaque-sha256> --project <production-project-id> --role viewer
npm run auth:webgpt -- revoke --db <path> --principal <opaque-sha256> --project <production-project-id>
npm run auth:webgpt -- list --db <path>
```

普通管理命令只接受 issuer-bound 的小写 SHA-256 principal，不接受原始 subject、邮箱、token 或凭据。非首个 viewer/owner 的固定顺序是 `register`、`auth:webgpt:bind-principal` 隐藏输入绑定、再 `grant`；未绑定 principal 必须拒绝授权。Windows 专用的 `auth:webgpt:bootstrap-owner` 使用隐藏提示读取 Federated subject，经 stdin 交给本地进程并直接完成原子 owner bootstrap；subject 不进入命令参数、输出或数据库。`bootstrap-owner`、grant/revoke 与 append-only authorization event 在单一事务中完成；只允许授权 `classification=production` 项目。对 Jenn 活动数据库运行这些写命令仍需当次明确授权。完整边界见 [Descope Multi-User Readonly Authorization](docs/DESCOPE_MULTI_USER_READONLY_AUTHORIZATION.md)。

数据库 schema 不再在服务启动时静默升级。首次使用或升级后必须在服务停止状态下显式执行 `npm run db:migrate`；命令会在迁移现有数据库前创建 `ops/backups/` 快照。对 Jenn 活动数据库执行迁移前仍需遵守当前授权边界。

## 本地启动

先构建，再启动 Workbench：

```powershell
npm run build
npm run start:local
```

Workbench 默认监听 `http://127.0.0.1:4181`。WebGPT V4 是独立服务：

```powershell
npm run start:webgpt
```

Readonly 默认仅在 `127.0.0.1:2091` 提供 MCP；Full 额外在 `127.0.0.1:2092` 提供媒体网关。未配置 OAuth 时健康检查可以通过，但 `/readyz` 和 MCP 调用保持关闭。

`WEBGPT_V4_TELEMETRY_MODE` 默认 `off`，不会创建 Telemetry 目录。显式设置为 `jsonl` 时，只向 Git 忽略的 `data/webgpt/telemetry/` 写入请求 ID、工具名、耗时、结果大小和安全错误码等低披露字段；写入或探针失败会使 `/readyz` 返回 503，但不改变工具业务结果。`WEBGPT_V4_WIDGET_DOMAIN` 只接受 HTTPS origin，并与媒体 public origin 分开验证；缺失时允许本地 Full 测试，但外部发布 gate 仍未满足。

### Windows 受管启停

完成显式数据库迁移后，可以使用普通用户权限的受管入口：

```powershell
npm run windows:start
npm run windows:status
npm run windows:stop
```

`windows:start` 在后台启动 Workbench 前会：

- 要求 Node.js 22；默认解析 `ops/tools/node-v22.23.1-win-x64/node.exe`，也可通过 `AI_VIDEO_NODE22_PATH` 指定其他 Node 22 可执行文件；
- 显式设置 `REAL_PROVIDER_ENABLED=false`、`M1_REAL_PROVIDER_EXECUTION_ALLOWED=false` 和 `M1_REAL_PROVIDER_COST_ACK=false`；
- 运行本地 `preflight` 和完整 build；
- 检查 PID、进程启动时间、Node 路径和 4181 端口，拒绝覆盖未知监听进程；
- 使用 60 秒总 deadline 等待 `/healthz` 与 `/readyz`，通过后才写入本地受管状态。

PID 状态和按次启动日志只写入 Git 忽略的 `ops/tools/workbench-runtime/`，也可通过 `AI_VIDEO_WORKBENCH_RUNTIME_ROOT` 指向工作区内的其他隔离目录。`windows:stop` 只有在 PID、进程身份和监听端口同时匹配时才会发送带一次性 token 的本地 graceful shutdown 请求；等待超时后才使用强制终止，并在结果中明确标记 `forced`。状态不一致时保持现场并 fail closed。`test:windows-runtime` 使用隔离数据库、状态目录和非生产端口覆盖 start/status/重复 start/graceful stop/强制 fallback，并在最后运行 `db:check`。当前命令不会创建或修改 Windows Task Scheduler，自启动仍需后续单独授权。

## 数据边界

- `data/app.sqlite*`：本地运行数据库，不进入 Git。
- `data/media/`、`data/imports/`：本地媒体与导入，不进入 Git。
- `data/reports/`：经筛选的项目证据，可按仓库规则进入 Git。
- `.env`、凭据、Provider payload、私有日志和本地状态：不得提交、打印或复制。

任何真实数据库迁移、批量历史文件移动、Provider 付费调用、发布或部署，都必须通过适用的授权边界。

## 稳定化路线

本版本冻结 WebGPT V5、Workbench V3 和新 Provider。GPT 服务面已完成默认 Readonly、严格 DTO、Compact context、离线 eval、Widget v2 metadata、低披露 Telemetry、Descope JWT 验证、显式项目 membership 与有界并发收敛；Descope tenant/ChatGPT connector 的实际外部切换、Secure MCP Tunnel、外部 HTTPS、媒体外部开放、Windows 自动启动、Full/Auth0 外部化与真实 Provider canary 仍是后续独立 gate。

SR0–SR5 已合入 `main`。SR6 disposable Stage 1 已使用隔离数据库完成迁移、完整性检查、备份恢复、preflight 和两轮启停验收，脱敏证据见 [SR6 Disposable Database Acceptance](ops/reports/2026-07-13-sr6-disposable-acceptance.md)。经 Jenn 单独明确授权，active-database Stage 2 又完成活动库备份、迁移、`db:check`、隔离恢复、核心记录一致性比较、两轮只读黄金路径和有界 soak，脱敏证据见 [SR6 Active Database Acceptance](ops/reports/2026-07-13-sr6-active-database-acceptance.md)。beta.4 活动库验收进一步应用 migration `0007`，脱敏证据见 [Beta 4 Active Database Acceptance](ops/reports/2026-07-14-beta4-active-database-acceptance.md)。MCP App Stage 3 已将活动库迁移至 `0008`，完成 issuer binding、恢复演练、真实 Snapshot 发布、七工具、Workbench、关闭—重开与有界 soak；脱敏证据见 [Stage 3 Acceptance](ops/reports/2026-07-17-readonly-mcp-app-stage3-acceptance.md)。`0.1.0-beta.5` 现为 Jenn 接受的单用户手动发布运行基线；多用户验收、自动同步和自动启动仍未完成。

详见 [当前状态](CURRENT_STATE.md)、[Stabilization Remediation](docs/STABILIZATION_REMEDIATION.md)、[GPT Service Capability Hardening](docs/GPT_SERVICE_CAPABILITY_HARDENING.md)、[架构](docs/ARCHITECTURE.md) 和 [Stabilization Release v2 taskbook](docs/STABILIZATION_RELEASE_V2.md)。
