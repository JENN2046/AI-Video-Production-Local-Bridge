. (Join-Path $PSScriptRoot "media-runtime-common.ps1")

$taskName = "Jenn AI Video Readonly Media Gateway"
try {
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($null -eq $existing) { Write-MediaJson ([ordered]@{ result = "ALREADY_REMOVED"; task_name = $taskName }); exit 0 }
  $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  if (@($existing.Actions).Count -ne 1 -or [string]$existing.Actions[0].Arguments -notlike "*media-logon-entry.ps1*" -or [string]$existing.Principal.UserId -ne $currentUser) { throw "MEDIA_LOGON_TASK_IDENTITY_MISMATCH" }
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-MediaJson ([ordered]@{ result = "REMOVED"; task_name = $taskName })
  exit 0
} catch {
  [Console]::Error.WriteLine((ConvertTo-Json ([ordered]@{ result = "FAIL"; stable_error_code = $_.Exception.Message }) -Compress))
  exit 1
}
