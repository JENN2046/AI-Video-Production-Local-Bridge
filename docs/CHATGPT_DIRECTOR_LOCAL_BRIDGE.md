# ChatGPT Director Local Bridge

Status: `CANDIDATE` — PR3 code and isolated-fixture contract. No Director endpoint is deployed, no activity database is migrated, and no external OAuth object is changed by this document.

## Purpose

The Director runtime keeps ChatGPT as the reasoning surface while the local Workbench remains the fact source and the only place allowed to persist an advisory Proposal:

```text
ChatGPT Director MCP
  -> public OAuth-protected Director Runtime
  -> bounded authenticated request queue
  <- outbound-only local bridge poll
  -> issuer-bound SQLite authorization and current Focus validation
  -> readonly context or frame analysis
  -> immutable advisory Proposal awaiting Human Workbench review
```

The public runtime has no SQLite dependency and no local media path. The local bridge never opens an inbound listener. It polls the remote runtime over an exact HTTPS origin and revalidates the tool scope, input schema, issuer-bound principal, project membership, Focus generation, target binding and current base-state hash before returning data or accepting a Proposal.

This route does not call the OpenAI API, Responses API, Agents SDK or a video Provider.

## Runtime surfaces

The public runtime exposes only:

```text
GET  /healthz
GET  /readyz
GET  /.well-known/oauth-protected-resource/director/mcp
POST /director/mcp
POST /director/bridge/v1/poll
POST /director/bridge/v1/complete
```

`/director/mcp` requires the separate Director OAuth audience and the exact per-tool scopes defined in the fixed five-tool catalog. PRMD, the host-visible standard `securitySchemes`, the compatibility `_meta.securitySchemes`, and runtime `WWW-Authenticate` challenges are generated from the same catalog.

The two bridge routes do not accept OAuth bearer tokens. They accept only short-lived HMAC-SHA256 envelopes signed with a dedicated 32-byte bridge key. Each message binds protocol version, key id, random nonce, issue time and a JCS-canonical body. Invalid signatures, stale messages, replays, malformed keyrings, queue overflow and timeouts fail closed with stable low-disclosure errors. Submit establishes a bounded 30-second queue wait; actual poll/lease refreshes the signed request and starts its execution deadline. Ordinary tools retain a 30-second execution budget; `inspect_director_video_frames` receives a distinct 130-second execution budget so its bounded 120-second local analysis can complete without weakening the other tools. A queued or active frame inspection is exclusive, preventing a single local worker from accepting requests it cannot begin within their stated budget. Readiness remains healthy during a still-valid dispatched lease.

Readiness is strict:

```text
oauth configured
AND authenticated local bridge poll observed within 30 seconds
```

The remote runtime reports neither database details nor local paths. `provider_calls_allowed` remains `false`.

## Local authority checks

Every local tool invocation opens the configured database under the current ledger with the narrowest connection mode:

- Focus, context, status and video analysis use SQLite read-only/query-only connections.
- `get_director_focus` requires an active issuer-bound principal even when no Focus exists.
- Project data requires an active membership for the same issuer and principal.
- Focus id and generation must match the latest non-terminal, unexpired Focus.
- `get_director_context` requires an explicit `proposal_kind`; the kind is part of the authoritative `base_state_hash` and must match the Focus target type.
- Artifact, SHOT, project, role, status, Blob owner and digest bindings fail closed on drift.

Only `submit_director_proposal` opens a write connection. Before its single transaction it recomputes the current target state and requires the caller's `base_state_hash` to match. The local service—not ChatGPT—assigns identity, workspace, project, target, source, hashes and timestamps. The transaction inserts one immutable Proposal and one append-only `submitted` event. An identical idempotency replay returns the existing Proposal; reuse for different content returns `DIRECTOR_IDEMPOTENCY_CONFLICT`.

No path in PR3 approves or executes a Proposal, creates a Generation Intent, calls a Provider, adopts a clip, confirms delivery, commits memory, deletes an Artifact or overwrites a package.

## Video frame analysis

`inspect_director_video_frames` is available only for the video Artifact currently bound to the active Focus and requires `projects.read media.read`.

The local service:

1. validates the active Artifact/Blob/file binding and full file digest;
2. probes the video with local FFprobe;
3. extracts a bounded timestamped JPEG sequence with local FFmpeg;
4. streams the source into a digest-verified private temporary copy, then decodes only that fixed copy instead of reopening a mutable source path or loading the whole video into memory;
5. rejects source videos above 2 GiB, caps returned frame bytes at 12 MiB and aborts the copy/probe/extraction operation after 120 seconds;
6. revalidates Focus, membership, Artifact and bytes after extraction;
7. removes the temporary frame directory;
8. returns image content to the model without writing SQLite.

The test fixture compares the complete logical database manifest before and after Focus, context and frame analysis. The model receives the timestamped images; the Director runtime never exposes an arbitrary file path or directory browser.

## Configuration contract

The following bridge variables are blank-or-complete:

```text
WEBGPT_DIRECTOR_BRIDGE_KEY_ID=
WEBGPT_DIRECTOR_BRIDGE_KEY_B64=
```

The key must decode to exactly 32 bytes. It is a dedicated bridge credential and must not be committed, printed, copied into docs or reused as a Snapshot/media key.

The local process additionally requires:

```text
WEBGPT_DIRECTOR_REMOTE_ORIGIN=
AI_VIDEO_WORKSPACE_DB_PATH=
```

The remote origin must be an exact credential-free HTTPS origin. The database must already be at `workbench-v2-6` / migration ledger `0009`; the bridge never migrates it.

Public commands:

```text
npm run start:director:remote
npm run start:director:bridge
npm run test:webgpt:director
```

Runtime secrets continue to come from explicit process environment or a separately authorized Git-ignored profile. The repository does not auto-load `.env`.
The PR3 local bridge refuses to start when `REAL_PROVIDER_ENABLED=true`; Provider execution belongs to the later bounded-orchestrator gate.

## Current evidence and remaining gates

The mandatory Director lane covers signed-envelope tampering/replay/expiry, exact tool scopes, remote-to-local end-to-end MCP calls, issuer/project/Focus binding, zero-write frame analysis, immutable Proposal persistence, idempotency conflict, and remote module-graph detachment from SQLite/local media paths. It is selected by canonical `npm test`, Windows CI and `test-selection-gate`.

Still deferred:

- PR4 Human Workbench Focus controls, Proposal approval queue and state projection;
- PR5 approved Proposal compilation, immutable Automation Grant and bounded RunningHub-only local orchestration;
- PR6 replaceable memory port, operations, external acceptance and version closeout;
- any deployment, OAuth registration, activity-database migration or real Provider call.

Until those gates pass, this is a reviewable implementation candidate, not a production Director service.
