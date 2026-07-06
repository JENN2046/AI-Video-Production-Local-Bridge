import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { paths } from "../paths.js";
import { openM0Database, type M0Database } from "../storage/sqlite.js";
import { getMediaArtifact, type MediaArtifact } from "./mediaArtifacts.js";
import {
  defaultH1WorkbenchState,
  h1DashboardSummary,
  h2CanaryWorkbenchSummary,
  H1_PROVIDER_BOUNDARY,
  H1_STATE_FILE,
  h1ShotBlockers,
  listH1MediaArtifacts,
  listH1Reports,
  scanH1Imports,
  type H1WorkbenchState
} from "./h1Workbench.js";

export const WEBGPT_READ_ONLY_BRIDGE_VERSION = "webgpt-readonly-v0.1";

export type WebGptReadOnlyToolName =
  | "get_workspace_status"
  | "get_project_status"
  | "list_import_candidates"
  | "list_media_artifacts"
  | "get_media_artifact"
  | "get_shot_status"
  | "get_storyboard_package_status"
  | "get_latest_reports"
  | "get_provider_readiness_summary_redacted";

export interface WebGptReadOnlyToolDefinition {
  name: WebGptReadOnlyToolName;
  description: string;
  input_schema: Record<string, unknown>;
  mode: "READ_ONLY";
  mutation_allowed: false;
  provider_call_allowed: false;
  secret_read_allowed: false;
  shell_allowed: false;
}

export type WebGptReadOnlyToolResult =
  | {
      ok: true;
      tool: WebGptReadOnlyToolName;
      mode: "READ_ONLY";
      mutation_allowed: false;
      data: unknown;
      provider_boundary: typeof H1_PROVIDER_BOUNDARY;
      report_refs: Array<{ name: string; relative_path: string; is_latest_pointer: boolean }>;
    }
  | {
      ok: false;
      tool: WebGptReadOnlyToolName | "unknown";
      mode: "READ_ONLY";
      mutation_allowed: false;
      error: {
        code: string;
        message: string;
      };
      provider_boundary: typeof H1_PROVIDER_BOUNDARY;
      report_refs: Array<{ name: string; relative_path: string; is_latest_pointer: boolean }>;
    };

export const WEBGPT_READ_ONLY_TOOLS: WebGptReadOnlyToolDefinition[] = [
  {
    name: "get_workspace_status",
    description: "Return local workspace bridge status, read-only tool inventory, and current report references.",
    input_schema: {},
    mode: "READ_ONLY",
    mutation_allowed: false,
    provider_call_allowed: false,
    secret_read_allowed: false,
    shell_allowed: false
  },
  {
    name: "get_project_status",
    description: "Return current Human Workbench project and readiness summary.",
    input_schema: { project_id: "optional app project id" },
    mode: "READ_ONLY",
    mutation_allowed: false,
    provider_call_allowed: false,
    secret_read_allowed: false,
    shell_allowed: false
  },
  {
    name: "list_import_candidates",
    description: "Return data/imports candidates as app-screened summaries.",
    input_schema: {},
    mode: "READ_ONLY",
    mutation_allowed: false,
    provider_call_allowed: false,
    secret_read_allowed: false,
    shell_allowed: false
  },
  {
    name: "list_media_artifacts",
    description: "Return app-owned storyboard image Media Artifact summaries.",
    input_schema: {},
    mode: "READ_ONLY",
    mutation_allowed: false,
    provider_call_allowed: false,
    secret_read_allowed: false,
    shell_allowed: false
  },
  {
    name: "get_media_artifact",
    description: "Return one app-owned Media Artifact by real app artifact_id.",
    input_schema: { artifact_id: "required app artifact id" },
    mode: "READ_ONLY",
    mutation_allowed: false,
    provider_call_allowed: false,
    secret_read_allowed: false,
    shell_allowed: false
  },
  {
    name: "get_shot_status",
    description: "Return current shot status from Human Workbench state.",
    input_schema: { shot_id: "optional shot id" },
    mode: "READ_ONLY",
    mutation_allowed: false,
    provider_call_allowed: false,
    secret_read_allowed: false,
    shell_allowed: false
  },
  {
    name: "get_storyboard_package_status",
    description: "Return package candidate blockers and frozen package history.",
    input_schema: {},
    mode: "READ_ONLY",
    mutation_allowed: false,
    provider_call_allowed: false,
    secret_read_allowed: false,
    shell_allowed: false
  },
  {
    name: "get_latest_reports",
    description: "Return report references and safe metadata, not raw private logs.",
    input_schema: {},
    mode: "READ_ONLY",
    mutation_allowed: false,
    provider_call_allowed: false,
    secret_read_allowed: false,
    shell_allowed: false
  },
  {
    name: "get_provider_readiness_summary_redacted",
    description: "Return redacted provider/canary readiness from existing dry-run reports.",
    input_schema: {},
    mode: "READ_ONLY",
    mutation_allowed: false,
    provider_call_allowed: false,
    secret_read_allowed: false,
    shell_allowed: false
  }
];

function isPendingId(value: string): boolean {
  const upper = value.toUpperCase();
  return upper.startsWith("PENDING") || upper.includes("PENDING_");
}

function h1StatePath(): string {
  return join(paths.workspaceRoot, H1_STATE_FILE);
}

function loadH1ReadonlyState(): H1WorkbenchState {
  const target = h1StatePath();
  if (!existsSync(target)) return defaultH1WorkbenchState();
  const parsed = JSON.parse(readFileSync(target, "utf8")) as H1WorkbenchState;
  return {
    ...defaultH1WorkbenchState(),
    ...parsed,
    regeneration_request_drafts: parsed.regeneration_request_drafts ?? []
  };
}

