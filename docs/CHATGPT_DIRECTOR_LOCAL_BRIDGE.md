# ChatGPT Director Local Bridge

Status: `PARTIALLY ACCEPTED` — the Unified Director transport, ledger `0011`
activity database and one bounded owner Proposal path are accepted. The managed
Windows Bridge lifecycle described below is an isolated-fixture candidate; the
currently running local Bridge has not yet been restarted under it.

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
WEBGPT_DIRECTOR_BRIDGE_KEY_B64=        # Remote only: Render secret
WEBGPT_DIRECTOR_BRIDGE_KEY_DPAPI_PATH= # Local Bridge only: ignored DPAPI ciphertext
```

The key must decode to exactly 32 bytes. The Remote runtime explicitly accepts only `WEBGPT_DIRECTOR_BRIDGE_KEY_B64` from its secret store; the local Bridge explicitly accepts only and decrypts the ignored `WEBGPT_DIRECTOR_BRIDGE_KEY_DPAPI_PATH` under DPAPI `CurrentUser`. A plaintext key in the local process, a DPAPI pointer in the Remote, or incomplete/mixed configuration fails closed. It is a dedicated bridge credential and must not be committed, printed, copied into docs or reused as a Snapshot/media key.

The local process additionally requires:

```text
WEBGPT_DIRECTOR_REMOTE_ORIGIN=
AI_VIDEO_WORKSPACE_DB_PATH=
```

The remote origin must be an exact credential-free HTTPS origin. The database must already be at `workbench-v2-6` / migration ledger `0011`; the bridge never migrates it.

Public commands:

```text
npm run start:director:remote
npm run start:director:bridge
npm run director:bridge:status
npm run director:bridge:stop
npm run director:bridge:key-import
npm run test:webgpt:director
npm run test:windows-runtime:director-bridge
```

Runtime secrets continue to come from explicit process environment or a separately authorized Git-ignored profile. The repository does not auto-load `.env`.
For future authorized Remote wiring, create and store the shared 32-byte Base64 key in the approved Remote secret-management flow as Render's `WEBGPT_DIRECTOR_BRIDGE_KEY_B64`. Then run `npm run director:bridge:key-import` and enter that exact key directly from the approved secret source through its hidden prompt to create local DPAPI `CurrentUser` ciphertext. The repository deliberately has no plaintext export or clipboard-transfer command: clipboard history and cloud synchronization cannot be cleared reliably. Configure only the non-secret local pointer `WEBGPT_DIRECTOR_BRIDGE_KEY_DPAPI_PATH` for `start:director:bridge`.
The PR3 local bridge refuses to start when `REAL_PROVIDER_ENABLED=true`; Provider execution belongs to the later bounded-orchestrator gate.

## Managed Windows runtime candidate

`start:director:bridge` is now the managed Windows entrypoint. Before building
or launching it:

- fails closed if any of the three Provider execution flags is `true`, forces
  all three to `false` for the child, and rejects any inherited plaintext local
  Bridge key before build or launch;
- refuses a new launch when it discovers the configured Bridge entrypoint as
  either the absolute managed two-argument Node command or the strict
  historical relative two-argument form without consistent managed state;
- requires Node.js 22, no tracked changes in `src`, `scripts`, `package.json`,
  `package-lock.json` or `tsconfig.json`, and no untracked files under `src` or
  `scripts`;
- optionally verifies the operator-supplied 40-character commit for both a
  new launch and an already-running managed instance;
- builds with output suppressed, then records the tracked-source commit,
  SHA-256 fingerprints for the Node executable and Bridge entrypoint, and a
  deterministic manifest of `dist/src` plus `dist/scripts`;
- binds the exact Node/entrypoint argv and a low-disclosure digest of the
  canonical Remote origin, database path, DPAPI pointer, key ID and disabled
  Provider gates;
- starts in `starting`, writes managed state, verifies the child identity, and
  only then sends an instance-bound activation receipt. The real child cannot
  load its DPAPI key/database or poll the Remote before that activation.

The Node process writes an atomic, instance-bound heartbeat every five seconds.
It contains timestamps, phase, source/build/launch fingerprints, bounded
stable error codes and `completion_pending`; `status` derives heartbeat and
authenticated-poll freshness from those timestamps. It never contains a
Bridge key, DPAPI path, database path, Remote origin, actor, project, tool
input/output or response body. `status` reports only a low-disclosure
whitelist and returns `RESTART_REQUIRED` on tracked-source, emitted-build,
Node, derived-argv or launch-configuration fingerprint drift,
`STATE_CONFLICT` on PID/start/path/exact-command process-identity mismatch,
and `NOT_READY` for stale/unhealthy transport state. `RUNNING` means
transport-ready only; it is not database, Focus or business readiness.

Stop remains outbound-only. The manager writes an instance-bound sentinel; the
Bridge checks for stop immediately before handler invocation and returns
`DIRECTOR_BRIDGE_STOPPING` when the sentinel is already observed, while an
already-running handler is allowed to finish. This file check is not an atomic
interlock with an external sentinel write. `completion_pending` is set before
handler invocation and cleared only after Remote `202`; a completion that has
not received that acknowledgement is retained in memory and retried before any
new poll. Within the broker's bounded five-minute in-memory acceptance window,
the Remote accepts an identical completion retry idempotently and rejects a
conflicting one; expiry or Remote restart makes a later retry unconfirmed
again.
Only an instance-matching final heartbeat with `phase=stopped`,
`stop_requested=true` and `completion_pending=false` is reported as graceful.
The default path never uses `Stop-Process`. A drain timeout or unconfirmed
completion does not delete receipts, report graceful, or force-kill a
still-running child; it returns a stable failure instead of claiming a clean
stop. A later start also fails closed when a missing process left a valid
`completion_pending=true` heartbeat.

The mandatory isolated smoke uses a fake Node child under a unique ignored
workspace runtime root and requires an explicit `-FixtureMode`; ambient
environment cannot switch the public command into fixture mode. It exercises
the activation handshake, exclusive lifecycle lock, repeat-start identity,
all three Provider flags, plaintext-key rejection, an actual copied-entrypoint
fingerprint change, stale-PID start recovery and final-heartbeat non-forced
stop. Synthetic key/database/origin strings are used only to verify
low-disclosure receipts; the fake child does not load a DPAPI key/database,
contact a Remote or call a Provider. A separate real-entrypoint unit test stops
the child before activation and confirms that key/database inputs were not
loaded.

## Current evidence and remaining gates

The mandatory Director lane covers signed-envelope tampering/replay/expiry,
exact tool scopes, remote-to-local end-to-end MCP calls,
issuer/project/Focus binding, zero-write frame analysis, immutable Proposal
persistence, idempotency conflict, completion retry/deduplication, remote
module-graph detachment from SQLite/local media paths and managed-runtime unit
contracts. The fake-child PowerShell lifecycle runs separately through
`test:windows-runtime:director-bridge`; canonical `npm test` and Windows CI
chain it after the Workbench runtime smoke. `test-selection-gate` verifies the
named test/catalog/CI wiring; it does not itself execute the PowerShell smoke.

Accepted through the bounded owner path:

- Human Workbench Focus controls, Proposal queue, current Focus/context
  binding and one native `storyboard_revision` left in `pending_review`,
  described in the dated [Unified Director handoff](HANDOFF_2026-07-28_UNIFIED_DIRECTOR.md).
  No approval, Grant compilation or execution was performed.

Implemented in the local PR5 candidate, but not yet externally accepted:

- Approved Proposal compilation, immutable Automation Grant and bounded verified-capability local orchestration, described in [CHATGPT_DIRECTOR_BOUNDED_ORCHESTRATOR.md](CHATGPT_DIRECTOR_BOUNDED_ORCHESTRATOR.md). Real Provider execution remains disabled by default and requires its external gate.

Implemented in the local PR6 candidate, but not externally accepted:

- a replaceable, project-bound advisory memory Recall Port and a non-dispatched Saveback envelope, described in [CHATGPT_DIRECTOR_MEMORY_PORT.md](CHATGPT_DIRECTOR_MEMORY_PORT.md). The default port is disabled; it does not connect a memory plugin or commit memory.

Still deferred:

- live restart of the current Bridge under the manager at the intended source
  commit and emitted-`dist` fingerprint, plus live malformed-Proposal
  negative-path acceptance;
- external memory-port acceptance and any Saveback dispatch;
- any further deployment/OAuth/configuration change or real Provider call.

The accepted positive transport path must not be widened into a claim that the
current local process is already managed, that Memory is connected, or that
Provider execution is authorized.
