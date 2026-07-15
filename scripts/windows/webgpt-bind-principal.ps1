[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$DatabasePath,

  [Parameter(Mandatory = $true)]
  [string]$Issuer
)

$ErrorActionPreference = "Stop"
$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$command = Join-Path $workspaceRoot "dist\scripts\webgpt-auth-admin.js"
$resolvedDatabase = [System.IO.Path]::GetFullPath($DatabasePath)

if (-not (Test-Path -LiteralPath $command -PathType Leaf)) {
  throw "Build output is missing. Run npm run build:server first."
}
if (-not (Test-Path -LiteralPath $resolvedDatabase -PathType Leaf)) {
  throw "Database does not exist."
}

& node $command bind-principal-preflight `
  --db $resolvedDatabase `
  --issuer $Issuer | Out-Null
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$secureSubject = Read-Host "Federated OAuth subject (input hidden)" -AsSecureString
$bstr = [IntPtr]::Zero
$plainSubject = $null
$subjectBytes = $null
$encodedSubject = $null
$previousOutputEncoding = $OutputEncoding
try {
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSubject)
  $plainSubject = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  if ([string]::IsNullOrWhiteSpace($plainSubject)) {
    throw "Federated OAuth subject is required."
  }
  $subjectBytes = [System.Text.Encoding]::UTF8.GetBytes($plainSubject)
  $encodedSubject = [Convert]::ToBase64String($subjectBytes)
  $OutputEncoding = [System.Text.ASCIIEncoding]::new()
  $encodedSubject | & node $command bind-principal-interactive `
    --db $resolvedDatabase `
    --issuer $Issuer
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
