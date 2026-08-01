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
- PR #109: `OPEN_READY`; base `main`, head
  `codex/blob-recovery-staging-reconciliation`, implementation commit
  `528aee4020d4be15a5fc5278de2f8c8abb20c637`, review remediation commit
  `e5c42113c73ba35a2c307eb0890dcd7d3be1216f`, and root-identity remediation
  `193b1077d67dd8872831e8fe7646d8879d4947f7`, and deterministic-stage
  whitelist candidate `0ff40f085368658887d3a77315d1eb7f51124c3f`. The prior process-local
  canonical-database gate `27058e32f5339359d15b876dc25375046075eb18` is
   superseded by `35122cd405f42bc627ae73d121f5a3dd14f3edbe`, which removes the global
   deterministic-stage startup sweep entirely. Candidate `e3704cb` adds an
   exact-storage-target SQLite mutex shared across independent database files;
   follow-up `20f029e` normalizes its Windows path identity to match
   case-insensitive path equality. Follow-up `95d8b29` also normalizes the
   deterministic stage and adds persistent target authority for root/digest
   conflicts plus memory-only SQLite journaling with sidecar rejection.
   Follow-up `84e4ef1` atomically publishes that authority from a fully written
   and fsynced unique temp, so a pre-publication hard exit cannot block retry.
   Follow-up `cc6dd87` canonicalizes the physical target for mutex, authority
   and stage identity and removes database-local Blob ids from the shared stage.
   Windows CI run `30684275229` exposed quoted `cmd` output in the 8.3 test
   helper; `94bd81b` normalizes that output and requires a fresh exact-head run.
   Run `30684654830` retained escaped quotes; `43e5519` extracts only the
   absolute drive path. Run `30685017849` passed both jobs and exact-head review
   reported no new issues, but thread audit exposed two older P2s. Follow-up
   `22c9e24` moves authority publication after all read-only validation and
   places deterministic staging beside the physical target. Follow-ups
   `0982c61` and `d7fbb21` narrow the missing-target DOS alias guard to the
   real SFN set. Head `7d2fb64` passed CI run `30688801572` attempt 3, but the
   complete review/thread audit found remaining authority-order, unowned-stage,
   mutex-ownership and eager-`node:sqlite` gaps. Implementation `15b3bed`
   validates recovery entries before authority publication, requires prior
   matching authority for a single-link deterministic stage, validates the
   bounded SQLite ownership header before opening the mutex, and lazily loads
   this module's SQLite dependency. Head `ed42b2b` passed CI run `30692274008`,
   but exact-head review found a first-use activation-root `EEXIST` race.
   Follow-up `d8c6768` makes directory initialization concurrency-safe while
   preserving the full post-create path checks. Head `5a80ed8` passed both jobs
   on run `30693297405`; its complete review found three further ownership gaps.
   Follow-up `f2c31c5` requires an exact app-created stage-owner hard-link pair,
   initializes the mutex through the continuously held exclusive descriptor,
   and excludes the current validated source from legacy-stage cleanup. Exact-head
   review then found two cleanup-order gaps; follow-up `1710c41` authenticates
   the descriptor-bound authority or mutex final before removing only its exact
   same-inode temp hard link.
- At state sync the unresolved threads are `PRRT_kwDOTTDtUM6VkSwY`,
  `PRRT_kwDOTTDtUM6VkqqS`, `PRRT_kwDOTTDtUM6VkzTz`,
  `PRRT_kwDOTTDtUM6Vk38a`, `PRRT_kwDOTTDtUM6Vk38b`,
  `PRRT_kwDOTTDtUM6VlUo8`, `PRRT_kwDOTTDtUM6VlUo-`,
  `PRRT_kwDOTTDtUM6VlsfV`, `PRRT_kwDOTTDtUM6VmCNv`,
  `PRRT_kwDOTTDtUM6VmCNw`, `PRRT_kwDOTTDtUM6VmGY5`,
  `PRRT_kwDOTTDtUM6VmMCl`, `PRRT_kwDOTTDtUM6VmU9i`,
  `PRRT_kwDOTTDtUM6VnQiz`, `PRRT_kwDOTTDtUM6VnW8t`,
  `PRRT_kwDOTTDtUM6VnW8u`, `PRRT_kwDOTTDtUM6VnZrR`,
  `PRRT_kwDOTTDtUM6VnfBZ` and `PRRT_kwDOTTDtUM6VnlsB`.
  Generic startup preserves the bounded stage; explicit recovery is serialized
  by exact target across database files. Exact-head Windows CI and a fresh
  post-promotion Codex review remain required; merge is not authorized.

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
| `S3B-T1B_RECOVER_ORPHANED_BLOB_STAGING` | `PASS_LOCAL_WITH_CROSS_DATABASE_TARGET_MUTEX` | `BLOCKED_BY_PR109_POST_PROMOTION_FINDING` in open Ready PR #109 | New exact-head CI and post-promotion Codex review |
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
