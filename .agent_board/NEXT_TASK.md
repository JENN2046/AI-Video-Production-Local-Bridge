# NEXT_TASK.md

Status: DONE

Task: R3-8D_PREPARE_REAL_STORYBOARD_KEYFRAME_CANARY

Title: Prepare Real Storyboard Keyframe Canary

Priority: P0

Lane: Provider Input Preparation And Offline Canary Planning

Project: AI Video Production Workspace Three Route Plan

Claimed by: Codex R3-8D executor

Claim run ID: codex-20260707-145158-r3-8d

Claimed at: 2026-07-07T14:51:58+08:00

Completed by: Codex R3-8D executor

Completed at: 2026-07-07T14:51:58+08:00

Result: PASS_READY_FOR_USER_AUTHORIZATION

## Goal

Prepare a real storyboard keyframe canary input package for a future Runway Gen-4.5 single-submit authorization, without making any provider call.

## Selected Keyframe

- Shot: `SHOT_001`
- Artifact ID: `artifact_cbed1c1c-4293-450e-897e-3be49ddf7fb7`
- Source path: `A:\AI Video Production Workspace\data\imports\g0_r1_SHOT_001_IMAGE_ACCEPTED_WEBGPT.png`
- Storage URI: `A:\AI Video Production Workspace\data\media\artifacts\images\artifact_cbed1c1c-4293-450e-897e-3be49ddf7fb7.png`
- Mime: `image/png`
- Dimensions: `941x1672`
- Runway canary ratio: `720:1280`
- Duration: `2`
- Max submit calls: `1`

## Evidence

- `data/reports/r3_8d_real_storyboard_keyframe_canary_prepare_result.json`
- `data/reports/r3_8c_runway_submit_failure_triage_result.json`
- `data/reports/g0_r1_import_prep_result.json`
- `data/reports/secret_scan_result.json`

## Validation

- `npm run r3:8d:prepare` PASS
- `npm run typecheck` PASS
- `npm run test:m1` PASS
- `npm run secret:scan` PASS
- `git diff --check` PASS with CRLF normalization warning only

## Boundary

No Runway or RunningHub call was made during R3-8D. No upload, live retry, provider credit consumption, real video generation, secret output, promptImage/base64 output, raw provider payload recording, source overwrite, push, tag, release, or deploy occurred.

## Next Safe Option

`R3-8E_Runway_Real_Storyboard_Keyframe_Single-Submit_Authorization` may be prepared only after Jenn provides a new exact current authorization phrase. R3-8D does not authorize a live submit.
