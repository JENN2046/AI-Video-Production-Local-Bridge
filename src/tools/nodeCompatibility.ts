type NodeVersion = readonly [major: number, minor: number, patch: number];

const STABLE_NODE_VERSION = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseStableNodeVersion(value: unknown): NodeVersion | null {
  if (typeof value !== "string") return null;
  const match = STABLE_NODE_VERSION.exec(value.trim());
  if (!match) return null;
  const version = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return version.every((part) => Number.isSafeInteger(part)) ? version : null;
}

function parseNodeMinimum(value: unknown): NodeVersion | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return parseStableNodeVersion(trimmed.startsWith(">=") ? trimmed.slice(2) : trimmed);
}

/**
 * Returns the normalized floor only for the package's supported engine shape.
 * Other ranges are deliberately rejected instead of being approximated.
 */
export function nodeEngineMinimumVersion(engineRange: unknown): string | null {
  if (typeof engineRange !== "string") return null;
  const trimmed = engineRange.trim();
  if (!trimmed.startsWith(">=")) return null;
  const parsed = parseStableNodeVersion(trimmed.slice(2));
  return parsed ? parsed.join(".") : null;
}

export function nodeVersionMeetsMinimum(detected: unknown, minimum: unknown): boolean {
  const actual = parseStableNodeVersion(detected);
  const required = parseNodeMinimum(minimum);
  if (!actual || !required) return false;
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== required[index]) return actual[index] > required[index];
  }
  return true;
}
