# NEXT_TASK

task_id: R2G-L_CHATGPT_CONNECTOR_READ_ONLY_LIVE_SMOKE_LOCAL_ENTRY_PREP
status: DONE
priority: P0
lane: ChatGPT MCP Bridge
project: AI Video Production Workspace GPT Bridge Line
title: ChatGPT Connector Read-Only Live Smoke Local Entry Prep
depends_on: R2G-K_CHATGPT_CONNECTOR_LIVE_AUTHORIZATION_FINAL_PREP
report_path: data/reports/r2g_l_chatgpt_connector_read_only_live_smoke_local_entry_prep_result.json
claimed_by: Codex R2G-L read-only live smoke local entry prep
claim_run_id: codex-20260709-155633-r2g-l
claimed_at: 2026-07-09T15:56:33+08:00
completed_by: Codex R2G-L read-only live smoke local entry prep
completed_at: 2026-07-09T16:07:30+08:00
result: PASS_READ_ONLY_LIVE_SMOKE_LOCAL_ENTRY_PREP
commit: PENDING_LOCAL_COMMIT

## Goal

Prepare the local read-only live smoke MCP entry without starting a public tunnel, creating a ChatGPT connector, reading credentials, calling providers/APIs, or deploying.

## Acceptance

- A local read-only live smoke MCP entry exists and can be exercised over localhost.
- Only `READ_ONLY` tools are listed or callable through the live smoke entry.
- Draft, human-confirmed write, provider, generation, shell, secret, and unknown tools fail closed.
- Generate `data/reports/r2g_l_chatgpt_connector_read_only_live_smoke_local_entry_prep_result.json`.
- Confirm no public tunnel, connector creation, deploy, `.env`/credential read, provider/API call, push, tag, release, deploy, or publish occurred.

## Boundary

- This task is local-only live smoke entry preparation.
- It may not start a public tunnel, expose a public MCP endpoint, create a ChatGPT connector, deploy, read `.env` or credentials, call providers/APIs, push, tag, release, publish, or change production configuration.

## Validation

- `npm run r2g:l:read-only-entry-prep`: PASS
- JSON parse for `data/reports/r2g_l_chatgpt_connector_read_only_live_smoke_local_entry_prep_result.json`: PASS
- `npm run typecheck`: PASS
- `npm run test:r2g:mcp`: PASS
- `npm run secret:scan`: PASS
- `git diff --check`: PASS_WITH_CRLF_WARNINGS_ONLY

## Result

- Local read-only live smoke entry implemented.
- Future local server command prepared: `npm run r2g:l:serve-read-only -- --port 2091`.
- No public tunnel, public MCP endpoint, ChatGPT connector creation, deploy, `.env`/credential read, provider/API call, push, tag, release, deploy, publish, or production configuration change occurred.
