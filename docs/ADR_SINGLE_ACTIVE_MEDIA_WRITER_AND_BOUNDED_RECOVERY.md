# ADR: Single Active Media Writer and Bounded Recovery

Status: accepted current-product boundary
Date: 2026-08-04 (Asia/Shanghai)

## Current governance truth

```yaml
current_main: 3c502e23f884d1b062210321d84848b45c7bb344
pr109: CLOSED_UNMERGED_RETIRED
pr113: OPEN_READY_CLOSEOUT_CANDIDATE
pr114_p2: DEFERRED_UNRESOLVED
pr115: CLOSED_UNMERGED
minimal_replacement:
  task_id: S3B-T1B-R1_MINIMAL_BOUNDED_STAGE_REPLACEMENT
  status: DEFERRED_NOT_REQUIRED_FOR_S4
  blocks_s4: false
```

The PR114 P2 is a valid behavior-test sufficiency finding. PR115 was an
unmerged attempted remediation and its fixture CI failure did not prove a
production runtime defect. Neither is recorded as fixed here.

During S4, verified-Blob recovery is not an automatic or explicit operation.
An integrity failure must stop and enter manual reconciliation; no Provider
resubmit or automatic stage cleanup is permitted.

## Decision

```yaml
single_active_media_writer: true
single_active_business_database: true
shared_media_root_multi_writer: unsupported
backup_or_copy_database_media_write: forbidden
recovery_copy_media_write: forbidden
blob_recovery_trigger: explicit_human_reconciliation_only
generic_startup_destructive_cleanup: forbidden
unsafe_or_ambiguous_recovery_state: fail_closed_and_manual
```

The current product supports one local Workbench instance, one business
database and one governed media store. Blob recovery is an explicit human
reconciliation operation; ordinary startup does not delete or reconcile
recovery files.

## Rationale

- The product is a single-user local Workbench.
- Workbench is the only authority for approval, cost acknowledgement, Artifact
  adoption and delivery.
- A multi-database shared media root is not a prerequisite for the current
  production loop.
- The product should not pay distributed-transaction and cross-process
  ownership costs for an unsupported deployment topology.
- Fail-closed behavior is safer than deleting a file whose ownership or
  provenance is ambiguous.

## Consequences

### Supported

```yaml
supported:
  - one Workbench instance
  - one business database
  - one governed media store
  - explicit human Blob recovery
  - deterministic, bounded recovery staging
```

### Unsupported

```yaml
unsupported:
  - two active Workbench instances
  - two active databases sharing one media root
  - concurrent explicit recovery from database copies
  - network-shared media-root multi-writer
  - backup-database or recovery-copy media writes
  - generic startup deletion of unproven recovery entries
```

## Re-evaluation triggers

Re-evaluate this decision only if one of the following becomes an explicit
product requirement and receives a separate RFC:

- formally supported multi-instance Workbench;
- shared or network media-disk writes;
- automatic database failover;
- multiple local recovery workers;
- a separate, approved cross-process media transaction design.

## Relationship to PR #109

PR #109 is retained as architecture and threat-model evidence but was closed
without merge after its implementation grew into the unsupported topology
described above. Its target mutex, authority, ownership-store, publication and
physical-identity protocols are not part of this ADR or current `main`.

The prepared minimal replacement remains deferred and is not the next required
S4 implementation. Any future authorization must start from current `main` on
a new branch and remain bounded to one deterministic stage per physical target,
non-destructive generic startup, explicit human reconciliation and fail-closed
handling of unsafe entries; it must not reopen PR #109's architecture.
