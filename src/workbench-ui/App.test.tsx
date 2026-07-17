import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  capabilities: { legacy_available: false, real_generation_requires_preflight: true, max_real_generation_jobs: 1, automatic_retry: false }
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
    expect(screen.queryByRole("link", { name: "Legacy" })).not.toBeInTheDocument();
  });

  it("exposes explicit readonly preflight and confirmed one-click publish without accepting paths from the browser", async () => {
    window.history.replaceState({}, "", "/v2/system/readonly");
    const fingerprint = "a".repeat(64);
    const status = {
      operations_version: "personal-readonly-operations-v1",
      checked_at: "2026-07-17T00:00:00.000Z",
      configuration: "ready",
      stable_error_code: null,
      database_available: true,
      publisher_key_available: true,
      ready_to_preflight: true,
      ready_to_publish: true,
      remote: {
        reachable: true,
        ready: true,
        health_http_status: 200,
        readiness_http_status: 200,
        service_version: "readonly-remote-v1.0.0",
        checks: { oauth: true, publisher_key: true, snapshot_fresh: true, authorization_projection: true },
        snapshot: { freshness_status: "fresh", generated_at: "2026-07-17T00:00:00.000Z", expires_at: "2026-07-18T00:00:00.000Z", age_seconds: 0, ttl_remaining_seconds: 86400, snapshot_fingerprint: fingerprint }
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
    render(<QueryClientProvider client={queryClient}><BrowserRouter><App /></BrowserRouter></QueryClientProvider>);

    expect(await screen.findByRole("heading", { name: "只读 MCP App 发布" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "运行预检" }));
    expect(await screen.findByText(/预检通过/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "预检并发布" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认预检并发布" }));
    expect(await screen.findByText(/发布完成/)).toBeInTheDocument();

    const publishCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/publish"));
    expect(publishCall).toBeTruthy();
    const init = publishCall?.[1] as RequestInit;
    expect(init.headers).toMatchObject({ "x-h1-action-nonce": "test-nonce" });
    expect(JSON.parse(String(init.body))).toEqual({ human_confirmation: true });
    expect(String(init.body)).not.toContain("profile");
    expect(String(init.body)).not.toContain("database");
  });
});
