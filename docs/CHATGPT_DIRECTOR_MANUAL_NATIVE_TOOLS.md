# ChatGPT Director Manual/Native Tool Contract

Status: `CANDIDATE` — PR2 contract plus PR3 isolated runtime implementation. No Director endpoint is deployed, no Provider call is enabled, and Jenn's activity database is not migrated by this document.

## Purpose

PR2 freezes the smallest ChatGPT-native Director surface while keeping manual import as a separately confirmed fallback:

```text
ChatGPT native MCP tools
  -> authenticated Director resource
  -> later authenticated local bridge
  -> immutable advisory Proposal
  -> Human Workbench review

Manual fallback
  -> explicit user-confirmed import
  -> source=untrusted_manual_import
  -> same immutable Proposal validator
```

ChatGPT remains the reasoning surface. This route does not call the OpenAI API, Responses API or Agents SDK.

## Fixed native tool set

The Director resource registers exactly five tools:

| Tool | OAuth scopes | Effect |
| --- | --- | --- |
| `get_director_focus` | `projects.read` | Read the current Workbench-selected Focus for the authenticated principal. |
| `get_director_context` | `projects.read` | Read the project/target/generation-bound discussion context. |
| `inspect_director_video_frames` | `projects.read media.read` | Read a bounded timestamped frame sequence for the Focus-bound video Artifact. PR3 supplies the zero-database-write implementation. |
| `submit_director_proposal` | `projects.read proposals.write` | Create an immutable advisory Proposal for Human Workbench review. It cannot approve or execute it. |
| `get_director_proposal_status` | `projects.read` | Read one same-principal Proposal status. |

All five tools are model-visible and have no Widget output template. The four read/compute tools use `readOnlyHint=true`. Proposal submission is non-destructive, bounded, idempotent and uses `readOnlyHint=false`.

Every successful structured result is bounded to 128 KiB. A valid result that exceeds the budget fails closed with `RESPONSE_BUDGET_EXCEEDED`; it is never silently truncated. Missing per-tool scopes return an MCP tool error with `_meta["mcp/www_authenticate"]`, so ChatGPT can request the exact missing `media.read` or `proposals.write` authorization instead of receiving a generic failure.

The registry never exposes approval, Provider submission, clip adoption, delivery confirmation, memory commit, Artifact deletion or Storyboard Package overwrite tools. Existing WebGPT Full tools are not inherited by the Director resource.

## Input authority

The native Proposal input contains only:

- current `focus_id` and `focus_generation`;
- current `base_state_hash`;
- a caller idempotency key;
- an optional parent Proposal identifier;
- the strict kind-specific Proposal draft.

The authenticated local bridge—not ChatGPT—assigns principal, workspace, project, target, source, proposal identifier, payload hash and creation time. PR3 rebuilds current authoritative target state and rejects Focus or base-state drift before persistence.

`get_director_context` requires an explicit `proposal_kind`. The proposal kind is part of the authoritative target state and its hash, so one Focus cannot silently reuse a context hash for a different advisory Proposal kind.

Manual imports must be explicitly confirmed and must retain `source=untrusted_manual_import`. A manual document can never be promoted to native evidence by changing a label.

## Separate OAuth resource

Director uses a resource/audience distinct from the accepted Readonly MCP App:

```text
WEBGPT_DIRECTOR_RESOURCE_URL
WEBGPT_DIRECTOR_OAUTH_ISSUER
WEBGPT_DIRECTOR_OAUTH_AUDIENCE
WEBGPT_DIRECTOR_OAUTH_JWKS_URI
WEBGPT_DIRECTOR_OAUTH_CLIENT_REGISTRATION
```

All five keys are all-or-nothing. URLs are credential-free HTTPS identifiers without query or fragment. Audience must equal resource exactly. If `WEBGPT_V4_RESOURCE_URL` is present, the Director resource must differ from it.

PRMD advertises exactly:

```text
projects.read
media.read
proposals.write
```

The fixed catalog carries each tool's exact narrower scope list. PR3 serializes it through both the host-visible standard `securitySchemes` field and the compatibility `_meta.securitySchemes` field used by the accepted App runtime. Runtime challenge URLs are derived from the Director resource path. Per the current Apps SDK authentication contract, deployment must provide PRMD, per-tool security schemes and runtime `WWW-Authenticate`/`mcp/www_authenticate` together.

## PR3 implementation

PR3 adds a public Director HTTP runtime, an authenticated outbound-only local bridge, issuer-bound Focus/context lookup, bounded FFmpeg frame extraction with model-visible images, and immutable native Proposal persistence. The complete boundary and operator contract is documented in [ChatGPT Director Local Bridge](CHATGPT_DIRECTOR_LOCAL_BRIDGE.md).

## Deferred to PR4+

- Human Workbench approval queue;
- compilation, Automation Grant execution, Provider submission and memory adapters.

Until external configuration and the later Human/Orchestrator gates pass, the registry and runtime remain an implementation candidate, not an externally usable Director App.
