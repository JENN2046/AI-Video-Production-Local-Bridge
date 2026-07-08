# NEXT_TASK.md

status: DONE

task_id: R3-9N_FINAL_VIDEO_ASSEMBLY_DRY_RUN

title: Final Video Assembly Dry Run

priority: P0

lane: Final Assembly Dry Run

project: AI Video Production Workspace Three Route Plan

depends_on: R3-9M_FINAL_ASSEMBLY_READINESS_CHECK

claimed_by: Codex R3-9N final video assembly dry run

claim_run_id: codex-20260708-184207-r3-9n

claimed_at: 2026-07-08T18:42:07+08:00

completed_by: Codex R3-9N final video assembly dry run

completed_at: 2026-07-08T18:42:54+08:00

result: PASS_READY_FOR_LOCAL_FINAL_ASSEMBLY_EXECUTION

validation_result: PASS

## Goal

Validate the exact local final assembly plan, output path, ffmpeg inputs, and no-overwrite gate before writing any final video.

## Required Work

- Parse `data/reports/r3_9m_final_assembly_readiness_check_result.json`.
- Require R3-9M result `PASS_READY_FOR_FINAL_ASSEMBLY_DRY_RUN`.
- Build the final assembly order from the R3-9M manifest.
- Prepare a local ffmpeg command plan without executing final output creation.
- Define isolated output directory and final video filename.
- Verify output path does not overwrite any source asset, imported image, generated clip, or previous final master.
- Do not create the final video in this task.

## Boundary

Dry-run only. No final video write, provider call, regeneration, batch expansion, `.env` or credential read, source overwrite, push, tag, release, or deploy.

## Result

- Generated `data/reports/r3_9n_final_video_assembly_dry_run_result.json`.
- Planned output path: `data/media/artifacts/final/r3-9o-final-video/ryan_lunch_break_skullcap_final_r3_9o.mp4`.
- Confirmed 4 input paths exist and no-overwrite gate passes.
- Final video was not written.
