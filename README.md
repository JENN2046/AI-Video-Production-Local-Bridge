# AI Video Production Workspace

AI Video Production Workspace 是 Jenn 的 Windows 本地 AI 视频生产与 ChatGPT 只读工作台。系统把项目、SHOT、Storyboard、Generation、Review、Delivery 和 Closeout 保存在本地 SQLite 与受治理媒体目录中；ChatGPT 只读取签名、限时的投影，不是第二事实源。

## 当前接受基线

| 项目 | 当前值 |
|---|---|
| Package | `0.1.0-beta.5` |
| MCP service | `webgpt-v4.3.0` |
| Remote App service | `readonly-remote-v1.0.0` |
| Media Gateway code | `readonly-media-gateway-v1.0.0`（外部验收未完成） |
| Snapshot contract | `readonly-snapshot-v4`（代码已合入，不能据此宣称公网媒体已可用） |
| Database | `workbench-v2-5` / ledger `0008` |
| Product status | `JENN_SINGLE_USER_MCP_APP_PASS` |
| Operations status | `MANUAL_PUBLISH_OPERATIONAL_READY` |
| Multi-user status | `PARTIAL_MULTI_USER_GATE` |

当前 `main` 已包含 Workbench V2、WebGPT V4、Auth0 Federated Readonly、签名 Snapshot、ChatGPT MCP App、共享派生状态、Human Workbench 人工发布，以及 Local Media Gateway 的代码和 Windows 运维入口。Cloudflare 媒体链路尚未完成端到端播放验收；Windows 登录任务、自动 Snapshot 发布、真实 Provider canary 和多用户黄金路径仍是独立 gate。

完整状态见 [CURRENT_STATE.md](CURRENT_STATE.md)，文档入口见 [docs/README.md](docs/README.md)。

## 三个日常入口

### 1. 本地 Workbench

```powershell
npm ci
npm run db:check -- --read-only
npm run windows:start
npm run windows:status
```

打开 `http://127.0.0.1:4181`。结束时：

```powershell
npm run windows:stop
```

这些命令必须在“拥有已验收 `data/app.sqlite` 的 Git 工作区根目录”运行；不要根据相似目录名猜测，也不要在空克隆中启动。先用 `git rev-parse --show-toplevel` 和 `Test-Path .\data\app.sqlite` 核对。`windows:*` 不安装自动启动，不启用真实 Provider，并拒绝接管未知 PID 或端口监听。

### 2. ChatGPT Readonly MCP App

日常查看不需要启动本地 MCP。远端 App 只读取内存中的签名 Snapshot。Snapshot 缺失、过期或 Render 重启后，在 Workbench 的 `系统 → 只读 App 发布` 中执行一次人工预检和确认发布。

CLI 等价入口：

```powershell
npm run preflight:webgpt:publisher -- --profile data/webgpt/publisher/profile.json
npm run publish:webgpt:snapshot -- --profile data/webgpt/publisher/profile.json
```

发布会替换远端只读内存 Snapshot；不会写活动数据库。详细步骤见 [使用说明](docs/USER_GUIDE.md) 和 [Readonly MCP App Delivery Runbook](docs/webgpt/READONLY_MCP_APP_DELIVERY_RUNBOOK.md)。

### 3. Local Media Gateway（候选，尚未验收完成）

```powershell
npm run media:preflight
npm run media:start
npm run media:status
npm run media:stop
```

Gateway 只监听 `127.0.0.1:2092`；媒体字节留在本机。Cloudflare named tunnel、DNS、共享 capability key 和 DPAPI token 已进入有界外部接线，但公网 route/edge 连接与真实 MP4 播放尚未形成 PASS。不要安装登录任务，也不要把媒体状态描述为 production-ready。详见 [Local Media Gateway Runbook](docs/webgpt/READONLY_LOCAL_MEDIA_GATEWAY_RUNBOOK.md)。

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
- Node.js 22（最低 `>=22.5.0`；接受环境为 `22.23.1`）
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
- [当前状态](CURRENT_STATE.md)
- [架构](docs/ARCHITECTURE.md)
- [项目建设经验](docs/PROJECT_LESSONS.md)
- [完整文档导航](docs/README.md)

历史 taskbook 与验收报告保留为证据，但不应覆盖当前运行手册。仓库不创建 tag、不发布 npm package，也不因文档更新自动部署任何服务。
