. (Join-Path $PSScriptRoot "media-runtime-common.ps1")

try {
  $profile = Read-MediaProfile
  $node = Resolve-MediaNode22
  Assert-MediaGitIgnored (Get-MediaPrivatePaths $profile)
  if (-not (Test-Path -LiteralPath $profile.DatabasePath -PathType Leaf)) { throw "MEDIA_DATABASE_NOT_FOUND" }
  foreach ($root in $profile.MediaRoots) { if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw "MEDIA_ROOT_NOT_FOUND" } }
  $cloudflaredVersion = Assert-Cloudflared $profile
  $key = Unprotect-MediaBytes $profile.CapabilityKeyPath
  $previousKey = $null
  try {
    if ($null -ne $profile.PreviousCapability) { $previousKey = Unprotect-MediaBytes $profile.PreviousCapability.ProtectedPath }
    Assert-MediaCapabilityKeyring $profile $key $previousKey
  } finally {
    [Array]::Clear($key, 0, $key.Length)
    if ($null -ne $previousKey) { [Array]::Clear($previousKey, 0, $previousKey.Length) }
  }
  $token = Unprotect-MediaBytes $profile.TunnelTokenPath
  try { if ($token.Length -lt 16 -or $token.Length -gt 8192) { throw "MEDIA_TUNNEL_TOKEN_INVALID" } } finally { [Array]::Clear($token, 0, $token.Length) }
  $profileFingerprint = Get-MediaRuntimeProfileFingerprint $profile $node.NodePath
  Assert-MediaPreflightPortState $profile $node.NodePath $profileFingerprint

  $oldDb = [Environment]::GetEnvironmentVariable("AI_VIDEO_WORKSPACE_DB_PATH", "Process")
  try {
    $env:AI_VIDEO_WORKSPACE_DB_PATH = $profile.DatabasePath
    Push-Location $script:MediaWorkspaceRoot
    try { & $node.NodePath dist/scripts/db-check.js --read-only *> $null; if ($LASTEXITCODE -ne 0) { throw "MEDIA_DATABASE_CHECK_FAILED" } } finally { Pop-Location }
  } finally {
    if ($null -eq $oldDb) { Remove-Item Env:AI_VIDEO_WORKSPACE_DB_PATH -ErrorAction SilentlyContinue } else { $env:AI_VIDEO_WORKSPACE_DB_PATH = $oldDb }
  }

  Write-MediaJson ([ordered]@{
    result = "PASS"
    checks = [ordered]@{ profile = $true; database = $true; schema = $true; media_roots = $true; capability_key = $true; tunnel_token = $true; cloudflared = $true; port = $true }
    cloudflared_version = $cloudflaredVersion
    node_version = $node.Version
    gateway_port = $profile.GatewayPort
  })
  exit 0
} catch {
  [Console]::Error.WriteLine((ConvertTo-Json ([ordered]@{ result = "FAIL"; stable_error_code = $_.Exception.Message }) -Compress))
  exit 1
}
