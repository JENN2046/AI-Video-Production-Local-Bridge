# NEXT_TASK.md

Status: DONE

Task: R3-8I_RUNNINGHUB_REAL_KEYFRAME_AUTHORIZATION_PREP

Title: RunningHub Real Keyframe Authorization Prep

Priority: P0

Lane: Approval Boundary Preparation

Project: AI Video Production Workspace Three Route Plan

Depends on: R3-8H_RUNNINGHUB_ADAPTER_OR_AUTHORIZATION_NEXT_STEP

Claimed by: Codex R3-8I executor

Claim run ID: codex-20260707-171333-r3-8i

Claimed at: 2026-07-07T17:13:33+08:00

Completed by: Codex R3-8I executor

Completed at: 2026-07-07T17:18:38+08:00

Result: PASS_READY_FOR_USER_AUTHORIZATION

Validation result: PASS

## Goal

Prepare the exact authorization phrase, final guard, and dry-run plan for a single RunningHub real-keyframe canary. This task must stop before any live provider upload or submit.

## Required Preparation

- Confirm the selected storyboard keyframe artifact from the app registry, not a GPT-invented ID.
- Reuse the R3-8G frozen RunningHub contract and R3-8H offline adapter skeleton.
- Prepare the upload-first plan for `POST /openapi/v2/media/upload/binary`.
- Prepare the single-submit plan for `POST /openapi/v2/rhart-video-g/image-to-video`.
- Prepare the query plan for `POST /openapi/v2/query`.
- Set `max_submit_calls=1`.
- Disable retries, batch, regeneration, publish, deploy, source overwrite, and any fallback to Runway.
- Produce a final guard report and exact user authorization phrase for the later live canary task.

## Acceptance

- No network call is attempted.
- No RunningHub upload, submit, query, poll, or output download is attempted.
- No Runway call is attempted.
- No provider credits are consumed.
- No real video is generated.
- No secret values, Authorization values, raw binary payloads, base64 image payloads, or raw provider payloads are recorded.
- The next live task remains blocked until Jenn gives a new exact authorization phrase.

## Validation

- `npm run typecheck`
- `npm run test:m1`
- `npm run secret:scan`
- `git diff --check`

## Stop Reason

Stop before any live RunningHub upload, submit, status query, provider output download, provider credit consumption, or real video generation. Any live provider action requires a future exact current Jenn authorization phrase.
