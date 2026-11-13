import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import product from "../../../package.json" with { type: "json" };
const serverCli = resolve("dist/server/cli.js"),
  desktopCli = resolve("dist/desktop/cli.js");
function launch(args: string[], cwd: string): { child: ChildProcess; ready: Promise<string> } {
  const child = spawn(process.execPath, [serverCli, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "",
    stderr = "";
  const ready = new Promise<string>((ok, fail) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error("CLI startup deadline"));
    }, 10000);
    child.stdout!.on("data", (chunk) => {
      stdout += String(chunk);
      const match = stdout.match(/aBridge [^:]+: (http:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        ok(match[1]!);
      }
    });
    child.stderr!.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (!stdout.includes("aBridge ")) fail(new Error(`CLI exited ${code}: ${stderr}`));
    });
  });
  return { child, ready };
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const ended = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  const [code] = await ended;
  clearTimeout(timer);
  assert.equal(code, 0);
}
test("version and desktop status are pure commands, no default database or native loading", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abridge-cli-pure-"));
  try {
    const result = spawnSync(process.execPath, [serverCli, "--version"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, HOME: dir },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), product.version);
    assert.deepEqual(await readdir(dir), []);
    const status = spawnSync(process.execPath, [desktopCli, "--state-dir", join(dir, "desktop"), "status"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).connection, "offline");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("compiled CLI starts outside repository, serves bundled web and persists account across restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abridge-cli-runtime-")),
    db = join(dir, "state/server.db");
  let running: ChildProcess | undefined;
  try {
    const input = JSON.stringify({ username: "fixture-admin", password: "fixture-password-123!" });
    const created = spawnSync(process.execPath, [serverCli, "user", "create", "--stdin", "--db", db], {
      input,
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(created.status, 0, created.stderr);
    assert.equal(JSON.parse(created.stdout).username, "fixture-admin");
    for (let index = 0; index < 2; index++) {
      const task = launch(["--db", db, "--port", "0"], dir);
      running = task.child;
      const url = await task.ready;
      const health = await fetch(url + "/health");
      assert.equal(((await health.json()) as { version: string }).version, product.version);
      const page = await fetch(url + "/");
      assert.equal(page.status, 200);
      assert.match(await page.text(), /\/static\/app\.js/);
      const login = await fetch(url + "/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: input,
      });
      assert.equal(login.status, 200);
      await stop(running);
      running = undefined;
    }
  } finally {
    if (running) await stop(running);
    await rm(dir, { recursive: true, force: true });
  }
});
