import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Check, FileImage, RefreshCw, RotateCcw, X } from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { apiGet, apiMutation, apiPage } from "../api";
import { EmptyState, ErrorState, KeyValue, LoadingState, MediaPreview, PageHeader, preserveVisibleVirtualScrolls, ProjectPicker, SegmentedTabs, StatusPill, VirtualList } from "../components";
import type { MediaArtifact, WorkspaceData } from "../types";
import s from "../workbench.module.css";

const tabs = [{ id: "pending", label: "待确认" }, { id: "drafts", label: "GPT 草稿" }, { id: "quarantine", label: "素材隔离" }];
const statusFilters: Record<string, Array<{ id: string; label: string }>> = {
  pending: [{ id: "all", label: "全部" }, { id: "pending", label: "待处理" }, { id: "executed", label: "已执行" }, { id: "rejected", label: "已拒绝" }, { id: "failed", label: "失败" }],
  drafts: [{ id: "all", label: "全部" }, { id: "pending", label: "待处理" }, { id: "revision_needed", label: "需修改" }, { id: "promoted", label: "已转生产" }, { id: "closed", label: "已关闭" }],
  quarantine: [{ id: "all", label: "全部" }, { id: "registerable", label: "可注册" }, { id: "blocked", label: "阻断" }, { id: "registered", label: "已注册" }, { id: "excluded", label: "已排除" }]
};

export function InboxPage() {
  const { tab = "pending" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? (tab === "quarantine" ? "registerable" : "pending");
  const selectedId = params.get("selected") ?? "";
  const query = useQuery({ queryKey: ["inbox", tab, status], queryFn: () => apiPage<Record<string, unknown>>(`/api/v2/inbox/${tab}?status=${encodeURIComponent(status)}&limit=100`) });
  const selected = useMemo(() => query.data?.items.find((item) => itemId(item) === selectedId) ?? query.data?.items[0], [query.data, selectedId]);
  const select = (item: Record<string, unknown>) => { preserveVisibleVirtualScrolls(); const next = new URLSearchParams(params); next.set("selected", itemId(item)); setParams(next, { replace: true }); };
  const refresh = useMutation({ mutationFn: () => apiMutation("/api/v2/import-index/refresh", "POST", {}), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["inbox", "quarantine"] }) });
  const changeStatus = (value: string) => { const next = new URLSearchParams(params); if (value === "all") next.delete("status"); else next.set("status", value); next.delete("selected"); setParams(next, { replace: true }); };
  return <div className={s.page}>
    <PageHeader eyebrow="进入生产前" title="收件箱" description="草稿、待确认动作和隔离素材按各自生命周期处理。" actions={tab === "quarantine" ? <button className={s.secondaryButton} onClick={() => refresh.mutate()} disabled={refresh.isPending}><RefreshCw size={16} /> 刷新索引</button> : undefined} />
    <div className={s.filterRows}>
      <SegmentedTabs ariaLabel="收件箱分类" items={tabs} active={tab} onChange={(value) => navigate(`/v2/inbox/${value}`)} />
      <SegmentedTabs ariaLabel="对象状态" active={status} onChange={changeStatus} items={statusFilters[tab] ?? statusFilters.pending} />
    </div>
    {query.isLoading ? <LoadingState /> : query.isError || !query.data ? <ErrorState error={query.error} /> : <div className={s.masterDetail}>
      <section className={s.queuePane}>
        <div className={s.paneTitle}><strong>{tabLabel(tab)}</strong><span>{query.data.meta.total}</span></div>
        <VirtualList items={query.data.items} estimate={92} scrollKey={`inbox:${tab}:${status}`} renderItem={(item) => <button className={`${s.queueItem} ${selected && itemId(selected) === itemId(item) ? s.queueItemActive : ""}`} onClick={() => select(item)}>
          <span className={s.queueIcon}>{tab === "quarantine" ? <FileImage size={18} /> : tab === "drafts" ? "GPT" : "!"}</span>
          <span><strong>{itemTitle(item)}</strong><small>{itemSummary(item)}</small></span>
          <StatusPill tone={statusTone(itemStatus(item))}>{statusLabel(itemStatus(item))}</StatusPill>
        </button>} />
      </section>
      <section className={s.detailPane}>{selected ? <InboxDetail item={selected} tab={tab} /> : <EmptyState title="当前筛选没有对象" />}</section>
    </div>}
  </div>;
}

