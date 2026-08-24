# AI Video Production Workspace

AI Video Production Workspace 是 Jenn 的 Windows 本地 AI 视频生产与 ChatGPT 只读工作台。系统把项目、SHOT、Storyboard、Generation、Review、Delivery 和 Closeout 保存在本地 SQLite 与受治理媒体目录中；ChatGPT 只读取签名、限时的投影，不是第二事实源。

## 当前接受基线

| 项目 | 当前值 |
|---|---|
| Package | `0.1.0-beta.5` |
| MCP service | `webgpt-v4.3.0` |
| Remote App service | `readonly-remote-v1.0.0` |
| Media Gateway code | `readonly-media-gateway-v1.0.0`（隔离 MP4 fixture 的公网播放已通过；byte-range 与广泛外部门禁仍未完成） |
| Snapshot contract | `readonly-snapshot-v4`（已支持上述有界 fixture 验收；不得据此宣称完整公网媒体可用） |
| Database | Canonical source: `workbench-v2-7` / ledger `0012`. The activity database's last explicitly accepted runtime boundary remains `workbench-v2-6` / ledger `0011`; current-main runtime acceptance is not established. Runtime startup still does not automatically migrate or roll back. |
| ChatGPT Director | Historical, commit-scoped evidence covers 单 Owner Focus → Context → advisory Proposal → Human Workbench 决定 → controlled import receipt；Provider、Grant 启动与 Memory 写入仍关闭。 |
| Unified ChatGPT Workspace | Historical, commit-scoped evidence covers the bounded `/workspace/mcp` OAuth、Bridge、Render 与活动库黄金路径；旧 `/mcp` 仍保留为回滚面。 |
| Product status | Historical, commit-scoped `JENN_SINGLE_USER_MCP_APP_PASS`; not current-main runtime or full-product acceptance |
| Operations status | Historical `MANUAL_PUBLISH_OPERATIONAL_READY` evidence is commit-scoped to an earlier schema. Current-main publish/recovery is `BLOCKED_PENDING_0012_ADMISSION_AND_RUNTIME_ACCEPTANCE`. |
| Multi-user status | `PARTIAL_MULTI_USER_GATE` |

当前 `main` 已包含 Workbench V2、WebGPT V4、Auth0 Federated Readonly、签名 Snapshot、ChatGPT MCP App、共享派生状态、Human Workbench 人工发布、已接线的 Unified Workspace Remote，以及 Local Media Gateway 的代码和 Windows 运维入口。Unified Workspace 保留旧 `/mcp` 为回滚面。Cloudflare 媒体链路已通过一次隔离 MP4 fixture 的端到端 Widget 播放；实际 byte-range 响应、Windows 登录任务、自动 Snapshot 发布、剩余媒体恢复/撤权案例、真实 Provider canary、稳定 Memory 插件和多用户黄金路径仍是独立 gate。

`ChatGPT Director` 保留单 Owner 活动库受控验收的历史、commit-scoped 证据：ChatGPT Connector 只能读取有界讨论上下文并提出不可变 Proposal，Workbench 保留人类批准与一次性 receipt 记录。Local Orchestrator 只在未来获授权的 Grant 内执行；`REAL_PROVIDER_ENABLED=false`、Memory 插件未接线，且不得把该历史验收扩大为 current-main runtime、自动生成、自动采纳、自动交付或自动 Memory 写入。

## 当前 source / activity runtime 边界

当前 canonical source 的 Workbench 与新 Snapshot export path 要求 `workbench-v2-7` / ledger `0012`。活动库最后明确接受的 runtime boundary 仍是 `workbench-v2-6` / ledger `0011`，其 `0010`→`0011` 备份、隔离迁移、只读 `db:check`、恢复演练、逻辑 manifest 比较与 Director 黄金路径证据继续作为历史验收保留。该证据不自动转移到 current main；current-main activity runtime acceptance 尚未建立。运行时不会自动迁移、回退或发布 Snapshot，针对活动库的 `0012` admission/migration 与 runtime acceptance 需要单独授权。

更广泛的历史状态见 [CURRENT_STATE.md](CURRENT_STATE.md)，文档入口见 [docs/README.md](docs/README.md)。`CURRENT_STATE.md` 尚待单独全量 reconciliation，不得覆盖本节冻结的 Foundation source/runtime boundary。

## 三个日常入口

### 1. 本地 Workbench（历史 `0011` path accepted；current-main pending）

