# NEXT_TASK

task_id: R2G-K_CHATGPT_CONNECTOR_LIVE_AUTHORIZATION_FINAL_PREP
status: DONE
priority: P0
lane: ChatGPT MCP Bridge
project: AI Video Production Workspace GPT Bridge Line
title: ChatGPT Connector Live Authorization Final Prep
depends_on: R2G-J_HTTP_MCP_TRANSPORT_LOCAL_DRY_RUN
report_path: data/reports/r2g_k_chatgpt_connector_live_authorization_final_prep_result.json
claimed_by: Codex R2G-K connector authorization final prep
claim_run_id: codex-20260709-153013-r2g-k
claimed_at: 2026-07-09T15:30:13+08:00
completed_by: Codex R2G-K connector authorization final prep
completed_at: 2026-07-09T15:32:43+08:00
result: PASS_READY_FOR_EXACT_LIVE_CONNECTOR_AUTHORIZATION
commit: PENDING_LOCAL_COMMIT

## Goal

Prepare the final live ChatGPT connector authorization package without starting a public tunnel, creating a connector, deploying, reading credentials, or calling providers.

## Acceptance

- Review R2G-G, R2G-I, and R2G-J evidence.
- Generate `data/reports/r2g_k_chatgpt_connector_live_authorization_final_prep_result.json`.
- Include exact future authorization phrase fields, stop conditions, minimum live smoke path, log redaction, and rollback/shutdown requirements.
- Confirm no public tunnel, connector creation, deploy, `.env`/credential read, provider/API call, push, tag, release, deploy, or publish occurred.

## Boundary

- This task is authorization prep only.
- It may not start a public tunnel, expose a public MCP endpoint, create a ChatGPT connector, deploy, read `.env` or credentials, call providers/APIs, push, tag, release, publish, or change production configuration.

## Validation

- `npm run r2g:k:authorization-final-prep`: PASS
- JSON parse and boundary check for `data/reports/r2g_k_chatgpt_connector_live_authorization_final_prep_result.json`: PASS
- `npm run typecheck`: PASS
- `npm run test:r2g:mcp`: PASS
- `npm run secret:scan`: PASS
- `git diff --check`: PASS_WITH_CRLF_WARNINGS_ONLY
