# NEXT_TASK

task_id: R2G-K_CHATGPT_CONNECTOR_LIVE_AUTHORIZATION_FINAL_PREP
status: READY
priority: P0
lane: ChatGPT MCP Bridge
project: AI Video Production Workspace GPT Bridge Line
title: ChatGPT Connector Live Authorization Final Prep
depends_on: R2G-J_HTTP_MCP_TRANSPORT_LOCAL_DRY_RUN
report_path: data/reports/r2g_k_chatgpt_connector_live_authorization_final_prep_result.json

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
