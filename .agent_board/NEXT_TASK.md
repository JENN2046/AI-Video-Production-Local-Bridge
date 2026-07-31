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

- PR #106: `MERGED` by squash as
  `b3a108abc8728e89259d0d953e1c638b9ca482ea`.
- PR #107: `OPEN_DRAFT_SUPERSEDED` and unmerged; its branch remains retained.
- PR #108: `DRAFT_AWAITING_FINAL_EXACT_HEAD_CI_AND_REVIEW`; base `main`, head
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
  regression. Local validation passed, but prior CI is non-transferable. Only
  new final exact-head CI/review evidence may support a later Jenn decision.

## S3B follow-ups

| Task | Local status | Repository/current status | Gate |
|---|---|---|---|
| `S3B-T1_BOUND_PROVIDER_POLLING` | `PASS` | `BLOCKED_BY_PR108_REVIEW_FINDING` in Draft PR #108 | New exact-head CI/review required |
| `S3B-T1A_MANUAL_RECONCILIATION_STATE_COHERENCE` | `PASS` | `BLOCKED_BY_PR108_REVIEW_FINDING` in Draft PR #108 | New exact-head CI/review required |
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
