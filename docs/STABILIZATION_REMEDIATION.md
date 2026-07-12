# Stabilization Remediation — Implementation Baseline

Date: 2026-07-12
Applies to: the `0.1.0-beta.2` code snapshot on `main@fbba4ce` and its closeout documentation
Status: planned; external connection is blocked

## Decision

The Beta 2 closeout remains a useful, tested code snapshot. It is **not** the release decision for Auth0, Secure MCP Tunnel, public media, automatic startup, or a real Provider canary.

An independent review identified integrity and contract gaps in the local production path. This remediation replaces external connection work as the next route. No external gate may be opened until every release gate in this document has passed through a new local acceptance run.

## Non-goals and hard boundaries

- Do not configure Auth0, Secure MCP Tunnel, public HTTPS/media, or Windows automatic startup.
- Do not perform a real or paid Provider call.
- Do not add WebGPT V5, Workbench V3, or a Provider.
- Do not read or change Jenn's active database during implementation. Database migration design and tests use disposable or copied fixtures only.
- A later active-database migration requires a separate concrete preflight, a backup, and Jenn's current explicit authorization.

## Target invariants

1. A media byte sequence is identified by an immutable content checksum. Reusing that content never changes an existing Artifact's project or SHOT scope.
2. An Artifact's project/SHOT scope is immutable after creation. A project/SHOT reference is created or changed only through one validated, transactional attach operation.
3. Workbench pricing, intent preparation, and Provider submission use the same declared capability and price-key contract.
4. A media Artifact is active only after the stored bytes, declared metadata, and media-type validation agree.
5. Every public or Workbench workflow that accepts an Artifact verifies its precise project and SHOT scope; delivery readiness verifies usable artifacts rather than IDs alone.
6. The canonical local test command and Windows CI execute every safety-relevant suite.

## Delivery sequence

Each delivery is one independently reviewable PR based on the latest green `main`. SR0 is documentation-only and uses diff validation. Every implementation delivery after SR0.5 must pass its scoped tests, `npm run typecheck`, `npm run build`, canonical `npm test`, and `npm run secret:scan` before the next delivery begins.

### SR0 — route correction and remediation taskbook

Record the Beta 2 snapshot accurately: local capability exists, but its external-connection release decision is blocked on this remediation. This PR changes documentation only.

### SR0.5 — test-selection gate

Before changing Artifact, Provider, or media behavior, make the existing safety suites part of the required baseline.

- Add named test commands for `tests/m1-provider-boundary.test.ts` and `tests/provider-env-secret-safety.test.ts`; add both commands, `test:memory`, and `test:source-audit` to canonical `npm test`.
- Add separate named Windows CI steps for those suites, retaining the existing named steps for failure diagnosis.
- Add a meta-test that independently fails when any declared safety suite is omitted from canonical `npm test` **or** from Windows CI; presence on one surface never satisfies the other.

Acceptance is a clean Windows run and intentional fixtures proving each declared suite is selected by both the local canonical command and Windows CI. SR1–SR4 may not start until SR0.5 is merged.

### SR1 — immutable blobs and atomic Artifact binding

Separate content identity from production ownership.

- Introduce a content-addressed `MediaBlob` record: checksum, byte size, detected MIME/type, storage location, integrity state, and immutable creation provenance.
- Retain `MediaArtifact` as the production object: one artifact ID, immutable project/SHOT scope, role, status, metadata, and a reference to one blob. `project_id` and `shot_id` are never updateable after its creation.
- Deduplicate only blobs by checksum. Importing identical bytes into another project or SHOT creates a new target-scoped Artifact that references the existing Blob; it never rewrites another Artifact's project, SHOT, role, or JSON payload.
- Replace direct reference mutation with one `attachArtifactToShot`/equivalent domain operation. It accepts only an already target-scoped, active Artifact and transactionally updates the target SHOT reference; it never changes Artifact ownership. A required target-scoped object is created through `createScopedArtifactFromBlob`, not by re-homing an Artifact.
- Define explicit project-scoped and shot-scoped roles. A project-scoped final artifact cannot satisfy a SHOT clip reference; a SHOT artifact cannot silently become another SHOT's clip.
- For existing databases, treat relational binding columns (`artifact_id`, `project_id`, `shot_id`, `role`, `artifact_type`, `status`) as authoritative and require matching JSON projections before migration. A mismatch fails closed as `ARTIFACT_STRUCTURED_DRIFT`; migration never guesses or silently rewrites either side.
- Create a transactionally recorded Artifact-to-Blob mapping with pre-migration backup, row/count/hash evidence, and fresh-fixture migration tests. Blob content facts are derived from verified local bytes, not copied from legacy JSON. A missing/non-local/unverifiable source is migrated only as non-active `unverified` evidence and cannot satisfy a workflow reference until separately verified; it is never guessed into a verified Blob. No active database migration is run in this PR.

