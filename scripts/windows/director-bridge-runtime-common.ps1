param(
  [switch]$FixtureMode
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:DirectorBridgeFixtureMode = [bool]$FixtureMode
$script:DirectorBridgeWorkspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

function Resolve-DirectorBridgeInsideWorkspace([string]$PathValue, [string]$FailureCode) {
  if ([string]::IsNullOrWhiteSpace($PathValue)) { throw $FailureCode }
  $candidate = if ([IO.Path]::IsPathRooted($PathValue)) {
    [IO.Path]::GetFullPath($PathValue)
  } else {
    [IO.Path]::GetFullPath((Join-Path $script:DirectorBridgeWorkspaceRoot $PathValue))
  }
  $prefix = $script:DirectorBridgeWorkspaceRoot.TrimEnd('\') + '\'
  if (-not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw $FailureCode }
  $current = $script:DirectorBridgeWorkspaceRoot
  foreach ($segment in @($candidate.Substring($prefix.Length) -split '[\\/]' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })) {
    $current = Join-Path $current $segment
    if (-not (Test-Path -LiteralPath $current)) { break }
    try { $attributes = [IO.File]::GetAttributes($current) } catch { throw $FailureCode }
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "DIRECTOR_BRIDGE_RUNTIME_PATH_REPARSE_POINT"
    }
  }
  return $candidate
}

