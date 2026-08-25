import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Check, CircleAlert, Clock3, Download, Edit3, Film, Pin, Play, RotateCcw, Save, ShieldCheck } from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { apiGet, apiMutation, closeoutDelivery, confirmGeneration, preflightDeliveryAssembly, preflightGeneration, reconcileGeneration, startDeliveryAssembly, startDeliveryExport, submitFinalReview } from "../api";
import { EmptyState, ErrorState, KeyValue, LoadingState, MediaPreview, Modal, PageHeader, preserveVisibleVirtualScrolls, SegmentedTabs, StatusPill, VirtualList } from "../components";
import type { AssemblyPreflight, ClipVersion, DeliveryJob, GenerationIntent, GenerationRun, MediaArtifact, ReconciliationItem, ReviewNote, Shot, WorkspaceData } from "../types";
import s from "../workbench.module.css";

const workspaceTabs = [
  { id: "overview", label: "总览" },
  { id: "storyboard", label: "分镜" },
  { id: "generation", label: "生成" },
  { id: "review", label: "审片" },
  { id: "delivery", label: "交付" }
];

export function ProjectWorkspacePage() {
  const { id = "", workspace = "overview" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [overrideOpen, setOverrideOpen] = useState(false);
  const query = useQuery({
    queryKey: ["project-workspace", id, workspace],
    queryFn: () => apiGet<WorkspaceData>(`/api/v2/projects/${encodeURIComponent(id)}/${workspace}`),
    refetchInterval: (current) => workspace === "generation"
      ? 10_000
      : workspace === "delivery" && (current.state.data as WorkspaceData | undefined)?.active_job
        ? 5_000
        : false
  });
  const projectMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiMutation(`/api/v2/projects/${encodeURIComponent(id)}`, "PATCH", body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["project-workspace", id] })
  });
  const lifecycleMutation = useMutation({
    mutationFn: (action: "archive" | "restore") => apiMutation(`/api/v2/projects/${encodeURIComponent(id)}/${action}`, "POST", {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["project-workspace", id] })
  });
  if (query.isLoading) return <LoadingState />;
  if (query.isError || !query.data) return <ErrorState error={query.error} />;
  const { project, meta } = query.data;
  const summary = query.data.summary;
  return <div className={s.page}>
    <PageHeader eyebrow={`${classificationLabel(meta.classification)} · ${project.project_id}`} title={project.title} description={`${project.video_spec.aspect_ratio} · ${project.video_spec.resolution} · ${project.video_spec.duration_seconds}s`} actions={<div className={s.headerActions}>
      <button className={s.iconButton} aria-label={meta.pinned ? "取消置顶" : "置顶项目"} onClick={() => projectMutation.mutate({ pinned: !meta.pinned })}><Pin size={17} fill={meta.pinned ? "currentColor" : "none"} /></button>
      <button className={s.iconButton} aria-label="指定下一步动作" onClick={() => setOverrideOpen(true)}><Edit3 size={17} /></button>
      {meta.lifecycle === "active" ? <button className={s.secondaryButton} onClick={() => lifecycleMutation.mutate("archive")}><Archive size={16} /> 归档</button> : <button className={s.secondaryButton} onClick={() => lifecycleMutation.mutate("restore")}><RotateCcw size={16} /> 恢复</button>}
    </div>} />
    <div className={s.projectNav}><SegmentedTabs ariaLabel="项目工作区" panelId="project-workspace-panel" items={workspaceTabs} active={workspace} onChange={(value) => navigate(`/v2/projects/${encodeURIComponent(id)}/${value}`)} />{meta.lifecycle === "archived" && <StatusPill tone="warning">只读归档</StatusPill>}</div>
    <div id="project-workspace-panel" role="tabpanel" aria-label="项目工作区内容" className={s.workspacePanel}>
      {workspace === "overview" && <OverviewWorkspace data={query.data} />}
      {workspace === "storyboard" && <StoryboardWorkspace data={query.data} />}
      {workspace === "generation" && <GenerationWorkspace data={query.data} />}
      {workspace === "review" && <ReviewWorkspace data={query.data} />}
      {workspace === "delivery" && <DeliveryWorkspace data={query.data} />}
    </div>
    {overrideOpen && summary && <NextActionModal projectId={id} summary={summary} onClose={() => setOverrideOpen(false)} />}
  </div>;
}

function OverviewWorkspace({ data }: { data: WorkspaceData }) {
  const metrics = data.metrics ?? {};
  return <div className={s.overviewLayout}>
    {data.summary && <section className={s.nextActionBand}><div><span className={s.eyebrow}>当前下一步</span><h2>{data.summary.next_action.label}</h2><p>{data.summary.next_action.source === "override" ? `人工指定，自动建议：${data.summary.next_action.derived.label}` : "根据当前生产事实自动推导"}</p></div><StatusPill tone={data.summary.next_action.priority === "urgent" ? "danger" : data.summary.next_action.priority === "high" ? "warning" : "info"}>{data.summary.next_action.source === "override" ? "人工指定" : "自动建议"}</StatusPill></section>}
    <section className={s.metricStrip}>{[["SHOT", metrics.shots ?? 0], ["已过分镜", metrics.storyboard_approved ?? 0], ["生成中", metrics.generation_active ?? 0], ["待审", metrics.review_pending ?? 0], ["已采纳", metrics.accepted_clips ?? 0]].map(([label, value]) => <div className={s.metricCell} key={label}><span>{label}</span><strong>{value}</strong></div>)}</section>
    <div className={s.overviewColumns}>
      <section className={s.tableSection}><div className={s.sectionTitle}><div><h2>当前阻断</h2><p>只显示会阻止下一步的生产事实。</p></div></div>{data.blockers?.length ? <div className={s.blockerList}>{data.blockers.map((blocker, index) => <div key={`${blocker.shot_id}-${index}`}><CircleAlert size={16} /><strong>{String(blocker.shot_id)}</strong><span>{blockerText(blocker)}</span></div>)}</div> : <EmptyState title="没有结构阻断" detail="项目可以继续推进。" />}</section>
      <section className={s.tableSection}><div className={s.sectionTitle}><div><h2>最近生成</h2><p>同项目最近 8 个运行。</p></div></div><RunList runs={data.recent_runs ?? []} /></section>
    </div>
  </div>;
}

