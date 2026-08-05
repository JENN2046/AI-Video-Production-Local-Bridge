import { scanS3bT2Eligibility, s3bT2ExitCode } from "../src/tools/s3bT2Eligibility.js";

if (process.argv.length !== 2) {
  const receipt = {
    schema_version: "s3b-t2-eligibility-receipt-v1",
    result: "T2_READ_ONLY_BOUNDARY_VIOLATION",
    eligible_candidate_count: 0,
    reason_code_counts: {},
    read_only_proof: { sqlite_total_changes: 0, network_calls: 0, credential_reads: 0, media_writes: 0 }
  } as const;
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  process.exitCode = 1;
} else {
  const receipt = await scanS3bT2Eligibility();
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  process.exitCode = s3bT2ExitCode(receipt.result);
}
