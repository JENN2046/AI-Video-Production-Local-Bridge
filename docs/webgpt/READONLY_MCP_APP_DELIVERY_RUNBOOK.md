# Readonly MCP App Delivery Runbook

Status: code-only PR4 runbook. It does not authorize Render, DNS, Auth0 or ChatGPT mutations.

## Boundaries

- The local SQLite workspace remains the only source of truth.
- The publisher opens the database through the existing readonly exporter and requires ledger `0008`.
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

## Preflight and manual publish

```powershell
npm run preflight:webgpt:publisher -- --profile data/webgpt/publisher/profile.json
npm run publish:webgpt:snapshot -- --profile data/webgpt/publisher/profile.json
```

Preflight validates ledger `0008`, exports through a readonly connection, verifies the DPAPI key pair, signs the strict Snapshot and reports only counts/fingerprint/time metadata. Publish uses `PUT /snapshot`, disables redirects, does not send credentials and does not read the remote response body. Each attempt writes a sanitized append-only receipt.

## Personal readonly operations

The local Human Workbench exposes the same frozen publisher through `系统 → 只读 App 发布`. It uses the Git-ignored profile selected by:

```text
WEBGPT_READONLY_PUBLISHER_PROFILE_PATH=data/webgpt/publisher/profile.json
```

If the variable is absent, the path above is the default. The browser never supplies or receives the profile path, database path, resource URL, key material or response body.

- Status checks only profile/key/database file availability, sanitized local receipt metadata and the public remote `/healthz`/`/readyz` projection. It does not export business rows or unlock the private key.
- The freshness projection marks a fresh Snapshot with at most two hours remaining as `renewal_due`, and maps `no_snapshot` or expiry to `restoration_required`. Remote failures produce a check-only recommendation. The 60-second UI status poll never exports or publishes.
- `运行预检` performs the existing ledger-`0008` readonly export and DPAPI signature check without a remote write or receipt.
- `预检并发布/续期/恢复` are labels for the same protected operation: Workbench action nonce plus explicit human confirmation, serialized execution, the same preflight and one `PUT /snapshot`.
- Remote errors are reduced to stable codes and HTTP status. No remote response body, business content or local path is returned to the UI.

This is still manual publishing. It does not schedule publishes, start Windows automatically or change Render/Auth0/ChatGPT configuration.

## Render delivery contract

`render.yaml` freezes one `starter` instance, no disk and `autoDeployTrigger: off`. External Stage 1 must separately authorize service creation and set:

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

## External stages and rollback

1. Create the isolated Render service with auto deploy disabled.
2. Bind DNS and verify HTTPS.
3. Configure the existing approved Auth0 public-client/API relationship without widening `projects.read`.
4. Create a new ChatGPT test App and verify resource/MIME/render bridge.
5. Publish a fixture Snapshot first; do not use the activity database.
6. Stop on the first OAuth, signature, scope or App rendering failure.

Rollback disables the new ChatGPT test App and Render service. It does not delete historical Auth0 objects, DPAPI keys, receipts or authorization evidence. Activity-database migration and publishing require separate current authorization.
