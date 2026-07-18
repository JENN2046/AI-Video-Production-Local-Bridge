import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Check, CircleAlert, Clock3, Edit3, Film, Pin, Play, RotateCcw, Save, ShieldCheck } from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { apiGet, apiMutation, confirmGeneration, preflightGeneration } from "../api";
import { EmptyState, ErrorState, KeyValue, LoadingState, MediaPreview, Modal, PageHeader, preserveVisibleVirtualScrolls, SegmentedTabs, StatusPill, VirtualList } from "../components";
import type { ClipVersion, GenerationIntent, GenerationRun, MediaArtifact, ReviewNote, Shot, WorkspaceData } from "../types";
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
  const query = useQuery({ queryKey: ["project-workspace", id, workspace], queryFn: () => apiGet<WorkspaceData>(`/api/v2/projects/${encodeURIComponent(id)}/${workspace}`), refetchInterval: workspace === "generation" ? 10_000 : false });
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
      <button className={s.iconButton} title={meta.pinned ? "取消置顶" : "置顶项目"} onClick={() => projectMutation.mutate({ pinned: !meta.pinned })}><Pin size={17} fill={meta.pinned ? "currentColor" : "none"} /></button>
      <button className={s.iconButton} title="指定下一步动作" onClick={() => setOverrideOpen(true)}><Edit3 size={17} /></button>
      {meta.lifecycle === "active" ? <button className={s.secondaryButton} onClick={() => lifecycleMutation.mutate("archive")}><Archive size={16} /> 归档</button> : <button className={s.secondaryButton} onClick={() => lifecycleMutation.mutate("restore")}><RotateCcw size={16} /> 恢复</button>}
    </div>} />
    <div className={s.projectNav}><SegmentedTabs items={workspaceTabs} active={workspace} onChange={(value) => navigate(`/v2/projects/${encodeURIComponent(id)}/${value}`)} />{meta.lifecycle === "archived" && <StatusPill tone="warning">只读归档</StatusPill>}</div>
    {workspace === "overview" && <OverviewWorkspace data={query.data} />}
    {workspace === "storyboard" && <StoryboardWorkspace data={query.data} />}
    {workspace === "generation" && <GenerationWorkspace data={query.data} />}
    {workspace === "review" && <ReviewWorkspace data={query.data} />}
    {workspace === "delivery" && <DeliveryWorkspace data={query.data} />}
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
  const evidence = <EvidencePanel title="运行记录"><RunList runs={(data.runs ?? []).filter((run) => !selected || run.shot_id === selected.shot_id)} /></EvidencePanel>;
  return <>
    <ThreePane
      queue={<ShotQueue shots={shots} selectedId={selected?.shot_id ?? ""} scrollKey={`${data.project.project_id}:generation`} onSelect={(shot) => setSelected(params, setParams, shot.shot_id)} />}
      detail={selected ? <div className={s.objectDetail}><div className={s.detailHeader}><div><span className={s.eyebrow}>单 SHOT 生成</span><h2>SHOT {String(selected.order).padStart(3, "0")}</h2></div><StatusPill tone={operationalTone(selected)}>{operationalLabel(selected)}</StatusPill></div><div className={s.storyboardStage}><MediaPreview artifact={data.artifacts?.[selected.storyboard_image_artifact_id]} /></div><KeyValue rows={[["Provider", "RunningHub"], ["模型", "rhart-video-g/image-to-video"], ["时长", `${selected.duration_seconds}s`], ["输出", "480p · 9:16"], ["提交策略", "一次上传 / 一次提交 / 零自动重提"]]} /><div className={s.detailActions}><button className={s.primaryButton} disabled={data.meta.lifecycle === "archived" || selected.status !== "storyboard_approved"} onClick={() => setModal(true)}><Play size={16} /> 预检并生成</button></div></div> : <EmptyState title="项目尚无可生成 SHOT" />}
      evidence={evidence}
    />
    {modal && selected && <GenerationModal projectId={data.project.project_id} shot={selected} artifact={data.artifacts?.[selected.storyboard_image_artifact_id]} onClose={() => setModal(false)} />}
  </>;
}

