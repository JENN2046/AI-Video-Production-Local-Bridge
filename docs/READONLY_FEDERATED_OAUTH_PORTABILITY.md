# Readonly Federated OAuth Portability v1

Status: `PARTIAL_EXTERNAL_GATE`

Repository implementation baseline: `main@c0239eb`

Accepted local runtime remains: package `0.1.0-beta.4`, MCP service `webgpt-v4.2.0`, activity-database ledger `0007`

Candidate database contract: Workbench schema `workbench-v2-5`, migration ledger `0008`

## Purpose

This taskbook separates the Readonly MCP resource server from any single identity-provider brand. The runtime accepts one strict Federated OAuth configuration, validates JWT signature/issuer/audience/expiry/scope, derives an opaque issuer-bound principal, and grants project access only through local production-project membership.

Readonly continues to expose exactly six `projects.read` tools. It does not enable media, write tools, Provider calls, anonymous MCP, public ingress, or automatic startup.

## Provider-neutral contract

The Readonly resource server requires all of the following:

- `WEBGPT_V4_READONLY_OAUTH_ISSUER` is the exact authorization-server identifier, metadata issuer, and JWT `iss`.
- `WEBGPT_V4_READONLY_OAUTH_AUDIENCE` exactly equals `WEBGPT_V4_RESOURCE_URL` and the access-token audience.
- `WEBGPT_V4_READONLY_OAUTH_JWKS_URI` exactly equals discovery metadata `jwks_uri`.
- `WEBGPT_V4_READONLY_OAUTH_CLIENT_REGISTRATION` is explicitly `predefined`, `cimd`, or `dcr`.
- Discovery is anonymous HTTPS, redirect-free, size-bounded, timeout-bounded, and DNS-pinned.
- Authorization code uses PKCE S256 and a public client with token endpoint authentication `none`.
- Readonly accepts `scope`, or the compatible `scp` string/array. If both exist, their normalized sets must be identical.
- `projects.read` is required. `permissions` never grants Readonly scope.
- Authentication alone grants no project access. The principal must be active, bound to the current issuer, and hold an active local membership.
- A current-issuer active production owner is required for readiness.

The generic runtime does not branch on `provider === "stytch"` or `provider === "descope"`. Provider selection is an external capability and acceptance decision, not a new authorization bypass.

## Stage 0 decision

Result: `AUTH0_CAPABILITY_GATE_FAILED`

This result does not claim that Auth0 lacks the product capability. Official Auth0 documentation describes Resource Parameter Compatibility Profile, public/native applications, PKCE, custom APIs, and custom scopes. The hard gate failed because the currently intended tenant/plan and its exact resource-to-audience behavior could not be verified read-only in the available session. The implementation therefore did not create or modify an Auth0 API/Application and did not relax the resource server.

Per the approved fallback rule, PR3 uses a Stytch predefined public-client capability fixture. Official Stytch documentation describes public third-party clients, token endpoint authentication `none`, PKCE, custom OAuth scopes, JWKS-backed JWTs, and an access-token custom audience. It also requires the integrating application to host the authorization/login/consent surface and warns that the default issuer is not fully OIDC compatible without the appropriate project domain. This is capability evidence only; it is not proof that Jenn's future Stytch project, authorization surface, issuer, or a ChatGPT connection has passed.

References:

- [OpenAI Apps SDK authentication](https://developers.openai.com/apps-sdk/build/auth)
- [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Auth0 Resource Parameter Compatibility Profile](https://auth0.com/ai/docs/mcp/guides/resource-param-compatibility-profile)
- [Stytch MCP authorization overview](https://stytch.com/docs/connected-apps/guides/mcp-auth-overview)
- [Stytch OAuth client types](https://stytch.com/docs/connected-apps/oauth-learn-more/client-types)

## PR3 offline contract

The selected-provider lane is deliberately isolated from external services:

- A generic validator freezes authorization code only, PKCE S256, token auth `none`, exact redirect allowlist, `projects.read` only, no client secret, no client credentials, and exact resource/audience equality.
- Synthetic JWTs with temporary test keys cover signature, exact issuer, exact audience, expiry, `kid`, key rotation, `scope`, `scp`, claim conflicts, and missing `projects.read`.
- Two synthetic users derive different opaque principals.
- Local authorization fixtures cover unregistered, owner, viewer, revoked, and cross-project access.
- The official MCP Client calls all six Readonly tools and compares the complete application-table logical manifest before and after.
- `test-selection-gate` freezes the test file, npm lane, Windows CI step, and four concrete security case names.

No OpenAI API, ChatGPT, IdP, Tunnel, Provider, activity database, `.env`, secret, token, cookie, or user subject is used by this lane.

## External gates

External acceptance requires new, separate authorization for each write surface. The order is fixed:

1. Verify the selected IdP project/plan supports the exact predefined public-client contract, exact MCP resource audience, standards-compatible issuer, and a publicly reachable end-user authorization/login/consent flow.
2. Create one isolated IdP API/resource and one public client using the exact redirect URI displayed by the ChatGPT management page. Do not guess the redirect.
3. Create one new private ChatGPT test App without changing the historical Descope App.
4. Write only non-secret values to an explicitly authorized Git-ignored runtime profile or isolated child-process environment.
5. Back up the activity database, migrate a copy to `0008`, and bootstrap issuer-bound owner/viewer principals through hidden input.
6. Start Readonly WebGPT and Tunnel with `REAL_PROVIDER_ENABLED=false`; verify two-user login, PKCE, audience, scope, six tools, cross-project rejection, immediate revoke, and last-owner readiness failure.
7. Compare the database logical manifest and stop all test processes.
8. Only after the isolated gate passes may a separately authorized activity-database cutover begin.

Until both users, activity-database migration, restart recovery, and bounded soak pass, status remains `PARTIAL_EXTERNAL_GATE`. Package `0.1.0-beta.5` and service `webgpt-v4.3.0` must not be claimed or published.

## Rollback

- Stop Tunnel and Readonly WebGPT first.
- Disable the new ChatGPT App and selected-provider client/resource; do not automatically delete them.
- Preserve historical Descope objects, principals, bindings, memberships, and append-only authorization events.
- Restore an activity database only from the validated migration-preflight backup and only under the authorization that permitted the cutover.
- Never recover service by weakening issuer, audience, scope, discovery, membership, or anonymous-access checks.
