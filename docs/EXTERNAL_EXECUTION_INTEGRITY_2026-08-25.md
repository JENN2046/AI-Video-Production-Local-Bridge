# External Execution Integrity

Date: 2026-08-25

Status: `LOCAL_FIXTURE_COVERED`. Canonical source advances to migration `0016`
and schema `workbench-v2-11`. This status is local code and fixture evidence. It
does not migrate the activity database, start Runtime 4181, authorize a paid
Provider call, or establish production acceptance.

## Durable execution authority

Each newly confirmed V2 real-generation Job must create one
`generation_execution_receipts` row in the same admission transaction or the
admission rolls back. The receipt freezes:

- current Intent confirmation, account, cost, budget, currency and expiry;
- Job identity plus Run row/payload identity, input, Provider binding and
  attempt version;
- Project, SHOT, Provider, model, normalized Provider input, and
  generation-plan identities;
- the Project video specification;
- the active immutable Storyboard Package identity and content digest;
- the current SHOT input snapshot; and
- the storyboard Artifact, Blob, and byte digest.

Receipt creation and transition require the connection-local
`generation_execution` production mutation owner. Its identity, authority
snapshot, first known Provider task and successful result are protected by
schema constraints and immutable-field triggers; updates without that owner
fail closed. A human may resume the same retained task or abandon the attempt;
a different task cannot replace an already persisted task.

Migration `0016` moves legacy active generation Jobs without a frozen receipt
to `manual_reconciliation` with
`GENERATION_EXECUTION_SNAPSHOT_MISSING`. It does not submit, poll, download,
retry, or infer authority for those Jobs. Attach or abandon is admitted only
for a canonical pre-`0016` Project/SHOT/Run/Intent binding carrying both its
exact deterministic migration event and a migration-only immutable attestation,
plus persisted restoration state. Random Job IDs are supported and
runtime-forged quarantine Events remain rejected.

## Await and finalization boundaries

The receipt freezes Job identity; the persistent worker separately verifies
the exact current Job stage and lease owner before each Provider effect. It
reloads the current Intent and verifies again
after resolved or rejected submit, poll and download awaits. A bounded,
nonempty task identity returned by a successful submit is persisted before
local canonical-ID validation and post-await authority evaluation. Thus a
possibly paid task remains durable for reconciliation instead of being treated
as a retryable no-task outcome. Director accounting settlement is attempted
separately; if that enrichment fails, the task identity, receipt and manual Job
remain durable with `DIRECTOR_ACCOUNTING_REQUIRES_RECONCILIATION`.

RunningHub upload completion is also revalidated before the paid submit
endpoint can be called. Provider task statuses are normalized to a bounded
stable vocabulary before any Run, receipt, Event, or error projection write.

The Provider output downloader rechecks authority after DNS resolution,
pinned-address fetch, redirects, response cancellation, and each streamed body
read. No authority failure proceeds to file activation.

Final output activation is available only through the worker-supplied
`activate_artifact` capability and runs inside its outer Workbench transaction.
An injected downloader cannot independently activate an Artifact and report it
as the worker result. The capability verifies its deterministic Artifact
identity, worker-authorized output directory, Project, SHOT, role, type and
Provider task both before opening the outer transaction and immediately before
persistence. It also probes the actual MP4 bytes and binds width, height,
aspect ratio and duration (within the greater of 250 ms or 2 percent) to the
frozen Project/Intent specification; downloader-supplied metadata is not a
media-fact authority. Unattested outputs remain durably recovery-bound even
when an archive attempt fails. The worker rechecks Project, SHOT, Storyboard
Package,
Run, receipt, lease, exact Job stage and any Director grant immediately before
Artifact persistence. Within that worker-owned path, Artifact, Blob,
GenerationRun, SHOT, Project, Intent, receipt, Job and Event changes share one
database commit. Activation markers are cleaned only after that commit. A
rollback retains recovery evidence and the known task is routed to
`manual_reconciliation` when the worker still owns the expected stage; an
externally changed Job stage is preserved rather than overwritten.

Mock regeneration follows the same post-await rule and commits its Artifact,
GenerationRun, and SHOT together. Both legacy batch real-Provider paths remain
permanently retired even if a caller passes `allow_live_provider: true`.

## Review-thread closure

The exact 11-thread mapping is
[external-execution-integrity-thread-ledger.json](evidence/external-execution-integrity-thread-ledger.json).
Each mapping uses a stable `EEI-*` test ID whose enabled test declaration,
mandatory npm lane, canonical `npm test` selection and Windows CI step are
checked by `[EEI-LEDGER-01]`. The selected tests include submit, poll,
download, Run/Job drift, final-transaction, filesystem recovery, immutable
receipt, regeneration, Director accounting and G0 restoration negative paths.
Migration tests cover checksum-governed current schema, trigger definitions,
genuine `0015 → 0016` reconciliation, and late-failure transaction rollback.

## Non-claims and next gates

No real Provider account, credential, task, budget, source media, activity
database, Runtime 4181 process, or production configuration was used or
changed. Real acceptance still requires the separately authorized activity
database `0011 → 0016` gate, one bounded real SHOT canary, one real complete
loop, and three closed real projects.
