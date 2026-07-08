# NEXT_TASK.md

Status: READY

Task: R3-9I_RUNNINGHUB_REGENERATION_AUTHORIZATION_PREP

Title: RunningHub Regeneration Authorization Prep

Priority: P0

Lane: RunningHub Regeneration Authorization Prep

Project: AI Video Production Workspace Three Route Plan

Depends on: R3-9H_SHOT_002_REPLACEMENT_DECISION

## Goal

Prepare a local-only, auditable RunningHub regeneration authorization package for the four rejected or regeneration-requested clips before any paid live execution.

## Required Work

- Parse `data/reports/r3_9f_human_clip_review_decision_apply_result.json`, `data/reports/r3_9g_regeneration_strategy_for_review_notes_result.json`, and `data/reports/r3_9h_shot_002_replacement_decision_result.json` as the source of truth.
- Build exactly one 4-shot regeneration authorization plan for `g0_r1_shot_001`, `g0_r1_shot_002`, `g0_r1_shot_003`, and `g0_r1_shot_004`.
- Use R3-9G revised strategy for SHOT_001, SHOT_003, and SHOT_004.
- Use R3-9H same-keyframe repair recommendation for SHOT_002.
- Record each shot's source storyboard image artifact, rejected generated clip artifact, revised prompt guidance, revised negative constraints, provider settings, output directory, and review focus.
- Draft a future exact authorization phrase for a later live RunningHub task.
- Do not read env files or credentials, call providers, upload media, submit jobs, poll status, download provider outputs, regenerate clips, batch-expand, assemble final video, mutate the frozen storyboard package, or overwrite source assets.

## Shot Requirements

- SHOT_001: food must be picked from inside the lunchbox and brought to the mouth; the lunchbox stays on the table.
- SHOT_002: use the same storyboard image artifact; forbid sighing, unhappy expression, slumped posture, disappointment, fatigue, and product-negative mood.
- SHOT_003: cap folds must become shallower and fabric must respond realistically to pull direction.
- SHOT_004: cap lighting, shadow direction, fabric texture, and contact shadow must remain physically consistent.

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

## Validation

- JSON parse for generated R3-9I authorization prep report
- `npm run typecheck`
- `npm run test:m1`
- `npm run secret:scan`
- `git diff --check`

## Boundary

Authorization prep only. No env or credential read, provider call, regeneration execution, final assembly, storyboard package mutation, source overwrite, push, tag, release, or deploy.
