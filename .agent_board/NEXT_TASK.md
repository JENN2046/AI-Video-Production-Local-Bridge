# NEXT_TASK.md

Status: DONE

Task: R3-9B_STORYBOARD_PACKAGE_TO_RUNNINGHUB_GENERATION_PLAN

Title: Storyboard Package To RunningHub Generation Plan

Priority: P1

Lane: Provider Production Planning

Project: AI Video Production Workspace Three Route Plan

Depends on: R3-9A_RUNNINGHUB_PRIMARY_LANE_WIRING_DRY_RUN

## Goal

Generate the production-readiness execution plan that maps the frozen storyboard package to RunningHub shot generation, without making any live provider call.

## Required Work

- Load the current frozen storyboard package using local app data only.
- Produce a shot-by-shot RunningHub plan with image artifact, prompt, negative prompt if present, `duration_seconds`, provider ratio/resolution fields, `output_dir`, and expected local artifact registration path.
- Enforce app-created artifact IDs; reject `PENDING_*`, audit images, product references imported as storyboard images, or missing media artifacts.
- Apply the RunningHub primary lane contract from R3-9A, including upload-first flow and 6-second minimum duration.
- Include budget and stop-condition fields for future authorization.
- Draft the exact future authorization phrase, but do not execute it.

## Acceptance

- Report contains one plan entry per eligible shot in the frozen storyboard package.
- Every plan entry references a real app Media Artifact ID and a local source path that is not overwritten.
- Report identifies any shot blocked from live use with a local reason.
- Future live provider execution remains authorization-gated and single-submit/budget bounded per user approval.
- Report records `network_call_attempted=false`, `runninghub_called=false`, `runway_called=false`, `provider_credits_consumed=false`, `real_video_generated=false`, `secret_values_exposed=false`.
- No credentials, `.env` files, raw provider payloads, signed URLs, source overwrite, push, tag, release, or deploy occurs.

## Validation

- JSON parse for generated plan report
- `npm run typecheck`
- `npm run test:m1`
- `npm run secret:scan`
- `git diff --check`

## Claim

- claimed_by: Codex R3-9B package generation planner
- claim_run_id: codex-20260708-121358-r3-9b
- claimed_at: 2026-07-08T12:13:58+08:00

## Result

- result: PASS_PACKAGE_GENERATION_PLAN_READY
- completed_by: Codex R3-9B package generation planner
- completed_at: 2026-07-08T12:17:58+08:00
- evidence: data/reports/r3_9b_storyboard_package_to_runninghub_generation_plan_result.json
- validation: PASS
- commit: PENDING_IN_CURRENT_TASK_COMMIT
