Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:WorkspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$configuredRuntimeRoot = $env:AI_VIDEO_WORKBENCH_RUNTIME_ROOT
if ([string]::IsNullOrWhiteSpace($configuredRuntimeRoot)) {
  $configuredRuntimeRoot = "ops\tools\workbench-runtime"
}
if (-not [System.IO.Path]::IsPathRooted($configuredRuntimeRoot)) {
  $configuredRuntimeRoot = Join-Path $script:WorkspaceRoot $configuredRuntimeRoot
}
$script:RuntimeRoot = [System.IO.Path]::GetFullPath($configuredRuntimeRoot)
$workspacePrefix = $script:WorkspaceRoot.TrimEnd('\') + '\'
if (-not $script:RuntimeRoot.StartsWith($workspacePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "WORKBENCH_RUNTIME_ROOT_OUTSIDE_WORKSPACE: $script:RuntimeRoot"
}
$script:StatePath = Join-Path $script:RuntimeRoot "workbench-state.json"

function Resolve-WorkbenchNode22 {
  $candidate = $env:AI_VIDEO_NODE22_PATH
  if ([string]::IsNullOrWhiteSpace($candidate)) {
    $candidate = Join-Path $script:WorkspaceRoot "ops\tools\node-v22.23.1-win-x64\node.exe"
  } elseif (-not [System.IO.Path]::IsPathRooted($candidate)) {
    $candidate = Join-Path $script:WorkspaceRoot $candidate
  }

  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
    throw "NODE22_NOT_FOUND: set AI_VIDEO_NODE22_PATH to a Node.js 22 executable"
  }

  $nodePath = (Resolve-Path -LiteralPath $candidate).Path
  $version = (& $nodePath --version 2>$null)
  if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v22\.') {
    throw "NODE22_REQUIRED: resolved runtime reported $version"
  }

  $npmPath = Join-Path (Split-Path -Parent $nodePath) "npm.cmd"
  if (-not (Test-Path -LiteralPath $npmPath -PathType Leaf)) {
    throw "NODE22_NPM_NOT_FOUND: $npmPath"
  }

  return [pscustomobject]@{
    NodePath = $nodePath
    NpmPath = (Resolve-Path -LiteralPath $npmPath).Path
    Version = $version
  }
}

function Resolve-WorkbenchDatabasePath {
  $configured = $env:AI_VIDEO_WORKSPACE_DB_PATH
  if ([string]::IsNullOrWhiteSpace($configured)) {
    return Join-Path $script:WorkspaceRoot "data\app.sqlite"
  }
  if ([System.IO.Path]::IsPathRooted($configured)) {
    return [System.IO.Path]::GetFullPath($configured)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $script:WorkspaceRoot $configured))
}

function Resolve-WorkbenchPort {
  $raw = $env:H1_WORKBENCH_PORT
  if ([string]::IsNullOrWhiteSpace($raw)) { $raw = $env:PORT }
  if ([string]::IsNullOrWhiteSpace($raw)) { return 4181 }

  $port = 0
  if (-not [int]::TryParse($raw, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
    throw "WORKBENCH_PORT_INVALID: $raw"
  }
  return $port
}

function Get-WorkbenchListenerPid([int]$Port) {
  $listener = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($null -eq $listener) { return $null }
  return [int]$listener.OwningProcess
}

function Read-WorkbenchState {
  if (-not (Test-Path -LiteralPath $script:StatePath -PathType Leaf)) { return $null }
  try {
    return Get-Content -Raw -LiteralPath $script:StatePath | ConvertFrom-Json
  } catch {
    throw "WORKBENCH_STATE_INVALID: $script:StatePath"
  }
}

function Test-WorkbenchProcessIdentity($State) {
  if ($null -eq $State -or $null -eq $State.pid) { return $false }
  $process = Get-Process -Id ([int]$State.pid) -ErrorAction SilentlyContinue
  if ($null -eq $process) { return $false }

  $actualStart = $process.StartTime.ToUniversalTime().ToString("o")
  if ($actualStart -ne [string]$State.process_start_time_utc) { return $false }

  try { $actualPath = $process.Path } catch { return $false }
  return [string]::Equals(
    [System.IO.Path]::GetFullPath($actualPath),
    [System.IO.Path]::GetFullPath([string]$State.node_path),
    [System.StringComparison]::OrdinalIgnoreCase
  )
}

function Get-WorkbenchHttpStatus([int]$Port, [int]$HealthTimeoutSec = 5, [int]$ReadyTimeoutSec = 10) {
  $healthStatus = 0
  $readyStatus = 0
  $ready = $false
  $checks = $null
  try {
    $healthResponse = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec $HealthTimeoutSec
    $healthStatus = [int]$healthResponse.StatusCode
  } catch { }
  try {
    $readyResponse = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/readyz" -TimeoutSec $ReadyTimeoutSec
    $readyStatus = [int]$readyResponse.StatusCode
    $body = $readyResponse.Content | ConvertFrom-Json
    $ready = [bool]$body.ok
    $checks = $body.checks
  } catch { }

  return [pscustomobject]@{
    health_status = $healthStatus
    ready_status = $readyStatus
    ready = $ready
    checks = $checks
  }
}

function Write-WorkbenchJson($Value) {
  $Value | ConvertTo-Json -Depth 8
}
