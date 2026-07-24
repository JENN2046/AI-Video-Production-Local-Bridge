# Unified ChatGPT Workspace Transport Runbook

Status: `CANDIDATE — local transport code merged; no unified external wiring or activity-database acceptance has occurred.`

This is the operational companion to the [Unified Workspace contract](../UNIFIED_CHATGPT_WORKSPACE_MCP.md). It describes the preflight, staged acceptance and rollback boundary for one future `AI Video Production Workspace` ChatGPT App. It does **not** authorize an Auth0, Render, ChatGPT, DNS, database or Provider change.

## Target and rollback topology

```text
ChatGPT: one AI Video Production Workspace App
  -> https://aivideo.skmt617.top/workspace/mcp
  -> Unified Workspace Remote
       -> Readonly signed in-memory Snapshot chain
       -> Director outbound local-bridge chain

Historical rollback surface
  -> https://aivideo.skmt617.top/mcp
  -> accepted Readonly Snapshot runtime
```

The two chains fail closed independently. The Remote runtime never opens SQLite, holds a local path or calls a Provider. The local Workbench remains the sole facts and write authority.

Do not remove, repoint or reconfigure legacy `/mcp` while accepting the unified Connector. The runtime rejects a legacy resource URL equivalent to the unified resource URL, including a trailing-slash variant; their OAuth audience and signed Snapshot stores must remain isolated.

## Fixed contract

| Item | Required value or rule |
| --- | --- |
| Unified MCP route | `/workspace/mcp` |
| Unified Snapshot route | `/workspace/snapshot` |
| PRMD | `/.well-known/oauth-protected-resource/workspace/mcp` |
| OAuth resource/audience | Exact credential-free HTTPS `/workspace/mcp` URL; the two values match exactly |
| Scopes | `projects.read`, `media.read`, `proposals.write` |
| OAuth client | Existing Native/public client; Authorization Code + PKCE S256; user-delegated only |
| M2M | Denied |
| Publisher verification | Separate Ed25519 SPKI public key remotely; private key remains DPAPI `CurrentUser` locally |
| Bridge credential | Separate 32-byte HMAC key; never reuse Snapshot or Media capability material |
| Provider | `REAL_PROVIDER_ENABLED=false` throughout all transport acceptance |

The public directory has 12 model-visible tools. Widget-only `get_readonly_media_playback` is excluded from the model directory and remains unavailable until the separate Media Gateway external gate passes. The Widget can read only low-disclosure Director Focus status; it cannot approve a Proposal, compile a Grant, submit a Provider job, adopt a Clip, deliver media or commit memory.

## Stage 0 — read-only external preflight

Complete this stage before creating anything. Record only a sanitized result; never record token values, subjects, unselected callback values or secret configuration.

1. Confirm the existing Native/public application has a strict exact callback allowlist, public-client PKCE and no M2M/client-secret path.
2. Confirm Auth0 has capacity for one new API/resource with the exact unified `/workspace/mcp` identifier.
3. Confirm legacy `/mcp` health, PRMD, challenge and Readonly login are unchanged.
4. Confirm Render can host the additional path without replacing the legacy runtime during the acceptance window.
5. Confirm ChatGPT can install one test App and that any callback it generates can be added as exactly one allowlist entry.
6. Confirm the activity database remains ledger `0010`; it must not be treated as satisfying the current-code ledger `0011` exporter or receipt gate.

Any mismatch is a stop condition. Do not reuse the legacy resource, broaden callbacks, enable M2M, share a key or change database schema to make preflight pass.

## Stage 1 — explicitly authorized external wiring

This stage needs a separate current authorization. Make only these bounded changes, in order:

1. Create one Auth0 API named `Jenn AI Video Workspace Unified` with the exact `/workspace/mcp` identifier and only the three fixed scopes.
2. Add only that API's user-delegated grant to the existing Native/public application. Do not create a new application, client secret or M2M grant.
3. Generate the independent Bridge key. Store its local copy with DPAPI `CurrentUser` and its remote copy as a Render secret; do not print either.
4. Create a local DPAPI publisher profile from `unified-workspace-publisher-profile.example.json`; configure only the matching public verification key remotely. The Remote accepts SPKI public PEM only, never a private PEM.
5. Deploy the unified runtime to the existing public origin while retaining legacy `/mcp` and `/snapshot` as rollback surfaces.
6. Create one ChatGPT test App. Add only its generated exact callback to the existing application if necessary.

Expected non-secret runtime configuration groups are:

```text
WEBGPT_WORKSPACE_RESOURCE_URL
WEBGPT_WORKSPACE_OAUTH_ISSUER
WEBGPT_WORKSPACE_OAUTH_AUDIENCE
WEBGPT_WORKSPACE_OAUTH_JWKS_URI
WEBGPT_WORKSPACE_OAUTH_CLIENT_REGISTRATION
WEBGPT_WORKSPACE_PUBLISHER_KEY_ID
WEBGPT_WORKSPACE_PUBLISHER_PUBLIC_KEY_B64
WEBGPT_DIRECTOR_BRIDGE_KEY_ID
WEBGPT_DIRECTOR_BRIDGE_KEY_B64
WEBGPT_DIRECTOR_REMOTE_ORIGIN
```

