param(
  [string]$Source = "data/webgpt/director/bridge-key.dpapi",
  [string]$Kid = "unified-workspace-bridge-v1"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\\..")).Path

function Write-DirectorBridgeJson([object]$Value) {
  [Console]::Out.WriteLine(($Value | ConvertTo-Json -Depth 4 -Compress))
}

function Get-DirectorBridgeStableErrorCode([object]$ErrorRecord) {
  $knownCodes = @(
    "DIRECTOR_BRIDGE_KEY_PATH_INVALID",
    "DIRECTOR_BRIDGE_KEY_PATH_OUTSIDE_WORKSPACE",
    "DIRECTOR_BRIDGE_KEY_PATH_INSPECTION_FAILED",
    "DIRECTOR_BRIDGE_KEY_PATH_REPARSE_POINT",
    "DIRECTOR_BRIDGE_KEY_GIT_CHECK_FAILED",
    "DIRECTOR_BRIDGE_KEY_PATH_TRACKED",
    "DIRECTOR_BRIDGE_KEY_PATH_NOT_IGNORED",
    "DIRECTOR_BRIDGE_KEY_INVALID",
    "DIRECTOR_BRIDGE_KEY_DPAPI_NOT_FOUND",
    "DIRECTOR_BRIDGE_KEY_DPAPI_INVALID",
    "DIRECTOR_BRIDGE_KEY_CLIPBOARD_FAILED",
    "DIRECTOR_BRIDGE_KEY_CLIPBOARD_CLEAR_FAILED"
  )
  $message = if ($null -ne $ErrorRecord.Exception) { [string]$ErrorRecord.Exception.Message } else { "" }
  if ($knownCodes -contains $message) { return $message }
  return "DIRECTOR_BRIDGE_KEY_OPERATION_FAILED"
}

function Resolve-DirectorBridgeWorkspacePath([string]$PathValue) {
  if ([string]::IsNullOrWhiteSpace($PathValue)) { throw "DIRECTOR_BRIDGE_KEY_PATH_INVALID" }
  $candidate = if ([IO.Path]::IsPathRooted($PathValue)) {
    [IO.Path]::GetFullPath($PathValue)
  } else {
    [IO.Path]::GetFullPath((Join-Path $workspaceRoot $PathValue))
  }
  $separatorCharacters = [char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $rootWithSeparator = ([IO.Path]::GetFullPath($workspaceRoot)).TrimEnd($separatorCharacters) + [IO.Path]::DirectorySeparatorChar
  if (-not $candidate.StartsWith($rootWithSeparator, [StringComparison]::OrdinalIgnoreCase)) {
    throw "DIRECTOR_BRIDGE_KEY_PATH_OUTSIDE_WORKSPACE"
  }
  $relative = $candidate.Substring($rootWithSeparator.Length)
  $current = $workspaceRoot
  foreach ($segment in @($relative -split '[\\/]' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })) {
    $current = Join-Path $current $segment
    if (-not (Test-Path -LiteralPath $current)) { break }
    try { $attributes = [IO.File]::GetAttributes($current) } catch { throw "DIRECTOR_BRIDGE_KEY_PATH_INSPECTION_FAILED" }
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "DIRECTOR_BRIDGE_KEY_PATH_REPARSE_POINT" }
  }
  return $candidate
}

function Assert-DirectorBridgeGitIgnored([string]$PathValue) {
  $tracked = @(& git -C $workspaceRoot ls-files -- $PathValue 2>$null)
  if ($LASTEXITCODE -ne 0) { throw "DIRECTOR_BRIDGE_KEY_GIT_CHECK_FAILED" }
  if ($tracked.Count -gt 0) { throw "DIRECTOR_BRIDGE_KEY_PATH_TRACKED" }
  & git -C $workspaceRoot check-ignore --quiet --no-index -- $PathValue
  if ($LASTEXITCODE -ne 0) { throw "DIRECTOR_BRIDGE_KEY_PATH_NOT_IGNORED" }
}

$clipboardSet = $false
$clipboardCleared = $false
$bytes = $null
$operationError = $null
try {
  if ($Kid -notmatch '^[A-Za-z0-9._-]{1,64}$') { throw "DIRECTOR_BRIDGE_KEY_INVALID" }
  $sourcePath = Resolve-DirectorBridgeWorkspacePath $Source
  Assert-DirectorBridgeGitIgnored $sourcePath
  if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { throw "DIRECTOR_BRIDGE_KEY_DPAPI_NOT_FOUND" }
  Add-Type -AssemblyName System.Security
  try { $protected = [Convert]::FromBase64String(([IO.File]::ReadAllText($sourcePath)).Trim()) } catch { throw "DIRECTOR_BRIDGE_KEY_DPAPI_INVALID" }
  try {
    try { $bytes = [Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser) } catch { throw "DIRECTOR_BRIDGE_KEY_DPAPI_INVALID" }
  } finally {
    [Array]::Clear($protected, 0, $protected.Length)
  }
  if ($bytes.Length -ne 32) { throw "DIRECTOR_BRIDGE_KEY_DPAPI_INVALID" }
  $encoded = [Convert]::ToBase64String($bytes)
  try { Set-Clipboard -Value $encoded } catch { throw "DIRECTOR_BRIDGE_KEY_CLIPBOARD_FAILED" }
  $clipboardSet = $true
  Remove-Variable encoded -ErrorAction SilentlyContinue
  Read-Host "Paste the secret into Render WEBGPT_DIRECTOR_BRIDGE_KEY_B64, save it, then press Enter to clear the clipboard" | Out-Null
} catch {
  $operationError = $_
} finally {
  if ($clipboardSet) {
    try { Set-Clipboard -Value " "; $clipboardCleared = $true } catch { $clipboardCleared = $false }
  }
  if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
  Remove-Variable encoded -ErrorAction SilentlyContinue
}

if ($null -ne $operationError) {
  [Console]::Error.WriteLine((ConvertTo-Json ([ordered]@{ result = "FAIL"; stable_error_code = Get-DirectorBridgeStableErrorCode $operationError }) -Compress))
  exit 1
}
if ($clipboardSet -and -not $clipboardCleared) {
  [Console]::Error.WriteLine((ConvertTo-Json ([ordered]@{ result = "FAIL"; stable_error_code = "DIRECTOR_BRIDGE_KEY_CLIPBOARD_CLEAR_FAILED" }) -Compress))
  exit 1
}
Write-DirectorBridgeJson ([ordered]@{ result = "RENDER_SECRET_TRANSFER_COMPLETED"; kid = $Kid; clipboard_cleared = $true })
exit 0
