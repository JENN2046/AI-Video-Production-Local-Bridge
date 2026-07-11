# M0 Task Decomposition

Source handoff:

- `docs/m0/M0_Codex_Handoff_Prompt_v1.1.md`

Commander decision:

- Treat the handoff prompt as the M0 governing brief.
- Do not execute M0 as one monolithic task.
- Execute in phase order from `M0-000` through `M0-H`.
- Keep `M0-000` as the calibration task.
- After `M0-000` completes, keep `M0-A` through `M0-H` as `READY` tasks controlled by their `depends_on` chain.
- Sustained execution should continue from one completed M0 phase to the next eligible `READY` phase until no eligible task remains or a stop boundary is hit.

## Phase Queue

| Task | Status | Purpose |
|---|---|---|
| `M0-000` | `READY` | Read-only repository reality calibration and implementation routing. |
| `M0-A` | `READY` | Base storage and app skeleton. |
| `M0-B` | `READY` | Media Artifact chain and storyboard image transfer spike. |
| `M0-C` | `READY` | Storyboard Package import and frozen snapshot behavior. |
| `M0-D` | `READY` | Mock provider video generation, Generation Batch, and Generation Run. |
| `M0-E` | `READY` | Review decisions, regeneration, version chain, and no-overwrite behavior. |
| `M0-F` | `READY` | Final assembly and final video artifact gate. |
| `M0-G` | `READY` | Real provider disabled boundary. |
| `M0-H` | `READY` | Validation, closeout report, and self-review. |

## Automatic Continuation Rule

After a phase reaches `DONE`, the executor should:

1. Scan `.agent_board/TASK_BACKLOG.md`.
2. Select the highest-priority `READY` task whose `depends_on` value is satisfied by completed prior work.
3. Load that task into `.agent_board/NEXT_TASK.json`.
4. Claim it.
5. Continue until no eligible `READY` task remains or a stop boundary is hit.

`FOLLOW_UP` still means a task is not executable. The M0 phase tasks are deliberately `READY`; their dependency chain, not manual promotion, controls execution order.

Stop instead of continuing when:

- a dependency is unmet;
- the queue or lock state is inconsistent;
- validation fails and cannot be safely fixed within the phase;
- continuing would require a secret/private-state read;
- continuing would delete or overwrite source media;
- continuing would call a real provider, push, tag, release, deploy, publish, or change production configuration;
- the phase scope drifts beyond M0 into M1.

## Non-Negotiable M0 Boundaries

- No push, tag, release, deploy, or publish.
- No real video provider calls.
- No provider credentials or secret reads.
- No network requirement for runtime tests or demo.
- No arbitrary local file reads.
- No writes outside app-controlled storage.
- No silent overwrite of prior media artifacts, generation runs, or regenerated clips.
- External image transfer may be `NOT_TESTED`, but fixture transfer must pass.
