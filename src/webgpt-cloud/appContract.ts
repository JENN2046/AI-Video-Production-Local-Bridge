import { z } from "zod/v4";

export const READONLY_WORKBENCH_RESOURCE_URI = "ui://aivideo/readonly-workbench-v1.html";
export const READONLY_WORKBENCH_RESOURCE_MIME = "text/html;profile=mcp-app";
export const READONLY_WORKBENCH_RESOURCE_VERSION = "readonly-workbench-v1.0.0";
export const READONLY_WORKBENCH_RENDER_TOOL = "render_ai_video_workspace_app";
export const READONLY_WORKBENCH_DATA_TOOLS = [
  "list_production_projects",
  "get_project_context",
  "list_project_shots",
  "get_review_package",
  "get_delivery_status",
  "get_closeout_evidence"
] as const;

export const READONLY_WORKBENCH_RENDER_INPUT_SCHEMA = z.object({
  initial_project_id: z.string().min(1).max(200).optional(),
  initial_panel: z.enum(["projects", "context", "shots", "review", "delivery", "closeout"]).optional()
}).strict();

export const READONLY_WORKBENCH_SNAPSHOT_STATUS_SCHEMA = z.object({
  server_now: z.string(),
  generated_at: z.string().nullable(),
  expires_at: z.string().nullable(),
  age_seconds: z.number().int().nonnegative().nullable(),
  ttl_remaining_seconds: z.number().int().nonnegative(),
  freshness_status: z.enum(["no_snapshot", "fresh", "snapshot_expired"]),
  snapshot_fingerprint: z.string().regex(/^[0-9a-f]{64}$/).nullable()
}).strict();

export const READONLY_WORKBENCH_SHELL_SCHEMA = z.object({
  app_state: z.enum(["ready", "no_snapshot", "snapshot_expired", "service_unavailable", "no_authorized_projects"]),
  service_version: z.string().min(1),
  resource_version: z.literal(READONLY_WORKBENCH_RESOURCE_VERSION),
  status: READONLY_WORKBENCH_SNAPSHOT_STATUS_SCHEMA,
  initial_intent: z.object({
    project_id: z.string().min(1).max(200).nullable(),
    panel: z.enum(["projects", "context", "shots", "review", "delivery", "closeout"])
  }).strict()
}).strict();

export type ReadonlyWorkbenchRenderInput = z.infer<typeof READONLY_WORKBENCH_RENDER_INPUT_SCHEMA>;
export type ReadonlyWorkbenchShell = z.infer<typeof READONLY_WORKBENCH_SHELL_SCHEMA>;
