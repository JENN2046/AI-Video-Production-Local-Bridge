. (Join-Path $PSScriptRoot "media-runtime-common.ps1")

$taskName = "Jenn AI Video Readonly Media Gateway"
try {
  $profile = Read-MediaProfile
  if (-not $profile.ProfilePath.Equals($script:DefaultMediaProfilePath, [StringComparison]::OrdinalIgnoreCase)) { throw "MEDIA_LOGON_TASK_PROFILE_MUST_USE_DEFAULT" }
  Assert-MediaGitIgnored @($profile.ProfilePath, $profile.CapabilityKeyPath, $profile.TunnelTokenPath, $profile.RuntimeDirectory)
  $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($null -ne $existing) { throw "MEDIA_LOGON_TASK_ALREADY_EXISTS" }
  $powerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
  $startScript = Join-Path $PSScriptRoot "media-logon-entry.ps1"
  $arguments = "-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File `"$startScript`""
  $action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments -WorkingDirectory $script:MediaWorkspaceRoot
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
  $trigger.Delay = "PT30S"
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
  $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "Starts the localhost-only readonly media gateway, then Cloudflare Tunnel, for the current signed-in user." | Out-Null
  $registered = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
  if (@($registered.Actions).Count -ne 1 -or (Split-Path -Leaf ([Environment]::ExpandEnvironmentVariables([string]$registered.Actions[0].Execute))) -ne "powershell.exe" -or [string]$registered.Actions[0].Arguments -notlike "*media-logon-entry.ps1*" -or [string]$registered.Principal.UserId -ne $currentUser -or [string]$registered.Principal.RunLevel -ne "Limited") {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    throw "MEDIA_LOGON_TASK_VERIFICATION_FAILED"
  }
  Write-MediaJson ([ordered]@{ result = "INSTALLED"; task_name = $taskName; current_user_only = $true; elevated = $false; delayed_seconds = 30 })
  exit 0
} catch {
  [Console]::Error.WriteLine((ConvertTo-Json ([ordered]@{ result = "FAIL"; stable_error_code = $_.Exception.Message }) -Compress))
  exit 1
}
