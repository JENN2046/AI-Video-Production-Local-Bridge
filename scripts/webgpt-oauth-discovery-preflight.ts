import { loadWebGptV4AuthConfig, type WebGptV4AuthConfig } from "../src/webgpt-v4/auth.js";
import { probeWebGptOAuthDiscovery } from "../src/webgpt-v4/oauthDiscovery.js";
import { parseWebGptV4Profile } from "../src/webgpt-v4/toolCatalog.js";
import { WebGptV4Error } from "../src/webgpt-v4/types.js";
import { createBenchmarkFakeIpRecoveringResolver } from "../src/net/pinnedHttpsTransport.js";

let profile: "readonly" | "full";
try {
  profile = parseWebGptV4Profile(process.env.WEBGPT_V4_PROFILE);
} catch {
  console.log(JSON.stringify({ ok: false, code: "INVALID_WEBGPT_PROFILE" }, null, 2));
  process.exit(1);
}

let auth: WebGptV4AuthConfig | null;
try {
  auth = loadWebGptV4AuthConfig(profile);
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    code: error instanceof WebGptV4Error ? error.code : "INVALID_WEBGPT_AUTH_CONFIG"
  }, null, 2));
  process.exit(1);
}
if (profile !== "readonly" || auth?.provider !== "federated") {
  console.log(JSON.stringify({ ok: false, code: "OAUTH_DISCOVERY_REQUIRES_READONLY_FEDERATED" }, null, 2));
  process.exit(1);
}

const report = await probeWebGptOAuthDiscovery(auth, {
  resolve_hostname: createBenchmarkFakeIpRecoveringResolver()
});
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
