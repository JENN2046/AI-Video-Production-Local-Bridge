import { openM0Database, type M0Database } from "../storage/sqlite.js";
import type { Confirmation, GenerationRun } from "./generation.js";
import { getProject, type ToolError } from "./projects.js";

type ToolResult<T> = { ok: true } & T | { ok: false; error: ToolError; blocking_reasons?: string[] };

/**
 * Migration 0012 makes the legacy placeholder-copy assembler incompatible on
 * purpose. The real persistent Assembly owner will replace this kill-switch;
 * Foundation must never manufacture delivery evidence or media output.
 */
export function assembleFinalVideo(
  input: {
    project_id: string;
    confirmation?: Confirmation;
  },
  db = openM0Database()
): ToolResult<{ run: GenerationRun; final_video_artifact_id: string }> {
  const project = getProject(db, input.project_id);
  if (!project) return { ok: false, error: { code: "PROJECT_NOT_FOUND", message: `Project not found: ${input.project_id}` } };

  return {
    ok: false,
    error: {
      code: "LEGACY_ASSEMBLY_INCOMPATIBLE",
      message: "Legacy placeholder assembly is disabled by the durable delivery-state schema."
    }
  };
}
