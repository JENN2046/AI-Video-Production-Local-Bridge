# NEXT_TASK.md

Status: FAILED

Task: R3-8E_RUNWAY_REAL_STORYBOARD_KEYFRAME_SINGLE_SUBMIT_AUTHORIZATION

Title: Runway Real Storyboard Keyframe Single-Submit Authorization

Priority: P0

Lane: Approval Boundary Live Provider Execution

Project: AI Video Production Workspace Three Route Plan

Claimed by: Codex R3-8E executor

Claim run ID: codex-20260707-151433-r3-8e

Claimed at: 2026-07-07T15:14:33+08:00

Failed by: Codex R3-8E executor

Failed at: 2026-07-07T15:14:33+08:00

Result: PROVIDER_FAILED_INSUFFICIENT_CREDITS

## Goal

Perform the one exact Jenn-authorized real storyboard keyframe Runway canary and stop after that one submit attempt.

## Execution

- Provider: `runway`
- Endpoint: `POST /v1/image_to_video`
- X-Runway-Version: `2024-11-06`
- Model: `gen4.5`
- Selected artifact: `artifact_cbed1c1c-4293-450e-897e-3be49ddf7fb7`
- Duration: `2`
- Ratio: `720:1280`
- Submit calls: `1`
- Provider job id present: `false`
- Generated video artifact: `none`

## Failure

Runway returned sanitized provider evidence indicating insufficient credits. No retry was attempted.

## Evidence

- `data/reports/r3_8e_runway_real_storyboard_keyframe_canary_result.json`
- `data/reports/r3_8d_real_storyboard_keyframe_canary_prepare_result.json`
- `data/reports/secret_scan_result.json`

## Validation

- `npm run env:check` PASS
- `npm run provider:preflight` PASS
- `npm run typecheck` PASS
- `npm run test:m1` PASS
- `npm run secret:scan` PASS
- `git diff --check` PASS with CRLF normalization warning only

## Boundary

Exactly one Runway submit was attempted. No second submit, retry, RunningHub call, regeneration, batch generation, source overwrite, secret output, promptImage/base64 output, raw provider payload recording, push, tag, release, or deploy occurred.

## Next Safe Option

Do not perform another live Runway submit without a new exact current Jenn authorization phrase. A future retry should be a new task because the R3-8E single-submit attempt has already been used.