function NextActionModal({ projectId, summary, onClose }: { projectId: string; summary: NonNullable<WorkspaceData["summary"]>; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState(summary.next_action.source === "override" ? summary.next_action.label : summary.next_action.derived.label);
  const [priority, setPriority] = useState<"urgent" | "high" | "normal">(summary.next_action.source === "override" ? summary.next_action.priority : summary.next_action.derived.priority);
  const mutation = useMutation({
    mutationFn: (clear: boolean) => apiMutation(`/api/v2/projects/${encodeURIComponent(projectId)}`, "PATCH", { next_action_override: clear ? null : { label, priority } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project-workspace", projectId] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      onClose();
    }
  });
  return <Modal title="指定下一步动作" onClose={onClose} footer={<><button className={s.secondaryButton} disabled={summary.next_action.source !== "override" || mutation.isPending} onClick={() => mutation.mutate(true)}>恢复自动建议</button><button className={s.primaryButton} disabled={!label.trim() || mutation.isPending} onClick={() => mutation.mutate(false)}>保存人工指定</button></>}>
    <div className={s.advisoryBox}><span>当前自动建议</span><strong>{summary.next_action.derived.label}</strong><small>阶段变化或保存满 7 天后，人工指定会自动失效。</small></div>
    <label className={s.field}><span>下一步动作</span><input autoFocus maxLength={120} value={label} onChange={(event) => setLabel(event.target.value)} /></label>
    <label className={s.field}><span>优先级</span><select value={priority} onChange={(event) => setPriority(event.target.value as "urgent" | "high" | "normal")}><option value="urgent">紧急</option><option value="high">高</option><option value="normal">普通</option></select></label>
    {mutation.isError && <div className={s.inlineError}>{mutation.error.message}</div>}
  </Modal>;
}

function StoryboardWorkspace({ data }: { data: WorkspaceData }) {
  const [params, setParams] = useSearchParams();
  const shots = data.shots ?? [];
  const selected = selectShot(shots, params.get("selected"));
  const evidence = selected ? <StoryboardEvidence shot={selected} projectId={data.project.project_id} readOnly={data.meta.lifecycle === "archived"} /> : null;
  return <ThreePane
    queue={<ShotQueue shots={shots} selectedId={selected?.shot_id ?? ""} scrollKey={`${data.project.project_id}:storyboard`} onSelect={(shot) => setSelected(params, setParams, shot.shot_id)} />}
    detail={selected ? <StoryboardDetail shot={selected} artifact={data.artifacts?.[selected.storyboard_image_artifact_id]} projectId={data.project.project_id} readOnly={data.meta.lifecycle === "archived"} /> : <EmptyState title="项目尚无 SHOT" />}
    evidence={evidence}
  />;
}

function StoryboardDetail({ shot, artifact, projectId, readOnly }: { shot: Shot; artifact?: MediaArtifact; projectId: string; readOnly: boolean }) {
  const queryClient = useQueryClient();
  const [description, setDescription] = useState(shot.description);
  const [prompt, setPrompt] = useState(shot.video_prompt);
  const [negative, setNegative] = useState(shot.negative_prompt);
  useEffect(() => { setDescription(shot.description); setPrompt(shot.video_prompt); setNegative(shot.negative_prompt); }, [shot]);
  const mutation = useMutation({ mutationFn: () => apiMutation(`/api/v2/projects/${encodeURIComponent(projectId)}/shots/${encodeURIComponent(shot.shot_id)}`, "PATCH", { description, video_prompt: prompt, negative_prompt: negative }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["project-workspace", projectId] }) });
  return <div className={s.objectDetail}>
    <div className={s.detailHeader}><div><span className={s.eyebrow}>SHOT {String(shot.order).padStart(3, "0")}</span><h2>{shot.description || "未命名镜头"}</h2></div><StatusPill tone={operationalTone(shot)}>{operationalLabel(shot)}</StatusPill></div>
    <div className={s.storyboardStage}><MediaPreview artifact={artifact} /></div>
    <div className={s.editorFields}><label className={s.field}><span>画面说明</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} disabled={readOnly} /></label><label className={s.field}><span>视频提示词</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={5} disabled={readOnly} /></label><label className={s.field}><span>负向提示词</span><textarea value={negative} onChange={(event) => setNegative(event.target.value)} rows={2} disabled={readOnly} /></label></div>
    <div className={s.detailActions}><button className={s.primaryButton} disabled={readOnly || mutation.isPending} onClick={() => mutation.mutate()}><Save size={16} /> 保存 SHOT</button>{mutation.isSuccess && <StatusPill tone="success">已保存</StatusPill>}{mutation.isError && <span className={s.inlineError}>{mutation.error.message}</span>}</div>
  </div>;
}

function StoryboardEvidence({ shot, projectId, readOnly }: { shot: Shot; projectId: string; readOnly: boolean }) {
  const queryClient = useQueryClient();
  const approve = useMutation({ mutationFn: () => apiMutation(`/api/v2/projects/${encodeURIComponent(projectId)}/shots/${encodeURIComponent(shot.shot_id)}`, "PATCH", { approve_storyboard: true, human_confirmation: true }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["project-workspace", projectId] }) });
  const blockers = [!shot.storyboard_image_artifact_id && "缺少分镜图", !shot.video_prompt && "缺少视频提示词"].filter(Boolean);
  return <EvidencePanel title="分镜门禁">
    <KeyValue rows={[["SHOT ID", shot.shot_id], ["时长", `${shot.duration_seconds}s`], ["分镜图", shot.storyboard_image_artifact_id ? "已绑定" : "未绑定"], ["提示词", shot.video_prompt ? "已填写" : "未填写"]]} />
    <div className={s.gateList}>{blockers.length ? blockers.map((item) => <div className={s.gateBad} key={String(item)}><CircleAlert size={15} />{item}</div>) : <div className={s.gateGood}><ShieldCheck size={15} />可批准分镜</div>}</div>
    <button className={s.primaryButton} disabled={readOnly || blockers.length > 0 || shot.status === "storyboard_approved" || approve.isPending} onClick={() => approve.mutate()}><Check size={16} /> 批准该 SHOT</button>
  </EvidencePanel>;
}

