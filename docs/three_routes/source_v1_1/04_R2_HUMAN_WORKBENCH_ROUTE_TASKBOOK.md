# R2｜人类工作台路线任务规划

## 0. 路线定位

Human Operator Workbench 是 Jenn / 人类操作者的本地生产控制台。

它不是 GPT 自动工具，不是 provider runner，不是视频编辑器。它的核心作用是：

```yaml
human_workbench_owns:
  - project state overview
  - import readiness review
  - shot approval decision
  - package freeze decision
  - provider guard decision
  - report inspection
  - video review decision
  - final assembly decision
  - memory saveback confirmation
```

---

## R2-0｜Human Workbench UX / State Plan

### 阶段目标

冻结页面、状态源、按钮权限和硬门。

### 执行任务书

```markdown
# R2-0｜Human Workbench UX / State Plan

## 任务目标
规划 Human Workbench MVP 页面与 app-side API 依赖。

## 必须输出
1. 页面列表
2. 每页读取哪些状态
3. 每页允许哪些 action
4. 哪些 action 需要硬门
5. mutation report schema
6. local server security rules
7. no-provider boundary
```

### 验收标准

```yaml
acceptance:
  - H1 pages frozen
  - provider calls excluded from H1
  - app-side state is only truth source
  - fake IDs blocked
  - local server security documented
```

---

## R2-1｜H1 Handoff Workbench MVP

### 阶段目标

实现最小人类工作台：导入、shot 管理、package 冻结、报告查看。

### 页面范围

```yaml
pages:
  - Dashboard
  - Imports
  - Shots
  - Storyboard Package
  - Reports
```

H1 不做：

```yaml
excluded:
  - Provider Guard 操作页
  - Video Review
  - Final Assembly
  - Memory Saveback
  - Assets
  - References
  - real provider call
```

### 执行任务书

```markdown
# R2-1｜H1 Handoff Workbench MVP

工作区：`A:\AI Video Production Workspace`

## 任务目标
实现本地 Human Workbench v0.1。

## Dashboard
显示：
- project readiness
- import readiness
- shot completeness
- package readiness
- latest blockers
- provider readiness summary as read-only only

## Imports
功能：
- 扫描 data/imports
- 预览图片
- 校验图片
- 注册 storyboard_image artifact
- 阻断 audit/reference/docs/zip

## Shots
功能：
- 编辑 description / video_prompt / negative_prompt / duration
- 关联 active artifact_id
- approve / revision_needed
- 显示 missing fields

## Storyboard Package
功能：
- run validateG0StoryboardPackage
- freeze app-ready package
- open frozen package report

## Reports
功能：
- latest pointer
- immutable report history
- open report
- show boundary evidence

## 禁止
- Runway / RunningHub real call
- video generation
- regeneration
- editing .env.local
- printing secrets
- source overwrite
- accepting fake IDs
```

### 验收标准

```yaml
acceptance:
  - Dashboard shows current blockers
  - Imports can register approved SHOT image
  - audit/reference images are rejected
  - Shots can link active artifact
  - package freeze blocked until all shots complete
  - freeze returns real package_id
  - Reports can open latest and historical reports
  - no provider call
  - no secret exposure
```

---

## R2-2｜H2 Canary Workbench

### 阶段目标

新增 Provider Guard / Canary 页面，支持人类判断是否授权单次 canary。

### 执行任务书

```markdown
# R2-2｜H2 Canary Workbench

## 页面功能
- 显示 active provider
- 显示 env check / preflight
- 显示 selected canary input
- 显示 input dimensions / ratio
- 显示 Runway ratio
- 显示 duration
- 显示 max_submit_calls=1
- 显示 no regeneration / no batch
- 生成 canary dry-run plan
- 展示真实调用授权说明

## 禁止
- 无单独授权时真实调用 provider
- 展示 secret 值
```

### 验收标准

```yaml
acceptance:
  - canary readiness visible
  - secret values never shown
  - dry-run reports visible
  - real submit requires separate Jenn authorization
```

---

## R2-3｜H3 Video Review Workbench

### 阶段目标

支持人类审片、通过、拒绝、写拒绝原因、发起重生成请求。

### 执行任务书

```markdown
# R2-3｜H3 Video Review Workbench

## 功能
- 播放 generated_clip artifact
- 显示 ffprobe metadata
- 显示 Generation Run
- approve clip
- reject clip
- 填写 rejection reason
- 创建 regeneration request draft
- 查看 clip_versions
- 不自动 regeneration
```

### 验收标准

```yaml
acceptance:
  - clip review decision saved
  - approved clip writes accepted_clip_artifact_id
  - rejected clip remains traceable
  - regeneration requires explicit confirmation
```

---

## R2-4｜H4 Final Assembly Workbench

### 阶段目标

支持最终合成前检查、执行合成、导出 final video。

### 验收标准

```yaml
acceptance:
  - all required shots accepted before assembly
  - assembly readiness visible
  - final assembly report written
  - final_video artifact created
  - final video ffprobe PASS
  - source clips not overwritten
```

---

## R2-5｜H5 Memory / Asset Workbench

### 阶段目标

支持资产沉淀、参考沉淀、记忆回存确认。

### 功能

```yaml
features:
  - show Memory Saveback Proposal
  - approve / reject memory items
  - update asset references
  - update creative references
  - view provenance
```

### 验收标准

```yaml
acceptance:
  - Memory Saveback Proposal visible
  - human can approve / reject memory items
  - asset/reference updates preserve provenance
  - no automatic memory save without confirmation
```
