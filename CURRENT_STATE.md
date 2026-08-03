# Current State

Date (Asia/Shanghai, UTC+08:00): 2026-08-03
Repository baseline: `main@55553cbf2f9bc387beb255cebb8b36bcb2deadbf`

## Repository and CI truth

- PR #104, `fix: classify Director Bridge authentication failures`, merged as
  `3a142bb1aeaf34a506f84b2fa2598a5819203d45`.
- PR #105, `test: add readonly media acceptance matrix`, merged as
  `bc3fa5a0baab81551bcef5dafc6fbc2f710d31f7`.
- PR #106, `docs: freeze scope and record core production readiness`, was
  squash-merged as `b3a108abc8728e89259d0d953e1c638b9ca482ea`.
- PR #108, `fix: bound Provider polling and recover verified Blob storage`, was
  squash-merged as `808d9334a49def7ce858f7c6138af75fed392c5b`.
- PR #109 remains open and unmerged at current head
  `69892d9c51c6fc2259e7689322870ee259a150d9` on
  `codex/blob-recovery-staging-reconciliation`. Its scope is now limited to
  Blob recovery staging, ownership, authority, mutex, path identity and crash
  convergence. The Node engine/preflight compatibility change was removed from
  this PR and is being prepared separately. The latest Blob-only follow-ups
  preserve the published-ownership, truncated-authority, mutex-companion and
  reusable-publication recovery fixes, while `4712f4d` keeps the Windows crash
  fixture deterministic. The latest follow-ups mark a target published at the
  link boundary and roll it back only with persisted ownership/inode proof.
  The
  unpersisted removal-isolation experiment from
  `c39367b` was reverted in `89e0161`; its atomic unlink race requires a
  separate persistent/native design and is explicitly deferred rather than
  expanded into this PR. Predecessor head `2b50105` passed both Windows CI jobs
  in run `30807054533`; exact-head CI and review evidence for the current head
  are tracked separately in PR #109. No merge is authorized. Later thread
  lists in this file are immutable historical state-sync snapshots for earlier
  PR #109 heads, not the current thread set.
- Historical PR #109 remediation snapshots record the earlier exact-target
  cross-database recovery serialization and atomically publishes the low-
  disclosure target authority record. The follow-up candidate also derives
  mutex, authority and stage identity from the canonical physical target and
  removes database-local Blob ids from stage identity; exact-final-head CI and
  review are still required before its review threads may be resolved. Windows
  CI run `30684275229` was superseded after its 8.3 test helper retained output
  quotes; follow-up `94bd81b` normalizes that test output and awaits a new run.
  Run `30684654830` showed the runner emits escaped quotes; `43e5519` extracts
  only the absolute drive path. Exact-head run `30685017849` then passed both
  jobs and Codex review found no new issues at `e290124`, but a full thread audit
  exposed two older unresolved P2 findings. Follow-up `22c9e24` delays authority
  publication until all read-only recovery validation passes and places the
  target-derived stage beside the physical target so placement never crosses a
  filesystem. Exact-head CI `30686707590` passed both jobs, but automatic review
  found that the missing-target guard treated every `~` as a DOS alias.
  Follow-up `0982c61` now rejects only 8.3-shaped names and proves an ordinary
  `final~edited.mp4` can recover. Exact-head CI `30687572904` passed both jobs,
  but final review found that the classifier still admitted punctuation outside
  the real SFN set. Follow-up `d7fbb21` narrows the character set and covers
  `+`, `,`, `;`, `=`, `[` and `]`. Head `7d2fb64` then passed both Windows
  jobs on run `30688801572` attempt 3, but the complete exact-head review/thread
  audit found four remaining ownership and compatibility gaps: recovery
  authority could be published before stage/target validation, an unowned
  deterministic stage could be deleted after that publication, a valid but
  unowned SQLite mutex could be opened and mutated, and this module imported
  `node:sqlite` eagerly. Implementation `15b3bed` now validates all existing
  recovery entries before authority publication, requires prior authority for
  a single-link deterministic stage, authenticates the mutex from its bounded
  SQLite header before opening it, and loads this module's SQLite dependency
  lazily. Head `ed42b2b` passed both Windows jobs on run `30692274008`, but its
  exact-head review found a first-use `EEXIST` race when independent recoveries
  concurrently initialize the same activation directories. Follow-up `d8c6768`
  now treats only concurrent `EEXIST` as a candidate and still performs the
  normal symlink, directory and canonical-root checks before use. Head `5a80ed8`
  passed both Windows jobs on run `30693297405`, but its complete review found
  three additional ownership gaps: persistent target authority alone could
  authorize a later unowned deterministic stage, mutex initialization reopened
  its temporary SQLite file by path, and legacy cleanup could delete the current
  validated source when its filename matched the legacy stage grammar. Follow-up
  `f2c31c5` binds each app-created deterministic stage to an exact companion
  hard-link owner, initializes the empty mutex database through the continuously
  held exclusive descriptor, and excludes the current source from legacy cleanup.
  Exact-head review then found two cleanup-order gaps: an unowned authority or
  mutex final path hard-linked to a deterministic temp could lose that temp
  before its content was authenticated. Follow-up `1710c41` now validates the
  opened final descriptor and complete authority/mutex ownership content before
  removing only the same-inode temp hard link. Subsequent exact-head review found
  three crash/identity gaps and two publication races. Follow-ups `568473c` and
  `e6f1d4b` make the stage-owner-first crash window retryable, bind each SQLite
  connection to its target-specific header identity before any mutating pragma,
  reject DOS-short drift before quarantine, keep validators non-destructive, and
  accept a publisher's safe `nlink 2→1` normalization. New exact-head CI and
  review are required.
