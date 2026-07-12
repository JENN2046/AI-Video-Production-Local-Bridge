. (Join-Path $PSScriptRoot "workbench-runtime-common.ps1")

try {
  $state = Read-WorkbenchState
  $defaultPort = Resolve-WorkbenchPort
  if ($null -eq $state) {
    $listenerPid = Get-WorkbenchListenerPid $defaultPort
    if ($null -ne $listenerPid) {
      throw "WORKBENCH_UNMANAGED_LISTENER: refusing to stop PID $listenerPid"
    }
    Write-WorkbenchJson ([pscustomobject]@{ result = "ALREADY_STOPPED"; port = $defaultPort })
    exit 0
  }

  $port = [int]$state.port
  $listenerPid = Get-WorkbenchListenerPid $port
  $identityMatches = Test-WorkbenchProcessIdentity $state
  if (-not $identityMatches) {
    if ($null -ne $listenerPid) {
      throw "WORKBENCH_STATE_CONFLICT: listener PID $listenerPid does not match managed process identity"
    }
    Remove-Item -LiteralPath $script:StatePath -Force
    Write-WorkbenchJson ([pscustomobject]@{ result = "STALE_STATE_REMOVED"; pid = [int]$state.pid; port = $port })
    exit 0
  }

  if ($listenerPid -ne [int]$state.pid) {
    throw "WORKBENCH_LISTENER_MISMATCH: refusing to stop managed PID"
  }

  Stop-Process -Id ([int]$state.pid) -ErrorAction Stop
  $released = $false
  for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
    Start-Sleep -Milliseconds 250
    $process = Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue
    $currentListener = Get-WorkbenchListenerPid $port
    if ($null -eq $process -and $null -eq $currentListener) {
      $released = $true
      break
    }
  }
  if (-not $released) { throw "WORKBENCH_STOP_TIMEOUT: state preserved for inspection" }

  Remove-Item -LiteralPath $script:StatePath -Force
  Write-WorkbenchJson ([pscustomobject]@{
    result = "STOPPED"
    pid = [int]$state.pid
    port = $port
    port_released = $true
  })
  exit 0
} catch {
  [Console]::Error.WriteLine((ConvertTo-Json ([ordered]@{ result = "FAIL"; error = $_.Exception.Message }) -Compress))
  exit 1
}
