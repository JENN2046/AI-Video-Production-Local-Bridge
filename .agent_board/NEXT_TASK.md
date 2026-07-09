# NEXT_TASK

task_id: R2G-G_CHATGPT_CONNECTOR_LIVE_CONNECTION_AUTHORIZATION_PREP
status: DONE
priority: P1
lane: ChatGPT MCP Bridge
project: AI Video Production Workspace GPT Bridge Line
title: ChatGPT Connector Live Connection Authorization Prep
depends_on: R2G-H1_MCP_SCHEMA_AND_DESCRIPTOR_HARDENING_FIX
report_path: data/reports/r2g_g_chatgpt_connector_live_connection_authorization_prep_result.json

## Goal

Prepare the live ChatGPT connector authorization package without starting any public tunnel, creating any connector, deploying, reading credentials, or calling providers.

## Result

result: PASS_READY_FOR_SEPARATE_LIVE_CONNECTION_AUTHORIZATION
claimed_at: 2026-07-09T14:32:19+08:00
completed_at: 2026-07-09T14:35:39+08:00
completed_by: Codex R2G-G connector authorization prep
commit: 6529d7f

## Validation

- `npm run r2g:g:authorization-prep`: PASS
- JSON parse and boundary check for `data/reports/r2g_g_chatgpt_connector_live_connection_authorization_prep_result.json`: PASS
- `npm run typecheck`: PASS
- `npm run test:r2g:mcp`: PASS
- `npm run secret:scan`: PASS
- `git diff --check`: PASS_WITH_CRLF_WARNINGS_ONLY

## Evidence

- `data/reports/r2g_g_chatgpt_connector_live_connection_authorization_prep_result.json`
- `data/reports/r2g_f_mcp_packaging_closeout_result.json`
- `data/reports/r2g_h1_mcp_schema_and_descriptor_hardening_fix_result.json`
- Official OpenAI Apps SDK docs listed inside the R2G-G report.

## Boundary

- Authorization prep only.
- No public tunnel, public MCP endpoint, ChatGPT connector creation, deploy, `.env` or credential read, provider/API call, source overwrite, push, tag, release, deploy, publish, or production configuration change occurred.
- Future live connection still requires a separate exact Jenn authorization phrase.
