# External Multi-User Readonly Connection — Preflight

Status: prepared; no external or local authorization state changed

Baseline: `main@385144d`, package `0.1.0-beta.4`, MCP service `webgpt-v4.2.0`

Profile: `readonly`

## Decision

Use a Descope **MCP Server Resource** and an associated **Agentic Client** for the ChatGPT connection. Prefer Client ID Metadata Documents (CIMD), keep Dynamic Client Registration (DCR) as a compatibility fallback, and use a pre-registered public client only if the target ChatGPT connection cannot complete CIMD or DCR.

Do not use a Console-created confidential Inbound App as the default ChatGPT client. Descope documents that Console-created Inbound Apps are confidential, while ChatGPT's interactive MCP OAuth flow uses authorization code with PKCE and supports public clients. Descope's current MCP model associates Agentic Clients with MCP Server Resources and supports CIMD, DCR, and pre-registration.

Public references:

- [OpenAI Apps SDK authentication](https://developers.openai.com/apps-sdk/build/auth)
- [Connect an app from ChatGPT](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt)
- [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Descope MCP client registration methods](https://docs.descope.com/agentic-identity-hub/core-components/mcp-servers/registration-methods)
- [Descope OAuth resource management](https://docs.descope.com/resources/managing-resources)

## Fixed security contract

The external connection must preserve all of these invariants:

- OAuth resource identifier is the final ChatGPT-visible MCP resource URI ending in `/mcp`.
- `WEBGPT_V4_RESOURCE_URL` and `WEBGPT_V4_DESCOPE_AUDIENCE` are identical to that resource identifier.
- The same RFC 8707 `resource` value is used on authorization and token requests and appears in the access-token audience.
- Descope JWT issuer and explicit HTTPS JWKS URI match the issued access token. `WEBGPT_V4_DESCOPE_AUTHORIZATION_SERVER_URL` is the resource-specific agentic discovery base and may differ from that issuer; it must resolve to metadata that advertises DCR and PKCE S256.
- Authorization code with PKCE S256 is enabled; client credentials is not used for an end-user connector.
- The only granted and advertised application scope is `projects.read`.
- MCP Protected Resource Metadata is reachable at the path-aware URL `/.well-known/oauth-protected-resource/mcp`.
- Tokens are validated for signature, issuer, audience, expiry, and scope on every request.
- Authentication alone grants no project access. Local explicit production-project membership remains authoritative.
- The Readonly profile exposes exactly six tools and does not start the media listener.
- `REAL_PROVIDER_ENABLED=false`; no write scope, media scope, public media route, automatic startup, or Provider call is introduced.

## External object checklist

No value in this checklist is permission to create or change an object.

The phases below are ordered. Do not begin ChatGPT app discovery before local owner readiness and the Tunnel are healthy.

### Phase A — Descope resource and client capability

1. Select the target Descope project.
2. Create or select one MCP Server Resource whose URL is the final MCP resource URI.
3. Define only `projects.read` on that Resource.
4. Enable CIMD for the MCP server and verify the authorization-server metadata advertises `client_id_metadata_document_supported=true`.
5. Keep DCR disabled unless the ChatGPT connection proves CIMD is unavailable. If DCR is required, restrict approved scopes to `projects.read` and approved redirects to the exact ChatGPT callback pattern.
6. If a pre-registered client is required, create it as non-confidential/public with token endpoint authentication `none`, authorization code, and PKCE S256. Do not create it through the Console path that produces a confidential client.
7. Associate the Agentic Client with only this MCP Server Resource and only `projects.read`.
8. Configure a consent/login flow that cannot silently add scopes.

### Phase B — Local owner readiness

1. Keep all secret values in ignored local secret storage. Do not print, copy, commit, or include them in receipts.
2. Write only the non-secret values required by `.env.example`: resource URL, issuer, audience, and JWKS URI.
3. Run `npm run preflight -- --profile=webgpt` with `WEBGPT_V4_PROFILE=readonly` and `REAL_PROVIDER_ENABLED=false`.
4. Start WebGPT and verify `/healthz=200`, canonical PRMD `=200`, anonymous `/mcp=401`, and `/readyz=503` until an active owner exists.
5. Under a separate database-write authorization, back up the activity database and run `npm run auth:webgpt:bootstrap-owner -- -DatabasePath <path> -Issuer <https-issuer> -ProjectId <production-project-id>`.
6. Enter the Descope subject only in the hidden prompt; the helper derives the issuer-bound principal and performs the atomic owner bootstrap without printing or persisting the raw subject.
7. Verify `/readyz=200`. Do not attempt ChatGPT discovery while readiness is `503`.

### Phase C — OpenAI Platform and Tunnel

1. Confirm the target Platform organization and target ChatGPT workspace before any write.
2. Associate the existing or newly approved Tunnel with both targets.
3. Use a runtime API key with Tunnel Read + Use only; creation or editing requires a separately scoped management credential.
4. Run `tunnel-client doctor`, start the Tunnel, and verify its health endpoint before creating the ChatGPT app.

### Phase D — ChatGPT app and discovery

1. In ChatGPT Developer mode, create a private app using **Tunnel**, not a public MCP URL.
2. If the selected registration mode requires an approved redirect, copy the exact callback URI presented by ChatGPT into Descope and then resume connection. Do not guess a callback ID.
3. Confirm discovery shows exactly the six Readonly tools before connecting the first user.

## Multi-user golden path

The external gate passes only when two real users are tested without disclosing their raw identity claims:

1. Owner authenticates and sees only explicitly assigned production projects.
2. Viewer authenticates and sees only explicitly assigned production projects.
3. An authenticated but unregistered principal receives `WEBGPT_PRINCIPAL_NOT_REGISTERED`.
4. Cross-project project, SHOT, Artifact, review, delivery, and closeout identifiers remain hidden as `PROJECT_NOT_FOUND` or the corresponding bound-object failure.
5. `tools/list` is exactly the six Readonly tools for both users.
6. No media resource, Widget resource, write tool, generation action, Provider request, or database business mutation occurs.
7. Revoking a membership takes effect immediately; revoking or disabling the last owner makes readiness fail closed.
8. The activity-database logical manifest is unchanged except for the explicitly authorized principal, membership, and append-only authorization event records.

## Stop conditions and rollback

Stop immediately if discovery advertises extra scopes, the token audience differs from the Resource, the client requires a stored secret in ChatGPT, anonymous MCP succeeds, an unassigned project is visible, readiness ignores owner state, or any media/write/Provider surface appears.

Rollback order:

1. Stop `tunnel-client`.
2. Disable the ChatGPT app connection.
3. Revoke the local project membership or disable the principal; preserve append-only events.
4. Disable the Descope Agentic Client or its Resource association.
5. Stop WebGPT.
6. Restore the database only if the separately authorized database procedure failed and its preflight explicitly calls for restoration.

Do not delete the Descope Resource, authorization evidence, activity database, or Tunnel as an automatic rollback action.

## Next authorization gate

The next execution authorization must name the target Descope project, Platform organization, ChatGPT workspace, Tunnel, and registration mode. It must separately authorize:

- external Descope/Platform/ChatGPT/Tunnel writes;
- ignored local OAuth/Tunnel configuration writes without reading or printing secrets;
- activity-database backup and first-owner bootstrap;
- a two-user Readonly golden-path test.

That authorization does not include Full/Auth0, write scopes, public media, Windows automatic startup, Provider canary, release, or deployment.
