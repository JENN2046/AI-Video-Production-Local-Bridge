Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:MediaWorkspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$script:DefaultMediaProfilePath = Join-Path $script:MediaWorkspaceRoot "data\webgpt\media-gateway\profile.json"

function Write-MediaJson([object]$Value) {
  [Console]::Out.WriteLine(($Value | ConvertTo-Json -Depth 8 -Compress))
}

function Resolve-MediaNode22 {
  $candidate = [Environment]::GetEnvironmentVariable("AI_VIDEO_NODE22_PATH", "Process")
  if ([string]::IsNullOrWhiteSpace($candidate)) { $candidate = Join-Path $script:MediaWorkspaceRoot "ops\tools\node-v22.23.1-win-x64\node.exe" }
  elseif (-not [IO.Path]::IsPathRooted($candidate)) { $candidate = Join-Path $script:MediaWorkspaceRoot $candidate }
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "MEDIA_NODE22_NOT_FOUND" }
  $resolved = (Resolve-Path -LiteralPath $candidate).Path
  $version = & $resolved --version 2>$null
  if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v22\.') { throw "MEDIA_NODE22_REQUIRED" }
  $npmPath = Join-Path (Split-Path -Parent $resolved) "npm.cmd"
  if (-not (Test-Path -LiteralPath $npmPath -PathType Leaf)) { throw "MEDIA_NODE22_NPM_NOT_FOUND" }
  return [pscustomobject]@{ NodePath = $resolved; NpmPath = (Resolve-Path -LiteralPath $npmPath).Path; Version = [string]$version }
}

function Resolve-MediaInsideWorkspace([string]$PathValue) {
  if ([string]::IsNullOrWhiteSpace($PathValue)) { throw "MEDIA_OPERATIONS_PROFILE_INVALID" }
  $candidate = if ([System.IO.Path]::IsPathRooted($PathValue)) { [System.IO.Path]::GetFullPath($PathValue) } else { [System.IO.Path]::GetFullPath((Join-Path $script:MediaWorkspaceRoot $PathValue)) }
  $prefix = $script:MediaWorkspaceRoot.TrimEnd('\') + '\'
  if (-not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "MEDIA_OPERATIONS_PATH_OUTSIDE_WORKSPACE" }
  return $candidate
}

function Get-MediaProfilePath {
  $configured = [Environment]::GetEnvironmentVariable("READONLY_MEDIA_OPERATIONS_PROFILE_PATH", "Process")
  if ([string]::IsNullOrWhiteSpace($configured)) { return $script:DefaultMediaProfilePath }
  return Resolve-MediaInsideWorkspace $configured
}

function Assert-MediaGitIgnored([string[]]$Paths) {
  foreach ($path in $Paths) {
    $tracked = @(& git -C $script:MediaWorkspaceRoot ls-files -- $path 2>$null)
    if ($LASTEXITCODE -ne 0) { throw "MEDIA_OPERATIONS_GIT_CHECK_FAILED" }
    if ($tracked.Count -gt 0) { throw "MEDIA_OPERATIONS_PRIVATE_PATH_TRACKED" }
    & git -C $script:MediaWorkspaceRoot check-ignore --quiet --no-index -- $path
    if ($LASTEXITCODE -ne 0) { throw "MEDIA_OPERATIONS_PRIVATE_PATH_NOT_IGNORED" }
  }
}

function Get-MediaPrivatePaths([object]$Profile) {
  $paths = @($Profile.ProfilePath, $Profile.CapabilityKeyPath, $Profile.TunnelTokenPath, $Profile.RuntimeDirectory)
  if ($null -ne $Profile.PreviousCapability) { $paths += $Profile.PreviousCapability.ProtectedPath }
  return $paths
}

function Get-MediaFileSha256([string]$Path, [string]$MissingCode) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw $MissingCode }
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Get-MediaRuntimeProfileFingerprint([object]$Profile, [string]$GatewayExecutable) {
  $previous = $null
  if ($null -ne $Profile.PreviousCapability) {
    $previous = [ordered]@{
      kid = $Profile.PreviousCapability.Kid
      protected_path = [IO.Path]::GetFullPath($Profile.PreviousCapability.ProtectedPath)
      protected_sha256 = Get-MediaFileSha256 $Profile.PreviousCapability.ProtectedPath "MEDIA_OPERATIONS_SECRET_NOT_FOUND"
      accepted_from = $Profile.PreviousCapability.AcceptedFrom
      accepted_until = $Profile.PreviousCapability.AcceptedUntil
    }
  }
  $identity = [ordered]@{
    profile_version = "readonly-media-operations-profile-v1"
    profile_path = [IO.Path]::GetFullPath($Profile.ProfilePath)
    database_path = [IO.Path]::GetFullPath($Profile.DatabasePath)
    issuer_hash = $Profile.IssuerHash
    allowed_origin = $Profile.AllowedOrigin
    gateway_port = [int]$Profile.GatewayPort
    media_roots = @($Profile.MediaRoots | ForEach-Object { [IO.Path]::GetFullPath($_) })
    capability_kid = $Profile.CapabilityKid
    capability_key_path = [IO.Path]::GetFullPath($Profile.CapabilityKeyPath)
    capability_key_sha256 = Get-MediaFileSha256 $Profile.CapabilityKeyPath "MEDIA_OPERATIONS_SECRET_NOT_FOUND"
    previous_capability = $previous
    gateway_executable = [IO.Path]::GetFullPath($GatewayExecutable)
    cloudflared_path = [IO.Path]::GetFullPath($Profile.CloudflaredPath)
    cloudflared_manifest_path = [IO.Path]::GetFullPath($Profile.CloudflaredManifestPath)
    tunnel_token_path = [IO.Path]::GetFullPath($Profile.TunnelTokenPath)
    tunnel_token_sha256 = Get-MediaFileSha256 $Profile.TunnelTokenPath "MEDIA_OPERATIONS_SECRET_NOT_FOUND"
    public_health_url = $Profile.PublicHealthUrl
    runtime_directory = [IO.Path]::GetFullPath($Profile.RuntimeDirectory)
  }
  $bytes = [Text.Encoding]::UTF8.GetBytes(($identity | ConvertTo-Json -Depth 8 -Compress))
  try {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
      $digest = $sha.ComputeHash($bytes)
      try { return ([BitConverter]::ToString($digest)).Replace('-', '').ToLowerInvariant() } finally { [Array]::Clear($digest, 0, $digest.Length) }
    } finally { $sha.Dispose() }
  } finally {
    [Array]::Clear($bytes, 0, $bytes.Length)
  }
}

