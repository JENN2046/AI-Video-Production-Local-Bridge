. (Join-Path $PSScriptRoot "media-runtime-common.ps1")

try {
  $runtime = Resolve-MediaNode22
  Push-Location $script:MediaWorkspaceRoot
  try { & $runtime.NpmPath run media:start; exit $LASTEXITCODE } finally { Pop-Location }
} catch {
  [Console]::Error.WriteLine((ConvertTo-Json ([ordered]@{ result = "FAIL"; stable_error_code = $_.Exception.Message }) -Compress))
  exit 1
}
