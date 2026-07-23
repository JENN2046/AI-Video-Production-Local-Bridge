import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CircleAlert, RefreshCw, ShieldAlert, Sparkles, X } from "lucide-react";
import { useSearchParams } from "react-router-dom";

import { apiGet, apiMutation, apiPage } from "../api";
import { EmptyState, ErrorState, KeyValue, LoadingState, PageHeader, StatusPill } from "../components";
import type { MediaArtifact, ProjectSummary, WorkspaceData } from "../types";
import s from "../workbench.module.css";

type FocusTargetType = "project" | "shot" | "artifact" | "delivery" | "memory";
type ProposalDecision = "accept" | "reject";

interface DirectorFocus {
  focus_id: string;
  project_id: string;
  target_type: FocusTargetType;
  target_id: string;
  generation: number;
  created_at: string;
  expires_at: string;
}

interface DirectorProposal {
  proposal_id: string;
  project_id: string;
  target_type: string;
  target_id: string;
  focus_id: string;
  focus_generation: number;
  kind: string;
  source: "native" | "untrusted_manual_import";
  created_at: string;
  base_state_hash: string;
  payload_hash: string;
  payload: Record<string, unknown>;
  status: "pending_review" | "accepted" | "rejected" | "withdrawn" | "compiled" | "stale";
  reason_code: string | null;
  updated_at: string;
  action_allowed: boolean;
  action_blocked_code: string | null;
  artifact_import_receipt: {
    receipt_id: string;
    artifact_id: string;
    blob_sha256: string;
    role: "storyboard_image" | "generated_clip";
    mime_type: string;
    created_at: string;
  } | null;
  automation_grant: {
    grant_id: string;
    provider: "runninghub";
    allowed_actions: string[];
    currency: string;
    max_total_minor: number;
    max_per_run_minor: number;
    max_versions_per_shot: number;
    max_automatic_retries: number;
    expires_at: string;
    policy_hash: string;
  } | null;
}

interface DirectorTower {
  project_id: string;
  principal_state: "single_owner_ready" | "no_active_owner" | "ambiguous_active_owner";
  focus: { state: "no_focus" | "active" | "focus_expired"; focus: DirectorFocus | null };
  proposals: DirectorProposal[];
}

const targetLabels: Record<FocusTargetType, string> = {
  project: "项目方向 / 脚本",
  shot: "SHOT / 分镜 / 生成方案",
  artifact: "片段 / 审片",
  delivery: "交付方案",
  memory: "Memory 回存建议"
};

const proposalLabels: Record<string, string> = {
  creative_brief: "创意 Brief", script: "脚本", shot_plan: "SHOT 方案", storyboard_revision: "分镜修订",
  artifact_import: "受控素材导入",
  generation_plan: "生成方案", clip_regeneration: "片段重生成", review_assessment: "审片建议",
  assembly_plan: "合成方案", delivery_plan: "交付方案", memory_saveback: "Memory 回存建议"
};

const DIRECTOR_ARTIFACT_PAGE_SIZE = 200;

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * `datetime-local` deliberately has no timezone.  Build its default from
 * local date parts instead of slicing an ISO/UTC string, because the browser
 * parses the submitted value back as local time.
 */
