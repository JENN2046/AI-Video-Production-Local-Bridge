# HANDOFF.md

Current mode: Sustained Task Queue Mode v0.1.0 for AI Video Production Workspace
Last run: codex-20260707-154200-r3-8g
Last result: R3-8G completed RunningHub contract freeze and no-network dry-run with PASS_CONTRACT_FREEZE_DRY_RUN

## Current state

Current task: R3-8G_RUNNINGHUB_CONTRACT_FREEZE_AND_DRY_RUN
Current status: DONE
Current owner: None

## R3-8G closeout

Completed at: 2026-07-07T15:56:55+08:00
Result: PASS_CONTRACT_FREEZE_DRY_RUN
Report: `data/reports/r3_8g_runninghub_contract_freeze_dry_run_result.json`

- RunningHub is primary in the local provider registry; Runway remains secondary and was not called.
- Frozen submit endpoint: `POST /openapi/v2/rhart-video-g/image-to-video`.
- Frozen upload endpoint: `POST /openapi/v2/media/upload/binary`; future live use must upload local app media first and use the returned `download_url`.
- Frozen query endpoint: `POST /openapi/v2/query`.
- Sanitized request fields: `prompt`, `aspectRatio`, `imageUrls`, `resolution`, `duration`.
- No RunningHub submit, Runway submit, provider status polling, provider upload, output download, credit consumption, real video generation, secret output, source overwrite, push, tag, release, or deploy occurred.
- Unresolved by official docs: full aspect-ratio enum, full duration range, native `negative_prompt` support.
- R3-8H remains `FOLLOW_UP` until Jenn promotes it to `READY`.

## Completed in last run

- Imported the adapted three-route dispatch package into `.agent_board/TASK_BACKLOG.md`.
- Added `R3-0_LOCAL_APP_CONTRACT_FREEZE_AND_H1_API_SUPPORT` as the only new `READY` task.
- Added `R2-1_H1_HANDOFF_WORKBENCH_MVP`, `R3-3_STRICT_SINGLE_RUNWAY_CANARY_SCRIPT`, and `R1-0_WEBGPT_MCP_BOUNDARY_AND_READONLY_BRIDGE_PLAN` as `FOLLOW_UP` tasks.
- Promoted the three follow-up tasks to `READY` for sustained automation.
- Rewired dependencies to force the sequence:
  `R3-0_LOCAL_APP_CONTRACT_FREEZE_AND_H1_API_SUPPORT`
  -> `R2-1_H1_HANDOFF_WORKBENCH_MVP`
  -> `R3-3_STRICT_SINGLE_RUNWAY_CANARY_SCRIPT`
  -> `R1-0_WEBGPT_MCP_BOUNDARY_AND_READONLY_BRIDGE_PLAN`.
- Kept `R3-3` as dry-run only; live Runway execution remains forbidden without a separate exact Jenn authorization task.
- Added the remaining route tasks from the v1.1 source taskbooks and rewired the queue into a longer dependency-gated chain:
  `R3-0`
  -> `R2-0`
  -> `R3-1`
  -> `R3-2`
  -> `R2-1`
  -> `R3-3`
  -> `R1-0`
  -> `R2-2`
  -> `R1-1`
  -> `R3-4`
  -> `R2-3`
  -> `R1-2`
  -> `R1-3`
  -> `R1-4`
  -> `R3-5`
  -> `R2-4`
  -> `R3-6`
  -> `R2-5`
  -> `R1-5`.