function Get-DirectorBridgeWorkspaceRelativePath([string]$PathValue) {
  $candidate = [IO.Path]::GetFullPath($PathValue)
  $prefix = $script:DirectorBridgeWorkspaceRoot.TrimEnd('\') + '\'
  if (-not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "DIRECTOR_BRIDGE_RUNTIME_ROOT_INVALID"
  }
  return $candidate.Substring($prefix.Length)
}

function Get-DirectorBridgeCanonicalPath([string]$PathValue, [string]$FailureCode) {
  $resolved = Resolve-DirectorBridgeInsideWorkspace $PathValue $FailureCode
  return $resolved.TrimEnd('\').Replace('\', '/').ToLowerInvariant()
}

$configuredRuntimeRoot = [Environment]::GetEnvironmentVariable("AI_VIDEO_DIRECTOR_BRIDGE_RUNTIME_ROOT", "Process")
if ([string]::IsNullOrWhiteSpace($configuredRuntimeRoot)) {
  $configuredRuntimeRoot = "data\webgpt\director\runtime"
}
$script:DirectorBridgeRuntimeRoot = Resolve-DirectorBridgeInsideWorkspace $configuredRuntimeRoot "DIRECTOR_BRIDGE_RUNTIME_ROOT_INVALID"

if ($script:DirectorBridgeFixtureMode) {
  $relativeRuntimeRoot = (Get-DirectorBridgeWorkspaceRelativePath $script:DirectorBridgeRuntimeRoot).Replace('\', '/')
  if (-not $relativeRuntimeRoot.StartsWith("ops/tools/director-bridge-runtime-smoke-", [StringComparison]::OrdinalIgnoreCase)) {
    throw "DIRECTOR_BRIDGE_RUNTIME_TEST_ROOT_INVALID"
  }
  $fixtureEntrypoint = [Environment]::GetEnvironmentVariable("AI_VIDEO_DIRECTOR_BRIDGE_FIXTURE_ENTRYPOINT", "Process")
  $script:DirectorBridgeEntrypointPath = Resolve-DirectorBridgeInsideWorkspace $fixtureEntrypoint "DIRECTOR_BRIDGE_ENTRYPOINT_INVALID"
  $runtimePrefix = $script:DirectorBridgeRuntimeRoot.TrimEnd('\') + '\'
  if (-not $script:DirectorBridgeEntrypointPath.StartsWith($runtimePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "DIRECTOR_BRIDGE_ENTRYPOINT_INVALID"
  }
  $script:DirectorBridgeRuntimeMode = "fixture"
} else {
  $script:DirectorBridgeEntrypointPath = Resolve-DirectorBridgeInsideWorkspace "dist\scripts\director-local-bridge.js" "DIRECTOR_BRIDGE_ENTRYPOINT_INVALID"
  $script:DirectorBridgeRuntimeMode = "live"
}
$script:DirectorBridgeEntrypointRelativePath = (Get-DirectorBridgeWorkspaceRelativePath $script:DirectorBridgeEntrypointPath).Replace('\', '/')
$script:DirectorBridgeStatePath = Join-Path $script:DirectorBridgeRuntimeRoot "director-bridge-state.json"
$script:DirectorBridgeHeartbeatPath = Join-Path $script:DirectorBridgeRuntimeRoot "director-bridge-heartbeat.json"
$script:DirectorBridgeStopRequestPath = Join-Path $script:DirectorBridgeRuntimeRoot "director-bridge-stop-request.json"
$script:DirectorBridgeActivationPath = Join-Path $script:DirectorBridgeRuntimeRoot "director-bridge-activation.json"
$script:DirectorBridgeLifecycleLockPath = Join-Path $script:DirectorBridgeRuntimeRoot "director-bridge-lifecycle.lock"

function Write-DirectorBridgeJson([object]$Value) {
  [Console]::Out.WriteLine(($Value | ConvertTo-Json -Depth 8 -Compress))
}

function Get-DirectorBridgeStableErrorCode([object]$ErrorRecord) {
  $message = [string]$ErrorRecord.Exception.Message
  if ($message -match '^DIRECTOR_[A-Z0-9_]{3,95}$') { return $message }
  return "DIRECTOR_BRIDGE_RUNTIME_FAILED"
}

function Write-DirectorBridgeFailure([object]$ErrorRecord) {
  [Console]::Error.WriteLine((ConvertTo-Json ([ordered]@{
    result = "FAIL"
    stable_error_code = Get-DirectorBridgeStableErrorCode $ErrorRecord
  }) -Compress))
}

function Assert-DirectorBridgePrivateRuntime {
  $tracked = @(& git -C $script:DirectorBridgeWorkspaceRoot ls-files -- $script:DirectorBridgeRuntimeRoot 2>$null)
  if ($LASTEXITCODE -ne 0) { throw "DIRECTOR_BRIDGE_RUNTIME_GIT_CHECK_FAILED" }
  if ($tracked.Count -gt 0) { throw "DIRECTOR_BRIDGE_RUNTIME_PRIVATE_PATH_TRACKED" }
  & git -C $script:DirectorBridgeWorkspaceRoot check-ignore --quiet --no-index -- $script:DirectorBridgeRuntimeRoot
  if ($LASTEXITCODE -ne 0) { throw "DIRECTOR_BRIDGE_RUNTIME_PRIVATE_PATH_NOT_IGNORED" }
}

function Assert-DirectorBridgeProviderDisabled {
  foreach ($name in @("REAL_PROVIDER_ENABLED", "M1_REAL_PROVIDER_EXECUTION_ALLOWED", "M1_REAL_PROVIDER_COST_ACK")) {
    $value = [Environment]::GetEnvironmentVariable($name, "Process")
    if (-not [string]::IsNullOrWhiteSpace($value) -and $value.Trim() -match '^(?i:true)$') {
      throw "DIRECTOR_PROVIDER_MUST_BE_DISABLED"
    }
  }
}

function Assert-DirectorBridgeNoPlaintextKey {
  $value = [Environment]::GetEnvironmentVariable("WEBGPT_DIRECTOR_BRIDGE_KEY_B64", "Process")
  if (-not [string]::IsNullOrWhiteSpace($value)) {
    throw "DIRECTOR_BRIDGE_PLAINTEXT_KEY_FORBIDDEN"
  }
}

function Resolve-DirectorBridgeNode22 {
  $candidate = [Environment]::GetEnvironmentVariable("AI_VIDEO_NODE22_PATH", "Process")
  if ([string]::IsNullOrWhiteSpace($candidate)) {
    $candidate = Join-Path $script:DirectorBridgeWorkspaceRoot "ops\tools\node-v22.23.1-win-x64\node.exe"
  } elseif (-not [IO.Path]::IsPathRooted($candidate)) {
    $candidate = Join-Path $script:DirectorBridgeWorkspaceRoot $candidate
  }
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "DIRECTOR_BRIDGE_NODE22_NOT_FOUND" }
  $resolved = (Resolve-Path -LiteralPath $candidate).Path
  try { $attributes = [IO.File]::GetAttributes($resolved) } catch { throw "DIRECTOR_BRIDGE_NODE22_INVALID" }
  if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or [IO.Path]::GetFileName($resolved) -ine "node.exe") {
    throw "DIRECTOR_BRIDGE_NODE22_INVALID"
  }
  $version = & $resolved --version 2>$null
  if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v22\.') { throw "DIRECTOR_BRIDGE_NODE22_REQUIRED" }
  $npmPath = Join-Path (Split-Path -Parent $resolved) "npm.cmd"
  if (-not (Test-Path -LiteralPath $npmPath -PathType Leaf)) { throw "DIRECTOR_BRIDGE_NODE22_NPM_NOT_FOUND" }
  return [pscustomobject]@{
    NodePath = $resolved
    NpmPath = (Resolve-Path -LiteralPath $npmPath).Path
    Version = [string]$version
  }
}

function Get-DirectorBridgeFileSha256([string]$PathValue, [string]$FailureCode) {
  for ($attempt = 0; $attempt -lt 100; $attempt += 1) {
    if (-not (Test-Path -LiteralPath $PathValue -PathType Leaf)) {
      if ($attempt -eq 99) { throw $FailureCode }
    } else {
      $stream = $null
      $sha = $null
      $digest = $null
      try {
        $stream = [IO.File]::Open(
          $PathValue,
          [IO.FileMode]::Open,
          [IO.FileAccess]::Read,
          ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
        )
        $sha = [Security.Cryptography.SHA256]::Create()
        $digest = $sha.ComputeHash($stream)
        return ([BitConverter]::ToString($digest)).Replace('-', '').ToLowerInvariant()
      } catch {
        if ($attempt -eq 99) { throw $FailureCode }
      } finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if ($null -ne $sha) { $sha.Dispose() }
        if ($null -ne $digest) { [Array]::Clear($digest, 0, $digest.Length) }
      }
    }
    Start-Sleep -Milliseconds 100
  }
  throw $FailureCode
}

function Get-DirectorBridgeTextSha256([string]$Value) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $digest = $sha.ComputeHash($bytes)
    try { return ([BitConverter]::ToString($digest)).Replace('-', '').ToLowerInvariant() }
    finally { [Array]::Clear($digest, 0, $digest.Length) }
  } finally {
    $sha.Dispose()
    [Array]::Clear($bytes, 0, $bytes.Length)
  }
}

function Get-DirectorBridgeLaunchArgvSha256([string]$NodePath, [string]$EntrypointPath) {
  $canonical = @(
    "director-bridge-launch-argv-v1",
    "node=$($NodePath.TrimEnd('\').Replace('\', '/').ToLowerInvariant())",
    "entrypoint=$($EntrypointPath.TrimEnd('\').Replace('\', '/').ToLowerInvariant())"
  ) -join "`n"
  return Get-DirectorBridgeTextSha256 $canonical
}

function Get-DirectorBridgeExactOrigin {
  $raw = [Environment]::GetEnvironmentVariable("WEBGPT_DIRECTOR_REMOTE_ORIGIN", "Process")
  if ([string]::IsNullOrWhiteSpace($raw)) { throw "DIRECTOR_BRIDGE_ORIGIN_INVALID" }
  try { $uri = [Uri]::new($raw.Trim(), [UriKind]::Absolute) }
  catch { throw "DIRECTOR_BRIDGE_ORIGIN_INVALID" }
  if ($uri.Scheme -ine "https" -or
      -not [string]::IsNullOrEmpty($uri.UserInfo) -or
      -not [string]::IsNullOrEmpty($uri.Query) -or
      -not [string]::IsNullOrEmpty($uri.Fragment) -or
      $uri.AbsolutePath -cne "/") {
    throw "DIRECTOR_BRIDGE_ORIGIN_INVALID"
  }
  return "$($uri.Scheme.ToLowerInvariant())://$($uri.Authority.ToLowerInvariant())"
}

function Get-DirectorBridgeLaunchConfigSha256 {
  Assert-DirectorBridgeProviderDisabled
  Assert-DirectorBridgeNoPlaintextKey
  $keyId = [Environment]::GetEnvironmentVariable("WEBGPT_DIRECTOR_BRIDGE_KEY_ID", "Process")
  if ([string]::IsNullOrWhiteSpace($keyId) -or $keyId.Trim() -notmatch '^[A-Za-z0-9._-]{1,64}$') {
    throw "DIRECTOR_BRIDGE_KEY_ID_INVALID"
  }
  $databasePath = Resolve-DirectorBridgeInsideWorkspace (
    [Environment]::GetEnvironmentVariable("AI_VIDEO_WORKSPACE_DB_PATH", "Process")
  ) "DIRECTOR_DATABASE_PATH_REQUIRED"
  $dpapiPath = Resolve-DirectorBridgeInsideWorkspace (
    [Environment]::GetEnvironmentVariable("WEBGPT_DIRECTOR_BRIDGE_KEY_DPAPI_PATH", "Process")
  ) "DIRECTOR_BRIDGE_KEY_POINTER_REQUIRED"
  if (-not $script:DirectorBridgeFixtureMode) {
    if (-not (Test-Path -LiteralPath $databasePath -PathType Leaf)) { throw "DIRECTOR_DATABASE_PATH_REQUIRED" }
    if (-not (Test-Path -LiteralPath $dpapiPath -PathType Leaf)) { throw "DIRECTOR_BRIDGE_KEY_POINTER_REQUIRED" }
  }
  $canonical = @(
    "director-bridge-launch-config-v1",
    "remote_origin=$(Get-DirectorBridgeExactOrigin)",
    "database_path=$($databasePath.TrimEnd('\').Replace('\', '/').ToLowerInvariant())",
    "dpapi_path=$($dpapiPath.TrimEnd('\').Replace('\', '/').ToLowerInvariant())",
    "key_id=$($keyId.Trim())",
    "provider_enabled=false",
    "provider_execution_allowed=false",
    "provider_cost_acknowledged=false"
  ) -join "`n"
  return Get-DirectorBridgeTextSha256 $canonical
}

function Get-DirectorBridgeBuildManifestSha256 {
  if ($script:DirectorBridgeFixtureMode) {
    return Get-DirectorBridgeFileSha256 $script:DirectorBridgeEntrypointPath "DIRECTOR_BRIDGE_BUILD_IDENTITY_INVALID"
  }
  $roots = @(
    (Join-Path $script:DirectorBridgeWorkspaceRoot "dist\src"),
    (Join-Path $script:DirectorBridgeWorkspaceRoot "dist\scripts")
  )
  $files = @()
  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw "DIRECTOR_BRIDGE_BUILD_IDENTITY_MISSING" }
    $files += Get-ChildItem -LiteralPath $root -Recurse -File | Sort-Object FullName
  }
  if ($files.Count -eq 0) { throw "DIRECTOR_BRIDGE_BUILD_IDENTITY_MISSING" }
  $manifest = [Text.StringBuilder]::new()
  foreach ($file in @($files | Sort-Object { Get-DirectorBridgeWorkspaceRelativePath $_.FullName })) {
    $relative = (Get-DirectorBridgeWorkspaceRelativePath $file.FullName).Replace('\', '/')
    [void]$manifest.Append($relative)
    [void]$manifest.Append(':')
    [void]$manifest.Append((Get-DirectorBridgeFileSha256 $file.FullName "DIRECTOR_BRIDGE_BUILD_IDENTITY_INVALID"))
    [void]$manifest.Append("`n")
  }
  return Get-DirectorBridgeTextSha256 $manifest.ToString()
}

