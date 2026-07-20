# Readonly Local Media Gateway Runbook

Status: code-complete candidate; external Cloudflare, Render secret, DNS and Windows logon-task acceptance remain separate gates.

## Boundary

The gateway keeps media bytes on Jenn's Windows machine. The remote MCP App can request one encrypted, five-minute capability for an Artifact already present in Snapshot v4. The local gateway revalidates issuer-bound membership, Artifact/Blob ownership, approved media-root containment and file SHA-256 before returning an opaque handle. A first `GET` consumes that handle and creates an in-memory playback session lasting at most 30 minutes.

The gateway listens only on `127.0.0.1:2092`. Cloudflare Tunnel is the sole planned public ingress for `https://media.skmt617.top`. This route does not change `https://aivideo.skmt617.top`, does not store bytes in Cloudflare, and does not enable directory listing, analysis, writes or Provider calls.

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

Before external playback acceptance, create an isolated MP4 fixture with `npm run media:fixture:create -- -InputPath <mp4> -Issuer <issuer> -ResourceUrl <resource>`. The wrapper reads the Auth0 `user_id/sub` through a masked prompt, never places it on the command line, copies rather than modifies the source MP4, and creates a fresh ledger-`0008` database plus managed media under Git-ignored `data/webgpt/media-acceptance/`. It prints only a random run ID and boolean checks. Verify the result with `npm run media:fixture:verify -- --run <run_id> --issuer <issuer> --resource <resource>`; verification is read-only and emits only counts and stable checks. Neither command publishes a Snapshot or starts the Tunnel.

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

Before promoting to `0.1.0-beta.6` / `webgpt-v4.4.0` / `readonly-remote-v1.1.0`, complete all external gates:

1. Create one shared capability key in the approved secret-management flow, configure the Render secret, and import that exact value locally with `media:capability-key-import`.
2. Create the named Tunnel and exact DNS route without paid features.
3. Deploy the accepted Snapshot v4/remote runtime commit and publish one real Snapshot v4.
4. Validate image and MP4/WebM playback, Range/seek, expiration, replay, membership revocation, gateway offline/recovery and project switching in ChatGPT.
5. Install and validate the current-user logon task only after separate authorization.
6. Compare the activity-database logical manifest, run `db:check`, and complete a bounded soak.

Until those checks pass, package/service versions remain at the currently accepted beta.5 baseline. The code path is present but media externalization and Windows auto-start are not claimed as accepted.

## Rollback

Stop the managed runtime, remove/disable only the new logon task and media route, clear only the new Render media secret/config, deploy the previously accepted remote commit, and republish Snapshot v3 if required. Never delete local media, rewrite authorization evidence, modify the activity database, or weaken OAuth/scope/integrity checks to recover availability.
