import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { type Socket } from "node:net";
import { join } from "node:path";
import { DesktopError } from "./errors.js";

export const powershellPath = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

// A private stdio worker reuses PowerShell, not permission decisions. Every request
// reads the current owner/DACL and rejects reparse points exactly as a fresh process did.
const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
function Check-PrivatePath([string]$p,[bool]$createAcl) {
$item = Get-Item -LiteralPath $p -Force
if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point refused' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$existing = $item.GetAccessControl()
if ($existing.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Wrong owner' }
if ($createAcl) {
if ($item.PSIsContainer) { $acl = New-Object Security.AccessControl.DirectorySecurity } else { $acl = New-Object Security.AccessControl.FileSecurity }
# The owner already matches. Writing it again requires WRITE_OWNER, which an
# owner with inherited Modify access need not have; owners can change the DACL.
$acl.SetAccessRuleProtection($true, $false)
$inherit = if ($item.PSIsContainer) { [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
foreach ($who in @($sid, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))) {
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($who, 'FullControl', $inherit, 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
$item.SetAccessControl($acl)
}
$acl = $item.GetAccessControl()
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Wrong owner' }
$hasOwner = $false
foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow') {
    if ($rule.IdentityReference.Value -notin @($sid.Value, 'S-1-5-18')) { throw 'Shared access refused' }
    if ($rule.IdentityReference.Value -eq $sid.Value) { $hasOwner = $true }
  }
}
if (-not $hasOwner) { throw 'Owner access missing' }
}
while ($null -ne ($line = [Console]::ReadLine())) {
  $id = 0
  try {
    if ($line.Length -gt 65536) { throw 'Request too large' }
    $request = $line | ConvertFrom-Json
    $id = $request.id
    if ($id -isnot [int] -or $id -le 0 -or $request.path -isnot [string] -or $request.createAcl -isnot [bool]) { throw 'Invalid request' }
    Check-PrivatePath $request.path $request.createAcl
    [Console]::WriteLine((@{id=$id;ok=$true} | ConvertTo-Json -Compress))
  } catch {
    [Console]::WriteLine((@{id=$id;ok=$false} | ConvertTo-Json -Compress))
  }
}
`;
const permissionError = () =>
  new DesktopError("credential_permissions", "Windows local state requires a private owner ACL");

class PermissionWorker {
  private readonly child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private buffer = "";
  private closed = false;
  private readonly pending = new Map<number, { finish(error?: Error): void }>();

  constructor() {
    this.child = spawn(
      powershellPath,
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child.stderr.resume(); // Neither native errors nor paths enter application logs.
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > 8192) return this.fail();
      while (this.buffer.includes("\n")) {
        const end = this.buffer.indexOf("\n");
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        try {
          const reply: unknown = JSON.parse(line);
          if (
            !reply ||
            typeof reply !== "object" ||
            !("id" in reply) ||
            !("ok" in reply) ||
            typeof reply.id !== "number" ||
            typeof reply.ok !== "boolean"
          )
            return this.fail();
          const request = this.pending.get(reply.id);
          if (!request) return this.fail();
          this.pending.delete(reply.id);
          request.finish(reply.ok ? undefined : permissionError());
        } catch {
          return this.fail();
        }
      }
      if (!this.pending.size) this.keepAlive(false);
    });
    this.child.on("error", () => this.fail());
    this.child.on("exit", () => this.fail());
    this.child.stdin.on("error", () => this.fail());
    this.child.stdout.on("error", () => this.fail());
    this.child.stderr.on("error", () => this.fail());
  }

  private keepAlive(active: boolean): void {
    if (active) this.child.ref();
    else this.child.unref();
    // Child-process pipes are Node sockets on Windows. Idle workers must not keep
    // a CLI/test alive; parent exit closes stdin and the worker exits on EOF.
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      const socket = stream as Socket;
      if (active) socket.ref();
      else socket.unref();
    }
  }

  private fail(): void {
    if (this.closed) return;
    this.closed = true;
    if (worker === this) worker = undefined;
    this.child.kill();
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    for (const request of this.pending.values()) request.finish(permissionError());
    this.pending.clear();
  }

  check(path: string, createAcl: boolean): Promise<void> {
    if (this.closed || this.pending.size >= 128) return Promise.reject(permissionError());
    const id = ++this.sequence;
    const input = JSON.stringify({ id, path, createAcl }) + "\n";
    if (input.length > 65536) return Promise.reject(permissionError());
    this.keepAlive(true);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(), 10000);
      this.pending.set(id, {
        finish(error) {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        },
      });
      this.child.stdin.write(input);
    });
  }
}

let worker: PermissionWorker | undefined;
/** Real-time Windows DACL validation; requests are data, never interpolated code. */
export function windowsPrivatePath(path: string, createAcl = false): Promise<void> {
  worker ??= new PermissionWorker();
  return worker.check(path, createAcl);
}
