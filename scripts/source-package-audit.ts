import { auditArchivePackage, auditTrackedSource, writeSourceAuditReport } from "../src/tools/sourceAudit.js";

const archivePath = process.argv[2];
const report = archivePath ? auditArchivePackage(archivePath) : auditTrackedSource();
const reportPath = writeSourceAuditReport(report);

console.log(
  JSON.stringify(
    {
      result: report.result,
      report_path: reportPath,
      archive_path: report.archive_path,
      finding_count: report.findings.length,
      checks: report.checks
    },
    null,
    2
  )
);

if (report.result !== "PASS") process.exitCode = 1;
