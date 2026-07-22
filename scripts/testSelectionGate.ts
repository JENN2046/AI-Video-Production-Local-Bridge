import ts from "typescript";

export type TestSuiteClassification = "mandatory" | "historical_non_runtime";

export interface TestSuiteGroup {
  id: string;
  classification: TestSuiteClassification;
  paths: string[];
  npm_script?: string;
  ci_step?: string;
  rationale?: string;
  active_entrypoint?: boolean;
  evidence?: string;
}

export interface RequiredCommand {
  npm_script: string;
  ci_step: string;
}

export type RemediationStage = "SR1" | "SR2" | "SR3" | "SR4";
export type RemediationKind = "fault_injection" | "migration_copy" | "boundary";

export interface RemediationSuite {
  id: string;
  stage: RemediationStage;
  kind: RemediationKind;
  path: string;
  npm_script: string;
  ci_step: string;
  case_name: string;
}

export interface OAuthPortabilitySuite {
  id: string;
  path: string;
  npm_script: string;
  ci_step: string;
  case_name: string;
}

export interface ReadonlyAppSuite extends OAuthPortabilitySuite {}
export interface DirectorSuite extends OAuthPortabilitySuite {}

export const REQUIRED_DIRECTOR_SUITES: ReadonlyArray<DirectorSuite> = [
  { id: "director-native-tool-registry", path: "tests/director-manual-native-tools.test.ts", npm_script: "test:webgpt:director", ci_step: "ChatGPT Director domain tests", case_name: "Director native registry exposes only the fixed advisory tool set with exact OAuth scopes" },
  { id: "director-tool-scope-challenge", path: "tests/director-manual-native-tools.test.ts", npm_script: "test:webgpt:director", ci_step: "ChatGPT Director domain tests", case_name: "Director registry enforces media and proposal scopes independently from projects.read" },
  { id: "director-result-budget", path: "tests/director-manual-native-tools.test.ts", npm_script: "test:webgpt:director", ci_step: "ChatGPT Director domain tests", case_name: "Director tool results fail closed above the 128 KiB structured response budget" },
  { id: "director-independent-oauth-resource", path: "tests/director-manual-native-tools.test.ts", npm_script: "test:webgpt:director", ci_step: "ChatGPT Director domain tests", case_name: "Director OAuth resource is complete, distinct, and advertises the fixed scopes" },
  { id: "director-manual-import-boundary", path: "tests/director-manual-native-tools.test.ts", npm_script: "test:webgpt:director", ci_step: "ChatGPT Director domain tests", case_name: "Manual Director import remains explicit, confirmed, and untrusted" },
  { id: "director-base-state-hash", path: "tests/director-domain-contract.test.ts", npm_script: "test:webgpt:director", ci_step: "ChatGPT Director domain tests", case_name: "director base-state hash uses deterministic JCS and changes with authoritative inputs" },
  { id: "director-advisory-review-contract", path: "tests/director-domain-contract.test.ts", npm_script: "test:webgpt:director", ci_step: "ChatGPT Director domain tests", case_name: "director proposal contract is kind-specific and review assessment remains advisory" },
  { id: "director-storyboard-v2-contract", path: "tests/director-domain-contract.test.ts", npm_script: "test:webgpt:director", ci_step: "ChatGPT Director domain tests", case_name: "Storyboard Package V2 is content-addressed and preserves continuity semantics" },
  { id: "director-automation-grant-contract", path: "tests/director-domain-contract.test.ts", npm_script: "test:webgpt:director", ci_step: "ChatGPT Director domain tests", case_name: "Automation Grant is content-addressed, bounded, and immutable by replacement" },
  { id: "director-migration-immutability", path: "tests/director-domain-contract.test.ts", npm_script: "test:webgpt:director", ci_step: "ChatGPT Director domain tests", case_name: "migrations 0009 and 0010 upgrade a real 0008 shape and make Director evidence immutable" },
  { id: "director-currency-migration-compatibility", path: "tests/director-domain-contract.test.ts", npm_script: "test:webgpt:director", ci_step: "ChatGPT Director domain tests", case_name: "migration 0010 upgrades an already-ledgered 0009 Grant database without checksum drift" },
  { id: "director-currency-migration-fail-closed", path: "tests/director-domain-contract.test.ts", npm_script: "test:webgpt:director", ci_step: "ChatGPT Director domain tests", case_name: "migration 0010 fails closed without partial schema changes for unsupported legacy Grant currency" },
  { id: "director-db-check-integrity", path: "tests/director-domain-contract.test.ts", npm_script: "test:webgpt:director", ci_step: "ChatGPT Director domain tests", case_name: "db check detects Director payload hash drift without repairing evidence" },
  { id: "director-migration-rollback", path: "tests/director-domain-contract.test.ts", npm_script: "test:webgpt:director", ci_step: "ChatGPT Director domain tests", case_name: "migration 0009 failure rolls back without partial Director tables or ledger evidence" },
  { id: "director-bridge-authentication", path: "tests/director-local-bridge.test.ts", npm_script: "test:webgpt:director", ci_step: "ChatGPT Director domain tests", case_name: "Director bridge HMAC rejects tampering, replay, expired authentication, and invalid keyrings" },
  { id: "director-standard-security-schemes", path: "tests/director-local-bridge.test.ts", npm_script: "test:webgpt:director", ci_step: "ChatGPT Director domain tests", case_name: "Director transport publishes host-visible standard security schemes for multi-scope tools" },
  { id: "director-local-service-boundary", path: "tests/director-local-bridge.test.ts", npm_script: "test:webgpt:director", ci_step: "ChatGPT Director domain tests", case_name: "Director local service binds Focus/context and persists only an immutable advisory Proposal" },
  { id: "director-outbound-bridge-runtime", path: "tests/director-local-bridge.test.ts", npm_script: "test:webgpt:director", ci_step: "ChatGPT Director domain tests", case_name: "Director remote runtime exposes five OAuth tools through the authenticated outbound local bridge" },
  { id: "director-remote-runtime-detachment", path: "tests/director-local-bridge.test.ts", npm_script: "test:webgpt:director", ci_step: "ChatGPT Director domain tests", case_name: "Director remote runtime module graph remains detached from SQLite and local media paths" },
  { id: "director-human-approval-boundary", path: "tests/director-workbench-approval.test.ts", npm_script: "test:webgpt:director", ci_step: "ChatGPT Director domain tests", case_name: "Human Workbench creates a single-owner Focus and records acceptance without compiling or executing" },
  { id: "director-human-approval-drift", path: "tests/director-workbench-approval.test.ts", npm_script: "test:webgpt:director", ci_step: "ChatGPT Director domain tests", case_name: "superseded Focus and authoritative drift block human acceptance without rewriting proposal history" },
  { id: "director-human-approval-api", path: "tests/director-workbench-approval.test.ts", npm_script: "test:webgpt:director", ci_step: "ChatGPT Director domain tests", case_name: "Human Workbench Director endpoints require the local mutation nonce and confirmation" },
  { id: "director-human-approval-revocation", path: "tests/director-workbench-approval.test.ts", npm_script: "test:webgpt:director", ci_step: "ChatGPT Director domain tests", case_name: "revoked proposal membership blocks a pending Director decision without creating a terminal event" },
  { id: "director-human-approval-owner-boundary", path: "tests/director-workbench-approval.test.ts", npm_script: "test:webgpt:director", ci_step: "ChatGPT Director domain tests", case_name: "owner demotion or owner ambiguity blocks a pending Director decision without appending a terminal event" },
  { id: "director-automation-grant-compilation", path: "tests/director-workbench-approval.test.ts", npm_script: "test:webgpt:director", ci_step: "ChatGPT Director domain tests", case_name: "an accepted current generation Proposal compiles exactly one immutable Automation Grant without an Intent, job, or Provider side effect" },
  { id: "director-automation-official-price-minor", path: "tests/director-workbench-approval.test.ts", npm_script: "test:webgpt:director", ci_step: "ChatGPT Director domain tests", case_name: "a bounded Director start reserves the official decimal price in minor units without submitting a Provider task" },
  { id: "director-automation-malformed-intent", path: "tests/director-workbench-approval.test.ts", npm_script: "test:webgpt:director", ci_step: "ChatGPT Director domain tests", case_name: "a malformed Director-prepared intent fails closed before provider selection" },
  { id: "director-automation-known-no-submit-retry", path: "tests/director-workbench-approval.test.ts", npm_script: "test:webgpt:director", ci_step: "ChatGPT Director domain tests", case_name: "a Director Grant retries only known no-submit failures and stops exactly at its retry limit" },
  { id: "director-focus-project-reset", path: "src/workbench-ui/App.test.tsx", npm_script: "test:v2:ui", ci_step: "Workbench V2 UI tests", case_name: "resets the default Focus target when the selected Director project changes" },
  { id: "director-human-approval-archive", path: "tests/director-workbench-approval.test.ts", npm_script: "test:webgpt:director", ci_step: "ChatGPT Director domain tests", case_name: "archived projects reject a pending Director decision after the approval page was opened" },
  { id: "director-memory-port-binding", path: "tests/director-memory-port.test.ts", npm_script: "test:webgpt:director", ci_step: "ChatGPT Director domain tests", case_name: "Director memory port binds advisory recall to the exact project and fails closed on port drift" },
  { id: "director-memory-saveback-envelope", path: "tests/director-memory-port.test.ts", npm_script: "test:webgpt:director", ci_step: "ChatGPT Director domain tests", case_name: "Director memory saveback envelope stays non-dispatched until a separate external confirmation" }
];