function InboxDetail({ item, tab }: { item: Record<string, unknown>; tab: string }) {
  if (tab === "quarantine") return <QuarantineDetail item={item} />;
  if (tab === "drafts") return <DraftDetail item={item} />;
  return <PendingDetail item={item} />;
}

function PendingDetail({ item }: { item: Record<string, unknown> }) {
  const queryClient = useQueryClient();
  const payload = asRecord(item.payload);
  const [targetProject, setTargetProject] = useState(String(item.project_id ?? payload.project_id ?? ""));
  const [reason, setReason] = useState("");
  const mutation = useMutation({
    mutationFn: (decision: "execute" | "reject") => apiMutation(`/api/v2/inbox/pending/${encodeURIComponent(itemId(item))}/decision`, "POST", { decision, target_project_id: targetProject, reason }),
    onSuccess: () => invalidateInbox(queryClient)
  });
  const pending = itemStatus(item) === "pending";
  return <div className={s.objectDetail}>
    <ObjectHeader item={item} eyebrow="待确认动作" />
    <KeyValue rows={[["动作类型", toolLabel(String(item.tool ?? ""))], ["目标项目", String(item.project_id ?? payload.project_id ?? "未指定")], ["创建时间", formatTime(String(item.created_at ?? ""))], ["状态", statusLabel(itemStatus(item))]]} />
    <details className={s.rawDetails}><summary>查看动作内容</summary><pre>{JSON.stringify(payload, null, 2)}</pre></details>
    {pending && <div className={s.actionPanel}><h3>确认动作</h3><label className={s.field}><span>目标项目</span><ProjectPicker value={targetProject} onChange={setTargetProject} /></label><label className={s.field}><span>拒绝原因</span><textarea rows={3} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="拒绝时必填，1–500 字" /></label><div className={s.buttonRow}><button className={s.dangerButton} disabled={!reason.trim() || mutation.isPending} onClick={() => mutation.mutate("reject")}><X size={16} /> 拒绝</button><button className={s.primaryButton} disabled={!targetProject || mutation.isPending} onClick={() => mutation.mutate("execute")}><Check size={16} /> 执行动作</button></div>{mutation.isError && <div className={s.inlineError}>{mutation.error.message}</div>}</div>}
  </div>;
}

function DraftDetail({ item }: { item: Record<string, unknown> }) {
  const queryClient = useQueryClient();
  const tool = String(item.tool ?? "");
  const payload = asRecord(item.payload);
  const [targetProject, setTargetProject] = useState(String(item.target_project_id ?? payload.project_id ?? ""));
  const [targetShot, setTargetShot] = useState(String(item.target_shot_id ?? payload.shot_id ?? ""));
  const [createNewShot, setCreateNewShot] = useState(false);
  const [projectTitle, setProjectTitle] = useState(String(payload.title ?? ""));
  const [classification, setClassification] = useState<"production" | "test" | "">("");
  const [note, setNote] = useState(String(item.revision_note ?? ""));
  const shots = useQuery({
    queryKey: ["draft-target-shots", targetProject],
    queryFn: () => apiGet<WorkspaceData>(`/api/v2/projects/${encodeURIComponent(targetProject)}/storyboard`),
    enabled: tool === "submit_shot_script_draft" && Boolean(targetProject)
  });
  const mutation = useMutation({
    mutationFn: (action: "request_revision" | "promote" | "close") => apiMutation(`/api/v2/inbox/drafts/${encodeURIComponent(itemId(item))}/transition`, "POST", { action, note, target_project_id: targetProject, target_shot_id: targetShot, create_new_shot: createNewShot, project_title: projectTitle, classification }),
    onSuccess: () => invalidateInbox(queryClient)
  });
  const mutable = itemStatus(item) === "pending" || itemStatus(item) === "revision_needed";
  const canPromote = tool === "submit_storyboard_package_draft"
    ? Boolean(projectTitle.trim() && classification)
    : tool === "submit_shot_script_draft"
      ? Boolean(targetProject && (createNewShot || targetShot))
      : Boolean(targetProject);
  return <div className={s.objectDetail}>
    <ObjectHeader item={item} eyebrow="GPT 草稿" />
    <KeyValue rows={[["草稿类型", toolLabel(tool)], ["创建时间", formatTime(String(item.created_at ?? ""))], ["状态", statusLabel(itemStatus(item))], ["修订链", String(item.parent_draft_id ?? "无") || "无"]]} />
    <details className={s.rawDetails}><summary>查看结构化草稿</summary><pre>{JSON.stringify(payload, null, 2)}</pre></details>
    {mutable && <div className={s.actionPanel}><h3>转入生产</h3>
      {tool === "submit_storyboard_package_draft" ? <><label className={s.field}><span>新项目名称</span><input value={projectTitle} onChange={(event) => setProjectTitle(event.target.value)} /></label><label className={s.field}><span>项目分类</span><select value={classification} onChange={(event) => setClassification(event.target.value as "production" | "test" | "")}><option value="">请选择</option><option value="production">生产</option><option value="test">测试</option></select></label></> : <label className={s.field}><span>目标项目</span><ProjectPicker value={targetProject} onChange={(value) => { setTargetProject(value); setTargetShot(""); }} /></label>}
      {tool === "submit_shot_script_draft" && <><label className={s.checkboxRowInline}><input type="checkbox" checked={createNewShot} onChange={(event) => { setCreateNewShot(event.target.checked); if (event.target.checked) setTargetShot(""); }} /><span>在目标项目中新建 SHOT</span></label>{!createNewShot && <label className={s.field}><span>现有 SHOT</span><select value={targetShot} onChange={(event) => setTargetShot(event.target.value)}><option value="">请选择</option>{(shots.data?.shots ?? []).map((shot) => <option key={shot.shot_id} value={shot.shot_id}>SHOT {String(shot.order).padStart(3, "0")} · {shot.description || shot.shot_id}</option>)}</select></label>}</>}
      <label className={s.field}><span>修改说明</span><textarea rows={3} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} placeholder="标记需修改时必填，1–500 字" /></label>
      <div className={s.buttonRow}><button className={s.secondaryButton} disabled={mutation.isPending} onClick={() => mutation.mutate("close")}>关闭草稿</button><button className={s.dangerButton} disabled={!note.trim() || mutation.isPending} onClick={() => mutation.mutate("request_revision")}><RotateCcw size={16} /> 需修改</button><button className={s.primaryButton} disabled={!canPromote || mutation.isPending} onClick={() => mutation.mutate("promote")}><Check size={16} /> 转入生产</button></div>
      {mutation.isError && <div className={s.inlineError}>{mutation.error.message}</div>}
    </div>}
  </div>;
}

