# PR #123 Delivery State Foundation failure map

Status: `READ_ONLY_ACCEPTANCE_INPUT`

This document preserves the failure semantics discovered on PR #123 without
accepting that PR's repair history into the clean Delivery State Foundation.
It is an ownership map, not proof that an outdated thread still reproduces.

Evidence baseline:

- research PR: `#123`
- research head: `6374ea1fbd210bca2a625f12d4866e1c78af18e2`
- clean Foundation base: `main@d4f7f719a068d4bb13e17efcf050d5c0ee00e973`
- unresolved threads classified: `66`
- retained by Foundation: `6`
- deferred to later owners: `60`

Pre-implementation Git admission record:

- branch head before changes: `d4f7f719a068d4bb13e17efcf050d5c0ee00e973`
- merge base with canonical main: `d4f7f719a068d4bb13e17efcf050d5c0ee00e973`
- PR #123 commit ancestry present: `false`
- cherry-picked PR #123 commits: `0`
- retained findings: `6`
- deferred findings: `60`

The clean Foundation must not copy PR #123 commits or treat a deferred finding
as authorization to implement Assembly, Final Review, Export, Closeout,
production mutation authority, Provider execution, reconciliation, media
recovery, or filesystem/database coordination.

## Retained Foundation findings

Each retained finding has a required negative test in
`tests/workbench-v2-delivery-state.test.ts`.

| Thread | Preserved failure semantics | Required negative test |
|---|---|---|
| `PRRT_kwDOTTDtUM6ZfJwx` | A Job must not have more than one Event of the same lifecycle type. | `delivery ledger rejects a duplicate lifecycle Event for one Job` |
| `PRRT_kwDOTTDtUM6Zx4QX` | Legacy backfill must preserve the historical final Artifact pointer and must not permit pointer substitution. | `legacy backfill preserves the bound final Artifact identity` |
| `PRRT_kwDOTTDtUM6Zx4Qd` | A terminal Job must be bound to one matching terminal Event. | `terminal Job state requires matching terminal Event evidence` |
| `PRRT_kwDOTTDtUM6Z9LKJ` | A Job must not be inserted directly in a terminal state without terminal evidence. | `direct terminal Job insertion fails closed without evidence` |
| `PRRT_kwDOTTDtUM6aCF4x` | A newly inserted Project must have the canonical initial delivery projection and cannot claim final approval or a final Artifact. | `new Project initialization rejects a terminal delivery projection` |
| `PRRT_kwDOTTDtUM6aC0aL` | A pointerless historical `final_approved` Project must remain recoverable and must not be frozen in `legacy_review_required`. | `pointerless legacy final approval backfills to not_ready` |

## Deferred to Production Mutation Authority

Disposition for every row: `DEFERRED_TO_OWNER`. These findings must not change
Foundation source code.

| Thread | Preserved failure semantics |
|---|---|
| `PRRT_kwDOTTDtUM6Zdye2` | WebGPT content writers require the same rework authority as other production writers. |
| `PRRT_kwDOTTDtUM6ZeDuS` | G0 writes must respect terminal Project authority before file or database effects. |
| `PRRT_kwDOTTDtUM6Zf_Hn` | Shared Project and SHOT persistence cannot bypass closed-state authority. |
| `PRRT_kwDOTTDtUM6Zr-uA` | Public SHOT persistence cannot mutate reviewed or delivered content without rework authority. |
| `PRRT_kwDOTTDtUM6Zr-uB` | Delivery-bound Artifact content and Blob bindings require mutation authority. |
| `PRRT_kwDOTTDtUM6ZtiA7` | Public Project persistence cannot mutate reviewed or delivered production content. |
| `PRRT_kwDOTTDtUM6ZtiA_` | Artifact-to-SHOT attachment requires delivery-aware mutation authority. |
| `PRRT_kwDOTTDtUM6ZwKci` | Non-production title updates need a narrow authority path and stable domain errors. |
| `PRRT_kwDOTTDtUM6Z-Tig` | Public Project writes cannot manufacture legacy delivery projection fields. |
| `PRRT_kwDOTTDtUM6acFed` | Direct Project and SHOT table writes require a database-level production authority design. |
| `PRRT_kwDOTTDtUM6atOiW` | Storyboard Package content needs database-level immutability once an owner activates that policy. |

