param(
  [Parameter(Mandatory = $true)][string]$InputPath,
  [Parameter(Mandatory = $true)][string]$Issuer,
  [Parameter(Mandatory = $true)][string]$ResourceUrl
)

$subject = $null
$resultCode = 1
try {
  $nodePath = $env:npm_node_execpath
  if ([string]::IsNullOrWhiteSpace($nodePath) -or -not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $nodeCommand) { throw "MEDIA_NODE22_REQUIRED" }
    $nodePath = $nodeCommand.Source
  }
  $nodeVersion = (& $nodePath --version 2>$null)
  if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v22\.') { throw "MEDIA_NODE22_REQUIRED" }
  $subject = Read-Host "Auth0 user_id/sub" -MaskInput
  if ([string]::IsNullOrWhiteSpace($subject)) { throw "MEDIA_ACCEPTANCE_SUBJECT_INVALID" }
  $subject | & $nodePath `
    (Join-Path $PSScriptRoot "..\..\dist\scripts\webgpt-media-acceptance-fixture.js") create `
    --input $InputPath --issuer $Issuer --resource $ResourceUrl
  $resultCode = $LASTEXITCODE
} catch {
  $candidate = [string]$_.Exception.Message
  $stableCode = if ($candidate -match '^MEDIA_[A-Z0-9_]+$') { $candidate } else { "MEDIA_ACCEPTANCE_WRAPPER_FAILED" }
  Write-Output (@{ result = "FAIL"; stable_error_code = $stableCode } | ConvertTo-Json -Compress)
} finally {
  Remove-Variable subject -ErrorAction SilentlyContinue
}
exit $resultCode
