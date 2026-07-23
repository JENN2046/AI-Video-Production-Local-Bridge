# Unified ChatGPT Workspace MCP Contract

Status: `CANDIDATE — PR3 local runtime complete; external wiring remains gated`

The intended primary ChatGPT connector is a single `AI Video Production Workspace` App at:

```text
https://aivideo.skmt617.top/workspace/mcp
```

It will use one OAuth resource and two separately fail-closed internal capability chains:

```text
Unified Workspace Remote
├─ Readonly: signed in-memory Snapshot, never a remote SQLite connection
└─ Director: authenticated outbound Local Workbench Bridge
```

The accepted Readonly route at `/mcp` remains a rollback surface. This document
does not authorize creation of an Auth0 API, a ChatGPT App, a Render deployment,
or any runtime configuration change.

## Local runtime routes

`npm run start:webgpt:workspace` starts the candidate host process. It has no
SQLite connection, local-path access, Provider execution path, or persistent
remote storage. Its routes are:

```text
GET   /healthz
GET   /readyz
GET   /.well-known/oauth-protected-resource/workspace/mcp
POST  /workspace/mcp
PUT   /workspace/snapshot
POST  /director/bridge/v1/poll
POST  /director/bridge/v1/complete
```

When the legacy Readonly configuration and its separate publisher verification
material are also present, the same process additionally serves its existing
`/mcp`, PRMD, and `/snapshot` routes. The two routes keep separate OAuth
audiences and separate in-memory Snapshot stores, so a signed Snapshot cannot
be replayed across the Connector boundary.

The unified route remains discoverable when exactly one internal chain is
available. Snapshot-dependent tools fail closed when the unified Snapshot is
missing or expired; Director tools return `DIRECTOR_BRIDGE_UNAVAILABLE` until
the authenticated local Bridge has a current poll lease. The render tool may
still return its low-disclosure empty shell in either condition.

## OAuth configuration contract

The unified route has an independent, all-or-nothing configuration group:

```text
WEBGPT_WORKSPACE_RESOURCE_URL=
WEBGPT_WORKSPACE_OAUTH_ISSUER=
WEBGPT_WORKSPACE_OAUTH_AUDIENCE=
WEBGPT_WORKSPACE_OAUTH_JWKS_URI=
WEBGPT_WORKSPACE_OAUTH_CLIENT_REGISTRATION=
WEBGPT_WORKSPACE_PUBLISHER_KEY_ID=
WEBGPT_WORKSPACE_PUBLISHER_PUBLIC_KEY_B64=
```

All identifiers must be credential-free HTTPS URLs. `RESOURCE_URL` and
`AUDIENCE` must match exactly; the resource must differ from both legacy
Readonly and Director resources. A blank example does not enable the route.

The fixed scope catalog is:

```text
projects.read
media.read
proposals.write
```

The same catalog is the source for protected-resource metadata, tool security
descriptors, and runtime OAuth challenges in the later remote-runtime PR.

`WEBGPT_WORKSPACE_PUBLISHER_PUBLIC_KEY_B64` is Ed25519 verification material
for the independent unified Snapshot store. The corresponding private key stays
in the existing DPAPI-protected publisher profile; no key material is loaded
from this repository or written by the remote runtime.

## Tool visibility and authorization

The future connector exposes exactly twelve model-visible tools:

| Chain | Tools | Required scopes |
| --- | --- | --- |
| Readonly | `render_ai_video_workspace_app` and six readonly data tools | `projects.read` |
| Director read | `get_director_focus`, `get_director_context`, `get_director_proposal_status` | `projects.read` |
| Director frames | `inspect_director_video_frames` | `projects.read media.read` |
| Director proposal | `submit_director_proposal` | `projects.read proposals.write` |

`get_readonly_media_playback` is Widget-only. It is deliberately excluded from
the model-visible directory and remains unavailable until the separate Media
Gateway external gate passes.

No tool in this contract approves a Proposal, compiles or submits a Provider
job, overwrites an Artifact, delivers media, or commits memory.

## External gates

The following remain separate, explicitly authorized external work:

1. Auth0 API/resource and user-delegated grant creation.
2. Independent Bridge-key provision through DPAPI and Render secret storage.
3. Render deployment and the unified ChatGPT test App.
4. Isolated and then activity-database acceptance.

Until those gates pass, this repository contract is a testable candidate only.

## Local verification

The mandatory `test:webgpt:workspace` lane now includes the isolated unified
runtime test. It proves the exact 12 model-visible tools plus the App-only
media tool, path-aware PRMD, no-Snapshot shell, independent Director bridge
failure, signed unified Snapshot delivery, and legacy `/mcp` rollback route.
`test-selection-gate`, canonical `npm test`, and the named Windows CI step all
select the lane.
