# RUN_LOCK.md

status: inactive
run_id: none
owner: none
started_at: null
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

## Rules

- If status is inactive, a new run may start.
- If status is active and belongs to the current run, continue.
- If status is active and not stale, another agent must not claim the current task.
- If status is active and appears stale, do not silently overwrite it. Record stale evidence in HANDOFF.md and report BLOCK unless stale-lock recovery is explicitly in scope.
- If the lock references a missing or inconsistent task, report BLOCK unless queue repair is explicitly in scope.