function QuarantineDetail({ item }: { item: Record<string, unknown> }) {
  const queryClient = useQueryClient();
  const [targetProject, setTargetProject] = useState("");
  const [targetShot, setTargetShot] = useState("");
  const [reason, setReason] = useState("");
  const shots = useQuery({
    queryKey: ["quarantine-target-shots", targetProject],
    queryFn: () => apiGet<WorkspaceData>(`/api/v2/projects/${encodeURIComponent(targetProject)}/storyboard`),
    enabled: Boolean(targetProject)
  });
  const mutation = useMutation({
    mutationFn: (decision: "excluded" | "registered") => apiMutation(`/api/v2/imports/${item.checksum}/decision`, "POST", { decision, target_project_id: targetProject, target_shot_id: targetShot, reason }),
    onSuccess: () => invalidateInbox(queryClient)
  });
  const blockers = Array.isArray(item.blockers) ? item.blockers : [];
  const workflowStatus = String(item.workflow_status ?? "blocked");
  const artifact: MediaArtifact | null = null;
  return <div className={s.objectDetail}>
    <div className={s.detailHeader}><div><span className={s.eyebrow}>隔离素材</span><h2>{String(item.filename ?? "未命名")}</h2></div><StatusPill tone={statusTone(workflowStatus)}>{statusLabel(workflowStatus)}</StatusPill></div>
    <div className={s.imageStage}>{item.filename ? <img src={`/imports/${encodeURIComponent(String(item.filename))}`} alt={String(item.filename)} /> : <MediaPreview artifact={artifact} />}</div>
    <KeyValue rows={[["尺寸", `${item.width ?? 0} × ${item.height ?? 0}`], ["画幅", String(item.aspect_ratio ?? "未知")], ["大小", formatBytes(Number(item.size_bytes ?? 0))], ["校验结果", blockers.length ? blockers.join("、") : "可注册"]]} />
    {(workflowStatus === "registerable" || workflowStatus === "blocked") && <div className={s.actionPanel}><h3>处理素材</h3><label className={s.field}><span>目标项目</span><ProjectPicker value={targetProject} onChange={(value) => { setTargetProject(value); setTargetShot(""); }} /></label><label className={s.field}><span>目标 SHOT</span><select value={targetShot} onChange={(event) => setTargetShot(event.target.value)} disabled={!targetProject || shots.isLoading}><option value="">请选择</option>{(shots.data?.shots ?? []).map((shot) => <option key={shot.shot_id} value={shot.shot_id}>SHOT {String(shot.order).padStart(3, "0")} · {shot.description || shot.shot_id}</option>)}</select></label><label className={s.field}><span>说明</span><input maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></label><div className={s.buttonRow}><button className={s.dangerButton} onClick={() => mutation.mutate("excluded")}> <Ban size={16} /> 排除素材</button><button className={s.primaryButton} disabled={workflowStatus !== "registerable" || !targetProject || !targetShot || mutation.isPending} onClick={() => mutation.mutate("registered")}><Check size={16} /> 注册到目标 SHOT</button></div>{workflowStatus === "blocked" && <div className={s.inlineNotice}>媒体校验未通过，不能注册；可以排除并保留记录。</div>}{mutation.isError && <div className={s.inlineError}>{mutation.error.message}</div>}</div>}
  </div>;
}

