. (Join-Path $PSScriptRoot "media-runtime-common.ps1")

try {
  $profile = Read-MediaProfile
  Assert-MediaGitIgnored @($profile.ProfilePath, $profile.CapabilityKeyPath)
  if (Test-Path -LiteralPath $profile.CapabilityKeyPath) { throw "MEDIA_CAPABILITY_KEY_ALREADY_EXISTS" }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $profile.CapabilityKeyPath) | Out-Null
  $bytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes); Protect-MediaBytes $bytes $profile.CapabilityKeyPath } finally { $rng.Dispose(); [Array]::Clear($bytes, 0, $bytes.Length) }
  Write-MediaJson ([ordered]@{ result = "CREATED"; kid = $profile.CapabilityKid; protected = $true })
  exit 0
} catch {
  [Console]::Error.WriteLine((ConvertTo-Json ([ordered]@{ result = "FAIL"; stable_error_code = $_.Exception.Message }) -Compress))
  exit 1
}
