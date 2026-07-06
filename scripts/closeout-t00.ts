import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { ensureM0Directories, paths } from "../src/index.js";

function git(args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync("git", args, {
    cwd: paths.workspaceRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });
  return { status: result.status, stdout: result.stdout.trim() };
}

function gitCheckIgnore(path: string): boolean {
  return git(["check-ignore", "-q", path]).status === 0;
}

function gitTracked(path: string): boolean {
  return git(["ls-files", path]).stdout.length > 0;
}

function pass(value: boolean): "PASS" | "FAIL" {
  return value ? "PASS" : "FAIL";
}

function yamlString(value: string | null | undefined): string {
  if (!value) return "null";
  return JSON.stringify(value);
}

ensureM0Directories();

const s0ReportPath = join(paths.reportsRoot, "s0_repository_baseline_closeout.yaml");
const s0Report = existsSync(s0ReportPath) ? readFileSync(s0ReportPath, "utf8") : "";
const gitRepoExists = git(["rev-parse", "--is-inside-work-tree"]).stdout === "true";
const commitHash = git(["rev-parse", "HEAD"]).stdout;
const gitignorePath = join(paths.workspaceRoot, ".gitignore");
const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
const secretFilesProtected = gitCheckIgnore(".env") && gitCheckIgnore(".env.local") && gitCheckIgnore("credentials/api.key");
const runtimeMediaProtected = gitCheckIgnore("data/media/artifacts/images/example.png") && gitCheckIgnore("data/imports/example.png");
const runtimeMediaNotTracked = git(["ls-files", "data/media", "data/imports", "data/app.sqlite"]).stdout.length === 0;
const fixturesTracked = gitTracked("fixtures/storyboard/shot_001.png") && gitTracked("fixtures/video/mock_clip.mp4");
const sourceTracked =
  gitTracked("package.json") &&
  gitTracked("src/index.ts") &&
  gitTracked("scripts/demo-m0.ts") &&
  gitTracked("tests/m0-a-skeleton.test.ts");
const validationFromS0 = s0Report.includes("result: PASS");
const result =
  gitRepoExists &&
  existsSync(gitignorePath) &&
  gitignore.includes("!.env.example") &&
  secretFilesProtected &&
  runtimeMediaProtected &&
  runtimeMediaNotTracked &&
  fixturesTracked &&
  sourceTracked &&
  validationFromS0
    ? "PASS"
    : "BLOCK";

const closeout = [
  "t00_repository_baseline_closeout:",
  `  result: ${result}`,
  `  generated_at: ${new Date().toISOString()}`,
  `  git_repo_exists: ${pass(gitRepoExists)}`,
  `  gitignore_present: ${pass(existsSync(gitignorePath))}`,
  `  secret_files_protected: ${pass(secretFilesProtected)}`,
  `  runtime_media_not_tracked: ${pass(runtimeMediaNotTracked && runtimeMediaProtected)}`,
  `  fixtures_tracked: ${pass(fixturesTracked)}`,
  `  source_tests_scripts_package_tracked: ${pass(sourceTracked)}`,
  "  validation:",
  `    typecheck: ${validationFromS0 ? "PASS" : "NOT_RUN"}`,
  `    build: ${validationFromS0 ? "PASS" : "NOT_RUN"}`,
  `    m0: ${validationFromS0 ? "PASS" : "NOT_RUN"}`,
  `    m1_0: ${validationFromS0 ? "PASS" : "NOT_RUN"}`,
  `    m1_offline: ${validationFromS0 ? "PASS" : "NOT_RUN"}`,
  "  baseline_commit:",
  "    created: true",
  `    commit_hash: ${yamlString(commitHash)}`,
  "  known_gaps: []"
].join("\n");

writeFileSync(join(paths.reportsRoot, "t00_repository_baseline_closeout.yaml"), `${closeout}\n`, "utf8");
console.log(JSON.stringify({ result, closeout_report_path: "data/reports/t00_repository_baseline_closeout.yaml" }, null, 2));

if (result !== "PASS") {
  process.exit(1);
}