## Deferred to Assembly Execution

Disposition for every row: `DEFERRED_TO_OWNER`. Foundation stores opaque Job,
Event and fingerprint fields but does not define Assembly lifecycle semantics.

| Thread | Preserved failure semantics |
|---|---|
| `PRRT_kwDOTTDtUM6ZeDuH` | Production inputs must be frozen while an Assembly Job is active. |
| `PRRT_kwDOTTDtUM6ZeDuW` | `ready_to_assemble` must project an Assembly action even when an older final pointer exists. |
| `PRRT_kwDOTTDtUM6Zrk6i` | Entering `final_review` requires successful Assembly evidence for the current Artifact. |
| `PRRT_kwDOTTDtUM6ZtiA3` | Assembly fingerprints must be frozen after Assembly and approvals must bind to the successful input. |
| `PRRT_kwDOTTDtUM6ZuYss` | Accepted clips consumed by Assembly must not change behind recorded evidence. |
| `PRRT_kwDOTTDtUM6ZvPL-` | Successful Assembly must cover every SHOT and reject zero or missing accepted clips. |
| `PRRT_kwDOTTDtUM6ZwKcg` | `assembling` must be bound to an active Assembly Job and queued Event. |
| `PRRT_kwDOTTDtUM6Z-Tie` | Queued and running Assembly input Artifacts must remain frozen. |
| `PRRT_kwDOTTDtUM6aAoJJ` | Reassembly must require current approval of every accepted SHOT clip. |
| `PRRT_kwDOTTDtUM6aCf2B` | Assembly and rework Event timestamps need one canonical ordering format. |
| `PRRT_kwDOTTDtUM6aEawS` | Assembly input fingerprints must be recomputed from the canonical input contract. |
| `PRRT_kwDOTTDtUM6aYfOH` | Persistent Assembly constraints must validate current clip approval state. |
| `PRRT_kwDOTTDtUM6aZLjN` | Assembly input readiness must be validated when a Job is queued. |
| `PRRT_kwDOTTDtUM6aZLjT` | Assembly inputs must be bound positionally to canonical SHOT order. |
| `PRRT_kwDOTTDtUM6arXRi` | A Project cannot enter `ready_to_assemble` without actual Assembly-ready SHOTs. |
| `PRRT_kwDOTTDtUM6asFki` | SHOT readiness drift must revoke `ready_to_assemble` atomically. |
| `PRRT_kwDOTTDtUM6ashCr` | Accepted-clip deactivation must revoke Assembly readiness atomically. |
| `PRRT_kwDOTTDtUM6as0nA` | Successful Assembly must atomically synchronize the Project final Artifact projection. |

## Deferred to Final Review, Export and Closeout

Disposition for every row: `DEFERRED_TO_OWNER`. Foundation defines the state
names and immutable ledger shapes only; it does not make these workflows
executable.

