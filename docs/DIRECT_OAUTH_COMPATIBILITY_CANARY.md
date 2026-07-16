# Direct OAuth Compatibility Canary

Status: local implementation and contract tests only. No public deployment or external Auth0/ChatGPT mutation is authorized by this document.

## Purpose

This P0 control experiment keeps the verified Readonly OAuth contract and changes one hosting variable:

```text
Secure MCP Tunnel endpoint
  -> direct public HTTPS /mcp endpoint
```

It reuses the repository's Federated Readonly configuration parser, JWT verifier, protected-resource metadata generator, `WWW-Authenticate` generator, and OAuth tool security scheme. The runtime has no SQLite, Snapshot, Workbench UI, media, or Provider dependency.

Official OpenAI requirements used by the canary:

- [Authentication](https://developers.openai.com/apps-sdk/build/auth)
- [Connect from ChatGPT](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt)

## Runtime surface

The canary exposes only:

```text
GET  /healthz
GET  /.well-known/oauth-protected-resource
GET  /.well-known/oauth-protected-resource/mcp
POST /mcp
```

The path-aware metadata endpoint is the canonical challenge target when the resource identifier ends in `/mcp`. The root endpoint is a compatibility alias containing the same metadata.

The MCP server advertises exactly one read-only tool:

```text
get_direct_oauth_smoke_status
```

Its only scope is `projects.read`. A successful result confirms authentication and returns static boundary facts; it returns no project identifiers, business content, Snapshot data, file paths, media, or Provider state.

## Local commands

The runtime intentionally does not load `.env`. Supply the same explicit process environment used by the approved Readonly configuration:

```text
WEBGPT_V4_RESOURCE_URL=<exact direct public HTTPS /mcp URL>
WEBGPT_V4_READONLY_OAUTH_ISSUER=<existing Auth0 issuer>
WEBGPT_V4_READONLY_OAUTH_AUDIENCE=<must equal WEBGPT_V4_RESOURCE_URL>
WEBGPT_V4_READONLY_OAUTH_JWKS_URI=<existing Auth0 JWKS URI>
WEBGPT_V4_READONLY_OAUTH_CLIENT_REGISTRATION=predefined
PORT=<hosting port, optional locally>
```

Run:

```text
npm run test:webgpt:direct-canary
npm run start:webgpt:direct-canary
```

## Fail-closed behavior

- Missing or ambiguous Readonly OAuth configuration prevents startup.
- Anonymous or invalid tokens receive `401` plus the repository-standard PRMD challenge.
- Missing `projects.read` receives `403` plus `insufficient_scope`.
- Unknown routes return `404`.
- There is no `/readyz`, database fallback, anonymous tool mode, media port, UI resource, Snapshot endpoint, or Provider path.

## External preflight and authorization boundary

Before public execution, record and authorize all of the following as one bounded canary window:

1. One isolated direct HTTPS service and its exact immutable origin.
2. The exact resource/audience value `<origin>/mcp`.
3. The existing Auth0 tenant/issuer/JWKS and the exact API/client objects to reuse or minimally extend.
4. One ChatGPT developer-mode test App using the direct `<origin>/mcp` URL and predefined public Client ID.
5. The exact callback addition, if ChatGPT generates a callback not already allowed.
6. No SQLite path, Snapshot signing key, media origin, Provider credential, or production tool configuration.
7. A stop condition and rollback that disable only the canary service/App and remove only callback/API changes created for this experiment.

Do not deploy until the direct origin is known: the resource URL, JWT audience, PRMD `resource`, and `resource_metadata` challenge must all be derived from that exact value.

## Evidence capture

Record only non-secret evidence:

```text
public MCP origin
health HTTP status
PRMD HTTP status and field-presence booleans
ChatGPT OAuth-field presence/absence
failure stage: discovery | client | callback | token | tool
tool list count and name
smoke tool success/failure
timestamps and sanitized stable error codes
```

Never record tokens, cookies, subjects, user identifiers, Auth0 secrets, raw headers containing credentials, or tool request bodies.

## Decision matrix

| Result | Interpretation |
| --- | --- |
| Direct connection shows normal OAuth configuration | Strong evidence that the compatibility break is in the Tunnel-hosted chain. |
| Direct connection still shows empty OAuth fields | The current PRMD/Auth0 contract is more likely rejected by the Connector itself. |
| OAuth fields appear but login fails | Discovery passed; investigate predefined client, callback, authorization, or token exchange. |
| Login and smoke tool both pass | The direct public HTTPS route is established as the viable OAuth transport. |

This canary does not establish production readiness and must not be expanded into the six production tools or MCP App Workbench in the same change.
