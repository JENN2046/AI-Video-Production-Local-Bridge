[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$stream = $null

try {
    $databasePath = [Console]::In.ReadLine()
    if ([string]::IsNullOrWhiteSpace($databasePath)) {
        exit 1
    }

    $stream = [System.IO.FileStream]::new(
        $databasePath,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::ReadWrite
    )
    [Console]::Out.WriteLine("LOCKED")
    [Console]::Out.Flush()

    if ([Console]::In.ReadLine() -ne "RELEASE") {
        exit 1
    }
}
catch {
    exit 1
}
finally {
    if ($null -ne $stream) {
        $stream.Dispose()
    }
}
