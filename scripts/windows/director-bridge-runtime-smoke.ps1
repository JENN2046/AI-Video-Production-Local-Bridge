Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$smokeName = "director-bridge-runtime-smoke-$PID-$([Guid]::NewGuid().ToString('N'))"
$smokeRoot = [IO.Path]::GetFullPath((Join-Path $workspaceRoot "ops\tools\$smokeName"))
$allowedPrefix = [IO.Path]::GetFullPath((Join-Path $workspaceRoot "ops\tools\director-bridge-runtime-smoke-"))
$statePath = Join-Path $smokeRoot "director-bridge-state.json"
$heartbeatPath = Join-Path $smokeRoot "director-bridge-heartbeat.json"
$stopRequestPath = Join-Path $smokeRoot "director-bridge-stop-request.json"
$notReadyRequestPath = Join-Path $smokeRoot "director-bridge-fixture-not-ready.request"
$fixtureSource = Join-Path $PSScriptRoot "fixtures\director-bridge-fake-runtime.cjs"
$fixtureEntrypoint = Join-Path $smokeRoot "director-bridge-fake-runtime.cjs"
$canary = "directorcanary$([Guid]::NewGuid().ToString('N'))"
$script:smokeInvocation = 0
$script:knownFixtureProcesses = @()
$script:runtimeTexts = @()
$script:failureCode = $null
$script:cleanupForced = $false
$script:priorNodeEnvironment = @{}

if (-not $smokeRoot.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "DIRECTOR_BRIDGE_RUNTIME_SMOKE_ROOT_INVALID"
}
if (Test-Path -LiteralPath $smokeRoot) {
  throw "DIRECTOR_BRIDGE_RUNTIME_SMOKE_ROOT_EXISTS"
}

function Invoke-DirectorBridgeSmokeScript([string]$ScriptName, [string[]]$AdditionalArguments = @()) {
  $script:smokeInvocation += 1
  $stdoutPath = Join-Path $smokeRoot "invoke-$($script:smokeInvocation).stdout.txt"
  $stderrPath = Join-Path $smokeRoot "invoke-$($script:smokeInvocation).stderr.txt"
  $arguments = @(
    "-NoProfile",
    "-ExecutionPolicy",
    "RemoteSigned",
    "-File",
    (Join-Path $PSScriptRoot $ScriptName),
    "-FixtureMode"
  ) + $AdditionalArguments
  $process = Start-Process -FilePath "powershell.exe" `
    -ArgumentList $arguments `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru
  $process.Handle | Out-Null
  $process.WaitForExit()
  $process.Refresh()
  $stdout = if (Test-Path -LiteralPath $stdoutPath) { Get-Content -Raw -LiteralPath $stdoutPath } else { "" }
  $stderr = if (Test-Path -LiteralPath $stderrPath) { Get-Content -Raw -LiteralPath $stderrPath } else { "" }
  $text = "$stdout$stderr".Trim()
  $json = $null
  if (-not [string]::IsNullOrWhiteSpace($text)) {
    try { $json = $text | ConvertFrom-Json } catch { }
  }
  $script:runtimeTexts += $text
  return [pscustomobject]@{ ExitCode = $process.ExitCode; Text = $text; Json = $json }
}

function Assert-DirectorBridgeStableFailure([object]$Invocation, [string]$ExpectedCode, [string]$FailureCode) {
  if ($Invocation.ExitCode -ne 1 -or
      $null -eq $Invocation.Json -or
      [string]$Invocation.Json.result -cne "FAIL" -or
      [string]$Invocation.Json.stable_error_code -cne $ExpectedCode -or
      (Test-Path -LiteralPath $statePath)) {
    throw $FailureCode
  }
}

function Assert-DirectorBridgeSmokeLowDisclosure([string[]]$Texts) {
  foreach ($text in $Texts) {
    if ($text.IndexOf($canary, [StringComparison]::Ordinal) -ge 0 -or
        $text -match 'WEBGPT_DIRECTOR_BRIDGE_KEY_(?:B64|DPAPI_PATH)' -or
        $text -match 'AI_VIDEO_WORKSPACE_DB_PATH') {
      throw "DIRECTOR_BRIDGE_RUNTIME_SMOKE_DISCLOSURE"
    }
  }
}

