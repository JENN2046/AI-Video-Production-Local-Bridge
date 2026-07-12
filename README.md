# AI Video Production Workspace Beta

AI Video Production Workspace 是面向 Jenn 本地 Windows 生产环境的、治理优先的 AI 视频生产系统 Beta。

当前版本为 `0.1.0-beta.2`，MCP service 版本为 `webgpt-v4.1.0`。系统已经包含 Workbench V2、WebGPT V4、MCP App、真实 Provider 生成边界、审片、重生成、合成、交付、Memory 与媒体分析能力。它适合单人本地生产和受控验证，但尚不是成熟的无人值守生产服务或可直接公网部署的平台。

## 当前边界

- Workbench 是唯一允许确认费用、提交真实 Provider、采纳审片结果和交付资产的人类执行面。
- WebGPT V4 默认以 `readonly` profile 运行，只注册六个 `projects.read` 工具；现有有限写入和媒体能力只在显式 `full` profile 中注册。
- WebGPT 的大型读取默认返回 `compact` DTO，结构化结果上限为 128 KiB；超限会明确返回 `RESPONSE_BUDGET_EXCEEDED`，不会静默裁断业务对象。
- WebGPT V4 不得上传媒体、确认费用、提交 Provider、采纳审片、合成、交付或删除资产。
- 未配置 OAuth 时 MCP 必须 fail closed；本项目不提供匿名 MCP 模式。
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
npm run db:backup
npm run db:check
npm run db:migrate
npm run preflight
npm test
npm run test:v2
npm run test:v2:ui
npm run test:webgpt:v4
npm run test:webgpt:eval
npm run eval:webgpt:replay -- --input <sanitized-result.json>
npm run test:h1
npm run test:db
npm run test:v2:browser
npm run secret:scan
```

`start:local` 以前台方式启动本地 Workbench。`windows:start`、`windows:status`、`windows:stop` 提供普通用户权限的 Windows 受管启停入口，但不会创建 Task Scheduler 或配置自动启动。`start:webgpt` 默认只启动 Readonly MCP；只有显式设置 `WEBGPT_V4_PROFILE=full` 才会同时启动媒体网关和现有有限写入工具。`preflight` 默认检查本地 Workbench profile；WebGPT 使用 `npm run preflight -- --profile=webgpt` 并按 Readonly/Full 检查对应端口和依赖，OAuth 缺失时会明确失败并保持 fail closed。

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

本版本冻结 WebGPT V5、Workbench V3 和新 Provider。GPT 服务面已完成默认 Readonly、严格 DTO、Compact context、离线 eval、Widget v2 metadata 和低披露 Telemetry 收敛；Auth0、Secure MCP Tunnel、外部 HTTPS、媒体外部开放、Windows 自动启动与真实 Provider canary 仍是后续独立 gate。

详见 [当前状态](CURRENT_STATE.md)、[Stabilization Remediation](docs/STABILIZATION_REMEDIATION.md)、[GPT Service Capability Hardening](docs/GPT_SERVICE_CAPABILITY_HARDENING.md)、[架构](docs/ARCHITECTURE.md) 和 [Stabilization Release v2 taskbook](docs/STABILIZATION_RELEASE_V2.md)。
