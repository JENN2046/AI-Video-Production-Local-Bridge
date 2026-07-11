# AI Video Production Workspace｜三路线总计划书 v1.1

## 1. 锚定实现目标

建设一个可控、可追踪、可复用的 AI 视频生产工作台：

```text
Idea
  ↓
Creative Brief
  ↓
Script
  ↓
Shot List
  ↓
Keyframe Prompts
  ↓
Web GPT Images
  ↓
Human Review
  ↓
Media Artifact Handoff
  ↓
Frozen Storyboard Package
  ↓
App Video Generation
  ↓
Review / Regeneration
  ↓
Final Assembly / Export
  ↓
Memory / Asset Saveback
```

一句话定义：

> 让 Jenn 从一个视频想法开始，通过网页 GPT 完成创意、脚本、分镜和关键帧，再由本地 App 安全接管素材、调用视频 provider、生成视频、审片、重生成、合成、归档和记忆沉淀。

---

## 2. 三条路线的总分工

| 路线 | 名称 | 主要使用者 | 核心职责 | 当前优先级 |
|---|---|---|---|---|
| R3 | 本地 App | 系统 / Codex / 工作台 | 事实源、对象管理、artifact、package、run、provider、report | 最高基础 |
| R2 | 人类工作台 | Jenn / 人类操作者 | 审批、导入、冻结、授权、审片、回滚、查看报告 | 最高产品 |
| R1 | 网页 GPT 侧 MCP 服务 | Web GPT / GPT Director | 读取状态、提交草案、请求动作、辅助审片 | 中后期 |

三条路线的权力关系：

```text
Web GPT / MCP
  ↓ 读取状态、提交草案、请求动作
Human Workbench
  ↓ 人类审批、选择、硬门确认
Local App
  ↓ 真实写入、校验、生成、报告、归档
Provider
  ↓ 仅在明确授权后真实调用
```

---

## 3. 总原则

### 3.1 本地 App 是事实源

所有真实状态必须来自本地 App：

```yaml
truth_source:
  - project_id
  - shot_id
  - artifact_id
  - storyboard_package_id
  - generation_run_id
  - report_path
  - provider_call_result
```

网页 GPT 可以提出草案，但不能编造这些 ID。

### 3.2 人类工作台是硬门入口

需要人类确认的动作：

```yaml
human_gate_required:
  - approve shot
  - register selected image as storyboard_image
  - freeze Storyboard Package
  - execute real provider submit
  - regenerate shot video
  - final assembly
  - mark final delivery approved
  - confirm memory saveback
```

### 3.3 MCP 是受控连接层，不是自动驾驶层

MCP 初期只允许：

```yaml
allowed_initial_mcp:
  - read real app status
  - submit drafts
  - propose actions
  - request validation
```

禁止：

```yaml
forbidden_mcp:
  - direct Runway call
  - direct RunningHub call
  - shell execution
  - secret read
  - source overwrite
  - delete artifact
  - freeze package without human confirmation
```

### 3.4 所有生成输入必须从 frozen package 读取

真实 provider 不能直接读：

```text
Web GPT 原始图
聊天记录图片
临时 download 文件
zip 内部文件
data/imports 原始路径
```

只能读：

```text
app-side active Media Artifact
frozen Storyboard Package
```

---

## 4. 总阶段计划

## Phase 0｜共同契约冻结

目标：冻结对象、API、报告、硬门、三路线权责。

产物：

```yaml
outputs:
  - Local App state contract
  - Human Workbench page/action contract
  - MCP tool boundary
  - Report schema
  - Hard gate matrix
```

验收：三条路线没有权责冲突。

---

## Phase 1｜本地 App handoff 内核补齐

目标：完成 `data/imports → Media Artifact → Storyboard Package` 的稳定链路。

产物：

```yaml
outputs:
  - register_media_artifact hardening
  - image validation
  - artifact reports
  - validateG0StoryboardPackage
  - importG0AppReadyStoryboardPackage
  - frozen package reports
```

验收：4 张 Web GPT keyframe 可以安全入库并冻结成 app-ready package。

---

## Phase 2｜人类工作台 H1

目标：Jenn 可以用 UI 完成导入、shot 审查、package 校验和冻结。

页面：

```yaml
pages:
  - Dashboard
  - Imports
  - Shots
  - Storyboard Package
  - Reports
```

验收：不靠命令行，也能完成一次 G0 WebGPT package → frozen package。

---

## Phase 3｜Strict Runway Canary

目标：补严格单次 canary，不使用会自动 regeneration proof 的 `demo:m1:real`。

验收：授权后最多 1 次 Runway submit，下载输出，ffprobe PASS，注册 generated_clip artifact。

---

## Phase 4｜网页 GPT MCP v0

目标：Web GPT 可以读取真实 app 状态，不再猜 artifact/package/run 状态。

验收：只读工具可用，无 mutation，无 provider call。

---

## Phase 5｜package-based 单镜头生成

目标：从 frozen package 创建 Generation Run，生成单镜头视频。

验收：每次生成有 run，每个输出有 artifact，旧版本不覆盖。

---

## Phase 6｜人类视频审片工作台

目标：Jenn 可以审片、通过、拒绝、写 rejection reason、请求重生成。

验收：review 决策写回 app，regeneration 不自动执行。

---

## Phase 7｜网页 GPT MCP v1

目标：GPT 可以提交草案和 action request，由人类工作台确认后执行。

验收：GPT 不能绕过人类 gate。

---

## Phase 8｜最终合成 / 导出

目标：全部 accepted clip 合成 final video artifact。

验收：final video ffprobe PASS，source clip 不覆盖。

---

## Phase 9｜Memory / Asset / Reference 沉淀

目标：项目结束后生成 Memory Saveback Proposal，由 Jenn 确认后写入长期记忆。

验收：没有未经确认的自动记忆写入。

---

## Phase 10｜ChatGPT MCP App 完整形态

目标：把 MCP 工具、资源、状态面板逐步做成 ChatGPT 内的工作流入口。

验收：GPT 可以辅助但不能越权。

---

## 5. 总体验收标准

```yaml
system_acceptance:
  creative:
    - Web GPT produces clean per-shot 9:16 keyframes
    - Web GPT does not claim app-side IDs

  local_app:
    - every file used in generation is Media Artifact
    - every video generation has Generation Run
    - every output is Media Artifact
    - frozen package exists before provider use

  human_workbench:
    - human can inspect/import/approve/freeze
    - hard gates visible and enforced
    - reports visible and traceable

  mcp:
    - GPT can read real status
    - GPT can submit drafts
    - GPT cannot bypass human gates

  provider:
    - real calls require explicit authorization
    - no regeneration/batch unless separately authorized
    - ffprobe validation required

  memory:
    - saveback proposal exists
    - human confirmation required before long-term memory write
```
