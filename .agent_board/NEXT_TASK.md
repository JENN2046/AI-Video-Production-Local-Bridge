# NEXT_TASK.md

Status: DONE

Task: R3-9H_SHOT_002_REPLACEMENT_DECISION

Title: SHOT 002 Replacement Decision

Priority: P1

Lane: Rejected Shot Decision

Project: AI Video Production Workspace Three Route Plan

Depends on: R3-9G_REGENERATION_STRATEGY_FOR_REVIEW_NOTES

## Claim

- claimed_by: Codex R3-9H shot 002 decision
- run_id: codex-20260708-164524-r3-9h
- claimed_at: 2026-07-08T16:45:24+08:00

## Goal

Decide the safe local next path for rejected `g0_r1_shot_002` before any final assembly or provider regeneration.

## Required Work

- Parse `data/reports/r3_9f_human_clip_review_decision_apply_result.json` as the source of truth.
- Focus only on `g0_r1_shot_002` and Jenn's reject note.
- Compare rework, replace, and remove/resequence paths.
- Record tradeoffs, blocker status, and a recommended next path.
- Do not call providers, execute regeneration, mutate the frozen storyboard package, assemble final video, or overwrite source assets.

## Validation

- JSON parse for generated SHOT_002 decision report
- `npm run typecheck`
- `npm run test:m1`
- `npm run secret:scan`
- `git diff --check`

## Boundary

Decision only. Do not call providers, execute regeneration, assemble final video, mutate storyboard package, overwrite source assets, push, tag, release, or deploy.

## Result

- completed_by: Codex R3-9H shot 002 decision
- completed_at: 2026-07-08T16:51:32+08:00
- result: PASS_SHOT_002_DECISION_READY
- validation_result: PASS
- report: data/reports/r3_9h_shot_002_replacement_decision_result.json
- recommended_next_path: R3-9I_SHOT_002_SAME_KEYFRAME_REGENERATION_PREP
- commit: d20e63f
