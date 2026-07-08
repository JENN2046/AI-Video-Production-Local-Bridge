# NEXT_TASK.md

status: DONE

task_id: R3-9M_FINAL_ASSEMBLY_READINESS_CHECK

title: Final Assembly Readiness Check

priority: P0

lane: Final Assembly Readiness

project: AI Video Production Workspace Three Route Plan

depends_on: R3-9L_HUMAN_REGENERATED_CLIP_REVIEW_DECISION_APPLY

claimed_by: Codex R3-9M final assembly readiness check

claim_run_id: codex-20260708-183254-r3-9m

claimed_at: 2026-07-08T18:32:54+08:00

completed_by: Codex R3-9M final assembly readiness check

completed_at: 2026-07-08T18:36:22+08:00

result: PASS_READY_FOR_FINAL_ASSEMBLY_DRY_RUN

validation_result: PASS

## Goal

Confirm whether all required shots have accepted active generated clips and whether the project is ready for a separate local final assembly dry-run.

## Required Work

- Parse `data/reports/r3_9l_human_regenerated_clip_review_decision_apply_result.json` as the source of truth.
- Verify exactly 4 required shots are present: `g0_r1_shot_001`, `g0_r1_shot_002`, `g0_r1_shot_003`, and `g0_r1_shot_004`.
- Verify every required shot has an accepted regenerated clip artifact.
- Verify every accepted clip exists locally, has `role=generated_clip`, `status=active`, and ffprobe `PASS`.
- Build a deterministic assembly input manifest in storyboard order.
- Do not assemble the final video in this task.

## Boundary

Readiness check only. No provider call, regeneration, batch expansion, final assembly, `.env` or credential read, source overwrite, push, tag, release, or deploy.

## Result

- Verified 4 accepted regenerated clips are active generated_clip video artifacts.
- Verified each local MP4 exists and ffprobe returns PASS.
- Generated `data/reports/r3_9m_final_assembly_readiness_check_result.json`.
- Generated `data/reports/r3_9m_assembly_input_manifest.json`.
- Final assembly was not executed; next safe task is R3-9N dry run.
