# R2G-H1｜MCP Schema And Descriptor Hardening Fix 任务书

## 0. 任务结论

```yaml
task_id: R2G-H1_MCP_SCHEMA_AND_DESCRIPTOR_HARDENING_FIX
status: READY
lane: ChatGPT MCP Bridge
result_target: PASS_MCP_SCHEMA_AND_DESCRIPTOR_HARDENED
depends_on: R2G-H_LOCAL_MCP_PACKAGE_ACCEPTANCE_REVIEW
```

本任务修复 R2G-H 验收复核发现的 3 个阻断项。完成前不得推进 `R2G-G_CHATGPT_CONNECTOR_LIVE_CONNECTION_AUTHORIZATION_PREP`，也不得做任何 live ChatGPT connector / public HTTPS / tunnel / deploy 工作。

## 1. 背景

R2G-H 复核报告：

`data/reports/r2g_h_local_mcp_package_acceptance_review_result.json`

复核结论：

```yaml
result: BLOCK_WITH_FINDINGS_BEFORE_LIVE_CONNECTOR
live_connector_readiness: BLOCKED_PENDING_FIXES
```

已发现问题：

1. `outputSchema` 与错误结果 envelope 不一致。
2. `inputSchema.additionalProperties=false` 没有被本地执行器强制执行。
3. 工具描述符浅拷贝，进程内消费者可修改全局嵌套 metadata。

## 2. 目标

把本地 R2G MCP bridge 从“本地可跑”提升到“schema / descriptor / fail-closed contract 可接受”，但仍保持 local-only。

必须做到：

- 成功和失败结果都符合声明的 `outputSchema`。
- 本地执行器强制执行 tool `inputSchema`，至少覆盖 `required`、`additionalProperties:false`、基础类型、`enum`、array item object。
- `listChatGptMcpToolDescriptors()` 返回值不可污染全局工具描述符。
- R2G-B schema fixture 与实现保持一致。
- 新增回归测试覆盖 R2G-H 的 3 个 findings。

## 3. 允许范围

允许修改：

- `src/tools/chatGptMcpBridge.ts`
- `tests/chatgpt-mcp-bridge.test.ts`
- `scripts/r2g-mcp-packaging.ts`，仅当报告/fixture 生成需要同步时
- `fixtures/mcp/chatgpt_mcp_tool_contract_r2g_b.json`
- `data/reports/r2g_b_mcp_tool_schema_and_contract_freeze_result.json`
- `data/reports/r2g_e_human_confirmation_and_write_gates_result.json`
- `data/reports/r2g_f_mcp_packaging_closeout_result.json`
- `data/reports/r2g_h1_mcp_schema_and_descriptor_hardening_fix_result.json`
- `.agent_board/*` 任务状态、ledger、validation log、handoff

## 4. 禁止范围

禁止：

- 启动 public tunnel
- 创建 public MCP endpoint
- 创建 ChatGPT connector
- 读取 `.env` / credentials
- 调用 OpenAI API / RunningHub / Runway / 任何 provider
- 生成、重生成、合成视频
- 覆盖 source assets
- push / tag / release / deploy / publish
- 修改 production configuration
- 触碰无关文件：`scripts/h1-workbench.ts`、`drag_drop_cards_to_planner.gif`、`howtouseinbox.gif`

## 5. 必修复点

### 5.1 输出 envelope 与 outputSchema 对齐

当前风险：

- `OBJECT_OUTPUT_SCHEMA` 要求 `ok`、`data`、`boundary`。
- `fail()` 返回 `ok`、`error`、`boundary`，缺少 `data`。

建议实现：

- 统一 `structuredContent` 形状：

```ts
{
  ok: boolean;
  data: Record<string, unknown>;
  error: Record<string, unknown>;
  boundary: Record<string, boolean>;
}
```

- 成功：

```ts
data = { ... };
error = {};
```

- 失败：

```ts
data = {};
error = { code, message };
```

- `OBJECT_OUTPUT_SCHEMA.required` 应包含 `ok`、`data`、`error`、`boundary`。
- `additionalProperties` 建议设为 `false`，除非有明确兼容理由。

### 5.2 执行器强制 inputSchema

当前风险：

即使 descriptor 声明：

```json
{ "additionalProperties": false }
```

本地执行器仍接受：

```ts
executeChatGptMcpTool("request_package_freeze", {
  reason: "schema probe",
  extra_unexpected: true
})
```

建议实现：

- 在 `executeChatGptMcpTool()` 调用 handler 前增加通用 schema guard。
- guard 至少检查：
  - required fields
  - unknown top-level fields when `additionalProperties:false`
  - primitive `type`: `string` / `number` / `boolean` / `object` / `array`
  - `enum`
  - array `items.type === "object"` 时，每个 item 必须是 object
  - nested item `additionalProperties` 只按 schema 当前声明执行；不要擅自收紧已声明为 `true` 的草稿 shot item。
