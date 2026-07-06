# 三路线集成路线图与验收标准

## 1. 集成依赖关系

```text
R3 Local App Contract
  ↓
R2 Human Workbench H1
  ↓
R3 Strict Runway Canary
  ↓
R1 MCP Read-Only Bridge
  ↓
R3 Package-Based Generation
  ↓
R2 Video Review Workbench
  ↓
R1 MCP Draft / Review Tools
  ↓
R3 Final Assembly + Memory Saveback
```

核心依赖：

```yaml
dependencies:
  mcp_depends_on:
    - stable local app read APIs
    - stable report references
    - human confirmation flow

  human_workbench_depends_on:
    - local app state APIs
    - mutation APIs
    - immutable reports

  provider_generation_depends_on:
    - active Media Artifacts
    - frozen Storyboard Package
    - explicit human authorization
    - provider preflight PASS
```

---

## 2. 集成阶段

## I0｜共同契约冻结

目标：冻结对象、API、报告、硬门。

验收：

```yaml
acceptance:
  - Local App / Human Workbench / MCP share same state contract
  - no route has conflicting authority
  - report schema and latest pointer defined
```

---

## I1｜G0 WebGPT Package → Local Artifact → Frozen Package

目标：用当前 WebGPT package，导入 clean SHOT images，生成真实 Media Artifact IDs，并冻结 package。

验收：

```yaml
acceptance:
  - 4 approved keyframes registered as artifacts
  - no audit/reference image imported as storyboard_image
  - package validation PASS
  - real storyboard_package_id returned
  - report written
```

---

## I2｜Strict Runway Canary

目标：补 strict one-submit canary，dry-run 后由 Jenn 单独授权一次真实调用。

验收：

```yaml
acceptance:
  - exactly one submit call
  - no regeneration
  - no batch
  - output downloaded
  - generated_clip artifact created
  - ffprobe PASS
```

---

## I3｜Human Workbench controls package production

目标：H1 工作台可以复现 import → artifact → package freeze。

验收：

```yaml
acceptance:
  - Jenn can inspect imports
  - Jenn can register approved keyframes
  - Jenn can approve shots
  - Jenn can freeze package
  - reports visible
```

---

## I4｜MCP reads real app state

目标：Web GPT 能查询真实 artifact / shot / package / report 状态。

验收：

```yaml
acceptance:
  - GPT no longer guesses app state
  - GPT cannot mutate app state
  - no fake ID claims
```

---

## I5｜Package-based generation + human video review

目标：从 frozen package 生成单镜头视频，并在人类工作台审片。

验收：

```yaml
acceptance:
  - Generation Run per shot
  - generated_clip artifact per output
  - review decisions recorded
  - no-overwrite versioning
  - regeneration requires explicit confirmation
```

---

## I6｜Final assembly + memory saveback

目标：所有 shot approved 后合成最终视频，并生成 saveback proposal。

验收：

```yaml
acceptance:
  - final video artifact exists
  - ffprobe PASS
  - memory saveback proposal exists
  - long-term memory write requires human confirmation
```

---

## 3. 全局验证矩阵

每个实现阶段至少运行：

```bash
npm run typecheck
npm run test:m1
npm run test:g0
npm run secret:scan
```

provider 相关阶段追加：

```bash
npm run env:check
npm run provider:preflight
```

真实视频输出相关阶段追加：

```bash
ffprobe validation
```

---

## 4. 全局风险清单

| 风险 | 后果 | 修正策略 |
|---|---|---|
| MCP 过早开放 mutation | GPT 绕过人类审批 | v0 只读，v0.5 只提交 draft |
| 人类工作台直接接受任意路径 | 路径穿越 / 错导入 | 只允许 data/imports + app allowlist |
| Storyboard Package 接受 PENDING ID | 假包进入生成链 | validate 层硬拒绝 |
| canary 和正式生成混淆 | 技术测试被误认为创意通过 | canary report 独立分类 |
| demo:m1:real 自动 regeneration | 第一次真实调用不干净 | 新增 strict runway:canary |
| report sprawl | 不知道哪个状态最新 | latest pointer + immutable history |
| audit/reference 图误入库 | 错图进入 provider | Imports 页硬分类阻断 |
| provider guard UI 造成误解 | 用户以为已经真实调用 | 明确 dry-run / real-call 状态 |

---

## 5. Definition of Done

系统进入 MVP 可用状态的最低条件：

```yaml
definition_of_done:
  creative:
    - Web GPT can produce clean keyframes and script

  artifact:
    - all keyframes imported as Media Artifacts
    - all artifact metadata recorded

  package:
    - Storyboard Package frozen from app-side IDs

  provider:
    - single Runway canary PASS
    - package-based generation path available

  review:
    - generated clips can be reviewed and approved/rejected

  final:
    - accepted clips can be assembled into final video

  memory:
    - saveback proposal generated and human-confirmed

  governance:
    - no fake IDs
    - no source overwrite
    - no secret exposure
    - no unauthorized provider calls
```
