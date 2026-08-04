# PR #109 Postmortem and Reusable Assets

Status: controlled retirement without merge
Date: 2026-08-04 (Asia/Shanghai)

## Decision

PR #109 was closed without merge at head `423351bf376378d6fde48cea3060cc7af35bb148`.
Its branch, commits, CI runs and review history remain available as research and
threat-model evidence. No commit from that branch is accepted into `main` by
this closeout.

The late finding that started the work was valid. The remediation was not a
bounded maintenance fix by the end of the review cycle, so the code candidate
is rejected as a whole rather than promoted piecemeal.

## Original problem

PR #108's late P2 identified that a hard process exit after a staged copy was
complete could leave a random recovery stage behind. Repeated recovery and
crash cycles could create unbounded complete-media copies and disk growth.

## Scope expansion timeline

The remediation expanded through these architectural layers:

```text
random stage cleanup
→ deterministic stage
→ startup reconciliation
→ verified-Blob whitelist
→ canonical database authority
→ cross-database target mutex
→ target authority
→ stage-instance ownership
→ SQLite ownership store
→ publication protocol
→ inode and hard-link proofs
→ Windows physical-path normalization
→ crash-state convergence protocol
```

The final shape was a cross-process, cross-database media transaction protocol,
not a small deterministic-stage correction.

## Root causes

1. The first architecture-level scope expansion did not trigger a stop.
2. An unsupported multi-database shared-media-root topology was treated as a
   product requirement.
3. Each review finding was treated as mandatory work in the same PR.
4. Automatic file deletion requires strong ownership proof and therefore added
   more durable state and failure windows.
5. Source, tests and the task board expanded together, continuously increasing
   the review surface.
6. No PR-size or review-cycle hard stop was applied early enough.

## Reusable assets

### Retain now

```yaml
retain_now:
  - deterministic and bounded recovery staging
  - generic startup is non-destructive for Blob recovery stages
  - explicit human recovery owns convergence
  - unsafe or ambiguous paths fail closed
  - legacy deletion requires an ownership proof
  - hard-process-exit regression testing
  - repeated-crash disk-growth testing
```

These are principles only. They do not mean that PR #109's implementation is
accepted into `main`.

### Retain for future research

```yaml
retain_for_future_research:
  - cross-process target-mutex threat model
  - physical-path identity model
  - SQLite sidecar and handle-binding risks
  - inode/path replacement threat model
  - create-to-persist crash windows
  - shared-media-root conflict model
```

## Rejected implementation baggage

The following do not enter the current product:

```yaml
reject_from_current_product:
  - cross-database SQLite target mutex
  - target authority files
  - separate stage ownership database
  - companion hard-link ownership protocol
  - multi-database shared-media-root writes
  - PID or timestamp leases
  - global orphan-stage deletion
  - automatic deletion of unproven recovery entries
```

They remain visible only through the retained PR history and this bounded
postmortem.

## Governance lessons

The following limits are now the default review guardrails:

```yaml
pr_size_soft_limit:
  source_additions: 400
  test_additions: 800
  implementation_commits: 4

architecture_stop_conditions:
  - second consecutive review introduces a new persistence mechanism
  - a new database or ownership store becomes necessary
  - new cross-process coordination becomes necessary
  - a new supported deployment topology is introduced
  - diff exceeds twice the original authorized scope
```

When any condition is met:

```text
STOP_IMPLEMENTATION_AND_RETURN_TO_ARCHITECTURE_REVIEW
```

Review-thread resolution or green CI must not be interpreted as proof that all
deferred risks were eliminated.

## Future replacement boundary

The only prepared follow-up is
`S3B-T1B-R1_MINIMAL_BOUNDED_STAGE_REPLACEMENT`. It is recorded as
`AWAITING_JENN_AUTHORIZATION` and is not authorized by this postmortem.

If later authorized, it must start from current `main` on a new branch and
address only one deterministic stage per physical target, non-destructive
generic startup, explicit human recovery convergence, and fail-closed handling
of unsafe or unproven entries. It must not cherry-pick PR #109 wholesale or add
cross-database mutexes, authority files, ownership stores, companion links or
multi-writer shared-media support.
