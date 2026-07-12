import type { WebGptV4Scope } from "./types.js";

export type WebGptV4Profile = "readonly" | "full";
export type WebGptV4ToolRisk = "read" | "media_read" | "limited_write" | "proposal_write" | "generation_prepare";

export interface WebGptV4ToolCatalogEntry {
  name: string;
  scope: WebGptV4Scope;
  profiles: readonly WebGptV4Profile[];
  risk: WebGptV4ToolRisk;
  database_access: "read" | "write";
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
  { name: "list_production_projects", scope: "projects.read", profiles: READONLY_AND_FULL, risk: "read", database_access: "read", annotations: READ_ANNOTATIONS },
  { name: "get_project_context", scope: "projects.read", profiles: READONLY_AND_FULL, risk: "read", database_access: "read", annotations: READ_ANNOTATIONS },
  { name: "list_project_shots", scope: "projects.read", profiles: READONLY_AND_FULL, risk: "read", database_access: "read", annotations: READ_ANNOTATIONS },
  { name: "list_project_media", scope: "media.read", profiles: FULL_ONLY, risk: "media_read", database_access: "read", annotations: READ_ANNOTATIONS },
  { name: "inspect_media", scope: "media.read", profiles: FULL_ONLY, risk: "media_read", database_access: "write", annotations: READ_ANNOTATIONS },
  { name: "get_review_package", scope: "projects.read", profiles: READONLY_AND_FULL, risk: "read", database_access: "read", annotations: READ_ANNOTATIONS },
  { name: "get_delivery_status", scope: "projects.read", profiles: READONLY_AND_FULL, risk: "read", database_access: "read", annotations: READ_ANNOTATIONS },
  { name: "get_closeout_evidence", scope: "projects.read", profiles: READONLY_AND_FULL, risk: "read", database_access: "read", annotations: READ_ANNOTATIONS },
  { name: "update_shot_copy", scope: "shots.write", profiles: FULL_ONLY, risk: "limited_write", database_access: "write", annotations: WRITE_ANNOTATIONS },
  { name: "add_review_note", scope: "reviews.write", profiles: FULL_ONLY, risk: "limited_write", database_access: "write", annotations: WRITE_ANNOTATIONS },
  { name: "submit_production_proposal", scope: "proposals.write", profiles: FULL_ONLY, risk: "proposal_write", database_access: "write", annotations: WRITE_ANNOTATIONS },
  { name: "revise_production_proposal", scope: "proposals.write", profiles: FULL_ONLY, risk: "proposal_write", database_access: "write", annotations: WRITE_ANNOTATIONS },
  { name: "close_production_proposal", scope: "proposals.write", profiles: FULL_ONLY, risk: "proposal_write", database_access: "write", annotations: WRITE_ANNOTATIONS },
  { name: "prepare_generation_intent", scope: "generation.prepare", profiles: FULL_ONLY, risk: "generation_prepare", database_access: "write", annotations: WRITE_ANNOTATIONS }
] as const satisfies readonly WebGptV4ToolCatalogEntry[];

export type WebGptV4ToolName = typeof WEBGPT_V4_TOOL_CATALOG[number]["name"];

export const WEBGPT_V4_FULL_TOOL_SCOPES = Object.fromEntries(
  WEBGPT_V4_TOOL_CATALOG.map((tool) => [tool.name, tool.scope])
) as Record<WebGptV4ToolName, WebGptV4Scope>;

export function webGptV4ToolsForProfile(profile: WebGptV4Profile): readonly WebGptV4ToolCatalogEntry[] {
  return WEBGPT_V4_TOOL_CATALOG.filter((tool) => (tool.profiles as readonly WebGptV4Profile[]).includes(profile));
}

export function parseWebGptV4Profile(value?: string | null): WebGptV4Profile {
  const normalized = value?.trim().toLowerCase() || "readonly";
  if (normalized !== "readonly" && normalized !== "full") {
    throw new Error("INVALID_WEBGPT_PROFILE");
  }
  return normalized;
}

export function webGptV4ToolScopesForProfile(profile: WebGptV4Profile): Record<string, WebGptV4Scope> {
  return Object.fromEntries(webGptV4ToolsForProfile(profile).map((tool) => [tool.name, tool.scope]));
}

export function webGptV4ScopesForProfile(profile: WebGptV4Profile): WebGptV4Scope[] {
  return [...new Set(webGptV4ToolsForProfile(profile).map((tool) => tool.scope))];
}

export function webGptV4Tool(name: WebGptV4ToolName): WebGptV4ToolCatalogEntry {
  const tool = WEBGPT_V4_TOOL_CATALOG.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Unknown WebGPT V4 tool: ${name}`);
  return tool;
}

export function webGptV4ToolNeedsWrite(name: string, profile: WebGptV4Profile): boolean {
  const tool = webGptV4ToolsForProfile(profile).find((entry) => entry.name === name);
  return tool?.database_access === "write";
}

export function isWebGptV4ToolName(value: string): value is WebGptV4ToolName {
  return WEBGPT_V4_TOOL_CATALOG.some((tool) => tool.name === value);
}
