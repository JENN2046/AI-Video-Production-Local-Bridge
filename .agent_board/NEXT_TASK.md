# NEXT_TASK.md

Status: DONE

Task: R3-7_RUNWAY_LIVE_CANARY_AUTHORIZATION

Title: Runway Live Canary Authorization

Priority: P0

Lane: Approval Boundary Preparation

Project: AI Video Production Workspace Three Route Plan

Claimed by: Codex sustained executor

Claim run ID: codex-20260707-113015-r3-7

Claimed at: 2026-07-07T11:30:15+08:00

Completed by: Codex sustained executor

Completed at: 2026-07-07T11:34:21+08:00

Result: PASS_READY_FOR_USER_AUTHORIZATION

## Goal

Prepare the exact authorization surface for a single live Runway canary after the local three-route workflow has passed. This task stopped before any live provider submit.

## Evidence

- `data/reports/r3_7_runway_live_canary_authorization_result.json`
- `data/reports/r3_7_runway_live_canary_authorization_result_20260707T113308+0800.json`
- `data/reports/m1_r0_runway_canary_dry_run_report.json`
- `data/reports/m1_r0_runway_canary_final_guard.json`
- `data/reports/provider_env_check_result.json`
- `data/reports/provider_preflight_result.json`
- `data/reports/secret_scan_result.json`

## Validation

- `npm run env:check`
- `npm run provider:preflight`
- `npm run typecheck`
- `npm run test:g0`
- `npm run secret:scan`
- `git diff --check`

## Stop Reason

No eligible READY tasks remain in `.agent_board/TASK_BACKLOG.md`. A live Runway submit requires exact current Jenn authorization.
