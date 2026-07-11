# 三路线规划审查｜AI Video Production Workspace

## 1. 审查结论

上一版三路线规划可以接受，但需要边界修正后再进入执行。

```yaml
review_result: ACCEPT_WITH_REQUIRED_REFINEMENTS
classification: PLAN_VALID_READY_FOR_TASKBOOK_PACKAGING
implementation_authorized_by_this_doc: false
recommended_next_action:
  - freeze Local App contract
  - implement H1 Human Workbench MVP
  - add strict single Runway canary script
  - plan WebGPT MCP read-only bridge
```

核心判断：

```text
本地 App 必须是事实源。
人类工作台必须是审批与硬门入口。
网页 GPT MCP 只能是受控辅助层，不能成为执行权源头。
```

---

## 2. 之前做对了什么

### 2.1 三路线拆分是正确的

把系统拆成：

```text
网页 GPT 侧 MCP 服务
人类工作台
本地 App
```

是正确的。它避免把“创意、操作、执行”混成一团。

三者的本质不同：

| 路线 | 本质 | 风险 |
|---|---|---|
| 网页 GPT MCP | 受控工具连接层 | 过早开放 mutation 会绕过人类 |
| 人类工作台 | 生产控制台 | 如果太晚做，会继续依赖命令行和聊天记录 |
| 本地 App | 事实源与执行内核 | 如果契约不稳，上层 UI 和 MCP 都会返工 |

### 2.2 先做人类工作台的判断正确

人类工作台不是“好看 UI”，而是实际生产中的控制台。它要负责：

```text
审图
导入
注册 artifact
确认 shot
冻结 package
查看报告
准备 provider 授权
审片
选择重生成
最终合成
```

没有这个工作台，系统会长期依赖：

```text
聊天记录 + 命令行 + JSON 报告 + 本地文件夹
```

这在工程验证阶段能走，但真实生产会混乱。

### 2.3 `Media Artifact` / `Storyboard Package` / `Generation Run` 的核心地位正确

三路线都应该围绕这三个对象展开：

```text
Media Artifact 解决文件可信
Storyboard Package 解决输入冻结
Generation Run 解决生成过程可追踪
```

这比“直接把 GPT 图扔给 Runway”稳定得多。

---

## 3. 存在的问题

### 3.1 MCP 路线不能提前拥有写权

上一版中容易出现一个误解：网页 GPT MCP 服务似乎可以“负责导入、冻结、注册”。这需要修正。

正确表达：

```yaml
WebGPT_MCP:
  can:
    - read app-side status
    - submit draft
    - propose import
    - request validation
    - request freeze
  cannot:
    - directly register artifact without human gate
    - directly freeze package without human gate
    - call provider
    - delete or overwrite source assets
```

真正的写入权属于：

```text
Human Workbench confirmed action → Local App mutation → immutable report
```

### 3.2 Canary 链路和正式生产链路必须分开

Runway canary 的目标是验证：

```text
credential / request / ratio / download / ffprobe / artifact registration
```

正式生产链路的目标是：

```text
approved WebGPT keyframe → Media Artifact → frozen Storyboard Package → Generation Run
```

两者不能混淆。canary 成功不代表创意视频通过，正式 keyframe 通过也不代表 provider path 已验证。

### 3.3 人类工作台 H1 不应包含真实 provider 操作

H1 应该只做：

```text
Dashboard / Imports / Shots / Storyboard Package / Reports
```

Provider Guard 可以只读摘要，但真实 provider submit 必须留到 H2 或之后，并且单独授权。

### 3.4 Report latest pointer 是必需能力

如果只写不可变报告，不维护 latest pointer，后续会出现：

```text
data/reports 很多文件，但不知道哪个才是当前状态
```

修正：

```yaml
report_policy:
  immutable_reports: true
  latest_pointer_per_report_type: true
  dashboard_reads_latest_pointer: true
  reports_page_can_open_history: true
```

### 3.5 本地 HTTP 服务必须默认只绑定 localhost

如果做本地 App / 工作台服务，必须加安全边界：

```yaml
local_server_security:
  bind_host: 127.0.0.1
  reject_lan_access: true
  no_public_tunnel_by_default: true
  csrf_or_action_nonce_for_mutations: required
  no_arbitrary_path_input: true
  no_shell_command_from_ui_input: true
```

---

## 4. 修正后的判断

```yaml
corrected_architecture:
  local_app:
    role: truth_source_and_executor
    owns:
      - Project
      - Shot
      - Media Artifact
      - Storyboard Package
      - Generation Run
      - Provider Runner
      - Reports

  human_workbench:
    role: operator_control_plane
    owns:
      - human approval
      - image selection
      - package freeze decision
      - provider authorization decision
      - video review decision

  webgpt_mcp:
    role: controlled_assistant_bridge
    owns:
      - read status
      - submit drafts
      - propose actions
    cannot_bypass:
      - human gate
      - app validation
      - provider gate
```

---

## 5. 下一步执行建议

优先派发三个任务：

```yaml
next_dispatch:
  1:
    title: R3-0_LOCAL_APP_CONTRACT_FREEZE_AND_H1_API_SUPPORT
    reason: 先固定事实源和 API，避免 UI 和 MCP 接错接口

  2:
    title: R2-1_H1_HANDOFF_WORKBENCH_MVP
    reason: 让 Jenn 可以从 UI 完成导入、审批、冻结、报告复核

  3:
    title: R3-3_STRICT_SINGLE_RUNWAY_CANARY_SCRIPT
    reason: 避免 demo:m1:real 成功后自动进入 regeneration proof
```

MCP 路线先做规划，不急着实现完整 App：

```yaml
webgpt_mcp_now:
  do: boundary_design_and_read_only_schema
  dont: full_mutation_tools_or_provider_tools
```

---

## 6. 审查结论

这份规划已经足够进入任务书阶段。  
但必须保持一个纪律：

```text
不是先把 GPT 接上全部能力，而是先让本地 App 和人类工作台建立可信生产闭环。
```
