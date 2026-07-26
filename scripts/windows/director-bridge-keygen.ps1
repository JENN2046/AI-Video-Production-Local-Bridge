param(
  [string]$Destination = "data/webgpt/director/bridge-key.dpapi",
  [string]$Kid = "unified-workspace-bridge-v1"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\\..")).Path

function Write-DirectorBridgeJson([object]$Value) {
  [Console]::Out.WriteLine(($Value | ConvertTo-Json -Depth 4 -Compress))
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

try {
  if ($Kid -notmatch '^[A-Za-z0-9._-]{1,64}$') { throw "DIRECTOR_BRIDGE_KEY_INVALID" }
  $destinationPath = Resolve-DirectorBridgeWorkspacePath $Destination
  Assert-DirectorBridgeGitIgnored $destinationPath
  if (Test-Path -LiteralPath $destinationPath) { throw "DIRECTOR_BRIDGE_KEY_ALREADY_EXISTS" }
  [IO.Directory]::CreateDirectory((Split-Path -Parent $destinationPath)) | Out-Null

  Add-Type -AssemblyName System.Security
  $bytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
    $protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    $temporary = "$destinationPath.tmp-$PID"
    try {
      [IO.File]::WriteAllText($temporary, [Convert]::ToBase64String($protected), [Text.UTF8Encoding]::new($false))
      Move-Item -LiteralPath $temporary -Destination $destinationPath -ErrorAction Stop
    } finally {
      Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
      [Array]::Clear($protected, 0, $protected.Length)
    }
  } finally {
    $rng.Dispose()
    [Array]::Clear($bytes, 0, $bytes.Length)
  }
  Write-DirectorBridgeJson ([ordered]@{ result = "CREATED"; kid = $Kid; protected = $true })
  exit 0
} catch {
  [Console]::Error.WriteLine((ConvertTo-Json ([ordered]@{ result = "FAIL"; stable_error_code = $_.Exception.Message }) -Compress))
  exit 1
}
