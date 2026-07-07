# NEXT_TASK.md

Status: DONE

Task: R3-8L_RUNNINGHUB_DURATION_CONTRACT_REPAIR_DRY_RUN

Title: RunningHub Duration Contract Repair Dry Run

Priority: P0

Lane: Provider Contract Repair

Project: AI Video Production Workspace Three Route Plan

Depends on: R3-8J_RECEIPT_FIX

## Result

`PASS_DURATION_CONTRACT_REPAIRED`

## Completed Work

- Encoded RunningHub minimum duration as `6` for `rhart-video-g/image-to-video`.
- Added the local fail-fast guard so `duration_seconds=3` is blocked before upload or submit request construction.
- Updated request-plan builders and authorization-prep logic to use `duration_seconds=6` for this RunningHub model.
- Added tests proving `duration_seconds=3` is blocked locally.
- Produced `data/reports/r3_8l_runninghub_duration_contract_repair_dry_run_result.json`.

## Validation

- `npm run r3:8l:dry-run` PASS
- `npm run typecheck` PASS
- `npm run test:m1` PASS
- `npm run secret:scan` PASS
- `git diff --check` PASS_WITH_CRLF_WARNINGS_ONLY

## Stop Reason

Stop before `R3-8M_RUNNINGHUB_6S_SINGLE_SUBMIT_CANARY`. Any live RunningHub upload, submit, status query, output download, provider credit consumption, or real video generation requires a fresh exact current Jenn authorization phrase with `duration_seconds=6`.
