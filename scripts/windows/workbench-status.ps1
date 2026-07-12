. (Join-Path $PSScriptRoot "workbench-runtime-common.ps1")

try {
  $state = Read-WorkbenchState
  if ($null -eq $state) {
    $defaultPort = Resolve-WorkbenchPort
    $listenerPid = Get-WorkbenchListenerPid $defaultPort
    Write-WorkbenchJson ([pscustomobject]@{
      result = if ($null -eq $listenerPid) { "STOPPED" } else { "UNMANAGED_LISTENER" }
      running = $false
      port = $defaultPort
      listener_pid = $listenerPid
    })
    if ($null -eq $listenerPid) { exit 1 }
    exit 2
  }

  $port = [int]$state.port
  $listenerPid = Get-WorkbenchListenerPid $port
  $identityMatches = Test-WorkbenchProcessIdentity $state
  $running = $identityMatches -and $listenerPid -eq [int]$state.pid
  $http = Get-WorkbenchHttpStatus $port
  $process = if ($identityMatches) { Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue } else { $null }

  Write-WorkbenchJson ([pscustomobject]@{
    result = if ($running -and $http.ready) { "RUNNING" } elseif ($running) { "NOT_READY" } else { "STALE_OR_CONFLICTED_STATE" }
    running = $running
    pid = [int]$state.pid
    port = $port
    health_status = $http.health_status
    ready_status = $http.ready_status
    ready = $http.ready
    checks = $http.checks
    provider_enabled = [bool]$state.provider_enabled
    node_version = [string]$state.node_version
    working_set_mb = if ($null -ne $process) { [math]::Round($process.WorkingSet64 / 1MB, 2) } else { $null }
    started_at_utc = [string]$state.started_at_utc
  })

  if ($running -and $http.ready) { exit 0 }
  exit 2
} catch {
  [Console]::Error.WriteLine((ConvertTo-Json ([ordered]@{ result = "FAIL"; error = $_.Exception.Message }) -Compress))
  exit 1
}
