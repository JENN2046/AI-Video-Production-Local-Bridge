# Current State

Date (Asia/Shanghai, UTC+08:00): 2026-07-31
Repository baseline: `main@b3a108abc8728e89259d0d953e1c638b9ca482ea`

## Repository and CI truth

- PR #104, `fix: classify Director Bridge authentication failures`, merged as
  `3a142bb1aeaf34a506f84b2fa2598a5819203d45`.
- PR #105, `test: add readonly media acceptance matrix`, merged as
  `bc3fa5a0baab81551bcef5dafc6fbc2f710d31f7`.
- PR #106, `docs: freeze scope and record core production readiness`, was
  squash-merged as `b3a108abc8728e89259d0d953e1c638b9ca482ea`.
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
| Current Provider path | Intent, budget, confirmation, bounded polling, manual reconciliation and verified-Blob recovery boundaries exist in `main@808d933` | PR #108 merged with green main CI, but a late P2 found an orphaned recovery-staging crash window; Draft PR #109 is the bounded remediation and still requires exact-head CI/review; no real Provider or S4 acceptance occurred | Core blocker before S4 |
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
unbounded random `blob-recovery-*.staged` file. Draft PR #109 contains the
narrow T1B remediation. It assigns each Blob/target pair one deterministic
slot under `.activation/staging`, reuses or safely replaces app-owned staged
bytes, reconciles safe startup orphans under the database recovery lock, and
narrowly removes legacy UUID stages. Unsafe symlinks, directories and unowned
hard links remain fail-closed and are not deleted. Blob rows, content facts,
storage URIs and Artifact-Blob links remain unchanged.

Implementation commit `528aee4020d4be15a5fc5278de2f8c8abb20c637`
passed the authorized local gates. Exact-head review of the first published
state then found that legacy cleanup accepted an over-broad filename pattern
without proving that the file matched the current Blob. Follow-up commit
`e5c4211c11d5bad1f06e7f5422f1b1aa678a5b7f` restricts legacy ownership to the
historical canonical UUID-v4 form and verifies SHA-256, size and MIME before
deletion; mismatches remain preserved and fail closed. The full local gate set
passed again. Exact-head review `4829032568` then found that startup cleanup did
not reject a registered media root redirected through a replaced ancestor.
Commit `193b1077d67dd8872831e8fe7646d8879d4947f7` now requires the canonical root
to equal the registered root before any activation cleanup; a junction
regression proves the external stage is retained and reported unsafe. The full
local gate set passes after this second fix. Draft PR #109 still requires new
exact-final-head Windows CI and Codex review. PR #108's late thread remains
unresolved until the remediation is reviewed, merged and verified.

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