Acceptance includes cross-project checksum reuse, cross-SHOT reuse, concurrent binding attempts, failed binding rollback, and WebGPT/Workbench reads after each case.

### SR2 — shared Provider capability and pricing contract

Create one typed, versioned local capability registry for each supported Provider/model route.

- The registry owns provider name, route/model identifier, allowed resolutions and durations, defaults, request projection, and price-cache key construction.
- Workbench price estimation, WebGPT generation-intent preparation, validation, and submission consume that same registry; no caller owns a literal model name or default resolution.
- Cache lookup uses a normalized capability-derived key and fails closed when a requested capability is absent or priced differently.
- Replace fixtures that manually encode stale price-cache keys with registry-derived fixture builders.

Acceptance includes the current RunningHub route/defaults, invalid capability combinations, stale-price rejection, and a proof that intent, estimate, and submit produce the identical key.

### SR3 — media activation and integrity verification

Make stored bytes part of the safety boundary.

- Use a persistent activation journal/state machine with `staged`, `file_placed`, `committed`, and `failed` states. The journal persists the expected checksum, size, detected type, pending/final paths, and sanitized Blob/Artifact creation data needed for deterministic recovery. Validate bytes in an app-controlled staging path, calculate SHA-256 and size, record the expected content/path before rename, then place the file into a non-active pending location.
- Only the final SQLite transaction that creates/verifies the Blob and Artifact may mark the pending file active. Startup recovery and `db:check` reconcile every non-terminal journal record by completing a verified commit or quarantining it with a stable error; a crash cannot silently make an unrecorded file active.
- Validate images by decoding content, not only magic/header fields. Validate videos with the established media probe before marking an Artifact active.
- Provider upload and generation-input paths recompute content facts and compare them with the registered blob before use.
- Extend `db:check` with controlled hash/size verification for local active media, symlink/escape rejection, and explicit integrity error classes. Remote URLs remain metadata-only and may not be treated as locally verified bytes.
- Registration failures leave neither an active file without a record nor a record claiming an unverified file; journal recovery cases are first-class acceptance tests.

Acceptance includes tampered bytes, wrong MIME/extension, malformed image/video, interrupted activation, missing file, symlink, and a successful verified provider-input dry run without a network call.

### SR4 — reference guards, truthful readiness, and legacy regeneration retirement

Close workflow paths that still accept an Artifact merely because it belongs to the same project.

- Require expected Artifact ID, project, SHOT, role/type, and active integrity state for review notes, review packages, proposals, regeneration, acceptance, delivery, and assembly readiness.
- Make readiness report failed checks with stable reasons; it must not report a project ready solely because reference strings are non-empty.
- Account for all serialized response payload, including embedded/base64 content, in result-budget enforcement. Prefer grants/references over embedded media where the public contract permits it.
- Retire or adapt the old in-process RunningHub regeneration path so it uses the persisted worker and injected credentials; it may not bypass the job/lease/manual-reconciliation boundary.

Acceptance includes same-project wrong-SHOT attempts, inactive/tampered artifacts, archived projects, stale references, oversized media responses, malformed image bodies, missing credentials, worker restart, and unknown Provider outcomes.

### SR5 — regression matrix expansion

Make safety tests mandatory rather than merely available.

- Add the SR1–SR4 fault-injection and migration-copy suites to the appropriate unit/integration lanes.
- Extend the SR0.5 selection meta-test to cover every new remediation suite and preserve named CI steps for failure diagnosis.

Acceptance is a clean Windows Node 22 + FFmpeg 8.1.2 CI run, browser smoke, secret scan, and an intentional failing fixture proving the added suites are actually selected.

### SR6 — local release re-acceptance

After SR1–SR5 merge, rerun the local production acceptance in two stages:

1. Disposable database/copy: backup, migration, integrity check, isolated restore, no paid Provider call.
2. Active database only after separate authorization: exact preflight, migration backup, `db:check`, read-only golden path, restart recovery, and bounded soak observation.

The final report must record command results, database logical manifest before/after where applicable, readiness state, and the explicit absence of external connection or Provider execution. It must not include secrets, raw business rows, media, or Provider payloads.

## Exit gates

External connection work can be proposed only when all of the following are true:

- SR1–SR5 are merged with green Windows CI and browser smoke.
- No direct mutable Artifact re-homing path remains in active code.
- Provider capability keys have one source of truth and all price/intent/submit contract tests pass.
- Local media integrity tests and `db:check` prove detection of content drift.
- Cross-SHOT and cross-project reference attacks fail closed in Workbench and WebGPT paths.
- The legacy regeneration route cannot perform a live submission outside the persisted job boundary.
- SR6 has passed with fresh evidence and no real Provider call.

Only then may Jenn decide whether to authorize a separate Auth0 + Secure MCP Tunnel readonly connection plan. Public media, write scopes, automatic startup, and a real Provider canary each remain separate gates.
