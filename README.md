# AI Video Production Workspace

AI Video Production Workspace 是 Jenn 的 Windows 本地 AI 视频生产与
ChatGPT 只读工作台。SQLite 与受治理媒体目录保存业务事实；Local
Workbench 是唯一的人类生产执行面，ChatGPT/Director 只提供有界读取与
建议，不是第二事实源。

当前 Human Workbench 候选实现了：

```text
分镜 → 生成 → 人工核对 → 审片/重生成 → FFmpeg 装配
     → 终审/定向返工 → 本地导出 → 明确结案
```

## 当前状态

| 项目 | 当前值 |
|---|---|
| Package | `0.1.0-beta.5` |
| MCP service | `webgpt-v4.3.0` |
| Candidate database | `workbench-v2-7` / ledger `0012` |
| Accepted activity database | `workbench-v2-6` / ledger `0011`；未被本候选读取、复制或迁移 |
| Human Workbench code | `CODE_COMPLETE`（仅代码与合成夹具） |
| Product completion | `PARTIAL`；活动库迁移、S4、一次真实闭环和 S7 三项目仍未完成 |
| Historical single-owner MCP App | `JENN_SINGLE_USER_MCP_APP_PASS`；只保留其命名验收边界 |
| Historical manual publish boundary | `MANUAL_PUBLISH_OPERATIONAL_READY`；不授权本候选发布 Snapshot |
| Remote Readonly App | 已有历史单 Owner 有界验收；不继承本候选的实时状态 |
| Media Gateway | 隔离 MP4 fixture 播放有历史证据；byte-range 与广泛外部门禁仍独立 |
| Multi-user | `PARTIAL_MULTI_USER_GATE`，冻结扩张 |

Human Workbench 补完代码位于独立 stacked Draft PR 系列 #121–#126 及其
后续验收分支，不在当前 `main`。这些 PR 必须按顺序 review；没有直接推送或
合并 `main` 的授权。

详细事实见 [Current State](CURRENT_STATE.md)，夹具证据见
[2026-08-13 Human Workbench code-complete fixture acceptance](ops/reports/2026-08-13-workbench-code-complete-fixture-acceptance.md)。

## Human Workbench 候选能力

- Seedance V1.5 Pro 模型选择、画幅映射、价格预检和 Provider 合同保持在
  显式费用/提交门禁后。
- Generation 展示脱敏人工核对项；已有或人工输入的 Provider task ID 只能
  恢复 polling/download，放弃必须填写原因并二次确认，恢复绝不重新 submit。
- Review 保留所有 Clip 版本，并在 1920、1166、820、390×844 四档视口
  保持版本栈和操作按钮可见可点。
- migration `0012` 持久化 delivery state、assembly/export jobs、不可变
  events 和 exports；历史 `final_approved` 只回填为
  `legacy_review_required`。
- 装配使用受治理 staging 和唯一输出名调用 FFmpeg：H.264/CRF 18/
  30fps/yuv420p、AAC 192kbps/48kHz/双声道，无音轨补静音，保持比例补边，
  `+faststart`，30 分钟硬超时且不自动重试。
- 终审支持接受、仅重装和选择 SHOT 定向重生成；旧 Clip 与最终版本均保留。
- 导出写入 `data/exports/<project_id>/`，以 `.part`、SHA/FFprobe 和独占
  rename 防止覆盖；结案必须另行输入 `确认结案`。
- 桌面保留六个主入口；移动端为“指挥台、项目、收件箱、Director、更多”。
  Tabs、ProjectPicker、Modal、More sheet 与确认对话框具有键盘/焦点模型，
  活跃页面纳入 axe 回归。

## 数据库兼容性与迁移边界

候选代码要求 `workbench-v2-7` / `0012`。运行时不会自动迁移或回退。
当前活动库仍是 `workbench-v2-6` / `0011`，因此不能把候选分支指向活动库
启动验收。

现有自动化只完成了合成 `0011` 文件副本的迁移、只读检查、业务清单比较、
`0012` 恢复和 `0011` 回滚演练。活动库属于 private state：读取/复制演练和
正式迁移必须分别取得当次精确授权。完整边界见
[Workbench Delivery Recovery](docs/WORKBENCH_DELIVERY_RECOVERY.md)。

## 三个入口

### 1. Local Workbench

当前 [http://127.0.0.1:4181](http://127.0.0.1:4181) 是隔离合成夹具预览，
用于界面与浏览器验收；它不是活动库、付费 Provider 或真实交付证据。

活动库升级并通过验收前，不要使用候选代码执行日常生产启动。升级后仍应先
从已核对的 Git 根运行只读检查，再使用受管 Windows runtime；具体步骤见
[User Guide](docs/USER_GUIDE.md)。

### 2. ChatGPT Readonly MCP App

Remote App 只读取签名 Snapshot，不直接读取当前 SQLite。Snapshot 发布、恢复
或更新都是独立的外部操作；Human Workbench 迁移不会自动发布 Snapshot。
旧 `/mcp` 仅为回滚面，不作为交付补完路线。

### 3. Local Media Gateway

```powershell
npm run media:preflight
npm run media:start
npm run media:status
npm run media:stop
```

Gateway 只监听 `127.0.0.1:2092`。Legacy Full WebGPT 也占用 2092，二者
不能同时运行。Gateway 是可选的人类播放面，不阻塞本地生成、装配或导出。

## 安全边界

- Workbench 是费用确认、Provider 提交、任务核对、Clip 采纳、终审、导出和
  结案的唯一权威面。
- 归档、结案、状态漂移、Artifact/Blob 漂移和并发 Job 一律 fail closed。
- 浏览器只获得相对导出路径和本地文件路由，不调用 Shell、不暴露绝对路径。
- `.env`、token、cookie、身份值、Provider payload、原始日志、活动数据库
  业务行和本地媒体不得提交或打印。
- Provider、活动库、Snapshot、Memory、Auth0、Cloudflare、Render、DNS、
  Windows Scheduled Task、release/deploy 都有独立授权边界。
- 本候选不删除 Legacy、不扩展多用户、自动路由、自动发布或非核心格式。

## 环境

- Windows 10/11
- Node.js 22（最低 `>=22.13.0`）
- npm 11 或兼容版本
- FFmpeg/FFprobe 8.1.2
- SQLite：Node.js 内置 `node:sqlite`

环境变量结构见 [.env.example](.env.example)。它只描述键名，不能存放真实值。

## 验证

完整门禁：

```powershell
npm test
```

主要独立 lanes：

```powershell
npm run typecheck
npm run build
npm run test:selection-gate
npm run test:foundation-boundaries
npm run test:provider-boundaries
npm run test:db
npm run test:v2
npm run test:v2:ui
npm run test:v2:browser
npm run test:windows-runtime
npm run secret:scan
```

Windows CI 必须同时通过 `Quality and integration` 与 `Browser smoke`。
测试文件存在不等于被执行；selection gate 同时核对 suite catalog、本地 lane
和 CI 路由。

## 文档

- [Current State](CURRENT_STATE.md)
- [User Guide](docs/USER_GUIDE.md)
- [Workbench Delivery Recovery](docs/WORKBENCH_DELIVERY_RECOVERY.md)
- [Product Scope Freeze](docs/PRODUCT_SCOPE_FREEZE.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Documentation Index](docs/README.md)

历史 taskbook 和验收报告只证明其命名 commit/输入/授权边界，不能覆盖当前
状态。仓库不会因文档或测试通过而自动发布、部署、迁移或调用 Provider。
