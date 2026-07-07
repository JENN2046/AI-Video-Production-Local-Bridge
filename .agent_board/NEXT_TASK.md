# NEXT_TASK.md

Status: FAILED

Task: R3-8J_RUNNINGHUB_REAL_KEYFRAME_SINGLE_SUBMIT_CANARY

Title: RunningHub Real Keyframe Single-Submit Canary

Priority: P0

Lane: Approval Boundary Live Provider Execution

Project: AI Video Production Workspace Three Route Plan

Depends on: R3-8I_RUNNINGHUB_REAL_KEYFRAME_AUTHORIZATION_PREP

Claimed by: Codex R3-8J executor

Claim run ID: codex-20260707-174355-r3-8j

Claimed at: 2026-07-07T17:43:55+08:00

## Goal

Run exactly one live RunningHub canary under Jenn's current exact authorization phrase and record sanitized evidence.

## Execution Boundary

- `duration_seconds=3`
- `max_upload_calls=1`
- `max_submit_calls=1`
- No automatic retry or second billable submit
- No Runway fallback
- No regeneration or batch generation
- No secret values, signed URLs, raw provider payloads, source overwrite, push, tag, release, or deploy

## Validation

- `npm run typecheck`
- `npm run test:m1`
- `npm run secret:scan`
- `git diff --check`

## Result

`PROVIDER_FAILED_DURATION_MIN_6`

RunningHub rejected the single authorized submit because `duration=3` is less than the provider minimum value `6`.

No provider job id, output URL, local video artifact, or ffprobe result exists.