function GenerationWorkspace({ data }: { data: WorkspaceData }) {
  const [params, setParams] = useSearchParams();
  const shots = data.shots ?? [];
  const selected = selectShot(shots, params.get("selected"));
  const [modal, setModal] = useState(false);
  const disabledReasonId = useId();
  const disabledReason = selected ? generationDisabledReason(data, selected) : "项目尚无可生成 SHOT。";
  const evidence = <><ReconciliationPanel data={data} /><EvidencePanel title="运行记录"><RunList runs={(data.runs ?? []).filter((run) => !selected || run.shot_id === selected.shot_id)} /></EvidencePanel></>;
  return <>
    <ThreePane
      queue={<ShotQueue shots={shots} selectedId={selected?.shot_id ?? ""} scrollKey={`${data.project.project_id}:generation`} onSelect={(shot) => setSelected(params, setParams, shot.shot_id)} />}
      detail={selected ? <div className={s.objectDetail}><div className={s.detailHeader}><div><span className={s.eyebrow}>单 SHOT 生成</span><h2>SHOT {String(selected.order).padStart(3, "0")}</h2></div><StatusPill tone={operationalTone(selected)}>{operationalLabel(selected)}</StatusPill></div><div className={s.storyboardStage}><MediaPreview artifact={data.artifacts?.[selected.storyboard_image_artifact_id]} /></div><KeyValue rows={[["Provider", "RunningHub"], ["模型", "rhart-video-g/image-to-video"], ["时长", `${selected.duration_seconds}s`], ["输出", "480p · 9:16"], ["提交策略", "一次上传 / 一次提交 / 零自动重提"]]} /><div className={s.detailActions}><button className={s.primaryButton} disabled={Boolean(disabledReason)} aria-describedby={disabledReason ? disabledReasonId : undefined} onClick={() => setModal(true)}><Play size={16} /> 预检并生成</button></div>{disabledReason && <p id={disabledReasonId} className={s.inlineNotice}>下一步：{disabledReason}</p>}</div> : <EmptyState title="项目尚无可生成 SHOT" />}
      evidence={evidence}
    />
    {modal && selected && <GenerationModal projectId={data.project.project_id} shot={selected} artifact={data.artifacts?.[selected.storyboard_image_artifact_id]} onClose={() => setModal(false)} />}
  </>;
}

function ReconciliationPanel({ data }: { data: WorkspaceData }) {
  const [dialog, setDialog] = useState<{ item: ReconciliationItem; decision: "attach_existing_task" | "abandon" } | null>(null);
  const readOnly = data.meta.lifecycle === "archived" || data.project.status === "final_approved";
  const items = data.reconciliation_items ?? [];
  return <>
    <EvidencePanel title="人工核对">
      {items.length ? <div className={s.reconciliationList}>{items.map((item) => <div key={item.job_id} className={s.reconciliationItem}>
        <div><strong>{item.shot_id}</strong><small>{item.reason_code}</small><StatusPill tone={item.has_provider_task_id ? "info" : "warning"}>{item.has_provider_task_id ? "已记录 task ID" : "待输入 task ID"}</StatusPill></div>
        <button className={s.secondaryButton} disabled={readOnly || Boolean(item.reference_error_code)} onClick={() => setDialog({ item, decision: "attach_existing_task" })}>{item.has_provider_task_id ? "继续核对已记录任务" : "输入现有 task ID"}</button>
        <button className={s.dangerButton} disabled={readOnly || Boolean(item.reference_error_code)} onClick={() => setDialog({ item, decision: "abandon" })}>放弃本次尝试</button>
      </div>)}</div> : <EmptyState title="没有待人工核对的生成" />}
    </EvidencePanel>
    {dialog && <ReconciliationModal projectId={data.project.project_id} item={dialog.item} decision={dialog.decision} onClose={() => setDialog(null)} />}
  </>;
}