export const REQUIRED_READONLY_APP_SUITES: ReadonlyArray<ReadonlyAppSuite> = [
  { id: "readonly-projection-ledger-gate", path: "tests/webgpt-cloud-projection.test.ts", npm_script: "test:webgpt:cloud", ci_step: "WebGPT cloud projection tests", case_name: "readonly projection requires migration 0010 and never upgrades an older database" },
  { id: "readonly-projection-dto-parity", path: "tests/webgpt-cloud-projection.test.ts", npm_script: "test:webgpt:cloud", ci_step: "WebGPT cloud projection tests", case_name: "SQLite and Snapshot readonly adapters preserve six-tool DTO parity and database zero-write manifest" },
  { id: "readonly-snapshot-fingerprint", path: "tests/webgpt-cloud-projection.test.ts", npm_script: "test:webgpt:cloud", ci_step: "WebGPT cloud projection tests", case_name: "snapshot fingerprint uses deterministic JCS input and server time remains authoritative" },
  { id: "readonly-signed-snapshot-transport", path: "tests/webgpt-cloud-remote-runtime.test.ts", npm_script: "test:webgpt:cloud", ci_step: "WebGPT cloud projection tests", case_name: "signed snapshot transport rejects tampering and atomically replaces only newer snapshots" },
  { id: "readonly-remote-no-database", path: "tests/webgpt-cloud-remote-runtime.test.ts", npm_script: "test:webgpt:cloud", ci_step: "WebGPT cloud projection tests", case_name: "remote runtime module graph excludes SQLite and local database adapter entrypoints" },
  { id: "readonly-remote-oauth-tools", path: "tests/webgpt-cloud-remote-runtime.test.ts", npm_script: "test:webgpt:cloud", ci_step: "WebGPT cloud projection tests", case_name: "remote OAuth challenges, signed publish, six readonly tools, and readiness stay fail closed" },
  { id: "readonly-remote-publish-limits", path: "tests/webgpt-cloud-remote-runtime.test.ts", npm_script: "test:webgpt:cloud", ci_step: "WebGPT cloud projection tests", case_name: "remote runtime rejects oversized and rate-limited publish attempts without replacing the snapshot" },
  { id: "readonly-remote-expiry", path: "tests/webgpt-cloud-remote-runtime.test.ts", npm_script: "test:webgpt:cloud", ci_step: "WebGPT cloud projection tests", case_name: "remote snapshot expiry makes readiness and data tools fail closed while health stays live" },
  { id: "readonly-app-resource-contract", path: "tests/webgpt-app-contract.test.ts", npm_script: "test:webgpt:app", ci_step: "WebGPT MCP App tests", case_name: "readonly MCP App contract freezes one render tool, six data tools, one app-only media tool, and the v1 resource" },
  { id: "readonly-app-shell-disclosure", path: "tests/webgpt-app-contract.test.ts", npm_script: "test:webgpt:app", ci_step: "WebGPT MCP App tests", case_name: "render contract accepts only low-disclosure shell state and initial intent" },
  { id: "readonly-app-render-binding", path: "tests/webgpt-app-contract.test.ts", npm_script: "test:webgpt:app", ci_step: "WebGPT MCP App tests", case_name: "readonly App resource and render binding expose a low-disclosure authenticated shell" },
  { id: "readonly-app-widget-security", path: "tests/webgpt-app-contract.test.ts", npm_script: "test:webgpt:app", ci_step: "WebGPT MCP App tests", case_name: "readonly workbench HTML enforces CSP-compatible local rendering and inline escaping" },
  { id: "readonly-app-race-isolation", path: "tests/webgpt-app-contract.test.ts", npm_script: "test:webgpt:app", ci_step: "WebGPT MCP App tests", case_name: "readonly workbench escapes malicious business text and ignores stale cross-project responses" },
  { id: "readonly-app-empty-refresh-recovery", path: "tests/webgpt-app-contract.test.ts", npm_script: "test:webgpt:app", ci_step: "WebGPT MCP App tests", case_name: "readonly workbench refresh recovers an existing empty shell through the data tool" },
  { id: "readonly-app-off-page-selection", path: "tests/webgpt-app-contract.test.ts", npm_script: "test:webgpt:app", ci_step: "WebGPT MCP App tests", case_name: "readonly workbench preserves a selected project outside the first page" },
  { id: "readonly-app-pagination-generation", path: "tests/webgpt-app-contract.test.ts", npm_script: "test:webgpt:app", ci_step: "WebGPT MCP App tests", case_name: "readonly workbench appends project pages without cancelling detail loads" },
  { id: "readonly-app-shot-pagination", path: "tests/webgpt-app-contract.test.ts", npm_script: "test:webgpt:app", ci_step: "WebGPT MCP App tests", case_name: "readonly workbench paginates SHOTs without changing project generation" },
  { id: "readonly-app-panel-error-routing", path: "tests/webgpt-app-contract.test.ts", npm_script: "test:webgpt:app", ci_step: "WebGPT MCP App tests", case_name: "readonly workbench routes parallel tool failures to their own panels" },
  { id: "readonly-app-review-selection-race", path: "tests/webgpt-app-contract.test.ts", npm_script: "test:webgpt:app", ci_step: "WebGPT MCP App tests", case_name: "readonly workbench rejects stale review responses for prior SHOT selections" },
  { id: "readonly-app-refresh-selection-recovery", path: "tests/webgpt-app-contract.test.ts", npm_script: "test:webgpt:app", ci_step: "WebGPT MCP App tests", case_name: "readonly workbench preserves the selected project when refresh fails" },
  { id: "readonly-app-snapshot-page-reset", path: "tests/webgpt-app-contract.test.ts", npm_script: "test:webgpt:app", ci_step: "WebGPT MCP App tests", case_name: "readonly workbench reloads project pages from offset zero after snapshot changes" },
  { id: "readonly-app-selected-shot-refresh", path: "tests/webgpt-app-contract.test.ts", npm_script: "test:webgpt:app", ci_step: "WebGPT MCP App tests", case_name: "readonly workbench preserves the selected paged SHOT across refresh" },
  { id: "readonly-app-unregistered-principal-empty", path: "tests/webgpt-app-contract.test.ts", npm_script: "test:webgpt:app", ci_step: "WebGPT MCP App tests", case_name: "readonly workbench maps an unregistered principal refresh to no authorized projects" },
  { id: "readonly-app-client-ttl-expiry", path: "tests/webgpt-app-contract.test.ts", npm_script: "test:webgpt:app", ci_step: "WebGPT MCP App tests", case_name: "readonly workbench clears business panels as soon as the client TTL reaches zero" },
  { id: "readonly-app-initial-zero-ttl", path: "tests/webgpt-app-contract.test.ts", npm_script: "test:webgpt:app", ci_step: "WebGPT MCP App tests", case_name: "readonly workbench does not mount business panels when the initial TTL is zero" },
  { id: "readonly-app-host-shell-invalidation", path: "tests/webgpt-app-contract.test.ts", npm_script: "test:webgpt:app", ci_step: "WebGPT MCP App tests", case_name: "readonly workbench ignores project responses that arrive after a non-ready host shell" },
  { id: "readonly-publisher-dpapi", path: "tests/webgpt-cloud-delivery.test.ts", npm_script: "test:webgpt:cloud", ci_step: "WebGPT cloud projection tests", case_name: "Windows DPAPI CurrentUser roundtrip keeps plaintext out of files and output" },
  { id: "readonly-publisher-ignored-paths", path: "tests/webgpt-cloud-delivery.test.ts", npm_script: "test:webgpt:cloud", ci_step: "WebGPT cloud projection tests", case_name: "publisher refuses runtime profile, key, or receipt paths that are not Git ignored" },
  { id: "readonly-publisher-signed-delivery", path: "tests/webgpt-cloud-delivery.test.ts", npm_script: "test:webgpt:cloud", ci_step: "WebGPT cloud projection tests", case_name: "publisher signs a strict projection, sends only the envelope, and writes a sanitized receipt" },
  { id: "personal-readonly-operations-safety", path: "tests/webgpt-cloud-delivery.test.ts", npm_script: "test:webgpt:cloud", ci_step: "WebGPT cloud projection tests", case_name: "personal readonly operations keep status read-only and run one explicit preflight-publish lane" },
  { id: "personal-readonly-operations-api", path: "tests/workbench-v2-api.test.ts", npm_script: "test:v2", ci_step: "Workbench V2 domain tests", case_name: "personal readonly operations API requires nonce and explicit publish confirmation" },
  { id: "readonly-render-blueprint", path: "tests/webgpt-cloud-delivery.test.ts", npm_script: "test:webgpt:cloud", ci_step: "WebGPT cloud projection tests", case_name: "Render blueprint freezes one always-on instance without disk or auto deploy" },
  { id: "readonly-render-no-database", path: "tests/webgpt-cloud-delivery.test.ts", npm_script: "test:webgpt:cloud", ci_step: "WebGPT cloud projection tests", case_name: "Render entrypoint keeps publisher, exporter, and SQLite modules out of the remote graph" },
  { id: "readonly-apps-smoke", path: "tests/webgpt-apps-smoke.test.ts", npm_script: "smoke:webgpt:app", ci_step: "WebGPT Apps smoke", case_name: "Apps smoke discovers seven model-visible tools and one app-only media tool, reads the UI resource, and renders an empty authenticated shell" },
  { id: "readonly-media-snapshot-v4-bindings", path: "tests/webgpt-cloud-projection.test.ts", npm_script: "test:webgpt:cloud", ci_step: "WebGPT cloud projection tests", case_name: "five-stage operational state exports through Snapshot v4 with canonical media bindings and blocker reasons" },
  { id: "readonly-media-capability-crypto", path: "tests/webgpt-media-capability-contract.test.ts", npm_script: "test:webgpt:media-gateway", ci_step: "Readonly media gateway contract tests", case_name: "readonly media capability encrypts strict five-minute claims and supports bounded key rotation" },
  { id: "readonly-media-capability-fail-closed", path: "tests/webgpt-media-capability-contract.test.ts", npm_script: "test:webgpt:media-gateway", ci_step: "Readonly media gateway contract tests", case_name: "readonly media capability rejects tampering, expiry, replay, and invalid key material" },
  { id: "readonly-media-gateway-bounded-integrity", path: "tests/webgpt-media-gateway-runtime.test.ts", npm_script: "test:webgpt:media-gateway", ci_step: "Readonly media gateway contract tests", case_name: "media integrity queue remains bounded and retains a timed-out slot until the underlying task settles" },
  { id: "readonly-media-gateway-streaming", path: "tests/webgpt-media-gateway-runtime.test.ts", npm_script: "test:webgpt:media-gateway", ci_step: "Readonly media gateway contract tests", case_name: "readonly media gateway verifies bytes, consumes capabilities once, streams ranges, and never writes SQLite" },
  { id: "readonly-media-gateway-revalidation", path: "tests/webgpt-media-gateway-runtime.test.ts", npm_script: "test:webgpt:media-gateway", ci_step: "Readonly media gateway contract tests", case_name: "readonly media sessions fail closed after membership revocation or file identity drift" },
  { id: "readonly-media-gateway-lifetime", path: "tests/webgpt-media-gateway-runtime.test.ts", npm_script: "test:webgpt:media-gateway", ci_step: "Readonly media gateway contract tests", case_name: "readonly media capability and session handles expire and never survive a gateway restart" },
  { id: "readonly-media-app-only-contract", path: "tests/webgpt-app-contract.test.ts", npm_script: "test:webgpt:app", ci_step: "WebGPT MCP App tests", case_name: "readonly media playback contract is app-only and keeps the capability URL out of model-visible output" },
  { id: "readonly-media-remote-pinning", path: "tests/webgpt-media-remote-bridge.test.ts", npm_script: "test:webgpt:cloud", ci_step: "WebGPT cloud projection tests", case_name: "remote media bridge uses a validated pinned address and keeps identifiers inside AES-GCM ciphertext" },
  { id: "readonly-media-widget-lifecycle", path: "tests/webgpt-app-contract.test.ts", npm_script: "test:webgpt:app", ci_step: "WebGPT MCP App tests", case_name: "readonly workbench preserves media across same-project refresh and clears it on project switch" },
  { id: "readonly-media-operations-safety", path: "tests/webgpt-media-operations.test.ts", npm_script: "test:webgpt:media-gateway", ci_step: "Readonly media gateway contract tests", case_name: "readonly media operations pin cloudflared and keep secrets out of command lines and status" },
  { id: "readonly-media-tunnel-protocol-forwarding", path: "tests/webgpt-media-operations.test.ts", npm_script: "test:webgpt:media-gateway", ci_step: "Readonly media gateway contract tests", case_name: "readonly media operations validate and forward the selected tunnel protocol" },
  { id: "readonly-media-mp4-acceptance-fixture", path: "tests/webgpt-media-acceptance-fixture.test.ts", npm_script: "test:webgpt:media-gateway", ci_step: "Readonly media gateway contract tests", case_name: "MP4 acceptance fixture and generated profiles are isolated, contract-valid, source-preserving, and low disclosure" },
  { id: "readonly-media-logon-ordering", path: "tests/webgpt-media-operations.test.ts", npm_script: "test:webgpt:media-gateway", ci_step: "Readonly media gateway contract tests", case_name: "readonly media logon task is current-user limited and starts gateway before tunnel" },
  { id: "readonly-media-preflight-port-identity", path: "tests/webgpt-media-operations.test.ts", npm_script: "test:webgpt:media-gateway", ci_step: "Readonly media gateway contract tests", case_name: "readonly media preflight accepts only a managed gateway matching the listener" },
  { id: "readonly-media-dpapi-keygen", path: "tests/webgpt-media-operations.test.ts", npm_script: "test:webgpt:media-gateway", ci_step: "Readonly media gateway contract tests", case_name: "readonly media capability keygen writes only DPAPI CurrentUser ciphertext to ignored storage" },
  { id: "readonly-media-apps-smoke-selection", path: "tests/webgpt-media-operations.test.ts", npm_script: "test:webgpt:media-gateway", ci_step: "Readonly media gateway contract tests", case_name: "readonly media Apps smoke and operations are mandatory local and Windows CI gates" }
];

