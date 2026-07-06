# R3｜本地 App 路线任务规划

## 0. 路线定位

本地 App 是系统事实源与执行内核。

它负责：

```yaml
local_app_owns:
  - Project
  - Shot
  - Media Artifact
  - Storyboard Package
  - Generation Run
  - Asset
  - Reference
  - Memory Item
  - Memory Recall Pack
  - Memory Saveback Proposal
  - Provider Runner
  - Reports
```

它不负责开放式创意生成。开放式创意属于网页 GPT。

---

## R3-0｜Local App Contract Freeze

### 阶段目标

冻结本地 App 对外暴露的对象、状态、报告、API 和硬门。

### 计划书

```yaml
phase: R3-0
name: Local App Contract Freeze
mode: read_only_or_contract_only
provider_calls: forbidden
purpose:
  - identify current app-side tools
  - freeze API categories
  - freeze report schema
  - define Workbench dependencies
  - define MCP dependencies
```

### 执行任务书

```markdown
# R3-0｜Local App Contract Freeze

工作区：`A:\AI Video Production Workspace`

## 任务目标
只读审查当前本地 App，冻结 app-side state / API / report contract。

## 必须输出
1. App-side object inventory
2. Existing tools / scripts inventory
3. Read API draft
4. Mutation API draft
5. Report schema draft
6. Latest pointer strategy
7. Human Workbench dependency map
8. WebGPT MCP dependency map
9. Hard gate matrix

## 禁止
- 修改代码
- 调用 Runway / RunningHub
- 生成视频
- 读取或打印 secret 值
- push / tag / release / deploy
```

### 验收标准

```yaml
acceptance:
  - all truth objects listed
  - all mutation actions identified
  - reports schema defined
  - latest pointer strategy defined
  - provider boundary documented
  - no network call
  - no secret exposure
```

---

## R3-1｜Media Artifact Import Core

### 阶段目标

稳定实现：

```text
data/imports → register_media_artifact → data/media/artifacts/images → real artifact_id
```

### 计划书

```yaml
phase: R3-1
name: Media Artifact Import Core
purpose:
  - approved WebGPT image import
  - image validation
  - artifact creation
  - unsafe file rejection
  - import report
```

### 执行任务书

```markdown
# R3-1｜Media Artifact Import Core

## 输入
`data/imports`

## 输出
`data/media/artifacts/images`

## 必须实现
1. 扫描导入目录
2. 校验 PNG / JPEG 可读
3. 记录 width / height / aspect_ratio / size_bytes / checksum
4. 阻断 path traversal
5. 阻断 symlink escape
6. 复制到 app-controlled media storage
7. 创建真实 artifact_id
8. 记录 artifact_type=image
9. 记录 role=storyboard_image
10. 记录 status=active
11. 写 immutable import report

## 必须拒绝
- audit 图片
- references 四宫格参考图
- docs
- zip
- PENDING_* IDs
- 假 artifact_id
- 非图片
- 不可读图片
```

### 验收标准

```yaml
positive_acceptance:
  - approved SHOT image becomes active Media Artifact
  - real artifact_id returned
  - checksum and metadata recorded
  - source file not overwritten

negative_acceptance:
  - audit image rejected
  - product reference rejected as storyboard_image
  - PENDING_* rejected
  - path traversal rejected

boundary:
  network_call_attempted: false
  provider_called: false
  secret_values_exposed: false
```

---

## R3-2｜Storyboard Package Freeze Core

### 阶段目标

把 WebGPT 脚本和真实 artifact_id 组装成 app-ready frozen Storyboard Package。

### 执行任务书

```markdown
# R3-2｜Storyboard Package Freeze Core

## 任务目标
实现或加固 Storyboard Package validate / import / freeze。

## 前置条件
- Project exists
- Shots exist
- Every required shot has active storyboard_image_artifact_id
- Every shot has description
- Every shot has video_prompt
- Every shot has duration_seconds
- negative_prompt exists or explicit empty string

## 必须实现
1. validateG0StoryboardPackage
2. importG0AppReadyStoryboardPackage
3. immutable frozen package
4. package freeze report
5. real storyboard_package_id returned

## 禁止
- PENDING_* IDs
- fake IDs
- raw data/imports path in provider chain
- modifying previous frozen package
```

