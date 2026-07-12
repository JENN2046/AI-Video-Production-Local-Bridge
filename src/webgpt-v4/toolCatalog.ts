import type { WebGptV4Scope } from "./types.js";

export type WebGptV4Profile = "readonly" | "full";
export type WebGptV4ToolRisk = "read" | "media_read" | "limited_write" | "proposal_write" | "generation_prepare";

export interface WebGptV4ToolCatalogEntry {
  name: string;
  scope: WebGptV4Scope;
  profiles: readonly WebGptV4Profile[];
  risk: WebGptV4ToolRisk;
  annotations: {
    readOnlyHint: boolean;
    openWorldHint: false;
    destructiveHint: false;
    idempotentHint?: true;
  };
}

const READ_ANNOTATIONS = { readOnlyHint: true, openWorldHint: false, destructiveHint: false } as const;
const WRITE_ANNOTATIONS = { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: true } as const;
const READONLY_AND_FULL = ["readonly", "full"] as const;
const FULL_ONLY = ["full"] as const;

export const WEBGPT_V4_TOOL_CATALOG = [
  { name: "list_production_projects", scope: "projects.read", profiles: READONLY_AND_FULL, risk: "read", annotations: READ_ANNOTATIONS },
  { name: "get_project_context", scope: "projects.read", profiles: READONLY_AND_FULL, risk: "read", annotations: READ_ANNOTATIONS },
  { name: "list_project_shots", scope: "projects.read", profiles: READONLY_AND_FULL, risk: "read", annotations: READ_ANNOTATIONS },
  { name: "list_project_media", scope: "media.read", profiles: FULL_ONLY, risk: "media_read", annotations: READ_ANNOTATIONS },
  { name: "inspect_media", scope: "media.read", profiles: FULL_ONLY, risk: "media_read", annotations: READ_ANNOTATIONS },
  { name: "get_review_package", scope: "projects.read", profiles: READONLY_AND_FULL, risk: "read", annotations: READ_ANNOTATIONS },
  { name: "get_delivery_status", scope: "projects.read", profiles: READONLY_AND_FULL, risk: "read", annotations: READ_ANNOTATIONS },
  { name: "get_closeout_evidence", scope: "projects.read", profiles: READONLY_AND_FULL, risk: "read", annotations: READ_ANNOTATIONS },
  { name: "update_shot_copy", scope: "shots.write", profiles: FULL_ONLY, risk: "limited_write", annotations: WRITE_ANNOTATIONS },
  { name: "add_review_note", scope: "reviews.write", profiles: FULL_ONLY, risk: "limited_write", annotations: WRITE_ANNOTATIONS },
  { name: "submit_production_proposal", scope: "proposals.write", profiles: FULL_ONLY, risk: "proposal_write", annotations: WRITE_ANNOTATIONS },
  { name: "revise_production_proposal", scope: "proposals.write", profiles: FULL_ONLY, risk: "proposal_write", annotations: WRITE_ANNOTATIONS },
  { name: "close_production_proposal", scope: "proposals.write", profiles: FULL_ONLY, risk: "proposal_write", annotations: WRITE_ANNOTATIONS },
  { name: "prepare_generation_intent", scope: "generation.prepare", profiles: FULL_ONLY, risk: "generation_prepare", annotations: WRITE_ANNOTATIONS }
] as const satisfies readonly WebGptV4ToolCatalogEntry[];

export type WebGptV4ToolName = typeof WEBGPT_V4_TOOL_CATALOG[number]["name"];

export const WEBGPT_V4_FULL_TOOL_SCOPES = Object.fromEntries(
  WEBGPT_V4_TOOL_CATALOG.map((tool) => [tool.name, tool.scope])
) as Record<WebGptV4ToolName, WebGptV4Scope>;

export function webGptV4ToolsForProfile(profile: WebGptV4Profile): readonly WebGptV4ToolCatalogEntry[] {
  return WEBGPT_V4_TOOL_CATALOG.filter((tool) => (tool.profiles as readonly WebGptV4Profile[]).includes(profile));
}

export function isWebGptV4ToolName(value: string): value is WebGptV4ToolName {
  return WEBGPT_V4_TOOL_CATALOG.some((tool) => tool.name === value);
}