function Read-MediaProfile {
  $profilePath = Get-MediaProfilePath
  if (-not (Test-Path -LiteralPath $profilePath -PathType Leaf)) { throw "MEDIA_OPERATIONS_PROFILE_NOT_FOUND" }
  try { $raw = Get-Content -Raw -LiteralPath $profilePath | ConvertFrom-Json } catch { throw "MEDIA_OPERATIONS_PROFILE_INVALID" }
  $required = @("profile_version", "database_path", "issuer_hash", "allowed_origin", "gateway_port", "media_roots", "capability_key", "cloudflared", "runtime_directory")
  foreach ($name in $required) { if (-not ($raw.PSObject.Properties.Name -contains $name)) { throw "MEDIA_OPERATIONS_PROFILE_INVALID" } }
  if (@($raw.PSObject.Properties).Count -ne $required.Count -or @($raw.PSObject.Properties.Name | Where-Object { $required -notcontains $_ }).Count -gt 0) { throw "MEDIA_OPERATIONS_PROFILE_INVALID" }
  if ($null -eq $raw.capability_key -or $null -eq $raw.cloudflared) { throw "MEDIA_OPERATIONS_PROFILE_INVALID" }
  $capabilityFields = @("kid", "protected_path", "previous")
  $capabilityMandatory = @("kid", "protected_path")
  $capabilityNames = @($raw.capability_key.PSObject.Properties.Name)
  if (@($capabilityNames | Where-Object { $capabilityFields -notcontains $_ }).Count -gt 0 -or @($capabilityMandatory | Where-Object { $capabilityNames -notcontains $_ }).Count -gt 0) { throw "MEDIA_OPERATIONS_PROFILE_INVALID" }
  $cloudflaredFields = @("executable_path", "manifest_path", "protected_token_path", "public_health_url")
  $cloudflaredNames = @($raw.cloudflared.PSObject.Properties.Name)
  if ($cloudflaredNames.Count -ne $cloudflaredFields.Count -or @($cloudflaredNames | Where-Object { $cloudflaredFields -notcontains $_ }).Count -gt 0) { throw "MEDIA_OPERATIONS_PROFILE_INVALID" }
  if ([string]$raw.profile_version -ne "readonly-media-operations-profile-v1") { throw "MEDIA_OPERATIONS_PROFILE_INVALID" }
  if ([string]$raw.issuer_hash -notmatch '^[0-9a-f]{64}$') { throw "MEDIA_OPERATIONS_PROFILE_INVALID" }
  try { $origin = [Uri]([string]$raw.allowed_origin) } catch { throw "MEDIA_OPERATIONS_PROFILE_INVALID" }
  if ($origin.Scheme -ne "https" -or $origin.AbsoluteUri.TrimEnd('/') -ne "https://aivideo.skmt617.top" -or -not [string]::IsNullOrEmpty($origin.UserInfo) -or $origin.Query -or $origin.Fragment) { throw "MEDIA_OPERATIONS_PROFILE_INVALID" }
  if ([int]$raw.gateway_port -ne 2092) { throw "MEDIA_OPERATIONS_PROFILE_INVALID" }
  if ($raw.media_roots -isnot [Array] -or $raw.media_roots.Count -lt 1) { throw "MEDIA_OPERATIONS_PROFILE_INVALID" }
  if ([string]$raw.capability_key.kid -notmatch '^[A-Za-z0-9._-]{1,64}$') { throw "MEDIA_OPERATIONS_PROFILE_INVALID" }
  try { $publicHealth = [Uri]([string]$raw.cloudflared.public_health_url) } catch { throw "MEDIA_OPERATIONS_PROFILE_INVALID" }
  if ($publicHealth.Scheme -ne "https" -or $publicHealth.Host -ne "media.skmt617.top" -or $publicHealth.AbsolutePath -ne "/healthz" -or $publicHealth.Query -or $publicHealth.Fragment -or -not [string]::IsNullOrEmpty($publicHealth.UserInfo)) { throw "MEDIA_OPERATIONS_PROFILE_INVALID" }

  $runtimeDirectory = Resolve-MediaInsideWorkspace ([string]$raw.runtime_directory)
  $previousCapability = $null
  if ($raw.capability_key.PSObject.Properties.Name -contains "previous" -and $null -ne $raw.capability_key.previous) {
    $previous = $raw.capability_key.previous
    $previousFields = @("kid", "protected_path", "accepted_from", "accepted_until")
    $previousNames = @($previous.PSObject.Properties.Name)
    if ($previousNames.Count -ne $previousFields.Count -or @($previousNames | Where-Object { $previousFields -notcontains $_ }).Count -gt 0) { throw "MEDIA_OPERATIONS_PROFILE_INVALID" }
    if ([string]$previous.kid -notmatch '^[A-Za-z0-9._-]{1,64}$' -or [string]$previous.accepted_from -notmatch '^\d{4}-\d{2}-\d{2}T' -or [string]$previous.accepted_until -notmatch '^\d{4}-\d{2}-\d{2}T') { throw "MEDIA_OPERATIONS_PROFILE_INVALID" }
    try { $from = [DateTimeOffset]::Parse([string]$previous.accepted_from, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal); $until = [DateTimeOffset]::Parse([string]$previous.accepted_until, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal) } catch { throw "MEDIA_OPERATIONS_PROFILE_INVALID" }
    $fromCanonical = $from.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")
    $untilCanonical = $until.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")
    if ($fromCanonical -ne [string]$previous.accepted_from -or $untilCanonical -ne [string]$previous.accepted_until) { throw "MEDIA_OPERATIONS_PROFILE_INVALID" }
    if ($until -le $from -or ($until - $from).TotalMinutes -gt 10) { throw "MEDIA_OPERATIONS_PROFILE_INVALID" }
    $previousCapability = [pscustomobject]@{ Kid = [string]$previous.kid; ProtectedPath = Resolve-MediaInsideWorkspace ([string]$previous.protected_path); AcceptedFrom = $fromCanonical; AcceptedUntil = $untilCanonical }
  }
  $profile = [ordered]@{
    ProfilePath = $profilePath
    DatabasePath = Resolve-MediaInsideWorkspace ([string]$raw.database_path)
    IssuerHash = [string]$raw.issuer_hash
    AllowedOrigin = ([string]$raw.allowed_origin).TrimEnd('/')
    GatewayPort = [int]$raw.gateway_port
    MediaRoots = @($raw.media_roots | ForEach-Object { Resolve-MediaInsideWorkspace ([string]$_) })
    CapabilityKid = [string]$raw.capability_key.kid
    CapabilityKeyPath = Resolve-MediaInsideWorkspace ([string]$raw.capability_key.protected_path)
    PreviousCapability = $previousCapability
    CloudflaredPath = Resolve-MediaInsideWorkspace ([string]$raw.cloudflared.executable_path)
    CloudflaredManifestPath = Resolve-MediaInsideWorkspace ([string]$raw.cloudflared.manifest_path)
    TunnelTokenPath = Resolve-MediaInsideWorkspace ([string]$raw.cloudflared.protected_token_path)
    PublicHealthUrl = [string]$raw.cloudflared.public_health_url
    RuntimeDirectory = $runtimeDirectory
    StatePath = Join-Path $runtimeDirectory "media-state.json"
    CountsPath = Join-Path $runtimeDirectory "media-counts.json"
  }
  return [pscustomobject]$profile
}