### 验收标准

```yaml
acceptance:
  - complete 4-shot package validates PASS
  - incomplete package returns BLOCK_WITH_REASON
  - fake IDs rejected
  - package frozen immutably
  - previous package version not overwritten
```

---

## R3-3｜Strict Single Runway Canary

### 阶段目标

新增严格单次 canary，避免使用成功后继续做 regeneration proof 的 `demo:m1:real`。

### 执行任务书

```markdown
# R3-3｜Strict Single Runway Canary

## 任务目标
新增 `npm run runway:canary` 或 `npm run demo:m1:canary`。

## 第一阶段
只实现 dry-run / ready report，不真实调用 Runway。

## 第二阶段
Jenn 单独授权后，执行一次真实 Runway submit。

## 硬规则
provider: runway
max_submit_calls: 1
duration_seconds: 2
input_image: fixtures/provider-canary/m1-r0/shot_001_canary_720x1280.png
runway_ratio: 768:1280
allow_regeneration: false
allow_batch_generation: false
allow_runninghub: false
allow_publish: false
allow_deploy: false
allow_source_asset_overwrite: false
allow_secret_printing: false
```

### 验收标准

```yaml
dry_run:
  - canary plan report generated
  - selected input readable
  - usable_for_real_provider_canary=true
  - network_call_attempted=false

real_call_after_authorization:
  - exactly 1 submit attempted
  - output downloaded
  - video registered as generated_clip artifact
  - ffprobe PASS
  - secret not exposed
  - no regeneration
```

---

## R3-4｜Package-Based Shot Generation

### 阶段目标

从 frozen Storyboard Package 创建 per-shot Generation Run，并生成视频片段。

### 执行任务书

```markdown
# R3-4｜Package-Based Shot Generation

## 任务目标
实现 frozen package → Generation Run → generated_clip artifact。

## 必须实现
1. create_generation_run_from_package_shot
2. provider request body builder
3. ratio mapping: project 9:16 → Runway 768:1280
4. provider submit after hard gate
5. output download
6. generated_clip Media Artifact registration
7. ffprobe validation
8. generation report

## 禁止
- 直接读取 WebGPT 原图
- 直接读取 data/imports
- 覆盖旧 output
- 自动 regeneration
```

### 验收标准

```yaml
acceptance:
  - one approved shot can generate one video
  - Generation Run created
  - generated_clip artifact created
  - ffprobe PASS
  - old versions not overwritten
```

---

## R3-5｜Review / Regeneration / Final Assembly Core

### 阶段目标

实现审片、拒绝、重生成、通过版本选择和最终合成。

### 执行任务书

```markdown
# R3-5｜Review Regeneration Final Assembly Core

## 必须实现
1. mark_clip_approved
2. mark_clip_rejected
3. create_regeneration_run
4. no-overwrite clip versioning
5. accepted_clip_artifact_id 写回 Shot
6. final assembly after all required shots accepted
7. final_video artifact
8. final assembly report
```

### 验收标准

```yaml
acceptance:
  - rejected clip remains traceable
  - regeneration creates new Generation Run
  - approved clip becomes accepted_clip_artifact_id
  - final assembly blocked until all shots approved
  - final video ffprobe PASS
```

---

## R3-6｜Memory / Asset Saveback Core

### 阶段目标

项目结束后生成 Memory Saveback Proposal，由 Jenn 确认后写入长期记忆。

### 验收标准

```yaml
acceptance:
  - closeout creates Memory Saveback Proposal
  - no automatic memory write without human confirmation
  - approved items become Memory Item
  - asset/reference updates preserve provenance
  - rejected items not saved
```
