# Readonly Local Media Gateway Runbook

Status: CANDIDATE. Code, Snapshot v4 media binding, Remote/Gateway key contract, Cloudflare named-tunnel/DNS setup and Windows operations have progressed through bounded stages. One isolated MP4 fixture has passed instance-bound public routing and ChatGPT Widget playback. The repository now includes a two-project Image/MP4 fixture and a low-disclosure acceptance matrix, but its public maintenance-window run, recovery soak, fixture/restore activity-database logical-manifest comparison and Windows logon-task acceptance remain incomplete.

Latest known boundary: `main@2b84f44` completed a bounded isolated-fixture public route and ChatGPT MP4 playback acceptance. A playable forward seek was observed, but no actual `206`/`Content-Range` response was recorded, so byte-range remains pending. The Gateway remains manually operated: this result does not establish restart persistence, revocation behavior, broad media-format coverage, unchanged activity business data across the fixture/restore sequence, or a Windows logon-task acceptance.

## Boundary

The gateway keeps media bytes on Jenn's Windows machine. The remote MCP App can request one encrypted, five-minute capability for an Artifact already present in Snapshot v4. The local gateway revalidates issuer-bound membership, Artifact/Blob ownership, approved media-root containment and file SHA-256 before returning an opaque handle. A first `GET` consumes that handle and creates an in-memory playback session lasting at most 30 minutes.

The gateway listens only on `127.0.0.1:2092`. Cloudflare Tunnel is the sole planned public ingress for `https://media.skmt617.top`. This route does not change `https://aivideo.skmt617.top`, does not store bytes in Cloudflare, and does not enable directory listing, analysis, writes or Provider calls.

The legacy local `WEBGPT_V4_PROFILE=full` media listener uses the same port. Full and the Readonly Media Gateway are mutually exclusive; stop Full before preflight/start and never change the Gateway bind address to work around the conflict.

## Frozen local files

Copy [readonly-media-operations-profile.example.json](readonly-media-operations-profile.example.json) to the Git-ignored path:

```text
data/webgpt/media-gateway/profile.json
```

The profile contains identifiers and paths but no plaintext secret. DPAPI CurrentUser protects the dedicated capability key and the Cloudflare Tunnel token in separate files under `data/webgpt/media-gateway/`. Neither secret is accepted on a command line.

Cloudflared is pinned by [cloudflared-windows-amd64.json](../../ops/manifests/cloudflared-windows-amd64.json). Place the downloaded executable at the profile's `executable_path`; `media:preflight` requires both the exact version and SHA-256. Do not enable cloudflared auto-update.

## Commands

The following commands only become operational after the separately authorized profile and secret setup:

```powershell
npm run media:capability-keygen
npm run media:capability-key-import
npm run media:protect-tunnel-token
npm run media:preflight
npm run media:start
npm run media:status
npm run media:stop
npm run media:install-logon-task
npm run media:remove-logon-task
```

`media:capability-keygen` creates a local-only random key and never exposes it. For the Remote MCP/Gateway shared deployment, first create one 32-byte Base64URL secret in the approved secret-management flow, configure that exact value as Render's `WEBGPT_MEDIA_CAPABILITY_ACTIVE_KEY_B64URL`, and run `media:capability-key-import` to enter the same value through a hidden prompt. The import command validates the canonical 43-character form, stores only DPAPI CurrentUser ciphertext, and never prints the key. There is intentionally no plaintext export command. Both commands fail if the protected destination already exists; rotation must use a new reviewed profile path/kid.

`media:preflight` validates the ignored paths, ledger/schema through `db:check`, media roots, DPAPI material, port availability, and the pinned cloudflared binary. It does not start the gateway or Tunnel and does not modify the database.

`media:start` starts the gateway first, waits for local `/readyz=200`, then injects the DPAPI-decrypted token only into the cloudflared child environment. It requires public `/healthz=200` before recording managed state. Failure stops children and does not retry.

