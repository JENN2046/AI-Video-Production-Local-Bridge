# Human Workbench Code-Complete Fixture Acceptance

Date: 2026-08-13

Result: `PASS_CODE_COMPLETE`

Scope: candidate code, disposable databases, synthetic media and browser
fixtures only.

## Candidate identity

- Candidate branch: `codex/workbench-acceptance-docs`
- Candidate database: `workbench-v2-7`
- Candidate migration ledger: `0012`
- Delivery engine contract: `final-assembly-v1`
- Base delivery series: Draft PRs #121 through #126

The candidate is a stacked series. It is not merged to `main`, and this report
does not authorize any merge.

## Isolation boundary

The acceptance used temporary or Git-ignored synthetic roots. It did not read,
copy, migrate, restore or run against the activity database. It made no
Provider request and did not read credentials, `.env.local`, raw Provider
responses, raw logs or private business rows.

The already-running `127.0.0.1:4181` surface remained a synthetic fixture
preview. Its health/readiness pulse is an availability observation only, not
activity-database or real-production evidence.

## Evidence matrix

| Evidence | Result |
|---|---|
| Seedance model/quote/adapter/UI boundaries | `PASS` |
| Manual reconciliation: known/new task ID, abandon, archived/closed, zero submit | `PASS` |
| Delivery migration/state/append-only constraints | `PASS` |
| FFmpeg assembly ordering, input drift, audio normalization, concurrency, timeout/restart and path boundaries | `PASS` |
| Final review, targeted SHOT rework and old-version preservation | `PASS` |
| Export idempotence/integrity/no-overwrite and phrase-gated closeout | `PASS` |
| UI component and page tests | `19/19 PASS` |
| Workbench V2 domain/API tests | `87/87 PASS` |
| H1 Workbench tests | `8/8 PASS` |
| Four-viewport Playwright + axe fixture matrix | `27/27 PASS` |
| Database governance lane, including new copy/restore rehearsal | `57/57 PASS` |
| Readonly profile environment-isolation regression | `79 PASS / 1 platform skip / 0 FAIL` |
| Media gateway boundary lane | `64 PASS / 2 Windows file-symlink privilege skips / 0 FAIL` |
| Full `npm test` after final documentation/diff | `PASS` (exit `0`, `781s`; Playwright fixture on isolated port `44181`) |
| Secret scan after final documentation/diff | `PASS`, no findings |

## `0011` to `0012` disposable copy rehearsal

The file-level regression creates a synthetic `0011` database and records a
normalized manifest before any migration. It then:

1. creates a coherent SQLite backup;
2. copies only that backup into an isolated rehearsal target;
3. applies exactly migration `0012`;
4. runs `db:check` with media recovery disabled;
5. compares every pre-existing business table's normalized row digest;
6. backs up and restores the migrated copy and compares its full logical
   manifest;
7. restores the pre-migration backup and verifies ledger `0011`, schema
   `workbench-v2-6`, and absence of delivery tables;
8. confirms the original synthetic source is unchanged.

The regression records no rows, prompts, identifiers, absolute paths or raw
database output in this report.

## Fixture completion definition

The final regression passed, so this series may be called `CODE_COMPLETE`
only. It must not be called “产品补完”.

The product completion gate remains:

1. exact authorization and acceptance for an activity-library copy rehearsal;
2. exact authorization and acceptance for activity migration `0011` → `0012`;
3. one named Provider/model/SHOT/budget canary with `max_submit=1`;
4. one real end-to-end generation/review/regeneration/assembly/export/closeout;
5. three real production projects, including multi-SHOT, targeted rework and
   Grok/Seedance mixed specifications.

## Non-claims

- No activity database migration or private-state inspection occurred.
- No paid submission, automatic retry or Provider execution occurred.
- No release, deployment, external upload, Snapshot publish, Memory write,
  production configuration change or Legacy expansion occurred.
- No direct push or merge to `main` occurred.
