. (Join-Path $PSScriptRoot "workbench-runtime-common.ps1")

try {
  New-Item -ItemType Directory -Force -Path $script:RuntimeRoot | Out-Null
  $state = Read-WorkbenchState
  $port = if ($null -ne $state) { [int]$state.port } else { Resolve-WorkbenchPort }
  $listenerPid = Get-WorkbenchListenerPid $port

  if ($null -ne $state) {
    $identityMatches = Test-WorkbenchProcessIdentity $state
    if ($identityMatches -and $listenerPid -eq [int]$state.pid) {
      $http = Get-WorkbenchHttpStatus $port
      Write-WorkbenchJson ([pscustomobject]@{
        result = "ALREADY_RUNNING"
        pid = [int]$state.pid
        port = $port
        health_status = $http.health_status
        ready_status = $http.ready_status
        ready = $http.ready
      })
      if (-not $http.ready) { exit 2 }
      exit 0
    }

    if ($identityMatches -or $null -ne $listenerPid) {
      throw "WORKBENCH_STATE_CONFLICT: refusing to replace live or ambiguous state"
    }
    Remove-Item -LiteralPath $script:StatePath -Force
  } elseif ($null -ne $listenerPid) {
    throw "WORKBENCH_PORT_IN_USE: port $port is owned by unmanaged PID $listenerPid"
  }

  $runtime = Resolve-WorkbenchNode22
  $databasePath = Resolve-WorkbenchDatabasePath
  if (-not (Test-Path -LiteralPath $databasePath -PathType Leaf)) {
    throw "WORKBENCH_DATABASE_NOT_FOUND: $databasePath"
  }

  $env:PATH = "$(Split-Path -Parent $runtime.NodePath);$env:PATH"
  $env:AI_VIDEO_WORKSPACE_DB_PATH = $databasePath
  $env:REAL_PROVIDER_ENABLED = "false"
  $env:M1_REAL_PROVIDER_EXECUTION_ALLOWED = "false"
  $env:M1_REAL_PROVIDER_COST_ACK = "false"
  $env:H1_WORKBENCH_PORT = [string]$port
  $shutdownBytes = New-Object byte[] 32
  $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $random.GetBytes($shutdownBytes) } finally { $random.Dispose() }
  $shutdownToken = [Convert]::ToBase64String($shutdownBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  $env:AI_VIDEO_WORKBENCH_SHUTDOWN_TOKEN = $shutdownToken

  Push-Location $script:WorkspaceRoot
  try {
    & $runtime.NpmPath run preflight
    if ($LASTEXITCODE -ne 0) { throw "WORKBENCH_PREFLIGHT_FAILED" }
    & $runtime.NpmPath run build
    if ($LASTEXITCODE -ne 0) { throw "WORKBENCH_BUILD_FAILED" }
  } finally {
    Pop-Location
  }

  $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
  $stdoutPath = Join-Path $script:RuntimeRoot "workbench-$stamp.stdout.log"
  $stderrPath = Join-Path $script:RuntimeRoot "workbench-$stamp.stderr.log"
  $process = Start-Process -FilePath $runtime.NodePath `
    -ArgumentList "dist/scripts/h1-workbench.js" `
    -WorkingDirectory $script:WorkspaceRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru

  $http = $null
  $startupDeadline = [DateTime]::UtcNow.AddSeconds(60)
  while ([DateTime]::UtcNow -lt $startupDeadline) {
    if ($process.HasExited) { break }
    $http = Get-WorkbenchHttpStatus $port 1 1
    if ($http.health_status -eq 200 -and $http.ready_status -eq 200 -and $http.ready) { break }
    Start-Sleep -Milliseconds 500
  }

  if ($process.HasExited -or $null -eq $http -or -not $http.ready) {
    if (-not $process.HasExited) { Stop-Process -Id $process.Id -ErrorAction SilentlyContinue }
    throw "WORKBENCH_START_NOT_READY: inspect local runtime logs"
  }

  $startedListenerPid = Get-WorkbenchListenerPid $port
  if ($startedListenerPid -ne $process.Id) {
    if (-not $process.HasExited) { Stop-Process -Id $process.Id -ErrorAction SilentlyContinue }
    throw "WORKBENCH_LISTENER_IDENTITY_MISMATCH: refusing to record ambiguous state"
  }

  $state = [ordered]@{
    pid = $process.Id
    port = $port
    process_start_time_utc = $process.StartTime.ToUniversalTime().ToString("o")
    started_at_utc = (Get-Date).ToUniversalTime().ToString("o")
    node_path = $runtime.NodePath
    node_version = $runtime.Version
    database_path = $databasePath
    workspace_root = $script:WorkspaceRoot
    provider_enabled = $false
    shutdown_token = $shutdownToken
    stdout_path = $stdoutPath
    stderr_path = $stderrPath
  }
  $temporaryStatePath = "$script:StatePath.tmp-$PID"
  try {
    $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $temporaryStatePath -Encoding UTF8
    Move-Item -LiteralPath $temporaryStatePath -Destination $script:StatePath -Force
  } catch {
    Remove-Item -LiteralPath $temporaryStatePath -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
    throw "WORKBENCH_STATE_WRITE_FAILED: managed process was stopped"
  }

  Write-WorkbenchJson ([pscustomobject]@{
    result = "STARTED"
    pid = $process.Id
    port = $port
    url = "http://127.0.0.1:$port/v2"
    ready = $true
    provider_enabled = $false
    node_version = $runtime.Version
  })
  exit 0
} catch {
  [Console]::Error.WriteLine((ConvertTo-Json ([ordered]@{ result = "FAIL"; error = $_.Exception.Message }) -Compress))
  exit 1
}