`TUNNEL_TRANSPORT_PROTOCOL` accepts only `auto`, `http2`, or `quic` and defaults to `auto`. `media:preflight` rejects any other value with `MEDIA_TUNNEL_PROTOCOL_INVALID`; `media:start` passes the selected value to cloudflared as `--protocol <value>`, and `media:status` reports only that non-secret protocol selection. Changing the protocol of an already-running instance requires an explicit stop and restart.

`media:status` reports only process state, local health/readiness, public health, active capability/session counts, and a stable error code. It never returns paths, media names, principal identifiers, key state or token material.

For the fixed production Workspace origin, the Gateway additionally accepts the exact ChatGPT Workspace sandbox origin required for Widget image/video requests. This is a code-owned, app-specific CORS allowlist entry: it is not a wildcard, does not permit arbitrary `*.oaiusercontent.com` origins, and is not added to custom `allowed_origin` deployments. Continue to keep the profile origin exactly `https://aivideo.skmt617.top`.

Before external playback acceptance, create an isolated two-project Image/MP4 fixture with `npm --silent run media:fixture:create -- -InputPath <mp4> -Issuer <issuer> -ResourceUrl https://aivideo.skmt617.top/workspace/mcp`. The wrapper reads the Auth0 `user_id/sub` through a masked prompt, never places it on the command line, copies rather than modifies the source MP4, and creates a fresh current ledger-`0011` / `workbench-v2-6` database plus managed media under Git-ignored `data/webgpt/media-acceptance/`. Project B receives a fixed 8-byte tail variant, so the source must leave that margin below the Gateway's maximum file size; an input that cannot fit its derived variant is rejected before fixture creation. Each project has a distinct storyboard image and distinct valid MP4 Artifact, so project switching exercises the authoritative Artifact/Blob ownership boundary rather than aliasing one Blob across projects. With the required `--silent` npm invocation, command output contains only a random run ID and boolean checks. Verify the result with `npm --silent run media:fixture:verify -- --run <run_id> --issuer <issuer> --resource https://aivideo.skmt617.top/workspace/mcp`; verification is read-only and emits only counts and stable checks. It joins every manifest project/SHOT/Artifact/Blob back to the isolated database and requires the corresponding Snapshot binding to match project, SHOT, Artifact type, role, MIME type, digest, and active status; a digest match alone is not binding evidence. The generated Unified publisher profile must pair this resource exactly with `https://aivideo.skmt617.top/workspace/snapshot`; legacy `/mcp` → `/snapshot` remains rollback-only.

WebM is not supported by the current authoritative Artifact activation path: video activation requires a validated `video/mp4` Blob. Do not insert a WebM row directly into SQLite or widen the production contract merely to satisfy this acceptance matrix. Record WebM as `NOT_SUPPORTED_BY_ARTIFACT_ACTIVATION` until a separately reviewed product change adds it.

Generate the two temporary runtime profiles from already validated, non-secret templates instead of copying JSON fields manually:

```text
npm --silent run media:fixture:profiles -- --run <run_id> --publisher-template <publisher-profile> --gateway-template <gateway-profile>
```

The generator strictly validates both templates, inherits only configuration and secret *locators*, and replaces only the database, media-root, receipt, and runtime paths with paths inside the isolated fixture. It never opens the referenced DPAPI ciphertext, starts a service, or publishes a Snapshot. It creates `publisher-profile.json` and `gateway-profile.json` under the fixture run with exclusive-create semantics; rerunning against existing outputs fails closed. Run the ordinary publisher and media preflights against those generated profiles before any temporary switch.

After the fixture Snapshot and generated gateway profile are active in the authorized maintenance window, run:

```text
npm --silent run media:fixture:matrix -- -RunId <run_id>
```

