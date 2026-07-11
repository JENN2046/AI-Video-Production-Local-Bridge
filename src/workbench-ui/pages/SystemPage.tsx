import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Database, FileJson, ShieldCheck, TestTube2 } from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { apiGet, apiMutation, apiPage } from "../api";
import { EmptyState, ErrorState, KeyValue, LoadingState, Modal, PageHeader, preserveVisibleVirtualScrolls, SegmentedTabs, StatusPill, VirtualList } from "../components";
import s from "../workbench.module.css";

const tabs = [{ id: "runninghub", label: "RunningHub 门禁" }, { id: "canary", label: "Canary" }, { id: "reports", label: "证据报告" }, { id: "governance", label: "数据治理" }];

interface GovernancePreview {
  rule_version: string;
  snapshot_hash: string;
  groups: Array<{ rule_id: string; label: string; count: number; samples: Array<{ project_id: string; title: string }> }>;
  candidate_count: number;
  unmatched_count: number;
  generated_at: string;
}

export function SystemPage() {
  const { tab = "runninghub" } = useParams();
  const navigate = useNavigate();
  return <div className={s.page}>
    <PageHeader eyebrow="本地运行边界" title="系统" description="查看 Provider 门禁、Canary 和结构化证据；原始 JSON 默认折叠。" />
    <div className={s.subnav}><SegmentedTabs items={tabs} active={tab} onChange={(value) => navigate(`/v2/system/${value}`)} /></div>
    {tab === "reports" ? <ReportsView /> : tab === "governance" ? <GovernanceView /> : <CanaryView mode={tab} />}
  </div>;
}

function GovernanceView() {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const query = useQuery({ queryKey: ["system", "governance"], queryFn: () => apiGet<GovernancePreview>("/api/v2/system/governance") });
  useEffect(() => {
    if (query.data && selected.length === 0) setSelected(query.data.groups.filter((group) => group.count > 0).map((group) => group.rule_id));
  }, [query.data]);
  const mutation = useMutation({
    mutationFn: () => apiMutation<{ affected_count: number }>("/api/v2/system/governance/apply", "POST", { rule_groups: selected, snapshot_hash: query.data?.snapshot_hash }),
    onSuccess: () => {
      setConfirming(false);
      setConfirmation("");
      queryClient.invalidateQueries({ queryKey: ["system", "governance"] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["shell"] });
    }
  });
  if (query.isLoading) return <LoadingState label="正在生成治理快照" />;
  if (query.isError || !query.data) return <ErrorState error={query.error} />;
  const selectedCount = query.data.groups.filter((group) => selected.includes(group.rule_id)).reduce((total, group) => total + group.count, 0);
  const toggle = (ruleId: string) => setSelected((current) => current.includes(ruleId) ? current.filter((id) => id !== ruleId) : [...current, ruleId]);
  return <div className={s.governanceLayout}>
    <section className={s.systemBand}><div className={s.systemIcon}><Database size={22} /></div><div><span className={s.eyebrow}>规则版本 {query.data.rule_version}</span><h2>历史测试数据治理</h2><p>命中项目只会标记为测试并归档，SHOT、运行、媒体和报告均保留。</p></div><StatusPill tone="warning">{query.data.candidate_count} 个候选</StatusPill></section>
    <section className={s.governanceSummary}><div><span>当前候选</span><strong>{query.data.candidate_count}</strong></div><div><span>保留活动未分类</span><strong>{query.data.unmatched_count}</strong></div><div><span>本次已选</span><strong>{selectedCount}</strong></div><div><span>快照</span><code>{query.data.snapshot_hash.slice(0, 12)}</code></div><button className={s.primaryButton} disabled={selectedCount === 0} onClick={() => setConfirming(true)}><Archive size={16} /> 确认所选分组</button></section>
    <section className={s.governanceGroups}>{query.data.groups.map((group) => <label key={group.rule_id} className={`${s.governanceGroup} ${selected.includes(group.rule_id) ? s.governanceGroupSelected : ""}`}>
      <input type="checkbox" checked={selected.includes(group.rule_id)} disabled={group.count === 0} onChange={() => toggle(group.rule_id)} />
      <span className={s.governanceGroupTitle}><strong>{group.label}</strong><StatusPill tone={group.count > 0 ? "info" : "neutral"}>{group.count}</StatusPill></span>
      <span className={s.governanceSamples}>{group.samples.slice(0, 3).map((sample) => <span key={sample.project_id}><strong>{sample.title}</strong><small>{sample.project_id}</small></span>)}</span>
    </label>)}</section>
    {mutation.isSuccess && <div className={s.successReceipt}>治理事务已完成，项目记录与历史对象均已保留。</div>}
    {confirming && <Modal title="确认归档测试候选" onClose={() => setConfirming(false)} footer={<><button className={s.secondaryButton} onClick={() => setConfirming(false)}>取消</button><button className={s.dangerButton} disabled={confirmation !== "归档测试项目" || mutation.isPending} onClick={() => mutation.mutate()}>标为测试并归档 {selectedCount} 个项目</button></>}>
      <div className={s.advisoryBox}><span>本次事务</span><strong>{selectedCount} 个项目 · {selected.length} 个规则组</strong><small>应用时会重新校验快照；有任何变化即整单阻断，不会部分落库。</small></div>
      <label className={s.field}><span>输入“归档测试项目”确认</span><input autoFocus value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
      {mutation.isError && <div className={s.inlineError}>{mutation.error.message}</div>}
    </Modal>}
  </div>;
}

