param(
  [switch]$FixtureMode
)

. (Join-Path $PSScriptRoot "director-bridge-runtime-common.ps1") -FixtureMode:$FixtureMode

try {
  Assert-DirectorBridgePrivateRuntime
  $state = Read-DirectorBridgeState
  if ($null -eq $state) {
    $targets = @(Get-DirectorBridgeTargetProcesses)
    $result = if ($targets.Count -gt 0) { "UNMANAGED_PROCESS" } else { "STOPPED" }
    Write-DirectorBridgeJson ([ordered]@{
      result = $result
      running = $false
      managed = $false
      runtime_mode = $script:DirectorBridgeRuntimeMode
      exact_build = $false
      transport_ready = $false
      process_identity = if ($targets.Count -gt 0) { "unmanaged" } else { "missing" }
      heartbeat = "missing"
      remote_contact = "missing"
      provider_enabled = $false
    })
    if ($targets.Count -gt 0) { exit 2 }
    exit 1
  }

  $assessment = Get-DirectorBridgeRuntimeAssessment $state
  Write-DirectorBridgeJson ([ordered]@{
    result = [string]$assessment.Result
    running = [bool]$assessment.Running
    managed = $true
    runtime_mode = $script:DirectorBridgeRuntimeMode
    exact_build = [bool]$assessment.ExactBuild
    transport_ready = [bool]$assessment.TransportReady
    source_commit = [string]$state.source_commit
    process_identity = [string]$assessment.ProcessIdentity
    heartbeat = [string]$assessment.Heartbeat
    remote_contact = [string]$assessment.RemoteContact
    phase = $assessment.Phase
    provider_enabled = $false
    started_at_utc = [string]$state.started_at_utc
    last_heartbeat_at_utc = $assessment.LastHeartbeat
  })
  exit ([int]$assessment.ExitCode)
} catch {
  Write-DirectorBridgeFailure $_
  exit 1
}
