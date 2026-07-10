import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, FileImage, Film } from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { apiPage } from "../api";
import { EmptyState, ErrorState, KeyValue, LoadingState, MediaPreview, PageHeader, preserveVisibleVirtualScrolls, ProjectPicker, SegmentedTabs, StatusPill, VirtualList } from "../components";
import type { MediaArtifact } from "../types";
import s from "../workbench.module.css";

const tabs = [{ id: "media", label: "媒体" }, { id: "memory", label: "Memory" }, { id: "reference", label: "Reference" }, { id: "recall", label: "Recall Pack" }];

export function AssetsPage() {
  const { tab = "media" } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const scope = params.get("scope") ?? "daily";
  const projectId = params.get("project_id") ?? "";
  const type = params.get("type") ?? "";
  const role = params.get("role") ?? "";
  const status = params.get("status") ?? "";
  const selectedId = params.get("selected") ?? "";
  const endpoint = `/api/v2/assets/${tab}?scope=${scope}&project_id=${encodeURIComponent(projectId)}&type=${encodeURIComponent(type)}&role=${encodeURIComponent(role)}&status=${encodeURIComponent(status)}&limit=100`;
  const query = useQuery({ queryKey: ["assets", tab, scope, projectId, type, role, status], queryFn: () => apiPage<Record<string, unknown>>(endpoint) });
  const selected = useMemo(() => query.data?.items.find((item) => assetId(item) === selectedId) ?? query.data?.items[0], [query.data, selectedId]);
  const set = (key: string, value: string) => { preserveVisibleVirtualScrolls(); const next = new URLSearchParams(params); if (value) next.set(key, value); else next.delete(key); if (key !== "selected") next.delete("selected"); if (key === "scope" && value === "unassigned") next.delete("project_id"); setParams(next, { replace: true }); };
  return <div className={s.page}>
    <PageHeader eyebrow="跨项目复用" title="资产库" description="日常生产资产默认可见，未归属资产在独立范围中治理。" />
    <div className={s.filterRows}>
      <SegmentedTabs ariaLabel="资产分类" items={tabs} active={tab} onChange={(value) => navigate(`/v2/assets/${value}`)} />
      {tab === "media" && <div className={s.assetFilterRow}>
        <div className={s.filterGroup}><span>范围</span><SegmentedTabs ariaLabel="资产范围" active={scope} onChange={(value) => set("scope", value)} items={[{ id: "daily", label: "日常项目" }, { id: "unassigned", label: "未归属" }, { id: "all", label: "全部" }]} /></div>
        <div className={s.filterGroup}><span>项目</span>{scope === "unassigned" ? <div className={s.disabledFilter}>未归属资产</div> : <ProjectPicker value={projectId} scope={scope === "all" ? "all" : "daily"} onChange={(value) => set("project_id", value)} />}</div>
        <div className={s.filterGroup}><span>媒体类型</span><SegmentedTabs ariaLabel="媒体类型" active={type} onChange={(value) => set("type", value)} items={[{ id: "", label: "全部" }, { id: "image", label: "图片" }, { id: "video", label: "视频" }]} /></div>
        <label className={s.filterGroup}><span>角色</span><select value={role} onChange={(event) => set("role", event.target.value)}><option value="">全部</option><option value="storyboard_image">分镜图</option><option value="generated_clip">生成片段</option><option value="final_video">最终视频</option></select></label>
        <label className={s.filterGroup}><span>状态</span><select value={status} onChange={(event) => set("status", event.target.value)}><option value="">全部</option><option value="active">可用</option><option value="pending_upload">待上传</option><option value="inaccessible">不可访问</option></select></label>
      </div>}
    </div>
    {query.isLoading ? <LoadingState /> : query.isError || !query.data ? <ErrorState error={query.error} /> : <div className={s.masterDetail}>
      <section className={s.queuePane}><div className={s.paneTitle}><strong>{tabs.find((item) => item.id === tab)?.label}</strong><span>{query.data.meta.total}</span></div><VirtualList items={query.data.items} estimate={78} scrollKey={`assets:${tab}:${scope}:${projectId}:${type}:${role}:${status}`} renderItem={(item) => <button className={`${s.queueItem} ${selected && assetId(selected) === assetId(item) ? s.queueItemActive : ""}`} onClick={() => set("selected", assetId(item))}><span className={s.queueIcon}>{item.artifact_type === "video" ? <Film size={18} /> : <FileImage size={18} />}</span><span><strong>{assetTitle(item)}</strong><small>{roleLabel(String(item.role ?? ""))} · {assetSub(item)}</small></span><StatusPill tone={item.status === "active" ? "success" : item.status === "inaccessible" ? "danger" : "warning"}>{statusLabel(String(item.status ?? "active"))}</StatusPill></button>} /></section>
      <section className={s.detailPane}>{selected ? <AssetDetail item={selected} tab={tab} /> : <EmptyState title="没有匹配资产" detail={scope === "daily" ? "可切换到未归属或全部范围继续查找。" : undefined} />}</section>
    </div>}
  </div>;
}

function AssetDetail({ item, tab }: { item: Record<string, unknown>; tab: string }) {
  if (tab === "media") {
    const artifact = item as unknown as MediaArtifact;
    return <div className={s.objectDetail}><div className={s.detailHeader}><div><span className={s.eyebrow}>{roleLabel(artifact.role)}</span><h2>{artifact.storage.filename || "未命名媒体"}</h2></div><StatusPill tone={artifact.status === "active" ? "success" : artifact.status === "inaccessible" ? "danger" : "warning"}>{statusLabel(artifact.status)}</StatusPill></div><div className={s.assetStage}><MediaPreview artifact={artifact} /></div><KeyValue rows={[["项目", artifact.linked_objects.project_id || "未归属"], ["SHOT", artifact.linked_objects.shot_id || "未绑定"], ["尺寸", `${artifact.metadata.width || 0} × ${artifact.metadata.height || 0}`], ["时长", artifact.metadata.duration_seconds ? `${artifact.metadata.duration_seconds}s` : "-"], ["内部 ID", <span className={s.copyValue}><code>{artifact.artifact_id}</code><button className={s.iconButton} title="复制 Artifact ID" onClick={() => navigator.clipboard.writeText(artifact.artifact_id)}><Copy size={14} /></button></span>]]} /></div>;
  }
  return <div className={s.objectDetail}><div className={s.detailHeader}><div><span className={s.eyebrow}>{tabs.find((entry) => entry.id === tab)?.label}</span><h2>{assetTitle(item)}</h2></div></div><details className={s.rawDetails}><summary>查看结构化内容</summary><pre>{JSON.stringify(item, null, 2)}</pre></details></div>;
}

function assetId(item: Record<string, unknown>) { return String(item.artifact_id ?? item.memory_id ?? item.reference_id ?? item.recall_pack_id ?? item.id ?? ""); }
function assetTitle(item: Record<string, unknown>) { const storage = item.storage as Record<string, unknown> | undefined; return String((storage?.filename ?? item.title ?? item.name ?? assetId(item)) || "未命名资产"); }
function assetSub(item: Record<string, unknown>) { const linked = item.linked_objects as Record<string, unknown> | undefined; return String(linked?.project_id ?? item.project_id ?? "未归属") || "未归属"; }
function roleLabel(value: string) { return (({ storyboard_image: "分镜图", generated_clip: "生成片段", final_video: "最终视频" } as Record<string, string>)[value] ?? value) || "媒体"; }
function statusLabel(value: string) { return ({ active: "可用", pending_upload: "待上传", inaccessible: "不可访问" } as Record<string, string>)[value] ?? value; }