| Thread | Preserved failure semantics |
|---|---|
| `PRRT_kwDOTTDtUM6ZfjJe` | Approval must be atomically bound to a final-review acceptance Event. |
| `PRRT_kwDOTTDtUM6Zrk6o` | Entering `exported` requires successful Export Job and Event evidence. |
| `PRRT_kwDOTTDtUM6ZuYso` | Approval evidence must remain required through exported and closed states. |
| `PRRT_kwDOTTDtUM6ZuYsw` | Final-review rework transitions require matching immutable decision Events. |
| `PRRT_kwDOTTDtUM6ZwKce` | An Export receipt must be bound to the bytes of a real governed file. |
| `PRRT_kwDOTTDtUM6Z9w6k` | Legacy approval needs one explicit atomic review transition. |
| `PRRT_kwDOTTDtUM6Z9w6n` | Closed delivery projection must ignore stale legacy next-action hints. |
| `PRRT_kwDOTTDtUM6Z-xZ6` | Active Export Jobs require queued and started lifecycle evidence. |
| `PRRT_kwDOTTDtUM6aBN9J` | Legacy downgrade requires an immutable human reset or rework Event. |
| `PRRT_kwDOTTDtUM6aDPTo` | Delivered projection must revalidate the current Export file. |
| `PRRT_kwDOTTDtUM6aEawM` | Workbench delivered status must agree with current Export integrity. |
| `PRRT_kwDOTTDtUM6aYfOD` | Closeout must revalidate Export bytes in the closeout transaction. |
| `PRRT_kwDOTTDtUM6aZ6Vo` | Export verification must not synchronously hash every final file on list reads. |
| `PRRT_kwDOTTDtUM6aahNW` | Cold list and Snapshot processes need a defined Export verification state. |
| `PRRT_kwDOTTDtUM6aa_bM` | Dashboard pending-delivery totals must use authoritative delivery state. |
| `PRRT_kwDOTTDtUM6abb9b` | Cold Workbench project lists must not confuse unverified with failed Export integrity. |
| `PRRT_kwDOTTDtUM6aq8qX` | Full Export verification failures must propagate into delivery summaries. |
| `PRRT_kwDOTTDtUM6arIly` | Export integrity failures must contribute to blocked-project totals. |
| `PRRT_kwDOTTDtUM6aruzi` | Targeted regeneration Events must bind to real SHOT rework. |
| `PRRT_kwDOTTDtUM6asFkq` | A closed Snapshot requires a usable final Artifact and a truthful delivered claim. |

## Closed by External Execution Integrity

Disposition for every row: `CLOSED_BY_0016_LOCAL_FIXTURES`. Migration `0016`,
schema `workbench-v2-11`, and the exact selected-test mapping are documented in
[`external-execution-integrity-thread-ledger.json`](evidence/external-execution-integrity-thread-ledger.json).
This closes the code and fixture findings only; it is not real Provider or
activity-runtime acceptance.

| Thread | Preserved failure semantics |
|---|---|
| `PRRT_kwDOTTDtUM6ZfJwv` | Provider submit, poll and download awaits require post-await mutation revalidation. |
| `PRRT_kwDOTTDtUM6ZfJww` | Media activation markers may be removed only after the true outer transaction commits. |
| `PRRT_kwDOTTDtUM6ZfjJd` | The persistent Generation Worker needs pre-effect and final-transaction authority checks. |
| `PRRT_kwDOTTDtUM6Z9w6i` | A possibly paid Provider task must be persisted before returning from a changed authority boundary. |
| `PRRT_kwDOTTDtUM6Z_11q` | Media activation rollback must retain an auditable recovery marker or Journal. |
| `PRRT_kwDOTTDtUM6aAoJM` | Async regeneration must recheck authority and persist Artifact, Run and SHOT atomically. |
| `PRRT_kwDOTTDtUM6aDPTh` | Provider result persistence must include frozen Project video specifications. |
| `PRRT_kwDOTTDtUM6aD6D_` | Provider persistence must revalidate Storyboard Package identity and content. |
| `PRRT_kwDOTTDtUM6aEawF` | A retained Provider task must have a reconciliation-compatible SHOT binding. |
| `PRRT_kwDOTTDtUM6acFef` | G0 filesystem writes need a transaction or restoration protocol around authority drift. |
| `PRRT_kwDOTTDtUM6asFkl` | A Provider task must remain reconcilable when media activation finalization rolls back. |

## Foundation acceptance boundary

Foundation proof is limited to migration, structural ledger integrity, safe
backfill, canonical initialization, structural governance, readonly projection
compatibility, and fail-closed rejection of legacy placeholder Assembly. A test
or implementation change that needs to interpret Assembly inputs, execute an
Export, accept a final review, close a Project, mutate production content,
contact a Provider, recover media, or coordinate filesystem state is a
`BLOCKED_SCOPE_ESCAPE` for this work package.
