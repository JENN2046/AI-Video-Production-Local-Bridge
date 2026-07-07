import { cleanSourceExport } from "../src/tools/sourceAudit.js";

const outputFlagIndex = process.argv.indexOf("--out");
const outputPath = outputFlagIndex >= 0 ? process.argv[outputFlagIndex + 1] : undefined;
const result = cleanSourceExport(outputPath);

console.log(
  JSON.stringify(
    {
      result: result.report.result,
      output_zip_path: result.report.output_zip_path ?? null,
      sha256_path: result.report.sha256_path ?? null,
      finding_count: result.report.findings.length,
      checks: result.report.checks,
      error: result.error ?? null
    },
    null,
    2
  )
);

if (!result.ok) process.exitCode = 1;
