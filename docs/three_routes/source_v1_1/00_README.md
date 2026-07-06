# AI Video Production Workspace｜三路线任务规划包 v1.1

生成时间：2026-07-06  
范围：网页 GPT 侧 MCP 服务 / 人类工作台 / 本地 App  3 条路线

## 包内文件

1. `01_PLAN_REVIEW.md`  
   对上一版三路线规划进行审查，给出通过结论、问题、修正和下一步判断。

2. `02_MASTER_PLAN_v1_1.md`  
   锚定实现目标的总计划书。定义三路线职责、优先级、阶段路线和总验收标准。

3. `03_R3_LOCAL_APP_ROUTE_TASKBOOK.md`  
   本地 App 路线完整阶段计划与任务书。重点是 Media Artifact、Storyboard Package、Generation Run、provider canary、review、final assembly、memory saveback。

4. `04_R2_HUMAN_WORKBENCH_ROUTE_TASKBOOK.md`  
   人类工作台路线完整阶段计划与任务书。重点是 Dashboard、Imports、Shots、Storyboard Package、Reports、Provider Guard、Video Review、Final Assembly、Memory/Asset。

5. `05_R1_WEBGPT_MCP_ROUTE_TASKBOOK.md`  
   网页 GPT 侧 MCP / Bridge 路线完整阶段计划与任务书。重点是只读服务、草案提交、人类确认动作、审片助手、长期 MCP App。

6. `06_INTEGRATION_ROADMAP_AND_ACCEPTANCE.md`  
   三路线集成路线图、依赖关系、全局验收标准、验证矩阵、风险控制。

7. `07_CODEX_DISPATCH_TASKS.md`  
   可直接派发给 Codex 的下一批任务书：Local App Contract Freeze、H1 Workbench MVP、Strict Runway Canary Script、WebGPT MCP Boundary Plan。

8. `manifest.json`  
   文件清单与 sha256。

## 总判断

三条路线都应该建设，但优先级不能反：

```text
1. 本地 App：事实源与执行内核
2. 人类工作台：Jenn 的审批、冻结、授权、审片控制台
3. 网页 GPT 侧 MCP 服务：GPT 的受控连接层
```

当前不建议直接做完整 MCP App。  
建议先完成：

```text
Local App artifact/package contract
  ↓
H1 Human Workbench MVP
  ↓
Strict single Runway canary script
  ↓
WebGPT MCP read-only bridge
```
