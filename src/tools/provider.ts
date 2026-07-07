export type ProviderName = "mock" | "real";
export type RealProviderName = "runway" | "runninghub";
export type ProviderPortName = "mock" | RealProviderName;
export type ProviderKind = "offline" | "real";
export type ProviderErrorCode =
  | "PROVIDER_NOT_FOUND"
  | "PROVIDER_UNSUPPORTED"
  | "PROVIDER_DISABLED"
  | "PROVIDER_CREDENTIAL_MISSING"
  | "PROVIDER_AUTH_FAILED"
  | "PROVIDER_INSUFFICIENT_CREDITS"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_REQUEST_FAILED"
  | "PROVIDER_OUTPUT_PENDING"
  | "PROVIDER_OUTPUT_MISSING"
  | "PROVIDER_OUTPUT_URI_BLOCKED"
  | "PROVIDER_OUTPUT_TOO_LARGE"
  | "PROVIDER_OUTPUT_INVALID_CONTENT_TYPE"
  | "PROVIDER_OUTPUT_DOWNLOAD_FAILED"
  | "PROVIDER_OUTPUT_INVALID"
  | "PROVIDER_UNSUPPORTED_INPUT"
  | "PROVIDER_CONTENT_REJECTED"
  | "PROVIDER_TRANSIENT_FAILURE"
  | "PROVIDER_COST_CONFIRMATION_REQUIRED"
  | "PROVIDER_SELECTION_MISMATCH"
  | "HARD_GATE_CONFIRMATION_REQUIRED";

export interface ProviderConfig {
  provider_name: ProviderPortName;
  provider_display_name: string;
  type: ProviderKind;
  model_name: string;
  generation_mode: "image_to_video";
  default: boolean;
  selectable: boolean;
  primary: boolean;
  required_for_m1_pass: boolean;
  credential_env_name: string | null;
  status: "m0_mock_provider" | "primary_real_provider" | "secondary_selectable_provider_port";
}

export interface ProviderExecutionRequest {
  provider: ProviderName;
  provider_name?: string;
  model_name?: string;
  cost_acknowledged?: boolean;
}

export interface SanitizedProviderErrorSummary {
  http_status: number | null;
  provider_error_code: string | null;
  provider_error_message: string | null;
  provider_error_field: string | null;
  retryable: boolean;
}

export interface SelectedProviderPort {
  config: ProviderConfig;
  provider: ProviderName;
  provider_name: ProviderPortName;
  credential?: string;
}

export interface ProviderToolError {
  code: ProviderErrorCode | string;
  message: string;
  retryable?: boolean;
  sanitized_provider_error_summary?: SanitizedProviderErrorSummary;
}

export type ProviderSelectionResult =
  | { ok: true; selected: SelectedProviderPort }
  | { ok: false; error: ProviderToolError };

export const M1_PROVIDER_CONFIGS: Record<ProviderPortName, ProviderConfig> = {
  mock: {
    provider_name: "mock",
    provider_display_name: "Mock Provider",
    type: "offline",
    model_name: "mock_fixture",
    generation_mode: "image_to_video",
    default: true,
    selectable: true,
    primary: false,
    required_for_m1_pass: false,
    credential_env_name: null,
    status: "m0_mock_provider"
  },
  runway: {
    provider_name: "runway",
    provider_display_name: "Runway API",
    type: "real",
    model_name: "gen4.5",
    generation_mode: "image_to_video",
    default: false,
    selectable: true,
    primary: true,
    required_for_m1_pass: true,
    credential_env_name: "RUNWAYML_API_SECRET",
    status: "primary_real_provider"
  },
  runninghub: {
    provider_name: "runninghub",
    provider_display_name: "RunningHub",
    type: "real",
    model_name: "rhart-video-g/image-to-video",
    generation_mode: "image_to_video",
    default: false,
    selectable: true,
    primary: false,
    required_for_m1_pass: false,
    credential_env_name: "RUNNINGHUB_API_KEY",
    status: "secondary_selectable_provider_port"
  }
};

export function listProviderConfigs(): ProviderConfig[] {
  return Object.values(M1_PROVIDER_CONFIGS);
}

export function isRealProviderName(value: string | undefined): value is RealProviderName {
  return value === "runway" || value === "runninghub";
}

export function selectM0Provider(provider: ProviderName = "mock") {
  if (provider === "real") {
    return {
      ok: false as const,
      error: {
        code: "PROVIDER_DISABLED",
        message: "Real providers are disabled in M0."
      }
    };
  }

  return {
    ok: true as const,
    provider: "mock" as const
  };
}

function envTrue(env: NodeJS.ProcessEnv, name: string): boolean {
  return env[name] === "true";
}

export function providerError(
  code: ProviderErrorCode | string,
  message: string,
  retryable = false,
  sanitizedProviderErrorSummary?: SanitizedProviderErrorSummary
): ProviderToolError {
  return {
    code,
    message,
    retryable,
    ...(sanitizedProviderErrorSummary ? { sanitized_provider_error_summary: sanitizedProviderErrorSummary } : {})
  };
}

