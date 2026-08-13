import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { directorLocalDateTimeInputValue } from "./pages/DirectorPage";

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

  it("formats Director datetime-local defaults from local clock fields", () => {
    const localClock = {
      getFullYear: () => 2026,
      getMonth: () => 6,
      getDate: () => 22,
      getHours: () => 11,
      getMinutes: () => 7,
      toISOString: () => "2026-07-22T03:07:00.000Z"
    } as unknown as Date;
    expect(directorLocalDateTimeInputValue(localClock)).toBe("2026-07-22T11:07");
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

  it("renders the fixed five-item mobile navigation and a keyboard-dismissable More sheet", async () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
      matches: true,
      media: "(max-width: 820px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={["/v2/dashboard"]}><App /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByRole("heading", { name: "指挥台" })).toBeInTheDocument();
    const mobileNav = screen.getByRole("navigation", { name: "移动端主导航" });
    expect(mobileNav.querySelectorAll("a,button")).toHaveLength(5);
    for (const name of ["指挥台", "项目", "收件箱", "Director", "更多"]) expect(screen.getByRole(name === "更多" ? "button" : "link", { name })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    const sheet = await screen.findByRole("dialog", { name: "更多" });
    expect(screen.getByRole("link", { name: /资产库/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /系统/ })).toBeInTheDocument();
    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "更多" })).not.toBeInTheDocument());
  });

  it("renders Director approval controls without treating a proposal or Grant as Provider execution", async () => {
    const projectId = "project_director_ui";
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/v2/shell") return new Response(JSON.stringify({ ok: true, data: shell }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.startsWith("/api/v2/projects?")) return new Response(JSON.stringify({ ok: true, data: [{ project: { project_id: projectId, title: "Director UI", status: "draft", brief: {}, video_spec: { duration_seconds: 15, aspect_ratio: "9:16", resolution: "1080x1920" }, shot_ids: [], active_storyboard_package_id: "", generation_batch_ids: [], exports: { final_video_artifact_id: "" } }, meta: {}, shot_count: 0, accepted_count: 0, active_run_count: 0, blocker_count: 0, blocked_shot_count: 0, blocker_codes: [], blocker_reason: "", review_pending_count: 0, delivery_state: "not_ready", next_action: {} }], meta: { limit: 100, offset: 0, total: 1, has_more: false } }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === `/api/v2/director/projects/${projectId}`) return new Response(JSON.stringify({ ok: true, data: { project_id: projectId, principal_state: "single_owner_ready", focus: { state: "no_focus", focus: null }, proposals: [] } }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === `/api/v2/projects/${projectId}/overview`) return new Response(JSON.stringify({ ok: true, data: { project: { project_id: projectId, title: "Director UI" } } }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === `/api/v2/projects/${projectId}/storyboard`) return new Response(JSON.stringify({ ok: true, data: { project: { project_id: projectId, title: "Director UI" }, shots: [] } }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === `/api/v2/assets/media?scope=all&project_id=${projectId}&status=active&limit=200&offset=0`) return new Response(JSON.stringify({ ok: true, data: [], meta: { limit: 200, offset: 0, total: 0, has_more: false } }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: url } }), { status: 404, headers: { "content-type": "application/json" } });
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={["/v2/director"]}><App /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByRole("heading", { name: "Director 审批台" })).toBeInTheDocument();
    expect(screen.getByText(/此处的接受仅记录人工审批/)).toBeInTheDocument();
    expect(await screen.findByText("自动执行")).toBeInTheDocument();
    expect(screen.getByText("需 Grant")).toBeInTheDocument();
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
        if (url === `/api/v2/projects/${projectId}/storyboard`) return new Response(JSON.stringify({ ok: true, data: workspace(projectId, title) }), { status: 200, headers: { "content-type": "application/json" } });
        if (url === `/api/v2/assets/media?scope=all&project_id=${projectId}&status=active&limit=200&offset=0`) return new Response(JSON.stringify({ ok: true, data: [], meta: { limit: 200, offset: 0, total: 0, has_more: false } }), { status: 200, headers: { "content-type": "application/json" } });
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

  it("pages every active Artifact before offering older entries as Director Focus targets", async () => {
    const projectId = "project_director_artifact_paging";
    const olderArtifactId = "artifact_director_older_active";
    const projectSummary = { project: { project_id: projectId, title: "Director artifact paging", status: "draft", brief: {}, video_spec: { duration_seconds: 15, aspect_ratio: "9:16", resolution: "1080x1920" }, shot_ids: [], active_storyboard_package_id: "", generation_batch_ids: [], exports: { final_video_artifact_id: "" } }, meta: {}, shot_count: 0, accepted_count: 0, active_run_count: 0, blocker_count: 0, blocked_shot_count: 0, blocker_codes: [], blocker_reason: "", review_pending_count: 0, delivery_state: "not_ready", next_action: {} };
    const artifact = (artifactId: string) => ({ artifact_id: artifactId, artifact_type: "video", role: "generated_clip", status: "active", storage: { uri: "", mime_type: "video/mp4", filename: "" }, metadata: { width: 720, height: 1280, duration_seconds: 5, aspect_ratio: "9:16", sha256: "d".repeat(64) }, linked_objects: { project_id: projectId, shot_id: "shot_artifact_paging" }, source: { kind: "fixture", provider: "", provider_job_id: "", sha256: "d".repeat(64), external_url_host: "" } });
    const newestPage = Array.from({ length: 200 }, (_, index) => artifact(`artifact_director_new_${String(index).padStart(3, "0")}`));
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/v2/shell") return new Response(JSON.stringify({ ok: true, data: shell }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.startsWith("/api/v2/projects?")) return new Response(JSON.stringify({ ok: true, data: [projectSummary], meta: { limit: 100, offset: 0, total: 1, has_more: false } }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === `/api/v2/director/projects/${projectId}`) return new Response(JSON.stringify({ ok: true, data: { project_id: projectId, principal_state: "single_owner_ready", focus: { state: "no_focus", focus: null }, proposals: [] } }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === `/api/v2/projects/${projectId}/overview` || url === `/api/v2/projects/${projectId}/storyboard`) return new Response(JSON.stringify({ ok: true, data: { project: { project_id: projectId, title: "Director artifact paging" }, shots: [] } }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === `/api/v2/assets/media?scope=all&project_id=${projectId}&status=active&limit=200&offset=0`) return new Response(JSON.stringify({ ok: true, data: newestPage, meta: { limit: 200, offset: 0, total: 201, has_more: true } }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === `/api/v2/assets/media?scope=all&project_id=${projectId}&status=active&limit=200&offset=200`) return new Response(JSON.stringify({ ok: true, data: [artifact(olderArtifactId)], meta: { limit: 200, offset: 200, total: 201, has_more: false } }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === "/api/v2/director/focus" && init?.method === "POST") return new Response(JSON.stringify({ ok: true, data: { focus: {} } }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: url } }), { status: 404, headers: { "content-type": "application/json" } });
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={["/v2/director"]}><App /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByRole("heading", { name: "Director 审批台" })).toBeInTheDocument();
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input) === `/api/v2/assets/media?scope=all&project_id=${projectId}&status=active&limit=200&offset=200`)).toBe(true));
    fireEvent.change(screen.getByLabelText("讨论层级"), { target: { value: "artifact" } });
    await waitFor(() => expect(screen.getByRole("option", { name: `generated_clip · ${olderArtifactId}` })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("当前对象"), { target: { value: olderArtifactId } });
    fireEvent.click(screen.getByRole("checkbox", { name: /我确认将此对象设为 ChatGPT 当前讨论目标/ }));
    fireEvent.click(screen.getByRole("button", { name: "设为当前讨论对象" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input, init]) => String(input) === "/api/v2/director/focus" && (init as RequestInit | undefined)?.method === "POST");
      expect(call).toBeTruthy();
      expect(JSON.parse(String((call?.[1] as RequestInit).body))).toMatchObject({ project_id: projectId, target_type: "artifact", target_id: olderArtifactId, human_confirmation: true });
    });
  });

  it("records an artifact_import receipt with only an already-registered Artifact identifier", async () => {
    const projectId = "project_director_import";
    const proposalId = "proposal_director_import";
    const artifactId = "artifact_director_import_older";
    const candidateArtifact = (candidateId: string) => ({ artifact_id: candidateId, artifact_type: "image", role: "storyboard_image", status: "active", storage: { uri: "C:/private/fixture.png", mime_type: "image/png", filename: "fixture.png" }, metadata: { width: 720, height: 1280, duration_seconds: null, aspect_ratio: "9:16", sha256: "c".repeat(64) }, linked_objects: { project_id: projectId, shot_id: "shot_import" }, source: { kind: "fixture", provider: "", provider_job_id: "", sha256: "c".repeat(64), external_url_host: "" } });
    const newestImportCandidates = Array.from({ length: 200 }, (_, index) => candidateArtifact(`artifact_director_import_new_${String(index).padStart(3, "0")}`));
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/v2/shell") return new Response(JSON.stringify({ ok: true, data: shell }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.startsWith("/api/v2/projects?")) return new Response(JSON.stringify({ ok: true, data: [{ project: { project_id: projectId, title: "Director import", status: "draft", brief: {}, video_spec: { duration_seconds: 5, aspect_ratio: "9:16", resolution: "1080x1920" }, shot_ids: ["shot_import"], active_storyboard_package_id: "", generation_batch_ids: [], exports: { final_video_artifact_id: "" } }, meta: {}, shot_count: 1, accepted_count: 0, active_run_count: 0, blocker_count: 0, blocked_shot_count: 0, blocker_codes: [], blocker_reason: "", review_pending_count: 0, delivery_state: "not_ready", next_action: {} }], meta: { limit: 100, offset: 0, total: 1, has_more: false } }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === `/api/v2/director/projects/${projectId}`) return new Response(JSON.stringify({ ok: true, data: { project_id: projectId, principal_state: "single_owner_ready", focus: { state: "active", focus: { focus_id: "focus_import", project_id: projectId, target_type: "shot", target_id: "shot_import", generation: 1, created_at: "2026-07-23T00:00:00.000Z", expires_at: "2026-07-23T01:00:00.000Z" } }, proposals: [{ proposal_id: proposalId, project_id: projectId, target_type: "shot", target_id: "shot_import", focus_id: "focus_import", focus_generation: 1, kind: "artifact_import", source: "native", created_at: "2026-07-23T00:00:00.000Z", base_state_hash: "a".repeat(64), payload_hash: "b".repeat(64), payload: { shot_id: "shot_import", target_role: "storyboard_image", expected_mime_type: "image/png", summary: "Import the approved storyboard reference.", rationale: "Local receipt only." }, status: "accepted", reason_code: "DIRECTOR_HUMAN_ACCEPTED", updated_at: "2026-07-23T00:01:00.000Z", action_allowed: false, action_blocked_code: "DIRECTOR_PROPOSAL_NOT_PENDING", automation_grant: null, artifact_import_receipt: null }] } }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === `/api/v2/projects/${projectId}/overview`) return new Response(JSON.stringify({ ok: true, data: { project: { project_id: projectId, title: "Director import" } } }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === `/api/v2/projects/${projectId}/storyboard`) return new Response(JSON.stringify({ ok: true, data: { project: { project_id: projectId, title: "Director import" }, shots: [{ shot_id: "shot_import", order: 1, description: "Import fixture" }] } }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === `/api/v2/assets/media?scope=all&project_id=${projectId}&status=active&limit=200&offset=0`) return new Response(JSON.stringify({ ok: true, data: [], meta: { limit: 200, offset: 0, total: 0, has_more: false } }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === `/api/v2/assets/media?scope=all&project_id=${projectId}&shot_id=shot_import&role=storyboard_image&mime_type=image%2Fpng&status=active&limit=200&offset=0`) return new Response(JSON.stringify({ ok: true, data: newestImportCandidates, meta: { limit: 200, offset: 0, total: 201, has_more: true } }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === `/api/v2/assets/media?scope=all&project_id=${projectId}&shot_id=shot_import&role=storyboard_image&mime_type=image%2Fpng&status=active&limit=200&offset=200`) return new Response(JSON.stringify({ ok: true, data: [candidateArtifact(artifactId)], meta: { limit: 200, offset: 200, total: 201, has_more: false } }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === `/api/v2/director/proposals/${proposalId}/artifact-import-receipt` && init?.method === "POST") return new Response(JSON.stringify({ ok: true, data: { receipt: {} } }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: url } }), { status: 404, headers: { "content-type": "application/json" } });
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={["/v2/director"]}><App /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByText("受控素材导入")).toBeInTheDocument();
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input) === `/api/v2/assets/media?scope=all&project_id=${projectId}&shot_id=shot_import&role=storyboard_image&mime_type=image%2Fpng&status=active&limit=200&offset=200`)).toBe(true));
    expect(screen.queryByText("C:/private/fixture.png")).not.toBeInTheDocument();
    expect(screen.getByText(/会重新读取已注册本地 Artifact 的字节/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("已验证的本地 Artifact"), { target: { value: artifactId } });
    fireEvent.click(await screen.findByRole("checkbox", { name: /我确认该 Artifact 已由本地导入流程校验/ }));
    fireEvent.click(screen.getByRole("button", { name: "记录不可变导入回执" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input, init]) => String(input) === `/api/v2/director/proposals/${proposalId}/artifact-import-receipt` && (init as RequestInit | undefined)?.method === "POST");
      expect(call).toBeTruthy();
      const body = String((call?.[1] as RequestInit).body);
      expect(JSON.parse(body)).toEqual({ artifact_id: artifactId, human_confirmation: true });
      expect(body).not.toContain("storage");
      expect(body).not.toContain("private");
    });
  });

  it("registers a quarantined local Artifact directly into a selected SHOT", async () => {
    const checksum = "f".repeat(64);
    const projectId = "project_quarantine_shot_scope";
    const shotId = "shot_quarantine_scope";
    const project = { project: { project_id: projectId, title: "Quarantine target", status: "draft", brief: {}, video_spec: { duration_seconds: 5, aspect_ratio: "9:16", resolution: "1080x1920" }, shot_ids: [shotId], active_storyboard_package_id: "", generation_batch_ids: [], exports: { final_video_artifact_id: "" } }, meta: {}, shot_count: 1, accepted_count: 0, active_run_count: 0, blocker_count: 0, blocked_shot_count: 0, blocker_codes: [], blocker_reason: "", review_pending_count: 0, delivery_state: "not_ready", next_action: {} };
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/v2/shell") return new Response(JSON.stringify({ ok: true, data: shell }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === "/api/v2/inbox/quarantine?status=registerable&limit=100") return new Response(JSON.stringify({ ok: true, data: [{ checksum, filename: "storyboard.png", workflow_status: "registerable", width: 720, height: 1280, aspect_ratio: "9:16", size_bytes: 1234, blockers: [] }], meta: { limit: 100, offset: 0, total: 1, has_more: false } }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === "/api/v2/projects?scope=daily&lifecycle=all&classification=all&query=&limit=20") return new Response(JSON.stringify({ ok: true, data: [project], meta: { limit: 20, offset: 0, total: 1, has_more: false } }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === `/api/v2/projects/${projectId}/storyboard`) return new Response(JSON.stringify({ ok: true, data: { project: project.project, shots: [{ shot_id: shotId, order: 1, description: "Import target" }] } }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === `/api/v2/imports/${checksum}/decision` && init?.method === "POST") return new Response(JSON.stringify({ ok: true, data: { artifact_id: "artifact_scoped" } }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: url } }), { status: 404, headers: { "content-type": "application/json" } });
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={["/v2/inbox/quarantine"]}><App /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByRole("heading", { name: "收件箱" })).toBeInTheDocument();
    expect(await screen.findByText("storyboard.png")).toBeInTheDocument();
    const projectSearch = screen.getByLabelText("搜索项目名称或 ID");
    fireEvent.focus(projectSearch);
    fireEvent.click(await screen.findByRole("option", { name: /Quarantine target/ }));
    const shotSelect = await screen.findByLabelText("目标 SHOT");
    await waitFor(() => expect(shotSelect).toBeEnabled());
    expect(screen.getByRole("button", { name: "注册到目标 SHOT" })).toBeDisabled();
    fireEvent.change(shotSelect, { target: { value: shotId } });
    fireEvent.click(screen.getByRole("button", { name: "注册到目标 SHOT" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input, init]) => String(input) === `/api/v2/imports/${checksum}/decision` && (init as RequestInit | undefined)?.method === "POST");
      expect(call).toBeTruthy();
      expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ decision: "registered", target_project_id: projectId, target_shot_id: shotId, reason: "" });
    });
  });

  it("moves readonly publishing into diagnostic-only Legacy without execution controls", async () => {
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
      return new Response(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: url } }), { status: 404, headers: { "content-type": "application/json" } });
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={["/v2/system/readonly"]}><App /></MemoryRouter></QueryClientProvider>);

    expect(await screen.findByRole("heading", { name: "只读 App 发布诊断" })).toBeInTheDocument();
    expect(screen.getByText("LEGACY_ROUTE_RETIRED_FROM_ACTIVE_WORKBENCH")).toBeInTheDocument();
    expect(screen.getByText(/不提供任何执行按钮/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /预检|发布|续期|恢复/ })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).includes("readonly-operations") && (init as RequestInit | undefined)?.method === "POST")).toBe(false);
  });

  it("separates enforced submission gates from actual Provider readiness", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/v2/shell") return new Response(JSON.stringify({ ok: true, data: shell }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === "/api/v2/system/canary") return new Response(JSON.stringify({ ok: true, data: {
        active_provider: "runninghub",
        env_check_result: "PASS",
        provider_preflight_result: "PASS",
        credential_present: false,
        selected_input: { source_type: "fixture", readable: true, usable_for_real_provider_canary: true, aspect_ratio: "9:16", duration_seconds: 5 },
        provider_boundary: { model: "seedance-v1-5-pro", max_submit_calls: 1, real_submit_requires_separate_authorization: true, real_submit_available: false, network_call_attempted: false },
        dry_run_plan: { batch_generation_allowed: false }
      } }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: url } }), { status: 404, headers: { "content-type": "application/json" } });
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={["/v2/system/provider"]}><App /></MemoryRouter></QueryClientProvider>);

    expect(await screen.findByText("门禁：已强制")).toBeInTheDocument();
    expect(screen.getByText("Provider：未就绪")).toBeInTheDocument();
    expect(screen.queryByText("硬门开启")).not.toBeInTheDocument();
  });
});
