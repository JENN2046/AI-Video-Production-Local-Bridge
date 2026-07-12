# Current State

Date: 2026-07-12

Baseline commit: `073ebd2` (PR #7 merged into `main`)

Target version: `0.1.0-beta.1`

## Product state

AI Video Production Workspace 已经越过概念验证：Workbench V2、WebGPT V4、真实 RunningHub 生成、审片、重生成、合成、交付、Memory 与媒体分析均有实现和测试。

系统当前适合 Jenn 的单人 Windows 本地生产与受控验证。Stabilization Release v2 已完成，PR #1–#7 均已合并：版本化数据库迁移、持久化 generation worker、媒体有界队列、完整 readiness、标准本地 preflight 和受保护的 Windows Workbench 生命周期控制均已实现。活动数据库已完成备份、迁移、`db:check`、隔离恢复演练与约四小时只读 soak；外部 OAuth/Tunnel 接线和 Windows 自动启动仍被冻结。

## Verified local baseline

- `npm run typecheck`: PASS
- `npm run build`: PASS
- `npm test`: PASS；`npm run test:v2`: 27/27；新增 Windows runtime smoke 覆盖 graceful stop、forced fallback 和最终 `db:check`
- Stabilization review remediation: PASS，包括未知 submit 人工核对、五对象终态收敛、完整 schema baseline、单一 migration lock、Legacy UI 退出和显式 legacy backfill
- `npm run preflight`: PASS on an isolated local profile
- FFmpeg/FFprobe 8.1.2: PASS，通过 WinGet Links 自动发现
- Workbench `/healthz`、`/readyz`: PASS；WebGPT 无 OAuth 时 `/readyz`: expected 503 fail closed
- Active database migration and read-only soak: PASS，属于 Jenn 本机的 local-only/untracked evidence，不是本仓库提交的公开 release artifact；本基线不把它宣称为可独立审计的仓库证据。需要复核时，请在本机用 Node `22.23.1` 重新执行 `npm run preflight`、`npm run db:check`、`npm run test:windows-runtime` 和只读 Workbench 验收路径。

These results are local evidence, not a substitute for remote CI. PR2 establishes the Windows Node 22 CI baseline; every stacked PR must retain that gate.

## Stabilization policy

- Freeze WebGPT V5, Workbench V3 and new providers.
- Preserve human confirmation, cost acknowledgement, idempotency and fail-closed behavior.
- Prefer compatibility-preserving internal seams before physical repository restructuring.
- Keep historical evidence readable, but remove historical execution paths from the production command surface.
- Do not perform live Provider calls during stabilization acceptance.

## Remaining release gates

- Keep the migrated active database backed up and rerun `db:check` before any future schema change.
- Main push CI for `073ebd2` is green on Windows Node 22 with FFmpeg 8.1.2.
- Keep Auth0, Tunnel, public HTTPS, Windows auto-start, WebGPT V5, Workbench V3 and new Providers outside this release.
- Do not make a paid Provider call as part of stabilization acceptance.