export function selectM1ProviderPort(
  request: ProviderExecutionRequest | undefined,
  env: NodeJS.ProcessEnv = process.env
): ProviderSelectionResult {
  if (!request || request.provider === "mock") {
    return {
      ok: true,
      selected: {
        config: M1_PROVIDER_CONFIGS.mock,
        provider: "mock",
        provider_name: "mock"
      }
    };
  }

  if (request.provider !== "real") {
    return { ok: false, error: providerError("PROVIDER_UNSUPPORTED", `Unsupported provider mode: ${String(request.provider)}`) };
  }

  const envProvider = env.M1_REAL_PROVIDER;
  if (!isRealProviderName(envProvider)) {
    return { ok: false, error: providerError("PROVIDER_DISABLED", "Real provider is disabled until M1_REAL_PROVIDER is runway or runninghub.") };
  }

  if (request.provider_name && request.provider_name !== envProvider) {
    return {
      ok: false,
      error: providerError(
        "PROVIDER_SELECTION_MISMATCH",
        `provider_execution.provider_name (${request.provider_name}) must match M1_REAL_PROVIDER (${envProvider}).`
      )
    };
  }

  const config = M1_PROVIDER_CONFIGS[envProvider];
  if (!config?.selectable) {
    return { ok: false, error: providerError("PROVIDER_NOT_FOUND", `Provider is not registered: ${envProvider}`) };
  }

  if (!envTrue(env, "REAL_PROVIDER_ENABLED") || !envTrue(env, "M1_REAL_PROVIDER_EXECUTION_ALLOWED")) {
    return { ok: false, error: providerError("PROVIDER_DISABLED", "Real provider execution gates are not enabled.") };
  }

  if (!envTrue(env, "M1_REAL_PROVIDER_COST_ACK") || request.cost_acknowledged !== true) {
    return { ok: false, error: providerError("PROVIDER_COST_CONFIRMATION_REQUIRED", "Real provider execution requires cost acknowledgement.") };
  }

  const credentialEnv = config.credential_env_name;
  const credential = credentialEnv ? env[credentialEnv] : "";
  if (!credential) {
    return {
      ok: false,
      error: providerError("PROVIDER_CREDENTIAL_MISSING", `Missing provider credential env: ${credentialEnv ?? "none"}.`)
    };
  }

  return {
    ok: true,
    selected: {
      config,
      provider: "real",
      provider_name: config.provider_name,
      credential
    }
  };
}

export function realCommandReadiness(env: NodeJS.ProcessEnv = process.env):
  | { ok: true; provider_name: RealProviderName; credential_env_name: string }
  | { ok: false; status: "SKIPPED_MISSING_ENV_GATE" | "SKIPPED_MISSING_CREDENTIAL"; provider_name: string; missing: string[] } {
  const providerName = env.M1_REAL_PROVIDER ?? "";
  const missingGates: string[] = [];

  if (!isRealProviderName(providerName)) missingGates.push("M1_REAL_PROVIDER");
  if (!envTrue(env, "REAL_PROVIDER_ENABLED")) missingGates.push("REAL_PROVIDER_ENABLED");
  if (!envTrue(env, "M1_REAL_PROVIDER_EXECUTION_ALLOWED")) missingGates.push("M1_REAL_PROVIDER_EXECUTION_ALLOWED");
  if (!envTrue(env, "M1_REAL_PROVIDER_COST_ACK")) missingGates.push("M1_REAL_PROVIDER_COST_ACK");

  if (missingGates.length > 0 || !isRealProviderName(providerName)) {
    return { ok: false, status: "SKIPPED_MISSING_ENV_GATE", provider_name: providerName || "unset", missing: missingGates };
  }

  const credentialEnv = M1_PROVIDER_CONFIGS[providerName].credential_env_name;
  if (!credentialEnv || !env[credentialEnv]) {
    return { ok: false, status: "SKIPPED_MISSING_CREDENTIAL", provider_name: providerName, missing: [credentialEnv ?? "credential_env"] };
  }

  return { ok: true, provider_name: providerName, credential_env_name: credentialEnv };
}

export function redactSecrets(value: string, secrets: string[] = []): string {
  let output = value;
  for (const secret of secrets) {
    if (secret) output = output.split(secret).join("<REDACTED>");
  }

  return output
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer <REDACTED>")
    .replace(/RUNWAYML_API_SECRET=[^\s"']+/g, "RUNWAYML_API_SECRET=<REDACTED>")
    .replace(/RUNNINGHUB_API_KEY=[^\s"']+/g, "RUNNINGHUB_API_KEY=<REDACTED>")
    .replace(/M1_TEST_SECRET_DO_NOT_LOG_123/g, "<REDACTED_TEST_SECRET>");
}
