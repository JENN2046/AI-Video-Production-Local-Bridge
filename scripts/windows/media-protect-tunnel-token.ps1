. (Join-Path $PSScriptRoot "media-runtime-common.ps1")

try {
  $profile = Read-MediaProfile
  Assert-MediaGitIgnored @($profile.ProfilePath, $profile.TunnelTokenPath)
  if (Test-Path -LiteralPath $profile.TunnelTokenPath) { throw "MEDIA_TUNNEL_TOKEN_ALREADY_EXISTS" }
  $secure = Read-Host "Cloudflare Tunnel token" -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($secure)
  $bytes = $null
  try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringUni($pointer)
    if ([string]::IsNullOrWhiteSpace($plain)) { throw "MEDIA_TUNNEL_TOKEN_INVALID" }
    $bytes = [Text.Encoding]::UTF8.GetBytes($plain)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $profile.TunnelTokenPath) | Out-Null
    Protect-MediaBytes $bytes $profile.TunnelTokenPath
  } finally {
    if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($pointer) }
    Remove-Variable plain -ErrorAction SilentlyContinue
  }
  Write-MediaJson ([ordered]@{ result = "SAVED"; protected = $true })
  exit 0
} catch {
  [Console]::Error.WriteLine((ConvertTo-Json ([ordered]@{ result = "FAIL"; stable_error_code = $_.Exception.Message }) -Compress))
  exit 1
}
