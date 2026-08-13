import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Cloud, Database, FileJson, RefreshCw, ShieldCheck, UploadCloud } from "lucide-react";
import { Navigate, NavLink, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { apiGet, apiMutation, apiPage } from "../api";
import { EmptyState, ErrorState, KeyValue, LoadingState, Modal, PageHeader, preserveVisibleVirtualScrolls, SegmentedTabs, StatusPill, VirtualList } from "../components";
import type { PersonalReadonlyOperationResult, PersonalReadonlyOperationsStatus } from "../types";
import s from "../workbench.module.css";

const tabs = [{ id: "provider", label: "Provider 门禁" }, { id: "governance", label: "数据治理" }];

interface GovernancePreview {
  rule_version: string;
  snapshot_hash: string;
  groups: Array<{ rule_id: string; label: string; count: number; samples: Array<{ project_id: string; title: string }> }>;
  candidate_count: number;
  unmatched_count: number;
  generated_at: string;
}

export function SystemPage() {
  const { tab: requestedTab = "provider" } = useParams();
  const navigate = useNavigate();
  const tab = requestedTab === "runninghub" || requestedTab === "canary" ? "provider" : requestedTab === "readonly" ? "legacy" : requestedTab;
  const [advancedOpen, setAdvancedOpen] = useState(tab === "reports" || tab === "legacy");
  useEffect(() => {
    if (tab === "reports" || tab === "legacy") setAdvancedOpen(true);
  }, [tab]);
  if (requestedTab !== tab) return <Navigate to={`/v2/system/${tab}`} replace />;
  if (!["provider", "governance", "reports", "legacy"].includes(tab)) return <Navigate to="/v2/system/provider" replace />;
  return <div className={s.page}>
    <PageHeader eyebrow="本地运行边界" title="系统" description="活动区只呈现当前 Provider 门禁与数据治理；历史能力留在高级诊断中。" />
    <div className={s.systemNavigation}>
      <SegmentedTabs ariaLabel="系统活动区" panelId="system-active-panel" items={tabs} active={tab} onChange={(value) => navigate(`/v2/system/${value}`)} />
      <details className={s.advancedNavigation} open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
        <summary>高级诊断</summary>
        <div><NavLink to="/v2/system/reports">证据报告</NavLink><NavLink to="/v2/system/legacy">Legacy 只读 App</NavLink></div>
      </details>
    </div>
    <div id="system-active-panel" role="tabpanel">
      {tab === "reports" ? <ReportsView /> : tab === "governance" ? <GovernanceView /> : tab === "legacy" ? <LegacyReadonlyDiagnostics /> : <ProviderGateView />}
    </div>
  </div>;
}

function statusTone(value: boolean | null): "success" | "warning" | "danger" | "neutral" {
  return value === true ? "success" : value === false ? "danger" : "neutral";
}

function statusText(value: boolean | null): string {
  return value === true ? "通过" : value === false ? "未通过" : "未知";
}

function shortFingerprint(value: string | null | undefined): string {
  return value ? `${value.slice(0, 12)}…${value.slice(-6)}` : "—";
}

function LegacyReadonlyDiagnostics() {
  const query = useQuery({
    queryKey: ["system", "readonly-operations"],
    queryFn: () => apiGet<PersonalReadonlyOperationsStatus>("/api/v2/system/readonly-operations"),
    refetchInterval: 60_000
  });
  if (query.isLoading) return <LoadingState label="正在读取 Legacy 诊断状态" />;
  if (query.isError || !query.data) return <div className={s.systemGrid}>
    <section className={s.systemBand}><div className={s.systemIcon}><Cloud size={22} aria-hidden="true" /></div><div><span className={s.eyebrow}>Advanced Legacy</span><h2>只读 App 发布诊断</h2><p>该历史发布面已退出活动生产路径，工作台不会提供预检、发布、续期或恢复按钮。</p></div><StatusPill tone="danger">不可用</StatusPill></section>
    <section className={s.systemPanel}><h3>不可用原因</h3><KeyValue rows={[["状态", "LEGACY_READONLY_UNAVAILABLE"], ["恢复方式", "仅通过独立 Legacy runbook 诊断；活动工作台不执行发布"]]} /></section>
  </div>;
  const data = query.data;
  const snapshot = data.remote.snapshot;
  return <div className={s.systemGrid}>
    <section className={s.systemBand}><div className={s.systemIcon}><Cloud size={22} aria-hidden="true" /></div><div><span className={s.eyebrow}>Advanced Legacy</span><h2>只读 App 发布诊断</h2><p>保留只读状态用于历史排障；该能力不属于当前视频生产闭环，工作台不提供任何执行按钮。</p></div><StatusPill tone="neutral">仅诊断</StatusPill></section>
    <section className={s.systemPanel}><h3>停用原因</h3><KeyValue rows={[["原因码", "LEGACY_ROUTE_RETIRED_FROM_ACTIVE_WORKBENCH"], ["活动替代面", "Provider 门禁 / 数据治理"], ["执行能力", "未提供"]]} /></section>
    <section className={s.systemPanel}><h3>本地状态</h3><KeyValue rows={[["配置", data.configuration], ["数据库", statusText(data.database_available)], ["发布密钥", statusText(data.publisher_key_available)], ["稳定错误码", data.stable_error_code ?? "—"]]} /></section>
    <section className={s.systemPanel}><h3>远端只读状态</h3><KeyValue rows={[["连接", statusText(data.remote.reachable)], ["Readiness", statusText(data.remote.ready)], ["Snapshot", snapshot.freshness_status], ["Fingerprint", <code>{shortFingerprint(snapshot.snapshot_fingerprint)}</code>]]} /></section>
  </div>;
}

function ReadonlyOperationsView() {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const query = useQuery({
    queryKey: ["system", "readonly-operations"],
    queryFn: () => apiGet<PersonalReadonlyOperationsStatus>("/api/v2/system/readonly-operations"),
    refetchInterval: 60_000
  });
  const preflight = useMutation({
    mutationFn: () => apiMutation<PersonalReadonlyOperationResult>("/api/v2/system/readonly-operations/preflight", "POST", {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["system", "readonly-operations"] })
  });
  const publish = useMutation({
    mutationFn: () => apiMutation<PersonalReadonlyOperationResult>("/api/v2/system/readonly-operations/publish", "POST", { human_confirmation: true }),
    onSuccess: () => {
      setConfirming(false);
      queryClient.invalidateQueries({ queryKey: ["system", "readonly-operations"] });
    }
  });
  if (query.isLoading) return <LoadingState label="正在读取只读 App 发布状态" />;
  if (query.isError || !query.data) return <ErrorState error={query.error} />;
  const data = query.data;
  const snapshot = data.remote.snapshot;
  const freshness = data.freshness_operations;
  const last = data.last_publish;
  const busy = preflight.isPending || publish.isPending;
  const snapshotLabel = snapshot.freshness_status === "fresh" ? "新鲜"
    : snapshot.freshness_status === "snapshot_expired" ? "已过期"
      : snapshot.freshness_status === "no_snapshot" ? "未发布" : "未知";
  const renewalAction = freshness.recommended_action === "preflight_and_renew";
  const publishLabel = renewalAction ? (freshness.state === "restoration_required" ? "预检并恢复" : "预检并续期") : "预检并发布";
  const reminderActionLabel = freshness.state === "restoration_required" ? "立即恢复" : "立即续期";
  const freshnessMessage = freshness.reason_code === "SNAPSHOT_EXPIRING_SOON"
    ? `Snapshot 将在 ${Math.max(0, Math.floor((snapshot.ttl_remaining_seconds ?? 0) / 60))} 分钟内过期，建议现在续期。`
    : freshness.reason_code === "SNAPSHOT_NOT_PUBLISHED"
      ? "远端当前没有 Snapshot，可能尚未发布或服务重启后内存快照已丢失。"
      : freshness.reason_code === "SNAPSHOT_EXPIRED"
        ? "远端 Snapshot 已过期，七个只读工具会保持 fail closed。"
        : freshness.reason_code === "REMOTE_UNREACHABLE"
          ? "远端服务当前不可达；请先检查服务状态，再决定是否续期。"
          : freshness.reason_code === "REMOTE_NOT_READY" || freshness.reason_code === "SNAPSHOT_STATUS_UNKNOWN"
            ? "远端状态不完整；请先刷新并检查 readiness。"
            : null;
  return <div className={s.systemGrid}>
    <section className={s.systemBand}>
      <div className={s.systemIcon}><Cloud size={22} /></div>
      <div><span className={s.eyebrow}>{data.operations_version}</span><h2>只读 MCP App 发布</h2><p>一键执行只读预检、签名和远端 Snapshot 替换；不会写业务数据库、调用 Provider 或启用媒体。</p></div>
      <div className={s.headerActions}>
        <button className={s.secondaryButton} disabled={query.isFetching || busy} onClick={() => void query.refetch()}><RefreshCw size={15} />刷新状态</button>
        <button className={s.secondaryButton} disabled={!data.ready_to_preflight || busy} onClick={() => preflight.mutate()}><ShieldCheck size={15} />运行预检</button>
        <button className={s.primaryButton} disabled={!data.ready_to_publish || busy} onClick={() => setConfirming(true)}><UploadCloud size={15} />{publishLabel}</button>
      </div>
    </section>
    {freshnessMessage && <section className={`${s.freshnessNotice} ${freshness.renewal_recommended ? s.freshnessWarning : s.freshnessDanger}`}>
      <div><strong>{freshness.renewal_recommended ? "Snapshot 需要人工处理" : "远端状态需要检查"}</strong><span>{freshnessMessage}</span><small>{freshness.reason_code} · 状态刷新不会自动发布。</small></div>
      {freshness.renewal_recommended && <button className={s.primaryButton} disabled={!data.ready_to_publish || busy} onClick={() => setConfirming(true)}><UploadCloud size={15} />{reminderActionLabel}</button>}
    </section>}
    <section className={s.systemPanel}><h3>本地发布条件</h3><KeyValue rows={[
      ["配置", data.configuration === "ready" ? "已就绪" : data.configuration === "missing" ? "未配置" : "配置无效"],
      ["活动数据库", statusText(data.database_available)],
      ["DPAPI 发布密钥", statusText(data.publisher_key_available)],
      ["稳定错误码", data.stable_error_code ?? "—"]
    ]} /></section>
    <section className={s.systemPanel}><h3>远端服务</h3><KeyValue rows={[
      ["连接", <StatusPill tone={statusTone(data.remote.reachable)}>{data.remote.reachable ? "可达" : "不可达"}</StatusPill>],
      ["Readiness", <StatusPill tone={statusTone(data.remote.ready)}>{data.remote.ready ? "Ready" : "Not ready"}</StatusPill>],
      ["HTTP", `${data.remote.health_http_status ?? "—"} / ${data.remote.readiness_http_status ?? "—"}`],
      ["服务版本", data.remote.service_version ?? "—"]
    ]} /></section>
    <section className={s.systemPanel}><h3>Snapshot</h3><KeyValue rows={[
      ["状态", <StatusPill tone={snapshot.freshness_status === "fresh" ? "success" : snapshot.freshness_status === "unknown" ? "neutral" : "warning"}>{snapshotLabel}</StatusPill>],
      ["Fingerprint", <code>{shortFingerprint(snapshot.snapshot_fingerprint)}</code>],
      ["生成时间", formatTime(snapshot.generated_at ?? "") || "—"],
      ["剩余 TTL", snapshot.ttl_remaining_seconds === null ? "—" : `${Math.max(0, Math.floor(snapshot.ttl_remaining_seconds / 60))} 分钟`]
    ]} /></section>
    <section className={s.systemPanel}><h3>远端门禁</h3><div className={s.checkList}>{Object.entries(data.remote.checks).map(([key, value]) => <div key={key}><span className={value ? s.checkGood : s.checkDanger} />{key}<strong>{statusText(value)}</strong></div>)}</div></section>
    <section className={s.systemPanel}><h3>最近发布回执</h3><KeyValue rows={[
      ["回执状态", data.last_receipt_state === "valid" ? "已验证" : data.last_receipt_state === "invalid" ? "无效" : "暂无"],
      ["结果", last?.result ?? "—"],
      ["时间", formatTime(last?.timestamp ?? "") || "—"],
      ["Fingerprint", <code>{shortFingerprint(last?.snapshot_fingerprint)}</code>]
    ]} /></section>
    {preflight.isSuccess && <div className={s.successReceipt}>预检通过：{shortFingerprint(preflight.data.snapshot_fingerprint)}，尚未替换远端 Snapshot。</div>}
    {publish.isSuccess && <div className={s.successReceipt}>发布完成：HTTP {publish.data.http_status} · {shortFingerprint(publish.data.snapshot_fingerprint)}</div>}
    {(preflight.isError || publish.isError) && <div className={s.inlineError}>{preflight.error?.message ?? publish.error?.message}</div>}
    {confirming && <Modal title={renewalAction ? "确认人工续期只读 Snapshot" : "确认发布只读 Snapshot"} onClose={() => setConfirming(false)} footer={<><button className={s.secondaryButton} onClick={() => setConfirming(false)}>取消</button><button className={s.primaryButton} disabled={publish.isPending} onClick={() => publish.mutate()}><UploadCloud size={15} />确认{publishLabel}</button></>}>
      <div className={s.advisoryBox}><span>本次操作</span><strong>只读导出 → DPAPI 签名 → HTTPS Snapshot 替换</strong><small>不会修改业务数据库、授权关系、媒体、Provider 或系统自动启动配置。</small></div>
    </Modal>}
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

function ProviderGateView() {
  const query = useQuery({ queryKey: ["system", "canary"], queryFn: () => apiGet<Record<string, unknown>>("/api/v2/system/canary") });
  if (query.isLoading) return <LoadingState />;
  if (query.isError || !query.data) return <ErrorState error={query.error} />;
  const boundary = query.data.provider_boundary as Record<string, unknown> | undefined;
  const selectedInput = query.data.selected_input as Record<string, unknown> | undefined;
  const dryRun = query.data.dry_run_plan as Record<string, unknown> | undefined;
  const envReady = /PASS|READY/i.test(String(query.data.env_check_result ?? ""));
  const preflightReady = /PASS|READY/i.test(String(query.data.provider_preflight_result ?? ""));
  const inputReady = selectedInput?.usable_for_real_provider_canary === true;
  const providerReady = query.data.credential_present === true && envReady && preflightReady && inputReady;
  const gateEnforced = boundary?.real_submit_requires_separate_authorization === true
    && Number(boundary?.max_submit_calls ?? 0) <= 1
    && dryRun?.batch_generation_allowed !== true;
  return <div className={s.systemGrid}>
    <section className={s.systemBand}><div className={s.systemIcon}><ShieldCheck size={22} aria-hidden="true" /></div><div><span className={s.eyebrow}>当前真实调用边界</span><h2>单 SHOT 单次提交</h2><p>门禁是否强制与 Provider 当前是否就绪分别显示；价格、余额、预算和当次确认缺一即 fail closed。</p></div><div className={s.statusStack}><StatusPill tone={gateEnforced ? "success" : "danger"}>门禁：{gateEnforced ? "已强制" : "未确认"}</StatusPill><StatusPill tone={providerReady ? "success" : "warning"}>Provider：{providerReady ? "已就绪" : "未就绪"}</StatusPill></div></section>
    <section className={s.systemPanel}><h3>Provider 就绪条件</h3><KeyValue rows={[["活动 Provider", String(query.data.active_provider ?? boundary?.provider ?? "未选择") || "未选择"], ["模型", String(boundary?.model ?? "未选择") || "未选择"], ["环境检查", envReady ? "通过" : "未通过"], ["Provider 预检", preflightReady ? "通过" : "未通过"], ["凭证状态", query.data.credential_present ? "已配置" : "未配置"]]} /></section>
    <section className={s.systemPanel}><h3>输入门禁</h3><KeyValue rows={[["来源类型", String(selectedInput?.source_type ?? "未选择") || "未选择"], ["字节可读", selectedInput?.readable ? "通过" : "未通过"], ["可用于真实 Canary", inputReady ? "通过" : "未通过"], ["画幅", String(selectedInput?.aspect_ratio ?? "-")], ["时长", `${selectedInput?.duration_seconds ?? 0}s`]]} /></section>
    <section className={s.systemPanel}><h3>提交约束</h3><KeyValue rows={[["独立人工授权", boundary?.real_submit_requires_separate_authorization === true ? "必需" : "未确认"], ["最大提交", String(boundary?.max_submit_calls ?? 0)], ["自动重试", "0"], ["批量生成", dryRun?.batch_generation_allowed === true ? "允许" : "禁止"]]} /></section>
    <section className={s.systemPanel}><h3>安全边界</h3><div className={s.checkList}>{Object.entries(boundary ?? {}).filter(([key, value]) => typeof value === "boolean" && !["real_submit_requires_separate_authorization", "real_submit_available"].includes(key)).map(([key, value]) => <div key={key}><span className={value ? s.checkDanger : s.checkGood} aria-hidden="true" />{key}<strong>{value ? "发生" : "未发生"}</strong></div>)}</div></section>
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
