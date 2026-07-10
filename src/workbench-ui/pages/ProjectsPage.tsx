import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, FolderPlus, Pin, Search } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { apiMutation, apiPage } from "../api";
import { ErrorState, LoadingState, Modal, PageHeader, SegmentedTabs, StatusPill, VirtualList } from "../components";
import type { Project, ProjectSummary } from "../types";
import s from "../workbench.module.css";

export function ProjectsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const lifecycle = params.get("lifecycle") ?? "active";
  const classification = params.get("classification") ?? "all";
  const search = params.get("query") ?? "";
  const scope = lifecycle === "active" && classification === "all" ? "daily" : "all";
  const endpoint = `/api/v2/projects?scope=${scope}&lifecycle=${encodeURIComponent(lifecycle)}&classification=${encodeURIComponent(classification)}&query=${encodeURIComponent(search)}&limit=100`;
  const query = useQuery({ queryKey: ["projects", scope, lifecycle, classification, search], queryFn: () => apiPage<ProjectSummary>(endpoint) });
  const updateParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (!value || (key === "classification" && value === "all")) next.delete(key); else next.set(key, value);
    setParams(next, { replace: true });
  };
  return <div className={s.page}>
    <PageHeader eyebrow="生产对象" title="项目" description="活动项目置顶；测试、未分类和归档项目通过筛选进入。" actions={<button className={s.primaryButton} onClick={() => setCreating(true)}><FolderPlus size={17} /> 新建项目</button>} />
    <div className={s.filterBar}>
      <div className={s.filterModes}>
        <SegmentedTabs ariaLabel="项目生命周期" active={lifecycle} onChange={(value) => updateParam("lifecycle", value)} items={[{ id: "active", label: "活动" }, { id: "archived", label: "归档" }, { id: "all", label: "全部" }]} />
        <SegmentedTabs ariaLabel="项目分类" active={classification} onChange={(value) => updateParam("classification", value)} items={[{ id: "all", label: "全部分类" }, { id: "production", label: "生产" }, { id: "unclassified", label: "未分类" }, { id: "test", label: "测试" }]} />
      </div>
      <label className={s.searchBox}><Search size={16} /><input value={search} onChange={(event) => updateParam("query", event.target.value)} placeholder="项目名或 ID" /></label>
    </div>
    {query.isLoading ? <LoadingState /> : query.isError || !query.data ? <ErrorState error={query.error} /> : <section className={s.projectList}>
      <div className={s.projectListHead}><span>项目</span><span>下一步动作</span><span>阻断原因</span><span>待审</span><span>阶段</span><span>最近活动</span><span /></div>
      <VirtualList items={query.data.items} estimate={72} scrollKey={`projects:${lifecycle}:${classification}:${search}`} renderItem={(item) => <button className={s.projectRow} onClick={() => navigate(`/v2/projects/${encodeURIComponent(item.project.project_id)}/overview`)}>
        <span className={s.projectIdentity}>{item.meta.pinned && <Pin size={13} />}<span><strong>{item.project.title}</strong><small>{item.project.project_id}</small></span></span>
        <span className={s.actionCell}><strong>{item.next_action.label}</strong><small>{item.next_action.source === "override" ? "人工指定" : "自动建议"}</small></span>
        <span className={s.blockerCell}>{item.blocker_reason || "-"}</span>
        <span>{item.review_pending_count}</span>
        <span><StatusPill tone={item.risk === "blocked" ? "danger" : item.risk === "attention" ? "warning" : "success"}>{projectStatus(item.project.status)}</StatusPill></span>
        <span>{formatDate(item.meta.last_opened_at ?? item.meta.updated_at)}</span>
        <span><ArrowRight size={16} /></span>
      </button>} />
      <div className={s.listFooter}>显示 {query.data.items.length} / {query.data.meta.total}</div>
    </section>}
    {creating && <CreateProjectModal onClose={() => setCreating(false)} onCreated={(project) => { setCreating(false); queryClient.invalidateQueries({ queryKey: ["projects"] }); navigate(`/v2/projects/${encodeURIComponent(project.project_id)}/overview`); }} />}
  </div>;
}

function CreateProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: (project: Project) => void }) {
  const [title, setTitle] = useState("");
  const [classification, setClassification] = useState<"production" | "test" | "">("");
  const mutation = useMutation({ mutationFn: () => apiMutation<{ project: Project }>("/api/v2/projects", "POST", { title, classification }), onSuccess: (data) => onCreated(data.project) });
  return <Modal title="创建项目" onClose={onClose} footer={<><button className={s.secondaryButton} onClick={onClose}>取消</button><button className={s.primaryButton} disabled={!title.trim() || !classification || mutation.isPending} onClick={() => mutation.mutate()}>创建并进入</button></>}>
    <label className={s.field}><span>项目名称</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：Ryan 午休安全帽短片" /></label>
    <label className={s.field}><span>项目分类</span><select value={classification} onChange={(event) => setClassification(event.target.value as "production" | "test" | "")}><option value="">请选择</option><option value="production">生产</option><option value="test">测试</option></select></label>
    <div className={s.formGrid}><label className={s.field}><span>画幅</span><select disabled><option>9:16</option></select></label><label className={s.field}><span>分辨率</span><select disabled><option>1080×1920</option></select></label></div>
    {mutation.isError && <div className={s.inlineError}>{mutation.error.message}</div>}
  </Modal>;
}

function projectStatus(value: string) { return ({ draft: "分镜准备", storyboard_approved: "可生成", video_generation_in_progress: "生成中", video_review: "待审片", final_approved: "已交付" } as Record<string, string>)[value] ?? value; }
function formatDate(value: string | null) { return value ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "未打开"; }
