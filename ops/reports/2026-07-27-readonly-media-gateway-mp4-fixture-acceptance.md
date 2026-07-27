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

## Tunnel transport evidence

```text
Selected TUNNEL_TRANSPORT_PROTOCOL: auto
Final edge transport:              not captured
Transport attribution:             not accepted
```

The managed fixture status recorded the non-secret selected protocol as `auto`.
It did not retain a low-disclosure observation that the connected edge session
was QUIC/UDP or HTTP2/TCP. Public instance health therefore proves only this
fixture's route and local-instance binding; it does not attribute success to a
particular transport. A future transport acceptance must record the selected
protocol and an actual final QUIC or TCP connection classification.

## Result

```text
READONLY_MEDIA_GATEWAY_FIXTURE_MP4_PLAYBACK_PASS
```

The tested sequence was:

```text
isolated signed Unified Snapshot
  -> local Gateway ready
  -> Cloudflare public instance health
  -> ChatGPT Widget MP4 playback
  -> one forward seek interaction
  -> fixture shutdown
  -> managed default runtime and fresh real Snapshot restoration
```

## Verified boundaries

- The fixture used a copied MP4 and Git-ignored generated profiles, keeping its
  test data separate from the activity database and preserving the source media.
- The public route was accepted only after local readiness and instance-bound
  public health succeeded. Its selected `auto` protocol is recorded above; the
  final QUIC/TCP classification is intentionally not inferred from health.
- The ChatGPT Widget reached playable video state and a forward seek remained
  playable, exercising the capability/session path end to end. No new
  `206`/`Content-Range` response was captured, so this is not byte-range
  acceptance.
- The exact ChatGPT Workspace sandbox origin was accepted by the code-owned
  production-origin allowlist; no wildcard origin was enabled.
- The fixture Gateway/Tunnel was stopped after the test. The managed default
  Gateway/Tunnel and a fresh real activity Snapshot were restored.
- A read-only activity-database check passed after restoration. That check
  verifies schema and integrity constraints only; it is not a business-data
  unchanged assertion.
- Fixture creation performed the expected isolated-database registrations for
  its storyboard and MP4 Artifacts. During the public playback and activity
  restoration phase, Provider calls, activity-database Artifact writes,
  delivery actions, Auth0/DNS changes, automatic publishing and Windows
  Scheduled Task installation were all zero.

## Non-claims and remaining gates

- This did not test an actual byte-range `206`/`Content-Range` response, image
  or WebM playback, capability expiry/replay, membership revocation, project
  switching, or Gateway-offline recovery.
- This did not establish whether the accepted route used QUIC/UDP or HTTP2/TCP
  at the Cloudflare edge.
- It did not validate a Windows logon task, restart persistence or a bounded
  recovery soak.
- No before/after activity-database logical-manifest comparison was captured
  for this fixture/restore sequence. This report therefore does not claim that
  its activity business data was unchanged.
- The real activity Snapshot was restored, but its media bytes were not used as
  a substitute for the isolated fixture in this acceptance.
- The Media Gateway remains a manual, separately authorized operation. No
  package, service or version promotion follows from this report.
