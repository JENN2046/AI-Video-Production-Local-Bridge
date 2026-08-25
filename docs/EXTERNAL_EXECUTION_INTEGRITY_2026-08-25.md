# External Execution Integrity

Date: 2026-08-25

Status: `LOCAL_FIXTURE_COVERED`. Canonical source advances to migration `0016`
and schema `workbench-v2-11`. This status is local code and fixture evidence. It
does not migrate the activity database, start Runtime 4181, authorize a paid
Provider call, or establish production acceptance.

## Durable execution authority

Every confirmed V2 real-generation Job receives one
`generation_execution_receipts` row in the same admission transaction. The
receipt freezes:

- Intent, Job, Run, Project, SHOT, Provider, model, normalized Provider input,
  and generation-plan identities;
- the Project video specification;
- the active immutable Storyboard Package identity and content digest;
- the current SHOT input snapshot; and
- the storyboard Artifact, Blob, and byte digest.

Receipt creation and transition require the connection-local
`generation_execution` production mutation owner. Its identity, authority
snapshot, first known Provider task, successful result, and history cannot be
rewritten or deleted by direct SQL. A human may resume the same retained task
or abandon the attempt; a different task cannot replace an already persisted
task.

Migration `0016` moves legacy active generation Jobs without a frozen receipt
to `manual_reconciliation` with
`GENERATION_EXECUTION_SNAPSHOT_MISSING`. It does not submit, poll, download,
retry, or infer authority for those Jobs.

## Await and finalization boundaries

The persistent worker verifies current receipt authority before any Provider
effect. It verifies again after resolved or rejected submit and poll awaits. A
successful submit is persisted before post-await authority is evaluated, so a
possibly paid task is never converted into a retryable no-task state. A
rejected submit await is quarantined as an unknown outcome; rejected poll or
download awaits retain the known task and use fixed low-disclosure errors.

The Provider output downloader rechecks authority after DNS resolution,
pinned-address fetch, redirects, response cancellation, and each streamed body
read. No authority failure proceeds to file activation.

Final output activation runs inside the outer Workbench transaction. The
worker rechecks Project, SHOT, Storyboard Package, receipt, lease, and any
Director grant immediately before Artifact persistence. Artifact, Blob,
GenerationRun, SHOT, Project, Intent, receipt, Job, and Events then commit as
one unit. Activation markers are cleaned only after that outer commit. A
rollback retains recovery evidence and the known task remains in
`manual_reconciliation`.

Mock regeneration follows the same post-await rule and commits its Artifact,
GenerationRun, and SHOT together. Both legacy batch real-Provider paths remain
permanently retired even if a caller passes `allow_live_provider: true`.

## Review-thread closure

The exact 11-thread mapping is
[external-execution-integrity-thread-ledger.json](evidence/external-execution-integrity-thread-ledger.json).
The selected tests include submit, poll, download, final-transaction,
filesystem recovery, immutable receipt, regeneration, and G0 restoration
negative paths. Migration tests cover checksum-governed current schema,
trigger definitions, legacy upgrade, and late-failure transaction rollback.

## Non-claims and next gates

No real Provider account, credential, task, budget, source media, activity
database, Runtime 4181 process, or production configuration was used or
changed. Real acceptance still requires the separately authorized activity
database `0011 → 0016` gate, one bounded real SHOT canary, one real complete
loop, and three closed real projects.
