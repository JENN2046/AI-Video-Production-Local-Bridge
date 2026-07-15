# Stytch Predefined Public Client — Readonly Runbook

Status: `CAPABILITY_FIXTURE_ONLY`

This runbook records the selected PR3 fallback after `AUTH0_CAPABILITY_GATE_FAILED`. It is not authority to create a Stytch project, Connected App, ChatGPT App, Tunnel association, runtime profile, or database authorization record.

## Required external shape

Before any object is created, confirm the target Stytch plan/project can provide this exact shape:

```text
client type: third_party_public (or the current equivalent public-client type)
grant: authorization_code only
PKCE: S256
token endpoint auth: none
client registration: predefined
scope: projects.read only
redirect URI: exact URI displayed by the target ChatGPT App
client secret: absent
client credentials: disabled
access token custom audience: exact WEBGPT_V4_RESOURCE_URL
```

Stytch terminology and APIs may change. Current official references describe `third_party_public`, PKCE, custom OAuth scopes, and `access_token_custom_audience`; the external preflight must re-check the current project rather than copying this document blindly.

## Fail-closed capability preflight

Stop with `SELECTED_PROVIDER_CAPABILITY_GATE_FAILED` if any item is false or cannot be verified:

- anonymous standard discovery returns exact issuer metadata;
- authorization/token/JWKS endpoints are HTTPS;
- PKCE advertises S256;
- public-client token authentication supports `none`;
- the client has no secret and cannot use client credentials;
- the redirect allowlist accepts the exact ChatGPT callback without a wildcard;
- the resource/API defines only `projects.read` for this App;
- a token issued for the MCP resource has exact `aud === WEBGPT_V4_RESOURCE_URL`;
- `projects.read` appears in standard `scope` or compatible `scp`;
- JWT `iss` and `jwks_uri` exactly match the configured values.

Do not compensate for a failed item by changing WebGPT issuer/audience checks, accepting `permissions`, adding broad scopes, using a confidential client, or bypassing discovery.

## Isolated acceptance order

1. Record non-secret object names and IDs in a local, ignored acceptance worksheet.
2. Create the resource/API and only `projects.read`.
3. Create the predefined public client with the exact ChatGPT redirect.
4. Configure exact custom audience equal to the Tunnel-visible MCP resource.
5. Create a new private ChatGPT test App; leave historical Descope objects unchanged.
6. Use a database copy migrated to `0008`; enter subjects only through hidden prompts.
7. Verify owner, unregistered second user, viewer grant, cross-project refusal, revoke, and last-owner fail-closed readiness.
8. Call exactly the six Readonly tools and compare the complete logical manifest.
9. Stop WebGPT/Tunnel and confirm ports `2091`, `2092`, and `2093` are released.

## Evidence rules

Allowed evidence is limited to sanitized capability booleans, non-secret object IDs, HTTP status, stable error codes, tool names, row-count/hash summaries, and timestamps. Do not record or print tokens, cookies, subjects, emails, authorization codes, client secrets, JWT bodies, database rows, business content, or provider payloads.

## Rollback

Disable the new ChatGPT App and Stytch client/resource association, stop local processes, and preserve evidence. Do not delete historical Descope objects or authorization history. Database rollback uses only the separately authorized, validated pre-migration backup.
