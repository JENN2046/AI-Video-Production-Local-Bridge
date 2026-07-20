. (Join-Path $PSScriptRoot "media-runtime-common.ps1")

try {
  $profile = Read-MediaProfile
  $state = Read-MediaState $profile
  if ($null -eq $state) {
    Write-MediaJson ([ordered]@{ result = "STOPPED"; gateway_process = "stopped"; gateway_health = 0; gateway_ready = 0; cloudflared_process = "stopped"; public_health = 0; active_capabilities = 0; active_sessions = 0; stable_error_code = $null })
    exit 1
  }
  if ([string]$state.state_version -eq "readonly-media-runtime-state-v1") {
    Write-MediaJson ([ordered]@{ result = "NOT_READY"; gateway_process = "unknown"; gateway_health = 0; gateway_ready = 0; cloudflared_process = "unknown"; public_health = 0; active_capabilities = $null; active_sessions = $null; stable_error_code = "MEDIA_OPERATIONS_RESTART_REQUIRED" })
    exit 2
  }
  $node = Resolve-MediaNode22
  $profileFingerprint = Get-MediaRuntimeProfileFingerprint $profile $node.NodePath
  Assert-MediaRuntimeStateIdentity $profile $node.NodePath $profileFingerprint $state
  $gateway = Test-MediaProcess $state "gateway"
  $cloudflared = Test-MediaProcess $state "cloudflared"
  $healthResult = Get-MediaGatewayHealth "http://127.0.0.1:$($profile.GatewayPort)/healthz"
  $health = $healthResult.Status
  $ready = Get-MediaHttp "http://127.0.0.1:$($profile.GatewayPort)/readyz"
  $publicResult = Get-MediaGatewayHealth $profile.PublicHealthUrl
  $public = $publicResult.Status
  $counts = $null
  if (Test-Path -LiteralPath $profile.CountsPath -PathType Leaf) { try { $counts = Get-Content -Raw -LiteralPath $profile.CountsPath | ConvertFrom-Json } catch { } }
  $ok = $gateway -and $cloudflared -and $healthResult.Valid -and $ready -eq 200 -and $publicResult.Valid
  Write-MediaJson ([ordered]@{
    result = if ($ok) { "RUNNING" } else { "NOT_READY" }
    gateway_process = if ($gateway) { "running" } else { "stopped" }
    gateway_health = $health
    gateway_ready = $ready
    cloudflared_process = if ($cloudflared) { "running" } else { "stopped" }
    public_health = $public
    active_capabilities = if ($null -ne $counts) { [int]$counts.capabilities } else { $null }
    active_sessions = if ($null -ne $counts) { [int]$counts.sessions } else { $null }
    stable_error_code = if ($ok) { $null } else { "MEDIA_RUNTIME_NOT_READY" }
  })
  if ($ok) { exit 0 } else { exit 2 }
} catch {
  [Console]::Error.WriteLine((ConvertTo-Json ([ordered]@{ result = "FAIL"; stable_error_code = $_.Exception.Message }) -Compress))
  exit 1
}
