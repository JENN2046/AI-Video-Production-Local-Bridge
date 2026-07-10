import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";

import { apiPage } from "./api";
import s from "./workbench.module.css";
import type { MediaArtifact, ProjectSummary } from "./types";

export function preserveVisibleVirtualScrolls(): void {
  document.querySelectorAll<HTMLElement>("[data-virtual-scroll-key]").forEach((element) => {
    const key = element.dataset.virtualScrollKey;
    if (!key) return;
    sessionStorage.setItem(`hwv2:scroll:${key}`, String(element.scrollTop));
    sessionStorage.setItem(`hwv2:scroll-lock:${key}`, String(Date.now() + 300));
  });
}

export function StatusPill({ tone = "neutral", children }: { tone?: "success" | "warning" | "danger" | "info" | "neutral"; children: ReactNode }) {
  return <span className={`${s.statusPill} ${s[`tone_${tone}`]}`}>{children}</span>;
}

export function LoadingState({ label = "正在读取当前工作区" }: { label?: string }) {
  return <div className={s.loading} role="status"><span className={s.spinner} />{label}</div>;
}

export function ErrorState({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : "数据读取失败。";
  return <div className={s.errorState} role="alert"><strong>当前视图无法加载</strong><span>{message}</span></div>;
}

export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return <div className={s.emptyState}><strong>{title}</strong>{detail && <span>{detail}</span>}</div>;
}

export function SegmentedTabs({ items, active, onChange, ariaLabel }: { items: Array<{ id: string; label: string; count?: number }>; active: string; onChange: (id: string) => void; ariaLabel?: string }) {
  return <div className={s.segmented} role="tablist" aria-label={ariaLabel}>
    {items.map((item) => <button key={item.id} role="tab" aria-selected={active === item.id} className={active === item.id ? s.segmentActive : ""} onClick={() => { preserveVisibleVirtualScrolls(); onChange(item.id); }}>
      {item.label}{item.count !== undefined && <span>{item.count}</span>}
    </button>)}
  </div>;
}

export function VirtualList<T>({
  items,
  estimate = 76,
  scrollKey,
  renderItem
}: {
  items: T[];
  estimate?: number;
  scrollKey: string;
  renderItem: (item: T, index: number) => ReactNode;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const activeScrollKey = useRef(scrollKey);
  const lastScrollTop = useRef(Number(sessionStorage.getItem(`hwv2:scroll:${scrollKey}`) ?? 0));
  const virtualizer = useVirtualizer({ count: items.length, getScrollElement: () => parentRef.current, estimateSize: () => estimate, overscan: 8 });

  useLayoutEffect(() => {
    const element = parentRef.current;
    if (!element) return;
    if (activeScrollKey.current !== scrollKey) {
      sessionStorage.setItem(`hwv2:scroll:${activeScrollKey.current}`, String(lastScrollTop.current));
      activeScrollKey.current = scrollKey;
      const saved = Number(sessionStorage.getItem(`hwv2:scroll:${scrollKey}`) ?? 0);
      lastScrollTop.current = Number.isFinite(saved) ? saved : 0;
    }
    const saved = Number(sessionStorage.getItem(`hwv2:scroll:${activeScrollKey.current}`) ?? lastScrollTop.current);
    if (Number.isFinite(saved)) lastScrollTop.current = saved;
    if (Math.abs(element.scrollTop - lastScrollTop.current) > 1) element.scrollTop = lastScrollTop.current;
    window.setTimeout(() => sessionStorage.removeItem(`hwv2:scroll-lock:${activeScrollKey.current}`), 300);
  });

  useEffect(() => () => {
    const position = parentRef.current?.scrollTop ?? lastScrollTop.current;
    sessionStorage.setItem(`hwv2:scroll:${activeScrollKey.current}`, String(position));
  }, []);

  return <div ref={parentRef} data-virtual-scroll-key={scrollKey} className={s.virtualViewport} onScroll={(event) => {
    const lockedUntil = Number(sessionStorage.getItem(`hwv2:scroll-lock:${activeScrollKey.current}`) ?? 0);
    if (event.currentTarget.scrollTop === 0 && lastScrollTop.current > 0 && Date.now() < lockedUntil) return;
    lastScrollTop.current = event.currentTarget.scrollTop;
    sessionStorage.setItem(`hwv2:scroll:${activeScrollKey.current}`, String(lastScrollTop.current));
  }}>
    <div className={s.virtualCanvas} style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((row) => <div key={row.key} className={s.virtualRow} style={{ height: row.size, transform: `translateY(${row.start}px)` }}>
        {renderItem(items[row.index], row.index)}
      </div>)}
    </div>
  </div>;
}

export function Modal({ title, children, onClose, footer }: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return <div className={s.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <section className={s.modal} role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <header><h2 id="modal-title">{title}</h2><button ref={closeRef} className={s.iconButton} onClick={onClose} title="关闭"><X size={18} /></button></header>
      <div className={s.modalBody}>{children}</div>
      {footer && <footer>{footer}</footer>}
    </section>
  </div>;
}

export function MediaPreview({ artifact, className = "" }: { artifact?: MediaArtifact | null; className?: string }) {
  if (!artifact) return <EmptyState title="尚未绑定媒体" />;
  const src = `/media/artifacts/${encodeURIComponent(artifact.artifact_id)}`;
  if (artifact.artifact_type === "video") return <video className={`${s.mediaPreview} ${className}`} controls preload="metadata" src={src} aria-label={artifact.storage.filename || artifact.artifact_id} />;
  return <img className={`${s.mediaPreview} ${className}`} src={src} alt={artifact.storage.filename || "分镜图"} />;
}

export function KeyValue({ rows }: { rows: Array<[string, ReactNode]> }) {
  return <dl className={s.keyValue}>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return <header className={s.pageHeader}>
    <div>{eyebrow && <span className={s.eyebrow}>{eyebrow}</span>}<h1>{title}</h1>{description && <p>{description}</p>}</div>
    {actions && <div className={s.headerActions}>{actions}</div>}
  </header>;
}

export function ProjectPicker({
  value,
  onChange,
  scope = "daily",
  placeholder = "搜索项目名称或 ID"
}: {
  value: string;
  onChange: (projectId: string) => void;
  scope?: "daily" | "all";
  placeholder?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value);
  const query = useQuery({
    queryKey: ["project-picker", scope, text],
    queryFn: () => apiPage<ProjectSummary>(`/api/v2/projects?scope=${scope}&lifecycle=all&classification=all&query=${encodeURIComponent(text)}&limit=20`),
    enabled: open
  });
  useEffect(() => {
    if (!value) setText("");
  }, [value]);
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, []);
  return <div ref={rootRef} className={s.projectPicker}>
    <label className={s.searchBox}><Search size={16} /><input
      value={text}
      onFocus={() => setOpen(true)}
      onChange={(event) => { setText(event.target.value); onChange(""); setOpen(true); }}
      placeholder={placeholder}
      aria-label={placeholder}
      aria-expanded={open}
    /></label>
    {open && <div className={s.projectPickerMenu} role="listbox">
      {query.isLoading ? <span className={s.projectPickerMessage}>正在搜索</span> : query.data?.items.length ? query.data.items.map((item) => <button
        type="button"
        role="option"
        aria-selected={item.project.project_id === value}
        key={item.project.project_id}
        onClick={() => { onChange(item.project.project_id); setText(item.project.title); setOpen(false); }}
      ><strong>{item.project.title}</strong><small>{item.project.project_id}</small></button>) : <span className={s.projectPickerMessage}>没有匹配项目</span>}
    </div>}
  </div>;
}
