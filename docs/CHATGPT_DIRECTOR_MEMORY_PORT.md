# ChatGPT Director Memory Port

Status: `CANDIDATE` — PR6 local contract only. The default port is disabled. This document does not configure, call, or depend on a memory plugin; it does not migrate the activity database, deploy a runtime, modify OAuth, or enable a Provider.

## Purpose

The Director needs carefully bounded historical experience without confusing it with the Workspace's current production facts:

```text
current Workspace facts
  -> Director Focus and authoritative target state
  -> injected advisory Memory Recall Port (disabled by default)
  -> ChatGPT discussion context
  -> immutable advisory Proposal
  -> Human Workbench decision
  -> non-dispatched Saveback envelope
  -> future separately accepted stable memory plugin
```

The Workspace remains authoritative for Projects, SHOTs, Artifacts, Runs, Review, Delivery and Closeout. A future memory system may provide only reusable preferences, confirmed decisions and failure patterns; it cannot approve a Proposal, create an Automation Grant, start a Provider job, overwrite an Artifact or alter the current Project state.

## Recall contract

`DirectorMemoryPort` is an injected interface, not an MCP tool and not a runtime environment configuration. `DirectorLocalService` uses a disabled in-process implementation unless a future integration explicitly injects a port.

Each recall request binds all of the following before any item can enter the public Director context:

- fixed workspace `jenn-ai-video-workspace`;
- opaque principal hash;
- normalized issuer hash;
- current Focus project ID;
- requested Proposal kind.

The port response must echo each binding exactly and use `director-memory-port-v1`. A project-scoped item may name only the exact requested project. A workspace-scoped item must name no source project. The local boundary strips the source-project identifier before returning the public context, so ChatGPT receives only category, bounded summary/evidence and scope.

The bounded public recall states are:

```text
disabled     default; no integration exists
empty        a reachable port found no applicable experience
ready        one to twelve verified, bound advisory items
unavailable  malformed, mismatched or failed port; no items disclosed
```

Malformed input, a thrown or stalled port (two-second recall budget), incorrect principal/issuer/project echo, a cross-project item, or an invalid shape becomes data-free `unavailable`. It never falls back to another project, an unscoped query, local filesystem search, SQLite history scan or a generic ChatGPT memory feature.

## Saveback boundary

`prepareDirectorMemorySavebackEnvelope` only prepares a portable envelope from a previously reviewed proposal. The envelope binds the same opaque principal, issuer hash and project as the accepted proposal. It returns:

```text
dispatch_state: awaiting_external_confirmation
requires_human_confirmation: true
```

It performs no filesystem, network, database or Provider operation. There is no automatic memory commit, no background retry and no hidden credential lookup. A future stable plugin integration must receive a separate external authorization, own its credential/configuration boundary, preserve project/issuer scoping and record its own acceptance evidence.

## Operations and future external gate

The candidate contract intentionally has no `.env` keys, client ID, token, plugin endpoint, user identity, database migration or scheduled task. Before a stable replacement plugin can be connected, a separate external gate must establish:

1. exact plugin version and its public data/security contract;
2. project and issuer binding parity with this port;
3. recall-only fixture acceptance, including cross-project rejection;
4. a separately confirmed Saveback dispatch path and audit receipt;
5. failure/kill-switch behavior that returns `unavailable` without blocking current Workspace facts.

Until that gate is accepted, Director continues to operate with `memory_recall: { state: "disabled", items: [] }`.

## Validation

```text
npm run test:webgpt:director
npm run test:selection-gate
```

The mandatory tests prove exact request/response binding, cross-project fail-closed behavior, disabled default behavior, source-project stripping, and a non-dispatched Saveback envelope. They are selected by canonical `npm test` and Windows CI.
