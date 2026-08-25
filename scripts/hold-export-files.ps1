$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

if (-not ("WorkbenchExportNative" -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

public static class WorkbenchExportNative
{
    private const uint FILE_READ_ATTRIBUTES = 0x00000080;
    private const uint DELETE = 0x00010000;
    private const uint GENERIC_READ = 0x80000000;
    private const uint GENERIC_WRITE = 0x40000000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    private const uint SYNCHRONIZE = 0x00100000;
    private const uint FILE_CREATE = 2;
    private const uint FILE_NON_DIRECTORY_FILE = 0x00000040;
    private const uint FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020;
    private const uint OBJ_CASE_INSENSITIVE = 0x00000040;

    [StructLayout(LayoutKind.Sequential)]
    private struct FileDispositionInfo
    {
        public byte DeleteFile;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct UnicodeString
    {
        public ushort Length;
        public ushort MaximumLength;
        public IntPtr Buffer;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ObjectAttributes
    {
        public int Length;
        public IntPtr RootDirectory;
        public IntPtr ObjectName;
        public uint Attributes;
        public IntPtr SecurityDescriptor;
        public IntPtr SecurityQualityOfService;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoStatusBlock
    {
        public IntPtr Status;
        public UIntPtr Information;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ByHandleFileInformation
    {
        public uint FileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        [MarshalAs(UnmanagedType.LPWStr)] string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFileInformationByHandle(
        SafeFileHandle file,
        int fileInformationClass,
        ref FileDispositionInfo information,
        uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(
        SafeFileHandle file,
        out ByHandleFileInformation information);

    [DllImport("ntdll.dll")]
    private static extern int NtCreateFile(
        out SafeFileHandle fileHandle,
        uint desiredAccess,
        ref ObjectAttributes objectAttributes,
        out IoStatusBlock ioStatusBlock,
        IntPtr allocationSize,
        uint fileAttributes,
        uint shareAccess,
        uint createDisposition,
        uint createOptions,
        IntPtr eaBuffer,
        uint eaLength);

    [DllImport("ntdll.dll")]
    private static extern uint RtlNtStatusToDosError(int status);

    public static SafeFileHandle HoldDirectoryEntry(string path)
    {
        SafeFileHandle handle = CreateFileW(
            path,
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            IntPtr.Zero,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            IntPtr.Zero);
        if (handle.IsInvalid)
        {
            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(error);
        }
        return handle;
    }

    public static void AssertIdentity(SafeFileHandle handle, string expectedDevice, string expectedInode)
    {
        ByHandleFileInformation information;
        if (!GetFileInformationByHandle(handle, out information))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        ulong expectedVolume = UInt64.Parse(expectedDevice, CultureInfo.InvariantCulture);
        ulong expectedFileIndex = UInt64.Parse(expectedInode, CultureInfo.InvariantCulture);
        ulong fileIndex = ((ulong)information.FileIndexHigh << 32) | information.FileIndexLow;
        if (expectedVolume != information.VolumeSerialNumber || expectedFileIndex != fileIndex)
        {
            throw new InvalidOperationException("EXPORT_DIRECTORY_IDENTITY_MISMATCH");
        }
    }

    public static SafeFileHandle CreateExclusiveFileRelative(SafeFileHandle directory, string name)
    {
        if (directory == null || directory.IsInvalid || String.IsNullOrWhiteSpace(name)
            || !Regex.IsMatch(name, "^[A-Za-z0-9_.-]+$"))
        {
            throw new ArgumentException("EXPORT_RELATIVE_NAME_INVALID");
        }
        byte[] encoded = Encoding.Unicode.GetBytes(name + "\0");
        IntPtr nameBuffer = Marshal.AllocHGlobal(encoded.Length);
        IntPtr unicodePointer = IntPtr.Zero;
        bool directoryReferenced = false;
        try
        {
            Marshal.Copy(encoded, 0, nameBuffer, encoded.Length);
            UnicodeString unicode = new UnicodeString {
                Length = checked((ushort)(encoded.Length - 2)),
                MaximumLength = checked((ushort)encoded.Length),
                Buffer = nameBuffer
            };
            unicodePointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));
            Marshal.StructureToPtr(unicode, unicodePointer, false);
            directory.DangerousAddRef(ref directoryReferenced);
            ObjectAttributes attributes = new ObjectAttributes {
                Length = Marshal.SizeOf(typeof(ObjectAttributes)),
                RootDirectory = directory.DangerousGetHandle(),
                ObjectName = unicodePointer,
                Attributes = OBJ_CASE_INSENSITIVE,
                SecurityDescriptor = IntPtr.Zero,
                SecurityQualityOfService = IntPtr.Zero
            };
            IoStatusBlock ioStatus;
            SafeFileHandle handle;
            int status = NtCreateFile(
                out handle,
                GENERIC_READ | GENERIC_WRITE | DELETE | SYNCHRONIZE,
                ref attributes,
                out ioStatus,
                IntPtr.Zero,
                FILE_ATTRIBUTE_NORMAL,
                FILE_SHARE_READ,
                FILE_CREATE,
                FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT,
                IntPtr.Zero,
                0);
            if (status < 0)
            {
                if (handle != null) handle.Dispose();
                throw new Win32Exception((int)RtlNtStatusToDosError(status));
            }
            return handle;
        }
        finally
        {
            if (directoryReferenced) directory.DangerousRelease();
            if (unicodePointer != IntPtr.Zero) Marshal.FreeHGlobal(unicodePointer);
            Marshal.FreeHGlobal(nameBuffer);
        }
    }

    public static void SetDeleteDisposition(SafeFileHandle file, bool deleteFile)
    {
        FileDispositionInfo information = new FileDispositionInfo { DeleteFile = deleteFile ? (byte)1 : (byte)0 };
        if (!SetFileInformationByHandle(file, 4, ref information, 1))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
    }
}
"@
}

$dataRootPath = [Console]::In.ReadLine()
$dataRootDevice = [Console]::In.ReadLine()
$dataRootInode = [Console]::In.ReadLine()
$exportRootPath = [Console]::In.ReadLine()
$exportRootDevice = [Console]::In.ReadLine()
$exportRootInode = [Console]::In.ReadLine()
$projectDirectoryPath = [Console]::In.ReadLine()
$projectDirectoryDevice = [Console]::In.ReadLine()
$projectDirectoryInode = [Console]::In.ReadLine()
$partPath = [Console]::In.ReadLine()
$finalPath = [Console]::In.ReadLine()
$sourcePath = [Console]::In.ReadLine()

$dataRoot = $null
$exportRoot = $null
$projectDirectory = $null
$part = $null
$final = $null
$partHandle = $null
$finalHandle = $null
$source = $null
$result = "ERROR"

try {
  if ([string]::IsNullOrWhiteSpace($dataRootPath) -or
      [string]::IsNullOrWhiteSpace($dataRootDevice) -or
      [string]::IsNullOrWhiteSpace($dataRootInode) -or
      [string]::IsNullOrWhiteSpace($exportRootPath) -or
      [string]::IsNullOrWhiteSpace($exportRootDevice) -or
      [string]::IsNullOrWhiteSpace($exportRootInode) -or
      [string]::IsNullOrWhiteSpace($projectDirectoryPath) -or
      [string]::IsNullOrWhiteSpace($projectDirectoryDevice) -or
      [string]::IsNullOrWhiteSpace($projectDirectoryInode) -or
      [string]::IsNullOrWhiteSpace($partPath) -or
      [string]::IsNullOrWhiteSpace($finalPath) -or
      [string]::IsNullOrWhiteSpace($sourcePath)) {
    throw [System.InvalidOperationException]::new("EXPORT_HANDLE_INPUT_INVALID")
  }

  $dataRoot = [WorkbenchExportNative]::HoldDirectoryEntry($dataRootPath)
  [WorkbenchExportNative]::AssertIdentity($dataRoot, $dataRootDevice, $dataRootInode)
  $exportRoot = [WorkbenchExportNative]::HoldDirectoryEntry($exportRootPath)
  [WorkbenchExportNative]::AssertIdentity($exportRoot, $exportRootDevice, $exportRootInode)
  $projectDirectory = [WorkbenchExportNative]::HoldDirectoryEntry($projectDirectoryPath)
  [WorkbenchExportNative]::AssertIdentity($projectDirectory, $projectDirectoryDevice, $projectDirectoryInode)

  if (-not [System.StringComparer]::OrdinalIgnoreCase.Equals([System.IO.Path]::GetDirectoryName($partPath), $projectDirectoryPath) -or
      -not [System.StringComparer]::OrdinalIgnoreCase.Equals([System.IO.Path]::GetDirectoryName($finalPath), $projectDirectoryPath)) {
    throw [System.InvalidOperationException]::new("EXPORT_HANDLE_DIRECTORY_BINDING_INVALID")
  }

  [Console]::Out.WriteLine("LEASED")
  [Console]::Out.Flush()
  $firstCommand = [Console]::In.ReadLine()
  if ($firstCommand -eq "ABORT") {
    $result = "ABORTED"
  } elseif ($firstCommand -ne "COPY") {
    throw [System.InvalidOperationException]::new("EXPORT_HANDLE_COPY_NOT_CONFIRMED")
  }

  if ($firstCommand -eq "COPY") {
    $partHandle = [WorkbenchExportNative]::CreateExclusiveFileRelative($projectDirectory, [System.IO.Path]::GetFileName($partPath))
    $part = [System.IO.FileStream]::new(
      $partHandle,
      [System.IO.FileAccess]::ReadWrite,
      1048576,
      $false)
    $finalHandle = [WorkbenchExportNative]::CreateExclusiveFileRelative($projectDirectory, [System.IO.Path]::GetFileName($finalPath))
    $final = [System.IO.FileStream]::new(
      $finalHandle,
      [System.IO.FileAccess]::ReadWrite,
      1048576,
      $false)

    $source = [System.IO.FileStream]::new(
      $sourcePath,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read,
      [System.IO.FileShare]::Read,
      1048576,
      [System.IO.FileOptions]::SequentialScan)
    $part.SetLength(0)
    $source.CopyTo($part, 1048576)
    $part.Flush($true)
    $part.Position = 0
    $final.SetLength(0)
    $part.CopyTo($final, 1048576)
    $final.Flush($true)
    $source.Dispose()
    $source = $null

    [Console]::Out.WriteLine("COPIED")
    [Console]::Out.Flush()
    $command = [Console]::In.ReadLine()
    if ($command -eq "PRESERVE") {
      [WorkbenchExportNative]::SetDeleteDisposition($part.SafeFileHandle, $true)
      $result = "PRESERVED"
    } elseif ($command -eq "ABORT") {
      [WorkbenchExportNative]::SetDeleteDisposition($part.SafeFileHandle, $true)
      [WorkbenchExportNative]::SetDeleteDisposition($final.SafeFileHandle, $true)
      $result = "ABORTED"
    } else {
      throw [System.InvalidOperationException]::new("EXPORT_HANDLE_RELEASE_INVALID")
    }
  }
} catch {
  if ($null -ne $part) {
    try { [WorkbenchExportNative]::SetDeleteDisposition($part.SafeFileHandle, $true) } catch {}
  } elseif ($null -ne $partHandle) {
    try { [WorkbenchExportNative]::SetDeleteDisposition($partHandle, $true) } catch {}
  }
  if ($null -ne $final) {
    try { [WorkbenchExportNative]::SetDeleteDisposition($final.SafeFileHandle, $true) } catch {}
  } elseif ($null -ne $finalHandle) {
    try { [WorkbenchExportNative]::SetDeleteDisposition($finalHandle, $true) } catch {}
  }
  $result = "ERROR"
} finally {
  if ($null -ne $source) { $source.Dispose() }
  if ($null -ne $final) { $final.Dispose() }
  if ($null -ne $part) { $part.Dispose() }
  if ($null -ne $finalHandle) { $finalHandle.Dispose() }
  if ($null -ne $partHandle) { $partHandle.Dispose() }
  if ($null -ne $projectDirectory) { $projectDirectory.Dispose() }
  if ($null -ne $exportRoot) { $exportRoot.Dispose() }
  if ($null -ne $dataRoot) { $dataRoot.Dispose() }
}

[Console]::Out.WriteLine($result)
[Console]::Out.Flush()
if ($result -eq "ERROR") { exit 1 }
