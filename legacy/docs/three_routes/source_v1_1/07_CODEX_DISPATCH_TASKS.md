# Codex 派发任务书包｜下一批执行任务

## 0. 派发顺序

推荐顺序：

```text
1. R3-0_LOCAL_APP_CONTRACT_FREEZE_AND_H1_API_SUPPORT
2. R2-1_H1_HANDOFF_WORKBENCH_MVP
3. R3-3_STRICT_SINGLE_RUNWAY_CANARY_SCRIPT
4. R1-0_WEBGPT_MCP_BOUNDARY_AND_READONLY_BRIDGE_PLAN
```

前三个优先级高于 MCP 完整实现。

---

# Task 1｜R3-0_LOCAL_APP_CONTRACT_FREEZE_AND_H1_API_SUPPORT

```markdown
# R3-0_LOCAL_APP_CONTRACT_FREEZE_AND_H1_API_SUPPORT

工作区：`A:\AI Video Production Workspace`

## 任务目标
只读审查本地 App 当前实现，冻结 Human Workbench H1 和 WebGPT MCP v0 所需的 app-side contract。

## 本轮边界
- 只读优先
- 不调用 Runway
- 不调用 RunningHub
- 不生成视频
- 不修改 .env.local
- 不打印 secret
- 不 push / tag / release / deploy

## 必须输出
1. Current object / schema inventory
2. Existing tool/script inventory
3. Read endpoint draft for H1
4. Mutation endpoint draft for H1
5. Read tool draft for MCP v0
6. Mutation report schema
7. latest pointer report strategy
8. hard gate matrix
9. implementation gaps
10. next implementation plan

## 验收标准
result: PASS_CONTRACT_READY or BLOCK_WITH_REASON
```

---

# Task 2｜R2-1_H1_HANDOFF_WORKBENCH_MVP

```markdown
# R2-1_H1_HANDOFF_WORKBENCH_MVP

工作区：`A:\AI Video Production Workspace`

## 任务目标
实现 Human Workbench H1 MVP：Dashboard / Imports / Shots / Storyboard Package / Reports。

## 硬边界
禁止：
- Runway real call
- RunningHub real call
- video generation
- regeneration
- batch generation
- final assembly
- memory saveback
- editing .env.local
- printing secrets
- public tunnel
- source overwrite
- accepting fake IDs

## 页面要求
Dashboard:
- show project readiness
- show import readiness
- show shot completeness
- show package blockers
- show latest reports

Imports:
- scan data/imports
- preview images
- validate selected image
- register approved image as Media Artifact
- block audit/reference/docs/zip

Shots:
- edit shot metadata
- link active Media Artifact
- mark approved / revision_needed
- block PENDING IDs

Storyboard Package:
- run validateG0StoryboardPackage
- freeze app-ready package
- write report

Reports:
- open latest report
- open report history
- show boundary evidence

## 必跑验证
npm run typecheck
npm run test:m1
npm run test:g0
npm run secret:scan

## 新增测试
positive:
- register approved SHOT image
- link active artifact to shot
- validate complete package
- freeze app-ready package

negative:
- reject audit image
- reject product reference
- reject PENDING IDs
- reject inactive artifact
- reject package freeze before all shots approved
- ensure no provider/network call from H1

## 回执
H1_HANDOFF_WORKBENCH_MVP_RESULT:
  result:
  changed_files:
  pages:
  api_endpoints:
  reports_written:
  validation:
  provider_boundary:
```

---

# Task 3｜R3-3_STRICT_SINGLE_RUNWAY_CANARY_SCRIPT

```markdown
# R3-3_STRICT_SINGLE_RUNWAY_CANARY_SCRIPT

工作区：`A:\AI Video Production Workspace`

## 任务目标
新增严格单次 Runway canary 入口，替代 `demo:m1:real` 用作首次真实 provider canary。

## 第一阶段
只实现 dry-run / ready report，不真实调用 Runway。

## 新增命令
推荐：
`npm run runway:canary`

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

## 本任务阶段禁止
- runway_called
- runninghub_called
- network_call_attempted
- provider_credits_consumed
- real_video_generated

## 必须实现
1. single-submit canary runner
2. dry-run plan report
3. input readiness verification
4. provider preflight reuse
5. secret redaction
6. no-regeneration proof
7. no-batch proof
8. require separate Jenn authorization for real call

## 必跑验证
npm run env:check
npm run provider:preflight
npm run typecheck
npm run test:m1
npm run test:g0
npm run secret:scan

## 回执
R3_3_STRICT_SINGLE_RUNWAY_CANARY_SCRIPT_RESULT:
  result:
  new_command:
  changed_files:
  dry_run_report:
  validation:
  provider_boundary:
```

---

# Task 4｜R1-0_WEBGPT_MCP_BOUNDARY_AND_READONLY_BRIDGE_PLAN

```markdown
# R1-0_WEBGPT_MCP_BOUNDARY_AND_READONLY_BRIDGE_PLAN

工作区：`A:\AI Video Production Workspace`

## 任务目标
规划 WebGPT MCP / Bridge 的边界和 v0 只读工具。

## 本轮边界
- 规划优先
- 不实现完整 MCP App
- 不开放 mutation
- 不调用 provider
- 不读取 secret

## 必须输出
1. Short-term HTTPS Bridge design
2. Long-term MCP App design
3. v0 read-only tool list
4. v0.5 draft submission tool list
5. v1 human-confirmed action request flow
6. forbidden tool list
7. auth / local bridge boundary
8. error schema
9. report reference schema
10. Human Workbench confirmation flow

## 验收标准
result: PASS_MCP_BOUNDARY_READY or BLOCK_WITH_REASON
```