function ReconciliationModal({ projectId, item, decision, onClose }: { projectId: string; item: ReconciliationItem; decision: "attach_existing_task" | "abandon"; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [taskId, setTaskId] = useState("");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const needsTaskId = decision === "attach_existing_task" && !item.has_provider_task_id;
  const valid = confirmed && (decision === "attach_existing_task" ? !needsTaskId || taskId.trim().length >= 3 : reason.trim().length >= 3);
  const mutation = useMutation({
    mutationFn: () => reconcileGeneration(item.job_id, {
      decision,
      ...(needsTaskId ? { provider_task_id: taskId.trim() } : {}),
      ...(decision === "abandon" ? { reason: reason.trim() } : {}),
      human_confirmation: true
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project-workspace", projectId] });
      queryClient.invalidateQueries({ queryKey: ["shell"] });
      onClose();
    }
  });
  return <Modal title={decision === "attach_existing_task" ? "继续人工核对" : "放弃本次生成尝试"} onClose={onClose} footer={<><button className={s.secondaryButton} onClick={onClose}>取消</button><button className={decision === "abandon" ? s.dangerButton : s.primaryButton} disabled={!valid || mutation.isPending} onClick={() => mutation.mutate()}>{decision === "abandon" ? "确认放弃" : "继续核对"}</button></>}>
    <div className={s.advisoryBox}><strong>{item.shot_id}</strong><small>{item.reason_code}</small><small>此操作只会恢复 polling / download 或结束当前 Intent，绝不会重新 submit。</small></div>
    {needsTaskId && <label className={s.field}><span>现有 Provider task ID</span><input autoFocus value={taskId} onChange={(event) => setTaskId(event.target.value)} autoComplete="off" /></label>}
    {decision === "abandon" && <label className={s.field}><span>放弃原因（必填）</span><textarea autoFocus rows={4} maxLength={1_000} value={reason} onChange={(event) => setReason(event.target.value)} /></label>}
    <label className={s.checkboxRowInline}><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>{decision === "abandon" ? "我确认结束这次生成 Intent；已有 Provider 任务不会被重新提交。" : "我确认这是已存在的 Provider 任务，只继续核对而不重新提交。"}</span></label>
    {mutation.isError && <div className={s.inlineError}>{mutation.error.message}</div>}
  </Modal>;
}

function GenerationModal({ projectId, shot, artifact, onClose }: { projectId: string; shot: Shot; artifact?: MediaArtifact; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [account, setAccount] = useState<"personal" | "team">("personal");
  const [budget, setBudget] = useState(1);
  const [model, setModel] = useState("rhart-video-g/image-to-video");
  const [intent, setIntent] = useState<GenerationIntent | null>(null);
  const [costChecked, setCostChecked] = useState(false);
  const seedance = model === "seedance-v1.5-pro/image-to-video";
  const preflight = useMutation({ mutationFn: () => preflightGeneration(projectId, { shot_id: shot.shot_id, account_label: account, budget_limit_value: budget, model }), onSuccess: (data) => setIntent(data.intent) });
  const confirm = useMutation({ mutationFn: () => confirmGeneration(intent?.intent_id ?? "", budget), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["project-workspace", projectId] }); queryClient.invalidateQueries({ queryKey: ["shell"] }); onClose(); } });
  return <Modal title={intent ? "确认一次真实生成" : "RunningHub 生成预检"} onClose={onClose} footer={<><button className={s.secondaryButton} onClick={onClose}>取消</button>{intent ? <button className={s.primaryButton} disabled={!costChecked || confirm.isPending} onClick={() => confirm.mutate()}>确认生成</button> : <button className={s.primaryButton} disabled={budget <= 0 || preflight.isPending} onClick={() => preflight.mutate()}>运行预检</button>}</>}>
    <div className={s.generationSummary}><MediaPreview artifact={artifact} /><KeyValue rows={[["Provider", "RunningHub"], ["账户", account === "personal" ? "个人账户" : "团队账户"], ["模型", model], ["SHOT", shot.shot_id], ["时长", `${shot.duration_seconds}s`], ["分辨率", seedance ? "720p" : "480p"]]} /></div>
    {!intent ? <div className={s.formGrid}><label className={s.field}><span>模型</span><select value={model} onChange={(event) => setModel(event.target.value)}><option value="rhart-video-g/image-to-video">Grok Imagine Video（默认）</option><option value="seedance-v1.5-pro/image-to-video">Seedance V1.5 Pro</option></select></label><label className={s.field}><span>账户标签</span><select value={account} onChange={(event) => setAccount(event.target.value as "personal" | "team")}><option value="personal">个人账户</option><option value="team">团队账户</option></select></label><label className={s.field}><span>本次预算上限</span><input type="number" min="0.01" step="0.01" value={budget} onChange={(event) => setBudget(Number(event.target.value))} /></label>{seedance && <div className={s.advisoryBox}><strong>Seedance V1.5 Pro</strong><small>仅接受 5 秒、720p；按官方示例使用 adaptive 画幅，默认关闭音频与固定机位。</small></div>}</div> : <div className={s.confirmationBox}><div><span>官方预计费用</span><strong>{intent.estimated_cost_value} {intent.currency}</strong></div><div><span>可用余额</span><strong>{intent.input_snapshot.account_balance_value} {intent.input_snapshot.account_balance_currency}</strong></div><div><span>预算上限</span><strong>{budget} {intent.currency}</strong></div><label className={s.checkboxRow}><input type="checkbox" checked={costChecked} onChange={(event) => setCostChecked(event.target.checked)} /><span>我确认本次费用，并同意仅为该 SHOT 提交一次真实生成。</span></label></div>}
    {(preflight.isError || confirm.isError) && <div className={s.inlineError}>{preflight.error?.message ?? confirm.error?.message}</div>}
  </Modal>;
}

function ReviewWorkspace({ data }: { data: WorkspaceData }) {
  const [params, setParams] = useSearchParams();
  const stacks = data.version_stacks ?? [];
  const selectedStack = stacks.find((stack) => stack.shot.shot_id === params.get("selected")) ?? stacks[0];
  const selectedVersion = selectedStack?.versions.find((version) => version.artifact_id === params.get("version")) ?? selectedStack?.versions.at(-1);
  const selectShotVersion = (shotId: string, artifactId?: string) => { const next = new URLSearchParams(params); next.set("selected", shotId); if (artifactId) next.set("version", artifactId); else next.delete("version"); setParams(next, { replace: true }); };
  const evidence = selectedStack && selectedVersion ? <><ReviewDecision projectId={data.project.project_id} shot={selectedStack.shot} version={selectedVersion} readOnly={data.meta.lifecycle === "archived"} /><ReviewNotes notes={(data.review_notes ?? []).filter((note) => note.shot_id === selectedStack.shot.shot_id)} /></> : null;
  return <ThreePane
    queue={<><div className={s.paneTitle}><strong>SHOT 版本栈</strong><span>{stacks.length}</span></div><VirtualList items={stacks} estimate={92} scrollKey={`${data.project.project_id}:review`} renderItem={(stack) => <button className={`${s.queueItem} ${stack.shot.shot_id === selectedStack?.shot.shot_id ? s.queueItemActive : ""}`} onClick={() => selectShotVersion(stack.shot.shot_id)}><span className={s.queueIcon}><Film size={18} /></span><span><strong>SHOT {String(stack.shot.order).padStart(3, "0")}</strong><small>{stack.versions.length} 个版本 · {stack.shot.operational_state?.review.stage ?? stack.shot.review.approval_status}</small></span><StatusPill tone={operationalTone(stack.shot)}>{operationalLabel(stack.shot)}</StatusPill></button>} /></>}
    detail={selectedStack && selectedVersion ? <div className={s.objectDetail}><div className={s.detailHeader}><div><span className={s.eyebrow}>SHOT {String(selectedStack.shot.order).padStart(3, "0")} · 版本 {selectedVersion.attempt_number}</span><h2>{selectedStack.shot.description || selectedStack.shot.shot_id}</h2></div><StatusPill tone={selectedVersion.review_status === "approved" ? "success" : selectedVersion.review_status === "rejected" ? "danger" : "warning"}>{selectedVersion.review_status}</StatusPill></div><div className={s.reviewStage}><MediaPreview artifact={selectedVersion.artifact} /></div><div className={s.versionStrip}>{selectedStack.versions.map((version) => <button key={version.artifact_id} className={version.artifact_id === selectedVersion.artifact_id ? s.versionActive : ""} onClick={() => selectShotVersion(selectedStack.shot.shot_id, version.artifact_id)}>V{version.attempt_number}<small>{version.review_status}</small></button>)}</div></div> : <EmptyState title="没有生成片段" detail="生成完成后会按 SHOT 聚合到这里。" />}
    evidence={evidence}
  />;
}

