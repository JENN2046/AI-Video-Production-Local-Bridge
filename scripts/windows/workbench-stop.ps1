. (Join-Path $PSScriptRoot "workbench-runtime-common.ps1")

try {
  $state = Read-WorkbenchState
  if ($null -eq $state) {
    $defaultPort = Resolve-WorkbenchPort
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

  $shutdownToken = if ($state.PSObject.Properties.Name -contains "shutdown_token") { [string]$state.shutdown_token } else { "" }
  if ([string]::IsNullOrWhiteSpace($shutdownToken)) {
    throw "WORKBENCH_SHUTDOWN_TOKEN_MISSING: refusing unmanaged force stop"
  }

  $gracefulAccepted = $false
  try {
    $shutdownResponse = Invoke-WebRequest -UseBasicParsing `
      -Method POST `
      -Uri "http://127.0.0.1:$port/_local/shutdown" `
      -Headers @{ "x-ai-video-shutdown-token" = $shutdownToken } `
      -TimeoutSec 5
    $gracefulAccepted = [int]$shutdownResponse.StatusCode -eq 202
  } catch { }

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
  $forced = $false
  if (-not $released) {
    $forced = $true
    $processBeforeForce = Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue
    if ($null -ne $processBeforeForce) {
      Stop-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue
    }
    for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
      Start-Sleep -Milliseconds 250
      $process = Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue
      $currentListener = Get-WorkbenchListenerPid $port
      if ($null -eq $process -and $null -eq $currentListener) {
        $released = $true
        break
      }
    }
  }
  if (-not $released) { throw "WORKBENCH_STOP_TIMEOUT: state preserved for inspection" }

  Remove-Item -LiteralPath $script:StatePath -Force
  Write-WorkbenchJson ([pscustomobject]@{
    result = "STOPPED"
    pid = [int]$state.pid
    port = $port
    port_released = $true
    graceful = $gracefulAccepted -and -not $forced
    forced = $forced
  })
  exit 0
} catch {
  [Console]::Error.WriteLine((ConvertTo-Json ([ordered]@{ result = "FAIL"; error = $_.Exception.Message }) -Compress))
  exit 1
}
