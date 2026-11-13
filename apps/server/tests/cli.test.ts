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
function launch(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): { child: ChildProcess; ready: Promise<{ url: string; adminUrl: string }> } {
  const child = spawn(process.execPath, [serverCli, ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ABRIDGE_ADMIN_TOKEN: undefined, ...env },
  });
  let stdout = "",
    stderr = "";
  const ready = new Promise<{ url: string; adminUrl: string }>((ok, fail) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error("CLI startup deadline"));
    }, 10000);
    child.stdout!.on("data", (chunk) => {
      stdout += String(chunk);
      const match = stdout.match(/aBridge [^:]+: (http:\/\/[^\s]+)/);
      const admin = stdout.match(/Admin console: (https?:\/\/[^\s]+)\n/);
      if (match && admin) {
        clearTimeout(timer);
        ok({ url: match[1]!, adminUrl: admin[1]! });
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
    let savedToken: string | null = null;
    for (let index = 0; index < 2; index++) {
      const task = launch(["--db", db, "--port", "0"], dir);
      running = task.child;
      const { url, adminUrl } = await task.ready;
      const token = new URLSearchParams(new URL(adminUrl).hash.slice(1)).get("admin_token");
      assert.ok(token);
      if (savedToken) assert.equal(token, savedToken);
      savedToken = token;
      if (index === 0) {
        const created = await fetch(url + "/api/admin/users", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + token },
          body: input,
        });
        assert.equal(created.status, 201);
        assert.equal(((await created.json()) as { username: string }).username, "fixture-admin");
      }
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

test("compiled CLI honors administrator env token, prints public links and removes user creation command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abridge-cli-admin-env-"));
  let running: ChildProcess | undefined;
  try {
    const token = "fixture-cli-admin-environment-token-123456789";
    const task = launch(
      ["--data-dir", dir, "--port", "0", "--public-origin", "https://bridge.example.com"],
      dir,
      { ABRIDGE_ADMIN_TOKEN: token },
    );
    running = task.child;
    const { url, adminUrl } = await task.ready;
    assert.equal(new URL(adminUrl).origin, "https://bridge.example.com");
    assert.equal(new URLSearchParams(new URL(adminUrl).hash.slice(1)).get("admin_token"), token);
    const created = await fetch(url + "/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({ username: "external-api", password: "fixture-password-1234" }),
    });
    assert.equal(created.status, 201);
    await stop(running);
    running = undefined;
    const removed = spawnSync(process.execPath, [serverCli, "user", "create"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.notEqual(removed.status, 0);
    const help = spawnSync(process.execPath, [serverCli, "--help"], { cwd: dir, encoding: "utf8" });
    assert.equal(help.status, 0);
    assert.equal(help.stdout.includes("user create"), false);
    assert.match(help.stdout, /--reset-admin-token/);
  } finally {
    if (running) await stop(running);
    await rm(dir, { recursive: true, force: true });
  }
});