function ReviewNotes({ notes }: { notes: ReviewNote[] }) {
  return <EvidencePanel title="辅助审片注记">{notes.length ? <div className={s.runList}>{notes.map((note) => <div key={note.note_id}><span><strong>{note.source === "webgpt_v4" ? "WebGPT" : note.source}</strong><small>{note.note}</small></span><StatusPill tone="neutral">{new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(note.created_at))}</StatusPill></div>)}</div> : <EmptyState title="暂无辅助注记" />}</EvidencePanel>;
}

function ReviewDecision({ projectId, shot, version, readOnly }: { projectId: string; shot: Shot; version: ClipVersion; readOnly: boolean }) {
  const queryClient = useQueryClient();
  const [revision, setRevision] = useState("");
  const mutation = useMutation({ mutationFn: (decision: "approved" | "revision_needed") => apiMutation(`/api/v2/projects/${encodeURIComponent(projectId)}/review/decision`, "POST", { shot_id: shot.shot_id, artifact_id: version.artifact_id, decision, rejection_reasons: decision === "revision_needed" ? [revision || "需要调整"] : [], revision_instruction: { summary: revision || "需要调整", prompt_delta: revision, negative_delta: "", priority: "medium" } }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["project-workspace", projectId, "review"] }) });
  return <EvidencePanel title="审片决定"><KeyValue rows={[["Artifact", version.artifact_id], ["Run", version.run_id], ["尝试", `V${version.attempt_number}`], ["当前决定", version.review_status]]} /><label className={s.field}><span>修订说明</span><textarea rows={4} value={revision} onChange={(event) => setRevision(event.target.value)} placeholder="仅请求修订时填写" /></label><div className={s.buttonColumn}><button className={s.primaryButton} disabled={readOnly || mutation.isPending} onClick={() => mutation.mutate("approved")}><Check size={16} /> 采纳此版本</button><button className={s.dangerButton} disabled={readOnly || mutation.isPending} onClick={() => mutation.mutate("revision_needed")}><RotateCcw size={16} /> 请求重生成</button></div>{mutation.isError && <div className={s.inlineError}>{mutation.error.message}</div>}</EvidencePanel>;
}

function DeliveryWorkspace({ data }: { data: WorkspaceData }) {
  const [dialog, setDialog] = useState<"assembly" | "accept" | "reassemble" | "regenerate_shots" | "export" | "closeout" | null>(null);
  const state = data.workflow_state ?? "not_ready";
  const currentArtifact = data.current_final_version?.artifact ?? data.final_artifact ?? null;
  const activeJob = data.active_job;
  const readOnly = data.meta.lifecycle === "archived" || state === "closed";
  const canAccept = Boolean(currentArtifact) && !activeJob && state === "final_review";
  const canReassemble = Boolean(currentArtifact) && !activeJob && new Set(["final_review", "approved", "exported", "legacy_review_required"]).has(state);
  const canRegenerate = Boolean(currentArtifact) && !activeJob && new Set(["final_review", "approved", "exported"]).has(state);
  const canExport = Boolean(currentArtifact) && !activeJob && new Set(["approved", "exported"]).has(state);
  return <>
    <div className={s.deliveryLayout}>
      <section className={s.deliveryStatus}><div className={s.systemIcon}>{state === "closed" || state === "exported" || state === "approved" ? <ShieldCheck size={24} /> : <Clock3 size={24} />}</div><div><span className={s.eyebrow}>交付状态</span><h2>{deliveryStateLabel(state)}</h2><p>{activeJob ? `${activeJob.job_type === "assembly" ? "装配" : "导出"} Job ${activeJob.state}；完成前生产写入已锁定。` : deliveryStateDetail(state)}</p></div><StatusPill tone={state === "closed" || state === "exported" || state === "approved" ? "success" : state === "assembling" || state === "final_review" ? "info" : "warning"}>{state}</StatusPill></section>

      <section className={s.deliveryClips}><div className={s.sectionTitle}><div><h2>1. 装配准备</h2><p>按 SHOT order 固定输入，只使用当前采纳且字节已验证的片段。</p></div><button className={s.primaryButton} disabled={readOnly || Boolean(activeJob)} onClick={() => setDialog("assembly")}><Play size={16} /> 装配预检</button></div><div className={s.clipGrid}>{(data.accepted_clips ?? []).map((clip) => <div key={clip.shot_id} className={s.clipItem}><MediaPreview artifact={clip.artifact} /><span>SHOT {String(clip.order).padStart(3, "0")} · {clip.artifact ? "已验证" : clip.reference_error_code ?? "未就绪"}</span></div>)}</div>{!(data.accepted_clips?.length) && <div className={s.deliverySectionBody}><EmptyState title="尚无装配输入" /></div>}</section>

      <section className={s.deliveryFinal}><div className={s.sectionTitle}><div><h2>2. 最终版本栈</h2><p>每次成功装配创建新 Artifact；历史版本不会覆盖。</p></div><StatusPill tone={(data.final_versions?.length ?? 0) ? "info" : "neutral"}>{data.final_versions?.length ?? 0} 个版本</StatusPill></div><div className={s.deliveryVersionGrid}>{(data.final_versions ?? []).map((version) => <article className={s.deliveryVersion} key={version.artifact_id}><MediaPreview artifact={version.artifact} /><div><strong>{version.artifact_id}</strong><small>{formatDeliveryTime(version.assembled_at ?? version.created_at)}</small><span>{version.is_current && <StatusPill tone="info">当前</StatusPill>}{version.is_approved && <StatusPill tone="success">已批准</StatusPill>}</span></div></article>)}</div>{!(data.final_versions?.length) && <div className={s.deliverySectionBody}><EmptyState title="尚无最终版本" detail="完成真实装配后，版本会在这里出现。" /></div>}</section>

      <section className={s.deliveryFinal}><div className={s.sectionTitle}><div><h2>3. 终审</h2><p>接受当前版本、仅重新装配，或只退回指定 SHOT。</p></div></div><div className={s.deliveryReviewBody}><div className={s.deliveryPreview}><MediaPreview artifact={currentArtifact} /></div><div className={s.deliveryDecisionPanel}><KeyValue rows={[["当前 Artifact", data.final_review?.current_artifact_id ?? "无"], ["批准 Artifact", data.final_review?.approved_artifact_id ?? "未批准"], ["终审状态", deliveryStateLabel(state)]]} /><div className={s.buttonColumn}><button className={s.primaryButton} disabled={readOnly || !canAccept} onClick={() => setDialog("accept")}><Check size={16} /> 接受当前版本</button><button className={s.secondaryButton} disabled={readOnly || !canReassemble} onClick={() => setDialog("reassemble")}><RotateCcw size={16} /> 保留 SHOT 并重装</button><button className={s.dangerButton} disabled={readOnly || !canRegenerate} onClick={() => setDialog("regenerate_shots")}><RotateCcw size={16} /> 定向 SHOT 返工</button></div></div></div></section>

      <section className={s.deliveryFinal}><div className={s.sectionTitle}><div><h2>4. 导出与结案</h2><p>导出和结案是两个独立的人工作业；UI 只显示相对路径。</p></div></div><div className={s.deliveryExportBody}><div><KeyValue rows={[["最新导出", data.latest_export?.relative_path ?? "尚未导出"], ["SHA-256", data.latest_export?.sha256 ? `${data.latest_export.sha256.slice(0, 12)}…` : "—"], ["完整性", data.latest_export?.verification_state ?? "not_applicable"], ["结案凭据", data.closeout_receipt?.event_id ?? "尚未结案"]]} />{data.latest_export && <a className={s.secondaryButton} download href={`/api/v2/projects/${encodeURIComponent(data.project.project_id)}/delivery/exports/${encodeURIComponent(data.latest_export.export_id)}/file`}><Download size={16} /> 本地下载</a>}</div><div className={s.buttonColumn}><button className={s.primaryButton} disabled={readOnly || !canExport} onClick={() => setDialog("export")}><Download size={16} /> 确认导出</button><button className={s.dangerButton} disabled={readOnly || state !== "exported" || Boolean(activeJob)} onClick={() => setDialog("closeout")}><ShieldCheck size={16} /> 确认结案</button></div></div></section>
    </div>
    {dialog === "assembly" && <AssemblyDeliveryModal data={data} onClose={() => setDialog(null)} />}
    {(dialog === "accept" || dialog === "reassemble" || dialog === "regenerate_shots") && currentArtifact && <FinalReviewModal data={data} artifact={currentArtifact} decision={dialog} onClose={() => setDialog(null)} />}
    {dialog === "export" && currentArtifact && <ExportDeliveryModal projectId={data.project.project_id} artifact={currentArtifact} retryJob={data.retryable_jobs?.export ?? null} onClose={() => setDialog(null)} />}
    {dialog === "closeout" && <CloseoutDeliveryModal projectId={data.project.project_id} onClose={() => setDialog(null)} />}
  </>;
}

