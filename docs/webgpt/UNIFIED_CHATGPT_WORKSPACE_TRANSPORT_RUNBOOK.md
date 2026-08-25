# Unified ChatGPT Workspace Transport Runbook

Status: `HISTORICAL_EXTERNAL_TRANSPORT_AND_ACTIVITY_GOLDEN_PATH_PASS — retain this runbook as commit-scoped evidence and a future revalidation boundary. Current-main execution requires separate ledger 0014 admission and runtime acceptance.`

This is the operational companion to the [Unified Workspace contract](../UNIFIED_CHATGPT_WORKSPACE_MCP.md). The bounded Auth0, Render, ChatGPT App, Bridge and activity-database stages described here have passed once. It remains the recovery and revalidation boundary; it does **not** authorize a new Auth0, Render, ChatGPT, DNS, database or Provider change.

Current-state override: canonical source requires
`workbench-v2-9` / ledger `0014`; the activity runtime's last accepted boundary
remains `workbench-v2-6` / ledger `0011`. Earlier external PASS results remain
bounded to their recorded commits, and the Bridge lifecycle narrative below is
historical rather than current runtime status. Do not start or recover a Bridge
against current main until the target database has separate `0011 → 0014` admission
and the exact source/runtime combination is accepted.

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

The public directory has 12 model-visible tools. Widget-only `get_readonly_media_playback` is excluded from the model directory and fails closed when its separate Media Gateway configuration is absent or invalid. A bounded isolated MP4 fixture has passed Widget playback; no actual byte-range response was recorded, and byte-range plus the remaining Media Gateway recovery/revocation gates are separate. The Widget can read only low-disclosure Director Focus status; it cannot approve a Proposal, compile a Grant, submit a Provider job, adopt a Clip, deliver media or commit memory.

## Stage 0 — read-only external preflight

Complete this stage before creating anything. Record only a sanitized result; never record token values, subjects, unselected callback values or secret configuration.

1. Confirm the existing Native/public application has a strict exact callback allowlist, public-client PKCE and no M2M/client-secret path.
2. Confirm Auth0 has capacity for one new API/resource with the exact unified `/workspace/mcp` identifier.
3. Confirm legacy `/mcp` health, PRMD, challenge and Readonly login are unchanged.
4. Confirm Render can host the additional path without replacing the legacy runtime during the acceptance window.
5. Confirm ChatGPT can install one test App and that any callback it generates can be added as exactly one allowlist entry.
6. Historical precondition: the activity database was ledger `0010` before its separately authorized `0011` migration. The activity runtime's last accepted boundary is ledger `0011`; do not rerun, downgrade or treat the historical precondition as a current readiness check.

Any mismatch is a stop condition. Do not reuse the legacy resource, broaden callbacks, enable M2M, share a key or change database schema to make preflight pass.

## Stage 1 — explicitly authorized external wiring

This stage needs a separate current authorization. Make only these bounded changes, in order:

