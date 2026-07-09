# NEXT_TASK

task_id: R2G-J_HTTP_MCP_TRANSPORT_LOCAL_DRY_RUN
status: DONE
priority: P0
lane: ChatGPT MCP Bridge
project: AI Video Production Workspace GPT Bridge Line
title: HTTP MCP Transport Local Dry Run
depends_on: R2G-I_LIVE_CONNECTOR_READINESS_REVIEW
report_path: data/reports/r2g_j_http_mcp_transport_local_dry_run_result.json
claimed_by: Codex R2G-J HTTP MCP transport local dry-run
claim_run_id: codex-20260709-150456-r2g-j
claimed_at: 2026-07-09T15:04:56+08:00
completed_by: Codex R2G-J HTTP MCP transport local dry-run
completed_at: 2026-07-09T15:08:34+08:00
result: PASS_LOCAL_HTTP_MCP_TRANSPORT_DRY_RUN
commit: PENDING_LOCAL_COMMIT

## Goal

Implement and validate a localhost-only HTTP MCP transport dry-run without public tunnel, ChatGPT connector creation, deployment, credential reads, provider calls, or publishing.

## Acceptance

- Localhost-only `/mcp` endpoint or equivalent local HTTP harness is implemented.
- Dry-run verifies list tools, an approved tool call, forbidden tool fail-closed, schema validation, and boundary flags.
- Report is written to `data/reports/r2g_j_http_mcp_transport_local_dry_run_result.json`.

## Validation

- `npm run typecheck`: PASS
- `npm run test:r2g:mcp`: PASS
- `npm run r2g:j:http-dry-run`: PASS
- JSON parse and boundary check for `data/reports/r2g_j_http_mcp_transport_local_dry_run_result.json`: PASS
- `npm run secret:scan`: PASS
- `git diff --check`: PASS_WITH_CRLF_WARNINGS_ONLY

## Boundary

- No public tunnel, public MCP endpoint, ChatGPT connector creation, deploy, `.env` or credential read, provider/API call, source overwrite, push, tag, release, deploy, publish, or production configuration change is allowed.
