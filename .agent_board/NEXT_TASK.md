# NEXT_TASK

task_id: R1-9_CHATGPT_MCP_APP_PACKAGING_DECISION
status: DONE
priority: P1
lane: WebGPT Bridge
project: AI Video Production Workspace GPT Bridge Line
title: ChatGPT MCP App Packaging Decision
claimed_by: Codex R1-9 packaging decision
claim_run_id: codex-20260708-203918-r1-9
claimed_at: 2026-07-08T20:39:18+08:00
completed_by: Codex R1-9 packaging decision
completed_at: 2026-07-08T20:42:06+08:00
result: PASS_GO_MCP_APP_BRIDGE_DECISION_READY
validation_result: PASS
source_report: data/reports/r1_8_webgpt_operator_runbook_and_prompt_pack_result.json
r1_7_smoke_report: data/reports/r1_7_webgpt_local_bridge_smoke_validation_result.json
r1_6_audit_report: data/reports/r1_6_webgpt_post_closeout_bridge_reality_audit_result.json
report_path: data/reports/r1_9_chatgpt_mcp_app_packaging_decision_result.json

## Goal

Close the R1 local WebGPT bridge stage with a fixed `GO_MCP_APP_BRIDGE` decision and define the handoff into R2G.

## Boundary

- Decision closeout only; implementation begins in R2G after this task completes.
- No public tunnel, provider call, `.env` or credential read, source overwrite, push, tag, release, deploy, publish, or production configuration change.

## Evidence

- `data/reports/r1_9_chatgpt_mcp_app_packaging_decision_result.json`
- `data/reports/r1_8_webgpt_operator_runbook_and_prompt_pack_result.json`
- `https://developers.openai.com/apps-sdk/build/mcp-server`
- `https://developers.openai.com/apps-sdk/deploy/submission`

## Validation

- JSON parse for generated R1-9 report: PASS
- `npm run typecheck`: PASS
- `npm run secret:scan`: PASS
- `git diff --check`: PASS_WITH_CRLF_WARNINGS_ONLY