- The final PR #106 head passed both `Quality and integration` and
  `Browser smoke`; the squash commit has the same tree as that reviewed head.
- Code and CI PASS establish repository facts only. They do not create a new
  deployment, public maintenance-window, Provider, database, Bridge, Snapshot,
  Memory or production acceptance.

The exact accepted external operation recorded by each historical report
remains bounded to that report's commit, inputs and authorization. A later
commit never inherits an older external PASS automatically.

The retained package and closeout identities remain:

| Identity | Current value |
|---|---|
| Package | `0.1.0-beta.5` |
| MCP service contract | `webgpt-v4.3.0` |
| Single-user product closeout | `JENN_SINGLE_USER_MCP_APP_PASS` |
| Manual Snapshot publishing boundary | `MANUAL_PUBLISH_OPERATIONAL_READY` |
| Multi-user boundary | `PARTIAL_MULTI_USER_GATE` |

These identifiers preserve the current package, schema and closeout contract.
They do not imply a fresh external acceptance for this branch or expand the
scope frozen below.

## Current product truth

The stable product authority remains:

```text
Local Workbench
  -> SQLite ledger 0011
  -> Governed Media Store
  -> Provider Adapter
  -> Generation / Review / Assembly / Delivery
```

SQLite is the business fact source. ChatGPT may inspect bounded context and
submit advisory Proposals, but it is not a second fact source and cannot
approve, adopt or deliver production work.

The active database is current-code compatible at `workbench-v2-6` / migration
ledger `0011`. Runtime startup does not automatically migrate or roll back the
database. `REAL_PROVIDER_ENABLED=false` remains the safe default.

## Capability matrix

| Capability | Current code fact | External or real acceptance | Current decision |
|---|---|---|---|
| Workbench V2 local UI | Storyboard, generation preflight, version review and delivery-readiness views exist | Activity database compatibility accepted at ledger `0011` | Core |
| SQLite and governed media | Migration, Artifact/Blob digest and FFprobe boundaries exist | Ledger `0011` migration/restore evidence remains commit-scoped | Core |
| Current Provider path | Intent, budget, confirmation, bounded polling, manual reconciliation and verified-Blob recovery boundaries exist in `main@808d933` | PR #108 merged with green main CI; open Ready PR #109 bounds recovery staging to one deterministic Blob/target slot, removes generic startup deletion, serializes independent databases by exact target and atomically publishes target authority, but still requires exact-head CI/review; no real Provider or S4 acceptance occurred | Core blocker before S4 |
| Historical R3 Provider path | Execution scripts now reside under `legacy/` | RunningHub real canary, four-shot generation and regeneration completed historically | Feasibility evidence only |
| Review and accepted clips | Version stacks, rejection reasons and human accepted-clip selection exist | Historical R3 review evidence exists | Core; current-path acceptance remains |
| Active assembly/export | Active assembly still contains `placeholder_copy` / mock-fixture behavior; Workbench has no production assembly/export action | No current-main production-path PASS | S6 core gap |
| Historical R3-9O assembly | Historical script used FFmpeg concat and registered a final Artifact | Historical real assembly and closeout passed at their recorded commits | Feasibility evidence only |
| Unified `/workspace/mcp` | Unified Remote and Director tool contracts exist | Earlier bounded transport/activity path passed | Core ChatGPT route; later commits do not inherit that PASS |
| Legacy `/mcp` | Still present | Earlier Readonly acceptance exists | `ROLLBACK_ONLY` |
| Dedicated Director route | Still present beside Unified Director tools | Earlier bounded evidence exists | `ROLLBACK_ONLY` |
| Director Bridge | A managed process was detected with source commit `3a142bb` | The recorded process source predates `main@b3a108a`; no current-main configuration, heartbeat or authenticated-contact acceptance was performed | Do not place before S3/S4 |
| Manual Snapshot | Publisher and signed Snapshot contract exist | Earlier bounded publish/recovery evidence exists | Optional; not an S3/S4 dependency |
| Media Gateway | PR #105 two-project Image/MP4 matrix is in main and CI passed | No corresponding current-main public maintenance-window acceptance | Optional human Widget playback |
| Memory Port | Advisory recall seam and non-dispatched Saveback envelope exist | No stable production plugin or automatic Saveback | Frozen |
| Multi-user | Code-level membership boundaries exist | Second real user path is not accepted | Frozen |
| Windows logon task | Installation code exists | No matching task was detected or accepted | Frozen |
| Automatic Snapshot | Not implemented | Not accepted | Frozen |

