import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { WebGptV4Profile } from "./toolCatalog.js";
import type { WebGptV4ToolName } from "./toolCatalog.js";
import { WebGptV4Error } from "./types.js";

export type WebGptTelemetryMode = "off" | "jsonl";

export interface WebGptTelemetryEvent {
  timestamp: string;
  request_id: string;
  profile: WebGptV4Profile;
  tool: WebGptV4ToolName;
  duration_ms: number;
  outcome: "success" | "error";
  error_code?: string;
  retryable?: boolean;
  result_bytes: number;
  item_count?: number;
  detail_level?: "compact" | "full";
}

export interface WebGptTelemetrySink {
  readonly mode: WebGptTelemetryMode;
  record(event: WebGptTelemetryEvent): void;
  markUnhealthy(): void;
  probe(): boolean;
  isHealthy(): boolean;
}

export function parseWebGptTelemetryMode(value?: string): WebGptTelemetryMode {
  const normalized = value?.trim() || "off";
  if (normalized === "off" || normalized === "jsonl") return normalized;
  throw new WebGptV4Error("INVALID_WEBGPT_TELEMETRY_MODE", "WEBGPT_V4_TELEMETRY_MODE must be off or jsonl.", "WEBGPT_V4_TELEMETRY_MODE");
}

export function parseWebGptWidgetDomain(value?: string): string | null {
  const normalized = value?.trim() ?? "";
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error("invalid");
    return parsed.origin;
  } catch {
    throw new WebGptV4Error("INVALID_WEBGPT_WIDGET_DOMAIN", "WEBGPT_V4_WIDGET_DOMAIN must be an HTTPS origin.", "WEBGPT_V4_WIDGET_DOMAIN");
  }
}

const TELEMETRY_FILE = /^webgpt-v4-(\d{4}-\d{2}-\d{2})\.jsonl$/;

function safeDirectory(root: string): string {
  const target = resolve(root);
  const missing: string[] = [];
  let current = target;
  while (!existsSync(current)) {
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) throw new Error("UNSAFE_TELEMETRY_DIRECTORY");
    current = parent;
  }
  while (true) {
    const info = lstatSync(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("UNSAFE_TELEMETRY_DIRECTORY");
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const directory of missing.reverse()) {
    mkdirSync(directory);
    const info = lstatSync(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("UNSAFE_TELEMETRY_DIRECTORY");
  }
  return target;
}

export interface JsonlTelemetryOptions {
  now?: () => Date;
  retention_days?: number;
  maximum_bytes?: number;
  probe_interval_ms?: number;
}

export class JsonlWebGptTelemetrySink implements WebGptTelemetrySink {
  readonly mode = "jsonl" as const;
  private healthy = true;
  private lastProbeAt = 0;
  private readonly now: () => Date;
  private readonly retentionMs: number;
  private readonly maximumBytes: number;
  private readonly probeIntervalMs: number;

  constructor(private readonly root: string, options: JsonlTelemetryOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.retentionMs = (options.retention_days ?? 7) * 24 * 60 * 60 * 1000;
    this.maximumBytes = options.maximum_bytes ?? 20 * 1024 * 1024;
    this.probeIntervalMs = options.probe_interval_ms ?? 30_000;
  }

  private cleanup(directory: string): void {
    const current = this.now().getTime();
    const candidates: Array<{ path: string; modified: number; bytes: number }> = [];
    for (const name of readdirSync(directory)) {
      if (!TELEMETRY_FILE.test(name)) continue;
      const path = join(directory, name);
      const info = lstatSync(path);
      if (info.isSymbolicLink() || !info.isFile()) continue;
      if (current - info.mtimeMs > this.retentionMs) {
        rmSync(path);
        continue;
      }
      candidates.push({ path, modified: info.mtimeMs, bytes: info.size });
    }
    let total = candidates.reduce((sum, item) => sum + item.bytes, 0);
    for (const item of candidates.sort((left, right) => left.modified - right.modified)) {
      if (total <= this.maximumBytes) break;
      rmSync(item.path);
      total -= item.bytes;
    }
  }

  record(event: WebGptTelemetryEvent): void {
    try {
      const directory = safeDirectory(this.root);
      const name = `webgpt-v4-${this.now().toISOString().slice(0, 10)}.jsonl`;
      const path = join(directory, name);
      if (existsSync(path)) {
        const info = lstatSync(path);
        if (info.isSymbolicLink() || !info.isFile()) throw new Error("UNSAFE_TELEMETRY_FILE");
      }
      appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" });
      this.cleanup(directory);
    } catch {
      this.markUnhealthy();
    }
  }

  markUnhealthy(): void {
    this.healthy = false;
    this.lastProbeAt = 0;
  }

  probe(): boolean {
    const current = this.now().getTime();
    if (this.lastProbeAt > 0 && current - this.lastProbeAt < this.probeIntervalMs) return this.healthy;
    this.lastProbeAt = current;
    let probePath = "";
    try {
      const directory = safeDirectory(this.root);
      probePath = join(directory, ".webgpt-telemetry-probe");
      if (existsSync(probePath) && lstatSync(probePath).isSymbolicLink()) throw new Error("UNSAFE_TELEMETRY_PROBE");
      writeFileSync(probePath, "", { encoding: "utf8", flag: "wx" });
      appendFileSync(probePath, "probe", "utf8");
      if (statSync(probePath).size !== 5) throw new Error("TELEMETRY_PROBE_FAILED");
      rmSync(probePath);
      this.cleanup(directory);
      this.healthy = true;
    } catch {
      if (probePath && existsSync(probePath) && !lstatSync(probePath).isSymbolicLink()) {
        try { rmSync(probePath); } catch { /* readiness remains false */ }
      }
      this.healthy = false;
    }
    return this.healthy;
  }

  isHealthy(): boolean {
    return this.healthy;
  }
}

class OffTelemetrySink implements WebGptTelemetrySink {
  readonly mode = "off" as const;
  record(): void { /* telemetry is disabled */ }
  markUnhealthy(): void { /* telemetry is disabled */ }
  probe(): boolean { return true; }
  isHealthy(): boolean { return true; }
}

export function createWebGptTelemetrySink(mode: WebGptTelemetryMode, root: string, options?: JsonlTelemetryOptions): WebGptTelemetrySink {
  return mode === "jsonl" ? new JsonlWebGptTelemetrySink(root, options) : new OffTelemetrySink();
}
