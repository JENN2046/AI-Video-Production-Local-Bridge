import type { ApiEnvelope, GenerationIntent, PageMeta, ShellData } from "./types";

let actionNonce = "";

async function parse<T>(response: Response): Promise<ApiEnvelope<T>> {
  const payload = await response.json() as ApiEnvelope<T>;
  if (!response.ok || !payload.ok) {
    const error = payload.error ?? { code: `HTTP_${response.status}`, message: "请求失败。" };
    throw Object.assign(new Error(error.message), { code: error.code, field: error.field });
  }
  return payload;
}

export async function apiGet<T>(path: string): Promise<T> {
  return (await parse<T>(await fetch(path, { headers: { Accept: "application/json" } }))).data;
}

export async function apiPage<T>(path: string): Promise<{ items: T[]; meta: PageMeta }> {
  const payload = await parse<T[]>(await fetch(path, { headers: { Accept: "application/json" } }));
  return { items: payload.data, meta: payload.meta as PageMeta };
}

export async function loadShell(): Promise<ShellData> {
  const shell = await apiGet<ShellData>("/api/v2/shell");
  actionNonce = shell.action_nonce;
  return shell;
}

export async function apiMutation<T>(path: string, method: "POST" | "PATCH", body: Record<string, unknown>): Promise<T> {
  if (!actionNonce) await loadShell();
  const response = await fetch(path, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-h1-action-nonce": actionNonce
    },
    body: JSON.stringify(body)
  });
  return (await parse<T>(response)).data;
}

export function preflightGeneration(projectId: string, body: { shot_id: string; account_label: "personal" | "team"; budget_limit_value: number }) {
  return apiMutation<{ intent: GenerationIntent }>(`/api/v2/projects/${encodeURIComponent(projectId)}/generation/preflight`, "POST", body);
}

export function confirmGeneration(intentId: string, budget: number) {
  return apiMutation<{ intent: GenerationIntent; run_id: string; job_id: string; status: "queued" }>(`/api/v2/generation/intents/${encodeURIComponent(intentId)}/confirm`, "POST", {
    budget_limit_value: budget,
    cost_confirmed: true,
    human_confirmation: true
  });
}
