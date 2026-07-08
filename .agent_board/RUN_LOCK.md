# RUN_LOCK.md

status: inactive
run_id: none
owner: none
started_at: none
current_task: none
project: AI Video Production Workspace Three Route Plan
stale_after_minutes: 120
last_completed_run_id: codex-20260707-171333-r3-8i
last_completed_task: R3-8I_RUNNINGHUB_REAL_KEYFRAME_AUTHORIZATION_PREP
last_completed_at: 2026-07-07T17:18:38+08:00
last_failed_run_id: codex-20260707-174355-r3-8j
last_failed_task: R3-8J_RUNNINGHUB_REAL_KEYFRAME_SINGLE_SUBMIT_CANARY
last_failed_at: 2026-07-07T17:46:23+08:00
last_completed_receipt_run_id: codex-20260707-182337-r3-8j-receipt-fix
last_completed_receipt_task: R3-8J_RECEIPT_FIX
last_completed_receipt_at: 2026-07-07T18:23:37+08:00
last_completed_duration_contract_run_id: codex-20260707-182633-r3-8l
last_completed_duration_contract_task: R3-8L_RUNNINGHUB_DURATION_CONTRACT_REPAIR_DRY_RUN
last_completed_duration_contract_at: 2026-07-07T18:31:23+08:00
last_completed_receipt_r1_run_id: codex-20260708-101350-r3-8l-receipt-fix-r1
last_completed_receipt_r1_task: R3-8L_RECEIPT_FIX_R1
last_completed_receipt_r1_at: 2026-07-08T10:16:15+08:00
last_failed_r3_8m_run_id: codex-20260708-102426-r3-8m-live
last_failed_r3_8m_task: R3-8M_RUNNINGHUB_6S_SINGLE_SUBMIT_CANARY
last_failed_r3_8m_at: 2026-07-08T10:30:30+08:00
last_completed_r3_8m_receipt_run_id: codex-20260708-105033-r3-8m-receipt-fix
last_completed_r3_8m_receipt_task: R3-8M_RECEIPT_FIX
last_completed_r3_8m_receipt_at: 2026-07-08T10:51:49+08:00
last_completed_r3_8n_run_id: codex-20260708-105731-r3-8n-strategy
last_completed_r3_8n_task: R3-8N_PROVIDER_ACCESS_STRATEGY_DECISION
last_completed_r3_8n_at: 2026-07-08T11:00:08+08:00
last_completed_r3_8o_run_id: codex-20260708-112510-r3-8o-live
last_completed_r3_8o_task: R3-8O_RUNNINGHUB_ENTERPRISE_KEY_6S_SINGLE_SUBMIT_CANARY
last_completed_r3_8o_at: 2026-07-08T11:28:19+08:00
last_completed_r3_8o_receipt_fix_r1_run_id: codex-20260708-113927-r3-8o-receipt-fix-r1
last_completed_r3_8o_receipt_fix_r1_task: R3-8O_RECEIPT_FIX_R1
last_completed_r3_8o_receipt_fix_r1_at: 2026-07-08T11:40:34+08:00
last_completed_r3_8k_run_id: codex-20260708-115033-r3-8k-closeout
last_completed_r3_8k_task: R3-8K_PROVIDER_PATH_DECISION_CLOSEOUT
last_completed_r3_8k_at: 2026-07-08T11:53:48+08:00
last_completed_r3_9a_run_id: codex-20260708-120613-r3-9a
last_completed_r3_9a_task: R3-9A_RUNNINGHUB_PRIMARY_LANE_WIRING_DRY_RUN
last_completed_r3_9a_at: 2026-07-08T12:11:19+08:00
last_completed_r3_9b_run_id: codex-20260708-121358-r3-9b
last_completed_r3_9b_task: R3-9B_STORYBOARD_PACKAGE_TO_RUNNINGHUB_GENERATION_PLAN
last_completed_r3_9b_at: 2026-07-08T12:17:58+08:00

last_completed_r3_9c_run_id: codex-20260708-140148-r3-9c
last_completed_r3_9c_task: R3-9C_RUNNINGHUB_4_SHOT_LIVE_AUTHORIZATION_PREP
last_completed_r3_9c_at: 2026-07-08T14:06:34+08:00

last_completed_r3_9d_run_id: codex-20260708-143236-r3-9d
last_completed_r3_9d_task: R3-9D_RUNNINGHUB_4_SHOT_SINGLE_PASS_LIVE_EXECUTION
last_completed_r3_9d_at: 2026-07-08T14:49:31+08:00

last_completed_r3_9e_run_id: codex-20260708-151059-r3-9e
last_completed_r3_9e_task: R3-9E_RUNNINGHUB_GENERATED_CLIP_REVIEW_PREP
last_completed_r3_9e_at: 2026-07-08T15:13:25+08:00

last_completed_r3_9f_run_id: codex-20260708-160441-r3-9f
last_completed_r3_9f_task: R3-9F_HUMAN_CLIP_REVIEW_DECISION_APPLY
last_completed_r3_9f_at: 2026-07-08T16:11:25+08:00

last_completed_r3_9g_run_id: codex-20260708-163900-r3-9g
last_completed_r3_9g_task: R3-9G_REGENERATION_STRATEGY_FOR_REVIEW_NOTES
last_completed_r3_9g_at: 2026-07-08T16:42:00+08:00

last_completed_r3_9h_run_id: codex-20260708-164524-r3-9h
last_completed_r3_9h_task: R3-9H_SHOT_002_REPLACEMENT_DECISION
last_completed_r3_9h_at: 2026-07-08T16:51:32+08:00

## Rules

- If status is inactive, a new run may start.
- If status is active and belongs to the current run, continue.
- If status is active and not stale, another agent must not claim the current task.
- If status is active and appears stale, do not silently overwrite it. Record stale evidence in HANDOFF.md and report BLOCK unless stale-lock recovery is explicitly in scope.
- If the lock references a missing or inconsistent task, report BLOCK unless queue repair is explicitly in scope.
