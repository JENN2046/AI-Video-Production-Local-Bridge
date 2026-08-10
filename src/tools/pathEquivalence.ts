import { resolve } from "node:path";

export function resolvedPathsEquivalent(
  first: string,
  second: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const left = resolve(first);
  const right = resolve(second);
  return platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
