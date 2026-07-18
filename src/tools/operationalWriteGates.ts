import type { ShotOperationalState } from "../packages/domain/operationalState.js";
import type { M0Database } from "../storage/sqlite.js";
import { collectProjectOperationalBundles, OperationalStateIntegrityError } from "./operationalStateFacts.js";
import type { Project, Shot } from "./projects.js";

export type ShotWorkflowWriteAction = keyof ShotOperationalState["allowed_workflow_actions"];

export type ShotWorkflowWriteGateResult =
  | { ok: true; state: ShotOperationalState }
  | {
    ok: false;
    error: {
      code: "PROJECT_ARCHIVED" | "SHOT_WORKFLOW_ACTION_NOT_ALLOWED" | "SHOT_WORKFLOW_GATE_INTEGRITY_VIOLATION";
      message: string;
      field: "project_id" | "workflow_action";
    };
  };

export function requireShotWorkflowWriteAction(
  db: M0Database,
  project: Project,
  shot: Shot,
  action: ShotWorkflowWriteAction
): ShotWorkflowWriteGateResult {
  const result = requireProjectShotWorkflowWriteAction(db, project, [shot], action);
  return result.ok ? { ok: true, state: result.states[0] } : result;
}

export function requireProjectShotWorkflowWriteAction(
  db: M0Database,
  project: Project,
  shots: Shot[],
  action: ShotWorkflowWriteAction
): { ok: true; states: ShotOperationalState[] } | Extract<ShotWorkflowWriteGateResult, { ok: false }> {
  try {
    if (shots.length === 0
      || new Set(shots.map((shot) => shot.shot_id)).size !== shots.length
      || shots.some((shot) => shot.project_id !== project.project_id)) {
      throw new OperationalStateIntegrityError("SHOT_OPERATIONAL_GATE_INPUT_INVALID");
    }
    const meta = db.prepare("SELECT lifecycle FROM workbench_project_meta WHERE project_id = ?").get(project.project_id) as { lifecycle: string } | undefined;
    if (!meta) throw new OperationalStateIntegrityError("PROJECT_OPERATIONAL_METADATA_MISSING");
    if (meta.lifecycle === "archived") {
      return { ok: false, error: { code: "PROJECT_ARCHIVED", message: "Archived projects are read-only.", field: "project_id" } };
    }
    if (meta.lifecycle !== "active") throw new OperationalStateIntegrityError("PROJECT_OPERATIONAL_METADATA_INVALID");
    const overrides = new Map(shots.map((shot) => [`${shot.project_id}\u0000${shot.shot_id}`, shot]));
    const bundle = collectProjectOperationalBundles(db, [project], { shot_overrides: overrides }).get(project.project_id);
    if (!bundle) throw new OperationalStateIntegrityError("SHOT_OPERATIONAL_STATE_UNAVAILABLE");
    const states = shots.map((shot) => bundle.states_by_shot_id.get(shot.shot_id));
    if (states.some((state) => state === undefined)) throw new OperationalStateIntegrityError("SHOT_OPERATIONAL_STATE_UNAVAILABLE");
    const denied = states.find((state) => !state?.allowed_workflow_actions[action]);
    if (denied) {
      return {
        ok: false,
        error: {
          code: "SHOT_WORKFLOW_ACTION_NOT_ALLOWED",
          message: `Workflow action ${action} is not allowed while the SHOT is in ${denied.primary_stage}.`,
          field: "workflow_action"
        }
      };
    }
    return { ok: true, states: states as ShotOperationalState[] };
  } catch (error) {
    if (!(error instanceof OperationalStateIntegrityError)) throw error;
    return {
      ok: false,
      error: {
        code: "SHOT_WORKFLOW_GATE_INTEGRITY_VIOLATION",
        message: "SHOT operational data failed the workflow write gate.",
        field: "workflow_action"
      }
    };
  }
}
