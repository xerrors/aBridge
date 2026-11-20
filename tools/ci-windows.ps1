# GitHub's Windows runner is elevated: its default object owner can be the
# Administrators group. Use the actual user's SID for files created by this
# verification process and its children, as in a normal desktop login.
# This changes only our process token, never machine policy or existing files.
param([ValidateSet('check', 'windows:shell:check', 'package:windows', 'package:windows:check', 'diagnose')][string]$Task = 'check')
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class VerificationTokenOwner {
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool SetTokenInformation(IntPtr token, int kind, IntPtr info, int size);
  public static void SetUser() {
    IntPtr token;
    if (!OpenProcessToken(GetCurrentProcess(), 0x88, out token)) throw new Win32Exception();
    var sid = WindowsIdentity.GetCurrent().User;
    var bytes = new byte[sid.BinaryLength]; sid.GetBinaryForm(bytes, 0);
    var buffer = Marshal.AllocHGlobal(bytes.Length);
    var owner = Marshal.AllocHGlobal(IntPtr.Size);
    try {
      Marshal.Copy(bytes, 0, buffer, bytes.Length); Marshal.WriteIntPtr(owner, buffer);
      if (!SetTokenInformation(token, 4, owner, IntPtr.Size)) throw new Win32Exception();
    } finally { Marshal.FreeHGlobal(owner); Marshal.FreeHGlobal(buffer); CloseHandle(token); }
  }
}
'@
[VerificationTokenOwner]::SetUser()
if ($Task -eq 'diagnose') {
  & node --import tsx --test tools/fixtures/windows-command-startup.ts
} else {
  & npm.cmd run $Task
}
exit $LASTEXITCODE