function AssemblyDeliveryModal({ data, onClose }: { data: WorkspaceData; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [preflight, setPreflight] = useState<AssemblyPreflight | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const retryJob = data.retryable_jobs?.assembly ?? null;
  const prepare = useMutation({ mutationFn: () => preflightDeliveryAssembly(data.project.project_id), onSuccess: setPreflight });
  const start = useMutation({
    mutationFn: () => startDeliveryAssembly(data.project.project_id, preflight?.input_fingerprint ?? "", retryJob?.job_id),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["project-workspace", data.project.project_id] }); onClose(); }
  });
  const error = prepare.error ?? start.error;
  return <Modal title="最终装配预检" onClose={onClose} footer={<><button className={s.secondaryButton} onClick={onClose}>取消</button>{preflight?.ready && preflight.tooling_checked ? <button className={s.primaryButton} disabled={!confirmed || start.isPending} onClick={() => start.mutate()}>{retryJob ? "确认并重新排队装配" : "确认并排队装配"}</button> : <button className={s.primaryButton} disabled={prepare.isPending} onClick={() => prepare.mutate()}>运行预检</button>}</>}>
    <div className={s.advisoryBox}><strong>final-assembly-v1</strong><small>FFmpeg 使用只读源文件、唯一 staging 和无覆盖输出；进程重启后不会自动重试。</small></div>
    {preflight && <><KeyValue rows={[["输入指纹", preflight.input_fingerprint ? `${preflight.input_fingerprint.slice(0, 16)}…` : "未生成"], ["目标规格", preflight.target ? `${preflight.target.width}×${preflight.target.height} · 30fps` : "未通过"], ["预计时长", `${preflight.expected_duration_seconds}s`], ["工具门禁", preflight.tooling_checked ? "FFmpeg / FFprobe 已验证" : "未验证"], ["重试来源", retryJob?.job_id ?? "首次执行"]]} />{preflight.blockers.length > 0 && <div className={s.gateList}>{preflight.blockers.map((blocker, index) => <div className={s.gateBad} key={`${blocker.code}-${index}`}><CircleAlert size={15} />{blocker.shot_id ? `${blocker.shot_id} · ` : ""}{blocker.code}</div>)}</div>}{preflight.ready && preflight.tooling_checked && <label className={s.checkboxRowInline}><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>我确认用此输入指纹创建一个持久装配 Job；失败不会自动重试，也不会移动最终版本指针。</span></label>}</>}
    {error && <div className={s.inlineError}>{error.message}</div>}
  </Modal>;
}

