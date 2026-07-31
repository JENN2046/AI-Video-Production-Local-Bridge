# NEXT_TASK.md

Generated from `.agent_board/NEXT_TASK.json`.

## Current slot

- Task: `S3-T1_CURRENT_WORKBENCH_CANARY_READINESS`
- Status: `DONE`
- Terminal result: `BLOCKED_BY_S3_FINDING`
- Current execution task: none
- Ready task count: `0`
- P0: `CURRENT_MAIN_REPEATABLE_PRODUCTION_LOOP`

S3 is terminal history. It is not `READY`, and no current task may be claimed
automatically.

## Publication state

- PR #108: `MERGED_WITH_LATE_P2_FOLLOWUP` by squash as
  `808d9334a49def7ce858f7c6138af75fed392c5b`.
- PR #109: `DRAFT_PR_AWAITING_REVIEW`; base `main`, head
  `codex/blob-recovery-staging-reconciliation`, implementation commit
  `528aee4020d4be15a5fc5278de2f8c8abb20c637`, review remediation commit
  `e5c4211c11d5bad1f06e7f5422f1b1aa678a5b7f`, and root-identity remediation
  `193b1077d67dd8872831e8fe7646d8879d4947f7`.
- PR #109 is not authorized for Ready or merge. Exact-head Windows CI and
  Codex review must be repeated after the review remediation.
- PR #108's late P2 thread remains unresolved until the remediation is merged
  and verified.

## Superseded PR #108 preparation detail

The following records the pre-merge review sequence and is not current
operational state.

- PR #106: `MERGED` by squash as
  `b3a108abc8728e89259d0d953e1c638b9ca482ea`.
- PR #107: `CLOSED_SUPERSEDED_UNMERGED`; its branch remains retained.
- Before merge, PR #108 was `DRAFT_AWAITING_FINAL_EXACT_HEAD_CI_AND_REVIEW`;
  base `main`, head
  `codex/s3b-provider-polling-restack`; not authorized for merge or
  ready-for-review. The narrow verified-Blob recovery and the follow-up
  archival, state-truth, committed-replacement restart, startup clock-rollback
  scheduling, inherited-lease takeover and repeated-attachment recovery-state
  fixes are in the candidate. Review `4825747733` additionally found that an
  old recovery blocked a valid switch to a new Provider task. Implementation
  `19f026f8f40f82203a3967a7f449152b272743cf` now validates and atomically
  archives the old recovery Artifacts before clearing the recovery and
  attaching the new task; same-task recovery remains preserved. Exact-head CI
  then passed, but review `4825989650` found that a different Intent could use
  the reserved local recovery identity before a replacement Artifact existed.
  Candidate `2847a34e8ee638ff1ca46824bc938f19acd870ff` globally rejects the
  `local_recovery_*` namespace at manual task attachment and has a cross-Intent
  regression. Head `528f33a4efc4024b49c2974374563f52ffe9195d` then passed
  Windows CI run `30610318191`, but review `4826019679` still exposed an
  unclosed abandon path and exact-head review `4826282464` found an
  unrecoverable two-link crash window in Blob placement. Implementation
  `aa9b8912d18dc11b6718e5bfed00e1d9c6ee35f9` now atomically retires recovery
  Artifacts before abandon and normalizes only the provably owned generated
  staged/target hard-link pair; unowned hard links remain rejected. Head
  `e5cb5d8320f44f59a51b453167b7eb1732a528e2` passed CI run `30613190531`,
  but exact-head review `4826557538` found that rollback detection still lost
  fractional seconds. Candidate `357b08718e2226a613b7613ede234e4c3cc337b7`
  now uses fractional `julianday` comparisons in scheduler selection and lease
  claim. Its startup regression proves a same-second 900 ms rollback with a
  future inherited lease and zero Provider calls. All required local gates
  pass. Head `1f49bc32164d8efee82ce12ebb2cc1e88c2b6df6` then passed CI run
  `30615172450`, but exact-head review `4826803376` found that a due persisted
  deadline could still wait for a crashed worker's five-minute lease after
  wall time caught up, and that the 900 ms regression depended on real
  scheduling speed. Candidate
  `2cce0f8af8063228c89237a946553ea62e8503d2` now lets a validated due
  deadline preempt the inherited lease, wakes at the deadline, and uses the
  injected scheduler clock. Fixed-clock rollback and expired-deadline
  regressions both reach `PROVIDER_POLL_TIMEOUT` with zero Provider calls.
  Workbench V2 is 68/68 and all broader local gates pass. The prior CI/review
  is non-transferable; only new final exact-head CI/review evidence may
  support a later Jenn decision.

## S3B follow-ups

| Task | Local status | Repository/current status | Gate |
|---|---|---|---|
| `S3B-T1_BOUND_PROVIDER_POLLING` | `PASS` | `DONE_IN_MAIN` via PR #108 | None for repository publication |
| `S3B-T1A_MANUAL_RECONCILIATION_STATE_COHERENCE` | `PASS` | `DONE_IN_MAIN` via PR #108 | None for repository publication |
| `S3B_VERIFIED_BLOB_STORAGE_RECOVERY` | `PASS` | `DONE_IN_MAIN_WITH_REMEDIATION_PENDING` | Wait for PR #109 review/merge decision |
| `S3B-T1B_RECOVER_ORPHANED_BLOB_STAGING` | `PASS_LOCAL_AFTER_REVIEW_FIX` | `DRAFT_PR_AWAITING_REVIEW` in PR #109 | New exact-head CI and Codex review |
| `S3B-T2_PREPARE_ELIGIBLE_SHOT` | — | `AWAITING_JENN_AUTHORIZATION` | Business-state write not authorized |
| `S3B-T3_CONFIGURE_RUNNINGHUB_CREDENTIAL` | — | `AWAITING_JENN_LOCAL_ACTION` | Secret operation not authorized |
| `S3B-T4_RERUN_CANARY_READINESS` | — | `BLOCKED` | Waits for T2, T3 and reviewed candidate code |

`S4-T1_REAL_SINGLE_SHOT_CURRENT_PATH` is `BLOCKED_UNAUTHORIZED`.

## Frozen and rollback-only surfaces

- `FROZEN`: Media Gateway promotion/expansion, Memory and automatic Saveback,
  multi-user/second-user, automatic Snapshot, Windows automatic startup,
  WebM/broad formats, new OAuth experiments, Full WebGPT externalization and
  Provider-platform expansion.
- `ROLLBACK_ONLY`: legacy `/mcp` and Dedicated Director route.

Media Gateway and Director Bridge do not block S3 or S4.
