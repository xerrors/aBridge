import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createConnection } from "node:net";
import {
  privateDirectory,
  writePrivateJson,
  readPrivateJson,
  saveCredential,
  loadCredential,
} from "../src/storage.js";
import { localControl, listenLocalControl, controlSocketPath } from "../src/local-control.js";
import { powershellPath } from "../src/windows-security.js";
import { windowsCommand } from "../src/windows-command.js";
import { LocalExecutor } from "../src/executor.js";
import { DeviceClient } from "../src/client.js";

const options = { skip: process.platform !== "win32" };
test(
  "Windows executor handles files, environment, timeout, cancellation and local shutdown",
  options,
  async () => {
    const root = await mkdtemp(join(tmpdir(), "abridge-executor-"));
    const executor = new LocalExecutor();
    try {
      const file = join(root, "中文 文件.txt");
      await executor.execute("write", "file_write", { path: file, content: "中文 😀" });
      assert.equal((await executor.execute("read", "file_read", { path: file })).content, "中文 😀");
      await assert.rejects(
        executor.execute("duplicate", "file_write", { path: file, content: "bad" }),
        /EEXIST/,
      );
      await executor.execute("replace", "file_write", { path: file, content: "x", overwrite: true });
      assert.equal(await readFile(file, "utf8"), "x");
      const listed = await executor.execute("list", "files_list", { path: root });
      assert.equal((listed.entries as { name: string }[])[0].name, "中文 文件.txt");
      await writeFile(file, Buffer.from([255]));
      await assert.rejects(executor.execute("invalid", "file_read", { path: file }), /UTF-8/);
      const output = await executor.execute("env", "command_execute", {
        command: "[Console]::Write($env:ABRIDGE_TEST_VALUE)",
        cwd: root,
        env: { ABRIDGE_TEST_VALUE: "中文 😀" },
      });
      assert.equal(output.timed_out, false, JSON.stringify(output));
      assert.equal(output.stdout, "中文 😀", JSON.stringify(output));
      assert.equal(output.exit_code, 0);
      const timeout = await executor.execute("timeout", "command_execute", {
        command: "Start-Sleep 60",
        timeout: 2,
      });
      assert.equal(timeout.timed_out, true);
      const controller = new AbortController();
      const running = executor.execute(
        "cancel",
        "command_execute",
        { command: "Start-Sleep 60" },
        undefined,
        controller.signal,
      );
      const timer = setTimeout(() => controller.abort(), 2000);
      await assert.rejects(running, /cancel|abort/i);
      clearTimeout(timer);
      const client = new DeviceClient({
        stateDir: root,
        config: { url: "http://127.0.0.1:1", capabilities: {}, paused: false },
        deviceKey: "abr_device_fixture",
        executor,
      });
      assert.deepEqual(await client.control({ command: "shutdown" }), { shutdown_requested: true });
    } finally {
      await executor.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  },
);
test(
  "Windows credentials retain private ACLs, Unicode paths, origin binding and atomic replacement",
  options,
  async () => {
    const root = await mkdtemp(join(tmpdir(), "abridge-win-"));
    const dir = join(root, "私有 状态");
    try {
      await mkdir(dir);
      // An existing user-owned D: workspace may grant Modify without WRITE_OWNER.
      // Its owner can still protect the DACL without attempting ownership changes.
      const modifyOnly = `
$ErrorActionPreference = 'Stop'
$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(dir).toString("base64")}'))
$item = Get-Item -LiteralPath $p
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier('S-1-5-18')), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
$item.SetAccessControl($acl)
`;
      await promisify(execFile)(
        powershellPath,
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(modifyOnly, "utf16le").toString("base64"),
        ],
        { windowsHide: true },
      );
      await privateDirectory(dir);
      await privateDirectory(dir, false);
      const file = join(dir, "配置.json");
      await writePrivateJson(file, { text: "中文 😀" });
      assert.deepEqual(await readPrivateJson(file), { text: "中文 😀" });
      await writePrivateJson(file, { replaced: true });
      assert.deepEqual(await readPrivateJson(file), { replaced: true });
      await saveCredential(dir, "http://127.0.0.1:8765", "abr_device_fixture");
      assert.equal(await loadCredential(dir, "http://127.0.0.1:8765"), "abr_device_fixture");
      await assert.rejects(loadCredential(dir, "http://127.0.0.1:9876"), /another server/);
      await writeFile(file, Buffer.alloc(50));
      await assert.rejects(readPrivateJson(file, 10), /too large/);
      const shared = join(root, "shared");
      await mkdir(shared);
      await assert.rejects(privateDirectory(shared, false), /private owner ACL/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("Windows local control authenticates before dispatch and enforces one listener", options, async () => {
  const root = await mkdtemp(join(tmpdir(), "abridge-control-"));
  let calls = 0;
  const server = await listenLocalControl(root, async (r) => {
    calls++;
    return { command: r.command };
  });
  try {
    const response = await localControl(root, { command: "status" });
    assert.equal(response.command, "status");
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(controlSocketPath(root));
      socket.once("connect", () => socket.write('{"command":"resume","_token":"wrong"}\n'));
      socket.once("data", (data) => {
        socket.destroy();
        resolve(data.toString());
      });
      socket.once("error", reject);
    });
    assert.equal(JSON.parse(raw).error.code, "control_unauthorized");
    assert.equal(calls, 1);
    const slashAlias = root.replaceAll("\\", "/") + "/.";
    assert.equal(controlSocketPath(root), controlSocketPath(slashAlias));
    assert.equal((await localControl(slashAlias, { command: "status" })).command, "status");
    assert.equal(calls, 2, "Both path spellings must reach the same authenticated listener");
    await assert.rejects(listenLocalControl(slashAlias, async () => ({})));
    assert.equal((await localControl(root, { command: "pause" })).command, "pause");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "Windows command preserves Unicode, stderr, explicit exits and kills detached descendants",
  options,
  async () => {
    const root = await mkdtemp(join(tmpdir(), "abridge-shell-"));
    try {
      const result = await promisify(execFile)(
        powershellPath,
        windowsCommand("[Console]::Write('中文 😀'); [Console]::Error.Write('错误')"),
        { windowsHide: true, timeout: 15000 },
      );
      assert.equal(result.stdout, "中文 😀");
      assert.equal(result.stderr, "错误");
      await assert.rejects(
        promisify(execFile)(powershellPath, windowsCommand("exit 7"), { windowsHide: true }),
        (e: unknown) => (e as { code: number }).code === 7,
      );
      const marker = join(root, "escaped.txt");
      const ready = join(root, "ready.txt");
      const childFile = join(root, "child.cjs");
      await writeFile(
        childFile,
        `require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'escaped'),3500)`,
      );
      const childCommand = `$child = Start-Process -WindowStyle Hidden -PassThru -FilePath '${process.execPath.replaceAll("'", "''")}' -ArgumentList '"${childFile.replaceAll("'", "''")}"'; for ($i=0; $i -lt 50 -and -not (Test-Path -LiteralPath '${ready.replaceAll("'", "''")}'); $i++) { Start-Sleep -Milliseconds 100 }; if (-not (Test-Path -LiteralPath '${ready.replaceAll("'", "''")}')) { throw 'Child did not start' }; [Console]::Write($child.Id)`;
      const launched = await promisify(execFile)(powershellPath, windowsCommand(childCommand), {
        windowsHide: true,
        timeout: 15000,
      });
      assert.equal(await readFile(ready, "utf8"), "ready");
      assert.ok(Number(launched.stdout) > 0);
      assert.throws(() => process.kill(Number(launched.stdout), 0), { code: "ESRCH" });
      await new Promise((resolve) => setTimeout(resolve, 4500));
      await assert.rejects(readFile(marker), { code: "ENOENT" });
      const shell = spawn(powershellPath, windowsCommand("Start-Sleep 60"), { windowsHide: true });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      shell.kill();
      await new Promise<void>((resolve) => shell.once("close", () => resolve()));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
