[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$directoryHandles = [System.Collections.Generic.List[System.IDisposable]]::new()
$fileHandles = [System.Collections.Generic.List[System.IDisposable]]::new()

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
        private const uint FileReadAttributes = 0x00000080;
        private const uint FileShareRead = 0x00000001;
        private const uint FileShareWrite = 0x00000002;
        private const uint OpenExisting = 3;
        private const uint FileAttributeDirectory = 0x00000010;
        private const uint FileAttributeNormal = 0x00000080;
        private const uint FileAttributeReparsePoint = 0x00000400;
        private const uint FileFlagBackupSemantics = 0x02000000;
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

        public static SafeFileHandle OpenProtected(string path)
        {
            SafeFileHandle handle = CreateFileW(
                path,
                GenericRead | GenericWrite,
                FileShareRead | FileShareWrite,
                IntPtr.Zero,
                OpenExisting,
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

        public static SafeFileHandle OpenProtectedDirectory(string path)
        {
            SafeFileHandle handle = CreateFileW(
                path,
                FileReadAttributes,
                FileShareRead | FileShareWrite,
                IntPtr.Zero,
                OpenExisting,
                FileFlagBackupSemantics | FileFlagOpenReparsePoint,
                IntPtr.Zero);
            if (handle.IsInvalid)
            {
                int error = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new Win32Exception(error);
            }
            try
            {
                ValidateDirectory(handle);
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

        public static string Identity(SafeFileHandle handle)
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
            ulong fileIndex = ((ulong)information.FileIndexHigh << 32) | information.FileIndexLow;
            return information.VolumeSerialNumber.ToString("X8") + ":" + fileIndex.ToString("X16");
        }

        public static void ValidateDirectory(SafeFileHandle handle)
        {
            ByHandleFileInformation information;
            if (handle == null || handle.IsInvalid || handle.IsClosed
                || !GetFileInformationByHandle(handle, out information))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            if ((information.FileAttributes & FileAttributeDirectory) == 0
                || (information.FileAttributes & FileAttributeReparsePoint) != 0)
            {
                throw new InvalidOperationException();
            }
        }

        public static string DirectoryIdentity(SafeFileHandle handle)
        {
            ValidateDirectory(handle);
            ByHandleFileInformation information;
            if (!GetFileInformationByHandle(handle, out information))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            ulong fileIndex = ((ulong)information.FileIndexHigh << 32) | information.FileIndexLow;
            return information.VolumeSerialNumber.ToString("X8") + ":" + fileIndex.ToString("X16");
        }
    }
}
'@

    $databasePath = [Console]::In.ReadLine()
    if ([string]::IsNullOrWhiteSpace($databasePath)) {
        exit 1
    }
    $expectedFileIdentityText = [Console]::In.ReadLine()
    $expectedFileIdentities = @($expectedFileIdentityText -split ",")
    if ($expectedFileIdentities.Count -ne 3 -or
        @($expectedFileIdentities | Where-Object { [string]$_ -cnotmatch "^[0-9A-F]{8}:[0-9A-F]{16}$" }).Count -ne 0) {
        exit 1
    }
    $expectedDirectoryIdentityText = [Console]::In.ReadLine()
    $expectedDirectoryIdentities = @($expectedDirectoryIdentityText -split ",")
    if ($expectedDirectoryIdentities.Count -lt 1 -or
        @($expectedDirectoryIdentities | Where-Object { [string]$_ -cnotmatch "^[0-9A-F]{8}:[0-9A-F]{16}$" }).Count -ne 0) {
        exit 1
    }

    $directoryPaths = [System.Collections.Generic.List[string]]::new()
    $currentDirectory = [System.IO.DirectoryInfo]::new(
        [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($databasePath))
    )
    while ($null -ne $currentDirectory) {
        $directoryPaths.Insert(0, $currentDirectory.FullName)
        $currentDirectory = $currentDirectory.Parent
    }
    if ($directoryPaths.Count -ne $expectedDirectoryIdentities.Count) {
        exit 1
    }
    for ($index = 0; $index -lt $directoryPaths.Count; $index += 1) {
        $handle = [MediaDatabasePathGuard.NativeMethods]::OpenProtectedDirectory([string]$directoryPaths[$index])
        $directoryHandles.Add($handle)
        if ([MediaDatabasePathGuard.NativeMethods]::DirectoryIdentity($handle) -cne [string]$expectedDirectoryIdentities[$index]) {
            throw [System.InvalidOperationException]::new()
        }
    }

    $protectedPaths = @(
        $databasePath,
        "$databasePath-wal",
        "$databasePath-shm"
    )
    for ($index = 0; $index -lt $protectedPaths.Count; $index += 1) {
        $handle = [MediaDatabasePathGuard.NativeMethods]::OpenProtected([string]$protectedPaths[$index])
        $fileHandles.Add($handle)
        if ([MediaDatabasePathGuard.NativeMethods]::Identity($handle) -cne [string]$expectedFileIdentities[$index]) {
            throw [System.InvalidOperationException]::new()
        }
    }
    foreach ($handle in $directoryHandles) {
        [MediaDatabasePathGuard.NativeMethods]::ValidateDirectory($handle)
    }
    foreach ($handle in $fileHandles) {
        [MediaDatabasePathGuard.NativeMethods]::Validate($handle)
    }

    [Console]::Out.WriteLine("LOCKED")
    [Console]::Out.Flush()

    $releaseTask = [Console]::In.ReadLineAsync()
    while (-not $releaseTask.Wait(100)) {
        foreach ($handle in $directoryHandles) {
            [MediaDatabasePathGuard.NativeMethods]::ValidateDirectory($handle)
        }
        foreach ($handle in $fileHandles) {
            [MediaDatabasePathGuard.NativeMethods]::Validate($handle)
        }
    }
    if ($releaseTask.Result -ne "RELEASE") {
        exit 1
    }
    foreach ($handle in $directoryHandles) {
        [MediaDatabasePathGuard.NativeMethods]::ValidateDirectory($handle)
    }
    foreach ($handle in $fileHandles) {
        [MediaDatabasePathGuard.NativeMethods]::Validate($handle)
    }
}
catch {
    exit 1
}
finally {
    for ($index = $fileHandles.Count - 1; $index -ge 0; $index -= 1) {
        $fileHandles[$index].Dispose()
    }
    for ($index = $directoryHandles.Count - 1; $index -ge 0; $index -= 1) {
        $directoryHandles[$index].Dispose()
    }
}