function reportRefs(): Array<{ name: string; relative_path: string; is_latest_pointer: boolean }> {
  return listH1Reports().map((report) => ({
    name: report.name,
    relative_path: report.relative_path,
    is_latest_pointer: report.is_latest_pointer
  }));
}

function ok(tool: WebGptReadOnlyToolName, data: unknown): WebGptReadOnlyToolResult {
  return {
    ok: true,
    tool,
    mode: "READ_ONLY",
    mutation_allowed: false,
    data,
    provider_boundary: H1_PROVIDER_BOUNDARY,
    report_refs: reportRefs()
  };
}

function fail(tool: WebGptReadOnlyToolName | "unknown", code: string, message: string): WebGptReadOnlyToolResult {
  return {
    ok: false,
    tool,
    mode: "READ_ONLY",
    mutation_allowed: false,
    error: { code, message },
    provider_boundary: H1_PROVIDER_BOUNDARY,
    report_refs: reportRefs()
  };
}

function summarizeArtifact(artifact: MediaArtifact) {
  return {
    artifact_id: artifact.artifact_id,
    artifact_type: artifact.artifact_type,
    role: artifact.role,
    status: artifact.status,
    storage: {
      uri: artifact.storage.uri,
      mime_type: artifact.storage.mime_type,
      filename: artifact.storage.filename
    },
    metadata: artifact.metadata,
    linked_objects: artifact.linked_objects
  };
}

export function executeWebGptReadOnlyTool(
  tool: WebGptReadOnlyToolName,
  input: Record<string, unknown> = {},
  db = openM0Database()
): WebGptReadOnlyToolResult {
  const state = loadH1ReadonlyState();

  if (!WEBGPT_READ_ONLY_TOOLS.some((definition) => definition.name === tool)) {
    return fail("unknown", "TOOL_NOT_FOUND", `Read-only tool not found: ${tool}`);
  }

  if (tool === "get_workspace_status") {
    return ok(tool, {
      workspace: "AI Video Production Workspace",
      bridge_version: WEBGPT_READ_ONLY_BRIDGE_VERSION,
      mode: "READ_ONLY",
      tool_count: WEBGPT_READ_ONLY_TOOLS.length,
      tools: WEBGPT_READ_ONLY_TOOLS.map((definition) => ({
        name: definition.name,
        mode: definition.mode,
        mutation_allowed: definition.mutation_allowed,
        provider_call_allowed: definition.provider_call_allowed,
        secret_read_allowed: definition.secret_read_allowed,
        shell_allowed: definition.shell_allowed
      })),
      provider_boundary: H1_PROVIDER_BOUNDARY
    });
  }

  if (tool === "get_project_status") {
    const requestedProjectId = typeof input.project_id === "string" ? input.project_id : "";
    if (requestedProjectId && requestedProjectId !== state.project.project_id) {
      return fail(tool, "PROJECT_NOT_FOUND", `Project not found in current workbench state: ${requestedProjectId}`);
    }
    return ok(tool, {
      project: state.project,
      dashboard: h1DashboardSummary(state, db)
    });
  }

  if (tool === "list_import_candidates") {
    return ok(tool, {
      imports: scanH1Imports(db)
    });
  }

  if (tool === "list_media_artifacts") {
    return ok(tool, {
      artifacts: listH1MediaArtifacts(db).map(summarizeArtifact)
    });
  }

  if (tool === "get_media_artifact") {
    const artifactId = typeof input.artifact_id === "string" ? input.artifact_id : "";
    if (!artifactId) return fail(tool, "MISSING_REQUIRED_FIELD", "artifact_id is required.");
    if (artifactId !== basename(artifactId) || isPendingId(artifactId)) return fail(tool, "INVALID_APP_ID", "Only real app artifact_id values are accepted.");
    const artifact = getMediaArtifact(db, artifactId);
    if (!artifact) return fail(tool, "ARTIFACT_NOT_FOUND", `Artifact not found: ${artifactId}`);
    return ok(tool, {
      artifact: summarizeArtifact(artifact)
    });
  }

  if (tool === "get_shot_status") {
    const shotId = typeof input.shot_id === "string" ? input.shot_id : "";
    const shots = state.shots.map((shot) => ({
      ...shot,
      blockers: h1ShotBlockers(shot, db)
    }));
    if (!shotId) return ok(tool, { shots });
    const shot = shots.find((candidate) => candidate.shot_id === shotId);
    if (!shot) return fail(tool, "SHOT_NOT_FOUND", `Shot not found: ${shotId}`);
    return ok(tool, { shot });
  }

  if (tool === "get_storyboard_package_status") {
    const shots = state.shots.map((shot) => ({
      shot_id: shot.shot_id,
      order: shot.order,
      approval_status: shot.approval_status,
      storyboard_image_artifact_id: shot.storyboard_image_artifact_id,
      blockers: h1ShotBlockers(shot, db)
    }));
    const blockers = shots.flatMap((shot) => shot.blockers.map((blocker) => `${shot.shot_id}:${blocker}`));
    return ok(tool, {
      project: state.project,
      app_ready_candidate: blockers.length === 0,
      blockers,
      shots,
      frozen_package_history: state.frozen_package_history,
      latest_frozen_package: state.frozen_package_history.at(-1) ?? null
    });
  }

  if (tool === "get_latest_reports") {
    return ok(tool, {
      reports: listH1Reports()
    });
  }

  if (tool === "get_provider_readiness_summary_redacted") {
    return ok(tool, {
      provider_readiness: h2CanaryWorkbenchSummary()
    });
  }

  return fail("unknown", "TOOL_NOT_FOUND", `Read-only tool not found: ${tool}`);
}
