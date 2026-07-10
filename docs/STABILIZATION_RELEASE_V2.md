# Stabilization Release v2 Taskbook

Target: `0.1.0-beta.1`  
Audience: Jenn local Windows production  
Baseline: `d38b69b`

## Outcome

Produce one clear, recoverable and continuously verified local production path without adding a new Workbench version, WebGPT version or Provider.

## Delivery sequence

1. Beta identity and release baseline.
2. Windows Node 22 and FFmpeg 8.1.2 CI.
3. Active module seams, V2-only routes and legacy execution retirement.
4. Explicit database migrations, backup and integrity checks.
5. Persistent generation jobs and audited manual reconciliation.
6. Bounded media analysis, readiness, preflight and unified acceptance.

Each delivery is an independent PR. A PR must build and pass its relevant tests before the next PR is based on it.

## Non-goals

- WebGPT V5 or Workbench V3
- New Provider integration
- Anonymous MCP access
- Auth0 tenant configuration
- Secure tunnel or public HTTPS deployment
- Windows service/automatic startup
- Real paid Provider calls during acceptance
- Rebuilding every existing JSON-backed table in one release

## Release gates

- Windows Node 22 CI passes typecheck, build, unit, MCP integration, UI, browser smoke and secret scan.
- Existing `workbench-v2-4` database copies can be backed up, migrated, checked and restored in isolation.
- Unknown Provider submission never triggers automatic resubmission.
- Provider completion updates local business state transactionally.
- FFmpeg analysis uses a bounded queue and content-aware cache.
- Workbench and WebGPT expose truthful, distinct liveness and readiness states.
- Legacy routes are absent from the active server and historical evidence is not compiled.

## Authorization gates

Before implementation performs a bulk historical file move or migrates Jenn's active database, it must provide a concrete preflight and obtain current explicit authorization. Test migrations operate only on disposable databases.