function Protect-MediaBytes([byte[]]$Bytes, [string]$Destination) {
  Add-Type -AssemblyName System.Security
  $protected = [System.Security.Cryptography.ProtectedData]::Protect($Bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  $temporary = "$Destination.tmp-$PID"
  try {
    [IO.File]::WriteAllText($temporary, [Convert]::ToBase64String($protected), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $Destination
  } finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    [Array]::Clear($protected, 0, $protected.Length)
  }
}

function ConvertFrom-MediaCapabilityKeyBase64Url([string]$Encoded) {
  if ($Encoded -notmatch '^[A-Za-z0-9_-]{43}$') { throw "MEDIA_CAPABILITY_KEY_INVALID" }
  $padded = $Encoded.Replace('-', '+').Replace('_', '/') + '='
  try { $bytes = [Convert]::FromBase64String($padded) } catch { throw "MEDIA_CAPABILITY_KEY_INVALID" }
  if ($bytes.Length -ne 32) {
    [Array]::Clear($bytes, 0, $bytes.Length)
    throw "MEDIA_CAPABILITY_KEY_INVALID"
  }
  $canonical = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  if ($canonical -cne $Encoded) {
    [Array]::Clear($bytes, 0, $bytes.Length)
    throw "MEDIA_CAPABILITY_KEY_INVALID"
  }
  return $bytes
}

function Unprotect-MediaBytes([string]$Path) {
  Add-Type -AssemblyName System.Security
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "MEDIA_OPERATIONS_SECRET_NOT_FOUND" }
  try { $protected = [Convert]::FromBase64String(([IO.File]::ReadAllText($Path)).Trim()) } catch { throw "MEDIA_OPERATIONS_SECRET_INVALID" }
  try { return [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser) } catch { throw "MEDIA_OPERATIONS_SECRET_INVALID" } finally { [Array]::Clear($protected, 0, $protected.Length) }
}