export const REQUIRED_OAUTH_PORTABILITY_SUITES: ReadonlyArray<OAuthPortabilitySuite> = [
  { id: "oauth-selected-provider-capability", path: "tests/webgpt-v4-selected-provider.test.ts", npm_script: "test:webgpt:v4", ci_step: "WebGPT V4 integration tests", case_name: "selected provider capability rejects missing PKCE, public-client, audience, and scope guarantees" },
  { id: "oauth-selected-provider-jwt", path: "tests/webgpt-v4-selected-provider.test.ts", npm_script: "test:webgpt:v4", ci_step: "WebGPT V4 integration tests", case_name: "selected provider JWT verifies signature, issuer, audience, expiry, scope claims, and key rotation" },
  { id: "oauth-selected-provider-authorization", path: "tests/webgpt-v4-selected-provider.test.ts", npm_script: "test:webgpt:v4", ci_step: "WebGPT V4 integration tests", case_name: "selected provider authorization distinguishes unregistered, owner, viewer, revoked, and cross-project access" },
  { id: "oauth-selected-provider-six-tools", path: "tests/webgpt-v4-selected-provider.test.ts", npm_script: "test:webgpt:v4", ci_step: "WebGPT V4 integration tests", case_name: "selected provider six readonly tools preserve the complete database logical manifest" },
  { id: "oauth-fakeip-doh-boundary", path: "tests/webgpt-v4-oauth-discovery.test.ts", npm_script: "test:webgpt:v4", ci_step: "WebGPT V4 integration tests", case_name: "benchmark fake-IP recovery uses bounded public DoH without weakening private-address rejection" },
  { id: "oauth-fakeip-jwks-pinning", path: "tests/webgpt-v4-server.test.ts", npm_script: "test:webgpt:v4", ci_step: "WebGPT V4 integration tests", case_name: "server authentication carries benchmark fake-IP recovery through remote JWKS pinning" }
];

