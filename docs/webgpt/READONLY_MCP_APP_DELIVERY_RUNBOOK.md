# Readonly MCP App Delivery Runbook

Status: `SCHEMA_GATE_PASS` on current `main`. Auth0/ChatGPT/Render wiring and manual Snapshot recovery passed Jenn single-user acceptance on the earlier ledger `0008` baseline; the active database separately completed the `0010` migration gate on 2026-07-22. That does not yet renew current-main publishing evidence. This document does not authorize further Render, DNS, Auth0 or ChatGPT mutations.

Live boundary: the accepted service currently has Render Free behavior, not an always-on production SLA. Process restart clears the only in-memory Snapshot and requires one explicit Human Workbench republish. The tracked `render.yaml` remains configuration evidence and must not be used as proof of live plan/settings.

## Boundaries

- The local SQLite workspace remains the only source of truth.
- The current publisher opens the database through the existing readonly exporter and requires ledger `0010`; the active database now meets that schema prerequisite, but no publish was performed as part of the migration.
- The remote service holds one signed Snapshot in memory and has no database or persistent disk.
- Publishing is manual. No scheduled task, Windows auto-start, Provider, media or write tool is enabled.
- Runtime profiles, DPAPI material and receipts live under ignored `data/webgpt/publisher/` paths.

## Local profile and key

Copy `docs/webgpt/readonly-publisher-profile.example.json` to an ignored location such as:

```text
data/webgpt/publisher/profile.json
```

Fill only the approved non-secret issuer, remote origin and local paths. Do not commit the runtime profile.

Create the Ed25519 publisher key once. The private PKCS#8 bytes are protected with Windows DPAPI `CurrentUser`; the plaintext private key is never written or printed.

```powershell
npm run webgpt:publisher:keygen -- --profile data/webgpt/publisher/profile.json
```

The command prints only `key_id` and the public-key SHA-256. Configure the public PEM as base64 in the remote `WEBGPT_CLOUD_PUBLISHER_PUBLIC_KEY_B64`; it is verification material, not a secret.

## Preflight and manual publish (historical; renewed acceptance pending)

```powershell
npm run preflight:webgpt:publisher -- --profile data/webgpt/publisher/profile.json
npm run publish:webgpt:snapshot -- --profile data/webgpt/publisher/profile.json
```

On current `main`, preflight requires ledger `0010`, which the active database now satisfies. A new publish/recovery still needs its own bounded acceptance: preflight validates the ledger, exports through a readonly connection, verifies the DPAPI key pair, signs the strict Snapshot and reports only counts/fingerprint/time metadata. Publish uses `PUT /snapshot`, disables redirects, does not send credentials and does not read the remote response body. Each attempt writes a sanitized append-only receipt.

## Personal readonly operations (historical; renewed acceptance pending)

The local Human Workbench exposes the same frozen publisher through `系统 → 只读 App 发布`. It uses the Git-ignored profile selected by:

```text
WEBGPT_READONLY_PUBLISHER_PROFILE_PATH=data/webgpt/publisher/profile.json
```

If the variable is absent, the path above is the default. The browser never supplies or receives the profile path, database path, resource URL, key material or response body.

- Status checks only profile/key/database file availability, sanitized local receipt metadata and the public remote `/healthz`/`/readyz` projection. It does not export business rows or unlock the private key.
- The freshness projection marks a fresh Snapshot with at most two hours remaining as `renewal_due`, and maps `no_snapshot` or expiry to `restoration_required`. Remote failures produce a check-only recommendation. The 60-second UI status poll never exports or publishes.
- Once a bounded publish/recovery acceptance is separately authorized, `运行预检` performs the ledger-`0010` readonly export and DPAPI signature check without a remote write or receipt.
- Once that acceptance is separately authorized, `预检并发布/续期/恢复` are labels for the same protected operation: Workbench action nonce plus explicit human confirmation, serialized execution, the same preflight and one `PUT /snapshot`.
- Remote errors are reduced to stable codes and HTTP status. No remote response body, business content or local path is returned to the UI.

This is still manual publishing. It does not schedule publishes, start Windows automatically or change Render/Auth0/ChatGPT configuration.

## Render delivery contract

`render.yaml` records the original one-instance/no-disk/auto-deploy-off delivery contract and still names `starter`. The accepted live route was later constrained to Render Free. Do not apply the Blueprint or change the live plan without a new external authorization. A new isolated service must separately authorize creation and set:

```text
WEBGPT_V4_RESOURCE_URL
WEBGPT_V4_READONLY_OAUTH_ISSUER
WEBGPT_V4_READONLY_OAUTH_AUDIENCE
WEBGPT_V4_READONLY_OAUTH_JWKS_URI
WEBGPT_V4_READONLY_OAUTH_CLIENT_REGISTRATION=predefined
WEBGPT_CLOUD_PUBLISHER_KEY_ID
WEBGPT_CLOUD_PUBLISHER_PUBLIC_KEY_B64
```

DNS must point the approved App origin to Render before Auth0 callback and ChatGPT App wiring. `resource_url` and OAuth audience must be the exact external `/mcp` URL. Render `/healthz` is liveness; `/readyz` remains `503` until OAuth, publisher verification material and a fresh Snapshot are all present.

## Accepted owner-only stage and future rollback

The owner-only Auth0, DNS, ChatGPT App, fixture/activity Snapshot, seven-tool and Human Workbench recovery path is accepted. Any replacement service or new App must repeat this sequence rather than inheriting that acceptance: create with auto deploy disabled, verify HTTPS, configure only `projects.read`, test a fixture Snapshot first, then stop on the first OAuth/signature/scope/render failure.

Rollback disables the new ChatGPT test App and Render service. It does not delete historical Auth0 objects, DPAPI keys, receipts or authorization evidence. Activity-database migration and publishing require separate current authorization.