function Test-MediaProcess([object]$Record, [string]$Kind) {
  $pidValue = if ($Kind -eq "gateway") { [int]$Record.gateway_pid } else { [int]$Record.cloudflared_pid }
  $startedValue = if ($Kind -eq "gateway") { [string]$Record.gateway_start_time_utc } else { [string]$Record.cloudflared_start_time_utc }
  $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
  if ($null -eq $process) { return $false }
  $expectedPath = if ($Kind -eq "gateway") { [string]$Record.gateway_executable } else { [string]$Record.cloudflared_executable }
  try {
    return $process.StartTime.ToUniversalTime().ToString("o") -eq $startedValue -and
      [IO.Path]::GetFullPath($process.Path).Equals([IO.Path]::GetFullPath($expectedPath), [StringComparison]::OrdinalIgnoreCase)
  } catch { return $false }
}

function Get-MediaHttp([string]$Url, [int]$TimeoutSec = 3) {
  try { return [int](Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSec).StatusCode } catch { return if ($null -ne $_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 } }
}

function Get-MediaGatewayHealth([string]$Url, [int]$TimeoutSec = 3) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSec
    $body = $response.Content | ConvertFrom-Json
    $valid = [int]$response.StatusCode -eq 200 -and [bool]$body.ok -and [string]$body.service -eq "readonly-media-gateway" -and [string]$body.version -eq "readonly-media-gateway-v1.0.0"
    return [pscustomobject]@{ Status = [int]$response.StatusCode; Valid = $valid }
  } catch {
    $status = if ($null -ne $_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    return [pscustomobject]@{ Status = $status; Valid = $false }
  }
}

function Get-MediaListenerPid([int]$Port) {
  $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  if ($listeners.Count -eq 0) { return $null }
  $owners = @($listeners | ForEach-Object { [int]$_.OwningProcess } | Sort-Object -Unique)
  if ($owners.Count -ne 1) { throw "MEDIA_GATEWAY_PORT_MULTIPLE_LISTENERS" }
  return [int]$owners[0]
}

function Read-MediaState([object]$Profile) {
  if (-not (Test-Path -LiteralPath $Profile.StatePath -PathType Leaf)) { return $null }
  try { return Get-Content -Raw -LiteralPath $Profile.StatePath | ConvertFrom-Json } catch { throw "MEDIA_OPERATIONS_STATE_INVALID" }
}

