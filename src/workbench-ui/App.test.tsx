import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

const shell = {
  version: "human-workbench-v2",
  operator: "Jenn",
  action_nonce: "test-nonce",
  navigation: { dashboard: 2, inbox: 3, projects: 0, assets: 0, system: 0 },
  actionable: { pending_confirmations: 1, gpt_drafts: 1, quarantined_imports: 1, review_pending: 2, running_jobs: 0 },
  capabilities: { legacy_available: true, real_generation_requires_preflight: true, max_real_generation_jobs: 1, automatic_retry: false }
};

describe("Human Workbench V2 shell", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    window.history.replaceState({}, "", "/v2/dashboard");
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/v2/shell") return new Response(JSON.stringify({ ok: true, data: shell }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === "/api/v2/dashboard") return new Response(JSON.stringify({ ok: true, data: { totals: { pending_confirmations: 2, blocked_projects: 1, review_pending: 2, generation_active: 0, pending_delivery: 1 }, projects: [], generated_at: "2026-07-10T00:00:00.000Z" } }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: url } }), { status: 404, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("mounts only the active route and never requests legacy bootstrap", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><BrowserRouter><App /></BrowserRouter></QueryClientProvider>);
    expect(await screen.findByRole("heading", { name: "指挥台" })).toBeInTheDocument();
    expect(await screen.findByText("今日项目队列")).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v2/dashboard", expect.anything()));
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/api/bootstrap"))).toBe(false);
    expect(screen.getByRole("link", { name: /收件箱/ })).toBeInTheDocument();
  });
});
