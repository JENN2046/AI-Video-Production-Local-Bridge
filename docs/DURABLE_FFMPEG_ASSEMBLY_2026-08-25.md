# Durable FFmpeg Assembly — 2026-08-25

## Result boundary

Canonical source advances to migration `0014` / schema `workbench-v2-9` and
replaces the `LEGACY_ASSEMBLY_INCOMPATIBLE` implementation with a durable local
FFmpeg Assembly worker.

This is a source and isolated-fixture result. It does not establish Activity
Runtime acceptance, Provider acceptance, production delivery, Export,
Closeout, or `PRODUCT_COMPLETE`. The activity database's last explicitly
accepted runtime boundary remains migration `0011` / schema
`workbench-v2-6`.

## Public contract

The current Workbench exposes:

```text
POST /api/v2/projects/:id/delivery/assembly/preflight
POST /api/v2/projects/:id/delivery/assembly
```

The start request requires:

```json
{
  "input_fingerprint": "<64 lowercase hex characters>",
  "human_confirmation": true,
  "retry_of_job_id": "<required after failed or interrupted Job>"
}
```

A new Job returns HTTP `202`. Queue persistence and the
`ready_to_assemble → assembling` transition commit before process scheduling.
`setImmediate` is only a same-process startup optimization; it is not a queue
durability guarantee.

The Delivery workspace projects `assembly_preflight`, `active_job`,
`final_versions`, and `current_final_version`. Read operations do not start,
resume, retry a Job, or mutate `last_opened_at`.

## Frozen input identity

The Assembly fingerprint uses canonical JCS and SHA-256 over:

- the Project video specification;
- canonical SHOT order;
- every accepted clip Artifact identity;
- every accepted clip Blob digest;
- SHOT duration and probed source duration.

The worker revalidates the current Project, SHOTs, accepted Artifact bindings,
Blob digests, durations, delivery state, Job state, and fingerprint before
rendering and again before finalization. Drift fails closed and does not update
the Project final pointer.

## Media execution

FFmpeg uses read-only inputs and app-governed per-Job staging with:

```text
-n
30 minute timeout
H.264 video
AAC audio
30 fps
yuv420p
faststart
source metadata and chapter stripping
aspect-preserving scale and pad
generated silence for clips without audio
```

Explicit output dimensions must also agree with the declared Project aspect
ratio within the governed tolerance.

Staging rejects path escape and symbolic-link ancestry. Output must pass
FFprobe facts, codec, dimensions, frame-rate, pixel-format, audio, duration,
digest, and governed media activation checks before becoming an active
`final_video` Artifact.

Final Artifact, Blob, GenerationRun, Project final pointer, Delivery state,
Job terminal state, and immutable Event are committed as one outer database
transaction. Media activation markers are removed only after that transaction
commits.

If the database driver reports an indeterminate commit result, the worker
returns `ASSEMBLY_RECOVERY_REQUIRED` and preserves both the registered media
and staging evidence. It does not mark the Job failed or delete activation
evidence unless rollback was explicitly confirmed.

## Worker and restart semantics

There is globally at most one queued or running Delivery Job.

On process startup, every inherited queued or running Delivery Job is marked
`interrupted`. Assembly delivery returns to `ready_to_assemble`, the prior
fingerprint is cleared, and an immutable terminal Event records whether
recovery evidence exists. Staging is preserved; its absolute path is not
projected or written to the Event.

No automatic retry or resume occurs. A later attempt must:

1. run preflight again;
2. recompute the fingerprint;
3. obtain explicit human confirmation;
4. bind `retry_of_job_id` to the latest failed or interrupted Assembly Job.

## Migration guarantees

Migration `0014` is a new forward-only incremental migration; migration `0012`
and migration `0013` are not modified. It adds Job fingerprint/timestamp facts,
Event state/fingerprint facts, exact Assembly transitions, immutable Job
identity, timestamp and terminal-output guards, and Assembly Event projection
guards. Connection-local Production Mutation Authority is required for every
Assembly/Export Job insert, lifecycle transition, and lifecycle Event. Direct
SQL cannot mint that authority or manufacture delivery projection.

Tests cover checksum/schema expectations, trigger definitions, failed
migration rollback, direct-SQL Job/Event owner rejection, terminal evidence
atomicity, commit-after-apply uncertainty, confirmed rollback, global
single-active enforcement, FFmpeg failure, timeout, input drift, aspect-ratio
drift, output no-overwrite, metadata/chapter stripping, restart interruption,
explicit retry, HTTP `202`, zero-write workspace polling, path safety, real
local composition, and atomic final registration. The previous-version
read-only fixture is a real database migrated through `0013`.

## Remaining gates

The following remain separate and incomplete:

- migration `0015`: Final Review, Export, and Closeout;
- migration `0016`: External Execution Integrity;
- responsive/WCAG acceptance;
- current-main fixture closeout;
- authorized Activity DB `0011 → 0016` migration and Runtime acceptance;
- one real SHOT canary, one real complete loop, and three real Projects.

Therefore this change must not be described as `CODE_COMPLETE_ON_CURRENT_MAIN`
or `PRODUCT_COMPLETE`.