export const REQUIRED_REMEDIATION_SUITES: ReadonlyArray<RemediationSuite> = [
  { id: "sr1-artifact-blob-faults", stage: "SR1", kind: "fault_injection", path: "tests/artifact-blob-boundary.test.ts", npm_script: "test:foundation-boundaries", ci_step: "Foundation and media boundary tests", case_name: "cross-SHOT reuse and stale concurrent binding attempts fail closed" },
  { id: "sr1-legacy-migration-copy", stage: "SR1", kind: "migration_copy", path: "tests/artifact-blob-boundary.test.ts", npm_script: "test:foundation-boundaries", ci_step: "Foundation and media boundary tests", case_name: "v2-4 migration derives Blob facts from local bytes and fails closed on structured drift" },
  { id: "sr2-provider-contract-faults", stage: "SR2", kind: "fault_injection", path: "tests/provider-capability-contract.test.ts", npm_script: "test:provider-boundaries", ci_step: "Provider and transfer safety tests", case_name: "Provider capability key rejects model, duration, resolution, and aspect drift" },
  { id: "sr2-worker-outcome-boundary", stage: "SR2", kind: "boundary", path: "tests/workbench-v2-domain.test.ts", npm_script: "test:v2", ci_step: "Workbench V2 domain tests", case_name: "provider task persistence failure enters manual reconciliation without losing the paid task ID" },
  { id: "sr3-activation-recovery-faults", stage: "SR3", kind: "fault_injection", path: "tests/media-activation-integrity.test.ts", npm_script: "test:foundation-boundaries", ci_step: "Foundation and media boundary tests", case_name: "recovery removes an activation-owned duplicate final after Blob dedupe" },
  { id: "sr3-integrity-migration-copy", stage: "SR3", kind: "migration_copy", path: "tests/database-governance.test.ts", npm_script: "test:db", ci_step: "Database and authorization governance tests", case_name: "migration 0006 backfills active legacy Artifact facts from the verified Blob" },
  { id: "sr4-reference-readiness-faults", stage: "SR4", kind: "fault_injection", path: "tests/workbench-v2-domain.test.ts", npm_script: "test:v2", ci_step: "Workbench V2 domain tests", case_name: "generation preflight rejects a storyboard Artifact bound to another SHOT" },
  { id: "sr4-webgpt-cross-shot-boundary", stage: "SR4", kind: "boundary", path: "tests/webgpt-v4-domain.test.ts", npm_script: "test:webgpt:v4", ci_step: "WebGPT V4 integration tests", case_name: "review and delivery guards reject same-project wrong-SHOT and tampered artifacts" }
];