## Provider history correction

The repository must not claim that a real Provider canary has never occurred.
The historical R3 route recorded:

- a successful RunningHub real single-submit canary;
- a successful four-shot real generation run;
- a successful four-shot regeneration run;
- local FFmpeg final assembly;
- human final approval and closeout.

Those execution scripts were later moved into `legacy/`. The historical
results prove engineering feasibility, but they do not prove that current
`main`, the current Workbench UI/API, or the ledger `0011` product path has
completed a fresh live acceptance. S3 prepares that current path offline; S4
is the separately authorized real single-shot acceptance.

## Assembly and export status

The active product path has not completed real assembly/export productization
or acceptance. The active assembly implementation still registers mock fixture
behavior through `placeholder_copy`. The Workbench Delivery view reports
readiness but does not provide a production assembly, export and closeout
action.

Historical R3-9O FFmpeg concat evidence is retained as design and feasibility
evidence. Fixture assembly must not be described as a current production
assembly PASS.

## Director Bridge status

A low-disclosure manager status check detected a managed Director Bridge
process whose recorded source commit is
`3a142bb1aeaf34a506f84b2fa2598a5819203d45`.

The recorded manager check returned `RESTART_REQUIRED` on the earlier
repository baseline, and its source commit still predates current
`main@b3a108a`. This restack did not start, stop or restart the Bridge. It did
not revalidate configuration identity, heartbeat or authenticated Remote
contact. Therefore the repository must not claim that the Bridge is stopped,
healthy, Remote-connected or accepted on current main.

The accepted `fbf6540` restart report and the later `2b43f558` diagnostic-gap
report remain historical, commit-scoped evidence.

## Media Gateway status and role

PR #105 added the two-project Image/MP4 acceptance fixture and low-disclosure
matrix to `main`; its code and CI passed. That merge did not itself run or
accept a corresponding public maintenance window.

The older public MP4 fixture PASS remains limited to
`main@2b84f447c1d85eaf5f96c4da6cf0d81080332131` and the exact boundary recorded
in its report. It does not transfer to PR #105 or current main.

```yaml
media_gateway:
  role: optional_human_widget_playback
  blocks_provider_canary: false
  blocks_core_beta: false
```

Model video understanding uses the local
`inspect_director_video_frames` FFmpeg frame-extraction path. Media Gateway
promotion, WebM, broad-format coverage, automatic startup and long recovery
soak are not core production prerequisites.

## Core phase dependencies

```yaml
S3:
  requires_director_bridge: false
  requires_snapshot: false
  requires_media_gateway: false
  requires_memory: false
  requires_multi_user: false
S4:
  requires_director_bridge: false
  requires_snapshot: false
  requires_media_gateway: false
  requires_memory: false
  requires_multi_user: false
S5:
  requires_director_bridge: true_only_when_using_chatgpt_frame_review
```

Bridge, Snapshot or Media Gateway recovery must not be inserted ahead of the
current-path Provider readiness and real single-shot canary.

## Current priority

The product-scope source of truth is
[Product Scope Freeze](docs/PRODUCT_SCOPE_FREEZE.md). S1 established one
current classification per component, froze peripheral expansion and retained
legacy routes only for rollback. It did not remove routes or change runtime
behavior.

The only P0 is `CURRENT_MAIN_REPEATABLE_PRODUCTION_LOOP`:

```text
Current Project -> Approved Storyboard Package -> Provider Generation
  -> Governed Media Artifact -> Workbench Review -> Regeneration
  -> Accepted Clips -> Real Assembly -> Export -> Closeout
```

