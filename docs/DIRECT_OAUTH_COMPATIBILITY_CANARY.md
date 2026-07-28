# Direct OAuth Compatibility Canary

Status: local contract implementation only. This canary is not a production
service, a deployment instruction, or authorization to change Auth0, Render,
DNS, routes, secrets, or ChatGPT configuration.

## Purpose

The canary isolates direct Streamable HTTP OAuth compatibility from the
Workbench, SQLite, Snapshots, media gateway, and Providers. It exposes exactly
one read-only `projects.read` smoke tool and returns no production data.

## Local contract

Run only with explicit process environment for the existing Readonly OAuth
contract:

```text
WEBGPT_V4_RESOURCE_URL=<exact MCP resource URL>
WEBGPT_V4_READONLY_OAUTH_ISSUER=<existing issuer>
WEBGPT_V4_READONLY_OAUTH_AUDIENCE=<must equal resource URL>
WEBGPT_V4_READONLY_OAUTH_JWKS_URI=<existing JWKS URL>
WEBGPT_V4_READONLY_OAUTH_CLIENT_REGISTRATION=predefined
```

`npm run start:direct-oauth-canary` listens on `127.0.0.1` by default. A
non-loopback listener is refused unless
`DIRECT_OAUTH_CANARY_ALLOWED_ORIGINS` supplies a comma-separated allowlist of
absolute Origins. `DIRECT_OAUTH_CANARY_HOST` and
`DIRECT_OAUTH_CANARY_PORT` are explicit process settings; this runtime never
loads a `.env` file.

Every request carrying an `Origin` header is checked before health, protected
resource metadata, authentication, or MCP processing. Requests without an
`Origin` header remain valid for non-browser MCP clients. The endpoint supports
JSON-RPC `POST`; `GET /mcp` returns `405` and `Allow: POST` because this
stateless canary does not expose a standalone SSE stream.

## Validation boundary

```bash
npm run test:webgpt:v4
```

The test covers loopback default binding, Origin rejection, non-loopback
allowlist requirement, protected-resource metadata, `GET /mcp` method behavior,
OAuth scope enforcement, the official MCP client, and source-graph isolation.

Before any public canary window, Jenn must separately authorize the exact
public origin, OAuth audience/resource, permitted Origins, callback policy,
target account, stop condition, and rollback. Record only sanitized evidence;
never record tokens, cookies, raw authorization headers, user identifiers, or
Provider payloads.
