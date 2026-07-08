# NEXT_TASK.md

Status: READY

Task: R3-9A_RUNNINGHUB_PRIMARY_LANE_WIRING_DRY_RUN

Title: RunningHub Primary Lane Wiring Dry Run

Priority: P1

Lane: Provider Primary Lane Dry Run

Project: AI Video Production Workspace Three Route Plan

Depends on: R3-8K_PROVIDER_PATH_DECISION_CLOSEOUT

## Goal

Wire and verify the local primary-provider planning path for RunningHub without making any live provider call.

## Required Work

- Verify the M1 generation planning path selects RunningHub Enterprise-Shared API Key as the primary provider lane.
- Confirm RunningHub request planning uses upload-first media flow and `duration_seconds` minimum `6`.
- Confirm single-shot and package planning can produce auditable dry-run plans behind authorization gates.
- Do not read credentials or call providers.

## Acceptance

- Primary provider selection resolves to `runninghub` for M1 generation planning.
- Runway remains secondary or fallback-only and is not selected by the primary-lane dry run.
- RunningHub `duration_seconds` is locally validated against the 6-second minimum before any upload or submit could occur.
- RunningHub upload-first planning is explicit: local media artifact to upload request plan to submit request plan to query/download readiness.
- Single-shot dry-run plan records selected image artifact, prompt, `duration_seconds`, `output_dir`, `max_upload_calls`, `max_submit_calls`, and `authorization_required`.
- Package-level dry-run plan is supported or clearly blocked with a local reason and no provider call.
- Report records `network_call_attempted=false`, `runninghub_called=false`, `runway_called=false`, `provider_credits_consumed=false`, `real_video_generated=false`, `secret_values_exposed=false`.
- No credentials, `.env` files, raw provider payloads, signed URLs, source overwrite, push, tag, release, or deploy occurs.

## Validation

- `npm run typecheck`
- `npm run test:m1`
- `npm run secret:scan`
- `git diff --check`

## Stop Reason

Dry-run only. Do not run any provider, credential-read, push, tag, release, or deploy action.