export function directorLocalDateTimeInputValue(date: Date): string {
  return `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}T${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
}

/**
 * Artifact Focuses must not silently disappear behind the Assets endpoint's
 * 200-item page limit.  Read every stable page before offering the target
 * list, and fail closed if a concurrent or malformed page would make that
 * list incomplete or cross-project.
 */
export async function loadDirectorActiveArtifacts(projectId: string): Promise<MediaArtifact[]> {
  const basePath = `/api/v2/assets/media?scope=all&project_id=${encodeURIComponent(projectId)}&status=active&limit=${DIRECTOR_ARTIFACT_PAGE_SIZE}`;
  const artifacts = new Map<string, MediaArtifact>();
  let offset = 0;
  let expectedTotal: number | null = null;
  for (;;) {
    const page = await apiPage<MediaArtifact>(`${basePath}&offset=${offset}`);
    if (
      page.meta.offset !== offset
      || page.meta.limit < 1
      || page.meta.total < 0
      || (expectedTotal !== null && page.meta.total !== expectedTotal)
    ) {
      throw new Error("DIRECTOR_ARTIFACT_PAGE_INVALID");
    }
    expectedTotal ??= page.meta.total;
    for (const artifact of page.items) {
      if (artifact.status !== "active" || artifact.linked_objects.project_id !== projectId || artifacts.has(artifact.artifact_id)) {
        throw new Error("DIRECTOR_ARTIFACT_PAGE_INVALID");
      }
      artifacts.set(artifact.artifact_id, artifact);
    }
    if (!page.meta.has_more) {
      if (artifacts.size !== expectedTotal) throw new Error("DIRECTOR_ARTIFACT_PAGE_INVALID");
      return [...artifacts.values()];
    }
    const nextOffset = offset + page.items.length;
    if (nextOffset <= offset || nextOffset >= expectedTotal) throw new Error("DIRECTOR_ARTIFACT_PAGE_INVALID");
    offset = nextOffset;
  }
}

export function DirectorPage() {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const projects = useQuery({
    queryKey: ["director-projects"],
    queryFn: () => apiPage<ProjectSummary>("/api/v2/projects?scope=all&lifecycle=active&classification=production&limit=100")
  });
  const projectId = params.get("project") ?? projects.data?.items[0]?.project.project_id ?? "";
  const tower = useQuery({
    queryKey: ["director-tower", projectId],
    queryFn: () => apiGet<DirectorTower>(`/api/v2/director/projects/${encodeURIComponent(projectId)}`),
    enabled: Boolean(projectId)
  });
  const workspace = useQuery({
    queryKey: ["director-workspace", projectId],
    queryFn: () => apiGet<WorkspaceData>(`/api/v2/projects/${encodeURIComponent(projectId)}/overview`),
    enabled: Boolean(projectId)
  });
  // `overview` intentionally contains only the project summary.  Director
  // targets and artifact-import receipts need their own bounded local reads:
  // the storyboard workspace supplies SHOTs, while the Assets API supplies
  // every already-registered active Artifact for this project (not only ones
  // already referenced by a package or clip version).
  const targetWorkspace = useQuery({
    queryKey: ["director-target-workspace", projectId],
    queryFn: () => apiGet<WorkspaceData>(`/api/v2/projects/${encodeURIComponent(projectId)}/storyboard`),
    enabled: Boolean(projectId)
  });
  const artifacts = useQuery({
    queryKey: ["director-artifacts", projectId],
    queryFn: () => loadDirectorActiveArtifacts(projectId),
    enabled: Boolean(projectId)
  });
  const selectProject = (nextProjectId: string) => {
    const next = new URLSearchParams(params);
    if (nextProjectId) next.set("project", nextProjectId); else next.delete("project");
    setParams(next, { replace: true });
  };

  if (projects.isLoading) return <LoadingState />;
  if (projects.isError || !projects.data) return <ErrorState error={projects.error} />;
  return <div className={s.page}>
    <PageHeader eyebrow="ChatGPT 只负责建议" title="Director 审批台" description="先选择讨论对象，再由 ChatGPT 提交不可变提议。此处的接受仅记录人工审批，不会调用 Provider、创建生成任务或覆盖历史版本。" />
    <section className={s.filterRows}>
      <label className={s.field}><span>生产项目</span><select value={projectId} onChange={(event) => selectProject(event.target.value)}>
        {projects.data.items.length === 0 ? <option value="">暂无活动生产项目</option> : projects.data.items.map((item) => <option key={item.project.project_id} value={item.project.project_id}>{item.project.title}</option>)}
      </select></label>
      <button className={s.secondaryButton} onClick={() => { void tower.refetch(); void workspace.refetch(); void targetWorkspace.refetch(); void artifacts.refetch(); }} disabled={!projectId || tower.isFetching}><RefreshCw size={16} /> 刷新审批状态</button>
    </section>
    {!projectId ? <EmptyState title="暂无可用生产项目" detail="创建并分类一个 production 项目后，才能建立 ChatGPT Director Focus。" />
      : tower.isLoading || workspace.isLoading || targetWorkspace.isLoading || artifacts.isLoading ? <LoadingState label="正在读取 Director 审批边界" />
        : tower.isError || workspace.isError || targetWorkspace.isError || artifacts.isError || !tower.data || !workspace.data || !targetWorkspace.data || !artifacts.data ? <ErrorState error={tower.error ?? workspace.error ?? targetWorkspace.error ?? artifacts.error} />
          : <DirectorTowerView key={workspace.data.project.project_id} tower={tower.data} workspace={{
            ...workspace.data,
            shots: targetWorkspace.data.shots ?? [],
            artifacts: Object.fromEntries(artifacts.data.map((artifact) => [artifact.artifact_id, artifact]))
          }} onChanged={() => {
            void tower.refetch();
            void queryClient.invalidateQueries({ queryKey: ["shell"] });
            void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
          }} />}
  </div>;
}

function DirectorTowerView({ tower, workspace, onChanged }: { tower: DirectorTower; workspace: WorkspaceData; onChanged: () => void }) {
  const [targetType, setTargetType] = useState<FocusTargetType>("project");
  const [targetId, setTargetId] = useState(workspace.project.project_id);
  const [confirmed, setConfirmed] = useState(false);
  const focus = useMutation({
    mutationFn: () => apiMutation("/api/v2/director/focus", "POST", { project_id: workspace.project.project_id, target_type: targetType, target_id: targetId, human_confirmation: confirmed }),
    onSuccess: () => { setConfirmed(false); onChanged(); }
  });
  const targets = useMemo(() => focusTargets(workspace, targetType), [workspace, targetType]);
  const selectType = (type: FocusTargetType) => {
    setTargetType(type);
    setTargetId(focusTargets(workspace, type)[0]?.id ?? "");
  };
  const principalReady = tower.principal_state === "single_owner_ready";
  return <>
    <section className={s.metricStrip} aria-label="Director 边界状态">
      <Metric label="本地事实源" value="Workbench" tone="success" />
      <Metric label="当前 Focus" value={tower.focus.state === "active" ? "已建立" : tower.focus.state === "focus_expired" ? "已过期" : "未建立"} tone={tower.focus.state === "active" ? "success" : "warning"} />
      <Metric label="待审批提议" value={String(tower.proposals.filter((item) => item.status === "pending_review").length)} tone="warning" />
      <Metric label="自动执行" value="需 Grant" tone="neutral" />
    </section>
    {!principalReady && <div className={s.inlineError}><ShieldAlert size={16} />{tower.principal_state === "no_active_owner" ? "未找到可用于 ChatGPT Director 的活跃 issuer-bound owner；不会创建无归属 Focus。" : "检测到多个活跃 owner；为避免把 ChatGPT 指向错误身份，当前 Focus 控制已锁定。"}</div>}
    <section className={s.masterDetail}>
      <div className={s.detailPane}>
        <div className={s.objectDetail}>
          <div className={s.detailHeader}><div><span className={s.eyebrow}>第一步</span><h2>设定 ChatGPT 讨论对象</h2></div><StatusPill tone={tower.focus.state === "active" ? "success" : "warning"}>{tower.focus.state === "active" ? "ACTIVE" : "NO FOCUS"}</StatusPill></div>
          {tower.focus.focus ? <KeyValue rows={[["目标", `${targetLabels[tower.focus.focus.target_type]} · ${tower.focus.focus.target_id}`], ["代次", String(tower.focus.focus.generation)], ["过期时间", formatTime(tower.focus.focus.expires_at)]]} /> : <p>选择一个项目、SHOT 或已绑定 Artifact。切换会使旧 Focus 终止；旧提议不会被自动采纳。</p>}
          <div className={s.formGrid}>
            <label className={s.field}><span>讨论层级</span><select value={targetType} onChange={(event) => selectType(event.target.value as FocusTargetType)}>{Object.entries(targetLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
            <label className={s.field}><span>当前对象</span><select value={targetId} onChange={(event) => setTargetId(event.target.value)}>{targets.map((target) => <option key={target.id} value={target.id}>{target.label}</option>)}</select></label>
          </div>
          <label className={s.checkboxRow}><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>我确认将此对象设为 ChatGPT 当前讨论目标；这不会执行生成、采纳或交付。</span></label>
          <div className={s.detailActions}><button className={s.primaryButton} disabled={!principalReady || !targetId || !confirmed || focus.isPending} onClick={() => focus.mutate()}><Sparkles size={16} /> 设为当前讨论对象</button>{focus.isError && <span className={s.inlineError}>{focus.error.message}</span>}</div>
        </div>
      </div>
      <aside className={s.evidencePane}><div className={s.evidencePanel}><div className={s.paneTitle}><strong>不可绕过的边界</strong></div><div className={s.evidenceBody}><div className={s.gateList}><div className={s.gateGood}><Check size={15} />提议版本不可改写</div><div className={s.gateGood}><Check size={15} />接受前重验当前事实状态</div><div className={s.gateBad}><CircleAlert size={15} />不创建 Intent / Grant / Provider 调用</div></div></div></div></aside>
    </section>
    <section className={s.tableSection}>
      <div className={s.sectionTitle}><div><h2>ChatGPT Director 提议</h2><p>接受只追加人工事件。仅接受的生成提议可经第二次确认编译为不可变、限额的 Automation Grant；编译本身不创建 Intent、任务或 Provider 调用。</p></div></div>
      {tower.proposals.length === 0 ? <EmptyState title="还没有 Director 提议" detail="在 ChatGPT 中围绕当前 Focus 讨论后，模型只能提交建议，不能直接执行。" /> : <div className={s.runList}>{tower.proposals.map((proposal) => <ProposalCard key={proposal.proposal_id} proposal={proposal} onChanged={onChanged} />)}</div>}
    </section>
  </>;
}

function ProposalCard({ proposal, onChanged }: { proposal: DirectorProposal; onChanged: () => void }) {
  const [confirmed, setConfirmed] = useState(false);
  const [grantConfirmed, setGrantConfirmed] = useState(false);
  const [maxTotalMinor, setMaxTotalMinor] = useState(1_000);
  const [maxPerRunMinor, setMaxPerRunMinor] = useState(500);
  const [maxVersionsPerShot, setMaxVersionsPerShot] = useState(2);
  const [maxAutomaticRetries, setMaxAutomaticRetries] = useState(0);
  const [grantExpiry, setGrantExpiry] = useState(() => directorLocalDateTimeInputValue(new Date(Date.now() + 60 * 60_000)));
  const [startConfirmed, setStartConfirmed] = useState(false);
  const [importConfirmed, setImportConfirmed] = useState(false);
  const [selectedArtifactId, setSelectedArtifactId] = useState("");
  const [reasonCode, setReasonCode] = useState("DIRECTOR_HUMAN_REJECTED");
  const decision = useMutation({
    mutationFn: (value: ProposalDecision) => apiMutation(`/api/v2/director/proposals/${encodeURIComponent(proposal.proposal_id)}/decision`, "POST", { decision: value, reason_code: value === "reject" ? reasonCode : undefined, human_confirmation: confirmed }),
    onSuccess: () => { setConfirmed(false); onChanged(); }
  });
  const compile = useMutation({
    mutationFn: () => apiMutation(`/api/v2/director/proposals/${encodeURIComponent(proposal.proposal_id)}/compile`, "POST", {
      max_total_minor: maxTotalMinor, max_per_run_minor: maxPerRunMinor, max_versions_per_shot: maxVersionsPerShot,
      max_automatic_retries: maxAutomaticRetries, expires_at: new Date(grantExpiry).toISOString(), human_confirmation: grantConfirmed
    }),
    onSuccess: () => { setGrantConfirmed(false); onChanged(); }
  });
  const start = useMutation({
    mutationFn: () => apiMutation(`/api/v2/director/grants/${encodeURIComponent(proposal.automation_grant!.grant_id)}/start`, "POST", {
      proposal_id: proposal.proposal_id, policy_hash: proposal.automation_grant!.policy_hash, account_label: "personal", human_confirmation: startConfirmed
    }),
    onSuccess: () => { setStartConfirmed(false); onChanged(); }
  });
  const importReceipt = useMutation({
    mutationFn: (artifactId: string) => apiMutation(`/api/v2/director/proposals/${encodeURIComponent(proposal.proposal_id)}/artifact-import-receipt`, "POST", {
      artifact_id: artifactId,
      human_confirmation: importConfirmed
    }),
    onSuccess: () => { setImportConfirmed(false); onChanged(); }
  });
  const pending = proposal.status === "pending_review" && proposal.action_allowed;
  const compilable = proposal.status === "accepted" && proposal.automation_grant === null && (proposal.kind === "generation_plan" || proposal.kind === "clip_regeneration");
  const importReceiptable = proposal.status === "accepted" && proposal.kind === "artifact_import" && proposal.artifact_import_receipt === null;
  const importCandidatePath = artifactImportCandidatePath(proposal);
  const importCandidates = useQuery({
    queryKey: ["director-artifact-import-candidates", importCandidatePath],
    queryFn: () => apiPage<MediaArtifact>(importCandidatePath ?? ""),
    enabled: importReceiptable && importCandidatePath !== null
  });
  const matchingImportCandidates = importCandidates.data?.items ?? [];
  const resolvedArtifactId = selectedArtifactId || matchingImportCandidates[0]?.artifact_id || "";
  const proposalCurrency = typeof proposal.payload.currency === "string" ? proposal.payload.currency : "";
  const budgetUnitLabel = proposalCurrency === "CNY" ? "CNY 分（100 分 = 1 元）" : proposalCurrency === "RH_COINS" ? "RH_COINS" : "minor units";
  return <article className={s.evidencePanel}>
    <div className={s.detailHeader}><div><span className={s.eyebrow}>{proposalLabels[proposal.kind] ?? proposal.kind}</span><h3>{proposalSummary(proposal)}</h3></div><StatusPill tone={proposalTone(proposal.status)}>{proposalStatusLabel(proposal.status)}</StatusPill></div>
    <KeyValue rows={[["来源", proposal.source === "native" ? "ChatGPT Native" : "手动导入（不可信）"], ["目标", `${proposal.target_type} · ${proposal.target_id}`], ["Focus", `#${proposal.focus_generation}`], ["创建", formatTime(proposal.created_at)], ["状态原因", proposal.reason_code ?? "-" ]]} />
    <details className={s.rawDetails}><summary>查看结构化提议（本地人类审批可见）</summary><pre>{JSON.stringify(proposal.payload, null, 2)}</pre></details>
    {pending ? <div className={s.actionPanel}><label className={s.checkboxRow}><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>我已核对当前状态和影响。接受只记录审批，不会执行 Provider、采纳视频或交付。</span></label><label className={s.field}><span>拒绝原因代码</span><select value={reasonCode} onChange={(event) => setReasonCode(event.target.value)}><option value="DIRECTOR_HUMAN_REJECTED">不采纳此建议</option><option value="DIRECTOR_SCOPE_NEEDS_REVISION">需要修改范围</option><option value="DIRECTOR_CREATIVE_DIRECTION_REJECTED">创意方向不符合</option><option value="DIRECTOR_BUDGET_NOT_APPROVED">预算未批准</option></select></label><div className={s.buttonRow}><button className={s.dangerButton} disabled={!confirmed || decision.isPending} onClick={() => decision.mutate("reject")}><X size={16} /> 拒绝提议</button><button className={s.primaryButton} disabled={!confirmed || decision.isPending} onClick={() => decision.mutate("accept")}><Check size={16} /> 接受提议</button></div>{decision.isError && <div className={s.inlineError}>{decision.error.message}</div>}</div>
      : importReceiptable ? <div className={s.actionPanel}><p>先在 Assets 中由 Jenn 选择本地文件并完成既有 Artifact/Blob 校验；此处仅把一个已注册、同项目同 SHOT 的 Artifact 记入不可变回执。操作不接受或保存路径、URL、文件字节；记录前会重新读取已注册本地 Artifact 的字节，以核验 Blob digest 与 MIME，不会启动生成。</p>{importCandidates.isLoading ? <p>正在读取与此提议精确匹配的已注册 Artifact。</p> : importCandidates.isError || importCandidatePath === null ? <div className={s.inlineError}>无法读取与此提议相符的已注册 Artifact；不会记录回执。</div> : matchingImportCandidates.length === 0 ? <div className={s.inlineError}>没有与此提议的角色、MIME 和 SHOT 相符的已注册 Artifact。</div> : <><label className={s.field}><span>已验证的本地 Artifact</span><select value={resolvedArtifactId} onChange={(event) => setSelectedArtifactId(event.target.value)}>{matchingImportCandidates.map((artifact) => <option key={artifact.artifact_id} value={artifact.artifact_id}>{artifact.role} · {artifact.artifact_id} · {artifact.storage.mime_type}</option>)}</select></label><label className={s.checkboxRow}><input type="checkbox" checked={importConfirmed} onChange={(event) => setImportConfirmed(event.target.checked)} /><span>我确认该 Artifact 已由本地导入流程校验，且应作为本提议的一次性受控导入回执。</span></label><div className={s.buttonRow}><button className={s.primaryButton} disabled={!resolvedArtifactId || !importConfirmed || importReceipt.isPending} onClick={() => importReceipt.mutate(resolvedArtifactId)}><Check size={16} /> 记录不可变导入回执</button></div>{importReceipt.isError && <div className={s.inlineError}>{importReceipt.error.message}</div>}</>}</div>
      : proposal.artifact_import_receipt ? <div className={s.inlineNotice}>已记录不可变导入回执 · {proposal.artifact_import_receipt.role} · {proposal.artifact_import_receipt.mime_type} · {proposal.artifact_import_receipt.artifact_id}。该回执不保存源路径、URL 或文件内容。</div>
      : compilable ? <div className={s.actionPanel}><p>第二次确认才会创建不可变 Grant。它只授权 RunningHub 的受限后续编排；当前动作不会发起任何 Provider 请求。</p><div className={s.formGrid}><label className={s.field}><span>总上限（{budgetUnitLabel}）</span><input type="number" min="1" value={maxTotalMinor} onChange={(event) => setMaxTotalMinor(Number(event.target.value))} /></label><label className={s.field}><span>单次上限（{budgetUnitLabel}）</span><input type="number" min="1" value={maxPerRunMinor} onChange={(event) => setMaxPerRunMinor(Number(event.target.value))} /></label><label className={s.field}><span>每 SHOT 最大版本</span><input type="number" min="1" max="20" value={maxVersionsPerShot} onChange={(event) => setMaxVersionsPerShot(Number(event.target.value))} /></label><label className={s.field}><span>自动重试次数</span><input type="number" min="0" max="5" value={maxAutomaticRetries} onChange={(event) => setMaxAutomaticRetries(Number(event.target.value))} /></label><label className={s.field}><span>Grant 到期</span><input type="datetime-local" value={grantExpiry} onChange={(event) => setGrantExpiry(event.target.value)} /></label></div><label className={s.checkboxRow}><input type="checkbox" checked={grantConfirmed} onChange={(event) => setGrantConfirmed(event.target.checked)} /><span>我确认此限额、版本和有效期；我知道编译会写入不可变授权证据，但不会提交 Provider。</span></label><div className={s.buttonRow}><button className={s.primaryButton} disabled={!grantConfirmed || compile.isPending} onClick={() => compile.mutate()}><ShieldAlert size={16} /> 编译有界 Automation Grant</button></div>{compile.isError && <div className={s.inlineError}>{compile.error.message}</div>}</div>
        : proposal.automation_grant ? <div className={s.actionPanel}><div className={s.inlineNotice}>已编译 Grant · {proposal.automation_grant.provider} · {proposal.automation_grant.currency} {proposal.automation_grant.max_total_minor} · 到期 {formatTime(proposal.automation_grant.expires_at)}。它不会绕过 Provider、预算、成员资格或事实状态门禁。</div><label className={s.checkboxRow}><input type="checkbox" checked={startConfirmed} onChange={(event) => setStartConfirmed(event.target.checked)} /><span>我确认启动这次已编译、受限的生成。系统仍会先重验官方价格、余额、能力和当前事实状态；默认 Provider 关闭时会 fail closed。</span></label><div className={s.buttonRow}><button className={s.primaryButton} disabled={!startConfirmed || start.isPending} onClick={() => start.mutate()}><Sparkles size={16} /> 启动有界生成</button></div>{start.isError && <div className={s.inlineError}>{start.error.message}</div>}</div>
          : <div className={s.inlineNotice}>{proposal.status === "stale" ? `该提议的 Focus 或事实状态已变化（${proposal.action_blocked_code ?? "DIRECTOR_FOCUS_STALE"}），不能被采纳。` : "该提议已进入不可逆的事件历史，不能再次决定。"}</div>}
  </article>;
}

