import { loadWebGptV4AuthConfig } from "../src/webgpt-v4/auth.js";
import { probeWebGptOAuthDiscovery } from "../src/webgpt-v4/oauthDiscovery.js";
import { parseWebGptV4Profile } from "../src/webgpt-v4/toolCatalog.js";

let profile: "readonly" | "full";
try {
  profile = parseWebGptV4Profile(process.env.WEBGPT_V4_PROFILE);
} catch {
  console.log(JSON.stringify({ ok: false, code: "INVALID_WEBGPT_PROFILE" }, null, 2));
  process.exit(1);
}

const auth = loadWebGptV4AuthConfig(profile);
if (profile !== "readonly" || auth?.provider !== "federated") {
  console.log(JSON.stringify({ ok: false, code: "OAUTH_DISCOVERY_REQUIRES_READONLY_FEDERATED" }, null, 2));
  process.exit(1);
}

const report = await probeWebGptOAuthDiscovery(auth);
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