Current stage queue:

1. `S1 Scope Freeze` — `DONE`
2. `S2 Core Loop Gap Audit` — `DONE`
3. `S3 Provider Canary Readiness` — `DONE` with local readiness findings
4. `S3B Single-Shot Canary Prerequisites` — `BLOCKED`
5. `S4 Real Single-Shot Canary` — `BLOCKED_BY_S3_FINDING`
6. `S5 Review and Regeneration` — not loaded
7. `S6 Assembly, Export and Closeout` — not loaded
8. `S7 Three Real Project Evaluation` — not loaded
9. `S8 Legacy Route Cleanup Decision` — not loaded

PR #108 was squash-merged into `main` as
`808d9334a49def7ce858f7c6138af75fed392c5b`. S3B-T1 bounded Provider polling,
S3B-T1A manual-reconciliation state coherence and the verified-Blob storage
recovery path are therefore in current `main`; the merge and green main CI do
not constitute a real Provider or S4 acceptance.

A P2 review finding arrived after the PR #108 merge: a hard process exit after
copying recovery staging bytes but before exclusive placement could leave an
unbounded random `blob-recovery-*.staged` file. Open Ready PR #109 bounds this
material to one deterministic slot derived from the normalized physical target
identity; Blob records that point at the same target therefore share one slot.
Commit `35122cd405f42bc627ae73d121f5a3dd14f3edbe` removes the global destructive
deterministic-stage sweep from `recoverMediaActivations`; generic startup no
longer enumerates, deletes or infers ownership of verified-Blob stages.

Implementation `e3704cb` adds the remaining cross-database coordination to
explicit recovery. A persistent app-controlled SQLite mutex is keyed only by
the canonical media root and exact resolved storage target. It is acquired
before the application write transaction and held across stage, quarantine,
placement, verification, commit or rollback. Binding facts are re-read after
the lock; a 30-second acquisition timeout returns `MEDIA_BLOB_RECOVERY_BUSY`
before any recovery filesystem mutation. Different targets remain independent,
and process exit releases the SQLite lock without a PID lease or stale cleanup.
Follow-up `20f029e` normalizes both mutex identity paths to lowercase on Windows,
matching `sameResolvedPath`; casing variants of the same physical target
therefore cannot split into separate locks. Follow-up `95d8b29` applies the same
identity to the deterministic stage, uses an app-controlled persistent target
authority record to reject divergent registered roots and conflicting immutable
Blob facts, and runs the SQLite mutex in memory-journal mode while rejecting any
pre-existing `-journal`, `-wal` or `-shm` entry.

Only `recoverVerifiedBlobStorage` may converge the exact slot for the Blob it is
explicitly repairing. It reuses a complete matching stage, safely discards and
recopies a partial app-owned stage, removes the exact stage when the final target
is already reusable, and fails closed without deleting unsafe entries. Legacy
random stages have no persistent ownership companion, so explicit recovery now
preserves them and fails closed even when their SHA-256, size and MIME match the
current Blob. Generic startup preserves deterministic stages as
bounded pending recovery material while continuing unrecorded-marker,
staging-owner and `media_activation_journal` recovery.

