import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectWorkspacePage } from "./ProjectWorkspacePage";

describe("RunningHub generation preflight", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("sends the selected Seedance model and shows the verified account balance before human confirmation", async () => {
    const projectId = "project_runninghub_canary";
    const shotId = "shot_runninghub_canary";
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === `/api/v2/projects/${projectId}/generation`) {
        return new Response(JSON.stringify({ ok: true, data: {
          project: { project_id: projectId, title: "RunningHub Canary", video_spec: { aspect_ratio: "9:16", resolution: "720p", duration_seconds: 5 } },
          meta: { classification: "production", lifecycle: "active", pinned: false },
          workspace: "generation",
          shots: [{ shot_id: shotId, project_id: projectId, order: 1, status: "storyboard_approved", duration_seconds: 5, description: "First clip", storyboard_image_artifact_id: "artifact_storyboard", video_prompt: "Gentle motion", negative_prompt: "", generation_run_ids: [], accepted_clip_artifact_id: "", clip_versions: [], review: { approval_status: "pending", rejection_reasons: [], latest_revision_instruction: null } }],
          artifacts: {},
          runs: []
        } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "/api/v2/shell") {
        return new Response(JSON.stringify({ ok: true, data: { action_nonce: "test-nonce" } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === `/api/v2/projects/${projectId}/generation/preflight` && init?.method === "POST") {
        return new Response(JSON.stringify({ ok: true, data: { intent: {
          intent_id: "intent_runninghub_canary", run_id: "", project_id: projectId, shot_id: shotId, provider: "runninghub", account_label: "personal",
          model: "seedance-v1.5-pro/image-to-video", input_artifact_id: "artifact_storyboard", duration_seconds: 5, resolution: "720p",
          estimated_cost_value: 0.08, budget_limit_value: 1, currency: "CNY", input_snapshot: { balance_gate: "pass", account_balance_value: 10, account_balance_currency: "CNY" },
          confirmed: false, expires_at: "2099-01-01T00:00:00.000Z", status: "prepared"
        } } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: url } }), { status: 404, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

    render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={[`/v2/projects/${projectId}/generation`]}><Routes><Route path="/v2/projects/:id/:workspace" element={<ProjectWorkspacePage />} /></Routes></MemoryRouter></QueryClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "预检并生成" }));
    fireEvent.change(screen.getByLabelText("模型"), { target: { value: "seedance-v1.5-pro/image-to-video" } });
    fireEvent.click(screen.getByRole("button", { name: "运行预检" }));

    await waitFor(() => expect(screen.getByText("可用余额")).toBeInTheDocument());
    expect(screen.getByText("10 CNY")).toBeInTheDocument();
    const preflightCall = fetchMock.mock.calls.find(([input, init]) => String(input) === `/api/v2/projects/${projectId}/generation/preflight` && init?.method === "POST");
    expect(JSON.parse(String(preflightCall?.[1]?.body))).toMatchObject({ model: "seedance-v1.5-pro/image-to-video" });
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("runninghub.cn"))).toBe(false);
  });
});

describe("manual generation reconciliation", () => {
  const projectId = "project_reconciliation";
  const shotId = "shot_reconciliation";

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function workspace(hasProviderTaskId: boolean) {
    return {
      project: { project_id: projectId, title: "Reconciliation", status: "storyboard_approved", video_spec: { aspect_ratio: "9:16", resolution: "1080x1920", duration_seconds: 6 } },
      meta: { classification: "production", lifecycle: "active", pinned: false },
      workspace: "generation",
      shots: [{
        shot_id: shotId, project_id: projectId, order: 1, status: "storyboard_approved", duration_seconds: 6,
        description: "Reconcile clip", storyboard_image_artifact_id: "artifact_storyboard", video_prompt: "Move", negative_prompt: "",
        generation_run_ids: [], accepted_clip_artifact_id: "", clip_versions: [],
        review: { approval_status: "pending", rejection_reasons: [], latest_revision_instruction: null },
        operational_state: {
          shot_id: shotId, project_id: projectId, stored_workflow_status: "storyboard_approved", primary_stage: "manual_reconciliation",
          storyboard: { approval_status: "approved", artifact_id: "artifact_storyboard", artifact_status: "active", verification_level: "bytes_verified" },
          generation: { stage: "manual_reconciliation", workflow_ready: false, reason_codes: ["GENERATION_MANUAL_RECONCILIATION"] },
          review: { stage: "not_started", reviewable: false, approval_status: null, selected_artifact_id: null },
          delivery: { accepted_clip_artifact_id: null, ready: false, reason_codes: ["SHOT_ACCEPTED_CLIP_MISSING"] },
          allowed_workflow_actions: { approve_storyboard: false, freeze_storyboard: false, prepare_generation: false, confirm_generation: false, review_clip: false, regenerate: false },
          blocker_codes: ["GENERATION_MANUAL_RECONCILIATION"]
        }
      }],
      artifacts: {},
      runs: [],
      reconciliation_items: [{
        job_id: "job_reconciliation", intent_id: "intent_reconciliation", shot_id: shotId,
        provider: "runninghub", model: "rhart-video-g/image-to-video", job_state: "manual_reconciliation",
        intent_status: "running", reason_code: "PROVIDER_SUBMIT_OUTCOME_UNKNOWN",
        has_provider_task_id: hasProviderTaskId, updated_at: "2026-08-13T00:00:00.000Z"
      }]
    };
  }

  function renderReconciliation(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>) {
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={[`/v2/projects/${projectId}/generation`]}><Routes><Route path="/v2/projects/:id/:workspace" element={<ProjectWorkspacePage />} /></Routes></MemoryRouter></QueryClientProvider>);
  }

  function responseFor(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, hasProviderTaskId: boolean) {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === `/api/v2/projects/${projectId}/generation`) return new Response(JSON.stringify({ ok: true, data: workspace(hasProviderTaskId) }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === "/api/v2/shell") return new Response(JSON.stringify({ ok: true, data: { action_nonce: "test-nonce" } }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === "/api/v2/generation/jobs/job_reconciliation/reconcile" && init?.method === "POST") return new Response(JSON.stringify({ ok: true, data: { job: { job_id: "job_reconciliation", state: "polling" }, intent: { intent_id: "intent_reconciliation" } } }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: url } }), { status: 404, headers: { "content-type": "application/json" } });
    });
  }

  it("continues a recorded Provider task without asking for or submitting another task", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    responseFor(fetchMock, true);
    renderReconciliation(fetchMock);

    fireEvent.click(await screen.findByRole("button", { name: "继续核对已记录任务" }));
    expect(screen.queryByLabelText("现有 Provider task ID")).not.toBeInTheDocument();
    expect(screen.getByText(/绝不会重新 submit/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "继续核对" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith("/reconcile") && init?.method === "POST")).toBe(true));
    const call = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith("/reconcile") && init?.method === "POST");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ decision: "attach_existing_task", human_confirmation: true });
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/generation/preflight"))).toBe(false);
  });

  it("requires a task ID when no recorded Provider task exists", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    responseFor(fetchMock, false);
    renderReconciliation(fetchMock);

    fireEvent.click(await screen.findByRole("button", { name: "输入现有 task ID" }));
    fireEvent.change(screen.getByLabelText("现有 Provider task ID"), { target: { value: "existing-task-456" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "继续核对" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith("/reconcile") && init?.method === "POST")).toBe(true));
    const call = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith("/reconcile") && init?.method === "POST");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ decision: "attach_existing_task", provider_task_id: "existing-task-456", human_confirmation: true });
  });

  it("requires both an abandonment reason and a second confirmation", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    responseFor(fetchMock, false);
    renderReconciliation(fetchMock);

    fireEvent.click(await screen.findByRole("button", { name: "放弃本次尝试" }));
    const submit = screen.getByRole("button", { name: "确认放弃" });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("放弃原因（必填）"), { target: { value: "Human verified no Provider task exists." } });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(submit);

    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith("/reconcile") && init?.method === "POST")).toBe(true));
    const call = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith("/reconcile") && init?.method === "POST");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ decision: "abandon", reason: "Human verified no Provider task exists.", human_confirmation: true });
  });
});
