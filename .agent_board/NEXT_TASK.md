# NEXT_TASK.md

machine: AI_VIDEO_PRODUCTION_SINGLE_SLOT_TASK_STATE
version: 0.1.0
slot: current
task_id: R3-8G_RUNNINGHUB_CONTRACT_FREEZE_AND_DRY_RUN
status: DONE
priority: P0
lane: Provider Contract Freeze
project: AI Video Production Workspace Three Route Plan
title: RunningHub Contract Freeze And Dry Run
updated_at: 2026-07-07T15:55:00+08:00
claimed_by: Codex R3-8G executor
claim_run_id: codex-20260707-154200-r3-8g
completed_by: Codex R3-8G executor
completed_at: 2026-07-07T15:55:00+08:00
result: PASS_CONTRACT_FREEZE_DRY_RUN
validation_result: PASS
delivery: local_only_commit_pending
commit: pending_at_task_closeout

## Scope

- Freeze the official RunningHub image-to-video model API contract.
- Build a no-network dry-run request plan for selected storyboard artifact artifact_cbed1c1c-4293-450e-897e-3be49ddf7fb7.
- Do not call RunningHub or Runway.

## Evidence

- data/reports/r3_8g_runninghub_contract_freeze_dry_run_result.json
- data/reports/secret_scan_result.json
- https://www.runninghub.cn/
- https://www.runninghub.cn/call-api/api-detail/2019380112598044674
- https://www.runninghub.cn/runninghub-api-doc-cn/api-448183102
- https://www.runninghub.cn/runninghub-api-doc-cn/api-425767306
- https://www.runninghub.cn/runninghub-api-doc-cn/api-425749007
- https://www.runninghub.cn/runninghub-api-doc-cn/doc-8435517
- https://www.runninghub.cn/runninghub-api-doc-cn/doc-8287338

## Validation

- npm run r3:8g:dry-run: PASS
- npm run typecheck: PASS
- npm run test:m1: PASS
- npm run secret:scan: PASS
- git diff --check: PASS_WITH_CRLF_WARNINGS_ONLY

## Provider Boundary

- network_call_attempted: false
- runninghub_called: false
- runway_called: false
- provider_credits_consumed: false
- real_video_generated: false
- secret_values_exposed: false

## Next Safe Option

- Promote R3-8H to READY for RunningHub adapter implementation or authorization preparation.
- Any live RunningHub submit still requires a future exact current authorization phrase.
