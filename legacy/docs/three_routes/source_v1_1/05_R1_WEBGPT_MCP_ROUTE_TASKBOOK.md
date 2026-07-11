# R1｜网页 GPT 侧 MCP / Bridge 路线任务规划

## 0. 路线定位

网页 GPT 侧 MCP 服务是受控连接层。它让 Web GPT 能读取真实 app 状态、提交草案、请求动作、辅助审片。

它不是本地 App，不是人类工作台，不是 provider runner。

正确权力边界：

```yaml
webgpt_mcp_can:
  - read app-side status
  - submit creative drafts
  - propose artifact links
  - request validation
  - request package freeze
  - draft review notes

webgpt_mcp_cannot:
  - directly call Runway
  - directly call RunningHub
  - read secrets
  - run shell
  - delete files
  - overwrite source assets
  - freeze package without human confirmation
  - approve final delivery
```

---

## R1-0｜MCP / Bridge Boundary Design

### 阶段目标

冻结网页 GPT 能调用什么、不能调用什么。

### 推荐架构

短期：

```text
Web GPT
  ↓ HTTPS Bridge / Custom Action compatible API
Local App API
```

长期：

```text
ChatGPT MCP App / Apps SDK
  ↓ MCP Tools + Resources + UI
Local App / Human Workbench guarded actions
```

### 执行任务书

```markdown
# R1-0｜WebGPT MCP Boundary Design

## 任务目标
规划网页 GPT 侧 MCP / Bridge 服务的工具边界。

## 必须输出
1. Tool categories
2. Read-only tools
3. Draft submission tools
4. Human-confirmed mutation request tools
5. Forbidden tools
6. Auth / local bridge boundary
7. Error schema
8. Report reference schema
9. Human Workbench confirmation flow

## 禁止
- provider call tools
- shell tools
- secret tools
- delete/overwrite tools
- direct package freeze
```

### 验收标准

```yaml
acceptance:
  - GPT can read status but cannot invent IDs
  - GPT can submit drafts but cannot bypass human approval
  - provider tools excluded
  - secrets inaccessible
```

---

## R1-1｜MCP v0 Read-Only Service

### 阶段目标

让 Web GPT 读取真实 app 状态，不再靠聊天记录猜状态。

### 工具草案

```yaml
read_tools:
  - get_workspace_status
  - get_project_status
  - list_import_candidates
  - list_media_artifacts
  - get_media_artifact
  - get_shot_status
  - get_storyboard_package_status
  - get_latest_reports
  - get_provider_readiness_summary
```

### 执行任务书

```markdown
# R1-1｜WebGPT MCP v0 Read-Only Tools

## 任务目标
实现只读 MCP / Bridge 工具，让 Web GPT 可以读取 app-side 状态。

## 必须实现
1. Tool schema
2. app API adapter
3. error schema
4. report references
5. no mutation
6. no provider call
7. no secret value response
```

### 验收标准

```yaml
acceptance:
  - GPT can see real artifact/package/shot status
  - GPT cannot mutate app state
  - no provider call
  - no secret exposure
```

---

## R1-2｜MCP v0.5 Draft Submission

### 阶段目标

允许 GPT 提交草案，但不直接改变生产状态。

### 工具草案

```yaml
draft_tools:
  - submit_shot_script_draft
  - submit_storyboard_package_draft
  - propose_artifact_link
  - propose_package_validation
  - propose_freeze_request
```

### 规则

```yaml
draft_rules:
  - drafts are not app-ready truth
  - human workbench must review
  - app must validate before mutation
  - no direct freeze
```

### 验收标准

```yaml
acceptance:
  - GPT draft stored separately
  - Human Workbench can review draft
  - fake IDs rejected
  - no frozen package created directly by GPT
```

---

## R1-3｜MCP v1 Human-Confirmed Handoff Tools

### 阶段目标

允许 GPT 请求低风险 mutation，但必须经过人类确认。

### 工具草案

```yaml
human_confirmed_tools:
  - request_register_media_artifact_from_import
  - request_link_artifact_to_shot
  - request_validate_storyboard_package
  - request_import_storyboard_package
```

### 执行规则

```yaml
execution_rules:
  - GPT request creates pending action
  - Human Workbench displays pending action
  - Jenn confirms or rejects
  - Local App executes mutation
  - immutable report written
```

### 验收标准

```yaml
acceptance:
  - GPT cannot execute mutation alone
  - human confirmation required
  - action report written
  - latest state updates after app execution
```

---

## R1-4｜MCP v2 Review Assistant Tools

### 阶段目标

让 GPT 读取视频结果 metadata 并辅助写审片意见，但不能替人类最终 approve。

### 工具草案

```yaml
review_tools:
  - get_generation_run
  - get_generated_clip_metadata
  - submit_review_note_draft
  - propose_rejection_reason
  - propose_regeneration_prompt
```

### 验收标准

```yaml
acceptance:
  - GPT can draft review notes
  - human final approval required
  - regeneration not triggered automatically
```

---

## R1-5｜MCP v3 Production Assistant

### 阶段目标

长期开放：GPT 辅助制定 generation / regeneration / assembly / saveback plan，但真实 provider 调用仍由人类硬门控制。

### 工具草案

```yaml
production_assistant_tools:
  - propose_generation_plan
  - propose_regeneration_plan
  - propose_final_assembly_plan
  - propose_memory_saveback
```

### 验收标准

```yaml
acceptance:
  - GPT proposes but does not execute real-world provider call
  - Human Workbench remains hard gate
  - Local App remains only executor
```
