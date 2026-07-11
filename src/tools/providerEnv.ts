import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { assertInsideWorkspace, paths } from "../paths.js";
import { isRealProviderName, M1_PROVIDER_CONFIGS, selectM1ProviderPort } from "./provider.js";

export const PROVIDER_ENV_KEYS = [
  "REAL_PROVIDER_ENABLED",
  "M1_REAL_PROVIDER",
  "M1_REAL_PROVIDER_EXECUTION_ALLOWED",
  "M1_REAL_PROVIDER_COST_ACK",
  "RUNWAYML_API_SECRET",
  "RUNWAYML_API_BASE_URL",
  "RUNWAYML_API_VERSION",
  "RUNNINGHUB_API_KEY",
  "RUNNINGHUB_API_BASE_URL",
  "RUNNINGHUB_MODEL_API_ENDPOINT",
  "PROVIDER_OUTPUT_DOWNLOAD_TIMEOUT_MS",
  "PROVIDER_TASK_POLL_INTERVAL_MS",
  "PROVIDER_TASK_POLL_TIMEOUT_MS"
] as const;

export type ProviderEnvKey = (typeof PROVIDER_ENV_KEYS)[number];

export interface ProviderEnvCheck {
  result: "PASS" | "FAIL";
  provider_name: string;
  real_provider_enabled: boolean;
  execution_allowed: boolean;
  cost_acknowledged: boolean;
  credential_env_name: string | null;
  credential_present: boolean;
  missing: string[];
  no_network_call: true;
}

export interface ProviderPreflight {
  result: "PASS" | "BLOCKED";
  provider_name: string;
  status: "MOCK_OR_DISABLED" | "READY_FOR_AUTHORIZED_REAL_CALL" | "BLOCKED_BY_GATE";
  selected_provider: string;
  missing: string[];
  error_code: string | null;
  credential_env_name: string | null;
  credential_present: boolean;
  /** Deprecated: kept for report shape compatibility; do not derive previews from secret values. */
  masked_credential_preview: string | null;
  network_call_attempted: false;
}

export interface SecretScanResult {
  result: "PASS" | "FAIL";
  git_tracked_files: "PASS" | "FAIL";
  reports: "PASS" | "FAIL";
  sqlite_or_runtime_state: "NOT_APPLICABLE";
  findings: Array<{ path: string; reason: string }>;
}

export interface ProviderEnvLoadResult {
  env_file_path: string;
  env_file_found: boolean;
  disabled: boolean;
  loaded_keys: ProviderEnvKey[];
  skipped_existing_keys: ProviderEnvKey[];
  ignored_keys: string[];
  parse_errors: string[];
  secret_values_exposed: false;
}

const SAFE_PLACEHOLDERS = new Set(["", "dummy", "DUMMY", "example", "EXAMPLE", "<REDACTED>", "<your key>", "<your_api_key>"]);
const SAFE_BEARER_PLACEHOLDERS = new Set(["test-token", "resource_metadata"]);
const PROVIDER_ENV_KEY_SET = new Set<string>(PROVIDER_ENV_KEYS);
const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".json",
  ".md",
  ".yaml",
  ".yml",
  ".txt",
  ".gitignore",
  ".example"
]);

function envTrue(env: NodeJS.ProcessEnv, key: string): boolean {
  return env[key] === "true";
}

export function maskSecret(value: string | undefined): string | null {
  if (!value) return null;
  if (value.length <= 8) return "****";
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}

export function providerCredentialEnv(providerName: string): string | null {
  return isRealProviderName(providerName) ? M1_PROVIDER_CONFIGS[providerName].credential_env_name : null;
}

function stripInlineComment(value: string): string {
  let output = "";
  let quoted: '"' | "'" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (!quoted && (char === '"' || char === "'")) {
      quoted = char;
      output += char;
      continue;
    }
    if (quoted && char === quoted) {
      quoted = null;
      output += char;
      continue;
    }
    if (!quoted && char === "#") break;
    output += char;
  }
  return output.trim();
}

function unquote(value: string): string {
  const trimmed = stripInlineComment(value);
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseEnvLine(line: string, lineNumber: number): { key?: string; value?: string; error?: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!match) return { error: `line_${lineNumber}_invalid_assignment` };

  return {
    key: match[1],
    value: unquote(match[2] ?? "")
  };
}

