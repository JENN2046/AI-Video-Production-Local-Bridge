# Workbench Delivery Recovery

Status: `CANDIDATE`

This runbook covers the owner-controlled Human Workbench path added for
`workbench-v2-7` / migration `0012`. It does not authorize activity-database
access, Provider execution, migration, deployment, Snapshot publishing or
Memory writes.

## Recovery invariant

Recovery may continue a recorded job or end the current intent. It must never
guess that a paid submit failed and submit again.

The safe order is:

```text
inspect sanitized state
  -> confirm Project is active and not closed
  -> continue the recorded Provider task or abandon with a reason
  -> explicitly retry an interrupted local delivery job
  -> verify current Artifact and export before closeout
```

## Generation reconciliation

Open the Project's Generation tab and select the reconciliation item.

- If a Provider task ID is already recorded, choose “继续核对已记录任务”. The
  worker may resume polling/download/finalization only.
- If no task ID is recorded, copy the existing Provider task ID from the
  Provider's own task history into the dialog. The ID is attached only after
  duplicate-ownership checks pass.
- To end the attempt, choose “放弃本次尝试”, enter a non-empty reason, and
  confirm the second dialog.
- Do not create a replacement Intent until the existing reconciliation item is
  resolved. Reconciliation performs zero Provider submits.

Archived Projects, closed Projects, stale Job state, duplicate task ownership
or malformed bindings fail closed. Preserve the stable error code and inspect
the sanitized state; do not bypass the guard in SQLite.

## Assembly recovery

Assembly preflight binds the Project specification, ordered SHOTs, accepted
Artifact IDs, Blob SHA values, durations and `final-assembly-v1` into one JCS
SHA-256 fingerprint.

- `ASSEMBLY_INPUT_CHANGED`: refresh the Delivery page, review changed SHOTs,
  and run a new preflight. Never reuse the stale fingerprint.
- `DELIVERY_JOB_ACTIVE`: wait for the visible job to reach a terminal state.
  There can be only one global assembly/export job.
- `FFMPEG_UNAVAILABLE`: repair the local managed FFmpeg/FFprobe path, then run
  preflight again. Do not mark the Project approved or exported.
- `ASSEMBLY_OUTPUT_INVALID`: preserve the failed job/error code. The final
  Artifact pointer did not move. Fix the input/tool issue and ask Jenn to
  explicitly retry.
- `interrupted`: restart recovery marks a previously unfinished job terminal
  and removes only that job's staging files. Jenn must press retry; there is no
  automatic retry.

Each successful assembly creates a new `final_video` Artifact and version.
Sources, accepted clips and older final versions remain immutable.

## Final review and targeted rework

The Final Review panel always acts on the current final Artifact:

- `accept` records approval for that exact Artifact;
- `reassemble` keeps all accepted SHOT pointers and returns to
  `ready_to_assemble`;
- `regenerate_shots` requires at least one SHOT, clears only those accepted
  pointers, creates regeneration requests and preserves every other SHOT.

`FINAL_REVIEW_ARTIFACT_STALE` means the visible version is no longer current.
Reload and review the new current version instead of approving the old one.

## Export and closeout recovery

Exports live under the governed relative library
`data/exports/<project_id>/`. The browser receives only a relative path and a
local download route; it never invokes a shell or receives an absolute path.

- Export writes a unique `.part` file, validates SHA/size/FFprobe and performs
  an exclusive rename. Failure leaves delivery state unchanged.
- Re-exporting the same Artifact reuses an existing record only when the file
  still exists and its bytes match. Missing or drifted bytes create a new
  export attempt; old evidence is not rewritten.
- Closeout is separate from export. Jenn must type `确认结案`.
- Closeout revalidates the current final Artifact, its matching export and the
  absence of active delivery jobs. `CLOSEOUT_EXPORT_MISMATCH` requires a new
  valid export before retrying closeout.
- After `closed`, every production write returns `PROJECT_CLOSED`. Archive and
  restore remain a separate lifecycle concern and do not reopen production.

## Activity database: two explicit authorization gates

The activity database is private state. Do not infer access from code or
fixture acceptance.

### Gate A — isolated activity-copy rehearsal

Before opening or copying the activity database, Jenn's current authorization
must name:

1. the verified activity database target;
2. permission to stop its Workbench and read/copy it;
3. the Git-ignored pre-migration backup and isolated-copy ownership boundary;
4. the rehearsal range `0011` → `0012`;
5. read-only `db:check`, logical/business manifest comparison and restore
   rehearsal;
6. the rollback copy and the condition for restarting the old runtime;
7. confirmation that no formal activity migration, Provider, Snapshot, Memory
   or external operation is included.

The rehearsal report must contain only versions, aggregate counts/digests and
stable result codes. It must not contain rows, prompts, identities, local
absolute paths, raw logs or Provider data.

### Gate B — formal activity migration

Only after Gate A passes, request a second exact authorization naming:

1. the same verified target;
2. migration `0011` → `0012`;
3. the retained pre-migration backup identity;
4. the tested rollback source and recovery procedure;
5. runtime stop/start scope;
6. post-migration read-only `db:check` and manifest comparison;
7. the stop condition for any mismatch.

On any migration, integrity or manifest mismatch, leave the Workbench stopped,
do not publish a Snapshot, do not retry a Provider, and report the sanitized
failure. Restore only under the named rollback authorization.

## Stable delivery error codes

| Code | Operator action |
|---|---|
| `ASSEMBLY_NOT_READY` | Resolve the named missing/invalid accepted SHOT input |
| `ASSEMBLY_INPUT_CHANGED` | Refresh and run a new preflight |
| `DELIVERY_JOB_ACTIVE` | Wait for or explicitly recover the current job |
| `FFMPEG_UNAVAILABLE` | Restore the managed local toolchain |
| `ASSEMBLY_OUTPUT_INVALID` | Preserve failure; fix and explicitly retry |
| `FINAL_REVIEW_ARTIFACT_STALE` | Reload and review the current version |
| `FINAL_REWORK_SELECTION_REQUIRED` | Select at least one problem SHOT |
| `EXPORT_INTEGRITY_FAILED` | Preserve state; export again after repair |
| `CLOSEOUT_EXPORT_MISMATCH` | Produce a verified export for the current Artifact |
| `CLOSEOUT_CONFIRMATION_REQUIRED` | Type the exact owner confirmation phrase |
| `PROJECT_CLOSED` | Stop production writes; do not bypass closeout |

The low-disclosure fixture evidence is recorded in
[2026-08-13 Human Workbench code-complete fixture acceptance](../ops/reports/2026-08-13-workbench-code-complete-fixture-acceptance.md).
