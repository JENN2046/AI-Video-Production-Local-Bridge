param(
  [string]$ExpectedCommit = "",
  [switch]$FixtureMode
)

. (Join-Path $PSScriptRoot "director-bridge-runtime-common.ps1") -FixtureMode:$FixtureMode

$lifecycleLock = $null
$startedProcess = $null
$state = $null
$instanceId = ""
$launchEnvironment = $null

try {
  Assert-DirectorBridgeNoNodeStartupEnvironment
  Assert-DirectorBridgeProviderDisabled
  Assert-DirectorBridgeNoPlaintextKey
  Assert-DirectorBridgeExpectedCommit $ExpectedCommit
  Assert-DirectorBridgePrivateRuntime
  New-Item -ItemType Directory -Force -Path $script:DirectorBridgeRuntimeRoot | Out-Null
  $lifecycleLock = Enter-DirectorBridgeLifecycleLock

  $existing = Read-DirectorBridgeState
  if ($null -ne $existing) {
    Assert-DirectorBridgeState $existing
    if (-not [string]::IsNullOrWhiteSpace($ExpectedCommit) -and [string]$existing.source_commit -cne $ExpectedCommit) {
      throw "DIRECTOR_BRIDGE_SOURCE_COMMIT_MISMATCH"
    }
    $assessment = Get-DirectorBridgeRuntimeAssessment $existing
    if ($assessment.ProcessIdentity -eq "match") {
      $result = if ($assessment.Result -eq "RUNNING") { "ALREADY_RUNNING" } else { [string]$assessment.Result }
      Write-DirectorBridgeJson ([ordered]@{
        result = $result
        running = [bool]$assessment.Running
        managed = $true
        runtime_mode = $script:DirectorBridgeRuntimeMode
        exact_build = [bool]$assessment.ExactBuild
        transport_ready = [bool]$assessment.TransportReady
        source_commit = [string]$existing.source_commit
        process_identity = [string]$assessment.ProcessIdentity
        configuration_identity = [string]$assessment.ConfigurationIdentity
        heartbeat = [string]$assessment.Heartbeat
        remote_contact = [string]$assessment.RemoteContact
        phase = $assessment.Phase
        provider_enabled = $false
        started_at_utc = [string]$existing.started_at_utc
      })
      exit ([int]$assessment.ExitCode)
    }
    if ($assessment.ProcessIdentity -ne "missing") {
      throw "DIRECTOR_BRIDGE_RUNTIME_STATE_CONFLICT"
    }
    Resolve-DirectorBridgeMissingProcessReceipts $existing
  } else {
    if (@(Get-DirectorBridgeTargetProcesses).Count -gt 0) {
      throw "DIRECTOR_BRIDGE_RUNTIME_UNMANAGED_PROCESS"
    }
    if ((Test-Path -LiteralPath $script:DirectorBridgeHeartbeatPath) -or
        (Test-Path -LiteralPath $script:DirectorBridgeStopRequestPath)) {
      throw "DIRECTOR_BRIDGE_RUNTIME_RECEIPTS_UNBOUND"
    }
    Remove-Item -LiteralPath $script:DirectorBridgeActivationPath -Force -ErrorAction SilentlyContinue
    if ($script:DirectorBridgeFixtureMode) {
      Remove-Item -LiteralPath $script:DirectorBridgeFixtureFailureReceiptPath -Force -ErrorAction SilentlyContinue
    }
  }

  $launchEnvironment = Get-DirectorBridgeLaunchEnvironment
  $launchConfigSha = Get-DirectorBridgeLaunchConfigSha256 $launchEnvironment
  $runtime = Resolve-DirectorBridgeNode22
  $sourceCommit = Assert-DirectorBridgeSourceBaseline $ExpectedCommit

  if (-not $script:DirectorBridgeFixtureMode) {
    $priorPath = $env:PATH
    $env:PATH = "$(Split-Path -Parent $runtime.NodePath);$priorPath"
    Push-Location $script:DirectorBridgeWorkspaceRoot
    try {
      & $runtime.NpmPath run build:server *> $null
      if ($LASTEXITCODE -ne 0) { throw "DIRECTOR_BRIDGE_BUILD_FAILED" }
    } finally {
      Pop-Location
      $env:PATH = $priorPath
    }
    if ((Get-DirectorBridgeSourceCommit) -cne $sourceCommit -or -not (Test-DirectorBridgeTrackedSourceClean)) {
      throw "DIRECTOR_BRIDGE_SOURCE_CHANGED_DURING_BUILD"
    }
  }

  $entrypointSha = Get-DirectorBridgeFileSha256 $script:DirectorBridgeEntrypointPath "DIRECTOR_BRIDGE_ENTRYPOINT_FINGERPRINT_FAILED"
  $buildManifestSha = Get-DirectorBridgeBuildManifestSha256
  $nodeSha = Get-DirectorBridgeFileSha256 $runtime.NodePath "DIRECTOR_BRIDGE_NODE22_INVALID"
  $launchArgvSha = Get-DirectorBridgeLaunchArgvSha256 $runtime.NodePath $script:DirectorBridgeEntrypointPath
  $launchEnvironment = Get-DirectorBridgeLaunchEnvironment
  $launchConfigSha = Get-DirectorBridgeLaunchConfigSha256 $launchEnvironment
  $instanceId = New-DirectorBridgeInstanceId
  foreach ($path in @(
    $script:DirectorBridgeHeartbeatPath,
    $script:DirectorBridgeStopRequestPath,
    $script:DirectorBridgeActivationPath
  )) {
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  }

  Add-DirectorBridgeRuntimeEnvironment `
    -Environment $launchEnvironment `
    -InstanceId $instanceId `
    -SourceCommit $sourceCommit `
    -BuildManifestSha $buildManifestSha `
    -EntrypointSha $entrypointSha `
    -LaunchConfigSha $launchConfigSha `
    -LaunchArgvSha $launchArgvSha

  $stamp = [DateTime]::UtcNow.ToString("yyyyMMdd-HHmmss")
  $stdoutPath = Join-Path $script:DirectorBridgeRuntimeRoot "director-bridge-$stamp.stdout.log"
  $stderrPath = Join-Path $script:DirectorBridgeRuntimeRoot "director-bridge-$stamp.stderr.log"
  $startedProcess = Start-DirectorBridgeNodeProcess `
    -NodePath $runtime.NodePath `
    -EntrypointPath $script:DirectorBridgeEntrypointPath `
    -LaunchEnvironment $launchEnvironment `
    -StdoutPath $stdoutPath `
    -StderrPath $stderrPath
  $startedProcess.Handle | Out-Null
  $startedProcess.Refresh()

  $state = [ordered]@{
    state_version = "director-bridge-runtime-state-v2"
    runtime_mode = $script:DirectorBridgeRuntimeMode
    instance_id = $instanceId
    pid = $startedProcess.Id
    process_start_time_utc = $startedProcess.StartTime.ToUniversalTime().ToString("o")
    started_at_utc = [DateTime]::UtcNow.ToString("o")
    node_executable = $runtime.NodePath
    node_executable_sha256 = $nodeSha
    node_version = $runtime.Version
    entrypoint_relative_path = $script:DirectorBridgeEntrypointRelativePath
    entrypoint_sha256 = $entrypointSha
    source_commit = $sourceCommit
    build_manifest_sha256 = $buildManifestSha
    launch_config_sha256 = $launchConfigSha
    launch_argv_sha256 = $launchArgvSha
    exact_baseline = -not $script:DirectorBridgeFixtureMode
    provider_enabled = $false
    heartbeat_interval_seconds = 5
  }
  Write-DirectorBridgeAtomicJson $script:DirectorBridgeStatePath $state

  $activationDeadline = [DateTime]::UtcNow.AddSeconds(15)
  $activationCandidate = $false
  while ([DateTime]::UtcNow -lt $activationDeadline) {
    $startedProcess.Refresh()
    if ($startedProcess.HasExited) { break }
    if (Test-DirectorBridgeActivationCandidate ([pscustomobject]$state)) {
      $activationCandidate = $true
      break
    }
    Start-Sleep -Milliseconds 100
  }
  $startedProcess.Refresh()
  if ($startedProcess.HasExited) { Throw-DirectorBridgeChildExit }
  if (-not $activationCandidate) { throw "DIRECTOR_BRIDGE_RUNTIME_ACTIVATION_TIMEOUT" }
  Write-DirectorBridgeActivation ([pscustomobject]$state)

  $startupTimeoutSeconds = if ($script:DirectorBridgeFixtureMode) { 15 } else { 180 }
  $deadline = [DateTime]::UtcNow.AddSeconds($startupTimeoutSeconds)
  $assessment = $null
  while ([DateTime]::UtcNow -lt $deadline) {
    $startedProcess.Refresh()
    if ($startedProcess.HasExited) { break }
    $assessment = Get-DirectorBridgeRuntimeAssessment ([pscustomobject]$state)
    if ($assessment.Result -eq "RUNNING") { break }
    Start-Sleep -Milliseconds 250
  }
  $startedProcess.Refresh()
  if ($startedProcess.HasExited) { Throw-DirectorBridgeChildExit }
  if ($null -eq $assessment -or $assessment.Result -ne "RUNNING") {
    throw "DIRECTOR_BRIDGE_RUNTIME_HEARTBEAT_TIMEOUT"
  }

  Write-DirectorBridgeJson ([ordered]@{
    result = "STARTED"
    running = $true
    managed = $true
    runtime_mode = $script:DirectorBridgeRuntimeMode
    exact_build = [bool]$assessment.ExactBuild
    transport_ready = [bool]$assessment.TransportReady
    source_commit = $sourceCommit
    configuration_identity = [string]$assessment.ConfigurationIdentity
    heartbeat = [string]$assessment.Heartbeat
    remote_contact = [string]$assessment.RemoteContact
    provider_enabled = $false
    started_at_utc = [string]$state.started_at_utc
  })
  exit 0
} catch {
  $failure = $_
  $cleanupTimedOut = $false
  if ($null -ne $startedProcess -and -not [string]::IsNullOrWhiteSpace($instanceId)) {
    try {
      $startedProcess.Refresh()
      if (-not $startedProcess.HasExited) {
        Write-DirectorBridgeStopRequestByInstance $instanceId
        $cleanupTimedOut = -not (Wait-DirectorBridgeProcessExit $startedProcess.Id 20)
      }
    } catch {
      $cleanupTimedOut = $true
    }
  }
  if ($cleanupTimedOut) {
    [Console]::Error.WriteLine((ConvertTo-Json ([ordered]@{
      result = "FAIL"
      stable_error_code = "DIRECTOR_BRIDGE_RUNTIME_CLEANUP_TIMEOUT"
    }) -Compress))
  } else {
    Write-DirectorBridgeFailure $failure
  }
  exit 1
} finally {
  if ($null -ne $lifecycleLock) { Exit-DirectorBridgeLifecycleLock $lifecycleLock }
}