export function loadProviderEnvFile(input: {
  filePath: string;
  env?: NodeJS.ProcessEnv;
  override?: boolean;
  disabled?: boolean;
}): ProviderEnvLoadResult {
  const env = input.env ?? process.env;
  const candidate = resolve(input.filePath);
  const approvedRoots = [paths.workspaceRoot, paths.dataRoot].map((root) => resolve(root));
  const envFilePath = approvedRoots.some((root) => {
    const value = relative(root, candidate);
    return value === "" || (!value.startsWith("..") && !isAbsolute(value));
  }) ? candidate : assertInsideWorkspace(input.filePath);
  const result: ProviderEnvLoadResult = {
    env_file_path: envFilePath,
    env_file_found: existsSync(envFilePath),
    disabled: input.disabled === true,
    loaded_keys: [],
    skipped_existing_keys: [],
    ignored_keys: [],
    parse_errors: [],
    secret_values_exposed: false
  };

  if (result.disabled || !result.env_file_found) return result;

  const text = readFileSync(envFilePath, "utf8");
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const parsed = parseEnvLine(line, index + 1);
    if (!parsed) continue;
    if (parsed.error) {
      result.parse_errors.push(parsed.error);
      continue;
    }
    if (!parsed.key || !PROVIDER_ENV_KEY_SET.has(parsed.key)) {
      if (parsed.key) result.ignored_keys.push(parsed.key);
      continue;
    }

    const key = parsed.key as ProviderEnvKey;
    if (!input.override && env[key]) {
      result.skipped_existing_keys.push(key);
      continue;
    }

    env[key] = parsed.value ?? "";
    result.loaded_keys.push(key);
  }

  return result;
}

export function loadProviderEnvLocal(env: NodeJS.ProcessEnv = process.env): ProviderEnvLoadResult {
  return loadProviderEnvFile({
    filePath: join(paths.workspaceRoot, ".env.local"),
    env,
    override: false,
    disabled: env.PROVIDER_ENV_LOCAL_DISABLE === "true"
  });
}

export function checkProviderEnv(env: NodeJS.ProcessEnv = process.env): ProviderEnvCheck {
  const providerName = env.M1_REAL_PROVIDER || "mock";
  const credentialEnvName = providerCredentialEnv(providerName);
  const missing: string[] = [];
  const realProviderSelected = isRealProviderName(providerName);

  if (realProviderSelected) {
    if (!envTrue(env, "REAL_PROVIDER_ENABLED")) missing.push("REAL_PROVIDER_ENABLED");
    if (!envTrue(env, "M1_REAL_PROVIDER_EXECUTION_ALLOWED")) missing.push("M1_REAL_PROVIDER_EXECUTION_ALLOWED");
    if (!envTrue(env, "M1_REAL_PROVIDER_COST_ACK")) missing.push("M1_REAL_PROVIDER_COST_ACK");
    if (credentialEnvName && !env[credentialEnvName]) missing.push(credentialEnvName);
  } else if (providerName !== "mock") {
    missing.push("M1_REAL_PROVIDER");
  }

  return {
    result: providerName === "mock" || (realProviderSelected && missing.length === 0) ? "PASS" : "FAIL",
    provider_name: providerName,
    real_provider_enabled: envTrue(env, "REAL_PROVIDER_ENABLED"),
    execution_allowed: envTrue(env, "M1_REAL_PROVIDER_EXECUTION_ALLOWED"),
    cost_acknowledged: envTrue(env, "M1_REAL_PROVIDER_COST_ACK"),
    credential_env_name: credentialEnvName,
    credential_present: credentialEnvName ? Boolean(env[credentialEnvName]) : false,
    missing,
    no_network_call: true
  };
}

export function providerPreflight(env: NodeJS.ProcessEnv = process.env): ProviderPreflight {
  const providerName = env.M1_REAL_PROVIDER || "mock";
  if (!isRealProviderName(providerName)) {
    return {
      result: providerName === "mock" ? "PASS" : "BLOCKED",
      provider_name: providerName,
      status: providerName === "mock" ? "MOCK_OR_DISABLED" : "BLOCKED_BY_GATE",
      selected_provider: "mock",
      missing: providerName === "mock" ? [] : ["M1_REAL_PROVIDER"],
      error_code: providerName === "mock" ? null : "PROVIDER_DISABLED",
      credential_env_name: null,
      credential_present: false,
      masked_credential_preview: null,
      network_call_attempted: false
    };
  }

  const credentialEnvName = providerCredentialEnv(providerName);
  const selected = selectM1ProviderPort(
    {
      provider: "real",
      provider_name: providerName,
      cost_acknowledged: envTrue(env, "M1_REAL_PROVIDER_COST_ACK")
    },
    env
  );

  if (!selected.ok) {
    const check = checkProviderEnv(env);
    return {
      result: "BLOCKED",
      provider_name: providerName,
      status: "BLOCKED_BY_GATE",
      selected_provider: providerName,
      missing: check.missing,
      error_code: selected.error.code,
      credential_env_name: credentialEnvName,
      credential_present: credentialEnvName ? Boolean(env[credentialEnvName]) : false,
      masked_credential_preview: null,
      network_call_attempted: false
    };
  }

  return {
    result: "PASS",
    provider_name: providerName,
    status: "READY_FOR_AUTHORIZED_REAL_CALL",
    selected_provider: selected.selected.provider_name,
    missing: [],
    error_code: null,
    credential_env_name: credentialEnvName,
    credential_present: credentialEnvName ? Boolean(env[credentialEnvName]) : false,
    masked_credential_preview: null,
    network_call_attempted: false
  };
}

