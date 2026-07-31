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
- PR #107: `SUPERSEDED` and unmerged; its branch remains retained.
- PR #108: `DRAFT_AWAITING_REVIEW_OR_MERGE`; base `main`, head
  `codex/s3b-provider-polling-restack`; not authorized for merge or
  ready-for-review. The narrow verified-Blob recovery and the follow-up
  archival, state-truth, committed-replacement restart, startup clock-rollback
  scheduling and repeated-attachment recovery-state fixes are in the
  candidate. Implementation commit
  `4e244592b96881d1ea1088dcbeba940262e4c155` is locally validated; only
  final exact-head CI/review evidence may support a later Jenn decision.

## S3B follow-ups

| Task | Local status | Repository/current status | Gate |
|---|---|---|---|
| `S3B-T1_BOUND_PROVIDER_POLLING` | `PASS` | `AWAITING_PR108_REVIEW_OR_MERGE` in Draft PR #108 | Not merged to `main` |
| `S3B-T1A_MANUAL_RECONCILIATION_STATE_COHERENCE` | `PASS` | `AWAITING_PR108_REVIEW_OR_MERGE` in Draft PR #108 | Not merged to `main` |
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
