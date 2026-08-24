# Readonly MCP App Delivery Runbook

Status: `HISTORICAL_ACCEPTANCE_AND_REVALIDATION_BOUNDARY`. Auth0/ChatGPT/Render wiring and manual Snapshot recovery passed Jenn single-user acceptance on earlier schema baselines. Canonical source and the current publisher now require `workbench-v2-7` / ledger `0012`; the activity runtime's last explicitly accepted boundary is `workbench-v2-6` / ledger `0011`, so it does not satisfy the current-main publisher gate. Publishing, renewal and recovery remain unavailable until separate `0012` admission and runtime/publisher acceptance. This document does not authorize database migration or further Render, DNS, Auth0 or ChatGPT mutations.

Live boundary: the accepted service currently has Render Free behavior, not an always-on production SLA. Process restart clears the only in-memory Snapshot and requires one explicit Human Workbench republish. The tracked `render.yaml` remains configuration evidence and must not be used as proof of live plan/settings.

## Boundaries

- The local SQLite workspace remains the only source of truth.
- The current publisher opens the database through the readonly exporter and requires `workbench-v2-7` / ledger `0012`. The activity runtime's last accepted `workbench-v2-6` / `0011` boundary does not satisfy that current-main gate. No automatic publish follows from migration or historical transport acceptance.
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

## Legacy preflight and manual publish (`0012` admission and re-acceptance pending)

```powershell
npm run preflight:webgpt:publisher -- --profile data/webgpt/publisher/profile.json
npm run publish:webgpt:snapshot -- --profile data/webgpt/publisher/profile.json
```

On current source, preflight requires `workbench-v2-7` / ledger `0012`; the activity runtime's last accepted `0011` boundary fails that gate. After a separately authorized `0012` admission, preflight validates the ledger, exports through a readonly connection, verifies the DPAPI key pair, signs the strict Snapshot and reports only counts/fingerprint/time metadata. The commands above must not be used against the activity database until both that database and this legacy profile have current-main preflight/publish/recovery acceptance. Historical Unified `/workspace` evidence does not authorize this external write.

## Personal readonly operations (legacy rollback surface; acceptance pending)

The local Human Workbench exposes the same frozen publisher through `系统 → 只读 App 发布`. It uses the Git-ignored profile selected by:

```text
WEBGPT_READONLY_PUBLISHER_PROFILE_PATH=data/webgpt/publisher/profile.json
```

If the variable is absent, the path above is the default. The browser never supplies or receives the profile path, database path, resource URL, key material or response body.

- Status checks only profile/key/database file availability, sanitized local receipt metadata and the public remote `/healthz`/`/readyz` projection. It does not export business rows or unlock the private key.
- The freshness projection marks a fresh Snapshot with at most two hours remaining as `renewal_due`, and maps `no_snapshot` or expiry to `restoration_required`. Remote failures produce a check-only recommendation. The 60-second UI status poll never exports or publishes.
- The activity runtime's last accepted boundary is ledger `0011`, while current source and publisher require ledger `0012`. `运行预检` and `预检并发布/续期/恢复` therefore remain unavailable through this legacy Workbench surface until separate `0012` admission and current-main publisher acceptance complete.
- A bounded Unified publish/recovery acceptance exists only for the separately configured Unified profile and `/workspace` Snapshot store. It does not authorize this legacy profile, and does not authorize automatic, scheduled, or unreviewed publication.
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

## Historical owner-only stage and future rollback

The owner-only Auth0, DNS, ChatGPT App, fixture/activity Snapshot, seven-tool and Human Workbench recovery path is historical accepted evidence. The activity runtime's last accepted boundary is ledger `0011`; current source requires `0012`, and the older `0010` baseline is historical only. This evidence does not create continuing or replacement-service publishing authority: any replacement service or new App must repeat this sequence rather than inheriting that acceptance: create with auto deploy disabled, verify HTTPS, configure only `projects.read`, test a fixture Snapshot first, then stop on the first OAuth/signature/scope/render failure.

Rollback disables the new ChatGPT test App and Render service. It does not delete historical Auth0 objects, DPAPI keys, receipts or authorization evidence. Any future activity-database migration and each publishing operation require their own current human authorization/confirmation.
