param(
  [switch]$FixtureMode
)

. (Join-Path $PSScriptRoot "director-bridge-runtime-common.ps1") -FixtureMode:$FixtureMode

$lifecycleLock = $null
try {
  Assert-DirectorBridgePrivateRuntime
  if (-not (Test-Path -LiteralPath $script:DirectorBridgeRuntimeRoot -PathType Container)) {
    if (@(Get-DirectorBridgeTargetProcesses).Count -gt 0) { throw "DIRECTOR_BRIDGE_RUNTIME_UNMANAGED_PROCESS" }
    Write-DirectorBridgeJson ([ordered]@{
      result = "ALREADY_STOPPED"
      running = $false
      managed = $false
      runtime_mode = $script:DirectorBridgeRuntimeMode
      graceful = $false
      forced = $false
      final_receipt = $false
    })
    exit 0
  }
  $lifecycleLock = Enter-DirectorBridgeLifecycleLock
  $state = Read-DirectorBridgeState
  if ($null -eq $state) {
    if (@(Get-DirectorBridgeTargetProcesses).Count -gt 0) { throw "DIRECTOR_BRIDGE_RUNTIME_UNMANAGED_PROCESS" }
    if ((Test-Path -LiteralPath $script:DirectorBridgeHeartbeatPath) -or
        (Test-Path -LiteralPath $script:DirectorBridgeStopRequestPath)) {
      throw "DIRECTOR_BRIDGE_RUNTIME_RECEIPTS_UNBOUND"
    }
    Remove-Item -LiteralPath $script:DirectorBridgeActivationPath -Force -ErrorAction SilentlyContinue
    Write-DirectorBridgeJson ([ordered]@{
      result = "ALREADY_STOPPED"
      running = $false
      managed = $false
      runtime_mode = $script:DirectorBridgeRuntimeMode
      graceful = $false
      forced = $false
      final_receipt = $false
    })
    exit 0
  }

  Assert-DirectorBridgeState $state
  $identity = Get-DirectorBridgeProcessIdentity $state
  if ($identity -eq "mismatch") { throw "DIRECTOR_BRIDGE_RUNTIME_PROCESS_IDENTITY_MISMATCH" }
  if ($identity -eq "missing") {
    Resolve-DirectorBridgeMissingProcessReceipts $state
    Write-DirectorBridgeJson ([ordered]@{
      result = "STALE_STATE_REMOVED"
      running = $false
      managed = $true
      runtime_mode = $script:DirectorBridgeRuntimeMode
      graceful = $false
      forced = $false
      final_receipt = $false
    })
    exit 0
  }

  $stopRequestedAt = [DateTimeOffset]::UtcNow
  Write-DirectorBridgeStopRequest $state
  $stopTimeoutSeconds = if ($script:DirectorBridgeFixtureMode) { 15 } else { 180 }
  if (-not (Wait-DirectorBridgeProcessExit ([int]$state.pid) $stopTimeoutSeconds)) {
    throw "DIRECTOR_BRIDGE_RUNTIME_STOP_TIMEOUT"
  }

  $finalState = Get-DirectorBridgeFinalReceiptState $state $stopRequestedAt
  if ($finalState -eq "completion_unconfirmed") { throw "DIRECTOR_BRIDGE_COMPLETION_UNCONFIRMED" }
  if ($finalState -ne "confirmed") { throw "DIRECTOR_BRIDGE_RUNTIME_STOP_UNCONFIRMED" }

  Remove-DirectorBridgeRuntimeReceipts
  Write-DirectorBridgeJson ([ordered]@{
    result = "STOPPED"
    running = $false
    managed = $true
    runtime_mode = $script:DirectorBridgeRuntimeMode
    graceful = $true
    forced = $false
    final_receipt = $true
  })
  exit 0
} catch {
  Write-DirectorBridgeFailure $_
  exit 1
} finally {
  if ($null -ne $lifecycleLock) { Exit-DirectorBridgeLifecycleLock $lifecycleLock }
}
