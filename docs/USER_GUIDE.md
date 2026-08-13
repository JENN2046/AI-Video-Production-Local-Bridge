# User Guide

Status: `UNIFIED_TRANSPORT_AND_SCHEMA_PASS`. The owner-only `0.1.0-beta.5` / ledger `0008` workflow remains historical evidence; the active database has now completed `0011`, and the bounded Unified Director owner path has passed. An isolated Media Gateway MP4 fixture playback path has also passed; byte-range plus broader Media, Provider, Memory and multi-user gates remain separate.

## Current-main database compatibility

This candidate code requires `workbench-v2-7` / ledger `0012`; the active database remains at the accepted `workbench-v2-6` / `0011` baseline and has not been migrated by this branch. Runtime startup never migrates a database automatically. Before activity-database use, Jenn must explicitly authorize the named target, `0011`→`0012`, verified backup and rollback path after a database-copy rehearsal. The accepted historical path does not authorize Provider execution, automatic Snapshot publishing, Memory saveback or production delivery.

## What Jenn can do today

### Local Workbench

The Workbench is the human production surface for projects, SHOTs, Storyboard, Generation, Review, Delivery and system operations. It is also the only surface allowed to confirm paid Provider work or adopt production decisions.

The following is the accepted local startup sequence. Use it only with the verified activity database and keep `REAL_PROVIDER_ENABLED=false` unless a separate Provider authorization exists:

```powershell
Set-Location "<verified repository root that owns the accepted data\app.sqlite>"
git rev-parse --show-toplevel
Test-Path .\data\app.sqlite
npm run db:check -- --read-only
npm run windows:start
npm run windows:status
```

The exact local root is deliberately not hard-coded: similarly named clones and archive directories may contain an empty or different `data/`. Continue only when the resolved Git root and accepted activity-database location match Jenn's runtime profile.

Open `http://127.0.0.1:4181`.

Stop it when finished:

```powershell
npm run windows:stop
```

If `windows:start` reports an unknown listener or stale identity, do not kill processes blindly. Preserve the state and use `windows:status` to identify the stable error code.

### ChatGPT Readonly Workbench

Open the installed Jenn AI Video Workspace App in ChatGPT. The App shows:

- service and Snapshot availability/fingerprint consistency, not a remote freshness or renewal estimate;
- authorized production projects;
- project context and next action;
- SHOT operational state;
- Review, Delivery and Closeout panels.

The banner “当前数据来自只读快照” is intentional. ChatGPT reads the last published Snapshot, not live SQLite rows.

Allowed actions are view, refresh, select project, expand SHOT, switch detail and copy a sanitized summary. Project edits, review adoption, Provider calls and Snapshot publishing are not App actions.

## Snapshot operations (Unified profile only; manual confirmation required)

The accepted current-schema flow uses the dedicated Unified publisher profile and Unified Snapshot store. The remote has no persistent Snapshot storage: do not invoke a Unified publish, renewal or recovery action without the separate human confirmation required for that one operation. The default `系统 → 只读 App 发布` Workbench surface and its `data/webgpt/publisher/profile.json` are legacy `/mcp` to `/snapshot` controls; they remain unavailable on the active database pending their own ledger-`0011` acceptance.

Unified currently has no low-disclosure remote freshness or `renewal_due` status command/UI. Do not reuse the legacy `fresh`, `renewal_due`, `no_snapshot`, `snapshot_expired` or `service_unavailable` labels for Unified decisions, and do not infer the existing remote Snapshot's lifetime from a local preflight result.

Accepted Unified flow:

