/** Opt-in native window smoke test against legacy Node and native-runtime unpacked candidates.
 * This verifies shell activation and pause intent, not browser binding or real desktop input.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { configureClient } from "../apps/windows/src/runtime.js";

if (process.platform !== "win32" || process.env.ABRIDGE_WINDOWS_LIVE !== "1")
  throw Error("Native shell checks require Windows and explicit ABRIDGE_WINDOWS_LIVE=1.");
const [oldPath, newPath] = process.argv.slice(2).map((path) => resolve(path));
if (!oldPath || !newPath) throw Error("Provide old and new unpacked package directories.");
function cli(directory: string): { executable: string; prefix: string[] } {
  const node = join(directory, "runtime/node.exe");
  return existsSync(node)
    ? { executable: node, prefix: [join(directory, "runtime/cli.js")] }
    : { executable: join(directory, "aBridge.exe"), prefix: [] };
}
for (const directory of [oldPath, newPath]) {
  assert.ok(existsSync(join(directory, "aBridge.exe")), "Package must contain aBridge.exe");
  for (const file of cli(directory).prefix) assert.ok(existsSync(file), "Legacy CLI is missing");
}
const temp = await mkdtemp(join(tmpdir(), "abridge-native-shell-"));
// No real account or device authorization; refused loopback endpoint exercises offline pause persistence.
const state = join(temp, "shared-state");
await configureClient(state, {
  url: "http://127.0.0.1:1",
  device_key: "abr_device_shell_fixture",
  capabilities: { screen: false, input: false, shell: false, files: false },
});
const credential = await readFile(join(state, "credentials/device.json"));
const initialConfig = JSON.parse(await readFile(join(state, "config.json"), "utf8"));
await mkdir(join(state, "windows-ui"), { recursive: true });
await writeFile(join(state, "windows-ui/native-preferences.json"), '{"theme":2}');
const script = join(temp, "check.ps1");
await writeFile(
  script,
  `
param([string]$Old,[string]$New,[string]$State)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class NativeShellCheck {
 public delegate bool EnumProc(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback,IntPtr p);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint msg,IntPtr w,IntPtr l);
 public static IntPtr Find(int pid) {
  IntPtr found=IntPtr.Zero;
  EnumWindows((h,p)=>{uint owner; GetWindowThreadProcessId(h,out owner); var title=new StringBuilder(256); GetWindowText(h,title,256); if(owner==pid && title.ToString()=="aBridge") found=h; return true;},IntPtr.Zero);
  return found;
 }
}
'@
function Wait-For([scriptblock]$Condition,[string]$Message) {
 $until=[DateTime]::UtcNow.AddSeconds(20)
 do { if (& $Condition) {return}; Start-Sleep -Milliseconds 50 } while([DateTime]::UtcNow -lt $until)
 throw $Message
}
function Invoke-Client([string]$Package,[string[]]$Arguments) {
 $node=Join-Path $Package 'runtime/node.exe'
 if(Test-Path -LiteralPath $node){
  $raw=& $node (Join-Path $Package 'runtime/cli.js') @Arguments --state-dir $State | Out-String
 } else {
  $raw=& (Join-Path $Package 'aBridge.exe') @Arguments --state-dir $State | Out-String
 }
 if($LASTEXITCODE -ne 0){throw ('Client command failed: '+$raw)}
 return ($raw | ConvertFrom-Json)
}
function Run-Pair([string]$First,[string]$Second,[bool]$InitiallyPaused) {
 $process=$null
 $secondProcess=$null
 try {
  $process=Start-Process -FilePath (Join-Path $First 'aBridge.exe') -ArgumentList @('--state-dir',('"'+$State+'"')) -WindowStyle Hidden -PassThru
  Wait-For { [NativeShellCheck]::Find($process.Id) -ne [IntPtr]::Zero } 'Primary shell did not create its window'
  $window=[NativeShellCheck]::Find($process.Id)
  [void][NativeShellCheck]::PostMessage($window,0x10,[IntPtr]::Zero,[IntPtr]::Zero)
  Wait-For { -not [NativeShellCheck]::IsWindowVisible($window) } 'Close did not hide to tray'
  $secondProcess=Start-Process -FilePath (Join-Path $Second 'aBridge.exe') -ArgumentList @('--state-dir',('"'+$State.ToUpperInvariant()+'/"')) -WindowStyle Hidden -PassThru
  if(-not $secondProcess.WaitForExit(10000)){ Stop-Process -Id $secondProcess.Id -Force; throw 'Cross-version mutex failed' }
  Wait-For { [NativeShellCheck]::IsWindowVisible($window) } 'Second instance did not activate first shell'
  Wait-For { Test-Path -LiteralPath (Join-Path $State 'control-auth.json') } 'Runtime did not open local control'
  Wait-For {
   try {
    $status=Invoke-Client $First @('status')
    if($status.paused -ne $InitiallyPaused){return $false}
    $resumed=Invoke-Client $First @('control','resume')
    return $resumed.ok -eq $true
   } catch { return $false }
  } 'Runtime did not preserve startup pause state or accept resume'
  Wait-For { (Get-Content -LiteralPath (Join-Path $State 'config.json') -Raw | ConvertFrom-Json).paused -eq $false } 'Resume did not persist'
  [void][NativeShellCheck]::PostMessage($window,0x312,[IntPtr]1,[IntPtr]::Zero)
  Wait-For { (Get-Content -LiteralPath (Join-Path $State 'config.json') -Raw | ConvertFrom-Json).paused -eq $true } 'Pause shortcut did not persist pause'
  [void][NativeShellCheck]::PostMessage($window,0x312,[IntPtr]1,[IntPtr]::Zero)
  Start-Sleep -Milliseconds 750
  if(-not (Get-Content -LiteralPath (Join-Path $State 'config.json') -Raw | ConvertFrom-Json).paused){throw 'Repeated pause shortcut resumed client'}
  $status=Invoke-Client $First @('status')
  if($status.paused -ne $true){throw 'Live runtime status disagrees with persisted pause'}
  if($status.active_operations -ne 0){throw 'Offline fixture unexpectedly has active operations'}
  Write-Output ('PASS: '+$First+' -> '+$Second+' hide, mutual exclusion, activation, inherited pause, resume, pause-only shortcut')
 } finally {
  if($secondProcess -and -not $secondProcess.HasExited){Stop-Process -Id $secondProcess.Id -Force}
  if($process -and -not $process.HasExited){Stop-Process -Id $process.Id -Force}
  # The real host observes pipe/parent loss and cleans its children. This is cleanup, not graceful-quit acceptance.
  Start-Sleep -Seconds 3
 }
}
Run-Pair $Old $New $false
Run-Pair $New $Old $true
`,
  "utf8",
);
try {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-Old",
      oldPath,
      "-New",
      newPath,
      "-State",
      state,
    ],
    {
      windowsHide: true,
      encoding: "utf8",
      timeout: 120000,
    },
  );
  process.stdout.write(result.stdout ?? "");
  if (result.status !== 0) {
    for (const directory of [oldPath, newPath]) {
      const command = cli(directory);
      const diagnostic = spawnSync(command.executable, [...command.prefix, "status", "--state-dir", state], {
        windowsHide: true,
        encoding: "utf8",
        timeout: 10000,
      });
      process.stderr.write((diagnostic.stdout ?? "") + (diagnostic.stderr ?? ""));
    }
  }
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.equal(
    JSON.parse(await readFile(join(state, "windows-ui/native-preferences.json"), "utf8")).theme,
    2,
  );
  assert.deepEqual(
    await readFile(join(state, "credentials/device.json")),
    credential,
    "Device identity changed",
  );
  const finalConfig = JSON.parse(await readFile(join(state, "config.json"), "utf8"));
  assert.equal(finalConfig.url, initialConfig.url, "Server binding changed");
  assert.deepEqual(finalConfig.capabilities, initialConfig.capabilities, "Capability preferences changed");
  assert.equal(finalConfig.paused, true);
  console.log("Legacy state, credentials, preferences and bidirectional shell behavior checks passed.");
} finally {
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
