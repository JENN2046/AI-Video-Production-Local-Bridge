# User Guide

Status: `CODE_COMPLETE` for candidate code and synthetic fixtures;
`PARTIAL` for real production acceptance.

The candidate requires `workbench-v2-7` / ledger `0012`. The accepted activity
database remains `workbench-v2-6` / `0011` and has not been read, copied or
migrated by this work. Runtime startup never migrates a database automatically.

## What Jenn can use now

### Synthetic Human Workbench preview

Open [http://127.0.0.1:4181](http://127.0.0.1:4181). During the current
acceptance session this listener uses a synthetic fixture data root. It is safe
for UI exploration, but it is not activity-library, paid-Provider or real
delivery evidence.

Do not point this candidate at the activity database until the copy rehearsal
and formal `0011` → `0012` migration each receive exact authorization and pass.

### ChatGPT Readonly Workbench

The installed Jenn AI Video Workspace App shows a signed Snapshot of authorized
production projects. It can display project context, SHOT state, Review,
Delivery and Closeout evidence. It cannot edit a Project, approve a clip,
submit a Provider job, publish a Snapshot, export a file or close a Project.

The banner “当前数据来自只读快照” is intentional. A Human Workbench migration
or decision does not update the remote Snapshot automatically.

## Human Workbench navigation

Desktop keeps six primary entries: Dashboard, Projects, Inbox, Assets,
Director and System.

Mobile uses five fixed entries: “指挥台、项目、收件箱、Director、更多”.
“更多” opens a focus-trapped sheet containing Assets and System. `Escape`
closes dialogs/sheets; focus returns to the control that opened them.

Inside a Project, the five tabs are Storyboard, Generation, Review, Delivery
and Activity. Arrow keys move between tabs, `Home`/`End` select the first/last
tab, and the Project picker supports standard combobox/listbox keys.

## Production workflow

### 1. Storyboard

Confirm the approved Storyboard Package and each SHOT's prompt, duration,
aspect ratio and bytes-verified image. Generation remains disabled when the
Project is archived/closed, the Package is stale, input bytes drift, another
paid generation is active, or a SHOT is not ready. The disabled control names
the exact reason and next action.

### 2. Generation and manual reconciliation

Generation preflight displays the Provider/model, mapped output, estimate,
budget and confirmation requirement. Each paid submit still requires its own
current Jenn confirmation.

When a Provider outcome is unknown, the Generation tab shows a sanitized
reconciliation item:

- continue the already-recorded task ID;
- attach an existing task ID from Provider history, then continue it;
- or abandon the attempt with a reason and second confirmation.

All three reconciliation routes perform zero Provider submits. Do not create a
new Intent until the unknown result is resolved.

### 3. Review and regeneration

Review shows the full Clip version stack. Jenn may accept the current Clip or
request revision with rejection reasons and a structured instruction. Targeted
regeneration creates a new version; it never overwrites the older Clip.

### 4. Delivery and assembly

Delivery is organized as:

```text
assembly readiness -> final version stack -> final review -> export/closeout
```

Run assembly preflight after every accepted-clip change. It fingerprints the
Project spec and ordered accepted Blob facts. Starting assembly persists a
queued Job and returns immediately; the global worker runs at most one assembly
or export. Failure or timeout leaves the final pointer unchanged and never
auto-retries.

### 5. Final review

Jenn chooses one action for the current final Artifact:

- accept the exact version;
- reassemble while keeping all SHOT adoptions;
- select one or more problem SHOTs for regeneration while preserving all other
  SHOT adoptions.

Reload when `FINAL_REVIEW_ARTIFACT_STALE` appears; an older final version cannot
be approved as current.

### 6. Export

After approval, confirm Export. The Workbench writes under the governed relative
library `data/exports/<project_id>/`, verifies bytes and records an immutable
export. The UI displays only a relative path and local download action.

An intact export for the same Artifact is reused. A missing or drifted file is
never silently reused, and a failed export does not change Project state.

### 7. Closeout

Closeout is separate from Export. Type the exact phrase `确认结案`. The system
rechecks the current Artifact, matching Export and absence of active jobs before
inserting the closeout event. After `closed`, production writes fail with
`PROJECT_CLOSED`; archiving does not reopen production.

## Starting an accepted activity runtime later

Only after activity migration and acceptance pass, use the verified Git root
and the accepted database/runtime profile:

```powershell
Set-Location "<verified repository root>"
git rev-parse --show-toplevel
Test-Path .\data\app.sqlite
npm run db:check -- --read-only
npm run windows:start
npm run windows:status
```

Do not run `db:migrate` as a repair command. Do not use the candidate startup
sequence against an `0011` activity database. The exact rehearsal, migration
and rollback authorization requirements are in
[Workbench Delivery Recovery](WORKBENCH_DELIVERY_RECOVERY.md).

If `windows:start` reports an unknown listener or stale identity, do not kill
processes blindly. Preserve the stable code and use `windows:status`.

## Snapshot operations

Snapshot publish/renew/recovery remains an independent, explicitly confirmed
Unified-profile operation. The System page now shows active Provider and data
governance by default. The old “只读 App 发布” controls live under Advanced
Legacy, explain why they are unavailable and expose no execution button.

Do not use the legacy Workbench publisher or `/mcp` route as a fallback. A
Workbench activity migration does not publish or renew the Unified Snapshot.

## Media preview

Local Media Gateway remains optional. Historical isolated MP4 playback exists,
but byte-range evidence and broader external gates remain separate. Media
failure must not block local project text/status or Human Workbench production.

Legacy Full WebGPT and Local Media Gateway both use port 2092; never run them
together. Do not install automatic startup or weaken Origin, capability, digest
or membership checks to make playback work.

## Common recovery

### Workbench is not ready

```powershell
npm run windows:status
npm run preflight
npm run db:check -- --read-only
```

The default writable `db:check` may recover staged media activations and move
files. Use it only inside an explicitly authorized recovery workflow.

### Generation outcome is unknown

Use only the Generation reconciliation dialog. Continue the recorded/existing
Provider task or abandon with a reason. Never press Generate again to “see if
it works”.

### Assembly/export was interrupted

Reload Delivery. The prior Job should be terminal `interrupted`; ask Jenn to
explicitly retry. Do not delete staging broadly and do not edit the final
Artifact pointer.

### Export does not match closeout

Re-export the current approved Artifact. Closeout must keep failing until a
complete, byte-matching export exists.

### ChatGPT has no Snapshot

Follow one separately confirmed Unified recovery from the Unified transport
runbook. Do not publish automatically from Human Workbench.

## Never put these in chat, logs or Git

Tokens, cookies, raw subjects, principal hashes, DPAPI plaintext, Cloudflare
connector tokens, capability keys, Provider payloads, database business rows,
local absolute media paths, raw logs or full Snapshot bodies.

For current facts see [Current State](../CURRENT_STATE.md). For installation and
external configuration see [Deployment Guide](DEPLOYMENT_GUIDE.md).
