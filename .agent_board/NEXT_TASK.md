# NEXT_TASK.md

Generated from `.agent_board/NEXT_TASK.json`.

## Current slot

- Task: `S3B-T2_PREPARE_ELIGIBLE_SHOT`
- Status: `BLOCKED`
- Ready: `false`
- Implementation authorized: `false`
- Read-only execution authorized: `true`
- Current execution task: none
- Ready task count: `0`
- P0: `CURRENT_MAIN_REPEATABLE_PRODUCTION_LOOP`

Jenn authorized the read-only offline T2 scan, but the task stopped before any
business database access because current `main` has no existing pure read-only
T2 executable entry. The stable result is
`BLOCKED_T2_EXECUTABLE_PATH_MISSING`. Existing modules expose the individual
read-only primitives, but this task forbids assembling a temporary scanner or
adding source code. T3 was not loaded and S4 remains unauthorized.

## Next authorized task

- Task: `S3B-T2-R1_IMPLEMENT_READ_ONLY_EXECUTABLE_ENTRY`
- Authorization: `GRANTED_CONDITIONAL`
- Implementation authorized: `true`
- Loaded: `false`
- Ready: `false`
- Execution started: `false`

All three activation conditions are required: PR #117 merged, post-merge main
CI green, and a clean worktree. Before that gate, R1 is not the current slot
and must not start. After the gate, R1 may be loaded and started without
another Jenn implementation authorization. Jenn's remaining decision is only
whether to authorize the separate PR #117 squash merge or keep the PR unmerged
and retain the current executable-missing block.

The verified T2 code baseline is
`main@90b1d688d1cad301d63aacf8e01acecf0b28eb1f`; Windows CI run
`30961478222` passed. Older repository-truth material below remains historical
context and is not rewritten by this task.

## Historical repository snapshot — superseded

**HISTORICAL SNAPSHOT ONLY.**
Do not use this section for the current baseline, task loading,
authorization, queue, merge, or execution decisions.
The authoritative current task state is the structured section above.

Historical baseline at that time:
`main@3c502e23f884d1b062210321d84848b45c7bb344`

- PR #108: `MERGED` as `808d9334a49def7ce858f7c6138af75fed392c5b`.
- PR #109: `CLOSED_UNMERGED_RETIRED`; head and branch retained; no source
  commit accepted into main.
- PR #110: `MERGED` as `00c8ed458144f03d4b0e1389d4de6dbf8005ed9a`.
- PR #111: `MERGED` as `770f3dff342874e90788d0f475c4cff49136e114`.
- PR #112: `MERGED` as `55553cbf2f9bc387beb255cebb8b36bcb2deadbf`.
- PR #113: `OPEN_READY` closeout candidate; task-board current and candidate
  heads are symbolic `VERIFY_BEFORE_MERGE` until the current PR head is
  re-read and revalidated. Last-reviewed and last-passed head is
  `16babfd9650184183acef959244c2d765ea53dcc` against base
  `3c502e23f884d1b062210321d84848b45c7bb344`; this is historical evidence, not
  a claim about the current PR head. Earlier `f8ed0b9` is retained as a
  reviewed-with-finding head, not a validated/pass head. No merge is claimed.
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
| `S3B-T2_PREPARE_ELIGIBLE_SHOT` | `BLOCKED` (`result: BLOCKED_T2_EXECUTABLE_PATH_MISSING`) |
| `S3B-T2-R1_IMPLEMENT_READ_ONLY_EXECUTABLE_ENTRY` | `GRANTED_CONDITIONAL`; not loaded, not ready, not started |
| `S3B-T3_CONFIGURE_RUNNINGHUB_CREDENTIAL` | `AWAITING_JENN_LOCAL_ACTION` |
| `S3B-T4_RERUN_CANARY_READINESS` | `BLOCKED_BY_T2_AND_T3` |
| `S4-T1_REAL_SINGLE_SHOT_CURRENT_PATH` | `BLOCKED_UNAUTHORIZED` |

Peripheral expansion remains frozen. Legacy `/mcp` and Dedicated Director
remain rollback-only. No task is `READY`.