function Get-DirectorBridgeSourceCommit {
  if ($script:DirectorBridgeFixtureMode) { return "0000000000000000000000000000000000000000" }
  $commit = (& git -C $script:DirectorBridgeWorkspaceRoot rev-parse --verify HEAD 2>$null | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$') { throw "DIRECTOR_BRIDGE_SOURCE_COMMIT_INVALID" }
  return $commit
}

function Test-DirectorBridgeTrackedSourceClean {
  if ($script:DirectorBridgeFixtureMode) { return $true }
  & git -C $script:DirectorBridgeWorkspaceRoot diff --quiet HEAD -- src scripts package.json package-lock.json tsconfig.json
  if ($LASTEXITCODE -ne 0) { return $false }
  $untracked = @(& git -C $script:DirectorBridgeWorkspaceRoot ls-files --others --exclude-standard -- src scripts 2>$null)
  if ($LASTEXITCODE -ne 0) { return $false }
  return $untracked.Count -eq 0
}

function Assert-DirectorBridgeExpectedCommit([string]$ExpectedCommit = "") {
  if (-not [string]::IsNullOrWhiteSpace($ExpectedCommit) -and $ExpectedCommit -notmatch '^[0-9a-f]{40}$') {
    throw "DIRECTOR_BRIDGE_SOURCE_COMMIT_MISMATCH"
  }
}

function Assert-DirectorBridgeSourceBaseline([string]$ExpectedCommit = "") {
  Assert-DirectorBridgeExpectedCommit $ExpectedCommit
  $commit = Get-DirectorBridgeSourceCommit
  if (-not [string]::IsNullOrWhiteSpace($ExpectedCommit) -and $commit -cne $ExpectedCommit) {
    throw "DIRECTOR_BRIDGE_SOURCE_COMMIT_MISMATCH"
  }
  if (-not (Test-DirectorBridgeTrackedSourceClean)) { throw "DIRECTOR_BRIDGE_TRACKED_SOURCE_DIRTY" }
  return $commit
}

function New-DirectorBridgeInstanceId {
  $bytes = New-Object byte[] 32
  $random = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $random.GetBytes($bytes) } finally { $random.Dispose() }
  try { return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_') }
  finally { [Array]::Clear($bytes, 0, $bytes.Length) }
}

function Write-DirectorBridgeAtomicJson([string]$PathValue, [object]$Value) {
  $temporary = "$PathValue.tmp-$PID-$([Guid]::NewGuid().ToString('N'))"
  try {
    [IO.File]::WriteAllText($temporary, (($Value | ConvertTo-Json -Depth 8 -Compress) + "`n"), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $PathValue -Force
  } finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
  }
}

function Read-DirectorBridgeState {
  if (-not (Test-Path -LiteralPath $script:DirectorBridgeStatePath -PathType Leaf)) { return $null }
  try { return Get-Content -Raw -LiteralPath $script:DirectorBridgeStatePath | ConvertFrom-Json }
  catch { throw "DIRECTOR_BRIDGE_RUNTIME_STATE_INVALID" }
}

function Assert-DirectorBridgeState([object]$State) {
  $required = @(
    "state_version", "runtime_mode", "instance_id", "pid", "process_start_time_utc",
    "started_at_utc", "node_executable", "node_executable_sha256", "node_version",
    "entrypoint_relative_path", "entrypoint_sha256", "source_commit", "build_manifest_sha256",
    "launch_config_sha256", "launch_argv_sha256", "exact_baseline", "provider_enabled",
    "heartbeat_interval_seconds"
  )
  $names = @($State.PSObject.Properties.Name)
  if ($names.Count -ne $required.Count -or
      @($required | Where-Object { $names -notcontains $_ }).Count -gt 0 -or
      @($names | Where-Object { $required -notcontains $_ }).Count -gt 0) {
    throw "DIRECTOR_BRIDGE_RUNTIME_STATE_INVALID"
  }
  try {
    $expectedExactBaseline = -not $script:DirectorBridgeFixtureMode
    if ([string]$State.state_version -cne "director-bridge-runtime-state-v2" -or
        [string]$State.runtime_mode -cne $script:DirectorBridgeRuntimeMode -or
        [string]$State.instance_id -notmatch '^[A-Za-z0-9_-]{43}$' -or
        [int]$State.pid -le 0 -or
        [string]$State.node_executable_sha256 -notmatch '^[0-9a-f]{64}$' -or
        [string]$State.node_version -notmatch '^v22\.' -or
        [string]$State.entrypoint_relative_path -cne $script:DirectorBridgeEntrypointRelativePath -or
        [string]$State.entrypoint_sha256 -notmatch '^[0-9a-f]{64}$' -or
        [string]$State.source_commit -notmatch '^[0-9a-f]{40}$' -or
        [string]$State.build_manifest_sha256 -notmatch '^[0-9a-f]{64}$' -or
        [string]$State.launch_config_sha256 -notmatch '^[0-9a-f]{64}$' -or
        [string]$State.launch_argv_sha256 -notmatch '^[0-9a-f]{64}$' -or
        $State.exact_baseline -isnot [bool] -or [bool]$State.exact_baseline -ne $expectedExactBaseline -or
        $State.provider_enabled -isnot [bool] -or [bool]$State.provider_enabled -ne $false -or
        [int]$State.heartbeat_interval_seconds -ne 5) {
      throw "DIRECTOR_BRIDGE_RUNTIME_STATE_INVALID"
    }
    $nodePath = [IO.Path]::GetFullPath([string]$State.node_executable)
    if ([IO.Path]::GetFileName($nodePath) -ine "node.exe" -or -not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
      throw "DIRECTOR_BRIDGE_RUNTIME_STATE_INVALID"
    }
    [void][DateTimeOffset]::Parse([string]$State.process_start_time_utc)
    [void][DateTimeOffset]::Parse([string]$State.started_at_utc)
  } catch {
    if ($_.Exception.Message -eq "DIRECTOR_BRIDGE_RUNTIME_STATE_INVALID") { throw }
    throw "DIRECTOR_BRIDGE_RUNTIME_STATE_INVALID"
  }
}

function Test-DirectorBridgeExactCommandLine([string]$CommandLine, [string]$NodePath) {
  if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
  $node = [IO.Path]::GetFullPath($NodePath)
  $entrypoint = $script:DirectorBridgeEntrypointPath
  $nodeForms = @("`"$node`"")
  if ($node -notmatch '\s') { $nodeForms += $node }
  $entrypointForms = @("`"$entrypoint`"")
  if ($entrypoint -notmatch '\s') { $entrypointForms += $entrypoint }
  foreach ($nodeForm in $nodeForms) {
    foreach ($entrypointForm in $entrypointForms) {
      if ($CommandLine.Trim().Equals("$nodeForm $entrypointForm", [StringComparison]::OrdinalIgnoreCase)) {
        return $true
      }
    }
  }
  return $false
}

function Test-DirectorBridgeLegacyRelativeCommandLine([string]$CommandLine, [string]$NodePath) {
  if ([string]::IsNullOrWhiteSpace($CommandLine) -or [string]::IsNullOrWhiteSpace($NodePath)) {
    return $false
  }
  try {
    $node = [IO.Path]::GetFullPath($NodePath)
  } catch {
    return $false
  }
  if ([IO.Path]::GetFileName($node) -ine "node.exe") { return $false }

  $nodeForms = @("node", "node.exe", "`"node`"", "`"node.exe`"", "`"$node`"")
  if ($node -notmatch '\s') { $nodeForms += $node }
  $relativeEntrypoints = @(
    "dist/scripts/director-local-bridge.js",
    "dist\scripts\director-local-bridge.js",
    ".\dist/scripts/director-local-bridge.js",
    ".\dist\scripts\director-local-bridge.js"
  )
  foreach ($nodeForm in @($nodeForms | Select-Object -Unique)) {
    foreach ($relativeEntrypoint in $relativeEntrypoints) {
      foreach ($entrypointForm in @($relativeEntrypoint, "`"$relativeEntrypoint`"")) {
        if ($CommandLine.Trim().Equals("$nodeForm $entrypointForm", [StringComparison]::OrdinalIgnoreCase)) {
          return $true
        }
      }
    }
  }
  return $false
}

function Get-DirectorBridgeTargetProcesses {
  $matches = @()
  $leaf = [IO.Path]::GetFileName($script:DirectorBridgeEntrypointPath).Replace("'", "''")
  try {
    $candidates = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe' AND CommandLine LIKE '%$leaf%'" -ErrorAction Stop)
    foreach ($candidate in $candidates) {
      $hasExecutable = -not [string]::IsNullOrWhiteSpace([string]$candidate.ExecutablePath)
      $isExactManagedTarget = $hasExecutable -and
        (Test-DirectorBridgeExactCommandLine ([string]$candidate.CommandLine) ([string]$candidate.ExecutablePath))
      # A relative argv cannot prove cwd. Treat the exact historical two-token shape as
      # an unmanaged discovery candidate only; managed identity remains absolute-only.
      $isLegacyUnmanagedTarget = -not $script:DirectorBridgeFixtureMode -and $hasExecutable -and
        (Test-DirectorBridgeLegacyRelativeCommandLine ([string]$candidate.CommandLine) ([string]$candidate.ExecutablePath))
      if ($isExactManagedTarget -or $isLegacyUnmanagedTarget) {
        $matches += $candidate
      }
    }
  } catch {
    throw "DIRECTOR_BRIDGE_PROCESS_INSPECTION_FAILED"
  }
  return @($matches)
}

function Get-DirectorBridgeProcessIdentity([object]$State) {
  $process = Get-Process -Id ([int]$State.pid) -ErrorAction SilentlyContinue
  if ($null -eq $process) { return "missing" }
  try {
    $startMatches = $process.StartTime.ToUniversalTime().ToString("o") -ceq [string]$State.process_start_time_utc
    $pathMatches = [IO.Path]::GetFullPath($process.Path).Equals(
      [IO.Path]::GetFullPath([string]$State.node_executable),
      [StringComparison]::OrdinalIgnoreCase
    )
    $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$State.pid)" -ErrorAction Stop
    $commandMatches = $null -ne $cim -and (Test-DirectorBridgeExactCommandLine ([string]$cim.CommandLine) ([string]$State.node_executable))
    $executableMatches = $null -ne $cim -and [IO.Path]::GetFullPath([string]$cim.ExecutablePath).Equals(
      [IO.Path]::GetFullPath([string]$State.node_executable),
      [StringComparison]::OrdinalIgnoreCase
    )
    $argvHashMatches = (Get-DirectorBridgeLaunchArgvSha256 ([string]$State.node_executable) $script:DirectorBridgeEntrypointPath) -ceq
      [string]$State.launch_argv_sha256
    if ($startMatches -and $pathMatches -and $commandMatches -and $executableMatches -and $argvHashMatches) { return "match" }
    return "mismatch"
  } catch {
    return "mismatch"
  }
}

function Read-DirectorBridgeHeartbeat([object]$State) {
  if (-not (Test-Path -LiteralPath $script:DirectorBridgeHeartbeatPath -PathType Leaf)) { return $null }
  try { $heartbeat = Get-Content -Raw -LiteralPath $script:DirectorBridgeHeartbeatPath | ConvertFrom-Json }
  catch { throw "DIRECTOR_BRIDGE_HEARTBEAT_INVALID" }
  $required = @(
    "heartbeat_version", "instance_id", "pid", "source_commit", "build_manifest_sha256",
    "entrypoint_sha256", "launch_config_sha256", "launch_argv_sha256", "phase",
    "heartbeat_at_utc", "last_authenticated_poll_at_utc", "last_request_completed_at_utc",
    "consecutive_failures", "next_retry_at_utc", "stable_error_code", "stop_requested",
    "completion_pending", "provider_enabled"
  )
  $names = @($heartbeat.PSObject.Properties.Name)
  if ($names.Count -ne $required.Count -or
      @($required | Where-Object { $names -notcontains $_ }).Count -gt 0 -or
      @($names | Where-Object { $required -notcontains $_ }).Count -gt 0) {
    throw "DIRECTOR_BRIDGE_HEARTBEAT_INVALID"
  }
  try {
    if ([string]$heartbeat.heartbeat_version -cne "director-bridge-heartbeat-v1" -or
        [string]$heartbeat.instance_id -cne [string]$State.instance_id -or
        [int]$heartbeat.pid -ne [int]$State.pid -or
        [string]$heartbeat.source_commit -cne [string]$State.source_commit -or
        [string]$heartbeat.build_manifest_sha256 -cne [string]$State.build_manifest_sha256 -or
        [string]$heartbeat.entrypoint_sha256 -cne [string]$State.entrypoint_sha256 -or
        [string]$heartbeat.launch_config_sha256 -cne [string]$State.launch_config_sha256 -or
        [string]$heartbeat.launch_argv_sha256 -cne [string]$State.launch_argv_sha256 -or
        [string]$heartbeat.phase -notin @("starting", "polling", "idle", "handling", "completing", "backoff", "stopping", "stopped", "failed") -or
        [int]$heartbeat.consecutive_failures -lt 0 -or [int]$heartbeat.consecutive_failures -gt 6 -or
        $heartbeat.stop_requested -isnot [bool] -or
        $heartbeat.completion_pending -isnot [bool] -or
        $heartbeat.provider_enabled -isnot [bool] -or [bool]$heartbeat.provider_enabled -ne $false) {
      throw "DIRECTOR_BRIDGE_HEARTBEAT_INVALID"
    }
    [void][DateTimeOffset]::Parse([string]$heartbeat.heartbeat_at_utc)
    if ($null -ne $heartbeat.last_authenticated_poll_at_utc) { [void][DateTimeOffset]::Parse([string]$heartbeat.last_authenticated_poll_at_utc) }
    if ($null -ne $heartbeat.last_request_completed_at_utc) { [void][DateTimeOffset]::Parse([string]$heartbeat.last_request_completed_at_utc) }
    if ($null -ne $heartbeat.next_retry_at_utc) { [void][DateTimeOffset]::Parse([string]$heartbeat.next_retry_at_utc) }
    if ($null -ne $heartbeat.stable_error_code -and [string]$heartbeat.stable_error_code -notmatch '^[A-Z][A-Z0-9_]{2,95}$') {
      throw "DIRECTOR_BRIDGE_HEARTBEAT_INVALID"
    }
  } catch {
    if ($_.Exception.Message -eq "DIRECTOR_BRIDGE_HEARTBEAT_INVALID") { throw }
    throw "DIRECTOR_BRIDGE_HEARTBEAT_INVALID"
  }
  return $heartbeat
}

function Test-DirectorBridgeLaunchIdentityCurrent([object]$State) {
  try {
    $entrypointSha = Get-DirectorBridgeFileSha256 $script:DirectorBridgeEntrypointPath "DIRECTOR_BRIDGE_ENTRYPOINT_INVALID"
    $buildSha = Get-DirectorBridgeBuildManifestSha256
    $sourceCommit = Get-DirectorBridgeSourceCommit
    $sourceClean = Test-DirectorBridgeTrackedSourceClean
    $nodeSha = Get-DirectorBridgeFileSha256 ([string]$State.node_executable) "DIRECTOR_BRIDGE_NODE22_INVALID"
    $argvSha = Get-DirectorBridgeLaunchArgvSha256 ([string]$State.node_executable) $script:DirectorBridgeEntrypointPath
    $configSha = Get-DirectorBridgeLaunchConfigSha256
    return $entrypointSha -ceq [string]$State.entrypoint_sha256 -and
      $buildSha -ceq [string]$State.build_manifest_sha256 -and
      $sourceCommit -ceq [string]$State.source_commit -and
      $nodeSha -ceq [string]$State.node_executable_sha256 -and
      $argvSha -ceq [string]$State.launch_argv_sha256 -and
      $configSha -ceq [string]$State.launch_config_sha256 -and
      $sourceClean
  } catch {
    return $false
  }
}

function Test-DirectorBridgeActivationCandidate([object]$State) {
  Assert-DirectorBridgeState $State
  if ((Get-DirectorBridgeProcessIdentity $State) -ne "match" -or -not (Test-DirectorBridgeLaunchIdentityCurrent $State)) {
    return $false
  }
  try { $heartbeat = Read-DirectorBridgeHeartbeat $State } catch { return $false }
  if ($null -eq $heartbeat) { return $false }
  $age = ([DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse([string]$heartbeat.heartbeat_at_utc)).TotalSeconds
  return $age -ge -5 -and $age -le 20 -and
    [string]$heartbeat.phase -ceq "starting" -and
    $null -eq $heartbeat.last_authenticated_poll_at_utc -and
    [int]$heartbeat.consecutive_failures -eq 0 -and
    $null -eq $heartbeat.stable_error_code -and
    -not [bool]$heartbeat.stop_requested -and
    -not [bool]$heartbeat.completion_pending
}

function Get-DirectorBridgeRuntimeAssessment([object]$State) {
  Assert-DirectorBridgeState $State
  $processIdentity = Get-DirectorBridgeProcessIdentity $State
  if ($processIdentity -eq "missing") {
    return [pscustomobject]@{ Result = "STALE_STATE"; ExitCode = 2; Running = $false; ProcessIdentity = "missing"; Heartbeat = "missing"; RemoteContact = "missing"; Phase = $null; ExactBuild = $false; TransportReady = $false; LastHeartbeat = $null }
  }
  if ($processIdentity -ne "match") {
    return [pscustomobject]@{ Result = "STATE_CONFLICT"; ExitCode = 2; Running = $false; ProcessIdentity = "mismatch"; Heartbeat = "unknown"; RemoteContact = "unknown"; Phase = $null; ExactBuild = $false; TransportReady = $false; LastHeartbeat = $null }
  }
  if (-not (Test-DirectorBridgeLaunchIdentityCurrent $State)) {
    return [pscustomobject]@{ Result = "RESTART_REQUIRED"; ExitCode = 2; Running = $true; ProcessIdentity = "match"; Heartbeat = "unknown"; RemoteContact = "unknown"; Phase = $null; ExactBuild = $false; TransportReady = $false; LastHeartbeat = $null }
  }
  try { $heartbeat = Read-DirectorBridgeHeartbeat $State } catch {
    return [pscustomobject]@{ Result = "NOT_READY"; ExitCode = 2; Running = $true; ProcessIdentity = "match"; Heartbeat = "invalid"; RemoteContact = "unknown"; Phase = $null; ExactBuild = [bool]$State.exact_baseline; TransportReady = $false; LastHeartbeat = $null }
  }
  if ($null -eq $heartbeat) {
    return [pscustomobject]@{ Result = "NOT_READY"; ExitCode = 2; Running = $true; ProcessIdentity = "match"; Heartbeat = "missing"; RemoteContact = "missing"; Phase = $null; ExactBuild = [bool]$State.exact_baseline; TransportReady = $false; LastHeartbeat = $null }
  }
  $now = [DateTimeOffset]::UtcNow
  $heartbeatAt = [DateTimeOffset]::Parse([string]$heartbeat.heartbeat_at_utc)
  $heartbeatAge = ($now - $heartbeatAt).TotalSeconds
  $heartbeatState = if ($heartbeatAge -ge -5 -and $heartbeatAge -le 20) { "fresh" } else { "stale" }
  $remoteState = "missing"
  if ($null -ne $heartbeat.last_authenticated_poll_at_utc) {
    $remoteAt = [DateTimeOffset]::Parse([string]$heartbeat.last_authenticated_poll_at_utc)
    $remoteAge = ($now - $remoteAt).TotalSeconds
    $remoteState = if ($remoteAge -ge -5 -and $remoteAge -le 180) { "fresh" } else { "stale" }
  }
  $ready = $heartbeatState -eq "fresh" -and
    $remoteState -eq "fresh" -and
    [string]$heartbeat.phase -notin @("starting", "backoff", "stopping", "stopped", "failed") -and
    -not [bool]$heartbeat.stop_requested -and
    -not [bool]$heartbeat.completion_pending -and
    [int]$heartbeat.consecutive_failures -eq 0 -and
    $null -eq $heartbeat.stable_error_code
  return [pscustomobject]@{
    Result = if ($ready) { "RUNNING" } else { "NOT_READY" }
    ExitCode = if ($ready) { 0 } else { 2 }
    Running = $true
    ProcessIdentity = "match"
    Heartbeat = $heartbeatState
    RemoteContact = $remoteState
    Phase = [string]$heartbeat.phase
    ExactBuild = [bool]$State.exact_baseline
    TransportReady = $ready
    LastHeartbeat = [string]$heartbeat.heartbeat_at_utc
  }
}

function Write-DirectorBridgeActivation([object]$State) {
  Write-DirectorBridgeAtomicJson $script:DirectorBridgeActivationPath ([ordered]@{
    activation_version = "director-bridge-activation-v1"
    instance_id = [string]$State.instance_id
    action = "activate"
    activated_at_utc = [DateTime]::UtcNow.ToString("o")
  })
}

function Write-DirectorBridgeStopRequestByInstance([string]$InstanceId) {
  Write-DirectorBridgeAtomicJson $script:DirectorBridgeStopRequestPath ([ordered]@{
    control_version = "director-bridge-control-v1"
    instance_id = $InstanceId
    action = "stop"
    requested_at_utc = [DateTime]::UtcNow.ToString("o")
  })
}

function Write-DirectorBridgeStopRequest([object]$State) {
  Write-DirectorBridgeStopRequestByInstance ([string]$State.instance_id)
}

function Get-DirectorBridgeFinalReceiptState(
  [object]$State,
  [DateTimeOffset]$NotBefore = [DateTimeOffset]::MinValue
) {
  try { $heartbeat = Read-DirectorBridgeHeartbeat $State } catch { return "invalid" }
  if ($null -eq $heartbeat) { return "missing" }
  if ([bool]$heartbeat.completion_pending) { return "completion_unconfirmed" }
  $heartbeatAt = [DateTimeOffset]::Parse([string]$heartbeat.heartbeat_at_utc)
  $threshold = if ($NotBefore -eq [DateTimeOffset]::MinValue) {
    [DateTimeOffset]::MinValue
  } else {
    $NotBefore.AddSeconds(-1)
  }
  if ($heartbeatAt -ge $threshold -and
      [string]$heartbeat.phase -ceq "stopped" -and
      [bool]$heartbeat.stop_requested) {
    return "confirmed"
  }
  return "invalid"
}

function Remove-DirectorBridgeRuntimeReceipts {
  foreach ($path in @(
    $script:DirectorBridgeStatePath,
    $script:DirectorBridgeHeartbeatPath,
    $script:DirectorBridgeStopRequestPath,
    $script:DirectorBridgeActivationPath
  )) {
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  }
}

function Enter-DirectorBridgeLifecycleLock {
  try {
    return [IO.File]::Open(
      $script:DirectorBridgeLifecycleLockPath,
      [IO.FileMode]::OpenOrCreate,
      [IO.FileAccess]::ReadWrite,
      [IO.FileShare]::None
    )
  } catch {
    throw "DIRECTOR_BRIDGE_RUNTIME_START_IN_PROGRESS"
  }
}

function Exit-DirectorBridgeLifecycleLock([IO.FileStream]$LockStream) {
  if ($null -ne $LockStream) { $LockStream.Dispose() }
}

function Wait-DirectorBridgeProcessExit([int]$ProcessId, [int]$TimeoutSeconds) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($null -eq (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $null -eq (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Resolve-DirectorBridgeMissingProcessReceipts([object]$State) {
  if (@(Get-DirectorBridgeTargetProcesses).Count -gt 0) {
    throw "DIRECTOR_BRIDGE_RUNTIME_STATE_CONFLICT"
  }
  if (Test-Path -LiteralPath $script:DirectorBridgeHeartbeatPath -PathType Leaf) {
    $heartbeat = Read-DirectorBridgeHeartbeat $State
    if ($null -eq $heartbeat) {
      throw "DIRECTOR_BRIDGE_HEARTBEAT_INVALID"
    }
    if ([bool]$heartbeat.completion_pending -or
        [string]$heartbeat.phase -in @("handling", "completing", "stopping")) {
      throw "DIRECTOR_BRIDGE_COMPLETION_UNCONFIRMED"
    }
  }
  if (Test-Path -LiteralPath $script:DirectorBridgeStopRequestPath -PathType Leaf) {
    $finalState = Get-DirectorBridgeFinalReceiptState $State
    if ($finalState -eq "completion_unconfirmed") { throw "DIRECTOR_BRIDGE_COMPLETION_UNCONFIRMED" }
    if ($finalState -ne "confirmed") { throw "DIRECTOR_BRIDGE_RUNTIME_STOP_UNCONFIRMED" }
  }
  Remove-DirectorBridgeRuntimeReceipts
}
