Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$smokeRoot = Join-Path $workspaceRoot "ops\tools\windows-runtime-smoke"
$runtimeRoot = Join-Path $smokeRoot "runtime"
$dataRoot = Join-Path $smokeRoot "data"
$databasePath = Join-Path $dataRoot "app.sqlite"
$smokePort = 43181

if (Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort $smokePort -State Listen -ErrorAction SilentlyContinue) {
  throw "WINDOWS_RUNTIME_SMOKE_PORT_IN_USE: $smokePort"
}
if (Test-Path -LiteralPath (Join-Path $runtimeRoot "workbench-state.json")) {
  throw "WINDOWS_RUNTIME_SMOKE_STATE_EXISTS: inspect before retrying"
}

$resolvedSmokeRoot = [System.IO.Path]::GetFullPath($smokeRoot)
$workspacePrefix = $workspaceRoot.TrimEnd('\') + '\'
if (-not $resolvedSmokeRoot.StartsWith($workspacePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "WINDOWS_RUNTIME_SMOKE_ROOT_INVALID"
}
if (Test-Path -LiteralPath $resolvedSmokeRoot) {
  Remove-Item -LiteralPath $resolvedSmokeRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $dataRoot "media") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $dataRoot "imports") | Out-Null

if ([string]::IsNullOrWhiteSpace($env:AI_VIDEO_NODE22_PATH) -and
    -not (Test-Path -LiteralPath (Join-Path $workspaceRoot "ops\tools\node-v22.23.1-win-x64\node.exe"))) {
  $env:AI_VIDEO_NODE22_PATH = (Get-Command node.exe -ErrorAction Stop).Source
}
$env:AI_VIDEO_WORKBENCH_RUNTIME_ROOT = $runtimeRoot
$env:AI_VIDEO_WORKSPACE_DATA_ROOT = $dataRoot
$env:AI_VIDEO_WORKSPACE_DB_PATH = $databasePath
$env:H1_WORKBENCH_PORT = [string]$smokePort
$env:REAL_PROVIDER_ENABLED = "false"
$env:M1_REAL_PROVIDER_EXECUTION_ALLOWED = "false"
$env:M1_REAL_PROVIDER_COST_ACK = "false"

. (Join-Path $PSScriptRoot "workbench-runtime-common.ps1")
$runtime = Resolve-WorkbenchNode22
$env:PATH = "$(Split-Path -Parent $runtime.NodePath);$env:PATH"

Push-Location $workspaceRoot
try {
  & $runtime.NpmPath run db:migrate
  if ($LASTEXITCODE -ne 0) { throw "WINDOWS_RUNTIME_SMOKE_MIGRATION_FAILED" }

  try {
    & $runtime.NpmPath run windows:start
    if ($LASTEXITCODE -ne 0) { throw "WINDOWS_RUNTIME_SMOKE_START_FAILED" }
    & $runtime.NpmPath run windows:status
    if ($LASTEXITCODE -ne 0) { throw "WINDOWS_RUNTIME_SMOKE_STATUS_FAILED" }
    & $runtime.NpmPath run windows:start
    if ($LASTEXITCODE -ne 0) { throw "WINDOWS_RUNTIME_SMOKE_IDEMPOTENT_START_FAILED" }

    $env:H1_WORKBENCH_PORT = "invalid-ambient-port"
    & $runtime.NpmPath run windows:status
    if ($LASTEXITCODE -ne 0) { throw "WINDOWS_RUNTIME_SMOKE_STATE_PORT_STATUS_FAILED" }

    $stopOutput = & powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File scripts/windows/workbench-stop.ps1
    if ($LASTEXITCODE -ne 0) { throw "WINDOWS_RUNTIME_SMOKE_STOP_FAILED" }
    $stop = $stopOutput | Out-String | ConvertFrom-Json
    if (-not $stop.graceful -or $stop.forced) { throw "WINDOWS_RUNTIME_SMOKE_STOP_WAS_NOT_GRACEFUL" }

    $env:H1_WORKBENCH_PORT = [string]$smokePort
    & $runtime.NpmPath run windows:start
    if ($LASTEXITCODE -ne 0) { throw "WINDOWS_RUNTIME_SMOKE_FALLBACK_START_FAILED" }
    $statePath = Join-Path $runtimeRoot "workbench-state.json"
    $fallbackState = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
    $fallbackState.shutdown_token = "invalid-fallback-token"
    $fallbackState | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statePath -Encoding UTF8
    $forcedOutput = & powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File scripts/windows/workbench-stop.ps1
    if ($LASTEXITCODE -ne 0) { throw "WINDOWS_RUNTIME_SMOKE_FORCED_STOP_FAILED" }
    $forcedStop = $forcedOutput | Out-String | ConvertFrom-Json
    if ($forcedStop.graceful -or -not $forcedStop.forced) { throw "WINDOWS_RUNTIME_SMOKE_FORCE_FALLBACK_NOT_REPORTED" }
  } finally {
    $env:H1_WORKBENCH_PORT = [string]$smokePort
    if (Test-Path -LiteralPath (Join-Path $runtimeRoot "workbench-state.json")) {
      & powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File scripts/windows/workbench-stop.ps1 | Out-Null
    }
  }

  & powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File scripts/windows/workbench-status.ps1 | Out-Null
  if ($LASTEXITCODE -ne 1) { throw "WINDOWS_RUNTIME_SMOKE_STOPPED_STATUS_FAILED" }
  & $runtime.NpmPath run db:check
  if ($LASTEXITCODE -ne 0) { throw "WINDOWS_RUNTIME_SMOKE_FINAL_DB_CHECK_FAILED" }

  [pscustomobject]@{
    result = "PASS"
    port = $smokePort
    graceful_stop = $true
    forced_fallback = [bool]$forcedStop.forced
    provider_enabled = $false
  } | ConvertTo-Json
} finally {
  Pop-Location
}
