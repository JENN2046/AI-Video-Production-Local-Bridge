# AI Video Production Workspace Beta

AI Video Production Workspace 是面向 Jenn 本地 Windows 生产环境的、治理优先的 AI 视频生产系统 Beta。

当前版本为 `0.1.0-beta.1`。系统已经包含 Workbench V2、WebGPT V4、MCP App、真实 Provider 生成边界、审片、重生成、合成、交付、Memory 与媒体分析能力。它适合单人本地生产和受控验证，但尚不是成熟的无人值守生产服务或可直接公网部署的平台。

## 当前边界

- Workbench 是唯一允许确认费用、提交真实 Provider、采纳审片结果和交付资产的人类执行面。
- WebGPT V4 可以读取生产上下文、修改有限文案、添加非决策性注记、提交提议和准备未确认的生成 intent。
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
npm run h1:workbench
npm run webgpt:v4:serve
npm run test:v2
npm run test:v2:ui
npm run test:webgpt:v4
npm run test:h1
npm run test:v2:browser
npm run secret:scan
```

`h1:workbench` 和 `webgpt:v4:serve` 是当前真实入口。稳定化版本后续 PR 才会加入 `start:*`、`db:*`、`preflight` 和统一 `test`；在实现落地前，这些名称不是可执行接口。

## 本地启动

先构建，再启动 Workbench：

```powershell
npm run build
npm run h1:workbench
```

Workbench 默认监听 `http://127.0.0.1:4181`。WebGPT V4 是独立服务：

```powershell
npm run webgpt:v4:serve
```

默认 MCP 与媒体端口为 `2091` 和 `2092`，只绑定 `127.0.0.1`。未配置 OAuth 时健康检查可以通过，但 `/readyz` 和 MCP 调用保持关闭。

## 数据边界

- `data/app.sqlite*`：本地运行数据库，不进入 Git。
- `data/media/`、`data/imports/`：本地媒体与导入，不进入 Git。
- `data/reports/`：经筛选的项目证据，可按仓库规则进入 Git。
- `.env`、凭据、Provider payload、私有日志和本地状态：不得提交、打印或复制。

任何真实数据库迁移、批量历史文件移动、Provider 付费调用、发布或部署，都必须通过适用的授权边界。

## 稳定化路线

本版本冻结 WebGPT V5、Workbench V3 和新 Provider。当前建设顺序是：CI 基线、主路径模块化、版本化 migration、持久化生成 worker、媒体资源调度和 readiness。

详见 [当前状态](CURRENT_STATE.md)、[架构](docs/ARCHITECTURE.md) 和 [Stabilization Release v2 taskbook](docs/STABILIZATION_RELEASE_V2.md)。