All-or-nothing configuration is intentional. A partial OAuth, publisher or bridge group fails closed. `WEBGPT_DIRECTOR_REMOTE_ORIGIN` is the exact unified public HTTPS origin for the outbound local bridge, not a filesystem path or local listener.

## Stage 1 smoke acceptance

Keep `REAL_PROVIDER_ENABLED=false`. The minimum result is:

```text
PRMD readable
securitySchemes match PRMD and the fixed scope catalog
unauthenticated request = HTTP 401 plus WWW-Authenticate
wrong issuer/audience/scope = no business data
12 model-visible tools discover correctly
legacy /mcp remains unchanged
```

The unified route may return an empty Readonly shell without a Snapshot and `DIRECTOR_BRIDGE_UNAVAILABLE` without a current bridge lease. Both are safe states, not reasons to weaken auth or upload an unverified Snapshot.

## Local bridge lifecycle and recovery

The Bridge is outbound-only and has no inbound local port or Scheduled Task. Start it only for an accepted isolated or activity-database stage:

```powershell
npm run start:director:bridge
```

It polls the exact `WEBGPT_DIRECTOR_REMOTE_ORIGIN` at the unified Bridge paths. A current poll lease makes the Remote Director chain available; it does not change the Readonly Snapshot's freshness. Stop the process with its normal console signal when the bounded stage ends.

If the Widget reports the bridge as unavailable, preserve the low-disclosure stable error code, stop the bounded test and check only the configured origin, current ledger, exact keyring completeness and Remote readiness under the authorized stage. Do not retry indefinitely, fall back to the old Director endpoint, publish a Snapshot to compensate, add an inbound listener or enable a Provider.

## Stage 2 — isolated owner golden path

Use an isolated database already at ledger `0011`. Start the local bridge only for this bounded test:

```powershell
npm run start:webgpt:workspace
npm run start:director:bridge
```

```text
owner Focus
-> get_director_context
-> optional inspect_director_video_frames
-> storyboard_revision or clip_regeneration Proposal
-> local Workbench approval or rejection
-> optional Automation Grant compilation
```

Verify immutable Proposal/Grant events, project/issuer/Focus/base-state binding and state-drift rejection. A Provider start must fail closed because the real Provider flag remains false. Do not use the activity database, save memory or import arbitrary file locations in this stage.

## Stage 3 — activity database acceptance

This stage is separately authorized and starts with the `0010` → `0011` migration gate: stop relevant processes, backup, logical manifest, isolated migration, `npm run db:check -- --read-only`, restore rehearsal, manifest comparison and only then the authorized activity migration. No automatic down migration is allowed.

After migration, run one single-owner golden path:

```text
Focus -> advisory Proposal -> human decision -> controlled Artifact receipt
```

The receipt may revalidate already-registered local Artifact bytes and digest, but never accepts, stores or exposes a source path, external URL or file bytes from ChatGPT. Core historical records and Artifacts must not be rewritten.

## Snapshot operations

The unified publisher accepts only this exact pair:

```text
/workspace/mcp -> /workspace/snapshot
```

Copy the example to a Git-ignored profile and use bounded publisher commands only after ledger and acceptance gates pass:

```powershell
npm run webgpt:publisher:keygen -- --profile data/webgpt/publisher/unified-workspace-profile.json
npm run preflight:webgpt:publisher -- --profile data/webgpt/publisher/unified-workspace-profile.json
npm run publish:webgpt:snapshot -- --profile data/webgpt/publisher/unified-workspace-profile.json
```

The Remote stores one signed, 24-hour in-memory Snapshot. Restart or expiry returns a safe empty shell until one explicit, accepted republish. Publishing does not create a bridge lease, and a bridge lease does not make stale Snapshot data readable.

## Acceptance receipt template

Use low-disclosure booleans, stable error codes, versions, timestamps, counts, Snapshot fingerprint and manifest comparison result only:

| Check | Expected evidence |
| --- | --- |
| OAuth | PRMD/security schemes/challenge agree; issuer, audience and scope failures disclose no business data |
| Readonly chain | Snapshot absent/expired fails closed; fresh unified Snapshot has one fingerprint across readonly tools |
| Director chain | Bridge HMAC/replay checks pass; unavailable bridge yields stable denial; no SQLite on Remote |
| Owner flow | Focus, context, bounded frames, advisory Proposal and human decision bind to project and current base state |
| Import receipt | One approved Proposal maps to at most one digest-validated, path-free receipt |
| Provider/memory | Provider calls = 0; memory dispatches = 0 |
| Legacy rollback | `/mcp` health, PRMD and accepted Readonly flow remain unchanged |
| Database | `db:check -- --read-only` PASS and manifest unchanged except authorized immutable Director evidence |

## Rollback

If unified wiring or acceptance fails, stop the unified bridge/runtime, disable only the newly created unified App/API grant/configuration under a separate authorization, and redeploy the previously accepted legacy runtime. Do not delete legacy Auth0 objects, historical authorization evidence, local media or database records. Restore a database only from a separately validated backup; never run an automatic down migration.

## Local verification

```powershell
npm run test:webgpt:workspace
npm run test:webgpt:director
npm run test:webgpt:cloud
npm run test:selection-gate
npm run secret:scan
```

The workspace lane, canonical `npm test` and named Windows CI step select unified contract tests. Passing local tests proves only the candidate contract; it does not authorize an external change or claim transport acceptance.
