[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$handles = [System.Collections.Generic.List[System.IDisposable]]::new()

try {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace MediaDatabasePathGuard
{
    [StructLayout(LayoutKind.Sequential)]
    internal struct ByHandleFileInformation
    {
        internal uint FileAttributes;
        internal uint CreationTimeLow;
        internal uint CreationTimeHigh;
        internal uint LastAccessTimeLow;
        internal uint LastAccessTimeHigh;
        internal uint LastWriteTimeLow;
        internal uint LastWriteTimeHigh;
        internal uint VolumeSerialNumber;
        internal uint FileSizeHigh;
        internal uint FileSizeLow;
        internal uint NumberOfLinks;
        internal uint FileIndexHigh;
        internal uint FileIndexLow;
    }

    public static class NativeMethods
    {
        private const uint GenericRead = 0x80000000;
        private const uint GenericWrite = 0x40000000;
        private const uint FileShareRead = 0x00000001;
        private const uint FileShareWrite = 0x00000002;
        private const uint OpenExisting = 3;
        private const uint OpenAlways = 4;
        private const uint FileAttributeDirectory = 0x00000010;
        private const uint FileAttributeNormal = 0x00000080;
        private const uint FileAttributeReparsePoint = 0x00000400;
        private const uint FileFlagOpenReparsePoint = 0x00200000;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandle(
            SafeFileHandle file,
            out ByHandleFileInformation information);

        public static SafeFileHandle OpenProtected(string path, bool createIfMissing)
        {
            SafeFileHandle handle = CreateFileW(
                path,
                GenericRead | GenericWrite,
                FileShareRead | FileShareWrite,
                IntPtr.Zero,
                createIfMissing ? OpenAlways : OpenExisting,
                FileAttributeNormal | FileFlagOpenReparsePoint,
                IntPtr.Zero);
            if (handle.IsInvalid)
            {
                int error = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new Win32Exception(error);
            }
            try
            {
                Validate(handle);
                return handle;
            }
            catch
            {
                handle.Dispose();
                throw;
            }
        }

        public static void Validate(SafeFileHandle handle)
        {
            ByHandleFileInformation information;
            if (handle == null || handle.IsInvalid || handle.IsClosed
                || !GetFileInformationByHandle(handle, out information))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            if ((information.FileAttributes & (FileAttributeDirectory | FileAttributeReparsePoint)) != 0
                || information.NumberOfLinks != 1)
            {
                throw new InvalidOperationException();
            }
        }
    }
}
'@

    $databasePath = [Console]::In.ReadLine()
    if ([string]::IsNullOrWhiteSpace($databasePath)) {
        exit 1
    }

    $protectedPaths = @(
        [pscustomobject]@{ Path = $databasePath; CreateIfMissing = $false },
        [pscustomobject]@{ Path = "$databasePath-wal"; CreateIfMissing = $true },
        [pscustomobject]@{ Path = "$databasePath-shm"; CreateIfMissing = $true }
    )
    foreach ($protectedPath in $protectedPaths) {
        $handle = [MediaDatabasePathGuard.NativeMethods]::OpenProtected(
            [string]$protectedPath.Path,
            [bool]$protectedPath.CreateIfMissing
        )
        $handles.Add($handle)
    }
    foreach ($handle in $handles) {
        [MediaDatabasePathGuard.NativeMethods]::Validate($handle)
    }

    [Console]::Out.WriteLine("LOCKED")
    [Console]::Out.Flush()

    $releaseTask = [Console]::In.ReadLineAsync()
    while (-not $releaseTask.Wait(100)) {
        foreach ($handle in $handles) {
            [MediaDatabasePathGuard.NativeMethods]::Validate($handle)
        }
    }
    if ($releaseTask.Result -ne "RELEASE") {
        exit 1
    }
    foreach ($handle in $handles) {
        [MediaDatabasePathGuard.NativeMethods]::Validate($handle)
    }
}
catch {
    exit 1
}
finally {
    for ($index = $handles.Count - 1; $index -ge 0; $index -= 1) {
        $handles[$index].Dispose()
    }
}
