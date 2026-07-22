import { loadDirectorGrantAuthorization } from "./grantRuntime.js";
import { directorMinorToProviderAmount } from "./currency.js";
import type { M0Database } from "../storage/sqlite.js";
import {
  confirmWorkbenchGeneration,
  discardDirectorPreparedGenerationIntent,
  preflightWorkbenchGeneration,
  startWorkbenchGeneration,
  type DirectorAutomationPreflightAuthorization,
  type WorkbenchGenerationDependencies,
  type WorkbenchGenerationIntent
} from "../tools/workbenchGeneration.js";
import type { WorkbenchV2Result } from "../tools/workbenchV2.js";

export interface DirectorBoundedExecutionInput extends DirectorAutomationPreflightAuthorization {
  account_label: "personal" | "team";
  /** Test seam only; normal local callers always start the bounded worker. */
  start_worker?: boolean;
}

export interface DirectorBoundedExecutionResult {
  intent: WorkbenchGenerationIntent;
  run_id: string;
  job_id: string;
  grant_id: string;
}

/**
 * The only path from a compiled Director Grant to a queued real generation.
 * It never receives a Provider credential. The existing Workbench preflight
 * still obtains the official price/balance evidence and the normal generation
 * confirmation code still creates the immutable run/job records.
 */
export async function startDirectorBoundedGeneration(
  input: DirectorBoundedExecutionInput,
  db: M0Database,
  dependencies: WorkbenchGenerationDependencies = {}
): Promise<WorkbenchV2Result<DirectorBoundedExecutionResult>> {
  const env = dependencies.env ?? process.env;
  if (env.REAL_PROVIDER_ENABLED !== "true") {
    return { ok: false, error: { code: "DIRECTOR_AUTOMATION_PROVIDER_DISABLED", message: "Director automation remains disabled until real Provider execution is explicitly enabled." } };
  }
  let authorization: ReturnType<typeof loadDirectorGrantAuthorization>;
  try {
    authorization = loadDirectorGrantAuthorization(db, input, "generation.submit", dependencies.now?.() ?? new Date());
  } catch (caught) {
    const code = caught instanceof Error && "code" in caught ? String(caught.code) : "DIRECTOR_AUTOMATION_AUTHORIZATION_FAILED";
    return { ok: false, error: { code, message: "Director Automation Grant cannot authorize generation." } };
  }
  const budgetLimitValue = directorMinorToProviderAmount(authorization.grant.max_per_run_minor, authorization.grant.currency);
  if (budgetLimitValue === null) {
    return { ok: false, error: { code: "DIRECTOR_AUTOMATION_CURRENCY_UNSUPPORTED", message: "Director Automation Grant currency has no approved minor-unit conversion." } };
  }
  const preflight = await preflightWorkbenchGeneration({
    project_id: authorization.grant.project_id,
    shot_id: authorization.shot.shot_id,
    account_label: input.account_label,
    budget_limit_value: budgetLimitValue,
    director_automation: input
  }, db, dependencies);
  if (!preflight.ok) return preflight;
  const confirmed = confirmWorkbenchGeneration({
    intent_id: preflight.data.intent.intent_id,
    budget_limit_value: budgetLimitValue,
    cost_confirmed: false,
    human_confirmation: false,
    director_automation: input
  }, db, dependencies);
  if (!confirmed.ok) {
    let discarded: ReturnType<typeof discardDirectorPreparedGenerationIntent>;
    try {
      discarded = discardDirectorPreparedGenerationIntent({
        intent_id: preflight.data.intent.intent_id,
        director_automation: input
      }, db);
    } catch {
      return { ok: false, error: { code: "DIRECTOR_AUTOMATION_PREPARED_INTENT_CLEANUP_FAILED", message: "Director preflight confirmation failed and its staging record could not be safely discarded." } };
    }
    if (!discarded.ok) {
      return { ok: false, error: { code: "DIRECTOR_AUTOMATION_PREPARED_INTENT_CLEANUP_FAILED", message: "Director preflight confirmation failed and its staging record could not be safely discarded." } };
    }
    return confirmed;
  }
  if (input.start_worker !== false) {
    startWorkbenchGeneration(confirmed.data.intent.intent_id, { allow_submit: true, dependencies });
  }
  return {
    ok: true,
    data: {
      intent: confirmed.data.intent,
      run_id: confirmed.data.run_id,
      job_id: confirmed.data.job_id,
      grant_id: input.grant_id
    }
  };
}
