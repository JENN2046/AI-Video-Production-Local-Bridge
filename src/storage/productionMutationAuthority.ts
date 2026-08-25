import { DatabaseSync } from "node:sqlite";

export type WorkbenchProductionMutationKind =
  | "project_content"
  | "project_title"
  | "shot"
  | "storyboard_package"
  | "artifact"
  | "regeneration_request"
  | "readiness_refresh"
  | "assembly_queue"
  | "assembly_start"
  | "assembly_failure"
  | "assembly_interruption"
  | "assembly_finalization"
  | "export_queue"
  | "export_start"
  | "export_failure"
  | "export_interruption"
  | "export_finalization";

export interface WorkbenchProductionMutationCapability {
  kind: WorkbenchProductionMutationKind;
  project_id: string;
  object_id: string;
}

const capabilities = new WeakMap<DatabaseSync, WorkbenchProductionMutationCapability[]>();
const installed = new WeakSet<DatabaseSync>();
const AUTHORITY_CONNECTION = Symbol.for("ai-video-production.workbench-authority-connection");

interface DatabaseSyncWithFunctions extends DatabaseSync {
  function(name: string, callback: (...args: unknown[]) => unknown): void;
  [AUTHORITY_CONNECTION]?: DatabaseSync;
}

function authorityConnection(db: DatabaseSync): DatabaseSync {
  return (db as DatabaseSyncWithFunctions)[AUTHORITY_CONNECTION] ?? db;
}

export function installWorkbenchProductionMutationAuthority(db: DatabaseSync): void {
  const connection = authorityConnection(db);
  if (installed.has(connection)) return;
  const stack: WorkbenchProductionMutationCapability[] = [];
  capabilities.set(connection, stack);
  Object.defineProperty(connection, AUTHORITY_CONNECTION, {
    value: connection,
    enumerable: false,
    configurable: false,
    writable: false
  });
  (connection as DatabaseSyncWithFunctions).function("workbench_production_mutation_authorized", (kind: unknown, projectId: unknown, objectId: unknown) => {
    const active = stack.at(-1);
    return active
      && active.kind === String(kind ?? "")
      && active.project_id === String(projectId ?? "")
      && active.object_id === String(objectId ?? "")
      ? 1
      : 0;
  });
  installed.add(connection);
}

export function withWorkbenchProductionMutationAuthority<T>(
  db: DatabaseSync,
  capability: WorkbenchProductionMutationCapability,
  action: () => T extends PromiseLike<unknown> ? never : T
): T {
  installWorkbenchProductionMutationAuthority(db);
  const stack = capabilities.get(authorityConnection(db));
  if (!stack) throw new Error("WORKBENCH_PRODUCTION_AUTHORITY_NOT_INSTALLED");
  stack.push(capability);
  try {
    const result = action() as T;
    if (result && typeof result === "object" && "then" in result
      && typeof (result as { then?: unknown }).then === "function") {
      throw new Error("WORKBENCH_PRODUCTION_AUTHORITY_ASYNC_FORBIDDEN");
    }
    return result;
  } finally {
    const released = stack.pop();
    if (released !== capability) {
      stack.length = 0;
      throw new Error("WORKBENCH_PRODUCTION_AUTHORITY_STACK_CORRUPT");
    }
  }
}
