import { rmSync } from "node:fs";

for (const path of ["dist/src", "dist/scripts", "dist/tests"]) {
  rmSync(path, { recursive: true, force: true });
}