function FinalReviewModal({ data, artifact, decision, onClose }: { data: WorkspaceData; artifact: MediaArtifact; decision: "accept" | "reassemble" | "regenerate_shots"; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const mutation = useMutation({
    mutationFn: () => submitFinalReview(data.project.project_id, { artifact_id: artifact.artifact_id, decision, ...(decision === "regenerate_shots" ? { shot_ids: selected, reason: reason.trim() } : {}) }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["project-workspace", data.project.project_id] }); queryClient.invalidateQueries({ queryKey: ["projects"] }); onClose(); }
  });
  const valid = confirmed && (decision !== "regenerate_shots" || (selected.length > 0 && reason.trim().length >= 3));
  const title = decision === "accept" ? "接受当前最终版本" : decision === "reassemble" ? "仅重新装配" : "定向 SHOT 返工";
  return <Modal title={title} onClose={onClose} footer={<><button className={s.secondaryButton} onClick={onClose}>取消</button><button className={decision === "regenerate_shots" ? s.dangerButton : s.primaryButton} disabled={!valid || mutation.isPending} onClick={() => mutation.mutate()}>确认终审决定</button></>}>
    <div className={s.advisoryBox}><strong>{artifact.artifact_id}</strong><small>{decision === "accept" ? "批准后才允许导出。" : decision === "reassemble" ? "保留全部 SHOT 采纳指针并回到装配准备。" : "只清除选中 SHOT 的采纳指针，其他 SHOT 保持不变。"}</small></div>
    {decision === "regenerate_shots" && <><fieldset className={s.shotSelection}><legend>选择问题 SHOT</legend>{(data.accepted_clips ?? []).map((clip) => <label key={clip.shot_id}><input type="checkbox" checked={selected.includes(clip.shot_id)} onChange={(event) => setSelected(event.target.checked ? [...selected, clip.shot_id] : selected.filter((id) => id !== clip.shot_id))} /><span>SHOT {String(clip.order).padStart(3, "0")} · {clip.shot_id}</span></label>)}</fieldset><label className={s.field}><span>返工原因（必填）</span><textarea rows={4} maxLength={1_000} value={reason} onChange={(event) => setReason(event.target.value)} /></label></>}
    <label className={s.checkboxRowInline}><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>我确认该决定针对当前最终 Artifact；旧 Clip、最终版本和事件证据必须保留。</span></label>
    {mutation.isError && <div className={s.inlineError}>{mutation.error.message}</div>}
  </Modal>;
}

function ExportDeliveryModal({ projectId, artifact, retryJob, onClose }: { projectId: string; artifact: MediaArtifact; retryJob: DeliveryJob | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [confirmed, setConfirmed] = useState(false);
  const mutation = useMutation({ mutationFn: () => startDeliveryExport(projectId, artifact.artifact_id, retryJob?.job_id), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["project-workspace", projectId] }); onClose(); } });
  return <Modal title="确认本地导出" onClose={onClose} footer={<><button className={s.secondaryButton} onClick={onClose}>取消</button><button className={s.primaryButton} disabled={!confirmed || mutation.isPending} onClick={() => mutation.mutate()}>{retryJob ? "确认重新导出" : "确认导出"}</button></>}>
    <div className={s.advisoryBox}><strong>{artifact.artifact_id}</strong><small>目标库为 data/exports/&lt;project_id&gt;/；先写 .part，经 SHA-256 与 FFprobe 校验后独占落盘，绝不覆盖。{retryJob ? ` 本次显式重试 ${retryJob.job_id}。` : ""}</small></div>
    <label className={s.checkboxRowInline}><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>我确认导出当前已批准最终版本。此动作不会自动结案。</span></label>
    {mutation.isError && <div className={s.inlineError}>{mutation.error.message}</div>}
  </Modal>;
}

function CloseoutDeliveryModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [phrase, setPhrase] = useState("");
  const mutation = useMutation({ mutationFn: () => closeoutDelivery(projectId, phrase), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["project-workspace", projectId] }); queryClient.invalidateQueries({ queryKey: ["projects"] }); onClose(); } });
  return <Modal title="项目结案" onClose={onClose} footer={<><button className={s.secondaryButton} onClick={onClose}>取消</button><button className={s.dangerButton} disabled={phrase !== "确认结案" || mutation.isPending} onClick={() => mutation.mutate()}>永久关闭生产写入</button></>}>
    <div className={s.advisoryBox}><strong>结案后生产写入将 fail closed</strong><small>系统会重新校验当前 Artifact、对应 Export 和活动 Job；归档仍是独立的可逆动作。</small></div>
    <label className={s.field}><span>输入固定短语“确认结案”</span><input autoComplete="off" value={phrase} onChange={(event) => setPhrase(event.target.value)} /></label>
    {mutation.isError && <div className={s.inlineError}>{mutation.error.message}</div>}
  </Modal>;
}

function ThreePane({ queue, detail, evidence }: { queue: ReactNode; detail: ReactNode; evidence: ReactNode }) {
  return <div className={s.threePane}><section className={s.queuePane}>{queue}</section><section className={s.detailPane}>{detail}</section><aside className={s.evidencePane}>{evidence}</aside></div>;
}

function EvidencePanel({ title, children }: { title: string; children: ReactNode }) { return <div className={s.evidencePanel}><div className={s.paneTitle}><strong>{title}</strong></div><div className={s.evidenceBody}>{children}</div></div>; }

function ShotQueue({ shots, selectedId, scrollKey, onSelect }: { shots: Shot[]; selectedId: string; scrollKey: string; onSelect: (shot: Shot) => void }) {
  return <><div className={s.paneTitle}><strong>SHOT 队列</strong><span>{shots.length}</span></div><VirtualList items={shots} estimate={88} scrollKey={scrollKey} renderItem={(shot) => <button className={`${s.queueItem} ${shot.shot_id === selectedId ? s.queueItemActive : ""}`} onClick={() => onSelect(shot)}><span className={s.shotNumber}>{String(shot.order).padStart(3, "0")}</span><span><strong>{shot.description || shot.shot_id}</strong><small>{shot.duration_seconds}s · {shot.clip_versions.length} 个片段</small></span><StatusPill tone={operationalTone(shot)}>{operationalLabel(shot)}</StatusPill></button>} /></>;
}

function RunList({ runs }: { runs: GenerationRun[] }) { return runs.length ? <div className={s.runList}>{runs.map((run) => <div key={run.run_id}><span className={`${s.runDot} ${run.status === "succeeded" ? s.runSuccess : run.status === "failed" ? s.runFailed : s.runActive}`} /><span><strong>{run.shot_id || run.run_type}</strong><small>{run.provider?.provider_name ?? "local"} · {run.provider?.provider_status || run.status}</small></span><StatusPill tone={run.status === "succeeded" ? "success" : run.status === "failed" ? "danger" : "warning"}>{run.status}</StatusPill></div>)}</div> : <EmptyState title="暂无运行记录" />; }