function Get-DirectorBridgeFixtureProcessCount {
  $count = 0
  foreach ($candidate in @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe' AND CommandLine LIKE '%director-bridge-fake-runtime.cjs%'" -ErrorAction Stop)) {
    if ([string]$candidate.CommandLine -and
        ([string]$candidate.CommandLine).IndexOf($fixtureEntrypoint, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $count += 1
    }
  }
  return $count
}

function Remember-DirectorBridgeFixturePid([object]$State) {
  $pidValue = [int]$State.pid
  $startTimeUtc = ([DateTimeOffset]::Parse([string]$State.process_start_time_utc)).ToUniversalTime()
  if (@($script:knownFixtureProcesses | Where-Object {
    [int]$_.pid -eq $pidValue -and
    ([DateTimeOffset]$_.process_start_time_utc).UtcDateTime.Ticks -eq $startTimeUtc.UtcDateTime.Ticks
  }).Count -eq 0) {
    $script:knownFixtureProcesses += [pscustomobject]@{
      pid = $pidValue
      process_start_time_utc = $startTimeUtc
    }
  }
}

try {
  foreach ($name in @([Environment]::GetEnvironmentVariables("Process").Keys)) {
    if ([string]$name -match '^(?i:NODE_)') {
      $script:priorNodeEnvironment[[string]$name] = [Environment]::GetEnvironmentVariable([string]$name, "Process")
      [Environment]::SetEnvironmentVariable([string]$name, $null, "Process")
    }
  }
  New-Item -ItemType Directory -Force -Path $smokeRoot | Out-Null
  $attributes = [IO.File]::GetAttributes($smokeRoot)
  if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "DIRECTOR_BRIDGE_RUNTIME_SMOKE_ROOT_REPARSE_POINT"
  }
  Copy-Item -LiteralPath $fixtureSource -Destination $fixtureEntrypoint

  if ([string]::IsNullOrWhiteSpace($env:AI_VIDEO_NODE22_PATH) -and
      -not (Test-Path -LiteralPath (Join-Path $workspaceRoot "ops\tools\node-v22.23.1-win-x64\node.exe"))) {
    $env:AI_VIDEO_NODE22_PATH = (Get-Command node.exe -ErrorAction Stop).Source
  }
  $env:AI_VIDEO_DIRECTOR_BRIDGE_RUNTIME_ROOT = $smokeRoot
  $env:AI_VIDEO_DIRECTOR_BRIDGE_FIXTURE_ENTRYPOINT = $fixtureEntrypoint
  $env:AI_VIDEO_DIRECTOR_BRIDGE_FIXTURE_MODE = "ready"
  $env:DIRECTOR_BRIDGE_RUNTIME_SMOKE_CANARY = $canary
  $env:WEBGPT_DIRECTOR_BRIDGE_KEY_ID = $canary.Substring(0, [Math]::Min(64, $canary.Length))
  $env:WEBGPT_DIRECTOR_BRIDGE_KEY_DPAPI_PATH = Join-Path $smokeRoot "$canary.dpapi"
  $env:WEBGPT_DIRECTOR_REMOTE_ORIGIN = "https://$canary.example.test"
  $env:AI_VIDEO_WORKSPACE_DB_PATH = Join-Path $smokeRoot "$canary.sqlite"
  [Environment]::SetEnvironmentVariable("WEBGPT_DIRECTOR_BRIDGE_KEY_B64", $null, "Process")
  [Environment]::SetEnvironmentVariable("FFMPEG_PATH", $null, "Process")

  . (Join-Path $PSScriptRoot "director-bridge-runtime-common.ps1") -FixtureMode
  $parserNodePath = (Resolve-DirectorBridgeNode22).NodePath
  $legacyNodeForms = @("node", "node.exe", "`"node`"", "`"node.exe`"", "`"$parserNodePath`"")
  if ($parserNodePath -notmatch '\s') { $legacyNodeForms += $parserNodePath }
  $legacyEntrypointForms = @(
    "dist/scripts/director-local-bridge.js",
    "dist\scripts\director-local-bridge.js",
    ".\dist/scripts/director-local-bridge.js",
    ".\dist\scripts\director-local-bridge.js"
  )
  foreach ($nodeForm in @($legacyNodeForms | Select-Object -Unique)) {
    foreach ($entrypoint in $legacyEntrypointForms) {
      foreach ($entrypointForm in @($entrypoint, "`"$entrypoint`"")) {
        $commandLine = "$nodeForm $entrypointForm"
        if (-not (Test-DirectorBridgeLegacyRelativeCommandLine $commandLine $parserNodePath) -or
            (Test-DirectorBridgeExactCommandLine $commandLine $parserNodePath)) {
          throw "DIRECTOR_BRIDGE_RUNTIME_SMOKE_LEGACY_ARGV_DISCOVERY_FAILED"
        }
      }
    }
  }
  foreach ($nonTarget in @(
    "`"$parserNodePath`" `"other/director-local-bridge.js`"",
    "`"$parserNodePath`" `"dist/scripts/director-local-bridge.js`" --extra",
    "`"$parserNodePath`" `"C:\other\dist\scripts\director-local-bridge.js`"",
    "node director-local-bridge.js"
  )) {
    if (Test-DirectorBridgeLegacyRelativeCommandLine $nonTarget $parserNodePath) {
      throw "DIRECTOR_BRIDGE_RUNTIME_SMOKE_LEGACY_ARGV_FALSE_POSITIVE"
    }
  }
  if (-not (Test-DirectorBridgeExactCommandLine "`"$parserNodePath`" `"$fixtureEntrypoint`"" $parserNodePath) -or
      (Test-DirectorBridgeLegacyRelativeCommandLine "`"$parserNodePath`" `"$fixtureEntrypoint`"" $parserNodePath)) {
    throw "DIRECTOR_BRIDGE_RUNTIME_SMOKE_MANAGED_ARGV_IDENTITY_FAILED"
  }

  foreach ($providerFlag in @(
    "REAL_PROVIDER_ENABLED",
    "M1_REAL_PROVIDER_EXECUTION_ALLOWED",
    "M1_REAL_PROVIDER_COST_ACK"
  )) {
    $env:REAL_PROVIDER_ENABLED = "false"
    $env:M1_REAL_PROVIDER_EXECUTION_ALLOWED = "false"
    $env:M1_REAL_PROVIDER_COST_ACK = "false"
    [Environment]::SetEnvironmentVariable($providerFlag, "true", "Process")
    $providerBlocked = Invoke-DirectorBridgeSmokeScript "director-bridge-start.ps1"
    Assert-DirectorBridgeStableFailure $providerBlocked "DIRECTOR_PROVIDER_MUST_BE_DISABLED" "DIRECTOR_BRIDGE_RUNTIME_SMOKE_PROVIDER_GATE_FAILED"
  }
  $env:REAL_PROVIDER_ENABLED = "false"
  $env:M1_REAL_PROVIDER_EXECUTION_ALLOWED = "false"
  $env:M1_REAL_PROVIDER_COST_ACK = "false"

  $env:NODE_OPTIONS = "--require=$fixtureEntrypoint"
  $nodeStartupBlocked = Invoke-DirectorBridgeSmokeScript "director-bridge-start.ps1"
  Assert-DirectorBridgeStableFailure $nodeStartupBlocked "DIRECTOR_BRIDGE_NODE_STARTUP_ENV_FORBIDDEN" "DIRECTOR_BRIDGE_RUNTIME_SMOKE_NODE_STARTUP_ENV_GATE_FAILED"
  [Environment]::SetEnvironmentVariable("NODE_OPTIONS", $null, "Process")

  $env:WEBGPT_DIRECTOR_BRIDGE_KEY_B64 = $canary
  $plaintextBlocked = Invoke-DirectorBridgeSmokeScript "director-bridge-start.ps1"
  Assert-DirectorBridgeStableFailure $plaintextBlocked "DIRECTOR_BRIDGE_PLAINTEXT_KEY_FORBIDDEN" "DIRECTOR_BRIDGE_RUNTIME_SMOKE_PLAINTEXT_GATE_FAILED"
  [Environment]::SetEnvironmentVariable("WEBGPT_DIRECTOR_BRIDGE_KEY_B64", $null, "Process")

  $lockPath = Join-Path $smokeRoot "director-bridge-lifecycle.lock"
  $heldLock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  try {
    $lockBlocked = Invoke-DirectorBridgeSmokeScript "director-bridge-start.ps1"
    Assert-DirectorBridgeStableFailure $lockBlocked "DIRECTOR_BRIDGE_RUNTIME_START_IN_PROGRESS" "DIRECTOR_BRIDGE_RUNTIME_SMOKE_LOCK_FAILED"
  } finally {
    $heldLock.Dispose()
  }

  $env:AI_VIDEO_DIRECTOR_BRIDGE_FIXTURE_MODE = "diagnostic-failure"
  $fixtureDiagnostic = Invoke-DirectorBridgeSmokeScript "director-bridge-start.ps1"
  if ($fixtureDiagnostic.ExitCode -ne 1 -or
      $null -eq $fixtureDiagnostic.Json -or
      [string]$fixtureDiagnostic.Json.result -cne "FAIL" -or
      [string]$fixtureDiagnostic.Json.stable_error_code -cne "DIRECTOR_BRIDGE_FIXTURE_DIAGNOSTIC_FAILURE" -or
      (Test-Path -LiteralPath (Join-Path $smokeRoot "director-bridge-fixture-failure.json"))) {
    throw "DIRECTOR_BRIDGE_RUNTIME_SMOKE_FIXTURE_DIAGNOSTIC_FAILED"
  }
  $env:AI_VIDEO_DIRECTOR_BRIDGE_FIXTURE_MODE = "ready"

  $started = Invoke-DirectorBridgeSmokeScript "director-bridge-start.ps1"
  if ($started.ExitCode -ne 0 -or
      $null -eq $started.Json -or
      [string]$started.Json.result -cne "STARTED" -or
      [string]$started.Json.runtime_mode -cne "fixture" -or
      [bool]$started.Json.exact_build -or
      -not [bool]$started.Json.transport_ready) {
    if ($null -ne $started.Json -and
        [string]$started.Json.stable_error_code -match '^DIRECTOR_[A-Z0-9_]{3,95}$') {
      throw ([string]$started.Json.stable_error_code)
    }
    throw "DIRECTOR_BRIDGE_RUNTIME_SMOKE_START_FAILED"
  }
  $originalStateText = Get-Content -Raw -LiteralPath $statePath
  $originalState = $originalStateText | ConvertFrom-Json
  Remember-DirectorBridgeFixturePid $originalState
  if ([string]$originalState.state_version -cne "director-bridge-runtime-state-v2" -or
      [string]$originalState.runtime_mode -cne "fixture" -or
      [bool]$originalState.exact_baseline -or
      [string]$originalState.node_executable_sha256 -notmatch '^[0-9a-f]{64}$' -or
      [string]$originalState.launch_config_sha256 -notmatch '^[0-9a-f]{64}$' -or
      [string]$originalState.launch_argv_sha256 -notmatch '^[0-9a-f]{64}$') {
    throw "DIRECTOR_BRIDGE_RUNTIME_SMOKE_STATE_V2_FAILED"
  }
  $originalHeartbeatText = Get-Content -Raw -LiteralPath $heartbeatPath
  $originalHeartbeat = $originalHeartbeatText | ConvertFrom-Json
  if ([string]$originalHeartbeat.instance_id -cne [string]$originalState.instance_id -or
      [string]$originalHeartbeat.launch_config_sha256 -cne [string]$originalState.launch_config_sha256 -or
      [string]$originalHeartbeat.launch_argv_sha256 -cne [string]$originalState.launch_argv_sha256 -or
      [bool]$originalHeartbeat.completion_pending) {
    throw "DIRECTOR_BRIDGE_RUNTIME_SMOKE_HEARTBEAT_IDENTITY_FAILED"
  }

  $status = Invoke-DirectorBridgeSmokeScript "director-bridge-status.ps1"
  if ($status.ExitCode -ne 0 -or
      $null -eq $status.Json -or
      [string]$status.Json.result -cne "RUNNING" -or
      [bool]$status.Json.exact_build -or
      -not [bool]$status.Json.transport_ready) {
    throw "DIRECTOR_BRIDGE_RUNTIME_SMOKE_STATUS_FAILED"
  }
  $priorTemp = [Environment]::GetEnvironmentVariable("TEMP", "Process")
  [Environment]::SetEnvironmentVariable("TEMP", (Join-Path $smokeRoot "bound-environment-drift"), "Process")
  try {
    $environmentDriftStatus = Invoke-DirectorBridgeSmokeScript "director-bridge-status.ps1"
    if ($environmentDriftStatus.ExitCode -ne 2 -or
        $null -eq $environmentDriftStatus.Json -or
        [string]$environmentDriftStatus.Json.result -cne "RESTART_REQUIRED") {
      throw "DIRECTOR_BRIDGE_RUNTIME_SMOKE_ENVIRONMENT_BINDING_FAILED"
    }
  } finally {
    [Environment]::SetEnvironmentVariable("TEMP", $priorTemp, "Process")
  }
  $environmentRestoredStatus = Invoke-DirectorBridgeSmokeScript "director-bridge-status.ps1"
  if ($environmentRestoredStatus.ExitCode -ne 0 -or
      $null -eq $environmentRestoredStatus.Json -or
      [string]$environmentRestoredStatus.Json.result -cne "RUNNING") {
    throw "DIRECTOR_BRIDGE_RUNTIME_SMOKE_ENVIRONMENT_RESTORE_FAILED"
  }
  [IO.File]::WriteAllText($notReadyRequestPath, "1`n", [Text.UTF8Encoding]::new($false))
  Start-Sleep -Milliseconds 500
  $notReadyStatus = Invoke-DirectorBridgeSmokeScript "director-bridge-status.ps1"
  if ($notReadyStatus.ExitCode -ne 2 -or
      $null -eq $notReadyStatus.Json -or
      [string]$notReadyStatus.Json.result -cne "NOT_READY" -or
      -not [bool]$notReadyStatus.Json.running -or
      [string]$notReadyStatus.Json.process_identity -cne "match") {
    throw "DIRECTOR_BRIDGE_RUNTIME_SMOKE_BACKOFF_FIXTURE_FAILED"
  }
  $notReadyStart = Invoke-DirectorBridgeSmokeScript "director-bridge-start.ps1"
  if ($notReadyStart.ExitCode -ne 2 -or
      $null -eq $notReadyStart.Json -or
      [string]$notReadyStart.Json.result -cne "NOT_READY" -or
      -not [bool]$notReadyStart.Json.running -or
      [bool]$notReadyStart.Json.transport_ready -or
      [string]$notReadyStart.Json.process_identity -cne "match" -or
      (Get-Content -Raw -LiteralPath $statePath) -cne $originalStateText -or
      (Get-DirectorBridgeFixtureProcessCount) -ne 1) {
    throw "DIRECTOR_BRIDGE_RUNTIME_SMOKE_NOT_READY_REPEAT_START_FAILED"
  }
  Remove-Item -LiteralPath $notReadyRequestPath -Force
  Start-Sleep -Milliseconds 500
  $recoveredStatus = Invoke-DirectorBridgeSmokeScript "director-bridge-status.ps1"
  if ($recoveredStatus.ExitCode -ne 0 -or
      $null -eq $recoveredStatus.Json -or
      [string]$recoveredStatus.Json.result -cne "RUNNING") {
    throw "DIRECTOR_BRIDGE_RUNTIME_SMOKE_BACKOFF_STATUS_RECOVERY_FAILED"
  }
  $secondStart = Invoke-DirectorBridgeSmokeScript "director-bridge-start.ps1"
  if ($secondStart.ExitCode -ne 0 -or
      $null -eq $secondStart.Json -or
      [string]$secondStart.Json.result -cne "ALREADY_RUNNING") {
    throw "DIRECTOR_BRIDGE_RUNTIME_SMOKE_IDEMPOTENT_START_FAILED"
  }
  $secondStateText = Get-Content -Raw -LiteralPath $statePath
  $secondState = $secondStateText | ConvertFrom-Json
  if ($secondStateText -cne $originalStateText -or
      [int]$secondState.pid -ne [int]$originalState.pid -or
      [string]$secondState.instance_id -cne [string]$originalState.instance_id -or
      [string]$secondState.process_start_time_utc -cne [string]$originalState.process_start_time_utc -or
      [string]$secondState.started_at_utc -cne [string]$originalState.started_at_utc -or
      (Get-DirectorBridgeFixtureProcessCount) -ne 1) {
    throw "DIRECTOR_BRIDGE_RUNTIME_SMOKE_IDEMPOTENT_IDENTITY_FAILED"
  }

  $expectedMismatch = Invoke-DirectorBridgeSmokeScript "director-bridge-start.ps1" @("-ExpectedCommit", ("1" * 40))
  if ($expectedMismatch.ExitCode -ne 1 -or
      $null -eq $expectedMismatch.Json -or
      [string]$expectedMismatch.Json.result -cne "FAIL" -or
      [string]$expectedMismatch.Json.stable_error_code -cne "DIRECTOR_BRIDGE_SOURCE_COMMIT_MISMATCH" -or
      (Get-Content -Raw -LiteralPath $statePath) -cne $originalStateText) {
    throw "DIRECTOR_BRIDGE_RUNTIME_SMOKE_EXPECTED_COMMIT_FAILED"
  }

  [IO.File]::AppendAllText($fixtureEntrypoint, "`n// fixture drift`n", [Text.UTF8Encoding]::new($false))
  $driftStatus = Invoke-DirectorBridgeSmokeScript "director-bridge-status.ps1"
  if ($driftStatus.ExitCode -ne 2 -or
      $null -eq $driftStatus.Json -or
      [string]$driftStatus.Json.result -cne "RESTART_REQUIRED") {
    throw "DIRECTOR_BRIDGE_RUNTIME_SMOKE_BUILD_DRIFT_FAILED"
  }
  Copy-Item -LiteralPath $fixtureSource -Destination $fixtureEntrypoint -Force
  $restoredStatus = Invoke-DirectorBridgeSmokeScript "director-bridge-status.ps1"
  if ($restoredStatus.ExitCode -ne 0 -or [string]$restoredStatus.Json.result -cne "RUNNING") {
    throw "DIRECTOR_BRIDGE_RUNTIME_SMOKE_BUILD_RESTORE_FAILED"
  }

  $stopped = Invoke-DirectorBridgeSmokeScript "director-bridge-stop.ps1"
  if ($stopped.ExitCode -ne 0 -or
      $null -eq $stopped.Json -or
      [string]$stopped.Json.result -cne "STOPPED" -or
      -not [bool]$stopped.Json.graceful -or
      [bool]$stopped.Json.forced -or
      -not [bool]$stopped.Json.final_receipt -or
      $null -ne (Get-Process -Id ([int]$originalState.pid) -ErrorAction SilentlyContinue)) {
    throw "DIRECTOR_BRIDGE_RUNTIME_SMOKE_STOP_FAILED"
  }
  $stoppedStatus = Invoke-DirectorBridgeSmokeScript "director-bridge-status.ps1"
  if ($stoppedStatus.ExitCode -ne 1 -or
      $null -eq $stoppedStatus.Json -or
      [string]$stoppedStatus.Json.result -cne "STOPPED") {
    throw "DIRECTOR_BRIDGE_RUNTIME_SMOKE_STOPPED_STATUS_FAILED"
  }

  $staleState = $originalStateText | ConvertFrom-Json
  $staleState.pid = 2147483000
  $staleState.process_start_time_utc = [DateTime]::UtcNow.AddDays(-1).ToString("o")
  [IO.File]::WriteAllText($statePath, (($staleState | ConvertTo-Json -Depth 8 -Compress) + "`n"), [Text.UTF8Encoding]::new($false))
  $staleHeartbeat = $originalHeartbeatText | ConvertFrom-Json
  $staleHeartbeat.pid = 2147483000
  $staleHeartbeat.phase = "completing"
  $staleHeartbeat.heartbeat_at_utc = [DateTime]::UtcNow.ToString("o")
  $staleHeartbeat.stop_requested = $false
  $staleHeartbeat.completion_pending = $true
  [IO.File]::WriteAllText($heartbeatPath, (($staleHeartbeat | ConvertTo-Json -Depth 8 -Compress) + "`n"), [Text.UTF8Encoding]::new($false))
  Remove-Item -LiteralPath $stopRequestPath -Force -ErrorAction SilentlyContinue

  $pendingStateText = Get-Content -Raw -LiteralPath $statePath
  $pendingHeartbeatText = Get-Content -Raw -LiteralPath $heartbeatPath
  $pendingStateBytes = [Convert]::ToBase64String([IO.File]::ReadAllBytes($statePath))
  $pendingHeartbeatBytes = [Convert]::ToBase64String([IO.File]::ReadAllBytes($heartbeatPath))
  $pendingBlocked = Invoke-DirectorBridgeSmokeScript "director-bridge-start.ps1"
  if ($pendingBlocked.ExitCode -ne 1 -or
      $null -eq $pendingBlocked.Json -or
      [string]$pendingBlocked.Json.result -cne "FAIL" -or
      [string]$pendingBlocked.Json.stable_error_code -cne "DIRECTOR_BRIDGE_COMPLETION_UNCONFIRMED" -or
      [Convert]::ToBase64String([IO.File]::ReadAllBytes($statePath)) -cne $pendingStateBytes -or
      [Convert]::ToBase64String([IO.File]::ReadAllBytes($heartbeatPath)) -cne $pendingHeartbeatBytes -or
      (Test-Path -LiteralPath $stopRequestPath) -or
      (Get-DirectorBridgeFixtureProcessCount) -ne 0) {
    throw "DIRECTOR_BRIDGE_RUNTIME_SMOKE_PENDING_RECEIPT_FAILED"
  }

  $invalidHeartbeatText = "{invalid-heartbeat"
  [IO.File]::WriteAllText($heartbeatPath, $invalidHeartbeatText, [Text.UTF8Encoding]::new($false))
  $invalidHeartbeatBytes = [Convert]::ToBase64String([IO.File]::ReadAllBytes($heartbeatPath))
  $invalidBlocked = Invoke-DirectorBridgeSmokeScript "director-bridge-start.ps1"
  if ($invalidBlocked.ExitCode -ne 1 -or
      $null -eq $invalidBlocked.Json -or
      [string]$invalidBlocked.Json.result -cne "FAIL" -or
      [string]$invalidBlocked.Json.stable_error_code -cne "DIRECTOR_BRIDGE_HEARTBEAT_INVALID" -or
      [Convert]::ToBase64String([IO.File]::ReadAllBytes($statePath)) -cne $pendingStateBytes -or
      [Convert]::ToBase64String([IO.File]::ReadAllBytes($heartbeatPath)) -cne $invalidHeartbeatBytes -or
      (Test-Path -LiteralPath $stopRequestPath) -or
      (Get-DirectorBridgeFixtureProcessCount) -ne 0) {
    throw "DIRECTOR_BRIDGE_RUNTIME_SMOKE_INVALID_RECEIPT_FAILED"
  }

  $staleHeartbeat.completion_pending = $false
  $staleHeartbeat.phase = "handling"
  $staleHeartbeat.heartbeat_at_utc = [DateTime]::UtcNow.ToString("o")
  [IO.File]::WriteAllText($heartbeatPath, (($staleHeartbeat | ConvertTo-Json -Depth 8 -Compress) + "`n"), [Text.UTF8Encoding]::new($false))
  $handlingHeartbeatText = Get-Content -Raw -LiteralPath $heartbeatPath
  $handlingHeartbeatBytes = [Convert]::ToBase64String([IO.File]::ReadAllBytes($heartbeatPath))
  $handlingBlocked = Invoke-DirectorBridgeSmokeScript "director-bridge-start.ps1"
  if ($handlingBlocked.ExitCode -ne 1 -or
      $null -eq $handlingBlocked.Json -or
      [string]$handlingBlocked.Json.result -cne "FAIL" -or
      [string]$handlingBlocked.Json.stable_error_code -cne "DIRECTOR_BRIDGE_COMPLETION_UNCONFIRMED" -or
      [Convert]::ToBase64String([IO.File]::ReadAllBytes($statePath)) -cne $pendingStateBytes -or
      [Convert]::ToBase64String([IO.File]::ReadAllBytes($heartbeatPath)) -cne $handlingHeartbeatBytes -or
      (Test-Path -LiteralPath $stopRequestPath) -or
      (Get-DirectorBridgeFixtureProcessCount) -ne 0) {
    throw "DIRECTOR_BRIDGE_RUNTIME_SMOKE_HANDLING_RECEIPT_FAILED"
  }

  $staleHeartbeat.phase = "failed"
  $staleHeartbeat.heartbeat_at_utc = [DateTime]::UtcNow.ToString("o")
  [IO.File]::WriteAllText($heartbeatPath, (($staleHeartbeat | ConvertTo-Json -Depth 8 -Compress) + "`n"), [Text.UTF8Encoding]::new($false))
  $staleStatus = Invoke-DirectorBridgeSmokeScript "director-bridge-status.ps1"
  if ($staleStatus.ExitCode -ne 2 -or
      $null -eq $staleStatus.Json -or
      [string]$staleStatus.Json.result -cne "STALE_STATE") {
    throw "DIRECTOR_BRIDGE_RUNTIME_SMOKE_STALE_STATE_FAILED"
  }
  $restarted = Invoke-DirectorBridgeSmokeScript "director-bridge-start.ps1"
  if ($restarted.ExitCode -ne 0 -or
      $null -eq $restarted.Json -or
      [string]$restarted.Json.result -cne "STARTED") {
    throw "DIRECTOR_BRIDGE_RUNTIME_SMOKE_STALE_RECOVERY_FAILED"
  }
  $restartedStateText = Get-Content -Raw -LiteralPath $statePath
  $restartedState = $restartedStateText | ConvertFrom-Json
  Remember-DirectorBridgeFixturePid $restartedState
  if ([int]$restartedState.pid -eq [int]$originalState.pid -or
      [string]$restartedState.instance_id -ceq [string]$originalState.instance_id) {
    throw "DIRECTOR_BRIDGE_RUNTIME_SMOKE_STALE_RECOVERY_IDENTITY_FAILED"
  }
  $restartedHeartbeatText = Get-Content -Raw -LiteralPath $heartbeatPath
  $restartStopped = Invoke-DirectorBridgeSmokeScript "director-bridge-stop.ps1"
  if ($restartStopped.ExitCode -ne 0 -or
      [string]$restartStopped.Json.result -cne "STOPPED" -or
      -not [bool]$restartStopped.Json.final_receipt -or
      $null -ne (Get-Process -Id ([int]$restartedState.pid) -ErrorAction SilentlyContinue)) {
    throw "DIRECTOR_BRIDGE_RUNTIME_SMOKE_RECOVERY_STOP_FAILED"
  }

  $script:runtimeTexts += @(
    $originalStateText,
    $originalHeartbeatText,
    $secondStateText,
    $pendingStateText,
    $pendingHeartbeatText,
    $invalidHeartbeatText,
    $handlingHeartbeatText,
    $restartedStateText,
    $restartedHeartbeatText
  )
  foreach ($file in @(Get-ChildItem -LiteralPath $smokeRoot -File -ErrorAction SilentlyContinue)) {
    if ($file.FullName.Equals($fixtureEntrypoint, [StringComparison]::OrdinalIgnoreCase)) { continue }
    $script:runtimeTexts += Get-Content -Raw -LiteralPath $file.FullName -ErrorAction SilentlyContinue
  }
  Assert-DirectorBridgeSmokeLowDisclosure $script:runtimeTexts
} catch {
  $message = [string]$_.Exception.Message
  $script:failureCode = if ($message -match '^DIRECTOR_[A-Z0-9_]{3,95}$') {
    $message
  } else {
    "DIRECTOR_BRIDGE_RUNTIME_SMOKE_FAILED"
  }
} finally {
  foreach ($name in @([Environment]::GetEnvironmentVariables("Process").Keys)) {
    if ([string]$name -match '^(?i:NODE_)') {
      [Environment]::SetEnvironmentVariable([string]$name, $null, "Process")
    }
  }
  foreach ($name in $script:priorNodeEnvironment.Keys) {
    [Environment]::SetEnvironmentVariable([string]$name, [string]$script:priorNodeEnvironment[$name], "Process")
  }
  if (Test-Path -LiteralPath $statePath -PathType Leaf) {
    try {
      $cleanupStop = Invoke-DirectorBridgeSmokeScript "director-bridge-stop.ps1"
      if ($cleanupStop.ExitCode -ne 0) { $script:failureCode = "DIRECTOR_BRIDGE_RUNTIME_SMOKE_CLEANUP_FAILED" }
    } catch {
      $script:failureCode = "DIRECTOR_BRIDGE_RUNTIME_SMOKE_CLEANUP_FAILED"
    }
  }
  foreach ($fixtureProcess in $script:knownFixtureProcesses) {
    $fixturePid = [int]$fixtureProcess.pid
    $live = Get-Process -Id $fixturePid -ErrorAction SilentlyContinue
    if ($null -ne $live) {
      try {
        $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $fixturePid" -ErrorAction Stop
        $expectedStartTimeUtc = ([DateTimeOffset]$fixtureProcess.process_start_time_utc).ToUniversalTime()
        $actualStartTimeUtc = [DateTimeOffset]::new($live.StartTime.ToUniversalTime())
        $startMatches = $actualStartTimeUtc.UtcDateTime.Ticks -eq $expectedStartTimeUtc.UtcDateTime.Ticks
        if ($null -eq $candidate -or
            -not $startMatches -or
            ([string]$candidate.CommandLine).IndexOf($fixtureEntrypoint, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
          continue
        }
        Stop-Process -Id $fixturePid -Force -ErrorAction Stop
        $script:cleanupForced = $true
        if ($null -eq $script:failureCode) {
          $script:failureCode = "DIRECTOR_BRIDGE_RUNTIME_SMOKE_CLEANUP_FORCED"
        }
      } catch {
        if ($null -eq $script:failureCode) {
          $script:failureCode = "DIRECTOR_BRIDGE_RUNTIME_SMOKE_CLEANUP_FAILED"
        }
      }
    }
  }
  $remainingFixtureProcesses = 0
  try { $remainingFixtureProcesses = Get-DirectorBridgeFixtureProcessCount } catch { $remainingFixtureProcesses = 1 }
  $resolved = [IO.Path]::GetFullPath($smokeRoot)
  if ($null -eq $script:failureCode -and
      $remainingFixtureProcesses -eq 0 -and
      $resolved.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase) -and
      (Test-Path -LiteralPath $resolved) -and
      (([IO.File]::GetAttributes($resolved) -band [IO.FileAttributes]::ReparsePoint) -eq 0)) {
    Remove-Item -LiteralPath $resolved -Recurse -Force
  } elseif ($remainingFixtureProcesses -gt 0 -and $null -eq $script:failureCode) {
    $script:failureCode = "DIRECTOR_BRIDGE_RUNTIME_SMOKE_CLEANUP_FAILED"
  }
}

if ($null -ne $script:failureCode) {
  [Console]::Error.WriteLine((ConvertTo-Json ([ordered]@{
    result = "FAIL"
    stable_error_code = $script:failureCode
  }) -Compress))
  exit 1
}

[ordered]@{
  result = "PASS"
  runtime_mode = "fixture"
  activation_gate = $true
  managed_start = $true
  idempotent_start = $true
  expected_commit_gate = $true
  actual_entrypoint_drift = "RESTART_REQUIRED"
  legacy_relative_argv_discovery = $true
  pending_completion_receipt_preserved = $true
  invalid_heartbeat_receipt_preserved = $true
  in_flight_phase_receipt_preserved = $true
  stale_state_start_recovery = $true
  graceful_stop = $true
  final_stop_receipt = $true
  forced_stop = $false
  fixture_failure_receipt = $true
  provider_enabled = $false
  plaintext_key_inheritance = $false
  node_startup_environment_rejected = $true
  startup_environment_binding = $true
  not_ready_repeat_start = $true
} | ConvertTo-Json
