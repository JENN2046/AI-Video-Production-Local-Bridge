[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$DatabasePath,

  [Parameter(Mandatory = $true)]
  [string]$Issuer,

  [Parameter(Mandatory = $true)]
  [string]$ProjectId,

  [string]$Reason = "LOCAL_ADMIN_APPROVED"
)

$ErrorActionPreference = "Stop"
$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$command = Join-Path $workspaceRoot "dist\scripts\webgpt-auth-admin.js"
$resolvedDatabase = [System.IO.Path]::GetFullPath($DatabasePath)

if (-not (Test-Path -LiteralPath $command -PathType Leaf)) {
  throw "Build output is missing. Run npm run build:server first."
}

$secureSubject = Read-Host "Descope subject (input hidden)" -AsSecureString
$bstr = [IntPtr]::Zero
$plainSubject = $null
try {
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSubject)
  $plainSubject = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  if ([string]::IsNullOrWhiteSpace($plainSubject)) {
    throw "Descope subject is required."
  }
  $plainSubject | & node $command bootstrap-owner-interactive `
    --db $resolvedDatabase `
    --issuer $Issuer `
    --project $ProjectId `
    --reason $Reason
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  $plainSubject = $null
  $secureSubject = $null
  if ($bstr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}
