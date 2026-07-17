import {
  assertReadonlyPublisherPathsIgnored,
  createReadonlyPublisherKey,
  loadReadonlyPublisherProfile,
  preflightReadonlyPublisher,
  publishReadonlySnapshot,
  ReadonlyPublisherError
} from "../src/webgpt-cloud/publisher.js";

function profilePath(): string {
  const inline = process.argv.find((value) => value.startsWith("--profile="))?.slice("--profile=".length);
  const separate = process.argv[process.argv.indexOf("--profile") + 1];
  const value = inline || (process.argv.includes("--profile") ? separate : "");
  if (!value) throw new ReadonlyPublisherError("READONLY_PUBLISHER_PROFILE_REQUIRED");
  return value;
}

function safeFailure(error: unknown): never {
  const code = error instanceof ReadonlyPublisherError ? error.code : "READONLY_PUBLISHER_FAILED";
  console.error(JSON.stringify({ ok: false, error: { code } }));
  process.exit(1);
}

async function main(): Promise<void> {
  const action = process.argv[2];
  if (!(["keygen", "preflight", "publish"] as const).includes(action as "keygen" | "preflight" | "publish")) {
    throw new ReadonlyPublisherError("READONLY_PUBLISHER_ACTION_INVALID");
  }
  const profile = loadReadonlyPublisherProfile(profilePath());
  assertReadonlyPublisherPathsIgnored(profilePath(), profile);
  if (action === "keygen") {
    const result = createReadonlyPublisherKey(profile);
    console.log(JSON.stringify({ ok: true, action, key_id: result.key_id, public_key_sha256: result.public_key_sha256 }));
    return;
  }
  if (action === "preflight") {
    const prepared = preflightReadonlyPublisher(profile);
    console.log(JSON.stringify({
      ok: true,
      action,
      key_id: profile.key_id,
      snapshot_fingerprint: prepared.snapshot.snapshot_fingerprint,
      generated_at: prepared.snapshot.generated_at,
      expires_at: prepared.snapshot.expires_at,
      project_count: prepared.snapshot.projects.length,
      principal_count: prepared.snapshot.authorization.principals.length
    }));
    return;
  }
  const result = await publishReadonlySnapshot(profile);
  console.log(JSON.stringify({ ok: true, action, ...result.receipt }));
}

main().catch(safeFailure);
