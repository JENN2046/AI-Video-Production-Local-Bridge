# ChatGPT Director Provider Capability & Quote Contract

Status: `CANDIDATE` — local code contract only. It neither enables a Provider nor changes an external Provider, Auth0, Render, or activity-database configuration.

## Purpose

ChatGPT may describe a storyboard revision or clip-regeneration proposal. It must never select an unverified model, invent a price, or carry a Provider credential. The local Human Workbench independently resolves execution policy:

```text
advisory Proposal
  -> verified ProviderCapability
  -> current local quote and balance preflight
  -> human compile of an immutable Automation Grant
```

## Capability registry

Each Director capability has an immutable reference over a shared provider capability record and declares:

- Provider, model, supported duration, resolution and aspect-ratio rules;
- allowed automation actions and maximum automatic retries;
- quote freshness requirement and official preflight/balance requirement;
- verification status.

Only `verification=verified` capabilities can compile a new Grant. The current local registry verifies the existing RunningHub image-to-video route. The Runway record is deliberately a `candidate`: it provides no executable path until a separate capability/quote canary produces evidence. The Director code never treats a candidate model string as verified.

Historical RunningHub Grants and Proposal records remain readable. They are not rewritten. A legacy Provider/model declaration is checked against the selected verified capability during a new compile and cannot override it.

## Quote boundary

The Workbench reads the existing local `webgpt_provider_price_cache` only when all of the following match the selected capability:

- Provider/model/duration/resolution key;
- versioned official-preflight source;
- recognized currency;
- unexpired cache value;
- freshness maximum of ten minutes.

Any missing, expired, stale, malformed or capability-drifted row blocks compilation with a stable error such as `DIRECTOR_QUOTE_REQUIRED`, `DIRECTOR_QUOTE_EXPIRED`, or `DIRECTOR_PROVIDER_CAPABILITY_DRIFT`.

ChatGPT's discussion context receives only:

```text
quote_state
expires_at
currency
requires_human_refresh
```

It never receives a numeric quote, budget, balance, capability reference, credential, or Provider response. The Workbench alone compares the verified quote against the human-entered per-run and total budget caps.

## Execution boundary

`REAL_PROVIDER_ENABLED=false` remains the default and must reject before a Provider request. This contract does not alter the existing execution adapter or make Runway executable. A real Provider canary, quote validation and bounded spend authorization remain independent external gates.

## Validation

```text
npm run test:webgpt:director
npm run test:selection-gate
```

The mandatory Director lane covers verified-only selection, candidate rejection, quote missing/stale/drift rejection, cost redaction, budget enforcement and no-Provider Grant compilation.