function selectShot(shots: Shot[], selectedId: string | null) { return shots.find((shot) => shot.shot_id === selectedId) ?? shots[0]; }
function setSelected(params: URLSearchParams, setParams: ReturnType<typeof useSearchParams>[1], id: string) { preserveVisibleVirtualScrolls(); const next = new URLSearchParams(params); next.set("selected", id); setParams(next, { replace: true }); }
function deliveryStateLabel(state: string): string {
  return ({
    not_ready: "装配输入尚未就绪",
    ready_to_assemble: "可以开始装配",
    assembling: "正在装配",
    final_review: "等待最终审查",
    revision_requested: "等待定向返工",
    approved: "最终版本已批准",
    exported: "已完成本地导出",
    closed: "项目已结案",
    legacy_review_required: "历史项目需要重新审查"
  } as Record<string, string>)[state] ?? state;
}
function deliveryStateDetail(state: string): string {
  return ({
    not_ready: "所有 SHOT 都有有效采纳片段后才能进入真实装配。",
    ready_to_assemble: "先运行工具与输入指纹预检，再明确确认装配。",
    assembling: "持久 Job 正在运行；失败不会自动重试。",
    final_review: "请审看当前最终版本，并作出接受、重装或定向返工决定。",
    revision_requested: "选中的 SHOT 已清除采纳指针，其他 SHOT 保持不变。",
    approved: "当前版本已批准，可以明确确认本地导出。",
    exported: "导出已校验；输入固定短语后才能正式结案。",
    closed: "生产写入已永久关闭；历史证据仍可读取。",
    legacy_review_required: "历史 final_approved 不代表新式导出或结案，需要人工重新确认。"
  } as Record<string, string>)[state] ?? "请按当前交付门禁继续。";
}
function formatDeliveryTime(value: string | null | undefined): string {
  if (!value) return "时间未知";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}
function generationDisabledReason(data: WorkspaceData, shot: Shot): string {
  if (data.meta.lifecycle === "archived") return "先恢复归档项目；归档状态只读。";
  if (data.project.status === "final_approved") return "项目已经完成结案，不能再创建生成任务。";
  if (shot.operational_state?.primary_stage === "manual_reconciliation") return "先处理该 SHOT 的人工核对项。";
  if (!shot.operational_state && shot.status === "storyboard_approved") return "";
  if (shot.operational_state?.allowed_workflow_actions.prepare_generation === true) return "";
  const labels: Record<string, string> = {
    STORYBOARD_APPROVAL_REQUIRED: "先批准该 SHOT 的分镜。",
    STORYBOARD_REVISION_REQUIRED: "先完成分镜修订并重新批准。",
    STORYBOARD_IMAGE_MISSING: "先绑定可用的分镜图。",
    STORYBOARD_ARTIFACT_INACTIVE: "先恢复或替换不可用的分镜图。",
    STORYBOARD_ARTIFACT_BINDING_INVALID: "先修复分镜图与项目/SHOT 的绑定。",
    STORYBOARD_ARTIFACT_ROLE_INVALID: "先替换角色不正确的分镜 Artifact。",
    STORYBOARD_ARTIFACT_INTEGRITY_INVALID: "先修复分镜图的字节完整性。",
    VIDEO_PROMPT_MISSING: "先填写视频提示词。",
    SHOT_DURATION_INVALID: "先修正 SHOT 时长。",
    GENERATION_FAILED: "先检查失败记录并明确下一次生成。"
  };
  const code = shot.operational_state?.generation.reason_codes[0] ?? shot.operational_state?.blocker_codes[0];
  return code ? labels[code] ?? `先处理阻断：${code}。` : "当前 SHOT 状态不允许生成；请先完成上一阶段。";
}
function shotStatus(value: string) { return ({ draft: "草稿", storyboard_approved: "分镜已批", video_pending: "待生成", video_generated: "已生成", video_review: "待审", approved: "已采纳", revision_needed: "需修订" } as Record<string, string>)[value] ?? value; }

function blockerText(blocker: Record<string, unknown>): string {
  const labels: Record<string, string> = {
    STORYBOARD_APPROVAL_REQUIRED: "待审批分镜",
    STORYBOARD_REVISION_REQUIRED: "分镜需修改",
    STORYBOARD_IMAGE_MISSING: "缺分镜图",
    STORYBOARD_ARTIFACT_INACTIVE: "分镜图不可用",
    STORYBOARD_ARTIFACT_BINDING_INVALID: "分镜图绑定错误",
    STORYBOARD_ARTIFACT_ROLE_INVALID: "分镜图角色错误",
    STORYBOARD_ARTIFACT_INTEGRITY_INVALID: "分镜图完整性异常",
    VIDEO_PROMPT_MISSING: "缺视频提示词",
    SHOT_DURATION_INVALID: "时长无效",
    CLIP_REVISION_REQUIRED: "片段需修改",
    GENERATION_MANUAL_RECONCILIATION: "生成需人工核对",
    GENERATION_FAILED: "生成失败",
    SHOT_STATE_INCONSISTENT: "状态不一致"
  };
  const reasons = Array.isArray(blocker.reason_codes) ? blocker.reason_codes.map((code) => labels[String(code)] ?? String(code)) : [];
  if (reasons.length > 0) return reasons.join("、");
  return [blocker.missing_image ? "缺分镜图" : "", blocker.missing_prompt ? "缺视频提示词" : ""].filter(Boolean).join("、");
}

function operationalLabel(shot: Shot): string {
  const stage = shot.operational_state?.primary_stage;
  if (!stage) return shotStatus(shot.status);
  return ({
    storyboard_draft: "分镜草稿",
    storyboard_blocked: "分镜阻断",
    storyboard_revision_needed: "分镜需修改",
    generation_ready: "可生成",
    generation_queued: "生成排队",
    generation_running: "生成中",
    manual_reconciliation: "人工核对",
    generation_failed: "生成失败",
    review_pending: "待审",
    clip_revision_needed: "片段需修改",
    accepted: "已采纳",
    state_inconsistent: "状态异常"
  } as Record<string, string>)[stage] ?? stage;
}

function operationalTone(shot: Shot): "success" | "warning" | "danger" | "neutral" {
  const stage = shot.operational_state?.primary_stage;
  if (!stage) return shot.status === "approved" || shot.status === "storyboard_approved" ? "success" : shot.status === "revision_needed" ? "danger" : "warning";
  if (stage === "accepted" || stage === "generation_ready") return "success";
  if (["storyboard_blocked", "storyboard_revision_needed", "clip_revision_needed", "generation_failed", "state_inconsistent"].includes(stage)) return "danger";
  if (stage === "storyboard_draft") return "neutral";
  return "warning";
}
function classificationLabel(value: string) { return ({ production: "生产项目", test: "测试项目", unclassified: "未分类项目" } as Record<string, string>)[value] ?? value; }
