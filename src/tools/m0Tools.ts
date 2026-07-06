import type { M0Database } from "../storage/sqlite.js";

export const M0_TOOL_NAMES = [
  "create_project",
  "get_project_status",
  "register_media_artifact",
  "import_storyboard_package",
  "start_storyboard_video_generation",
  "get_generation_status",
  "mark_shot_clip_review",
  "regenerate_shot_video",
  "assemble_final_video"
] as const;

export type M0ToolName = (typeof M0_TOOL_NAMES)[number];

export interface M0ToolDefinition {
  name: M0ToolName;
  implementedInPhase: string;
  status: "placeholder" | "implemented";
}

export interface M0ToolContext {
  db: M0Database;
}

export interface M0ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

const phaseByTool: Record<M0ToolName, string> = {
  create_project: "M0-A",
  get_project_status: "M0-A",
  register_media_artifact: "M0-B",
  import_storyboard_package: "M0-C",
  start_storyboard_video_generation: "M0-D",
  get_generation_status: "M0-D",
  mark_shot_clip_review: "M0-E",
  regenerate_shot_video: "M0-E",
  assemble_final_video: "M0-F"
};

const implementedTools = new Set<M0ToolName>([
  "create_project",
  "get_project_status",
  "register_media_artifact",
  "import_storyboard_package"
  ,
  "start_storyboard_video_generation",
  "get_generation_status",
  "mark_shot_clip_review",
  "regenerate_shot_video",
  "assemble_final_video"
]);

export function listM0Tools(): M0ToolDefinition[] {
  return M0_TOOL_NAMES.map((name) => ({
    name,
    implementedInPhase: phaseByTool[name],
    status: implementedTools.has(name) ? "implemented" : "placeholder"
  }));
}

export function isM0ToolName(name: string): name is M0ToolName {
  return (M0_TOOL_NAMES as readonly string[]).includes(name);
}

export function callM0ToolPlaceholder(name: string): M0ToolResult {
  if (!isM0ToolName(name)) {
    return {
      ok: false,
      error: {
        code: "UNKNOWN_TOOL",
        message: `Unknown M0 tool: ${name}`
      }
    };
  }

  return {
    ok: false,
    error: {
      code: "M0_TOOL_NOT_IMPLEMENTED",
      message: `${name} is registered but not implemented in the M0-A skeleton.`
    }
  };
}
