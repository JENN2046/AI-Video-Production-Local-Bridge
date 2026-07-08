# NEXT_TASK

task_id: R1-8_WEBGPT_OPERATOR_RUNBOOK_AND_PROMPT_PACK
status: DONE
priority: P1
lane: WebGPT Bridge
project: AI Video Production Workspace GPT Bridge Line
title: WebGPT Operator Runbook And Prompt Pack
claimed_by: Codex R1-8 operator runbook prompt pack
claim_run_id: codex-20260708-202753-r1-8
claimed_at: 2026-07-08T20:27:53+08:00
completed_by: Codex R1-8 operator runbook prompt pack
completed_at: 2026-07-08T20:35:57+08:00
result: PASS_WEBGPT_OPERATOR_RUNBOOK_AND_PROMPT_PACK_READY
validation_result: PASS
source_report: data/reports/r1_7_webgpt_local_bridge_smoke_validation_result.json
final_closeout_report: data/reports/r3_9r_final_delivery_closeout_result.json
report_path: data/reports/r1_8_webgpt_operator_runbook_and_prompt_pack_result.json
runbook_path: docs/webgpt/WEBGPT_OPERATOR_RUNBOOK_R1_8.md
prompt_pack_path: docs/webgpt/WEBGPT_PROMPT_PACK_R1_8.md

## Goal

Create a Chinese local operator runbook and WebGPT prompt pack so future Web GPT outputs can be handed into the local system consistently.

## Boundary

- Documentation and prompt pack only.
- No public tunnel, provider call, `.env` or credential read, source overwrite, push, tag, release, deploy, publish, or production configuration change.

## Evidence

- `docs/webgpt/WEBGPT_OPERATOR_RUNBOOK_R1_8.md`
- `docs/webgpt/WEBGPT_PROMPT_PACK_R1_8.md`
- `data/reports/r1_8_webgpt_operator_runbook_and_prompt_pack_result.json`

## Validation

- JSON parse for generated R1-8 report: PASS
- Required section check for both docs: PASS
- `npm run typecheck`: PASS
- `npm run secret:scan`: PASS
- `git diff --check`: PASS_WITH_CRLF_WARNINGS_ONLY