function focusTargets(workspace: WorkspaceData, type: FocusTargetType): Array<{ id: string; label: string }> {
  if (type === "project" || type === "delivery" || type === "memory") return [{ id: workspace.project.project_id, label: workspace.project.title }];
  if (type === "shot") return (workspace.shots ?? []).map((shot) => ({ id: shot.shot_id, label: `SHOT ${String(shot.order).padStart(3, "0")} · ${shot.description || shot.shot_id}` }));
  return Object.values(workspace.artifacts ?? {}).filter((artifact) => artifact.status === "active" && artifact.linked_objects.project_id === workspace.project.project_id).map((artifact) => ({ id: artifact.artifact_id, label: `${artifact.role} · ${artifact.artifact_id}` }));
}

function artifactImportCandidatePath(proposal: DirectorProposal): string | null {
  if (proposal.kind !== "artifact_import") return null;
  const shotId = typeof proposal.payload.shot_id === "string" ? proposal.payload.shot_id : "";
  const role = proposal.payload.target_role === "storyboard_image" || proposal.payload.target_role === "generated_clip" ? proposal.payload.target_role : "";
  const mimeType = typeof proposal.payload.expected_mime_type === "string" ? proposal.payload.expected_mime_type : "";
  if (!proposal.project_id || !shotId || !role || !mimeType) return null;
  return `/api/v2/assets/media?scope=all&project_id=${encodeURIComponent(proposal.project_id)}&shot_id=${encodeURIComponent(shotId)}&role=${encodeURIComponent(role)}&mime_type=${encodeURIComponent(mimeType)}&status=active&limit=200`;
}

function Metric({ label, value, tone }: { label: string; value: string; tone: "success" | "warning" | "neutral" }) { return <div className={s.metricCell}><span>{label}</span><strong>{value}</strong><StatusPill tone={tone}>{tone === "success" ? "OK" : tone === "warning" ? "WAIT" : "LOCKED"}</StatusPill></div>; }
function proposalSummary(proposal: DirectorProposal) { return String(proposal.payload.summary ?? proposal.payload.diagnosis ?? proposal.payload.rationale ?? proposal.kind); }
function proposalStatusLabel(value: DirectorProposal["status"]) { return ({ pending_review: "待审批", accepted: "已接受", rejected: "已拒绝", withdrawn: "已撤回", compiled: "已编译", stale: "已过期" } as Record<string, string>)[value]; }
function proposalTone(value: DirectorProposal["status"]): "success" | "warning" | "danger" | "neutral" { return value === "accepted" || value === "compiled" ? "success" : value === "rejected" || value === "stale" ? "danger" : value === "pending_review" ? "warning" : "neutral"; }
function formatTime(value: string) { return value ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "-"; }