The wrapper decrypts the existing DPAPI capability key only in memory and supplies it to the matrix process over stdin; the key is never placed in command arguments or output. The matrix opens `fixture.json` with atomic no-follow semantics where the platform exposes them, then verifies the opened descriptor is the same single-link regular file still named inside the fixture root before reading; descriptor/path identity and `nlink === 1` checks also fail closed on Windows, where Node does not expose `O_NOFOLLOW`. It caps the opened file at 16 KiB before JSON parsing, so a larger local manifest yields `MEDIA_ACCEPTANCE_MANIFEST_TOO_LARGE` without being loaded into memory.

Before any SQLite connection opens, the matrix establishes descriptor leases for the fixture `app.sqlite` and its `-wal` and `-shm` sidecars, requiring each opened descriptor and current path to identify the same single-link regular file inside the fixture root. Alongside the guarded database path, it sends only their fixed-width volume/file identities to the Windows path guard over the helper's private stdin. The guard atomically opens those three existing paths with no-follow handles, read/write sharing but no delete sharing, and compares every opened handle with its expected lease identity before reporting `LOCKED`; it then rechecks all three handles while held. SQLite opens and all queries or mutations occur only while both layers remain valid. An ancestor-junction ABA swap, temporary file replacement, pre-positioned external sidecar, hard link, or reparse point therefore fails as `MEDIA_ACCEPTANCE_ROOT_UNSAFE` instead of binding SQLite to an unleased file. Both the read-only Snapshot exporter and writable revocation connection retain post-open lease checks as defense in depth.

Local media size and MP4-tail checks likewise open the manifest-selected path with no-follow semantics first, require the opened descriptor and current path to identify the same single-link regular file inside the fixture root, and recheck that identity after tail reads; the matrix never hashes a tail obtained through the earlier check-then-open sequence. The matrix checks public `/healthz` and `/readyz`, then uses the fixed ChatGPT Widget sandbox Origin for every capability activation and media request. It requires each media response to echo that exact Origin in `Access-Control-Allow-Origin` and return `Access-Control-Allow-Credentials: true`; Node `fetch` completing alone is not CORS evidence. Every capability, replay, expiry, revocation, or other JSON control response must also carry a Content-Type whose normalized media type is exactly `application/json`, matching the Remote MCP production client; missing or rewritten types fail as `MEDIA_ACCEPTANCE_RESPONSE_INVALID` before parsing. Each successful ordinary capability issuance must return the exact five-minute `expires_at` encoded by its signed request; a shortened response lifetime is not accepted merely because its timestamp is canonical or still in the future. JSON control and error bodies are capped at 16 KiB, Image bodies at their local fixture size, and MP4 bodies at the requested suffix Range length; a larger or unbounded streamed response is cancelled and reported as `MEDIA_ACCEPTANCE_RESPONSE_TOO_LARGE` before it can exhaust matrix memory or reach JSON parsing. Header-only responses, including health, readiness, and capability activation, have their unneeded bodies cancelled before the request deadline is cleared.

The matrix also checks Image `200` with an exact Artifact digest, an actual MP4 suffix `Range` response with `206`/`Content-Range`, expected total length and the current fixture video's distinguishing tail digest, both fixture projects, replay rejection, both a stale request-envelope rejection and an actually issued near-expiry capability handle rejected after its returned `expires_at`, denial of both an existing session and a new capability issuance after membership revocation, and continued access to the unaffected project. Ordinary requests have a 15-second deadline; capability issuance has a 60-second deadline covering the Gateway's 45-second full-file hash limit plus network margin. The whole matrix has an approximately 15-minute-35-second stop condition: eight capability requests, eighteen ordinary requests, the allowed expiry wait, and two minutes for bounded local setup/scheduling. Membership revocation is deliberately last and writes only the isolated fixture database. A success receipt is held in memory until the path guard accepts `RELEASE`, its helper exits cleanly, all three database lease descriptors close, and the overall timer is cleared; any cleanup failure emits only the stable FAIL receipt and leaves stdout empty. Output contains the run ID, booleans, and a stable error code on failure—never capability/session handles, URLs, principal IDs, hashes, paths, headers, response bodies, file identities, or secret material. A local wrapper exception that is not an existing `MEDIA_*` enum is normalized to `MEDIA_ACCEPTANCE_WRAPPER_FAILED`.

