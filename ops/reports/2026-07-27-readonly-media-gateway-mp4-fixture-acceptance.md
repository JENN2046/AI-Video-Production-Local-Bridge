# Readonly Media Gateway MP4 Fixture Acceptance

Date: 2026-07-27
Scope: one bounded, isolated MP4 fixture acceptance through the Unified
ChatGPT Workspace Widget. This report is evidence for this exact test boundary;
it is not a general Media Gateway production-readiness claim.

## Tested identity

```text
Repository commit:        main@2b84f447c1d85eaf5f96c4da6cf0d81080332131
Media Gateway contract:   readonly-media-gateway-v1.0.0
Snapshot contract:        readonly-snapshot-v4
Remote deployment source: main@2b84f447c1d85eaf5f96c4da6cf0d81080332131
```

The deployed Remote and the local Gateway used this same source identity for
the bounded fixture run. Later commits do not inherit this PASS without their
own acceptance evidence.

## Result

```text
READONLY_MEDIA_GATEWAY_FIXTURE_MP4_PLAYBACK_RANGE_SEEK_PASS
```

The tested sequence was:

```text
isolated signed Unified Snapshot
  -> local Gateway ready
  -> Cloudflare public instance health
  -> ChatGPT Widget MP4 playback
  -> one forward Range/seek
  -> fixture shutdown
  -> managed default runtime and fresh real Snapshot restoration
```

## Verified boundaries

- The fixture used a copied MP4 and Git-ignored generated profiles; it did not
  overwrite the source media or the activity database.
- The public route was accepted only after local readiness, edge evidence and
  instance-bound public health succeeded.
- The ChatGPT Widget reached playable video state and the forward seek remained
  playable, exercising the capability/session and byte-range path end to end.
- The exact ChatGPT Workspace sandbox origin was accepted by the code-owned
  production-origin allowlist; no wildcard origin was enabled.
- The fixture Gateway/Tunnel was stopped after the test. The managed default
  Gateway/Tunnel and a fresh real activity Snapshot were restored.
- A read-only activity-database check passed after restoration.
- Provider calls, Artifact writes, delivery actions, Auth0/DNS changes,
  automatic publishing and Windows Scheduled Task installation were all zero.

## Non-claims and remaining gates

- This did not test image or WebM playback, capability expiry/replay,
  membership revocation, project switching, or Gateway-offline recovery.
- It did not validate a Windows logon task, restart persistence or a bounded
  recovery soak.
- The real activity Snapshot was restored, but its media bytes were not used as
  a substitute for the isolated fixture in this acceptance.
- The Media Gateway remains a manual, separately authorized operation. No
  package, service or version promotion follows from this report.
