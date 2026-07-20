. (Join-Path $PSScriptRoot "media-runtime-common.ps1")

try {
  $profile = Read-MediaProfile
  Assert-MediaGitIgnored (Get-MediaPrivatePaths $profile)
  $state = Read-MediaState $profile
  if ($null -eq $state) {
    if ($null -ne (Get-MediaListenerPid $profile.GatewayPort)) { throw "MEDIA_OPERATIONS_STATE_MISSING_WITH_LISTENER" }
    Write-MediaJson ([ordered]@{ result = "ALREADY_STOPPED"; gateway = $false; cloudflared = $false })
    exit 0
  }
  if ([string]$state.state_version -eq "readonly-media-runtime-state-v1") { throw "MEDIA_OPERATIONS_RESTART_REQUIRED" }
  if ([string]$state.state_version -notin @("readonly-media-runtime-state-v2", "readonly-media-runtime-state-v3")) { throw "MEDIA_OPERATIONS_STATE_INVALID" }
  $node = Resolve-MediaNode22
  $profileFingerprint = Get-MediaRuntimeProfileFingerprint $profile $node.NodePath
  $profileDrift = [string]$state.profile_fingerprint -cne $profileFingerprint
  $allowProfileDrift = [string]$state.state_version -eq "readonly-media-runtime-state-v3" -and $profileDrift
  Assert-MediaRuntimeStateIdentity $profile $node.NodePath $profileFingerprint $state ([string]$state.state_version) $allowProfileDrift
  $gateway = Test-MediaProcess $state "gateway"
  $cloudflared = Test-MediaProcess $state "cloudflared"
  if ($profileDrift) {
    if (-not $gateway -or -not $cloudflared) { throw "MEDIA_OPERATIONS_STATE_CONFLICT" }
    if ((Get-MediaListenerPid $profile.GatewayPort) -ne [int]$state.gateway_pid) { throw "MEDIA_GATEWAY_LISTENER_IDENTITY_MISMATCH" }
    $localHealth = Get-MediaGatewayHealth "http://127.0.0.1:$($profile.GatewayPort)/healthz" 3 ([string]$state.instance_probe)
    if (-not $localHealth.Valid) { throw "MEDIA_GATEWAY_INSTANCE_MISMATCH" }
  }
  if (-not $gateway -and (Get-Process -Id ([int]$state.gateway_pid) -ErrorAction SilentlyContinue)) { throw "MEDIA_GATEWAY_PROCESS_IDENTITY_MISMATCH" }
  if (-not $cloudflared -and (Get-Process -Id ([int]$state.cloudflared_pid) -ErrorAction SilentlyContinue)) { throw "MEDIA_TUNNEL_PROCESS_IDENTITY_MISMATCH" }
  if ($cloudflared) { Stop-Process -Id ([int]$state.cloudflared_pid) -ErrorAction Stop }
  if ($gateway) { Stop-Process -Id ([int]$state.gateway_pid) -ErrorAction Stop }
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    $gatewayLeft = Get-Process -Id ([int]$state.gateway_pid) -ErrorAction SilentlyContinue
    $tunnelLeft = Get-Process -Id ([int]$state.cloudflared_pid) -ErrorAction SilentlyContinue
    if ($null -eq $gatewayLeft -and $null -eq $tunnelLeft) { break }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($null -ne $gatewayLeft -or $null -ne $tunnelLeft) { throw "MEDIA_STOP_TIMEOUT" }
  if ($null -ne (Get-MediaListenerPid $profile.GatewayPort)) { throw "MEDIA_GATEWAY_PORT_NOT_RELEASED" }
  Remove-Item -LiteralPath $profile.StatePath -Force
  Remove-Item -LiteralPath $profile.CountsPath -Force -ErrorAction SilentlyContinue
  Write-MediaJson ([ordered]@{ result = "STOPPED"; gateway = $false; cloudflared = $false; port_released = $true })
  exit 0
} catch {
  [Console]::Error.WriteLine((ConvertTo-Json ([ordered]@{ result = "FAIL"; stable_error_code = $_.Exception.Message }) -Compress))
  exit 1
}