function GenerationModal({ projectId, shot, artifact, onClose }: { projectId: string; shot: Shot; artifact?: MediaArtifact; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [account, setAccount] = useState<"personal" | "team">("personal");
  const [budget, setBudget] = useState(1);
  const [intent, setIntent] = useState<GenerationIntent | null>(null);
  const [costChecked, setCostChecked] = useState(false);
  const preflight = useMutation({ mutationFn: () => preflightGeneration(projectId, { shot_id: shot.shot_id, account_label: account, budget_limit_value: budget }), onSuccess: (data) => setIntent(data.intent) });
  const confirm = useMutation({ mutationFn: () => confirmGeneration(intent?.intent_id ?? "", budget), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["project-workspace", projectId] }); queryClient.invalidateQueries({ queryKey: ["shell"] }); onClose(); } });
  return <Modal title={intent ? "确认一次真实生成" : "RunningHub 生成预检"} onClose={onClose} footer={<><button className={s.secondaryButton} onClick={onClose}>取消</button>{intent ? <button className={s.primaryButton} disabled={!costChecked || confirm.isPending} onClick={() => confirm.mutate()}>确认生成</button> : <button className={s.primaryButton} disabled={budget <= 0 || preflight.isPending} onClick={() => preflight.mutate()}>运行预检</button>}</>}>
    <div className={s.generationSummary}><MediaPreview artifact={artifact} /><KeyValue rows={[["Provider", "RunningHub"], ["账户", account === "personal" ? "个人账户" : "团队账户"], ["模型", "rhart-video-g/image-to-video"], ["SHOT", shot.shot_id], ["时长", `${shot.duration_seconds}s`], ["分辨率", "480p"]]} /></div>
    {!intent ? <div className={s.formGrid}><label className={s.field}><span>账户标签</span><select value={account} onChange={(event) => setAccount(event.target.value as "personal" | "team")}><option value="personal">个人账户</option><option value="team">团队账户</option></select></label><label className={s.field}><span>本次预算上限</span><input type="number" min="0.01" step="0.01" value={budget} onChange={(event) => setBudget(Number(event.target.value))} /></label></div> : <div className={s.confirmationBox}><div><span>官方预计费用</span><strong>{intent.estimated_cost_value} {intent.currency}</strong></div><div><span>预算上限</span><strong>{budget} {intent.currency}</strong></div><label className={s.checkboxRow}><input type="checkbox" checked={costChecked} onChange={(event) => setCostChecked(event.target.checked)} /><span>我确认本次费用，并同意仅为该 SHOT 提交一次真实生成。</span></label></div>}
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
    queue={<section className={s.stackQueue}><div className={s.paneTitle}><strong>SHOT 版本栈</strong><span>{stacks.length}</span></div><VirtualList items={stacks} estimate={92} scrollKey={`${data.project.project_id}:review`} renderItem={(stack) => <button className={`${s.queueItem} ${stack.shot.shot_id === selectedStack?.shot.shot_id ? s.queueItemActive : ""}`} onClick={() => selectShotVersion(stack.shot.shot_id)}><span className={s.queueIcon}><Film size={18} /></span><span><strong>SHOT {String(stack.shot.order).padStart(3, "0")}</strong><small>{stack.versions.length} 个版本 · {stack.shot.operational_state?.review.stage ?? stack.shot.review.approval_status}</small></span><StatusPill tone={operationalTone(stack.shot)}>{operationalLabel(stack.shot)}</StatusPill></button>} /></section>}
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
  return <div className={s.deliveryLayout}>
    <section className={s.deliveryStatus}><div className={s.systemIcon}>{data.ready_for_assembly ? <ShieldCheck size={24} /> : <Clock3 size={24} />}</div><div><span className={s.eyebrow}>交付门禁</span><h2>{data.ready_for_assembly ? "可进入最终合成" : "等待所有 SHOT 采纳片段"}</h2><p>{data.ready_for_assembly ? "镜头版本栈已收敛，可以执行现有合成和最终审查流程。" : "不会用未采纳版本自动拼接最终视频。"}</p></div><StatusPill tone={data.ready_for_assembly ? "success" : "warning"}>{data.ready_for_assembly ? "READY" : "BLOCKED"}</StatusPill></section>
    <section className={s.deliveryClips}><div className={s.sectionTitle}><div><h2>合成顺序</h2><p>按 SHOT order 固定排列。</p></div></div><div className={s.clipGrid}>{(data.accepted_clips ?? []).map((clip) => <div key={clip.shot_id} className={s.clipItem}><MediaPreview artifact={clip.artifact} /><span>SHOT {String(clip.order).padStart(3, "0")}</span></div>)}</div></section>
    <section className={s.deliveryFinal}><div className={s.sectionTitle}><div><h2>最终视频</h2><p>合成产物和最终决策保持原有安全门。</p></div></div><MediaPreview artifact={data.final_artifact} /></section>
  </div>;
}

