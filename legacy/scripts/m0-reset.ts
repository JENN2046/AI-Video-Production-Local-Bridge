import { existsSync, rmSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { ensureM0Directories, paths } from "../src/index.js";

function assertInsideDataRoot(targetPath: string): string {
  const dataRoot = resolve(paths.dataRoot);
  const target = resolve(targetPath);
  const rel = relative(dataRoot, target);

  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return target;
  }

  throw new Error(`Refusing to reset outside data root: ${target}`);
}

const resetTargets = [
  paths.sqlitePath,
  `${paths.sqlitePath}-shm`,
  `${paths.sqlitePath}-wal`,
  paths.mediaRoot,
  paths.reportsRoot
];

for (const target of resetTargets) {
  const safeTarget = assertInsideDataRoot(target);
  if (existsSync(safeTarget)) {
    rmSync(safeTarget, { recursive: true, force: true });
  }
}

ensureM0Directories();

console.log(JSON.stringify({ result: "PASS", reset_root: paths.dataRoot }, null, 2));
