import { executeWebGptReadOnlyTool, WEBGPT_READ_ONLY_TOOLS, type WebGptReadOnlyToolName } from "../src/index.js";

function argument(args: string[], name: string): string {
  const index = args.indexOf(name);
  return index === -1 ? "" : args[index + 1] ?? "";
}

function input(args: string[]): Record<string, unknown> {
  const raw = argument(args, "--input-json");
  if (!raw) return {};
  if (Buffer.byteLength(raw, "utf8") > 100 * 1024) throw new Error("--input-json exceeds 100 KiB.");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--input-json must contain one JSON object.");
  return parsed as Record<string, unknown>;
}

export function runWebGptLegacyOffline(label: string, args = process.argv.slice(2)): void {
  const tool = argument(args, "--tool") as WebGptReadOnlyToolName;
  if (!tool) {
    console.log(JSON.stringify({
      ok: true,
      mode: "LEGACY_OFFLINE_READ_ONLY",
      legacy_entry: label,
      network_listener_started: false,
      writes_allowed: false,
      replacement: "webgpt:v4:serve",
      usage: "--tool <read-only-tool> [--input-json <json>]",
      read_only_tools: WEBGPT_READ_ONLY_TOOLS
    }, null, 2));
    return;
  }
  if (!WEBGPT_READ_ONLY_TOOLS.some((definition) => definition.name === tool)) throw new Error(`Legacy offline compatibility does not allow tool: ${tool}`);
  console.log(JSON.stringify(executeWebGptReadOnlyTool(tool, input(args)), null, 2));
}
