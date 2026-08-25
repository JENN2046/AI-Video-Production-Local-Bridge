# Production Mutation Authority

Status: `SOURCE_IMPLEMENTED_PENDING_EXACT_HEAD_ACCEPTANCE`

Migration `0013` advances canonical source to `workbench-v2-8`. It does not
migrate or accept the activity database, whose last explicitly accepted runtime
boundary remains migration `0011` / `workbench-v2-6`.

## Authority contract

- The production mutation capability is connection-local, object-bound and
  synchronous. It is never persisted as a reusable token.
- Existing Project and SHOT mutations, Storyboard Package creation, and
  delivery-bound Artifact content or Blob rebinding pass through one explicit
  owner path. Initial Project insertion remains governed by the canonical
  `not_ready` projection trigger; an initially registered Artifact cannot become
  an accepted clip without an authority-owned SHOT mutation.
- `queued` or `running` Assembly and Export Jobs freeze the Project, every SHOT,
  Storyboard Package creation, title, and accepted-input Artifact/Blob bindings.
  A Job-owned capability may still register its new output Artifact; this does not
  permit mutation or rebinding of accepted inputs or existing final evidence.
- Reviewed or delivered content requires an explicit rework transition. A title
  update is the only narrow non-content Project write allowed before closeout.
- A closed Project rejects every Project production or title mutation.
- Any accepted-input drift atomically revokes `ready_to_assemble` and clears its
  fingerprint. Promotion back to ready revalidates every SHOT, approved clip,
  Artifact binding and verified Blob.
- SQLite busy/locked errors become `PRODUCTION_MUTATION_CONFLICT` without SQL,
  row values or database paths.
- G0 checks authority before creating a directory or staging bytes. It restores
  the prior file only after database rollback is confirmed; an indeterminate
  commit or failed rollback retains the target and backup for reconciliation.

## Failure-map evidence

The 11 deferred Production Mutation Authority threads are mapped one-to-one in
[`evidence/production-mutation-authority-thread-ledger.json`](evidence/production-mutation-authority-thread-ledger.json).
The mandatory Workbench V2 test lane verifies both that ledger and every named
negative test.

## Acceptance boundary

This PR can establish source and fixture acceptance for `0013`; it cannot claim
Activity Runtime acceptance, Provider canary acceptance, executable Assembly,
Final Review, Export, Closeout or product completion. Those remain later gates.