Independent database A/B/C startup processes, `:memory:`, five hard crashes,
same-target and different-target recovery, bounded busy, unsafe-lock,
partial-stage, already-reusable, unknown-stage and explicit retry regressions
pass. Implementation `f2c31c5` additionally requires the exact deterministic
stage and its app-created owner path to be hard links to the same inode before
reuse or deletion, preserves a later unowned stage even after target authority
exists, initializes the mutex without a path-reopen window, and never treats the
current validated source as legacy cleanup material. Follow-ups `568473c` and
`e6f1d4b` close the later stage-owner crash, mutex-connection identity,
DOS-short quarantine and publication-normalization findings. Follow-ups
`82e6ca2` and `ebb9b07` isolate only the verified stage-owner inode pair before
cleanup, preserve an entry replaced after
validation, and make a hard exit between cleanup entries converge on retry.
Final closeout follow-up `112921e` keeps cleanup on the target filesystem and
converges a hard exit between the two isolation renames. Closeout fixes
`a14c15e` and `0baf31c` preserve the current recovery source during cleanup
reconciliation and reject DOS-alias content drift before authority publication;
they add no feature or external capability. Safety contraction `6b6e238`
preserves lone cleanup entries whose ownership cannot be proven instead of
adding a new ownership registry or recovery protocol. Safety contraction
`f0c486b` also removes automatic normalization of two-link target states; only
the complete deterministic stage-owner-target ownership triple can be changed.
Follow-up `46f206d` requires that target, stage and owner share the same device
and inode before any normalization.
Local validation
passes with media activation 70 PASS / 0 FAIL / 1 platform-capability skip,
Foundation 132 PASS / 0 FAIL / 1 platform-capability skip,
Provider 52/52, Workbench V2 68/68 and selection 23/23; typecheck, build, secret
scan and diff checks also pass. At state sync the 26 unresolved PR #109 threads
are `PRRT_kwDOTTDtUM6VkSwY`, `PRRT_kwDOTTDtUM6VkqqS`,
`PRRT_kwDOTTDtUM6VkzTz`, `PRRT_kwDOTTDtUM6Vk38a`,
`PRRT_kwDOTTDtUM6Vk38b`, `PRRT_kwDOTTDtUM6VlUo8`,
`PRRT_kwDOTTDtUM6VlUo-`, `PRRT_kwDOTTDtUM6VlsfV`,
`PRRT_kwDOTTDtUM6VmCNv`, `PRRT_kwDOTTDtUM6VmCNw`,
`PRRT_kwDOTTDtUM6VnQiz`,
`PRRT_kwDOTTDtUM6VnW8t`, `PRRT_kwDOTTDtUM6VnW8u` and
`PRRT_kwDOTTDtUM6VnZrR`, `PRRT_kwDOTTDtUM6VnfBZ`,
`PRRT_kwDOTTDtUM6VnlsB`, `PRRT_kwDOTTDtUM6Vnvkt`,
`PRRT_kwDOTTDtUM6Vnvkv`, `PRRT_kwDOTTDtUM6Vn2uJ`,
`PRRT_kwDOTTDtUM6VoV-d`,
`PRRT_kwDOTTDtUM6VoV-e`, `PRRT_kwDOTTDtUM6VomGc`,
`PRRT_kwDOTTDtUM6VorLf`, `PRRT_kwDOTTDtUM6Vox11` and
`PRRT_kwDOTTDtUM6Vo6Ke` and `PRRT_kwDOTTDtUM6VpKft`. All 26 threads remain unresolved pending
new exact-head CI and a fresh complete review. PR #109
remains open and unmerged.
Cross-database explicit recovery is serialized by an exact-target SQLite mutex,
and merge remains a separate Jenn decision.

The complete Media Gateway promotion, Memory plugin, second real user,
automatic Snapshot, Windows logon task, WebM/broad formats and new OAuth
compatibility experiments are removed from the S3/S4 blocker chain.

Current frozen work:

- Media Gateway expansion or automatic startup;
- stable Memory plugin and automatic Saveback;
- multi-user expansion and second-user golden path;
- automatic Snapshot synchronization;
- Windows logon startup;
- WebM and broad-format coverage;
- new OAuth compatibility experiments;
- Full WebGPT externalization and legacy-route features.

Current rollback-only surfaces:

- legacy `/mcp`;
- Dedicated Director route.

No rollback surface is authorized for removal by this state correction.

## Accepted evidence index

- [Director Active Database Migration Acceptance](ops/reports/2026-07-22-director-active-database-migration-acceptance.md)
- [Unified Director Activity Acceptance](ops/reports/2026-07-27-unified-director-activity-acceptance.md)
- [Readonly Media Gateway MP4 Fixture Acceptance](ops/reports/2026-07-27-readonly-media-gateway-mp4-fixture-acceptance.md)
- [Unified Director Wire Contract Acceptance](ops/reports/2026-07-28-unified-director-wire-contract-acceptance.md)
- [Managed Director Bridge Restart Acceptance](ops/reports/2026-07-29-managed-director-bridge-restart-acceptance.md)
- [Director Bridge Restart Diagnostic Gap](ops/reports/2026-07-29-director-bridge-restart-diagnostic-gap.md)

Historical R3 Provider, regeneration, assembly and closeout evidence remains
under `data/reports/` and `.agent_board/TASK_LEDGER.md`. Those reports are not
current-main acceptance receipts.

## Non-claims

- No code, database, media, runtime, secret or external configuration was
  changed by S0.
- No Provider was called and no Snapshot was published.
- No Bridge, Gateway, Tunnel or other service was started, stopped or
  restarted.
- No npm package, tag, release, deployment or remote branch update occurred.
- Passing CI does not prove a live Render, Auth0, Cloudflare, Bridge, Snapshot,
  Media Gateway or Provider configuration.

See [docs/README.md](docs/README.md) for the current-document index and
[docs/PROJECT_LESSONS.md](docs/PROJECT_LESSONS.md) for construction lessons.