function ObjectHeader({ item, eyebrow }: { item: Record<string, unknown>; eyebrow: string }) {
  return <div className={s.detailHeader}><div><span className={s.eyebrow}>{eyebrow}</span><h2>{itemTitle(item)}</h2></div><StatusPill tone={statusTone(itemStatus(item))}>{statusLabel(itemStatus(item))}</StatusPill></div>;
}

function invalidateInbox(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ["inbox"] });
  queryClient.invalidateQueries({ queryKey: ["shell"] });
  queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  queryClient.invalidateQueries({ queryKey: ["projects"] });
}

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function itemId(item: Record<string, unknown>) { return String(item.action_id ?? item.draft_id ?? item.checksum ?? item.filename ?? ""); }
function itemTitle(item: Record<string, unknown>) { const tool = String(item.tool ?? item.draft_type ?? ""); return String(item.title ?? (tool ? toolLabel(tool) : item.filename) ?? "未命名对象"); }
function itemSummary(item: Record<string, unknown>) { return String(item.summary ?? item.description ?? item.reason ?? formatTime(String(item.created_at ?? "")) ?? "等待处理"); }
function itemStatus(item: Record<string, unknown>) { return String(item.workflow_status ?? item.status ?? item.decision ?? "pending"); }
function statusLabel(value: string) { return ({ pending: "待处理", executed: "已执行", rejected: "已拒绝", failed: "失败", revision_needed: "需修改", promoted: "已转生产", closed: "已关闭", registerable: "可注册", blocked: "阻断", excluded: "已排除", registered: "已注册", quarantined: "隔离中" } as Record<string, string>)[value] ?? value; }
function statusTone(value: string): "success" | "warning" | "danger" | "info" | "neutral" { if (["executed", "promoted", "registered", "registerable"].includes(value)) return "success"; if (["failed", "blocked", "rejected"].includes(value)) return "danger"; if (["pending", "revision_needed", "quarantined"].includes(value)) return "warning"; return "neutral"; }
function toolLabel(value: string) { return (({ submit_shot_script_draft: "SHOT 文案草稿", submit_storyboard_package_draft: "分镜包草稿", propose_artifact_link: "素材关联建议", propose_package_validation: "分镜包校验建议", propose_freeze_request: "冻结建议", request_register_media_artifact_from_import: "注册隔离素材", request_link_artifact_to_shot: "关联分镜素材", request_validate_storyboard_package: "校验分镜包", request_import_storyboard_package: "冻结分镜包", webgpt_v4_proposal_storyboard_package: "生产分镜包提议", webgpt_v4_proposal_review_decision: "审片决定提议", webgpt_v4_proposal_regeneration: "重生成提议", webgpt_v4_proposal_final_assembly: "最终合成提议", webgpt_v4_proposal_memory_saveback: "Memory 回写提议", webgpt_v4_proposal_package_freeze: "分镜包冻结提议", request_webgpt_review_decision: "执行审片决定", request_webgpt_regeneration: "建立重生成请求", request_webgpt_final_assembly_plan: "采纳最终合成方案", request_webgpt_memory_saveback_plan: "采纳 Memory 回写方案" } as Record<string, string>)[value] ?? value) || "未命名对象"; }
function tabLabel(value: string) { return tabs.find((tab) => tab.id === value)?.label ?? value; }
function formatBytes(value: number) { return value > 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1024))} KB`; }
function formatTime(value: string) { return value ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : ""; }
