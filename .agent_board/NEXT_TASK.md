# NEXT TASK

Task ID: M0-H
Status: DONE
Priority: P0
Lane: Safe Local Production Lane
Project: M0 Video Loop Validation

Title:
Validation And Closeout

Claimed by:
Codex M0 executor

Goal:
Run final M0 validation and produce honest closeout evidence.

Acceptance:
- npm run test:m0 passes.
- npm run demo:m0 passes and exercises the tool interface.
- npm run closeout:m0 writes data/reports/m0_closeout.yaml.
- Closeout report includes all required validation, evidence, artifact summary, scenarios, hard gates, known gaps, and next recommendation.
- Implementation summary is produced.
- Self-review report is produced.

Validation:
- npm run test:m0
- npm run demo:m0
- npm run closeout:m0
- closeout YAML structure check
- self-review structure check

Allowed delivery:
- local_file_update
- tests
- demo
- closeout_report
- self_review
- validation_log
- handoff

Blocked delivery:
- push
- tag
- release
- deploy
- publish
- real_provider_call
- provider_credential_read
- secret_read
- state_private_read
- production_config_change

Evidence:
- data/reports/m0_closeout.yaml
- data/reports/m0_implementation_summary.yaml
- data/reports/m0_self_review.yaml
- data/reports/m0_demo_result.json

Last updated:
2026-07-06T12:13:42+08:00
