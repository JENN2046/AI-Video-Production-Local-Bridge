# NEXT_TASK.md

Status: READY

Task: R3-9E_RUNNINGHUB_GENERATED_CLIP_REVIEW_PREP

Title: RunningHub Generated Clip Review Prep

Priority: P1

Lane: Generated Clip Review Prep

Project: AI Video Production Workspace Three Route Plan

Depends on: R3-9D_RUNNINGHUB_4_SHOT_SINGLE_PASS_LIVE_EXECUTION

## Goal

Prepare the human review surface for the four RunningHub-generated clips without changing review state or calling providers.

## Required Work

- Parse the R3-9D live result report as the source of truth.
- Prepare a local review package for the four generated RunningHub clips.
- Summarize generated clip artifacts, local mp4 paths, ffprobe results, source keyframe references, and prompt context.
- Create a human review table with `accept`, `reject`, and `regenerate_requested` decision fields.
- Do not call providers, regenerate clips, assemble final video, or mark review decisions.

## Acceptance

- Review package includes exactly 4 generated clips unless the source report is inconsistent.
- Each review entry records `shot_id`, generated `artifact_id`, local mp4 path, ffprobe status, duration summary, source storyboard image artifact, source keyframe path, prompt summary, and review decision placeholders.
- Review decision placeholders include `accept`, `reject`, `regenerate_requested`, notes, and reviewer fields without preselecting a decision.
- Package includes instructions for the next human review step without modifying app review status.
- Report records `network_call_attempted=false`, `runninghub_called=false`, `runway_called=false`, `provider_credits_consumed=false`, `real_video_generated=false`, `regeneration_performed=false`, `final_assembly_performed=false`, `secret_values_exposed=false`.
- No provider call, regeneration, batch expansion, final assembly, source overwrite, secret output, raw provider payload recording, signed URL recording, push, tag, release, or deploy occurs.

## Validation

- JSON/YAML parse for generated review package report
- `npm run typecheck`
- `npm run test:m1`
- `npm run secret:scan`
- `git diff --check`

## Stop Reason

Review prep only. Do not mutate review decisions, call providers, regenerate, assemble final video, push, tag, release, or deploy.
