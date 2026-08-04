# NEXT_TASK.md

Generated from `.agent_board/NEXT_TASK.json`.

## Current slot

- Task: `S3B-T2_PREPARE_ELIGIBLE_SHOT`
- Status: `BLOCKED`
- Ready: `false`
- Implementation authorized: `false`
- Current execution task: none
- Ready task count: `0`
- P0: `CURRENT_MAIN_REPEATABLE_PRODUCTION_LOOP`

This task is blocked at the approval boundary. The preserved substate is
`result: AWAITING_JENN_AUTHORIZATION`; it is not executable until Jenn gives
separate authorization. S3B-T3 remains a Jenn-local credential action, S3B-T4
is an offline-only readiness rerun and does not perform or claim a live price
preview; S4 requires separate paid/provider authorization and performs any
credentialed online price preflight immediately before submit.

## Current repository truth

- `main`: `3c502e23f884d1b062210321d84848b45c7bb344`
- PR #108: `MERGED` as `808d9334a49def7ce858f7c6138af75fed392c5b`.
- PR #109: `CLOSED_UNMERGED_RETIRED`; head and branch retained; no source
  commit accepted into main.
- PR #110: `MERGED` as `00c8ed458144f03d4b0e1389d4de6dbf8005ed9a`.
- PR #111: `MERGED` as `770f3dff342874e90788d0f475c4cff49136e114`.
- PR #112: `MERGED` as `55553cbf2f9bc387beb255cebb8b36bcb2deadbf`.
- PR #113: `OPEN_READY` closeout candidate; task-board current head is
  intentionally `VERIFY_BEFORE_MERGE`. Last validated head was
  `f8ed0b90c956cb3ba60bb8bc6038e05b3865eabb` against base
  `3c502e23f884d1b062210321d84848b45c7bb344`; exact-head review and merge are
  still pending and no merge is claimed.
- PR #114: `MERGED` as `3c502e23f884d1b062210321d84848b45c7bb344`; its valid P2
  behavior-test finding remains `DEFERRED_UNRESOLVED` (thread `3708908011`).
- PR #115: `CLOSED_UNMERGED`; head `866accc40ea36c7d8098048ea911eb6e6b0a376b`,
  branch retained; final fixture CI failure was
  `DIRECTOR_BRIDGE_RUNTIME_SMOKE_FIXTURE_STAGING_UNCLASSIFIED`.

Code/CI status does not imply a new external Provider, Bridge, database,
Snapshot, Memory, deployment or public acceptance.

## Recovery boundary

`S3B-T1B-R1_MINIMAL_BOUNDED_STAGE_REPLACEMENT` is
`DEFERRED_NOT_REQUIRED_FOR_S4`, `ready: false`,
`implementation_authorized: false`, `blocks_s4: false`. PR #114's P2 is not
claimed fixed; PR #115 did not prove a production runtime defect.

During S4, verified-Blob recovery is governed by:

- automatic use: forbidden;
- explicit recovery use: forbidden;
- integrity failure: `STOP_AND_ENTER_MANUAL_RECONCILIATION`;
- Provider resubmit on integrity failure: forbidden;
- automatic stage cleanup: forbidden.

## S3B/S4 sequence

| Task | Status |
|---|---|
| `S3B-T1_BOUND_PROVIDER_POLLING` | `DONE_IN_MAIN` |
| `S3B-T1A_MANUAL_RECONCILIATION_STATE_COHERENCE` | `DONE_IN_MAIN` |
| `S3B_VERIFIED_BLOB_RECOVERY` | `DONE_IN_MAIN_WITH_LATE_STAGE_ACCUMULATION_FINDING` |
| `S3B-T1B_PR109` | `RETIRED_UNMERGED` |
| `S3B-T1B-R1_MINIMAL_BOUNDED_STAGE_REPLACEMENT` | `DEFERRED_NOT_REQUIRED_FOR_S4` |
| `S3B-T2_PREPARE_ELIGIBLE_SHOT` | `BLOCKED` (`result: AWAITING_JENN_AUTHORIZATION`) |
| `S3B-T3_CONFIGURE_RUNNINGHUB_CREDENTIAL` | `AWAITING_JENN_LOCAL_ACTION` |
| `S3B-T4_RERUN_CANARY_READINESS` | `BLOCKED_BY_T2_AND_T3` |
| `S4-T1_REAL_SINGLE_SHOT_CURRENT_PATH` | `BLOCKED_UNAUTHORIZED` |

Peripheral expansion remains frozen. Legacy `/mcp` and Dedicated Director
remain rollback-only. No task is `READY`.
