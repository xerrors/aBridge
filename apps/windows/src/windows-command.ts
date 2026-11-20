/** A job owns the command's descendants even when the shell exits before them. */
export function windowsCommand(command: string): string[] {
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ABridgeCommandJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long a,b; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic basic; public IO io; public UIntPtr process,job,peakProcess,peakJob; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr data, uint size);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  static IntPtr handle;
  public static void Attach() {
    handle = CreateJobObject(IntPtr.Zero, null);
    var info = new Extended(); info.basic.flags = 0x2000;
    var size = Marshal.SizeOf(info); var ptr = Marshal.AllocHGlobal(size);
    try {
      Marshal.StructureToPtr(info, ptr, false);
      if (handle == IntPtr.Zero || !SetInformationJobObject(handle, 9, ptr, (uint)size) || !AssignProcessToJobObject(handle, GetCurrentProcess())) throw new Exception("Cannot isolate command process tree");
    } finally { Marshal.FreeHGlobal(ptr); }
  }
}
'@
[ABridgeCommandJob]::Attach()
$global:LASTEXITCODE = 0
try {
  & ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(command).toString("base64")}'))))
  if (-not $?) { exit 1 }
  exit $LASTEXITCODE
} catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }
`;
  return [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}
