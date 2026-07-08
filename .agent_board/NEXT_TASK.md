# NEXT_TASK.md

Status: DONE

Task: R3-9J_RUNNINGHUB_REGENERATION_SINGLE_PASS_LIVE_EXECUTION

Title: RunningHub Regeneration Single-Pass Live Execution

Priority: P0

Lane: RunningHub Regeneration Live Execution

Project: AI Video Production Workspace Three Route Plan

Depends on: R3-9I_RUNNINGHUB_REGENERATION_AUTHORIZATION_PREP

## Claim

- claimed_by: Codex R3-9J RunningHub regeneration live execution
- run_id: codex-20260708-174525-r3-9j
- claimed_at: 2026-07-08T17:45:25+08:00

## Goal

Execute the authorized 4-shot RunningHub regeneration run exactly once, with sanitized local evidence and no retry or batch expansion.

## Budget Boundary

- provider: `runninghub`
- route: `rhart-video-g/image-to-video`
- duration: `6` seconds per shot
- aspectRatio: `9:16`
- resolution: `480p`
- max_upload_calls_total: `4`
- max_submit_calls_total: `4`
- max_upload_calls_per_shot: `1`
- max_submit_calls_per_shot: `1`
- no retry
- no second submit
- no Runway fallback
- no batch expansion
- stop on first upload or submit failure

## Boundary

- Authorized to read `.env.local` only for `RUNNINGHUB_API_KEY`; secret values must not be printed or recorded.
- Authorized to call RunningHub for the 4 planned regeneration shots only.
- No retry, second submit, Runway fallback, batch expansion, final assembly, storyboard package mutation, source overwrite, secret output, raw provider payload recording, signed URL recording, push, tag, release, or deploy.

## Validation

- JSON parse for generated R3-9J live report
- `npm run typecheck`
- `npm run test:m1`
- `npm run secret:scan`
- `git diff --check`

## Result

- completed_by: Codex R3-9J RunningHub regeneration live execution
- completed_at: 2026-07-08T17:54:52+08:00
- result: PASS_LIVE_4_SHOT_REGENERATION_COMPLETED
- validation_result: PASS
- report: data/reports/r3_9j_runninghub_regeneration_single_pass_live_execution_result.json
- generated_artifacts:
  - g0_r1_shot_001: artifact_37d18f76-ec61-4b5d-8f5c-acca2b4ba203
  - g0_r1_shot_002: artifact_eeef12a7-9533-4172-beaa-6c25b91415f7
  - g0_r1_shot_003: artifact_20b1ee68-0b75-4fc1-96a8-93f36de31d5a
  - g0_r1_shot_004: artifact_263a2344-5154-4981-bfe4-120571effb3e
- commit: PENDING_LOCAL_COMMIT
