# NEXT_TASK.md

Generated from `.agent_board/NEXT_TASK.json`.

## Current slot

- Task: `S3B-T1B-R1_MINIMAL_BOUNDED_STAGE_REPLACEMENT`
- Status: `AWAITING_JENN_AUTHORIZATION`
- Ready: `false`
- Implementation authorized: `false`
- Current execution task: none
- Ready task count: `0`
- P0: `CURRENT_MAIN_REPEATABLE_PRODUCTION_LOOP`

The task is prepared only. Do not claim, implement, test, or publish it until
Jenn gives separate authorization.

## Current repository truth

- `main`: `55553cbf2f9bc387beb255cebb8b36bcb2deadbf`
- PR #108: `MERGED` as
  `808d9334a49def7ce858f7c6138af75fed392c5b`; S3B-T1/T1A and verified-Blob
  recovery are in main, with a late staged-file accumulation finding still
  open for replacement.
- PR #109: `CLOSED_UNMERGED_RETIRED`; head and branch retained as research
  evidence; no source commit accepted into main.
- PR #110: `MERGED` as `00c8ed458144f03d4b0e1389d4de6dbf8005ed9a`.
- PR #111: `OPEN_DRAFT` with failed readonly Media Gateway CI; unchanged.
- PR #112: `MERGED` as `55553cbf2f9bc387beb255cebb8b36bcb2deadbf`.

## Prepared replacement boundary

The prepared replacement is limited to:

- one deterministic stage per physical target;
- non-destructive generic startup;
- explicit human recovery convergence;
- fail-closed unsafe or unproven entries.

It must not add cross-database target mutexes, target authority, a stage
ownership database, companion hard-link protocols or multi-writer shared media
roots. The source target is current `main`; PR #109 must not be cherry-picked.

## S3B and S4 state

| Task | Status |
|---|---|
| `S3B-T1_BOUND_PROVIDER_POLLING` | `DONE_IN_MAIN` |
| `S3B-T1A_MANUAL_RECONCILIATION_STATE_COHERENCE` | `DONE_IN_MAIN` |
| `S3B_VERIFIED_BLOB_RECOVERY` | `DONE_IN_MAIN_WITH_LATE_STAGE_ACCUMULATION_FINDING` |
| `S3B-T1B_PR109` | `RETIRED_UNMERGED` |
| `S3B-T1B-R1_MINIMAL_BOUNDED_STAGE_REPLACEMENT` | `AWAITING_JENN_AUTHORIZATION` |
| `S3B-T2_PREPARE_ELIGIBLE_SHOT` | `AWAITING_JENN_AUTHORIZATION` |
| `S3B-T3_CONFIGURE_RUNNINGHUB_CREDENTIAL` | `AWAITING_JENN_LOCAL_ACTION` |
| `S3B-T4_RERUN_CANARY_READINESS` | `BLOCKED_BY_T2_AND_T3` |
| `S4-T1_REAL_SINGLE_SHOT_CURRENT_PATH` | `BLOCKED_UNAUTHORIZED` |

Peripheral expansion remains frozen. Legacy `/mcp` and Dedicated Director
remain rollback-only.