function Assert-MediaRuntimeStateIdentity([object]$Profile, [string]$ExpectedGatewayExecutable, [string]$ExpectedProfileFingerprint, [object]$State) {
  $required = @("state_version", "profile_fingerprint", "gateway_pid", "gateway_start_time_utc", "gateway_executable", "cloudflared_pid", "cloudflared_start_time_utc", "cloudflared_executable", "started_at_utc", "gateway_port")
  $names = @($State.PSObject.Properties.Name)
  if ($names.Count -ne $required.Count -or @($required | Where-Object { $names -notcontains $_ }).Count -gt 0 -or @($names | Where-Object { $required -notcontains $_ }).Count -gt 0) { throw "MEDIA_OPERATIONS_STATE_INVALID" }
  try {
    if ([string]$State.state_version -ne "readonly-media-runtime-state-v2" -or [int]$State.gateway_port -ne [int]$Profile.GatewayPort) { throw "MEDIA_OPERATIONS_STATE_INVALID" }
    if ([string]$State.profile_fingerprint -notmatch '^[0-9a-f]{64}$') { throw "MEDIA_OPERATIONS_STATE_INVALID" }
    if ([string]$State.profile_fingerprint -cne $ExpectedProfileFingerprint) { throw "MEDIA_OPERATIONS_PROFILE_DRIFT" }
    if ([int]$State.gateway_pid -le 0 -or [int]$State.cloudflared_pid -le 0) { throw "MEDIA_OPERATIONS_STATE_INVALID" }
    $gatewayPath = [IO.Path]::GetFullPath([string]$State.gateway_executable)
    $expectedGatewayPath = [IO.Path]::GetFullPath($ExpectedGatewayExecutable)
    $cloudflaredPath = [IO.Path]::GetFullPath([string]$State.cloudflared_executable)
    $expectedCloudflaredPath = [IO.Path]::GetFullPath([string]$Profile.CloudflaredPath)
    if (-not $gatewayPath.Equals($expectedGatewayPath, [StringComparison]::OrdinalIgnoreCase) -or -not $cloudflaredPath.Equals($expectedCloudflaredPath, [StringComparison]::OrdinalIgnoreCase)) { throw "MEDIA_OPERATIONS_STATE_INVALID" }
  } catch {
    if ($_.Exception.Message -in @("MEDIA_OPERATIONS_STATE_INVALID", "MEDIA_OPERATIONS_PROFILE_DRIFT")) { throw }
    throw "MEDIA_OPERATIONS_STATE_INVALID"
  }
}

function Assert-MediaPreflightPortState([object]$Profile, [string]$ExpectedGatewayExecutable, [string]$ExpectedProfileFingerprint) {
  $listener = Get-MediaListenerPid $Profile.GatewayPort
  $state = Read-MediaState $Profile
  if ($null -eq $state) {
    if ($null -ne $listener) { throw "MEDIA_GATEWAY_PORT_IN_USE" }
    return
  }

  Assert-MediaRuntimeStateIdentity $Profile $ExpectedGatewayExecutable $ExpectedProfileFingerprint $state
  if (-not (Test-MediaProcess $state "gateway") -or -not (Test-MediaProcess $state "cloudflared")) { throw "MEDIA_OPERATIONS_STATE_CONFLICT" }
  if ($null -eq $listener -or [int]$listener -ne [int]$state.gateway_pid) { throw "MEDIA_GATEWAY_LISTENER_IDENTITY_MISMATCH" }
}

function Assert-Cloudflared([object]$Profile) {
  if (-not (Test-Path -LiteralPath $Profile.CloudflaredPath -PathType Leaf)) { throw "MEDIA_CLOUDFLARED_NOT_FOUND" }
  try { $manifest = Get-Content -Raw -LiteralPath $Profile.CloudflaredManifestPath | ConvertFrom-Json } catch { throw "MEDIA_CLOUDFLARED_MANIFEST_INVALID" }
  if ([string]$manifest.manifest_version -ne "cloudflared-binary-v1" -or [string]$manifest.platform -ne "windows-amd64" -or [string]$manifest.sha256 -notmatch '^[0-9a-f]{64}$') { throw "MEDIA_CLOUDFLARED_MANIFEST_INVALID" }
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Profile.CloudflaredPath).Hash.ToLowerInvariant()
  if ($actual -ne [string]$manifest.sha256) { throw "MEDIA_CLOUDFLARED_CHECKSUM_MISMATCH" }
  $version = & $Profile.CloudflaredPath --version 2>$null | Out-String
  if ($LASTEXITCODE -ne 0 -or $version -notmatch [Regex]::Escape([string]$manifest.version)) { throw "MEDIA_CLOUDFLARED_VERSION_MISMATCH" }
  return [string]$manifest.version
}
