# Readonly MCP App External Stage 3 Acceptance

Date: 2026-07-17

Result: `PASS_JENN_SINGLE_USER_MCP_APP`

## Accepted identity

- Source baseline: `main@07ad045f3b1d1ade1b2249ce256bafa2fc05385c`
- Package closeout version: `0.1.0-beta.5`
- MCP service: `webgpt-v4.3.0`
- Remote App service: `readonly-remote-v1.0.0`
- Database schema: `workbench-v2-5`
- Accepted activity-database ledger: `0008`

## Authorization and disclosure boundary

Jenn explicitly authorized stopping the local readonly WebGPT and Tunnel,
backing up and migrating the activity database, adding issuer-bound owner
authorization through hidden input, running integrity and restore checks,
publishing a signed readonly Snapshot, and completing the single-user ChatGPT
MCP App acceptance.

The acceptance did not print or retain raw OAuth subjects, tokens, cookies,
private keys, project identifiers, project titles, or business text. It did not
enable media, write tools, Provider execution, Windows automatic startup or any
paid API call. Existing legacy principal, membership and authorization events
were preserved.

## Database migration and recovery

The local readonly WebGPT and Tunnel were stopped before migration; ports 2091,
2092, 2093 and 4181 were released. Three consistent backups were retained in
the Git-ignored backup area:

- explicit pre-migration backup: `app-2026-07-17T14-18-03-723Z.sqlite`
- automatic migration backup: `app-2026-07-17T14-18-11-460Z.sqlite`
- post-migration backup: `app-2026-07-17T14-25-57-389Z.sqlite`

Migration applied only ledger entry `0008`. Legacy inbox and WebGPT history
backfills were no-ops. The old Federated principal received only its immutable
legacy issuer binding. A new Auth0 owner principal, issuer binding, membership
and append-only authorization events were created through the approved hidden
input path.

The activity database and isolated restored copy both passed `db:check` with:

- `quick_check=ok`
- current schema
- zero invalid JSON or structured drift rows
- zero orphan rows
- zero missing or invalid media files
- zero pending or quarantined media activations
- zero unbound authorization rows
- zero check errors

The isolated restored copy exactly matched the post-migration activity database:

```text
table_count=30
row_count=23
sha256=8350d42903bdc08a05eb502b94c2a8936329142600a1b936b93634e87485779a
```

The business-core manifest excluded migration and authorization governance
tables. It remained identical before migration, after migration, after restore,
after Snapshot publishing and after ChatGPT acceptance:

```text
table_count=24
row_count=5
sha256=5d7a76e7dff322d8660e52abf26dbf608aea0a1f2ba26a8b56b7abf6270566e1
```

## Snapshot and MCP App acceptance

Publisher preflight accepted one authorized production project and one principal
for the current Auth0 issuer. Signed Snapshot publication returned HTTP 202.
The publisher's before/after database manifest was identical.

The remote service returned HTTP 200 for `/healthz` and `/readyz`; OAuth,
publisher-key, Snapshot-freshness and authorization-projection checks were all
true. ChatGPT completed authenticated calls to the render tool and all six
readonly data tools. The Project Context, Shot Workbench, Review Package,
Delivery Status and Closeout Evidence panels loaded successfully without a
stable error code or database write.

Closing and reopening the ChatGPT Workbench preserved authentication and loaded
the same fresh Snapshot. A bounded 60-second soak produced five consecutive
HTTP 200 health/readiness samples with all readiness checks true. The final
Widget refresh remained authenticated and fresh.

## Accepted status and remaining limits

```text
JENN_SINGLE_USER_MCP_APP_PASS
MANUAL_PUBLISH_OPERATIONAL_READY
PARTIAL_MULTI_USER_GATE
```

- Render Free may sleep or restart, clearing the in-memory Snapshot.
- Snapshot TTL is 24 hours; restart or expiry requires manual republishing.
- The accepted activity project currently exercises the empty SHOT/Artifact
  state. Populated panel rendering remains covered by the isolated fixture
  acceptance and automated App tests.
- ChatGPT developer-mode acceptance had platform CSP enforcement disabled.
  Resource CSP behavior remains covered by automated tests, while platform
  enforcement is an external follow-up.
- A second real user, automated synchronization, automatic startup, public
  media, write tools and Provider canary remain outside this acceptance.

No tag, package publication, release or additional deployment was performed.
