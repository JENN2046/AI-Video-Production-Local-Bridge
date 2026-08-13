import type { ApiEnvelope, AssemblyPreflight, DeliveryJob, GenerationIntent, PageMeta, ShellData, WorkbenchExport } from "./types";

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

export function preflightGeneration(projectId: string, body: { shot_id: string; account_label: "personal" | "team"; budget_limit_value: number; model: string }) {
  return apiMutation<{ intent: GenerationIntent }>(`/api/v2/projects/${encodeURIComponent(projectId)}/generation/preflight`, "POST", body);
}

export function confirmGeneration(intentId: string, budget: number) {
  return apiMutation<{ intent: GenerationIntent; run_id: string; job_id: string; status: "queued" }>(`/api/v2/generation/intents/${encodeURIComponent(intentId)}/confirm`, "POST", {
    budget_limit_value: budget,
    cost_confirmed: true,
    human_confirmation: true
  });
}

export function reconcileGeneration(jobId: string, body: {
  decision: "attach_existing_task" | "abandon";
  provider_task_id?: string;
  reason?: string;
  human_confirmation: true;
}) {
  return apiMutation<{ job: { job_id: string; state: string }; intent: GenerationIntent }>(`/api/v2/generation/jobs/${encodeURIComponent(jobId)}/reconcile`, "POST", body);
}

export function preflightDeliveryAssembly(projectId: string) {
  return apiMutation<AssemblyPreflight>(`/api/v2/projects/${encodeURIComponent(projectId)}/delivery/assembly/preflight`, "POST", {});
}

export function startDeliveryAssembly(projectId: string, inputFingerprint: string) {
  return apiMutation<{ job: DeliveryJob; preflight: AssemblyPreflight }>(`/api/v2/projects/${encodeURIComponent(projectId)}/delivery/assembly`, "POST", {
    input_fingerprint: inputFingerprint,
    human_confirmation: true
  });
}

export function submitFinalReview(projectId: string, body: {
  artifact_id: string;
  decision: "accept" | "reassemble" | "regenerate_shots";
  shot_ids?: string[];
  reason?: string;
}) {
  return apiMutation(`/api/v2/projects/${encodeURIComponent(projectId)}/delivery/final-review`, "POST", { ...body, human_confirmation: true });
}

export function startDeliveryExport(projectId: string, artifactId: string) {
  return apiMutation<{ reused: boolean; export: WorkbenchExport | null; job: DeliveryJob | null }>(`/api/v2/projects/${encodeURIComponent(projectId)}/delivery/export`, "POST", {
    artifact_id: artifactId,
    human_confirmation: true
  });
}

export function closeoutDelivery(projectId: string, confirmationPhrase: string) {
  return apiMutation(`/api/v2/projects/${encodeURIComponent(projectId)}/delivery/closeout`, "POST", {
    confirmation_phrase: confirmationPhrase
  });
}