- schema guard 失败时返回稳定错误码，例如：
  - `SCHEMA_VALIDATION_FAILED`
  - `UNKNOWN_INPUT_FIELD`
  - `INVALID_INPUT_TYPE`
  - `MISSING_REQUIRED_FIELD`
  - `INVALID_ENUM_VALUE`

### 5.3 descriptor immutable / clone

当前风险：

`listChatGptMcpToolDescriptors()` 只浅拷贝：

```ts
return CHATGPT_MCP_TOOL_DESCRIPTORS.map((descriptor) => ({ ...descriptor }));
```

进程内消费者可修改 nested object，污染全局 descriptor。

建议实现：

- 对 `CHATGPT_MCP_TOOL_DESCRIPTORS` 深冻结，或
- `listChatGptMcpToolDescriptors()` 返回深克隆，且测试证明修改返回值不会影响全局 descriptor。

优先方案：

```ts
const clone = structuredClone(value)
```

如需兼容，可用 `JSON.parse(JSON.stringify(value))`，但要确认不会丢失函数或非 JSON 类型；当前 descriptor 是 JSON-safe。

## 6. 必加测试

在 `tests/chatgpt-mcp-bridge.test.ts` 中至少新增：

1. failure envelope conforms to outputSchema
   - forbidden provider tool
   - fake artifact id
   - missing required field
   - 检查 `structuredContent` 包含 `ok/data/error/boundary`

2. executor rejects additionalProperties
   - READ_ONLY: `get_project_status` 带 extra field 应失败
   - DRAFT_ONLY: `submit_storyboard_draft` 顶层 extra field 应失败
   - HUMAN_CONFIRMATION_REQUIRED: `request_package_freeze` 带 extra field 应失败

3. descriptor mutation cannot affect global descriptors
   - 修改 `listChatGptMcpToolDescriptors()[0].security.provider_call_allowed`
   - 再读取全局或再次 list，必须仍为 `false`

4. schema fixture matches descriptors
   - `fixtures/mcp/chatgpt_mcp_tool_contract_r2g_b.json` 的 `tool_contract` 与 `CHATGPT_MCP_TOOL_DESCRIPTORS` 同步。

## 7. 必生成报告

输出：

`data/reports/r2g_h1_mcp_schema_and_descriptor_hardening_fix_result.json`

报告必须包含：

```yaml
task_id: R2G-H1_MCP_SCHEMA_AND_DESCRIPTOR_HARDENING_FIX
result: PASS_MCP_SCHEMA_AND_DESCRIPTOR_HARDENED or BLOCK_WITH_REASON
fixed_findings:
  - R2G-H-FINDING-001
  - R2G-H-FINDING-002
  - R2G-H-FINDING-003
validation:
  typecheck:
  test_r2g_mcp:
  schema_fixture_check:
  secret_scan:
  diff_check:
provider_boundary:
  public_tunnel_started: false
  public_mcp_endpoint_created: false
  chatgpt_connector_created: false
  network_call_attempted: false
  provider_called: false
  env_files_read: false
  credentials_read: false
  secret_values_exposed: false
next_gate:
  r2g_g_may_be_prepared_after_h1: true or false
```

## 8. 必跑验证

```bash
npm run r2g:b:contract
npm run r2g:e:gates
npm run r2g:f:closeout
npm run typecheck
npm run test:r2g:mcp
npm run secret:scan
git diff --check
```

还必须运行一个 JSON parse 检查：

```bash
node -e "JSON.parse(require('fs').readFileSync('data/reports/r2g_h1_mcp_schema_and_descriptor_hardening_fix_result.json','utf8')); JSON.parse(require('fs').readFileSync('fixtures/mcp/chatgpt_mcp_tool_contract_r2g_b.json','utf8')); console.log('R2G_H1_JSON_PARSE_PASS')"
```

## 9. 验收标准

任务通过条件：

- R2G-H 的 3 个 findings 均被测试覆盖并修复。
- `test:r2g:mcp` 中新增的负向测试通过。
- `r2g_h1` 报告为 `PASS_MCP_SCHEMA_AND_DESCRIPTOR_HARDENED`。
- `R2G-G` 仍不执行，只允许在 H1 完成后作为后续授权准备任务。
- 工作树不包含无关变更。

任务失败或阻塞条件：

- 任一 R2G-H finding 未修复。
- 修复需要改变公共 connector / live endpoint / credentials / provider 调用。
- 测试或 secret scan 失败且无法在本任务范围内修复。

## 10. 交付格式

最终汇报必须包含：

```yaml
R2G-H1_RESULT:
  result:
  changed_files:
  fixed_findings:
  validation:
  report:
  boundary:
    public_tunnel_started: false
    public_mcp_endpoint_created: false
    chatgpt_connector_created: false
    provider_called: false
    env_files_read: false
    credentials_read: false
  git:
    commit:
    push: false
  next:
    r2g_g_status:
```
