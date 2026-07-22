import { lazy, Suspense, useState, type ReactElement } from "react";
import { Navigate, NavLink, Outlet, Route, Routes } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, FolderKanban, Inbox, LayoutDashboard, Library, Settings, Sparkles } from "lucide-react";

import { loadShell } from "./api";
import { LoadingState } from "./components";
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

const nav = [
  { id: "dashboard", label: "指挥台", to: "/v2/dashboard", icon: LayoutDashboard },
  { id: "director", label: "Director 审批", to: "/v2/director", icon: Sparkles },
  { id: "inbox", label: "收件箱", to: "/v2/inbox/pending", icon: Inbox },
  { id: "projects", label: "项目", to: "/v2/projects", icon: FolderKanban },
  { id: "assets", label: "资产库", to: "/v2/assets/media", icon: Library },
  { id: "system", label: "系统", to: "/v2/system/runninghub", icon: Settings }
] as const;

function AppShell() {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("hwv2:nav-collapsed") === "true");
  const shell = useQuery({ queryKey: ["shell"], queryFn: loadShell, refetchInterval: 30_000 });
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem("hwv2:nav-collapsed", String(next));
  };
  return <div className={`${s.app} ${collapsed ? s.navCollapsed : ""}`}>
    <aside className={s.sidebar} aria-label="主导航">
      <div className={s.brand}><span className={s.brandMark}><Sparkles size={18} /></span><span className={s.brandText}><strong>Human Workbench</strong><small>AI Video Production</small></span></div>
      <nav>
        {nav.map((item) => {
          const Icon = item.icon;
          const count = shell.data?.navigation[item.id] ?? 0;
          return <NavLink key={item.id} to={item.to} aria-label={item.label} title={collapsed ? item.label : undefined} className={({ isActive }) => `${s.navItem} ${isActive ? s.navActive : ""}`}>
            <Icon size={19} /><span className={s.navLabel}>{item.label}</span>{count > 0 && <span className={s.navBadge}>{count > 99 ? "99+" : count}</span>}
          </NavLink>;
        })}
      </nav>
      <div className={s.sidebarBottom}>
        <button className={s.collapseButton} onClick={toggle} title={collapsed ? "展开导航" : "收起导航"}>{collapsed ? <ChevronRight size={17} /> : <><ChevronLeft size={17} /><span>收起</span></>}</button>
      </div>
    </aside>
    <div className={s.shell}>
      <div className={s.topbar}>
        <div className={s.connection}><span className={shell.isError ? s.connectionBad : s.connectionGood} />{shell.isError ? "本地服务异常" : "本地工作台已连接"}</div>
        <div className={s.topMeta}><span>{shell.data?.actionable.running_jobs ?? 0} 个生成中</span><span>{shell.data?.actionable.review_pending ?? 0} 个待审</span><strong>{shell.data?.operator ?? "Jenn"}</strong></div>
      </div>
      <main className={s.content}><Outlet /></main>
      <div className={s.liveRegion} aria-live="polite">{shell.isFetching ? "正在刷新工作台计数" : ""}</div>
    </div>
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