Gateway offline/recovery remains an operator-controlled subgate because it changes managed process state. While the fixture runtime is active, load one media session in the existing Unified App, stop the managed fixture Gateway, confirm the existing media fails closed and the UI reports Gateway offline without retaining old media, restart the same fixture profile, confirm `/readyz` and `/healthz`, and request a fresh capability. An old capability or session must not survive the restart. Do not persist its URL or handle as evidence.

Do not capture fixture evidence with ordinary `npm run`: npm echoes the expanded arguments, including source paths and endpoint identifiers, before the wrapper starts. These commands do not publish a Snapshot or start the Tunnel.

`media:install-logon-task` creates `Jenn AI Video Readonly Media Gateway` for Jenn's current interactive user with a 30-second logon delay, `RunLevel Limited`, one instance, and at most three one-minute retries. It does not use `SYSTEM`, Administrator, or a stored Windows password. Installing or removing this task requires a separate current authorization; merging this code does not install it.

## Cloudflare external gate

The separately authorized Cloudflare configuration must create one named tunnel:

```text
jenn-ai-video-readonly-media
```

Published route:

```text
media.skmt617.top -> http://127.0.0.1:2092
catch-all          -> http_status:404
```

Do not enable Access, R2, Workers, Load Balancer, paid plans, wildcard routes, request debug logging, or a route for the local database/media directory. The token must be stored through `media:protect-tunnel-token`; do not place it in a profile, `.env`, command line, Scheduled Task arguments, GitHub, or a receipt.

Render must receive the same dedicated capability key as a secret only after separate authorization. It must not reuse the Snapshot publisher key. Active/previous key rotation is limited to the existing ten-minute compatibility window.

## Acceptance and closeout

The following bounded gate has passed: an isolated signed Unified Snapshot was published, an MP4 fixture played in the ChatGPT Widget, the fixture runtime was stopped, and the managed default runtime plus a fresh real Snapshot were restored. A forward seek remained playable, but no actual `206`/`Content-Range` response was captured; byte-range is not part of this PASS. The post-restore read-only `db:check` passed, but that alone does not prove unchanged activity business data. The exact evidence and non-claims are in [Readonly Media Gateway MP4 Fixture Acceptance](../../ops/reports/2026-07-27-readonly-media-gateway-mp4-fixture-acceptance.md).

Before promoting to `0.1.0-beta.6` / `webgpt-v4.4.0` / `readonly-remote-v1.1.0`, complete all remaining external gates:

1. Run the new two-project matrix through the public route, then validate gateway offline/recovery and project switching in the existing Unified App. Record the selected protocol plus the final QUIC/UDP or HTTP2/TCP edge classification. WebM is currently `NOT_SUPPORTED_BY_ARTIFACT_ACTIVATION`; it is not a missing acceptance result for this baseline.
2. Install and validate the current-user logon task only after separate authorization.
3. Capture a before/after activity-database logical-manifest comparison for the fixture/restore path, then complete a bounded restart/recovery soak and verify the real Snapshot still follows the manual publication/recovery contract.

Until those checks pass, package/service versions remain at the currently accepted beta.5 baseline. The code path and some external objects exist, but media externalization and Windows auto-start are not claimed as accepted.

## Rollback

Stop the managed runtime, remove/disable only the new logon task and media route, clear only the new Render media secret/config, deploy the previously accepted remote commit, and republish Snapshot v3 if required. Never delete local media, rewrite authorization evidence, modify the activity database, or weaken OAuth/scope/integrity checks to recover availability.
