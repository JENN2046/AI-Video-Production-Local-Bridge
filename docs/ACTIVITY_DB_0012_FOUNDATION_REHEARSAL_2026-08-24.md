# Activity DB 0012 Foundation Rehearsal — 2026-08-24

## Decision

`PASS_0012_FOUNDATION_REHEARSAL`

This is disposable-fixture evidence only. It does not claim that the real
Activity DB was inspected, backed up, restored, migrated, or admitted. It does
not establish current-main runtime acceptance or authorize Runtime 4181,
Provider execution, Production Mutation Authority, Assembly, Final Review,
Export, Closeout, publication, or deployment.

## Authority and boundary

| Authority | Evidence-bound state |
| --- | --- |
| PR base | `main@2af891575b1144159998b094fa53211f2d86f566` |
| Canonical source | `workbench-v2-7` / migration `0012` |
| Last accepted activity-runtime evidence | `workbench-v2-6` / migration `0011` |
| Real Activity DB inspection in this rehearsal | `NOT_PERFORMED` |
| Current-main runtime acceptance | `NOT_ESTABLISHED` |

The `0011` activity-runtime statement is historical, commit-scoped evidence,
not a fresh observation of private local state. Any real inventory, backup,
migration, restore, runtime transition, or low-disclosure business-state check
remains a separately authorized operation.

## RA-001 — Disposable fixture boundary

The rehearsal constructs synthetic `0011` databases from the production
migration registry. It does not open the configured workspace database or infer
its path, row counts, schema objects, runtime state, or current bytes.

The fixture set covers:

- a `final_approved` Project with a valid same-Project active final Artifact;
- a pointerless `final_approved` Project; and
- a malformed final pointer that must fail closed before `0012` schema changes.

## RA-002 — Isolated `0011 → 0012` behavior

| Fixture | Result | Evidence |
| --- | --- | --- |
| Valid final pointer | PASS | Migration copy reaches exact `0012`; every business table that existed at `0011` is unchanged; delivery state becomes `legacy_review_required` and preserves the pointer. |
| Pointerless final approval | PASS | Migration reaches `0012`, projects `not_ready`, and fabricates no final pointer, Job, or Event. |
| Invalid final pointer | PASS (fail closed) | Migration raises `WORKBENCH_LEGACY_FINAL_ARTIFACT_INVALID`; full pre-migration logical manifest and business summary remain unchanged. |

The executable evidence is
[`tests/activity-db-0012-foundation-rehearsal.test.ts`](../tests/activity-db-0012-foundation-rehearsal.test.ts).

## RA-003 — Backup, migration copy, and independent restore

The valid-pointer fixture exercises four distinct paths:

```text
original 0011 fixture
  -> VACUUM INTO backup (before migration)
       -> migration copy -> exact 0012
       -> after the migration attempt, previously nonexistent restore target -> 0011
```

The test proves:

1. the formal backup is created before any migration attempt;
2. the original `0011` fixture retains the exact ledger, schema-object digest,
   full logical manifest, and all pre-existing business-table rows;
3. the migration copy contains the exact `0001..0012` ledger with canonical
   checksums, reports `workbench-v2-7`, contains the four Foundation tables,
   and preserves every table that existed before `0012` except the expected
   `m0_meta` and `schema_migrations` changes;
4. the restore target is asserted absent before restore, then created from the
   backup as a separate file;
5. the backup and independent restore both retain the exact `0001..0011`
   ledger, pre-`0012` schema-object digest, full logical manifest, all
   pre-existing business-table rows, and `PRAGMA quick_check=ok`; and
6. the migration copy's whole-database manifest changes intentionally because
   `0012` adds schema/ledger/delivery-state facts, while every pre-existing
   business table remains identical.

Migration `0012` remains frozen. No down migration is introduced or claimed;
real recovery remains restore-from-preserved-backup only.

## RA-004 — Foundation invariants

The migrated copy also verifies:

- legacy final pointer immutability;
- global single-active Delivery Job authority;
- terminal Job evidence rejection; and
- Delivery Event append-only protection.

Existing targeted suites cover structural schema/checksum drift, readonly
Snapshot `0012` fail-closed behavior, zero-write readonly projection, and the
legacy Assembly kill switch.

## RA-005 — Result boundary

The rehearsal found no unexplained mutation of the original fixture, no
fabricated delivery evidence after the malformed-pointer precondition failure,
and no mismatch between the backup and independent restore. The malformed case
does not claim to exercise rollback after partial DDL; late-fault transaction
atomicity remains part of the current-main fixture acceptance gate.

This result is exactly:

```text
PASS_0012_FOUNDATION_REHEARSAL
```

It is not `READY_FOR_ACTIVITY_DB_0012_ADMISSION`, `RUNTIME_READY`, or
`PRODUCT_COMPLETE`.

## Validation

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm run test:selection-gate` | PASS — 23/23; 80/80 mandatory files selected |
| Focused rehearsal + Delivery State + readonly Snapshot + Assembly kill switch | PASS — 30/30 |
| `npm run test:foundation-boundaries` | PASS — 133 passed, 4 Windows permission-based symlink skips |
| `npm run test:v2` | PASS — 83/83 |
| `npm run test:db` | PASS — 61/61 |
| `npm run secret:scan` | PASS — zero findings |
| `git diff --check origin/main` | PASS |

A green fixture run does not promote this report into real Runtime acceptance.

## Next gate

A future real `0011 → 0016` Activity DB gate must first obtain exact authority
for the target database, allowed read-only inventory, pre-migration backup,
independent restore target, execution window, Runtime 4181 stop/start method,
and recovery trigger. This report grants none of those authorities.