- Provider/live/memory tasks remain boundary-protected inside their task cards; exact Jenn authorization is still required for live provider calls and long-term memory write.
- R3-0, R2-0, R3-1, R3-2, R2-1, and R3-3 have completed in the sustained run.
- R3-2 froze a four-shot app-ready Storyboard Package with app-returned artifact IDs and wrote `data/reports/r3_2_storyboard_package_freeze_core_result.json`.
- R1-0 completed the docs-only WebGPT MCP boundary/read-only bridge plan at `docs/three_routes/r1_0_webgpt_mcp_boundary_readonly_bridge_plan.md`.
- R2-2 completed H2 Provider Guard / Canary Workbench with a Chinese `金丝雀` page and read-only `/api/canary` endpoint.
- R1-1 completed WebGPT MCP/Bridge v0 read-only service with nine GET-only localhost tools.
- R3-4 completed package-based mock shot generation from frozen package to `generated_clip` artifact with ffprobe PASS.
- R2-3 completed H3 Video Review Workbench with a Chinese `审片` page, `/api/review`, approve/reject review actions, and draft-only regeneration requests.
- R1-2 completed MCP v0.5 Draft Submission with draft-only tools, separate draft store, v0.5 bridge, and a Chinese H1 `GPT 草稿` page.
- R1-3 completed MCP v1 Human-Confirmed Handoff Tools with pending action tools, a v1 bridge, H1 `待确认` page, and nonce-protected confirmation/rejection.
- R1-4 completed MCP v2 Review Assistant Tools with run/clip metadata reads and review note/rejection/regeneration prompt drafts.
- R3-5 completed Review Regeneration Final Assembly Core with local mock/provider-gated validation and wrote `data/reports/r3_5_review_regeneration_final_assembly_core_result.json`.
- R2-4 completed H4 Final Assembly Workbench with Chinese `合成` page, `/api/assembly`, explicit local assembly confirmation, and final artifact ffprobe evidence.
- R3-6 completed Memory Asset Saveback Core with local proposal, confirmed materialization, and recall pack generation.
- R2-5 completed H5 Memory Asset Workbench with Chinese `记忆资产` page and guarded `/api/memory` endpoints.
- R1-5 completed MCP v3 Production Assistant with plan-only tools and localhost bridge.
- Full three-route sustained chain completed; one new authorization-preparation READY task has been opened for Runway live canary.
- Final sustained-loop validation passed across M0, M1, G0, H1, memory saveback, WebGPT v0/v0.5/v1/v2/v3, secret scan, and diff check.
- Commander acceptance review package generated at `ops/reports/three_route_acceptance_review_package_20260707_103611/THREE_ROUTE_ACCEPTANCE_REVIEW.md`.
- Handoff header was cleaned up on 2026-07-07 to reflect final `R1-5 / DONE` state.
- R3-7 completed on 2026-07-07 with `PASS_READY_FOR_USER_AUTHORIZATION` and wrote `data/reports/r3_7_runway_live_canary_authorization_result.json`.
- Provider preflight was tightened so credential presence is boolean-only and no masked credential preview is emitted.
- Earlier acceptance-review cleanup did not modify `.agent_board/NEXT_TASK.json`; R3-7 later updated it as the active queue state.
- Earlier acceptance-review cleanup did not claim or execute imported tasks; R3-7 was later claimed and completed as authorization preparation.
- M0 handoff prompt captured at `docs/m0/M0_Codex_Handoff_Prompt_v1.1.md`.
- M0 phase decomposition captured at `docs/m0/M0_TASK_DECOMPOSITION.md`.
- M0-000 through M0-H executed in order.
- M0 tools are implemented behind a stable internal TypeScript interface.
- SQLite metadata persistence is available at `data/app.sqlite`.
- App-controlled media storage is under `data/media`.
- M0 closeout reports were written under `data/reports`.
- R3-8C completed on 2026-07-07 with `PASS_READY_FOR_INPUT_STRATEGY_DECISION` and wrote `data/reports/r3_8c_runway_submit_failure_triage_result.json`.
- Runway submit failures now support sanitized provider error summaries for future non-2xx failures.
- Runway request summaries now report endpoint/version/model/ratio/duration/text length/image metadata without `promptImage` or base64.
- Current canary gradient fixture is unsuitable for the next live Gen-4.5 I2V canary.
- R3-8D completed on 2026-07-07 with `PASS_READY_FOR_USER_AUTHORIZATION` and wrote `data/reports/r3_8d_real_storyboard_keyframe_canary_prepare_result.json`.
- R3-8D reviewed SHOT_001 through SHOT_004 approved WebGPT keyframes and selected app artifact `artifact_cbed1c1c-4293-450e-897e-3be49ddf7fb7` from `SHOT_001`.
- The R3-8D dry-run canary plan uses `provider=runway`, `model=gen4.5`, `endpoint=POST /v1/image_to_video`, `X-Runway-Version=2024-11-06`, `duration_seconds=2`, `ratio=720:1280`, and `max_submit_calls=1`.
- R3-8D did not call Runway or RunningHub, upload media, consume provider credits, generate video, read/print secrets, overwrite source assets, push, tag, release, or deploy.
- R3-8E executed exactly one Jenn-authorized Runway submit using artifact `artifact_cbed1c1c-4293-450e-897e-3be49ddf7fb7`.
- R3-8E result is `PROVIDER_FAILED_INSUFFICIENT_CREDITS`: Runway returned sanitized provider evidence indicating insufficient credits.
- R3-8E did not retry and did not produce a provider job id or video artifact.
- R3-8E added provider classification coverage so HTTP 400 credit messages map to `PROVIDER_INSUFFICIENT_CREDITS`.
- Another live Runway submit requires a new exact current Jenn authorization phrase.
- R3-8G completed RunningHub contract freeze and no-network dry-run.
- R3-8G report is `data/reports/r3_8g_runninghub_contract_freeze_dry_run_result.json`.
- R3-8G did not call RunningHub or Runway and did not read or print secrets.
- R3-8H completed RunningHub adapter skeleton and offline tests.
- R3-8H report is `data/reports/r3_8h_runninghub_adapter_skeleton_offline_result.json`.
- R3-8H added offline upload, submit, and query request builders for RunningHub, plus synthetic response parsers and sanitized error mapping.
- R3-8H did not call RunningHub or Runway, upload media to provider, poll status, download provider output, consume provider credits, generate video, read/print secrets, overwrite source assets, push, tag, release, or deploy.

