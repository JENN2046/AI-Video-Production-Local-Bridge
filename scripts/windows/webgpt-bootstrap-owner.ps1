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

& node $command bootstrap-owner-preflight `
  --db $resolvedDatabase `
  --issuer $Issuer `
  --project $ProjectId `
  --reason $Reason | Out-Null
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$secureSubject = Read-Host "Descope subject (input hidden)" -AsSecureString
$bstr = [IntPtr]::Zero
$plainSubject = $null
$subjectBytes = $null
$encodedSubject = $null
$previousOutputEncoding = $OutputEncoding
try {
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSubject)
  $plainSubject = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  if ([string]::IsNullOrWhiteSpace($plainSubject)) {
    throw "Descope subject is required."
  }
  $subjectBytes = [System.Text.Encoding]::UTF8.GetBytes($plainSubject)
  $encodedSubject = [Convert]::ToBase64String($subjectBytes)
  $OutputEncoding = [System.Text.ASCIIEncoding]::new()
  $encodedSubject | & node $command bootstrap-owner-interactive `
    --db $resolvedDatabase `
    --issuer $Issuer `
    --project $ProjectId `
    --reason $Reason
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  $OutputEncoding = $previousOutputEncoding
  $encodedSubject = $null
  if ($null -ne $subjectBytes) {
    [Array]::Clear($subjectBytes, 0, $subjectBytes.Length)
  }
  $subjectBytes = $null
  $plainSubject = $null
  $secureSubject = $null
  if ($bstr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}