function fileLooksText(path: string): boolean {
  const lower = path.toLowerCase();
  for (const extension of TEXT_EXTENSIONS) {
    if (lower.endsWith(extension)) return true;
  }
  return false;
}

function isSecretAdjacentPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  if (normalized === ".env.example") return false;
  return (
    normalized === ".env" ||
    normalized.startsWith(".env.") ||
    normalized.includes("/credentials/") ||
    normalized.startsWith("credentials/") ||
    normalized.includes("/secrets/") ||
    normalized.startsWith("secrets/") ||
    normalized.includes("/state-private/") ||
    normalized.startsWith("state-private/")
  );
}

function valueAfterAssignment(line: string, key: string): string | null {
  const match = line.match(new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*([^\\s"'#]+)`));
  return match?.[1] ?? null;
}

export function secretFindingForText(text: string): string | null {
  const keys = ["RUNWAYML_API_SECRET", "RUNNINGHUB_API_KEY"];
  for (const line of text.split(/\r?\n/)) {
    for (const key of keys) {
      const value = valueAfterAssignment(line, key);
      if (
        value &&
        !SAFE_PLACEHOLDERS.has(value) &&
        !value.includes("<") &&
        !value.startsWith("$") &&
        !value.includes("{") &&
        !value.toLowerCase().includes("dummy") &&
        !value.toLowerCase().includes("fake")
      ) {
        return `${key} has a non-placeholder value`;
      }
    }
  }

  const jsonSecretMatch = text.match(/"(RUNWAYML_API_SECRET|RUNNINGHUB_API_KEY)"\s*:\s*"([^"]+)"/);
  if (jsonSecretMatch) {
    const value = jsonSecretMatch[2];
    if (
      value &&
      !SAFE_PLACEHOLDERS.has(value) &&
      !value.includes("<") &&
      !value.startsWith("$") &&
      !value.includes("{") &&
      !value.toLowerCase().includes("dummy") &&
      !value.toLowerCase().includes("fake")
    ) {
      return `${jsonSecretMatch[1]} has a non-placeholder JSON value`;
    }
  }

  const bearerMatch = text.match(/\bBearer\s+([A-Za-z0-9._~+/=-]{8,})\b/);
  if (bearerMatch) {
    const value = bearerMatch[1];
    if (!SAFE_BEARER_PLACEHOLDERS.has(value) && !value.includes("<") && !value.toLowerCase().includes("dummy") && !value.toLowerCase().includes("fake")) {
      return "unredacted bearer token";
    }
  }

  const tokenMatch = text.match(/\b(sk-[A-Za-z0-9_-]{16,}|rk_[A-Za-z0-9_-]{16,})\b/);
  if (tokenMatch && !tokenMatch[0].toLowerCase().includes("dummy")) return "token-like secret pattern";

  return null;
}

function gitTrackedFiles(): string[] {
  const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: paths.workspaceRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

function scanPaths(pathsToScan: string[]): Array<{ path: string; reason: string }> {
  const findings: Array<{ path: string; reason: string }> = [];
  for (const relativePath of pathsToScan) {
    if (isSecretAdjacentPath(relativePath)) {
      findings.push({ path: relativePath, reason: "secret-adjacent path is tracked" });
      continue;
    }
    const absolutePath = join(paths.workspaceRoot, relativePath);
    if (!existsSync(absolutePath)) continue;
    const stats = statSync(absolutePath);
    if (!stats.isFile() || stats.size > 1024 * 1024 || !fileLooksText(relativePath)) continue;
    const reason = secretFindingForText(readFileSync(absolutePath, "utf8"));
    if (reason) findings.push({ path: relativePath, reason });
  }
  return findings;
}

function reportFiles(): string[] {
  if (!existsSync(paths.reportsRoot)) return [];
  return readdirSync(paths.reportsRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && (entry.name.endsWith(".json") || entry.name.endsWith(".yaml") || entry.name.endsWith(".yml")))
    .map((entry) => relative(paths.workspaceRoot, join(paths.reportsRoot, entry.name)).replace(/\\/g, "/"));
}

export function runSecretScan(): SecretScanResult {
  const trackedFindings = scanPaths(gitTrackedFiles());
  const reportFindings = scanPaths(reportFiles());
  const findings = [...trackedFindings, ...reportFindings];
  const gitTrackedStatus = trackedFindings.length === 0 ? "PASS" : "FAIL";
  const reportsStatus = reportFindings.length === 0 ? "PASS" : "FAIL";

  return {
    result: gitTrackedStatus === "PASS" && reportsStatus === "PASS" ? "PASS" : "FAIL",
    git_tracked_files: gitTrackedStatus,
    reports: reportsStatus,
    sqlite_or_runtime_state: "NOT_APPLICABLE",
    findings
  };
}