1. Follow the dedicated Unified profile procedure in [UNIFIED_CHATGPT_WORKSPACE_TRANSPORT_RUNBOOK.md](webgpt/UNIFIED_CHATGPT_WORKSPACE_TRANSPORT_RUNBOOK.md#snapshot-operations).
2. If the Unified ChatGPT App visibly reports no Snapshot or renders no project data, treat that as a recovery request. If it renders the intended current Snapshot, do nothing unless Jenn explicitly confirms one bounded manual refresh.
3. Run one Unified preflight. Record only its `snapshot_fingerprint`, `generated_at`, `expires_at` and counts; these describe the newly prepared candidate, not the current remote Snapshot.
4. If preflight passes and the one recovery/manual-refresh operation is explicitly confirmed, publish once.
5. Reopen or refresh the ChatGPT App and confirm the readonly tools share the candidate fingerprint. If they do not, stop with the stable error code; do not retry indefinitely.

Do not use the legacy Workbench control or legacy default-profile CLI commands as a fallback. Their separate ledger-`0011` preflight/publish/recovery acceptance is still pending.

Never loop Unified publish attempts. On failure, keep the receipt and stable error code; do not print the response body or DPAPI material.

## Readonly data interpretation

- `operational_state` is the canonical shared state for Storyboard, Generation, Review and blockers.
- Missing identifiers are `null` in public DTOs, not ambiguous empty strings.
- Review `not_started` differs from `pending`: pending means reviewable media exists.
- A project can be visible only when the current issuer-bound principal has an active membership.
- A changed `snapshot_fingerprint` means the Widget must clear combined views before loading new data.

## Media preview status

The media UI and Local Gateway code exist. One isolated MP4 fixture has passed the Unified Workspace Remote public Cloudflare route and ChatGPT Widget playback. A forward seek was playable, but no actual `206`/`Content-Range` response was recorded, so byte-range remains pending. This is not normal-production media readiness. Today:

- do not treat the accepted fixture path as a general normal-ChatGPT media-preview guarantee;
- do not install the Gateway login task;
- do not weaken Origin, capability, digest or membership checks to make playback work;
- use `npm run media:status` only during an authorized media test.

In the accepted fixture path, playback remains readonly and on-demand: opening a media card requests a five-minute single-use capability and creates at most a 30-minute in-memory session. It never grants directory access. An actual byte-range response, expiration/replay, revocation, project switching, recovery and the fixture/restore logical-manifest comparison remain separate gates.

The legacy Full WebGPT media listener and the new Readonly Media Gateway both use local port 2092. Never run them together. The accepted fixture route is Unified Workspace Remote plus Local Gateway, not local Full profile. The legacy Remote Readonly App `/mcp` route is a rollback surface and was not covered by this Unified fixture acceptance.

## Common recovery

### Workbench is not ready

```powershell
npm run windows:status
npm run preflight
npm run db:check -- --read-only
```

The default writable `npm run db:check` may recover staged media activations and move files. Use it only in an explicitly authorized recovery workflow. Do not run `db:migrate` as a generic repair; migration is an explicit, backed-up activity-database operation.

### ChatGPT says no Snapshot

For the accepted Unified App, follow one explicitly confirmed Unified-profile preflight/publish from [UNIFIED_CHATGPT_WORKSPACE_TRANSPORT_RUNBOOK.md](webgpt/UNIFIED_CHATGPT_WORKSPACE_TRANSPORT_RUNBOOK.md#snapshot-operations). This is expected after Render Free sleep/restart or after 24 hours. Do not use the legacy `系统 → 只读 App 发布` recovery control on the active database; its separate re-acceptance remains pending.

### OAuth reconnects automatically to the wrong user

The accepted baseline is owner-only. Second-user acceptance is deferred; do not interpret an automatic existing session as a passed multi-user test.

### Gateway/Tunnel is offline

Keep the seven ordinary readonly tools available. Media failure must not make project text/status tools unavailable. Run `media:status`, then stop unless the current test explicitly authorizes restart.

## Never put these in chat, logs or Git

Token, cookie, raw subject, principal hash, DPAPI plaintext, Cloudflare connector token, capability key, Provider payload, database business rows, local media paths or full Snapshot bodies.

For installation and external configuration, use [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md).
