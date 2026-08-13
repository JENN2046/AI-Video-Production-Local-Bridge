import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
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

export function SegmentedTabs({ items, active, onChange, ariaLabel = "视图切换", panelId }: { items: Array<{ id: string; label: string; count?: number }>; active: string; onChange: (id: string) => void; ariaLabel?: string; panelId?: string }) {
  const generatedId = useId().replaceAll(":", "");
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = Math.max(0, items.findIndex((item) => item.id === active));
  const activate = (index: number) => {
    const item = items[index];
    if (!item) return;
    preserveVisibleVirtualScrolls();
    onChange(item.id);
    window.requestAnimationFrame(() => buttons.current[index]?.focus());
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % items.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else return;
    event.preventDefault();
    activate(next);
  };
  return <div className={s.segmented} role="tablist" aria-label={ariaLabel}>
    {items.map((item, index) => <button
      id={`tab-${generatedId}-${item.id || "all"}`}
      key={item.id}
      ref={(element) => { buttons.current[index] = element; }}
      role="tab"
      type="button"
      tabIndex={index === selectedIndex ? 0 : -1}
      aria-selected={active === item.id}
      aria-controls={panelId}
      className={active === item.id ? s.segmentActive : ""}
      onKeyDown={(event) => onKeyDown(event, index)}
      onClick={() => { preserveVisibleVirtualScrolls(); onChange(item.id); }}
    >
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

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])'
].join(",");

function focusableElements(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(focusableSelector)].filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
}

export function Modal({ title, children, onClose, footer, variant = "dialog" }: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode; variant?: "dialog" | "sheet" }) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const restoreRef = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const titleId = `modal-${useId().replaceAll(":", "")}`;
  useLayoutEffect(() => {
    const background = document.getElementById("root");
    const backgroundWasInert = background?.hasAttribute("inert") ?? false;
    const previousOverflow = document.body.style.overflow;
    background?.setAttribute("inert", "");
    document.body.style.overflow = "hidden";
    const dismiss = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener("keydown", dismiss);
    const active = document.activeElement;
    const initial = active instanceof HTMLElement && dialogRef.current?.contains(active)
      ? active
      : dialogRef.current?.querySelector<HTMLElement>("[autofocus]") ?? closeRef.current;
    initial?.focus();
    return () => {
      if (!backgroundWasInert) background?.removeAttribute("inert");
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", dismiss);
      const trigger = restoreRef.current;
      window.requestAnimationFrame(() => { if (trigger?.isConnected) trigger.focus(); });
    };
  }, []);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = focusableElements(dialogRef.current);
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return createPortal(<div className={`${s.modalBackdrop} ${variant === "sheet" ? s.sheetBackdrop : ""}`} role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <section ref={dialogRef} className={`${s.modal} ${variant === "sheet" ? s.sheet : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}>
      <header><h2 id={titleId}>{title}</h2><button ref={closeRef} className={s.iconButton} onClick={onClose} aria-label="关闭"><X size={18} /></button></header>
      <div className={s.modalBody}>{children}</div>
      {footer && <footer>{footer}</footer>}
    </section>
  </div>, document.body);
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
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = `project-picker-${useId().replaceAll(":", "")}`;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value);
  const [activeIndex, setActiveIndex] = useState(0);
  const query = useQuery({
    queryKey: ["project-picker", scope, text],
    queryFn: () => apiPage<ProjectSummary>(`/api/v2/projects?scope=${scope}&lifecycle=all&classification=all&query=${encodeURIComponent(text)}&limit=20`),
    enabled: open
  });
  useEffect(() => {
    if (!value) setText("");
  }, [value]);
  const items = query.data?.items ?? [];
  useEffect(() => {
    setActiveIndex((current) => Math.max(0, Math.min(current, Math.max(0, items.length - 1))));
  }, [items.length]);
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, []);
  const selectProject = (index: number) => {
    const item = items[index];
    if (!item) return;
    onChange(item.project.project_id);
    setText(item.project.title);
    setOpen(false);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      if (open) event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === "Enter" && open && items[activeIndex]) {
      event.preventDefault();
      selectProject(activeIndex);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    setOpen(true);
    if (items.length === 0) return;
    if (event.key === "Home") setActiveIndex(0);
    else if (event.key === "End") setActiveIndex(items.length - 1);
    else if (event.key === "ArrowDown") setActiveIndex((current) => (current + 1) % items.length);
    else setActiveIndex((current) => (current - 1 + items.length) % items.length);
  };
  return <div ref={rootRef} className={s.projectPicker}>
    <div className={s.searchBox}><Search size={16} aria-hidden="true" /><input
      ref={inputRef}
      role="combobox"
      value={text}
      onFocus={() => { setOpen(true); setActiveIndex(Math.max(0, items.findIndex((item) => item.project.project_id === value))); }}
      onChange={(event) => { setText(event.target.value); onChange(""); setActiveIndex(0); setOpen(true); }}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      aria-label={placeholder}
      aria-autocomplete="list"
      aria-expanded={open}
      aria-controls={listboxId}
      aria-activedescendant={open && items[activeIndex] ? `${listboxId}-option-${activeIndex}` : undefined}
    /></div>
    {open && <div id={listboxId} className={s.projectPickerMenu} role="listbox" aria-label="项目搜索结果">
      {query.isLoading ? <span className={s.projectPickerMessage}>正在搜索</span> : items.length ? items.map((item, index) => <button
        id={`${listboxId}-option-${index}`}
        type="button"
        role="option"
        tabIndex={-1}
        aria-selected={item.project.project_id === value}
        key={item.project.project_id}
        className={index === activeIndex ? s.projectPickerOptionActive : ""}
        onMouseEnter={() => setActiveIndex(index)}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => selectProject(index)}
      ><strong>{item.project.title}</strong><small>{item.project.project_id}</small></button>) : <span className={s.projectPickerMessage}>没有匹配项目</span>}
    </div>}
  </div>;
}
