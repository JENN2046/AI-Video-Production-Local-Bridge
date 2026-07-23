import {
  READONLY_WORKBENCH_DATA_TOOLS,
  READONLY_WORKBENCH_MEDIA_TOOL,
  READONLY_WORKBENCH_RENDER_TOOL
} from "../webgpt-cloud/appContract.js";
import { DIRECTOR_NATIVE_TOOL_CATALOG } from "../director/mcpContract.js";
import type { WebGptV4Scope } from "../webgpt-v4/types.js";

export type UnifiedWorkspaceToolChain = "readonly" | "director";
export type UnifiedWorkspaceToolVisibility = "model" | "app";

export interface UnifiedWorkspaceToolCatalogEntry {
  name: string;
  scope: readonly WebGptV4Scope[];
  chain: UnifiedWorkspaceToolChain;
  visibility: UnifiedWorkspaceToolVisibility;
  risk: "read" | "media_read" | "proposal_write";
}

const PROJECTS_READ = ["projects.read"] as const satisfies readonly WebGptV4Scope[];

/**
 * This is the only public model-visible tool list for the future unified
 * connector. The old Readonly and Director catalogs remain independently
 * deployable rollback contracts until external acceptance succeeds.
 */
export const UNIFIED_WORKSPACE_MODEL_TOOL_CATALOG: readonly UnifiedWorkspaceToolCatalogEntry[] = [
  { name: READONLY_WORKBENCH_RENDER_TOOL, scope: PROJECTS_READ, chain: "readonly", visibility: "model", risk: "read" },
  ...READONLY_WORKBENCH_DATA_TOOLS.map((name) => ({ name, scope: PROJECTS_READ, chain: "readonly" as const, visibility: "model" as const, risk: "read" as const })),
  ...DIRECTOR_NATIVE_TOOL_CATALOG.map((entry) => ({
    name: entry.name,
    scope: entry.scope,
    chain: "director" as const,
    visibility: "model" as const,
    risk: entry.risk
  }))
];

export const UNIFIED_WORKSPACE_APP_ONLY_TOOL_CATALOG: readonly UnifiedWorkspaceToolCatalogEntry[] = [
  { name: READONLY_WORKBENCH_MEDIA_TOOL, scope: PROJECTS_READ, chain: "readonly", visibility: "app", risk: "media_read" }
];

export const UNIFIED_WORKSPACE_OAUTH_SCOPES = ["projects.read", "media.read", "proposals.write"] as const satisfies readonly WebGptV4Scope[];

export function unifiedWorkspaceToolScopes(includeAppOnly = false): Record<string, readonly WebGptV4Scope[]> {
  const catalog = includeAppOnly
    ? [...UNIFIED_WORKSPACE_MODEL_TOOL_CATALOG, ...UNIFIED_WORKSPACE_APP_ONLY_TOOL_CATALOG]
    : UNIFIED_WORKSPACE_MODEL_TOOL_CATALOG;
  return Object.fromEntries(catalog.map((entry) => [entry.name, entry.scope]));
}

export function assertUnifiedWorkspaceToolCatalog(): void {
  const entries = [...UNIFIED_WORKSPACE_MODEL_TOOL_CATALOG, ...UNIFIED_WORKSPACE_APP_ONLY_TOOL_CATALOG];
  const names = new Set(entries.map((entry) => entry.name));
  if (entries.length !== names.size) throw new Error("UNIFIED_WORKSPACE_TOOL_DUPLICATE");
  if (UNIFIED_WORKSPACE_MODEL_TOOL_CATALOG.length !== 12) throw new Error("UNIFIED_WORKSPACE_MODEL_TOOL_COUNT_INVALID");
  const scopes = new Set(entries.flatMap((entry) => entry.scope));
  if (scopes.size !== UNIFIED_WORKSPACE_OAUTH_SCOPES.length
    || UNIFIED_WORKSPACE_OAUTH_SCOPES.some((scope) => !scopes.has(scope))) {
    throw new Error("UNIFIED_WORKSPACE_SCOPE_CATALOG_INVALID");
  }
}
