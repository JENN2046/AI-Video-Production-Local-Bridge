# Current State

Date: 2026-07-12

Baseline: GPT Service Capability Hardening v1, delivered sequentially through PR #9–#13; Stabilization Remediation is now the active route

Target version: `0.1.0-beta.2`; MCP service: `webgpt-v4.1.0`

Frozen runtime implementation baseline: `main@fbba4ce` (`Merge pull request #13`)

## Product state

AI Video Production Workspace 已经越过概念验证：Workbench V2、WebGPT V4、真实 RunningHub 生成、审片、重生成、合成、交付、Memory 与媒体分析均有实现和测试。

系统当前适合 Jenn 的单人 Windows 本地生产与受控验证。Stabilization Release v2 已完成，PR #1–#7 均已合并：版本化数据库迁移、持久化 generation worker、媒体有界队列、完整 readiness、标准本地 preflight 和受保护的 Windows Workbench 生命周期控制均已实现。活动数据库已完成备份、迁移、`db:check`、隔离恢复演练与约四小时只读 soak；外部 OAuth/Tunnel 接线和 Windows 自动启动仍被冻结。

WebGPT V4 已收敛为 `webgpt-v4.1.0`：默认 Readonly 仅暴露六个 `projects.read` 工具；14 个 Full 工具均使用显式公共 DTO；大型上下文默认 Compact 并受 128 KiB 预算约束；离线 contract/eval、Widget v2 和可选低披露 JSONL Telemetry 均有故障路径测试。PR #13 进一步收紧 Schema readiness、项目/SHOT/Artifact 绑定、公共结果 envelope、Eval 参数字段和媒体 public origin，并完成对应故障注入。此状态不表示外部 ChatGPT 接线已完成。

## Verified local baseline

- `npm run typecheck`: PASS
- `npm run build`: PASS
- `npm test`: PASS；`npm run test:v2`: 27/27；`npm run test:webgpt:v4`: 45/45；Windows runtime smoke 覆盖 graceful stop、forced fallback 和最终 `db:check`
- Stabilization review remediation: PASS，包括未知 submit 人工核对、五对象终态收敛、完整 schema baseline、单一 migration lock、Legacy UI 退出和显式 legacy backfill
- `npm run preflight`: PASS on an isolated local profile
- FFmpeg/FFprobe 8.1.2: PASS，通过 WinGet Links 自动发现
- Workbench `/healthz`、`/readyz`: PASS；WebGPT 无 OAuth 时 `/readyz`: expected 503 fail closed
- Active database migration and read-only soak: PASS，属于 Jenn 本机的 local-only/untracked evidence，不是本仓库提交的公开 release artifact；本基线不把它宣称为可独立审计的仓库证据。需要复核时，请在本机用 Node `22.23.1` 重新执行 `npm run preflight`、`npm run db:check`、`npm run test:windows-runtime` 和只读 Workbench 验收路径。

Remote CI evidence: PR #9–#13 均已合并；每个 PR 的 Windows `Quality and integration` 与 `Browser smoke` 均为 `SUCCESS`。PR #13 的最终 Windows CI run 为 [29187898165](https://github.com/JENN2046/AI-Video-Production-Local-Bridge/actions/runs/29187898165)。PR2 establishes the Windows Node 22 CI baseline; every future PR must retain that gate.

## Beta 2 snapshot and remediation gate

- `0.1.0-beta.2` 的运行实现快照为 `main@fbba4ce`；Closeout 位于 `main@de8c2cd`。它们保留为已验证的历史基线，而不是外部连接发布裁决。
- 独立审查发现 Artifact 绑定/所有权、Provider 定价契约、媒体内容完整性、跨 SHOT 引用和 CI 覆盖仍有阻断缺口。详情与实施顺序见 [Stabilization Remediation](docs/STABILIZATION_REMEDIATION.md)。
- 因此冻结不创建 Git tag、不发布 package、不执行 release 或 deploy；后续运行代码只能通过 Remediation 独立 PR 推进。
- Auth0、Secure MCP Tunnel、媒体公网 HTTPS、Windows 自动启动和真实 Provider canary 均继续冻结，且不得在 Remediation 全部重新验收前启动。

## Stabilization policy

- Freeze WebGPT V5, Workbench V3 and new providers.
- Preserve human confirmation, cost acknowledgement, idempotency and fail-closed behavior.
- Prefer compatibility-preserving internal seams before physical repository restructuring.
- Keep historical evidence readable, but remove historical execution paths from the production command surface.
- Do not perform live Provider calls during stabilization acceptance.

## Remaining release gates

- Keep the migrated active database backed up and rerun `db:check` before any future schema change.
- GPT hardening PRs retain the Windows Node 22 + FFmpeg 8.1.2 CI and browser-smoke gates.
- Keep Auth0, Secure MCP Tunnel, public media HTTPS, Windows auto-start, real Provider canary, WebGPT V5, Workbench V3 and new Providers outside this release.
- Do not make a paid Provider call as part of stabilization acceptance.
- Do not enter external-connection work until the remediation exit gates pass.