## Blocked in last run

- None

## Failed in last run

- None

## Skipped in last run

- None

## Remaining READY tasks

- None

## Closeout evidence

- `data/reports/m0_closeout.yaml`
- `data/reports/m0_implementation_summary.yaml`
- `data/reports/m0_self_review.yaml`
- `data/reports/m0_demo_result.json`
- `data/reports/r3_2_storyboard_package_freeze_core_result.json`
- `data/reports/g0_r1_package_freeze_result_047b0378-3f50-41fa-bd60-24214fd0fc63.json`
- `docs/three_routes/r1_0_webgpt_mcp_boundary_readonly_bridge_plan.md`
- `data/reports/r2_2_h2_canary_workbench_result.json`
- `data/reports/r1_1_mcp_v0_read_only_service_result.json`
- `data/reports/r3_4_package_based_shot_generation_result.json`
- `data/reports/r3_4_package_based_shot_generation_result_e7c8e120-c469-47eb-9c36-cd9b08a7d865.json`
- `data/reports/r2_3_h3_video_review_workbench_result.json`
- `data/reports/r1_2_mcp_v0_5_draft_submission_result.json`
- `data/reports/r1_3_mcp_v1_human_confirmed_handoff_tools_result.json`
- `data/reports/r1_4_mcp_v2_review_assistant_tools_result.json`
- `data/reports/r3_5_review_regeneration_final_assembly_core_result.json`
- `data/reports/r2_4_h4_final_assembly_workbench_result.json`
- `data/reports/h4_final_assembly_result.json`
- `data/reports/r3_6_memory_asset_saveback_core_result.json`
- `data/reports/memory_saveback_result.json`
- `data/reports/r2_5_h5_memory_asset_workbench_result.json`
- `data/reports/r1_5_mcp_v3_production_assistant_result.json`
- `data/reports/r3_7_runway_live_canary_authorization_result.json`
- `data/reports/r3_7_runway_live_canary_authorization_result_20260707T113308+0800.json`
- `data/reports/r3_8b_runway_gen45_single_submit_canary_result.json`
- `data/reports/r3_8c_runway_submit_failure_triage_result.json`
- `data/reports/r3_8d_real_storyboard_keyframe_canary_prepare_result.json`
- `data/reports/r3_8e_runway_real_storyboard_keyframe_canary_result.json`
- `data/reports/r3_8g_runninghub_contract_freeze_dry_run_result.json`
- `data/reports/r3_8h_runninghub_adapter_skeleton_offline_result.json`
- `ops/reports/three_route_acceptance_review_package_20260707_103611/THREE_ROUTE_ACCEPTANCE_REVIEW.md`
- `ops/reports/three_route_acceptance_review_package_20260707_103611/README.md`

## Risks

- The board is installed as local workspace state. It is not backed by git in this directory.
- M0 result is `PASS_WITH_GAPS` because real provider integration remains disabled and external image transfer is `NOT_TESTED`.
- Node's built-in `node:sqlite` is experimental and emits warnings in Node v22.

## Next recommended action

- R3-8I remains `FOLLOW_UP`; promote it only when Jenn wants RunningHub live-canary authorization preparation.
- Do not submit to RunningHub without a future exact current Jenn authorization phrase.
- Do not retry Runway canary without a new exact current Jenn authorization phrase.