1. Create one Auth0 API named `Jenn AI Video Workspace Unified` with the exact HTTPS identifier `https://aivideo.skmt617.top/workspace/mcp` and only the three fixed scopes.
2. Add only that API's user-delegated grant to the existing Native/public application. Do not create a new application, client secret or M2M grant.
3. Create and store the independent shared 32-byte Base64 Bridge key in the approved Remote secret-management flow as Render's `WEBGPT_DIRECTOR_BRIDGE_KEY_B64`. Then use `npm run director:bridge:key-import` to enter that exact value directly from the approved secret source through a hidden local prompt and create only DPAPI `CurrentUser` ciphertext. The repository has no plaintext export or clipboard-transfer command: replacing the current Windows clipboard does not reliably clear clipboard history or cloud synchronization. Configure the local Bridge only with the non-secret `WEBGPT_DIRECTOR_BRIDGE_KEY_DPAPI_PATH` pointer.
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
WEBGPT_DIRECTOR_REMOTE_ORIGIN
AI_VIDEO_WORKSPACE_DB_PATH
```

The dedicated `WEBGPT_DIRECTOR_BRIDGE_KEY_B64` is a secret, not ordinary runtime configuration: retain it only as a local DPAPI-protected value and a Render secret. The Remote runtime rejects a DPAPI pointer and receives the Base64 value only as a Render secret; the local Bridge rejects the Base64 value and receives only `WEBGPT_DIRECTOR_BRIDGE_KEY_DPAPI_PATH` to decrypt under DPAPI `CurrentUser`. Never place the Base64 value in a preflight, receipt, status command, log, process arguments, or repository file.

All-or-nothing configuration is intentional. A partial OAuth, publisher or bridge group fails closed. `WEBGPT_DIRECTOR_REMOTE_ORIGIN` is the exact unified public HTTPS origin for the outbound local bridge, not a filesystem path or local listener. `AI_VIDEO_WORKSPACE_DB_PATH` is injected only into the local Bridge process. Historical acceptance used `workbench-v2-6` / ledger `0011`; any current-main revalidation must instead use an authorized isolated or activity database separately admitted at `workbench-v2-9` / ledger `0014`. Do not place its value in receipts, logs, process arguments, or repository files.

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

The Bridge is outbound-only and has no inbound local port or Scheduled Task.
The commands below are the current operator path. A separately authorized
controlled restart adopted the managed Bridge at `fbf6540` on 2026-07-29; see
the
[managed restart acceptance](../../ops/reports/2026-07-29-managed-director-bridge-restart-acceptance.md).
That accepted process was later stopped for an authorized `2b43f558`
activation attempt. The new child did not establish authenticated Remote
contact and was cleaned up by the manager, so the Bridge is currently stopped.
Do not repeat the first-adoption procedure; use the normal managed recovery
path after the diagnostic repair passes CI.

Historical first-adoption note: before the completed first managed start, the
operator independently identified the legacy Bridge by PID, start time and
command line, stopped it gracefully through the previously accepted operation,
and confirmed no absolute or relative
`dist/scripts/director-local-bridge.js` Node process remained. This paragraph
is retained only as migration evidence. Reuse it only if independent evidence
shows a genuinely unmanaged legacy process; do not apply it to the accepted
managed `fbf6540` process.

The next restart gate is limited to diagnosing or recovering Remote contact
with the low-disclosure startup receipt, then accepting the merged
cross-terminal configuration-identity behavior. It still requires separate
authorization and exact merged source/build verification.

Start the managed Bridge only for an accepted isolated or activity-database
stage:

```powershell
npm run start:director:bridge
npm run director:bridge:status
npm run director:bridge:stop
```

It polls the exact `WEBGPT_DIRECTOR_REMOTE_ORIGIN` at the unified Bridge paths.
A current authenticated poll makes the Remote Director chain transport-ready;
it does not prove database, Focus or business readiness and does not change the
Readonly Snapshot's freshness. A fresh managed `start` requires the complete
non-secret launch configuration. Once a managed Bridge is already healthy, an
operator may run `status` or repeat `start` from a new terminal that has none
of the four non-secret launch variables. In that case the manager still checks
process identity, source, emitted build, Node executable, argv and heartbeat;
it reports `configuration_identity=not_rechecked` rather than pretending that
the launch-configuration digest was recomputed. A healthy `status` therefore
returns `RUNNING`, and a repeat `start` returns `ALREADY_RUNNING` without a
rebuild, key operation or second child process.

For a rejected poll, both the Unified Workspace Remote and the dedicated
Director Remote project only the allowlisted authentication classes
`DIRECTOR_BRIDGE_AUTH_INVALID` and `DIRECTOR_BRIDGE_AUTH_EXPIRED` in the
low-disclosure `x-director-bridge-auth-class` response header. A signature is
verified before an expired class can be projected. The local Bridge maps the
two classes to `DIRECTOR_BRIDGE_POLL_AUTH_INVALID` and
`DIRECTOR_BRIDGE_POLL_AUTH_EXPIRED`. A missing, unknown or malformed header
remains `DIRECTOR_BRIDGE_POLL_AUTH_REJECTED`; the client does not consume or
report the response body.

`configuration_identity=verified` means all four variables were supplied and
the low-disclosure configuration digest matched the managed state. Supplying
only part of that tuple fails closed with
`DIRECTOR_BRIDGE_LAUNCH_CONFIGURATION_INCOMPLETE`; it is not a health result.
When the complete tuple is present, any digest mismatch, including an
allowlisted startup-environment drift such as `TEMP`, still produces
`RESTART_REQUIRED`. `stop` uses the selected runtime root and persisted
managed identity; it does not read the Bridge key or database.
If a fresh start reaches
`DIRECTOR_BRIDGE_RUNTIME_HEARTBEAT_TIMEOUT`, preserve the complete JSON result.
An optional `child_error_code` contains only a validated, instance-bound
`DIRECTOR_*` enum captured before cleanup. It does not contain raw error text,
an origin, credential identifier, path, payload or provider response. The
manager-level `stable_error_code` remains the controlling result; omission of
`child_error_code` means no safe child diagnostic was available.
Poll rejection diagnostics remain enum-only: authentication, route, request
body, content type, busy, redirect, other client rejection and Remote failure
are distinguished without reading or returning the response body or numeric
HTTP status.
End a bounded stage with `npm run director:bridge:stop`. Only that stop command
returning `result=STOPPED`, `graceful=true` and `final_receipt=true` in the
same response is graceful-stop evidence. A later standalone `status` result of
`STOPPED` is not equivalent. Timeout or unconfirmed completion preserves
receipts and must not be reclassified as a clean stop.

If the Widget reports the bridge as unavailable, preserve the low-disclosure stable error code, stop the bounded test and check only the configured origin, current ledger, exact keyring completeness and Remote readiness under the authorized stage. Do not retry indefinitely, fall back to the old Director endpoint, publish a Snapshot to compensate, add an inbound listener or enable a Provider.

## Stage 2 — isolated owner golden path

The recorded historical Stage 2 used an isolated database at ledger `0011`. Do not repeat that instruction against current main. A future revalidation must use an independently admitted `workbench-v2-9` / ledger `0014` database. The Stage 1 deployed HTTPS Unified Remote must remain available at the exact configured `WEBGPT_DIRECTOR_REMOTE_ORIGIN`; do not start `npm run start:webgpt:workspace` locally for this step, because that local test host is HTTP and is not a valid Bridge origin. Start the local Bridge only for an explicitly authorized bounded test:

```powershell
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

This historical stage was separately authorized and started with the `0010` → `0011` migration gate: stop relevant processes, backup, logical manifest, isolated migration, `npm run db:check -- --read-only`, restore rehearsal, manifest comparison and only then the authorized activity migration. The recorded activity-database operation completed this gate; do not rerun it, and no automatic down migration is allowed.

After migration, run one single-owner golden path:

```text
Focus -> advisory Proposal -> human decision -> controlled Artifact receipt
```

The receipt may revalidate already-registered local Artifact bytes and digest, but never accepts, stores or exposes a source path, external URL or file bytes from ChatGPT. Core historical records and Artifacts must not be rewritten.

### Recorded Stage 3 result

The authorized activity-database run completed the `0010` → `0011` migration
gate and then a single-Owner Focus → Context → advisory Proposal → Human
Workbench decision → controlled Artifact receipt path. The receipt was matched
to an already registered active Artifact and revalidated its digest; no source
path, URL or byte payload was accepted or retained. The run created no Grant,
Provider request, generation job, Artifact overwrite, delivery action or Memory
write.

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
