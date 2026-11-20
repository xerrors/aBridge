import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { createInterface } from "node:readline";
import { powershellPath, windowsPrivatePath } from "../src/windows-security.js";

const options = { skip: process.platform !== "win32", timeout: 30000 };
async function powershell(script: string): Promise<string> {
  return (
    await promisify(execFile)(
      powershellPath,
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { windowsHide: true, timeout: 10000 },
    )
  ).stdout.trim();
}
async function workers(parent: number): Promise<number[]> {
  const output =
    await powershell(`$ids=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${parent} AND Name='powershell.exe'" | Where-Object {
    $_.ProcessId -ne $PID -and $_.CommandLine -match '-EncodedCommand' -and
    [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String(($_.CommandLine -split ' ')[-1])).Contains('function Check-PrivatePath')
  } | ForEach-Object {[int]$_.ProcessId}); ConvertTo-Json -InputObject $ids -Compress`);
  return JSON.parse(output) as number[];
}
async function gone(pid: number): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await delay(50);
  }
  assert.fail(`Fixture helper ${pid} survived its parent`);
}

test(
  "Windows ACL worker reuses process, isolates data and immediately detects widened ACL",
  options,
  async () => {
    const root = await mkdtemp(join(tmpdir(), "abridge-acl-"));
    const dir = join(root, "中文 ' $变量 😀");
    const marker = join(root, "must-not-exist");
    await mkdir(dir);
    try {
      await windowsPrivatePath(dir, true);
      const before = await workers(process.pid);
      assert.equal(before.length, 1);
      const invalid = `${dir}\"; [IO.File]::WriteAllText('${marker.replaceAll("'", "''")}','injected')\n#`;
      const results = await Promise.allSettled(
        Array.from({ length: 24 }, (_, i) => windowsPrivatePath(i % 3 === 0 ? invalid : dir)),
      );
      results.forEach((result, i) => assert.equal(result.status, i % 3 === 0 ? "rejected" : "fulfilled"));
      await assert.rejects(access(marker), { code: "ENOENT" });
      assert.deepEqual(await workers(process.pid), before, "requests reuse the same helper");
      const encoded = Buffer.from(dir).toString("base64");
      await powershell(`$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))
      $item=Get-Item -LiteralPath $p; $acl=$item.GetAccessControl()
      $rule=New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier('S-1-1-0')),'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow')
      $acl.AddAccessRule($rule); $item.SetAccessControl($acl)`);
      await assert.rejects(windowsPrivatePath(dir), { code: "credential_permissions" });
      await windowsPrivatePath(dir, true);
      await windowsPrivatePath(dir);
      assert.deepEqual(
        await workers(process.pid),
        before,
        "a denied check does not poison subsequent requests",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("Windows ACL worker recovers after loss and exits with normal or terminated CLI", options, async () => {
  const root = await mkdtemp(join(tmpdir(), "abridge-acl-lifecycle-"));
  try {
    for (const abrupt of [false, true]) {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `
        import {createInterface} from 'node:readline';
        import {windowsPrivatePath} from ${JSON.stringify(new URL("../src/windows-security.ts", import.meta.url).href)};
        const lines=createInterface({input:process.stdin});
        for await(const line of lines){
          const request=JSON.parse(line);
          await windowsPrivatePath(request.path,request.create);
          console.log(JSON.stringify({id:request.id,ok:true}));
        }
      `,
        ],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
      child.stderr.resume();
      const lines = createInterface({ input: child.stdout });
      const replies: string[] = [];
      lines.on("line", (line) => replies.push(line));
      const exit = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", () => resolve());
      });
      let helper: number | undefined;
      try {
        const check = async (id: number, create = false) => {
          child.stdin.write(JSON.stringify({ id, path: root, create }) + "\n");
          for (let i = 0; i < 100 && replies.length < id; i++) await delay(50);
          assert.equal(replies.length, id, "exactly one completion per submitted check");
          assert.deepEqual(JSON.parse(replies[id - 1]), { id, ok: true });
        };
        await check(1, true);
        const first = await workers(child.pid!);
        assert.equal(first.length, 1);
        helper = first[0];
        process.kill(helper); // Only the helper proven to belong to this fixture child.
        await gone(helper);
        await delay(100);
        await check(2);
        const second = await workers(child.pid!);
        assert.equal(second.length, 1);
        helper = second[0];
        assert.notEqual(helper, first[0]);
        if (abrupt) child.kill();
        else child.stdin.end();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            exit,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(Error("ACL worker kept fixture CLI alive")), 4000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        await gone(helper);
        assert.equal(replies.length, 2, "helper recovery never replays a prior request");
      } finally {
        child.kill();
        await exit;
        lines.close();
        if (helper && (await workers(child.pid!)).includes(helper)) process.kill(helper);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
