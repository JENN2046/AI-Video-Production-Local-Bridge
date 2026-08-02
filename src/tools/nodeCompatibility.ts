export function nodeVersionMeetsMinimum(detected: string, minimum: string): boolean {
  const parse = (value: string): [number, number, number] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const actual = parse(detected);
  const required = parse(minimum);
  if (!actual || !required) return false;
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== required[index]) return actual[index] > required[index];
  }
  return true;
}
