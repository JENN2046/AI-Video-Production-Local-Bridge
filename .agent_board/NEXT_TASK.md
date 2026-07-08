# NEXT_TASK

task_id: R3-9P_FINAL_VIDEO_REVIEW_PACKAGE
status: DONE
priority: P1
lane: Final Video Review
project: AI Video Production Workspace Three Route Plan
title: Final Video Review Package
claimed_by: Codex R3-9P final video review package
claim_run_id: codex-20260708-185423-r3-9p
claimed_at: 2026-07-08T18:54:23+08:00
completed_by: Codex R3-9P final video review package
completed_at: 2026-07-08T18:57:20+08:00
result: PASS_FINAL_VIDEO_REVIEW_PACKAGE_READY
validation_result: PASS
source_report: data/reports/r3_9o_final_video_assembly_execution_result.json
report_path: data/reports/r3_9p_final_video_review_package_result.json
review_table_path: data/reports/r3_9p_final_video_review_table.md

## Goal

Prepare a local Chinese review package for the assembled final video so Jenn can decide final creative approval separately.

## Scope

- Parse `data/reports/r3_9o_final_video_assembly_execution_result.json`.
- Include the final video path, final video artifact id, ffprobe summary, source clip list, and assembly report link.
- Generate a Chinese final-video review table with placeholders for `accept`, `reject`, and `revision_requested`.
- State that this package does not publish, deploy, upload, or mark final creative approval.

## Boundary

- Review package only.
- No provider call, regeneration, batch expansion, `.env` or credential read, source overwrite, push, tag, release, deploy, publish, or final creative approval.

## Result

- Generated `data/reports/r3_9p_final_video_review_package_result.json`.
- Generated `data/reports/r3_9p_final_video_review_table.md`.
- Included final video `data/media/artifacts/final/r3-9o-final-video/ryan_lunch_break_skullcap_final_r3_9o.mp4`.
- Final creative approval remains unrecorded.
