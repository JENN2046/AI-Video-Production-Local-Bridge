# Readonly ChatGPT MCP App Workbench v1

Planning baseline: `main@e9002bd3b7fe88cf5ee2e767074293894320bb25`

This taskbook defines the sequential implementation of a real Readonly ChatGPT MCP App Workbench. The local workspace remains the only source of truth. A remote service may consume only a signed, expiring, strict readonly projection.

## Frozen architecture

```text
Local workspace
  -> strict readonly projection
  -> signed ephemeral snapshot
  -> remote OAuth MCP server
  -> MCP Apps resource and render tool
  -> ChatGPT iframe workbench
```

Readonly exposes six data tools plus `render_ai_video_workspace_app`. Media bytes, write tools, Provider execution, anonymous access and automatic publishing remain out of scope.

## Database boundary

The exporter requires schema `workbench-v2-5` with migration ledger `0008`. It opens SQLite read-only, validates the complete schema ledger before reading business tables, and never migrates automatically. A database below `0008` fails with `READONLY_PROJECTION_SCHEMA_MIGRATION_REQUIRED`.

The accepted Jenn activity database remains at ledger `0007`. It must not be opened by the exporter. Any future activity-database migration requires a separate authorization, migration-before backup, `db:check`, isolated restore verification, logical-manifest comparison and rollback evidence.

## Delivery order

1. **Readonly Projection Contract** — `ReadonlyDataSource`, SQLite/Snapshot adapters, Snapshot V1, six-tool DTO parity, issuer-bound project allowlist, forbidden-field checks, zero-write evidence, JCS fingerprint and server-time contract.
2. **Remote MCP Runtime and Signed Snapshot Transport** — Auth0 PKCE, OAuth challenges, signed in-memory replacement, TTL, readiness, rate limits and low-disclosure stdout events.
3. **MCP Apps UI Resource and Workbench** — the v1 resource, render tool, bridge, panels, empty/error/expired states, CSP and browser-state isolation.
4. **Publisher, Render Delivery and CI** — DPAPI publisher key, exporter/publisher preflight, Render packaging, Apps smoke and delivery runbooks.

Each PR starts from the latest accepted `main` after the previous PR is merged and green. A changed `main` requires a read-only drift audit of public contracts, migration requirements and test selection before implementation continues.

## Snapshot V1

The Snapshot contains only validated public DTO projections and opaque issuer-bound authorization mappings. Its fingerprint is 64-character lowercase SHA-256 over RFC 8785/JCS canonical JSON, excluding the fingerprint itself and future transport/signature fields. The publisher computes it; every consumer must recompute and compare it before use.

The Snapshot is limited to 8 MiB and a maximum TTL of 24 hours. `server_now`, `age_seconds` and `ttl_remaining_seconds` are server-derived. Service-side expiration remains authoritative.

## Mandatory tests

Two independent public lanes are mandatory:

```text
npm run test:webgpt:cloud
npm run test:webgpt:app
```

Both commands must be selected by canonical `npm test`, Windows CI and `test-selection-gate`. The gate also pins concrete safety cases so a test file cannot silently leave its required lane.

## Closeout states

Only after single-user external acceptance may closeout record:

```text
JENN_SINGLE_USER_MCP_APP_PASS
MANUAL_PUBLISH_OPERATIONAL_READY
PARTIAL_MULTI_USER_GATE
```

This route does not claim `PERSONAL_READONLY_PRODUCTION_READY`, automatic synchronization, public App Directory readiness or multi-user completion.

## PR2 remote runtime contract

The remote runtime is database-free. It starts with no Snapshot, keeps at most one verified Snapshot in memory, and returns `503` from `/readyz` until OAuth, the Ed25519 publisher verification key, and a fresh Snapshot are all present. Restarting the process returns it to `no_snapshot`.

The publish surface is `PUT /snapshot`. A publisher sends a strict `readonly-snapshot-envelope-v1` containing the finalized Snapshot, key id, Ed25519 signature and no credentials. The signature covers a domain-separated JCS representation of the complete finalized Snapshot. A replacement is accepted only after schema, fingerprint, TTL, key id and signature verification; an older Snapshot cannot replace a newer one, while an identical signed Snapshot is idempotent.

The remote `/mcp` surface exposes only the six `projects.read` data tools in this stage. OAuth failures return the HTTP challenge and `mcp/www_authenticate` metadata without business data. `/healthz` means process liveness only. Runtime stdout events are restricted to low-disclosure operational fields and never include identity, project identifiers, tool arguments/results or Snapshot content.

## PR4 delivery contract

The Windows publisher uses an Ed25519 private key protected by DPAPI `CurrentUser`, a Git-ignored runtime profile and sanitized append-only receipts. It runs the strict ledger-`0008` readonly exporter, signs one Snapshot and sends only the envelope to `PUT /snapshot` with redirects disabled and no credentials. Publishing remains a manual operator action.

The tracked Render Blueprint defines one always-on `starter` instance, no persistent disk and `autoDeployTrigger: off`. It is configuration evidence only: this repository change does not create a Render service, DNS record, Auth0 object or ChatGPT App. External delivery follows `docs/webgpt/READONLY_MCP_APP_DELIVERY_RUNBOOK.md` under separate authorization.
