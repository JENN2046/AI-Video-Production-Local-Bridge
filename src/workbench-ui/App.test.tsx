import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

const shell = {
  version: "human-workbench-v2",
  operator: "Jenn",
  action_nonce: "test-nonce",
  navigation: { dashboard: 2, inbox: 3, director: 0, projects: 0, assets: 0, system: 0 },
  actionable: { pending_confirmations: 1, gpt_drafts: 1, quarantined_imports: 1, review_pending: 2, running_jobs: 0 },
  capabilities: { legacy_available: false, real_generation_requires_preflight: true, max_real_generation_jobs: 1, automatic_retry: false }
};

describe("Human Workbench V2 shell", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/v2/shell") return new Response(JSON.stringify({ ok: true, data: shell }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === "/api/v2/dashboard") return new Response(JSON.stringify({ ok: true, data: { totals: { pending_confirmations: 2, blocked_projects: 1, review_pending: 2, generation_active: 0, pending_delivery: 1 }, projects: [], generated_at: "2026-07-10T00:00:00.000Z" } }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: url } }), { status: 404, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("mounts only the active route and never requests legacy bootstrap", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={["/v2/dashboard"]}><App /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByRole("heading", { name: "指挥台" })).toBeInTheDocument();
    expect(await screen.findByText("今日项目队列")).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v2/dashboard", expect.anything()));
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/api/bootstrap"))).toBe(false);
    expect(screen.getByRole("link", { name: /收件箱/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Director 审批/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Legacy" })).not.toBeInTheDocument();
  });

  it("renders Director approval controls without treating a proposal as Provider execution", async () => {
    const projectId = "project_director_ui";
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/v2/shell") return new Response(JSON.stringify({ ok: true, data: shell }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.startsWith("/api/v2/projects?")) return new Response(JSON.stringify({ ok: true, data: [{ project: { project_id: projectId, title: "Director UI", status: "draft", brief: {}, video_spec: { duration_seconds: 15, aspect_ratio: "9:16", resolution: "1080x1920" }, shot_ids: [], active_storyboard_package_id: "", generation_batch_ids: [], exports: { final_video_artifact_id: "" } }, meta: {}, shot_count: 0, accepted_count: 0, active_run_count: 0, blocker_count: 0, blocked_shot_count: 0, blocker_codes: [], blocker_reason: "", review_pending_count: 0, delivery_state: "not_ready", next_action: {} }], meta: { limit: 100, offset: 0, total: 1, has_more: false } }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === `/api/v2/director/projects/${projectId}`) return new Response(JSON.stringify({ ok: true, data: { project_id: projectId, principal_state: "single_owner_ready", focus: { state: "no_focus", focus: null }, proposals: [] } }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === `/api/v2/projects/${projectId}/overview`) return new Response(JSON.stringify({ ok: true, data: { project: { project_id: projectId, title: "Director UI" }, shots: [], artifacts: {} } }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: url } }), { status: 404, headers: { "content-type": "application/json" } });
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={["/v2/director"]}><App /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByRole("heading", { name: "Director 审批台" })).toBeInTheDocument();
    expect(screen.getByText(/此处的接受仅记录人工审批/)).toBeInTheDocument();
    expect(await screen.findByText("执行权限")).toBeInTheDocument();
    expect(screen.getByText("未开放")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).includes("/director/") && (init as RequestInit | undefined)?.method === "POST")).toBe(false);
  });

  it("resets the default Focus target when the selected Director project changes", async () => {
    const projectA = "project_director_ui_a";
    const projectB = "project_director_ui_b";
    const projectSummary = (projectId: string, title: string) => ({ project: { project_id: projectId, title, status: "draft", brief: {}, video_spec: { duration_seconds: 15, aspect_ratio: "9:16", resolution: "1080x1920" }, shot_ids: [], active_storyboard_package_id: "", generation_batch_ids: [], exports: { final_video_artifact_id: "" } }, meta: {}, shot_count: 0, accepted_count: 0, active_run_count: 0, blocker_count: 0, blocked_shot_count: 0, blocker_codes: [], blocker_reason: "", review_pending_count: 0, delivery_state: "not_ready", next_action: {} });
    const workspace = (projectId: string, title: string) => ({ project: { project_id: projectId, title }, shots: [], artifacts: {} });
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/v2/shell") return new Response(JSON.stringify({ ok: true, data: shell }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.startsWith("/api/v2/projects?")) return new Response(JSON.stringify({ ok: true, data: [projectSummary(projectA, "Director A"), projectSummary(projectB, "Director B")], meta: { limit: 100, offset: 0, total: 2, has_more: false } }), { status: 200, headers: { "content-type": "application/json" } });
      for (const [projectId, title] of [[projectA, "Director A"], [projectB, "Director B"]] as const) {
        if (url === `/api/v2/director/projects/${projectId}`) return new Response(JSON.stringify({ ok: true, data: { project_id: projectId, principal_state: "single_owner_ready", focus: { state: "no_focus", focus: null }, proposals: [] } }), { status: 200, headers: { "content-type": "application/json" } });
        if (url === `/api/v2/projects/${projectId}/overview`) return new Response(JSON.stringify({ ok: true, data: workspace(projectId, title) }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "/api/v2/director/focus" && init?.method === "POST") return new Response(JSON.stringify({ ok: true, data: { focus: {} } }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: url } }), { status: 404, headers: { "content-type": "application/json" } });
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={["/v2/director"]}><App /></MemoryRouter></QueryClientProvider>);
    const projectSelect = await screen.findByLabelText("生产项目");
    fireEvent.change(projectSelect, { target: { value: projectB } });
    await waitFor(() => expect(screen.getByLabelText("当前对象")).toHaveValue(projectB));
    fireEvent.click(screen.getByRole("checkbox", { name: /我确认将此对象设为 ChatGPT 当前讨论目标/ }));
    fireEvent.click(screen.getByRole("button", { name: "设为当前讨论对象" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input, init]) => String(input) === "/api/v2/director/focus" && (init as RequestInit | undefined)?.method === "POST");
      expect(call).toBeTruthy();
      expect(JSON.parse(String((call?.[1] as RequestInit).body))).toMatchObject({ project_id: projectB, target_type: "project", target_id: projectB, human_confirmation: true });
    });
  });

  it("exposes explicit readonly preflight and confirmed one-click publish without accepting paths from the browser", async () => {
    const fingerprint = "a".repeat(64);
    const status = {
      operations_version: "personal-readonly-operations-v2",
      checked_at: "2026-07-17T00:00:00.000Z",
      configuration: "ready",
      stable_error_code: null,
      database_available: true,
      publisher_key_available: true,
      ready_to_preflight: true,
      ready_to_publish: true,
      freshness_operations: { state: "renewal_due", reason_code: "SNAPSHOT_EXPIRING_SOON", renewal_recommended: true, recommended_action: "preflight_and_renew", renewal_threshold_seconds: 7200 },
      remote: {
        reachable: true,
        ready: true,
        health_http_status: 200,
        readiness_http_status: 200,
        service_version: "readonly-remote-v1.0.0",
        checks: { oauth: true, publisher_key: true, snapshot_fresh: true, authorization_projection: true, media_capability_roundtrip: true },
        snapshot: { freshness_status: "fresh", generated_at: "2026-07-17T00:00:00.000Z", expires_at: "2026-07-18T00:00:00.000Z", age_seconds: 82800, ttl_remaining_seconds: 3600, snapshot_fingerprint: fingerprint }
      },
      last_publish: null,
      last_receipt_state: "none"
    };
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/v2/shell") return new Response(JSON.stringify({ ok: true, data: shell }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === "/api/v2/system/readonly-operations") return new Response(JSON.stringify({ ok: true, data: status }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.endsWith("/preflight")) return new Response(JSON.stringify({ ok: true, data: { result: "PASS", snapshot_fingerprint: fingerprint, generated_at: status.remote.snapshot.generated_at, expires_at: status.remote.snapshot.expires_at } }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.endsWith("/publish")) return new Response(JSON.stringify({ ok: true, data: { result: "PASS", http_status: 202, snapshot_fingerprint: fingerprint, generated_at: status.remote.snapshot.generated_at, expires_at: status.remote.snapshot.expires_at } }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: url } }), { status: 404, headers: { "content-type": "application/json" } });
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={["/v2/system/readonly"]}><App /></MemoryRouter></QueryClientProvider>);

    expect(await screen.findByRole("heading", { name: "只读 MCP App 发布" })).toBeInTheDocument();
    expect(await screen.findByText(/Snapshot 将在 60 分钟内过期/)).toBeInTheDocument();
    expect(screen.getByText(/状态刷新不会自动发布/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "运行预检" }));
    expect(await screen.findByText(/预检通过/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "立即续期" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认预检并续期" }));
    expect(await screen.findByText(/发布完成/)).toBeInTheDocument();

    const publishCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/publish"));
    expect(publishCall).toBeTruthy();
    const init = publishCall?.[1] as RequestInit;
    expect(init.headers).toMatchObject({ "x-h1-action-nonce": "test-nonce" });
    expect(JSON.parse(String(init.body))).toEqual({ human_confirmation: true });
    expect(String(init.body)).not.toContain("profile");
    expect(String(init.body)).not.toContain("database");
    expect(fetchMock.mock.calls.some(([input]) => /^\/api\/v2\/projects\//.test(String(input)))).toBe(false);
  });

  it("shows a manual recovery action when a restarted remote has no snapshot", async () => {
    const status = {
      operations_version: "personal-readonly-operations-v2",
      checked_at: "2026-07-19T00:00:00.000Z",
      configuration: "ready",
      stable_error_code: null,
      database_available: true,
      publisher_key_available: true,
      ready_to_preflight: true,
      ready_to_publish: true,
      freshness_operations: { state: "restoration_required", reason_code: "SNAPSHOT_NOT_PUBLISHED", renewal_recommended: true, recommended_action: "preflight_and_renew", renewal_threshold_seconds: 7200 },
      remote: {
        reachable: true,
        ready: false,
        health_http_status: 200,
        readiness_http_status: 503,
        service_version: "readonly-remote-v1.0.0",
        checks: { oauth: true, publisher_key: true, snapshot_fresh: false, authorization_projection: false, media_capability_roundtrip: false },
        snapshot: { freshness_status: "no_snapshot", generated_at: null, expires_at: null, age_seconds: null, ttl_remaining_seconds: null, snapshot_fingerprint: null }
      },
      last_publish: null,
      last_receipt_state: "none"
    };
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/v2/shell") return new Response(JSON.stringify({ ok: true, data: shell }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === "/api/v2/system/readonly-operations") return new Response(JSON.stringify({ ok: true, data: status }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: url } }), { status: 404, headers: { "content-type": "application/json" } });
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={["/v2/system/readonly"]}><App /></MemoryRouter></QueryClientProvider>);

    expect(await screen.findByText(/远端当前没有 Snapshot/)).toBeInTheDocument();
    expect(screen.getByText("media_capability_roundtrip")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "立即恢复" })).toBeEnabled();
    expect(screen.getByText(/状态刷新不会自动发布/)).toBeInTheDocument();
  });
});
