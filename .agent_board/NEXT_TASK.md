# NEXT_TASK

task_id: R2G-H1_MCP_SCHEMA_AND_DESCRIPTOR_HARDENING_FIX
status: READY
priority: P0
lane: ChatGPT MCP Bridge
project: AI Video Production Workspace GPT Bridge Line
title: MCP Schema And Descriptor Hardening Fix
depends_on: R2G-H_LOCAL_MCP_PACKAGE_ACCEPTANCE_REVIEW
taskbook_path: docs/webgpt/R2G_H1_MCP_SCHEMA_AND_DESCRIPTOR_HARDENING_TASKBOOK.md
taskbook_self_review_report: data/reports/r2g_h1_taskbook_self_review_result.json
report_path: data/reports/r2g_h1_mcp_schema_and_descriptor_hardening_fix_result.json

## Goal

Harden the local R2G MCP bridge contract before any live ChatGPT connector preparation.

## Required Work

- Fix R2G-H outputSchema/error-envelope mismatch.
- Enforce MCP tool inputSchema server-side, including `additionalProperties:false`.
- Deep-freeze or deep-clone tool descriptors so listed metadata cannot mutate global descriptor state.
- Add regression tests for all R2G-H findings.
- Regenerate affected R2G reports and schema fixture.

## Validation

- `npm run r2g:b:contract`
- `npm run r2g:e:gates`
- `npm run r2g:f:closeout`
- JSON parse for `data/reports/r2g_h1_mcp_schema_and_descriptor_hardening_fix_result.json`
- JSON parse for `fixtures/mcp/chatgpt_mcp_tool_contract_r2g_b.json`
- `npm run typecheck`
- `npm run test:r2g:mcp`
- `npm run secret:scan`
- `git diff --check`

## Boundary

- Local hardening only.
- No public tunnel, public MCP endpoint, ChatGPT connector creation, provider/API call, `.env` or credential read, source overwrite, push, tag, release, deploy, publish, or production configuration change.
- Do not touch unrelated files: `scripts/h1-workbench.ts`, `drag_drop_cards_to_planner.gif`, or `howtouseinbox.gif`.

## Stop

`R2G-G_CHATGPT_CONNECTOR_LIVE_CONNECTION_AUTHORIZATION_PREP` remains `FOLLOW_UP` until R2G-H1 is completed and accepted.
