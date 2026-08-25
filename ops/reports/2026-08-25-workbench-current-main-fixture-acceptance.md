# Human Workbench Current-main Fixture Acceptance

Date: 2026-08-25

## Result

```yaml
result: CODE_COMPLETE_ON_CURRENT_MAIN
source_schema: workbench-v2-11
source_migration: 0016
base_main_at_pr_start: ffacdcda9860901fddf50df2cdbfc88a5235461b
evidence_authority: exact head of the PR containing this report
activity_runtime_acceptance: NOT_RUN
real_provider_canary: NOT_RUN
real_project_acceptance: NOT_RUN
product_complete: false
```

This result means the current source has one mandatory, isolated acceptance
fixture for the complete Human Workbench production loop and one staged
database-upgrade/restore fixture from the last accepted Activity Runtime
boundary through the current schema. It does not promote local fixture evidence
to Activity Runtime or production evidence.

## Complete-loop fixture

The current-main fixture uses a disposable database, synthetic Storyboard input,
synthetic Provider responses, and generated six-second MP4 inputs. It proves the
following sequence on current source:

```text
Generation admission
→ ambiguous submit outcome
→ explicit human reconciliation without resubmit
→ governed Provider-result download
→ accepted clip
→ real local FFmpeg Assembly
→ Final Review targeted regeneration
→ second governed generation and accepted clip
→ second Assembly with the first final version preserved
→ Final Review accept
→ native governed Export with SHA-256 verification
→ rejection of an inexact closeout phrase
→ exact "确认结案" Closeout
```

The final Workspace projection is checked for the current final version, all
final versions, Final Review, latest Export, Closeout receipt, no active Job, and
the durable `closed` state. Generation and Delivery Jobs must all be terminal
successes, the exported bytes must match the immutable receipt digest, and the
database check must pass. No read starts, resumes, or retries a Job.

## Migration, backup, and restore fixture

The database acceptance creates an isolated `0011` / `workbench-v2-6` fixture,
takes a pre-migration backup, and copies it to a previously absent target. It
then applies every frozen migration separately:

```text
0011 / workbench-v2-6
→ 0012 / workbench-v2-7
→ 0013 / workbench-v2-8
→ 0014 / workbench-v2-9
→ 0015 / workbench-v2-10
→ 0016 / workbench-v2-11
```

At each step it verifies the canonical migration name, checksum, schema version,
and representative governed trigger expression. It also verifies that business
rows do not drift, the original `0011` source remains unchanged, and the final
database passes the database checker. Separate backups of the `0011` and `0016`
boundaries are restored into previously absent targets and compared by logical
manifest and business projection.

This is a disposable rehearsal. It is not the authorized Activity DB
`0011 → 0016` migration.

## Validation

The final implementation worktree passed the canonical complete local gate:

```text
npm test: PASS
```

That gate includes typecheck, production build, selection-gate enforcement,
Foundation, T2, Provider boundaries, database governance, all Workbench V2
tests, UI tests, WebGPT/Director/Unified/Media suites, local Windows Runtime
fixture smoke, the 22-case browser/WCAG matrix, and secret scanning. The new
complete-loop acceptance is mandatory in `test:v2`; the staged `0011 → 0016`
case is mandatory in `test:db`.

Two pre-existing test-environment dependencies were made deterministic while
closing the gate: the Readonly profile fixture now injects synthetic Federated
OAuth and owner authority instead of inheriting host OAuth variables, and two
file-symlink attack fixtures report an explicit capability skip when the Windows
process lacks symlink permission. All non-symlink negative paths still execute.

The build retains the existing Vite warning that the Trello background URL is
resolved at runtime. No build or test failure remains.

## Non-claims and remaining gates

No Activity database, private-state content, Runtime 4181 process, real Provider
account, paid task, production source media, production configuration, external
Snapshot, release, or deployment was read or changed for this acceptance.

The following gates remain separate and mandatory before `PRODUCT_COMPLETE`:

1. Explicitly authorized Activity DB `0011 → 0016` inventory, backup, isolated
   rehearsal, restore rehearsal, migration, Runtime 4181 smoke, and
   low-disclosure business-state check.
2. One explicitly budgeted real single-SHOT Provider canary with
   `max_submit=1` and no automatic retry.
3. One real complete generation-to-Closeout loop.
4. Three real Projects: one multi-SHOT, one targeted-rework, and one mixed
   Grok/Seedance specification project, all closed with no P0/P1 finding,
   duplicate paid task, unexplained recovery marker, or overwritten file.

Until all four gates pass, the only allowed conclusion from this report is:

```text
CODE_COMPLETE_ON_CURRENT_MAIN
```
