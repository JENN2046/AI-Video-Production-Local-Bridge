# NEXT_TASK.md

Status: READY

Task: R3-9C_RUNNINGHUB_4_SHOT_LIVE_AUTHORIZATION_PREP

Title: RunningHub 4-Shot Live Authorization Prep

Priority: P0

Lane: Provider Live Authorization Prep

Project: AI Video Production Workspace Three Route Plan

Depends on: R3-9B_STORYBOARD_PACKAGE_TO_RUNNINGHUB_GENERATION_PLAN

## Goal

Prepare the final local authorization gate for a future RunningHub 4-shot live run without executing it.

## Required Work

- Inspect the R3-9B local generation plan and produce a final hard-gate authorization prep report.
- Verify four planned storyboard shots, artifact IDs, prompts, durations, output directories, budget limits, and stop conditions.
- Draft the exact future Jenn authorization phrase for one bounded RunningHub 4-shot live execution.
- Do not read credentials, `.env` files, or make live provider calls.

## Acceptance

- R3-9B plan is parsed and referenced as the source of truth.
- Exactly 4 eligible shot plans are confirmed, with 0 local blockers or a clear `BLOCK_WITH_REASON`.
- Each shot confirms app-created media artifact ID, `storyboard_image` role, local source path, prompt, provider `duration_seconds=6`, `output_dir`, and future local artifact storage expectations.
- Budget and stop conditions are explicit: `max_upload_calls_total=4`, `max_submit_calls_total=4`, max one upload and one submit per shot, no retry, no second submit, no regeneration, no batch expansion, no Runway fallback.
- Future query/download/ffprobe validation path is documented for each shot.
- A precise future authorization phrase is drafted but not executed.
- Report records `network_call_attempted=false`, `runninghub_called=false`, `runway_called=false`, `provider_credits_consumed=false`, `real_video_generated=false`, `secret_values_exposed=false`.
- No credentials, `.env` files, raw provider payloads, signed URLs, source overwrite, push, tag, release, or deploy occurs.

## Validation

- JSON parse for generated authorization prep report
- `npm run typecheck`
- `npm run test:m1`
- `npm run secret:scan`
- `git diff --check`

## Stop Reason

Authorization prep only. Do not run any provider, credential-read, push, tag, release, or deploy action.
