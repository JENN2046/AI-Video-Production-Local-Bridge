import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CircleAlert, Clapperboard, Inbox, PackageCheck, Play } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { apiGet } from "../api";
import { ErrorState, LoadingState, PageHeader, StatusPill } from "../components";
import type { ProjectSummary } from "../types";
import s from "../workbench.module.css";

interface DashboardData {
  totals: { pending_confirmations: number; blocked_projects: number; review_pending: number; generation_active: number; pending_delivery: number };
  projects: ProjectSummary[];
  generated_at: string;
}

export function DashboardPage() {
  const navigate = useNavigate();
  const query = useQuery({ queryKey: ["dashboard"], queryFn: () => apiGet<DashboardData>("/api/v2/dashboard") });
  if (query.isLoading) return <LoadingState />;
  if (query.isError || !query.data) return <ErrorState error={query.error} />;
  const metrics = [
    { label: "待确认", value: query.data.totals.pending_confirmations, icon: Inbox },
    { label: "阻断项目", value: query.data.totals.blocked_projects, icon: CircleAlert },
    { label: "待审 SHOT", value: query.data.totals.review_pending, icon: Clapperboard },
    { label: "生成中", value: query.data.totals.generation_active, icon: Play },
    { label: "待交付", value: query.data.totals.pending_delivery, icon: PackageCheck }
  ];
  return <div className={s.page}>
    <PageHeader eyebrow="跨项目生产态势" title="指挥台" description="按风险和最近活动排序，只保留今天需要判断或推进的对象。" />
    <section className={s.metricStrip} aria-label="生产指标">
      {metrics.map(({ label, value, icon: Icon }) => <div key={label} className={s.metricCell}><Icon size={18} /><span>{label}</span><strong>{value}</strong></div>)}
    </section>
    <section className={s.tableSection}>
      <div className={s.sectionTitle}><div><h2>今日项目队列</h2><p>只显示活动的生产与未分类项目，按阻断和最近活动排序。</p></div><button className={s.textButton} onClick={() => navigate("/v2/projects")}>全部项目 <ArrowRight size={16} /></button></div>
      <div className={s.tableHeader}><span>项目</span><span>下一步动作</span><span>阻断原因</span><span>待审</span><span>阶段</span><span>最近活动</span><span /></div>
      <div className={s.tableBody}>
        {query.data.projects.map((item) => <button key={item.project.project_id} className={s.tableRow} onClick={() => navigate(`/v2/projects/${encodeURIComponent(item.project.project_id)}/overview`)}>
          <span className={s.primaryCell}><strong>{item.project.title}</strong><small>{item.project.project_id}</small></span>
          <span className={s.actionCell}><strong>{item.next_action.label}</strong><small>{item.next_action.source === "override" ? "人工指定" : "自动建议"}</small></span>
          <span className={s.blockerCell}>{item.blocker_reason || "-"}</span>
          <span>{item.review_pending_count}</span>
          <span><StatusPill tone={item.risk === "blocked" ? "danger" : item.risk === "attention" ? "warning" : "success"}>{statusLabel(item.project.status)}</StatusPill></span>
          <span>{formatDate(item.meta.last_opened_at ?? item.meta.updated_at)}</span>
          <span><ArrowRight size={16} /></span>
        </button>)}
      </div>
    </section>
  </div>;
}

function statusLabel(value: string) {
  return ({ draft: "分镜准备", storyboard_approved: "可生成", video_generation_in_progress: "生成中", video_review: "待审片", final_approved: "已交付" } as Record<string, string>)[value] ?? value;
}

function formatDate(value: string | null) {
  return value ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "-";
}
