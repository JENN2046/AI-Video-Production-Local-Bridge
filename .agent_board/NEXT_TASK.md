# NEXT_TASK

task_id: R2G-H_LOCAL_MCP_PACKAGE_ACCEPTANCE_REVIEW
status: DONE
priority: P0
lane: ChatGPT MCP Bridge
project: AI Video Production Workspace GPT Bridge Line
title: Local MCP Package Acceptance Review
claimed_by: Codex R2G-H local MCP acceptance review
claim_run_id: codex-20260709-135145-r2g-h
claimed_at: 2026-07-09T13:51:45+08:00
completed_by: Codex R2G-H local MCP acceptance review
completed_at: 2026-07-09T13:51:45+08:00
result: BLOCK_WITH_FINDINGS_BEFORE_LIVE_CONNECTOR
validation_result: PASS_FOR_REVIEW_EXECUTION_WITH_FINDINGS
report_path: data/reports/r2g_h_local_mcp_package_acceptance_review_result.json

## Findings

- P1: Error tool results violate the declared `outputSchema`; failure envelopes return `error` while schema requires `data`.
- P1: Tool schemas advertise `additionalProperties:false`, but the local executor accepts extra fields and can store them in draft/pending records.
- P2: Tool descriptors are shallow-copied; in-process consumers can mutate nested global descriptor metadata.

## Boundary

- Review only.
- No public tunnel, public MCP endpoint, ChatGPT connector creation, provider/API call, `.env` or credential read, source overwrite, push, tag, release, deploy, publish, or production configuration change.

## Next

- `R2G-H1_MCP_SCHEMA_AND_DESCRIPTOR_HARDENING_FIX` is recorded as `FOLLOW_UP`.
- `R2G-G_CHATGPT_CONNECTOR_LIVE_CONNECTION_AUTHORIZATION_PREP` remains `FOLLOW_UP` and must not be promoted until R2G-H1 is completed and accepted.
