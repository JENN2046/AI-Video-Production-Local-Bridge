import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface M0Paths {
  workspaceRoot: string;
  dataRoot: string;
  importsRoot: string;
  sqlitePath: string;
  mediaRoot: string;
  imageArtifactsRoot: string;
  videoArtifactsRoot: string;
  finalArtifactsRoot: string;
  mediaActivationRoot: string;
  mediaActivationStagingRoot: string;
  mediaActivationPendingRoot: string;
  mediaActivationQuarantineRoot: string;
  mediaActivationJournalRoot: string;
  reportsRoot: string;
}

export function getM0Paths(workspaceRoot = process.cwd()): M0Paths {
  const root = resolve(workspaceRoot);
  const configuredDataRoot = process.env.AI_VIDEO_WORKSPACE_DATA_ROOT?.trim();
  const dataRoot = configuredDataRoot ? resolve(root, configuredDataRoot) : join(root, "data");
  const mediaRoot = join(dataRoot, "media");
  const artifactsRoot = join(mediaRoot, "artifacts");
  const configuredSqlitePath = process.env.AI_VIDEO_WORKSPACE_DB_PATH?.trim();

  return {
    workspaceRoot: root,
    dataRoot,
    importsRoot: join(dataRoot, "imports"),
    sqlitePath: configuredSqlitePath
      ? resolve(root, configuredSqlitePath)
      : join(dataRoot, "app.sqlite"),
    mediaRoot,
    imageArtifactsRoot: join(artifactsRoot, "images"),
    videoArtifactsRoot: join(artifactsRoot, "videos"),
    finalArtifactsRoot: join(artifactsRoot, "final"),
    mediaActivationRoot: join(mediaRoot, ".activation"),
    mediaActivationStagingRoot: join(mediaRoot, ".activation", "staging"),
    mediaActivationPendingRoot: join(mediaRoot, ".activation", "pending"),
    mediaActivationQuarantineRoot: join(mediaRoot, ".activation", "quarantine"),
    mediaActivationJournalRoot: join(mediaRoot, ".activation", "journal"),
    reportsRoot: join(dataRoot, "reports")
  };
}

export const paths = getM0Paths();

export function assertInsideWorkspace(targetPath: string, workspaceRoot = paths.workspaceRoot): string {
  const root = resolve(workspaceRoot);
  const target = resolve(targetPath);
  const rel = relative(root, target);

  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return target;
  }

  throw new Error(`Path is outside workspace: ${target}`);
}

export function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

export function ensureM0Directories(m0Paths = paths): void {
  ensureDir(m0Paths.dataRoot);
  ensureDir(m0Paths.importsRoot);
  ensureDir(m0Paths.imageArtifactsRoot);
  ensureDir(m0Paths.videoArtifactsRoot);
  ensureDir(m0Paths.finalArtifactsRoot);
  ensureDir(m0Paths.mediaActivationStagingRoot);
  ensureDir(m0Paths.mediaActivationPendingRoot);
  ensureDir(m0Paths.mediaActivationQuarantineRoot);
  ensureDir(m0Paths.mediaActivationJournalRoot);
  ensureDir(m0Paths.reportsRoot);
}
