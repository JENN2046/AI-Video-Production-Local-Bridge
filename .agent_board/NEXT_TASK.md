# NEXT_TASK.md

Status: READY

Task: R3-8O_RECEIPT_FIX_R1

Title: R3-8O Receipt Fix R1

Priority: P0

Lane: Provider Evidence Receipt

Project: AI Video Production Workspace Three Route Plan

Depends on: R3-8O_RUNNINGHUB_ENTERPRISE_KEY_6S_SINGLE_SUBMIT_CANARY

## Goal

Repair the R3-8O audit chain before provider path closeout.

## Required Work

- Backfill R3-8O live canary commit `99dd716`.
- Backfill R3-8O receipt commit `c746b08`.
- Update only receipt metadata, task board state, and local audit ledger where applicable.
- Keep R3-8K as `FOLLOW_UP` and make it depend on `R3-8O_RECEIPT_FIX_R1`.

## Acceptance

- No network call is attempted.
- No RunningHub upload, submit, query, poll, or output download is attempted.
- No Runway call is attempted.
- No provider credits are consumed.
- No real video is generated.
- No secret values, signed URLs, raw provider payloads, or source assets are exposed or overwritten.

## Validation

- JSON parse for updated report/state files
- `npm run secret:scan`
- `git diff --check`

## Stop Reason

Stop before R3-8K closeout or any new live provider call. This task is receipt repair only.
