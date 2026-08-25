# Final Review, Export, and Closeout — 2026-08-25

## Result boundary

Canonical source advances to migration `0015` / schema `workbench-v2-10`.
The Human Workbench now implements the fixture-backed path from a current
Assembly Artifact through Final Review, governed local Export, and exact
Closeout.

This is source and isolated-fixture evidence only. It is not Activity Runtime
acceptance, Provider acceptance, real-project delivery, `CODE_COMPLETE_ON_CURRENT_MAIN`,
or `PRODUCT_COMPLETE`. The activity database's last explicitly accepted runtime
boundary remains migration `0011` / schema `workbench-v2-6`.

## Public contract

```text
POST /api/v2/projects/:id/delivery/final-review
POST /api/v2/projects/:id/delivery/export
GET  /api/v2/projects/:id/delivery/exports/:exportId/file
POST /api/v2/projects/:id/delivery/closeout
```

Final Review accepts `accept`, `reassemble`, or `regenerate_shots`. Every
decision requires `human_confirmation: true` and must target the current final
Artifact. Targeted regeneration accepts only current SHOTs owned by the Project,
clears only their accepted pointers, creates durable regeneration requests, and
preserves old Clip and final Artifacts.

Export requires the current approved Artifact and explicit human confirmation.
A new persistent Job returns HTTP `202`; byte-identical reuse of a verified
immutable Export returns HTTP `200`. Failed or interrupted work is never retried
implicitly: a new attempt must bind `retry_of_job_id` to the latest retryable Job.

Closeout requires the exact phrase:

```text
确认结案
```

## State and evidence

The implemented transitions are:

```text
final_review + accept              → approved
final_review/approved/exported
  + reassemble                     → ready_to_assemble
final_review/approved/exported
  + regenerate_shots               → revision_requested
approved + successful export       → exported
exported + exact closeout           → closed
```

Review decisions, Delivery projection, and immutable Events commit in one
transaction. Export copies into a governed `.part` path with no-overwrite,
validates SHA-256, size, and FFprobe facts, then atomically registers the
immutable Export receipt, terminal Job, Event, and Delivery pointer. Existing
Export files and receipts are never overwritten or deleted by rework.

Cold project-list and Dashboard reads do not synchronously hash every finished
video. They project Export verification separately as `unverified`, `verified`,
or `failed`; a cold valid `closed` Project therefore reports
`verification_required`, not a false integrity failure or an unverified
`delivered` claim. The single-Project Workspace, WebGPT Delivery read, download,
Closeout, and Snapshot export are explicit full-verification boundaries. A full
failure becomes `delivery_invalid`, contributes to blocked-project totals, and
prevents a readonly Snapshot from claiming delivery. Verified downloads stream
from the same read-only file descriptor whose identity and SHA-256 were checked,
so the HTTP layer does not reopen the path after verification.

On process startup, inherited queued or running Export Jobs become
`interrupted`. Any `.part` or final recovery evidence is preserved; the worker
does not resume or retry. If a final database commit acknowledgement is
indeterminate, the operation returns `EXPORT_RECOVERY_REQUIRED` or
`CLOSEOUT_RECOVERY_REQUIRED` and performs no destructive compensation.

Closeout revalidates, inside one transaction, the Project pointer, current and
approved Artifact identity, latest immutable Export receipt, real Export bytes,
SHA-256, size, and FFprobe result. The Project becomes `final_approved` before
the Delivery state becomes `closed`; all later production writes fail closed.

## Workspace projection

The Delivery workspace projects real database state:

- `assembly_preflight`
- `active_job`
- `retryable_jobs`
- `final_versions`
- `current_final_version`
- `final_review`
- `latest_export`
- `closeout_receipt`

`summary.export_verification_state` and
`latest_export.verification_state` distinguish cold/unverified state from a
confirmed integrity failure. `workflow_state` remains the durable state-machine
fact; verification status never mutates it or starts a Job.

Reads never queue, start, resume, or retry work. UI polling runs only while an
active Job is present and stops after terminal state is projected.

## Migration and fixture evidence

Migration `0015` is forward-only. Migrations `0012`, `0013`, and `0014` remain
unchanged. Database triggers require connection-local Production Mutation
Authority for Final Review, Export, Event, Project projection, and Closeout
changes. Direct SQL cannot forge those transitions or receipts.

Targeted tests cover the isolated `0014 → 0015` upgrade, deterministic checksum,
required index and trigger expressions, migration failure atomicity, direct-SQL
rejection, stale Artifact checks, selected-SHOT regeneration, old-version
retention, Export no-overwrite, byte drift, idempotent reuse, explicit retry,
restart interruption, lost commit acknowledgement, exact Closeout phrase,
closed-project write rejection, cold-versus-full Export verification, Dashboard
blocker propagation, sanitized Workspace DTOs, and same-descriptor verified
download. Snapshot projection tests cover current-source Export verification
state while preserving verification compatibility for older signed source pairs.

## Remaining gates

- migration `0016`: External Execution Integrity;
- responsive and WCAG AA acceptance;
- current-main fixture acceptance across the complete loop;
- separately authorized Activity DB `0011 → 0016` migration and Runtime acceptance;
- one real SHOT canary, one real complete loop, and three real Projects.

No real database, Provider, production Runtime, source-media overwrite, release,
or deployment action is authorized by this document.
