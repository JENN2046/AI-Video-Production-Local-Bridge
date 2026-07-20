. (Join-Path $PSScriptRoot "media-runtime-common.ps1")

$gateway = $null
$cloudflared = $null
$startLock = $null
$profile = $null
$previousKey = $null
$instanceProbe = $null
$previousEnvironmentVariables = @("READONLY_MEDIA_GATEWAY_PREVIOUS_KID", "READONLY_MEDIA_GATEWAY_PREVIOUS_KEY_B64URL", "READONLY_MEDIA_GATEWAY_PREVIOUS_ACCEPTED_FROM", "READONLY_MEDIA_GATEWAY_PREVIOUS_ACCEPTED_UNTIL")
try {
  Remove-Item Env:TUNNEL_TOKEN -ErrorAction SilentlyContinue
  $profile = Read-MediaProfile
  Assert-MediaGitIgnored (Get-MediaPrivatePaths $profile)
  $node = Resolve-MediaNode22
  $profileFingerprint = Get-MediaRuntimeProfileFingerprint $profile $node.NodePath
  New-Item -ItemType Directory -Force -Path $profile.RuntimeDirectory | Out-Null
  $existing = Read-MediaState $profile
  if ($null -ne $existing) {
    Assert-MediaRuntimeStateIdentity $profile $node.NodePath $profileFingerprint $existing
    $gatewayLive = Test-MediaProcess $existing "gateway"
    $tunnelLive = Test-MediaProcess $existing "cloudflared"
    if ($gatewayLive -and $tunnelLive) {
      $localReady = Get-MediaHttp "http://127.0.0.1:$($profile.GatewayPort)/readyz"
      $localHealth = Get-MediaGatewayHealth "http://127.0.0.1:$($profile.GatewayPort)/healthz" 3 ([string]$existing.instance_probe)
      $publicReady = Get-MediaGatewayHealth $profile.PublicHealthUrl 3 ([string]$existing.instance_probe)
      if ((Get-MediaListenerPid $profile.GatewayPort) -ne [int]$existing.gateway_pid -or $localReady -ne 200 -or -not $localHealth.Valid -or -not $publicReady.Valid) { throw "MEDIA_RUNTIME_NOT_READY" }
      Write-MediaJson ([ordered]@{ result = "ALREADY_RUNNING"; gateway = $true; cloudflared = $true; gateway_ready = $true; public_health = $true })
      exit 0
    }
    if ($gatewayLive -or $tunnelLive) { throw "MEDIA_OPERATIONS_STATE_CONFLICT" }
    Remove-Item -LiteralPath $profile.StatePath -Force
  }
  $lockPath = Join-Path $profile.RuntimeDirectory "media-start.lock"
  try { $startLock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::Write, [IO.FileShare]::None) } catch { throw "MEDIA_START_ALREADY_IN_PROGRESS" }

  & powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File (Join-Path $PSScriptRoot "media-preflight.ps1") *> $null
  if ($LASTEXITCODE -ne 0) { throw "MEDIA_PREFLIGHT_FAILED" }

  $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
  $gatewayOut = Join-Path $profile.RuntimeDirectory "gateway-$stamp.stdout.log"
  $gatewayErr = Join-Path $profile.RuntimeDirectory "gateway-$stamp.stderr.log"
  $tunnelOut = Join-Path $profile.RuntimeDirectory "cloudflared-$stamp.stdout.log"
  $tunnelErr = Join-Path $profile.RuntimeDirectory "cloudflared-$stamp.stderr.log"

  $instanceProbe = New-MediaInstanceProbe
  $key = Unprotect-MediaBytes $profile.CapabilityKeyPath
  try {
    $previousEnvironmentVariables | ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }
    $env:READONLY_MEDIA_GATEWAY_DATABASE_PATH = $profile.DatabasePath
    $env:READONLY_MEDIA_GATEWAY_ISSUER_HASH = $profile.IssuerHash
    $env:READONLY_MEDIA_GATEWAY_ACTIVE_KID = $profile.CapabilityKid
    $env:READONLY_MEDIA_GATEWAY_ACTIVE_KEY_B64URL = [Convert]::ToBase64String($key).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    $env:READONLY_MEDIA_GATEWAY_ALLOWED_ORIGIN = $profile.AllowedOrigin
    $env:READONLY_MEDIA_GATEWAY_ALLOWED_ROOTS_JSON = ConvertTo-Json @($profile.MediaRoots) -Compress
    $env:READONLY_MEDIA_GATEWAY_PORT = [string]$profile.GatewayPort
    $env:READONLY_MEDIA_GATEWAY_COUNTS_PATH = $profile.CountsPath
    $env:READONLY_MEDIA_GATEWAY_INSTANCE_PROBE = $instanceProbe
    if ($null -ne $profile.PreviousCapability) {
      $previousKey = Unprotect-MediaBytes $profile.PreviousCapability.ProtectedPath
      $env:READONLY_MEDIA_GATEWAY_PREVIOUS_KID = $profile.PreviousCapability.Kid
      $env:READONLY_MEDIA_GATEWAY_PREVIOUS_KEY_B64URL = [Convert]::ToBase64String($previousKey).TrimEnd('=').Replace('+', '-').Replace('/', '_')
      $env:READONLY_MEDIA_GATEWAY_PREVIOUS_ACCEPTED_FROM = $profile.PreviousCapability.AcceptedFrom
      $env:READONLY_MEDIA_GATEWAY_PREVIOUS_ACCEPTED_UNTIL = $profile.PreviousCapability.AcceptedUntil
    }
    $gateway = Start-Process -FilePath $node.NodePath -ArgumentList "dist/scripts/webgpt-media-gateway-server.js" -WorkingDirectory $script:MediaWorkspaceRoot -WindowStyle Hidden -RedirectStandardOutput $gatewayOut -RedirectStandardError $gatewayErr -PassThru
  } finally {
    [Array]::Clear($key, 0, $key.Length)
    if ($null -ne $previousKey) { [Array]::Clear($previousKey, 0, $previousKey.Length) }
    (@("READONLY_MEDIA_GATEWAY_DATABASE_PATH", "READONLY_MEDIA_GATEWAY_ISSUER_HASH", "READONLY_MEDIA_GATEWAY_ACTIVE_KID", "READONLY_MEDIA_GATEWAY_ACTIVE_KEY_B64URL", "READONLY_MEDIA_GATEWAY_ALLOWED_ORIGIN", "READONLY_MEDIA_GATEWAY_ALLOWED_ROOTS_JSON", "READONLY_MEDIA_GATEWAY_PORT", "READONLY_MEDIA_GATEWAY_COUNTS_PATH", "READONLY_MEDIA_GATEWAY_INSTANCE_PROBE") + $previousEnvironmentVariables) | ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  $ready = 0
  do { if ($gateway.HasExited) { break }; $ready = Get-MediaHttp "http://127.0.0.1:$($profile.GatewayPort)/readyz" 2; if ($ready -eq 200) { break }; Start-Sleep -Milliseconds 500 } while ([DateTime]::UtcNow -lt $deadline)
  if ($gateway.HasExited -or $ready -ne 200) { if (-not $gateway.HasExited) { Stop-Process -Id $gateway.Id -ErrorAction SilentlyContinue }; throw "MEDIA_GATEWAY_NOT_READY" }
  if ((Get-MediaListenerPid $profile.GatewayPort) -ne $gateway.Id) { throw "MEDIA_GATEWAY_LISTENER_IDENTITY_MISMATCH" }
  $localHealth = Get-MediaGatewayHealth "http://127.0.0.1:$($profile.GatewayPort)/healthz" 3 $instanceProbe
  if (-not $localHealth.Valid) { Stop-Process -Id $gateway.Id -ErrorAction SilentlyContinue; throw "MEDIA_GATEWAY_INSTANCE_MISMATCH" }

  $tokenBytes = Unprotect-MediaBytes $profile.TunnelTokenPath
  try {
    $env:TUNNEL_TOKEN = [Text.Encoding]::UTF8.GetString($tokenBytes)
    $cloudflared = Start-Process -FilePath $profile.CloudflaredPath -ArgumentList @("tunnel", "--no-autoupdate", "--loglevel", "warn", "run") -WorkingDirectory $script:MediaWorkspaceRoot -WindowStyle Hidden -RedirectStandardOutput $tunnelOut -RedirectStandardError $tunnelErr -PassThru
  } finally {
    [Array]::Clear($tokenBytes, 0, $tokenBytes.Length)
    Remove-Item Env:TUNNEL_TOKEN -ErrorAction SilentlyContinue
  }

  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  $publicHealth = [pscustomobject]@{ Status = 0; Valid = $false }
  do { if ($cloudflared.HasExited) { break }; $publicHealth = Get-MediaGatewayHealth $profile.PublicHealthUrl 3 $instanceProbe; if ($publicHealth.Valid) { break }; Start-Sleep -Seconds 1 } while ([DateTime]::UtcNow -lt $deadline)
  if ($cloudflared.HasExited -or -not $publicHealth.Valid) { if (-not $cloudflared.HasExited) { Stop-Process -Id $cloudflared.Id -ErrorAction SilentlyContinue }; Stop-Process -Id $gateway.Id -ErrorAction SilentlyContinue; throw "MEDIA_TUNNEL_NOT_READY" }

  $state = [ordered]@{
    state_version = "readonly-media-runtime-state-v3"
    profile_fingerprint = $profileFingerprint
    instance_probe = $instanceProbe
    gateway_pid = $gateway.Id
    gateway_start_time_utc = $gateway.StartTime.ToUniversalTime().ToString("o")
    gateway_executable = $node.NodePath
    cloudflared_pid = $cloudflared.Id
    cloudflared_start_time_utc = $cloudflared.StartTime.ToUniversalTime().ToString("o")
    cloudflared_executable = $profile.CloudflaredPath
    started_at_utc = (Get-Date).ToUniversalTime().ToString("o")
    gateway_port = $profile.GatewayPort
  }
  $temporary = "$($profile.StatePath).tmp-$PID"
  $state | ConvertTo-Json | Set-Content -LiteralPath $temporary -Encoding UTF8
  Move-Item -LiteralPath $temporary -Destination $profile.StatePath -Force
  $startLock.Dispose()
  $startLock = $null
  Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
  Write-MediaJson ([ordered]@{ result = "STARTED"; gateway = $true; gateway_ready = $true; cloudflared = $true; public_health = $true })
  exit 0
} catch {
  if ($null -ne $cloudflared -and -not $cloudflared.HasExited) { Stop-Process -Id $cloudflared.Id -ErrorAction SilentlyContinue }
  if ($null -ne $gateway -and -not $gateway.HasExited) { Stop-Process -Id $gateway.Id -ErrorAction SilentlyContinue }
  if ($null -ne $startLock) { $startLock.Dispose() }
  if ($null -ne $profile) { Remove-Item -LiteralPath (Join-Path $profile.RuntimeDirectory "media-start.lock") -Force -ErrorAction SilentlyContinue }
  [Console]::Error.WriteLine((ConvertTo-Json ([ordered]@{ result = "FAIL"; stable_error_code = $_.Exception.Message }) -Compress))
  exit 1
}
