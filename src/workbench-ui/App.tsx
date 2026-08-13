import { lazy, Suspense, useEffect, useState, type ReactElement } from "react";
import { Navigate, NavLink, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, FolderKanban, Inbox, LayoutDashboard, Library, MoreHorizontal, Settings, Sparkles } from "lucide-react";

import { loadShell } from "./api";
import { LoadingState, Modal } from "./components";
import s from "./workbench.module.css";

const AssetsPage = lazy(() => import("./pages/AssetsPage").then((module) => ({ default: module.AssetsPage })));
const DashboardPage = lazy(() => import("./pages/DashboardPage").then((module) => ({ default: module.DashboardPage })));
const DirectorPage = lazy(() => import("./pages/DirectorPage").then((module) => ({ default: module.DirectorPage })));
const InboxPage = lazy(() => import("./pages/InboxPage").then((module) => ({ default: module.InboxPage })));
const ProjectWorkspacePage = lazy(() => import("./pages/ProjectWorkspacePage").then((module) => ({ default: module.ProjectWorkspacePage })));
const ProjectsPage = lazy(() => import("./pages/ProjectsPage").then((module) => ({ default: module.ProjectsPage })));
const SystemPage = lazy(() => import("./pages/SystemPage").then((module) => ({ default: module.SystemPage })));

function deferred(element: ReactElement) {
  return <Suspense fallback={<LoadingState />}>{element}</Suspense>;
}

const desktopNav = [
  { id: "dashboard", label: "指挥台", to: "/v2/dashboard", icon: LayoutDashboard },
  { id: "director", label: "Director 审批", to: "/v2/director", icon: Sparkles },
  { id: "inbox", label: "收件箱", to: "/v2/inbox/pending", icon: Inbox },
  { id: "projects", label: "项目", to: "/v2/projects", icon: FolderKanban },
  { id: "assets", label: "资产库", to: "/v2/assets/media", icon: Library },
  { id: "system", label: "系统", to: "/v2/system/provider", icon: Settings }
] as const;

const mobileNav = [
  { id: "dashboard", label: "指挥台", to: "/v2/dashboard", icon: LayoutDashboard },
  { id: "projects", label: "项目", to: "/v2/projects", icon: FolderKanban },
  { id: "inbox", label: "收件箱", to: "/v2/inbox/pending", icon: Inbox },
  { id: "director", label: "Director", to: "/v2/director", icon: Sparkles }
] as const;

function useMobileNavigation(): boolean {
  const query = "(max-width: 820px)";
  const [mobile, setMobile] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return mobile;
}

function AppShell() {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("hwv2:nav-collapsed") === "true");
  const [moreOpen, setMoreOpen] = useState(false);
  const mobile = useMobileNavigation();
  const location = useLocation();
  const shell = useQuery({ queryKey: ["shell"], queryFn: loadShell, refetchInterval: 30_000 });
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem("hwv2:nav-collapsed", String(next));
  };
  const renderNavLink = (item: (typeof desktopNav)[number] | (typeof mobileNav)[number]) => {
    const Icon = item.icon;
    const count = shell.data?.navigation[item.id] ?? 0;
    return <NavLink key={item.id} to={item.to} aria-label={item.label} title={!mobile && collapsed ? item.label : undefined} className={({ isActive }) => `${s.navItem} ${isActive ? s.navActive : ""}`}>
      <Icon size={19} aria-hidden="true" /><span className={s.navLabel}>{item.label}</span>{count > 0 && <span className={s.navBadge} aria-hidden="true">{count > 99 ? "99+" : count}</span>}
    </NavLink>;
  };
  const moreActive = location.pathname.startsWith("/v2/assets") || location.pathname.startsWith("/v2/system");
  return <div className={`${s.app} ${collapsed ? s.navCollapsed : ""}`}>
    <a className={s.skipLink} href="#main-content">跳到主要内容</a>
    <aside className={s.sidebar} aria-label="主导航">
      {!mobile ? <>
        <div className={s.brand}><span className={s.brandMark}><Sparkles size={18} aria-hidden="true" /></span><span className={s.brandText}><strong>Human Workbench</strong><small>AI Video Production</small></span></div>
        <nav aria-label="桌面主导航">{desktopNav.map(renderNavLink)}</nav>
        <div className={s.sidebarBottom}>
          <button className={s.collapseButton} onClick={toggle} aria-label={collapsed ? "展开导航" : "收起导航"}>{collapsed ? <ChevronRight size={17} /> : <><ChevronLeft size={17} /><span>收起</span></>}</button>
        </div>
      </> : <nav className={s.mobileNavigation} aria-label="移动端主导航">
        {mobileNav.map(renderNavLink)}
        <button type="button" className={`${s.navItem} ${moreActive ? s.navActive : ""}`} aria-label="更多" aria-expanded={moreOpen} aria-controls="mobile-more-sheet" aria-current={moreActive ? "page" : undefined} onClick={() => setMoreOpen(true)}>
          <MoreHorizontal size={19} aria-hidden="true" /><span className={s.navLabel}>更多</span>
        </button>
      </nav>}
    </aside>
    <div className={s.shell}>
      <div className={s.topbar}>
        <div className={s.connection}><span className={shell.isError ? s.connectionBad : s.connectionGood} />{shell.isError ? "本地服务异常" : "本地工作台已连接"}</div>
        <div className={s.topMeta}><span>{shell.data?.actionable.running_jobs ?? 0} 个生成中</span><span>{shell.data?.actionable.review_pending ?? 0} 个待审</span><strong>{shell.data?.operator ?? "Jenn"}</strong></div>
      </div>
      <main id="main-content" className={s.content} tabIndex={-1}><Outlet /></main>
      <div className={s.liveRegion} aria-live="polite">{shell.isFetching ? "正在刷新工作台计数" : ""}</div>
    </div>
    {moreOpen && <Modal title="更多" variant="sheet" onClose={() => setMoreOpen(false)}>
      <nav id="mobile-more-sheet" className={s.moreSheetNavigation} aria-label="更多工作台入口">
        <NavLink to="/v2/assets/media" onClick={() => setMoreOpen(false)}><Library size={20} aria-hidden="true" /><span><strong>资产库</strong><small>浏览媒体与跨项目资产</small></span></NavLink>
        <NavLink to="/v2/system/provider" onClick={() => setMoreOpen(false)}><Settings size={20} aria-hidden="true" /><span><strong>系统</strong><small>Provider 门禁与数据治理</small></span></NavLink>
      </nav>
    </Modal>}
  </div>;
}

export function App() {
  return <Routes>
    <Route path="/v2" element={<AppShell />}>
      <Route index element={<Navigate to="dashboard" replace />} />
      <Route path="dashboard" element={deferred(<DashboardPage />)} />
      <Route path="director" element={deferred(<DirectorPage />)} />
      <Route path="inbox/:tab" element={deferred(<InboxPage />)} />
      <Route path="projects" element={deferred(<ProjectsPage />)} />
      <Route path="projects/:id/:workspace" element={deferred(<ProjectWorkspacePage />)} />
      <Route path="assets/:tab" element={deferred(<AssetsPage />)} />
      <Route path="system/:tab" element={deferred(<SystemPage />)} />
    </Route>
    <Route path="*" element={<Navigate to="/v2/dashboard" replace />} />
  </Routes>;
}
