# NEXT_TASK

task_id: R2G-0_CHATGPT_MCP_PACKAGING_REALITY_AUDIT
status: DONE
priority: P0
lane: ChatGPT MCP Bridge
project: AI Video Production Workspace GPT Bridge Line
title: ChatGPT MCP Packaging Reality Audit
claimed_by: Codex R2G-0 packaging reality audit
claim_run_id: codex-20260708-204851-r2g-0
claimed_at: 2026-07-08T20:48:51+08:00
completed_by: Codex R2G-0 packaging reality audit
completed_at: 2026-07-08T20:52:19+08:00
result: PASS_MCP_PACKAGING_REALITY_AUDITED
validation_result: PASS
report_path: data/reports/r2g_0_chatgpt_mcp_packaging_reality_audit_result.json

## Goal

Map the real current ChatGPT Apps SDK / MCP requirements to the local R1 bridge before implementation.

## Boundary

- Audit report only.
- No server implementation, public tunnel, public MCP endpoint, ChatGPT connector creation, provider/API call, `.env` or credential read, source overwrite, push, tag, release, deploy, publish, or production configuration change.

## Evidence

- `data/reports/r2g_0_chatgpt_mcp_packaging_reality_audit_result.json`
- `data/reports/r1_9_chatgpt_mcp_app_packaging_decision_result.json`
- Official OpenAI Apps SDK / MCP docs under `https://developers.openai.com/apps-sdk`

## Validation

- JSON parse for generated R2G-0 report: PASS
- `npm run typecheck`: PASS
- `npm run secret:scan`: PASS
- `git diff --check`: PASS_WITH_CRLF_WARNINGS_ONLY
