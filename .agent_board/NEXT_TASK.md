# NEXT_TASK.md

Status: READY

Task: R3-8J_RECEIPT_FIX

Title: R3-8J RunningHub Duration Failure Receipt Fix

Priority: P0

Lane: Provider Evidence Receipt

Project: AI Video Production Workspace Three Route Plan

Depends on: R3-8J_RUNNINGHUB_REAL_KEYFRAME_SINGLE_SUBMIT_CANARY

## Goal

Repair the R3-8J audit chain before any further RunningHub retry planning.

## Required Work

- Backfill R3-8J commit `1f68c36` into the R3-8J report, backlog, and ledger where applicable.
- Record that RunningHub received exactly one upload and exactly one submit.
- Record that `query_call_count=0`, `provider_job_id_present=false`, and no channel/output URL exists.
- Record the provider-side duration contract evidence: `duration=3` is below minimum value `6`.
- Leave R3-8L as the next eligible offline duration-contract repair task.

## Acceptance

- No network call is attempted.
- No RunningHub upload, submit, query, poll, or output download is attempted.
- No Runway call is attempted.
- No provider credits are consumed.
- No real video is generated.
- No secret values, signed URLs, raw provider payloads, or source assets are exposed or overwritten.

## Validation

- JSON parse for updated report files
- `npm run secret:scan`
- `git diff --check`

## Stop Reason

Stop before any live RunningHub upload, submit, status query, provider output download, provider credit consumption, or real video generation. Any new live provider action requires a future exact current Jenn authorization phrase.