function ThreePane({ queue, detail, evidence }: { queue: ReactNode; detail: ReactNode; evidence: ReactNode }) {
  return <div className={s.threePane}><section className={s.queuePane}>{queue}</section><section className={s.detailPane}>{detail}<div className={s.inlineEvidence}>{evidence}</div></section><aside className={s.evidencePane}>{evidence}</aside></div>;
}

function EvidencePanel({ title, children }: { title: string; children: ReactNode }) { return <div className={s.evidencePanel}><div className={s.paneTitle}><strong>{title}</strong></div><div className={s.evidenceBody}>{children}</div></div>; }

function ShotQueue({ shots, selectedId, scrollKey, onSelect }: { shots: Shot[]; selectedId: string; scrollKey: string; onSelect: (shot: Shot) => void }) {
  return <><div className={s.paneTitle}><strong>SHOT 队列</strong><span>{shots.length}</span></div><VirtualList items={shots} estimate={88} scrollKey={scrollKey} renderItem={(shot) => <button className={`${s.queueItem} ${shot.shot_id === selectedId ? s.queueItemActive : ""}`} onClick={() => onSelect(shot)}><span className={s.shotNumber}>{String(shot.order).padStart(3, "0")}</span><span><strong>{shot.description || shot.shot_id}</strong><small>{shot.duration_seconds}s · {shot.clip_versions.length} 个片段</small></span><StatusPill tone={operationalTone(shot)}>{operationalLabel(shot)}</StatusPill></button>} /></>;
}

function RunList({ runs }: { runs: GenerationRun[] }) { return runs.length ? <div className={s.runList}>{runs.map((run) => <div key={run.run_id}><span className={`${s.runDot} ${run.status === "succeeded" ? s.runSuccess : run.status === "failed" ? s.runFailed : s.runActive}`} /><span><strong>{run.shot_id || run.run_type}</strong><small>{run.provider?.provider_name ?? "local"} · {run.provider?.provider_status || run.status}</small></span><StatusPill tone={run.status === "succeeded" ? "success" : run.status === "failed" ? "danger" : "warning"}>{run.status}</StatusPill></div>)}</div> : <EmptyState title="暂无运行记录" />; }

function selectShot(shots: Shot[], selectedId: string | null) { return shots.find((shot) => shot.shot_id === selectedId) ?? shots[0]; }
function setSelected(params: URLSearchParams, setParams: ReturnType<typeof useSearchParams>[1], id: string) { preserveVisibleVirtualScrolls(); const next = new URLSearchParams(params); next.set("selected", id); setParams(next, { replace: true }); }
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
