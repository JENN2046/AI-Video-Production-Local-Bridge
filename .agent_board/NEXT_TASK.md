# NEXT_TASK

task_id: R2G-F_MCP_PACKAGING_CLOSEOUT
status: DONE
priority: P1
lane: ChatGPT MCP Bridge
project: AI Video Production Workspace GPT Bridge Line
title: MCP Packaging Closeout
claimed_by: Codex R2G A-F sustained local MCP packaging
claim_run_id: codex-20260708-210000-r2g-a-f
claimed_at: 2026-07-08T21:00:00+08:00
completed_by: Codex R2G A-F sustained local MCP packaging
completed_at: 2026-07-08T21:12:49+08:00
result: PASS_LOCAL_MCP_PACKAGE_READY_FOR_SEPARATE_CONNECTOR_PREP
validation_result: PASS
report_path: data/reports/r2g_f_mcp_packaging_closeout_result.json

## Goal

Close out the local MCP bridge package before any public ChatGPT connection step.

## Boundary

- Stopped at R2G-F by Jenn's current instruction.
- R2G-G remains `FOLLOW_UP` and was not loaded or executed.
- No public tunnel, public MCP endpoint, ChatGPT connector creation, provider call, `.env` or credential read, source overwrite, push, tag, release, deploy, publish, or production configuration change.

## Evidence

- `src/tools/chatGptMcpBridge.ts`
- `scripts/r2g-mcp-packaging.ts`
- `tests/chatgpt-mcp-bridge.test.ts`
- `fixtures/mcp/chatgpt_mcp_tool_contract_r2g_b.json`
- `data/reports/r2g_a_mcp_security_and_permission_model_result.json`
- `data/reports/r2g_b_mcp_tool_schema_and_contract_freeze_result.json`
- `data/reports/r2g_c_local_mcp_server_skeleton_result.json`
- `data/reports/r2g_d_chatgpt_handoff_e2e_dry_run_result.json`
- `data/reports/r2g_e_human_confirmation_and_write_gates_result.json`
- `data/reports/r2g_f_mcp_packaging_closeout_result.json`

## Validation

- JSON parse for R2G-A through R2G-F reports: PASS
- Schema fixture parse/check: PASS
- `npm run typecheck`: PASS
- `npm run test:r2g:mcp`: PASS
- `npm run secret:scan`: PASS
- `git diff --check`: PASS_WITH_CRLF_WARNINGS_ONLY
