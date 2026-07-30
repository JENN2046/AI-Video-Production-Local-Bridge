param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^run_[0-9a-f]{32}$')]
  [string]$RunId
)

. (Join-Path $PSScriptRoot "media-runtime-common.ps1")

$previousProfile = [Environment]::GetEnvironmentVariable("READONLY_MEDIA_OPERATIONS_PROFILE_PATH", "Process")
$keyBytes = $null
$encodedKey = $null
try {
  $runRoot = Resolve-MediaInsideWorkspace (Join-Path "data\webgpt\media-acceptance" $RunId)
  $profilePath = Resolve-MediaInsideWorkspace (Join-Path $runRoot "gateway-profile.json")
  $env:READONLY_MEDIA_OPERATIONS_PROFILE_PATH = $profilePath
  $profile = Read-MediaProfile
  if ($profile.DatabasePath -ne (Resolve-MediaInsideWorkspace (Join-Path $runRoot "app.sqlite"))) { throw "MEDIA_ACCEPTANCE_PROFILE_INVALID" }
  $node = Resolve-MediaNode22
  $keyBytes = Unprotect-MediaBytes $profile.CapabilityKeyPath
  if ($keyBytes.Length -ne 32) { throw "MEDIA_CAPABILITY_KEY_INVALID" }
  $encodedKey = [Convert]::ToBase64String($keyBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  Push-Location $script:MediaWorkspaceRoot
  try {
    $encodedKey | & $node.NodePath --no-warnings "dist/scripts/webgpt-media-acceptance-matrix.js" --run $RunId --origin "https://media.skmt617.top" --kid $profile.CapabilityKid
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  } finally { Pop-Location }
} catch {
  $candidate = [string]$_.Exception.Message
  $stableCode = if ($candidate -match '^MEDIA_[A-Z0-9_]+$') { $candidate } else { "MEDIA_ACCEPTANCE_WRAPPER_FAILED" }
  [Console]::Error.WriteLine((ConvertTo-Json ([ordered]@{ result = "FAIL"; stable_error_code = $stableCode }) -Compress))
  exit 1
} finally {
  if ($null -ne $keyBytes) { [Array]::Clear($keyBytes, 0, $keyBytes.Length) }
  $encodedKey = $null
  if ($null -eq $previousProfile) { Remove-Item Env:READONLY_MEDIA_OPERATIONS_PROFILE_PATH -ErrorAction SilentlyContinue }
  else { $env:READONLY_MEDIA_OPERATIONS_PROFILE_PATH = $previousProfile }
}