function CanaryView({ mode }: { mode: string }) {
  const query = useQuery({ queryKey: ["system", "canary"], queryFn: () => apiGet<Record<string, unknown>>("/api/v2/system/canary") });
  if (query.isLoading) return <LoadingState />;
  if (query.isError || !query.data) return <ErrorState error={query.error} />;
  const boundary = query.data.provider_boundary as Record<string, unknown> | undefined;
  const selectedInput = query.data.selected_input as Record<string, unknown> | undefined;
  return <div className={s.systemGrid}>
    <section className={s.systemBand}><div className={s.systemIcon}>{mode === "runninghub" ? <ShieldCheck size={22} /> : <TestTube2 size={22} />}</div><div><span className={s.eyebrow}>{mode === "runninghub" ? "真实调用边界" : "离线验收"}</span><h2>{mode === "runninghub" ? "单 SHOT 单次提交" : "Canary 状态"}</h2><p>{mode === "runninghub" ? "价格、余额、预算和当次确认全部通过后，才允许一次上传和一次提交。" : "Canary 不会从 V2 自动发起真实调用。"}</p></div><StatusPill tone="success">硬门开启</StatusPill></section>
    <section className={s.systemPanel}><h3>Provider</h3><KeyValue rows={[["活动 Provider", String(query.data.active_provider ?? boundary?.provider ?? "runninghub")], ["模型", String(boundary?.model ?? "rhart-video-g/image-to-video")], ["凭证状态", query.data.credential_present ? "已配置" : "未配置"], ["自动重试", "0"], ["真实任务并发", "1"]]} /></section>
    <section className={s.systemPanel}><h3>输入门禁</h3><KeyValue rows={[["输入", String(selectedInput?.path ?? "未选择")], ["可读", selectedInput?.readable ? "通过" : "未通过"], ["画幅", String(selectedInput?.aspect_ratio ?? "-")], ["时长", `${selectedInput?.duration_seconds ?? 0}s`]]} /></section>
    <section className={s.systemPanel}><h3>安全边界</h3><div className={s.checkList}>{Object.entries(boundary ?? {}).filter(([, value]) => typeof value === "boolean").map(([key, value]) => <div key={key}><span className={value ? s.checkDanger : s.checkGood} />{key}<strong>{value ? "发生" : "未发生"}</strong></div>)}</div></section>
  </div>;
}

function ReportsView() {
  const [params, setParams] = useSearchParams();
  const selectedName = params.get("selected") ?? "";
  const query = useQuery({ queryKey: ["system", "reports"], queryFn: () => apiPage<Record<string, unknown>>("/api/v2/system/reports?limit=100") });
  const selected = useMemo(() => query.data?.items.find((item) => item.name === selectedName) ?? query.data?.items[0], [query.data, selectedName]);
  const report = useQuery({ queryKey: ["report", selected?.name], queryFn: () => apiGet<Record<string, unknown>>(`/api/v2/system/reports/${encodeURIComponent(String(selected?.name ?? ""))}`), enabled: Boolean(selected?.name) });
  if (query.isLoading) return <LoadingState />;
  if (query.isError || !query.data) return <ErrorState error={query.error} />;
  return <div className={s.masterDetail}><section className={s.queuePane}><div className={s.paneTitle}><strong>报告</strong><span>{query.data.meta.total}</span></div><VirtualList items={query.data.items} estimate={72} scrollKey="system:reports" renderItem={(item) => <button className={`${s.queueItem} ${selected?.name === item.name ? s.queueItemActive : ""}`} onClick={() => { preserveVisibleVirtualScrolls(); const next = new URLSearchParams(params); next.set("selected", String(item.name)); setParams(next, { replace: true }); }}><span className={s.queueIcon}><FileJson size={18} /></span><span><strong>{String(item.name)}</strong><small>{formatSize(Number(item.size_bytes ?? 0))} · {formatTime(String(item.updated_at ?? ""))}</small></span>{Boolean(item.is_latest_pointer) && <StatusPill tone="info">latest</StatusPill>}</button>} /></section><section className={s.detailPane}>{selected ? <div className={s.objectDetail}><div className={s.detailHeader}><div><span className={s.eyebrow}>证据摘要</span><h2>{String(selected.name)}</h2></div></div>{report.isLoading ? <LoadingState /> : report.isError || !report.data ? <ErrorState error={report.error} /> : <><KeyValue rows={[["结果", String(report.data.result ?? "UNKNOWN")], ["任务", String(report.data.task ?? report.data.action ?? "-")], ["生成时间", String(report.data.generated_at ?? "-")], ["Provider 调用", (report.data.provider_boundary as Record<string, unknown> | undefined)?.network_call_attempted ? "是" : "否"]]} /><details className={s.rawDetails}><summary>查看原始 JSON</summary><pre>{JSON.stringify(report.data, null, 2)}</pre></details></>}</div> : <EmptyState title="暂无报告" />}</section></div>;
}

function formatSize(value: number) { return value > 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1024))} KB`; }
function formatTime(value: string) { return value ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : ""; }