活动库的 `0011` 有界 Unified activity path 已验证本地启动、Focus/Proposal、人工决定与受控 receipt；该结果是历史 runtime 验收基线，不是 current-main `0012` runtime acceptance。不要把拉取 current main 解释为现有活动库已可直接使用；在单独完成 `0012` activity-database admission/migration 与 runtime acceptance 前，不应以已接受组合启动。仓库不会自动迁移、回退、发布 Snapshot 或启动 Provider。

### 2. ChatGPT Readonly MCP App

日常查看不需要启动本地 MCP。远端 App 只读取内存中的签名 Snapshot；已接受的 Snapshot/恢复证据仍可作为历史证据阅读。活动库迁移不自动发布或更新远端内存 Snapshot；下一次 publish/recovery 需要自己的有界验收。详细边界见 [使用说明](docs/USER_GUIDE.md) 和 [Readonly MCP App Delivery Runbook](docs/webgpt/READONLY_MCP_APP_DELIVERY_RUNBOOK.md)。

### 3. Local Media Gateway（候选；隔离 MP4 fixture 播放已通过）

```powershell
npm run media:preflight
npm run media:start
npm run media:status
npm run media:stop
```

Gateway 只监听 `127.0.0.1:2092`；媒体字节留在本机。Cloudflare named tunnel、DNS、共享 capability key 和 DPAPI token 已完成有界外部接线；隔离 MP4 fixture 已通过公网 route/edge 与 ChatGPT Widget 播放。一次 forward seek 可用，但未记录实际 `206`/`Content-Range`，因此 byte-range 仍待验收。它不是完整 production-ready 声明：撤权、项目切换、离线恢复、格式覆盖、Windows 登录任务、soak，以及该 fixture/restore 路径的活动库前后 logical-manifest 比较仍未验收。详见 [Local Media Gateway Runbook](docs/webgpt/READONLY_LOCAL_MEDIA_GATEWAY_RUNBOOK.md) 与 [MP4 Fixture Acceptance](ops/reports/2026-07-27-readonly-media-gateway-mp4-fixture-acceptance.md)。

Legacy `WEBGPT_V4_PROFILE=full` 也占用 2092；它与 Readonly Media Gateway 互斥。启动 Gateway 前必须确认 Full profile 已停止。

## 安全边界

- Workbench 是确认费用、提交 Provider、采纳审片和交付资产的唯一人类执行面。
- Readonly MCP App 只暴露 `projects.read`；匿名 MCP、写工具、Provider 调用和媒体目录浏览均禁止。
- 本地数据库是唯一事实源；Remote Runtime 没有数据库或持久盘，只保留一个签名 Snapshot。
- `.env`、token、cookie、subject、DPAPI 明文、Provider payload、活动数据库和本地媒体不得提交或打印。
- 数据库启动时不自动迁移。对活动库执行 `db:migrate` 必须先停止服务、备份、记录 manifest，并取得当次明确授权。
- Render、Auth0、ChatGPT、Cloudflare、DNS、Windows Scheduled Task、真实 Provider 和 release/deploy 都是外部变更，需要独立授权。

## 环境

- Windows 10/11
- Node.js 22（最低 `>=22.13.0`；接受环境为 `22.23.1`）
- npm 11 或兼容版本
- FFmpeg/FFprobe 8.1.2
- SQLite：Node.js 内置 `node:sqlite`

环境变量目录见 [.env.example](.env.example)。它是结构说明，不会被仓库自动加载，也不能存放真实值。

## 验证

```powershell
npm run typecheck
npm run build
npm run test:selection-gate
npm run test:db
npm run test:webgpt:v4
npm run test:webgpt:cloud
npm run test:webgpt:app
npm run test:webgpt:director
npm run test:webgpt:workspace
npm run test:webgpt:media-gateway
npm run test:v2:browser
npm run secret:scan
```

完整门禁：

```powershell
npm test
```

Windows CI 必须同时通过 `Quality and integration` 与 `Browser smoke`。测试文件存在不代表被执行；`test-selection-gate` 同时验证 suite catalog、npm lane 和 Windows CI 选择。

## 文档

- [使用说明](docs/USER_GUIDE.md)
- [部署与外部接线说明](docs/DEPLOYMENT_GUIDE.md)
- [Unified Workspace Transport Runbook](docs/webgpt/UNIFIED_CHATGPT_WORKSPACE_TRANSPORT_RUNBOOK.md)
- [当前状态](CURRENT_STATE.md)
- [架构](docs/ARCHITECTURE.md)
- [项目建设经验](docs/PROJECT_LESSONS.md)
- [完整文档导航](docs/README.md)

历史 taskbook 与验收报告保留为证据，但不应覆盖当前运行手册。仓库不创建 tag、不发布 npm package，也不因文档更新自动部署任何服务。
