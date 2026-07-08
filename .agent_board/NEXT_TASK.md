# NEXT_TASK.md

Status: READY

Task: R3-9F_HUMAN_CLIP_REVIEW_DECISION_APPLY

Title: Human Clip Review Decision Apply

Priority: P0

Lane: Human Clip Review Decision Apply

Project: AI Video Production Workspace Three Route Plan

Depends on: R3-9E_RUNNINGHUB_GENERATED_CLIP_REVIEW_PREP

## Goal

Apply Jenn's human review decisions for the four RunningHub-generated clips without triggering regeneration or assembly.

## Required Work

- Parse Jenn-filled review decisions from `data/reports/r3_9e_runninghub_generated_clip_review_table.md`.
- Apply human review decisions to the local app review state and decision report.
- Preserve reviewer notes exactly, including the updated SHOT_002 reject reason.
- Do not call providers, regenerate clips, assemble final video, or overwrite source assets.

## Acceptance

- The review table is parsed as the source of truth from the current working tree.
- Exactly 4 shot decisions are parsed, with exactly one decision per shot.
- Decision summary is 0 `accept`, 1 `reject`, and 3 `regenerate_requested`.
- `SHOT_001` is recorded as `regenerate_requested` with Jenn's food-from-lunchbox eating-action note.
- `SHOT_002` is recorded as `reject` with Jenn's note that sighing/unhappy expression hurts purchase intent.
- `SHOT_003` is recorded as `regenerate_requested` with Jenn's cap-fold/fabric realism note.
- `SHOT_004` is recorded as `regenerate_requested` with Jenn's cap lighting realism note.
- Generated decision-apply report records all source `generated_clip` artifact IDs and review decisions.
- Local review state is updated only for review decisions; no provider generation, regeneration, final assembly, or media overwrite occurs.

## Validation

- JSON parse for generated decision-apply report
- `npm run typecheck`
- `npm run test:m1`
- `npm run secret:scan`
- `git diff --check`

## Stop Reason

Review decision apply only. Do not call providers, regenerate, assemble final video, overwrite source assets, push, tag, release, or deploy.
