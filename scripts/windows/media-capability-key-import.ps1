. (Join-Path $PSScriptRoot "media-runtime-common.ps1")

try {
  $profile = Read-MediaProfile
  Assert-MediaGitIgnored @($profile.ProfilePath, $profile.CapabilityKeyPath)
  if (Test-Path -LiteralPath $profile.CapabilityKeyPath) { throw "MEDIA_CAPABILITY_KEY_ALREADY_EXISTS" }

  $secure = Read-Host "Shared media capability key (input hidden)" -AsSecureString
  $pointer = [IntPtr]::Zero
  $keyBytes = $null
  try {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($secure)
    $encoded = [Runtime.InteropServices.Marshal]::PtrToStringUni($pointer)
    $keyBytes = ConvertFrom-MediaCapabilityKeyBase64Url $encoded
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $profile.CapabilityKeyPath) | Out-Null
    Protect-MediaBytes $keyBytes $profile.CapabilityKeyPath
  } finally {
    if ($null -ne $keyBytes) { [Array]::Clear($keyBytes, 0, $keyBytes.Length) }
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($pointer) }
    Remove-Variable encoded -ErrorAction SilentlyContinue
    $secure = $null
  }
  Write-MediaJson ([ordered]@{ result = "IMPORTED"; kid = $profile.CapabilityKid; protected = $true })
  exit 0
} catch {
  [Console]::Error.WriteLine((ConvertTo-Json ([ordered]@{ result = "FAIL"; stable_error_code = $_.Exception.Message }) -Compress))
  exit 1
}