export interface TestSuiteCatalog {
  version: 2;
  groups: TestSuiteGroup[];
  required_commands?: RequiredCommand[];
  remediation_suites: RemediationSuite[];
  oauth_portability_suites: OAuthPortabilitySuite[];
  director_suites: DirectorSuite[];
  readonly_app_suites: ReadonlyAppSuite[];
}

export interface TestSelectionAuditInput {
  catalog: TestSuiteCatalog;
  source_files: string[];
  source_texts: Record<string, string>;
  runner_config_texts?: Record<string, string>;
  package_scripts: Record<string, string>;
  workflow_text: string;
  required_remediation_suites?: ReadonlyArray<RemediationSuite>;
  required_oauth_portability_suites?: ReadonlyArray<OAuthPortabilitySuite>;
  required_director_suites?: ReadonlyArray<DirectorSuite>;
  required_readonly_app_suites?: ReadonlyArray<ReadonlyAppSuite>;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function npmRuns(command: string): Set<string> {
  const result = new Set<string>();
  for (const segment of command.split("&&").map((item) => item.trim())) {
    const match = segment.match(/^npm\s+run\s+([A-Za-z0-9:_-]+)(?:\s+--(?:\s+.*)?)?$/);
    if (match) result.add(match[1]);
  }
  return result;
}

function workflowNpmSteps(workflow: string): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  let currentName = "";
  for (const line of workflow.split(/\r?\n/)) {
    const name = line.match(/^\s*-\s+name:\s*(.+?)\s*$/);
    if (name) {
      currentName = name[1].replace(/^['"]|['"]$/g, "");
      continue;
    }
    const run = line.match(/^\s*run:\s*npm\s+run\s+([A-Za-z0-9:_-]+)\s*$/);
    if (!run) continue;
    const names = result.get(run[1]) ?? new Set<string>();
    names.add(currentName);
    result.set(run[1], names);
  }
  return result;
}

function expectedRunnerPath(sourcePath: string): string {
  const normalized = normalizePath(sourcePath);
  if (normalized.startsWith("tests/browser/")) return normalized;
  return `dist/${normalized.replace(/\.tsx?$/, ".js")}`;
}

function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern
    .replaceAll("**/", "\u0000")
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", "[^/]*")
    .replaceAll("\u0000", "(?:.*/)?");
  return new RegExp(`^${escaped}$`).test(value);
}

function expandGlobBraces(pattern: string): string[] {
  const match = pattern.match(/\{([^{}]+)\}/);
  if (!match || match.index === undefined) return [pattern];
  const before = pattern.slice(0, match.index);
  const after = pattern.slice(match.index + match[0].length);
  return match[1].split(",").flatMap((option) => expandGlobBraces(`${before}${option}${after}`));
}

function vitestConfigSelectsPath(configText: string, sourcePath: string): boolean {
  const normalizedPath = normalizePath(sourcePath);
  const patterns = [...configText.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
  return patterns.some((pattern) => expandGlobBraces(pattern).some((expanded) => globMatches(normalizePath(expanded), normalizedPath)));
}

function packageScriptSelectsPath(command: string, sourcePath: string, runnerConfigTexts: Record<string, string>): boolean {
  const unsupportedControlOperators = command.replaceAll("&&", "");
  if (/[;|&\r\n]/.test(unsupportedControlOperators)) return false;
  const expected = expectedRunnerPath(sourcePath);
  return command.split("&&").some((rawSegment) => {
    const segment = rawSegment.trim();
    const tokens = segment
      .split(/\s+/)
      .map((token) => token.replace(/^["']|["',]$/g, ""))
      .filter(Boolean);
    const configIndex = tokens.findIndex((token) => token === "--config");
    const configPath = configIndex >= 0 ? normalizePath(tokens[configIndex + 1] ?? "") : "";
    const isVitestRunner = tokens[0] === "vitest"
      && tokens[1] === "run"
      && configPath.length > 0
      && vitestConfigSelectsPath(runnerConfigTexts[configPath] ?? "", sourcePath);
    if (isVitestRunner) return true;
    const pathIndex = tokens.findIndex((token) => globMatches(normalizePath(token), expected));
    if (pathIndex < 0) return false;
    const isDirectNodeRunner = tokens[0] === "node" && pathIndex === 1;
    const isNodeTestRunner = tokens[0] === "node" && tokens[1] === "--test" && pathIndex >= 2;
    const isIsolatedNodeRunner = tokens[0] === "node" && /run-isolated-tests\.(?:js|mjs)$/.test(tokens[1] ?? "") && pathIndex >= 2;
    const playwrightOffset = tokens[0] === "npx" ? 1 : 0;
    const isPlaywrightRunner = tokens[playwrightOffset] === "playwright"
      && tokens[playwrightOffset + 1] === "test"
      && pathIndex > playwrightOffset + 1;
    return isDirectNodeRunner || isNodeTestRunner || isIsolatedNodeRunner || isPlaywrightRunner;
  });
}

function sourceContainsNamedCase(source: string, caseName: string): boolean {
  const sourceFile = ts.createSourceFile("selection-gate-case.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && (node.expression.text === "test" || node.expression.text === "it")) {
      const name = node.arguments[0];
      const nameMatches = name && (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) && name.text === caseName;
      if (nameMatches) {
        const options = node.arguments[1];
        const disabled = options && ts.isObjectLiteralExpression(options) && options.properties.some((property) => {
          if (ts.isShorthandPropertyAssignment(property)) return property.name.text === "skip" || property.name.text === "todo";
          if (!ts.isPropertyAssignment(property)) return false;
          const propertyName = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : "";
          if (propertyName !== "skip" && propertyName !== "todo") return false;
          return property.initializer.kind !== ts.SyntaxKind.FalseKeyword;
        });
        if (!disabled) found = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

export function auditTestSelection(input: TestSelectionAuditInput): string[] {
  const errors: string[] = [];
  if (input.catalog.version !== 2) return ["CATALOG_VERSION_INVALID"];
  if (!Array.isArray(input.catalog.groups)) return ["CATALOG_GROUPS_INVALID"];
  if (!Array.isArray(input.catalog.remediation_suites)) return ["CATALOG_REMEDIATION_SUITES_INVALID"];
  if (!Array.isArray(input.catalog.oauth_portability_suites)) return ["CATALOG_OAUTH_PORTABILITY_SUITES_INVALID"];
  if (!Array.isArray(input.catalog.director_suites)) return ["CATALOG_DIRECTOR_SUITES_INVALID"];
  if (!Array.isArray(input.catalog.readonly_app_suites)) return ["CATALOG_READONLY_APP_SUITES_INVALID"];

  const sourceFiles = new Set(input.source_files.map(normalizePath));
  const catalogPaths = new Map<string, string>();
  const requirements: RequiredCommand[] = [...(input.catalog.required_commands ?? [])];

  for (const group of input.catalog.groups) {
    if (!group.id?.trim() || !Array.isArray(group.paths) || group.paths.length === 0) {
      errors.push(`CATALOG_GROUP_INVALID: ${group.id || "<missing>"}`);
      continue;
    }
    if (group.classification !== "mandatory" && group.classification !== "historical_non_runtime") {
      errors.push(`CATALOG_CLASSIFICATION_INVALID: ${group.id}`);
      continue;
    }
    if (group.classification === "historical_non_runtime") {
      if (!group.rationale || group.rationale.trim().length < 20) errors.push(`CATALOG_HISTORICAL_RATIONALE_REQUIRED: ${group.id}`);
      if (group.active_entrypoint !== false) errors.push(`CATALOG_HISTORICAL_ACTIVE_ENTRYPOINT_REQUIRED: ${group.id}`);
      if (!group.evidence || group.evidence.trim().length < 10) errors.push(`CATALOG_HISTORICAL_EVIDENCE_REQUIRED: ${group.id}`);
      if (group.npm_script || group.ci_step) errors.push(`CATALOG_HISTORICAL_GATE_FORBIDDEN: ${group.id}`);
    } else if (!group.npm_script || !group.ci_step) {
      errors.push(`CATALOG_MANDATORY_GATE_REQUIRED: ${group.id}`);
    } else {
      requirements.push({ npm_script: group.npm_script, ci_step: group.ci_step });
    }

    for (const rawPath of group.paths) {
      const path = normalizePath(rawPath);
      const owner = catalogPaths.get(path);
      if (owner) errors.push(`CATALOG_DUPLICATE: ${path} (${owner}, ${group.id})`);
      else catalogPaths.set(path, group.id);
    }
  }

  for (const path of sourceFiles) {
    if (!catalogPaths.has(path)) errors.push(`CATALOG_UNCLASSIFIED: ${path}`);
  }
  for (const path of catalogPaths.keys()) {
    if (!sourceFiles.has(path)) errors.push(`CATALOG_FILE_MISSING: ${path}`);
  }

  const remediationIds = new Set<string>();
  const remediationStages = new Set<RemediationStage>();
  const remediationKinds = new Set<RemediationKind>();
  for (const suite of input.catalog.remediation_suites) {
    const path = normalizePath(suite.path ?? "");
    if (!suite.id?.trim() || remediationIds.has(suite.id)) {
      errors.push(`REMEDIATION_SUITE_ID_INVALID: ${suite.id || "<missing>"}`);
    } else {
      remediationIds.add(suite.id);
    }
    if (!["SR1", "SR2", "SR3", "SR4"].includes(suite.stage)) {
      errors.push(`REMEDIATION_STAGE_INVALID: ${suite.id}`);
    } else {
      remediationStages.add(suite.stage);
    }
    if (!["fault_injection", "migration_copy", "boundary"].includes(suite.kind)) {
      errors.push(`REMEDIATION_KIND_INVALID: ${suite.id}`);
    } else {
      remediationKinds.add(suite.kind);
    }
    const ownerId = catalogPaths.get(path);
    const owner = input.catalog.groups.find((group) => group.id === ownerId);
    if (!owner || owner.classification !== "mandatory") {
      errors.push(`REMEDIATION_SUITE_NOT_MANDATORY: ${suite.id} -> ${path || "<missing>"}`);
    } else if (owner.npm_script !== suite.npm_script || owner.ci_step !== suite.ci_step) {
      errors.push(`REMEDIATION_LANE_MISMATCH: ${suite.id}`);
    }
    if (!suite.case_name?.trim() || !sourceContainsNamedCase(input.source_texts[path] ?? "", suite.case_name)) {
      errors.push(`REMEDIATION_CASE_MISSING: ${suite.id} -> ${suite.case_name || "<missing>"}`);
    }
  }
  const requiredSuites = input.required_remediation_suites ?? REQUIRED_REMEDIATION_SUITES;
  const requiredRemediation = new Map(requiredSuites.map((suite) => [suite.id, suite]));
  const actualRemediation = new Map(input.catalog.remediation_suites.map((suite) => [suite.id, suite]));
  for (const required of requiredSuites) {
    const actual = actualRemediation.get(required.id);
    if (!actual) {
      errors.push(`REMEDIATION_SUITE_MISSING: ${required.id}`);
    } else if (actual.stage !== required.stage
      || actual.kind !== required.kind
      || normalizePath(actual.path) !== normalizePath(required.path)
      || actual.npm_script !== required.npm_script
      || actual.ci_step !== required.ci_step
      || actual.case_name !== required.case_name) {
      errors.push(`REMEDIATION_SUITE_SIGNATURE_MISMATCH: ${required.id}`);
    }
  }
  for (const suite of input.catalog.remediation_suites) {
    if (!requiredRemediation.has(suite.id)) errors.push(`REMEDIATION_SUITE_UNDECLARED: ${suite.id}`);
  }
  for (const stage of ["SR1", "SR2", "SR3", "SR4"] as const) {
    if (!remediationStages.has(stage)) errors.push(`REMEDIATION_STAGE_MISSING: ${stage}`);
  }
  for (const kind of ["fault_injection", "migration_copy"] as const) {
    if (!remediationKinds.has(kind)) errors.push(`REMEDIATION_KIND_MISSING: ${kind}`);
  }

  const requiredOauthSuites = input.required_oauth_portability_suites ?? REQUIRED_OAUTH_PORTABILITY_SUITES;
  const requiredOauth = new Map(requiredOauthSuites.map((suite) => [suite.id, suite]));
  const actualOauth = new Map(input.catalog.oauth_portability_suites.map((suite) => [suite.id, suite]));
  if (actualOauth.size !== input.catalog.oauth_portability_suites.length) errors.push("OAUTH_PORTABILITY_SUITE_ID_DUPLICATE");
  for (const required of requiredOauthSuites) {
    const actual = actualOauth.get(required.id);
    if (!actual) {
      errors.push(`OAUTH_PORTABILITY_SUITE_MISSING: ${required.id}`);
      continue;
    }
    if (normalizePath(actual.path) !== normalizePath(required.path)
      || actual.npm_script !== required.npm_script
      || actual.ci_step !== required.ci_step
      || actual.case_name !== required.case_name) {
      errors.push(`OAUTH_PORTABILITY_SUITE_SIGNATURE_MISMATCH: ${required.id}`);
    }
  }
  for (const suite of input.catalog.oauth_portability_suites) {
    if (!requiredOauth.has(suite.id)) errors.push(`OAUTH_PORTABILITY_SUITE_UNDECLARED: ${suite.id}`);
    const path = normalizePath(suite.path ?? "");
    const ownerId = catalogPaths.get(path);
    const owner = input.catalog.groups.find((group) => group.id === ownerId);
    if (!owner || owner.classification !== "mandatory") {
      errors.push(`OAUTH_PORTABILITY_SUITE_NOT_MANDATORY: ${suite.id} -> ${path || "<missing>"}`);
    } else if (owner.npm_script !== suite.npm_script || owner.ci_step !== suite.ci_step) {
      errors.push(`OAUTH_PORTABILITY_LANE_MISMATCH: ${suite.id}`);
    }
    if (!suite.case_name?.trim() || !sourceContainsNamedCase(input.source_texts[path] ?? "", suite.case_name)) {
      errors.push(`OAUTH_PORTABILITY_CASE_MISSING: ${suite.id} -> ${suite.case_name || "<missing>"}`);
    }
  }

  const requiredDirectorSuites = input.required_director_suites ?? REQUIRED_DIRECTOR_SUITES;
  const requiredDirectors = new Map(requiredDirectorSuites.map((suite) => [suite.id, suite]));
  const actualDirectors = new Map(input.catalog.director_suites.map((suite) => [suite.id, suite]));
  if (actualDirectors.size !== input.catalog.director_suites.length) errors.push("DIRECTOR_SUITE_ID_DUPLICATE");
  for (const required of requiredDirectorSuites) {
    const actual = actualDirectors.get(required.id);
    if (!actual) {
      errors.push(`DIRECTOR_SUITE_MISSING: ${required.id}`);
      continue;
    }
    if (normalizePath(actual.path) !== normalizePath(required.path)
      || actual.npm_script !== required.npm_script
      || actual.ci_step !== required.ci_step
      || actual.case_name !== required.case_name) {
      errors.push(`DIRECTOR_SUITE_SIGNATURE_MISMATCH: ${required.id}`);
    }
  }
  for (const suite of input.catalog.director_suites) {
    if (!requiredDirectors.has(suite.id)) errors.push(`DIRECTOR_SUITE_UNDECLARED: ${suite.id}`);
    const path = normalizePath(suite.path ?? "");
    const ownerId = catalogPaths.get(path);
    const owner = input.catalog.groups.find((group) => group.id === ownerId);
    if (!owner || owner.classification !== "mandatory") {
      errors.push(`DIRECTOR_SUITE_NOT_MANDATORY: ${suite.id} -> ${path || "<missing>"}`);
    } else if (owner.npm_script !== suite.npm_script || owner.ci_step !== suite.ci_step) {
      errors.push(`DIRECTOR_SUITE_LANE_MISMATCH: ${suite.id}`);
    }
    if (!suite.case_name?.trim() || !sourceContainsNamedCase(input.source_texts[path] ?? "", suite.case_name)) {
      errors.push(`DIRECTOR_CASE_MISSING: ${suite.id} -> ${suite.case_name || "<missing>"}`);
    }
  }

  const requiredReadonlyAppSuites = input.required_readonly_app_suites ?? REQUIRED_READONLY_APP_SUITES;
  const requiredReadonlyApps = new Map(requiredReadonlyAppSuites.map((suite) => [suite.id, suite]));
  const actualReadonlyApps = new Map(input.catalog.readonly_app_suites.map((suite) => [suite.id, suite]));
  if (actualReadonlyApps.size !== input.catalog.readonly_app_suites.length) errors.push("READONLY_APP_SUITE_ID_DUPLICATE");
  for (const required of requiredReadonlyAppSuites) {
    const actual = actualReadonlyApps.get(required.id);
    if (!actual) {
      errors.push(`READONLY_APP_SUITE_MISSING: ${required.id}`);
      continue;
    }
    if (normalizePath(actual.path) !== normalizePath(required.path)
      || actual.npm_script !== required.npm_script
      || actual.ci_step !== required.ci_step
      || actual.case_name !== required.case_name) {
      errors.push(`READONLY_APP_SUITE_SIGNATURE_MISMATCH: ${required.id}`);
    }
  }
  for (const suite of input.catalog.readonly_app_suites) {
    if (!requiredReadonlyApps.has(suite.id)) errors.push(`READONLY_APP_SUITE_UNDECLARED: ${suite.id}`);
    const path = normalizePath(suite.path ?? "");
    const ownerId = catalogPaths.get(path);
    const owner = input.catalog.groups.find((group) => group.id === ownerId);
    if (!owner || owner.classification !== "mandatory") {
      errors.push(`READONLY_APP_SUITE_NOT_MANDATORY: ${suite.id} -> ${path || "<missing>"}`);
    } else if (owner.npm_script !== suite.npm_script || owner.ci_step !== suite.ci_step) {
      errors.push(`READONLY_APP_SUITE_LANE_MISMATCH: ${suite.id}`);
    }
    if (!suite.case_name?.trim() || !sourceContainsNamedCase(input.source_texts[path] ?? "", suite.case_name)) {
      errors.push(`READONLY_APP_CASE_MISSING: ${suite.id} -> ${suite.case_name || "<missing>"}`);
    }
  }

  const canonicalRuns = npmRuns(input.package_scripts.test ?? "");
  const workflowSteps = workflowNpmSteps(input.workflow_text);
  const uniqueRequirements = new Map<string, RequiredCommand>();
  for (const requirement of requirements) {
    const existing = uniqueRequirements.get(requirement.npm_script);
    if (existing && existing.ci_step !== requirement.ci_step) {
      errors.push(`CATALOG_REQUIREMENT_CONFLICT: ${requirement.npm_script} (${existing.ci_step}, ${requirement.ci_step})`);
    } else {
      uniqueRequirements.set(requirement.npm_script, requirement);
    }
  }
  for (const requirement of uniqueRequirements.values()) {
    if (!input.package_scripts[requirement.npm_script]) errors.push(`PACKAGE_SCRIPT_MISSING: ${requirement.npm_script}`);
    if (!canonicalRuns.has(requirement.npm_script)) errors.push(`LOCAL_GATE_MISSING: ${requirement.npm_script}`);
    const names = workflowSteps.get(requirement.npm_script);
    if (!names) errors.push(`CI_GATE_MISSING: ${requirement.npm_script}`);
    else if (!names.has(requirement.ci_step)) errors.push(`CI_STEP_MISMATCH: ${requirement.npm_script} expected ${requirement.ci_step}`);
  }

  for (const group of input.catalog.groups.filter((item) => item.classification === "mandatory")) {
    const command = input.package_scripts[group.npm_script ?? ""] ?? "";
    for (const path of group.paths) {
      if (!packageScriptSelectsPath(command, path, input.runner_config_texts ?? {})) {
        errors.push(`PACKAGE_SUITE_PATH_MISSING: ${group.npm_script} -> ${normalizePath(path)}`);
      }
    }
  }

  return errors;
}
