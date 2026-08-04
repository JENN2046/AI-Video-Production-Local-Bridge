# ADR: Single Active Media Writer and Bounded Recovery

Status: accepted current-product boundary
Date: 2026-08-04 (Asia/Shanghai)

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
