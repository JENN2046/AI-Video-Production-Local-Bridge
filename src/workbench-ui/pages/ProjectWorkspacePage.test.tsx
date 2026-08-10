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

  it("shows the verified account balance before human confirmation", async () => {
    const projectId = "project_runninghub_canary";
    const shotId = "shot_runninghub_canary";
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === `/api/v2/projects/${projectId}/generation`) {
        return new Response(JSON.stringify({ ok: true, data: {
          project: { project_id: projectId, title: "RunningHub Canary", video_spec: { aspect_ratio: "9:16", resolution: "480p", duration_seconds: 6 } },
          meta: { classification: "production", lifecycle: "active", pinned: false },
          workspace: "generation",
          shots: [{ shot_id: shotId, project_id: projectId, order: 1, status: "storyboard_approved", duration_seconds: 6, description: "First clip", storyboard_image_artifact_id: "artifact_storyboard", video_prompt: "Gentle motion", negative_prompt: "", generation_run_ids: [], accepted_clip_artifact_id: "", clip_versions: [], review: { approval_status: "pending", rejection_reasons: [], latest_revision_instruction: null } }],
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
          model: "rhart-video-g/image-to-video", input_artifact_id: "artifact_storyboard", duration_seconds: 6, resolution: "480p",
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
    fireEvent.click(screen.getByRole("button", { name: "运行预检" }));

    await waitFor(() => expect(screen.getByText("可用余额")).toBeInTheDocument());
    expect(screen.getByText("10 CNY")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("runninghub.cn"))).toBe(false);
  });
});
