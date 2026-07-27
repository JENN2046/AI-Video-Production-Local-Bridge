# User Guide

Status: `UNIFIED_TRANSPORT_AND_SCHEMA_PASS`. The owner-only `0.1.0-beta.5` / ledger `0008` workflow remains historical evidence; the active database has now completed `0011`, and the bounded Unified Director owner path has passed. An isolated Media Gateway MP4 fixture playback/Range path has also passed; broader Media, Provider, Memory and multi-user gates remain separate.

## Current-main database compatibility

Current code requires `workbench-v2-6` / ledger `0011`, and the active database has passed that migration and bounded runtime acceptance. Runtime startup still never migrates a database automatically. The accepted path does not authorize Provider execution, automatic Snapshot publishing, Memory saveback or production delivery.

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

- service and Snapshot freshness;
- authorized production projects;
- project context and next action;
- SHOT operational state;
- Review, Delivery and Closeout panels.

The banner “当前数据来自只读快照” is intentional. ChatGPT reads the last published Snapshot, not live SQLite rows.

Allowed actions are view, refresh, select project, expand SHOT, switch detail and copy a sanitized summary. Project edits, review adoption, Provider calls and Snapshot publishing are not App actions.

## Snapshot operations (manual; renewed run still requires confirmation)

The states and UI flow below include historical ledger-`0008` evidence and the accepted current-schema Unified flow. The remote has no persistent Snapshot storage: do not invoke a publish, renewal or recovery action without the separate human confirmation required for that one operation.

Snapshot status has four useful states:

| State | Meaning | Action |
|---|---|---|
| `fresh` | Current Snapshot is usable | No action |
| `renewal_due` | Less than two hours remain | Publish once when convenient |
| `no_snapshot` / `snapshot_expired` | Remote memory is empty or expired | Run one explicit recovery publish |
| `service_unavailable` | Remote health cannot be confirmed | Stop; do not repeatedly publish |

Preferred UI flow:

1. Open Workbench `系统 → 只读 App 发布`.
2. Read the low-disclosure status.
3. Choose `运行预检`.
4. If it passes, choose the single confirmed publish/renew/recover action.
5. Reopen or refresh the ChatGPT App and confirm all seven readonly tools share one fingerprint.

CLI fallback:

```powershell
npm run preflight:webgpt:publisher -- --profile data/webgpt/publisher/profile.json
npm run publish:webgpt:snapshot -- --profile data/webgpt/publisher/profile.json
```

Never loop publish attempts. On failure, keep the receipt and stable error code; do not print the response body or DPAPI material.

## Readonly data interpretation

- `operational_state` is the canonical shared state for Storyboard, Generation, Review and blockers.
- Missing identifiers are `null` in public DTOs, not ambiguous empty strings.
- Review `not_started` differs from `pending`: pending means reviewable media exists.
- A project can be visible only when the current issuer-bound principal has an active membership.
- A changed `snapshot_fingerprint` means the Widget must clear combined views before loading new data.

## Media preview status

The media UI and Local Gateway code exist. One isolated MP4 fixture has passed the public Cloudflare route, ChatGPT Widget playback and forward Range/seek. This is not normal-production media readiness. Today:

- do not treat the accepted fixture path as a general normal-ChatGPT media-preview guarantee;
- do not install the Gateway login task;
- do not weaken Origin, capability, digest or membership checks to make playback work;
- use `npm run media:status` only during an authorized media test.

In the accepted fixture path, playback remains readonly and on-demand: opening a media card requests a five-minute single-use capability and creates at most a 30-minute in-memory session. It never grants directory access. Expiration/replay, revocation, project switching, recovery and the fixture/restore logical-manifest comparison remain separate gates.

The legacy Full WebGPT media listener and the new Readonly Media Gateway both use local port 2092. Never run them together; the accepted ChatGPT App route uses the Remote Readonly App plus Local Gateway, not local Full profile.

## Common recovery

### Workbench is not ready

```powershell
npm run windows:status
npm run preflight
npm run db:check -- --read-only
```

The default writable `npm run db:check` may recover staged media activations and move files. Use it only in an explicitly authorized recovery workflow. Do not run `db:migrate` as a generic repair; migration is an explicit, backed-up activity-database operation.

### ChatGPT says no Snapshot

Run one Human Workbench preflight/publish. This is expected after Render Free sleep/restart or after 24 hours.

### OAuth reconnects automatically to the wrong user

The accepted baseline is owner-only. Second-user acceptance is deferred; do not interpret an automatic existing session as a passed multi-user test.

### Gateway/Tunnel is offline

Keep the seven ordinary readonly tools available. Media failure must not make project text/status tools unavailable. Run `media:status`, then stop unless the current test explicitly authorizes restart.

## Never put these in chat, logs or Git

Token, cookie, raw subject, principal hash, DPAPI plaintext, Cloudflare connector token, capability key, Provider payload, database business rows, local media paths or full Snapshot bodies.

For installation and external configuration, use [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md).
