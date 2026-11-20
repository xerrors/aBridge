import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, type ChildProcess } from "node:child_process";
import {
  spawnVerificationProcess,
  stopVerificationProcess,
} from "../../../tools/lib/verification-process.js";
import { once } from "node:events";
import product from "../../../package.json" with { type: "json" };
const serverCli = resolve("dist/server/cli.js");
function launch(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): { child: ChildProcess; ready: Promise<{ url: string; adminUrl: string }> } {
  const child = spawnVerificationProcess([serverCli, ...args], {
    cwd,
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
      fail(new Error(`CLI exited ${code}: ${stderr}`));
    });
  });
  return { child, ready };
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, "exit");
  await stopVerificationProcess(child);
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  const [code] = await ended;
  clearTimeout(timer);
  assert.equal(code, 0);
}
test("version is a pure command without default database initialization", async () => {
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
      assert.equal(new URL(adminUrl).hash, "", "startup never prints administrator credentials");
      const token = (await readFile(db + ".admin-token", "utf8")).trim();
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
    assert.equal(new URL(adminUrl).hash, "", "environment administrator token is not logged");
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
    const invalidDelegation = spawnSync(process.execPath, [serverCli, "--data-dir", dir, "--port", "0"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, ABRIDGE_DELEGATION_ENABLED: "tru" },
    });
    assert.notEqual(invalidDelegation.status, 0);
    assert.match(invalidDelegation.stderr, /ABRIDGE_DELEGATION_ENABLED must be true or false/);
  } finally {
    if (running) await stop(running);
    await rm(dir, { recursive: true, force: true });
  }
});

test("public HTTP OIDC opt-in works through CLI or environment and defaults to disabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abridge-cli-http-"));
  const env = {
    ABRIDGE_PUBLIC_ORIGIN: "http://bridge.example:8765",
    ABRIDGE_OIDC_ISSUER_URL: "https://identity.example",
    ABRIDGE_OIDC_CLIENT_ID: "fixture",
    ABRIDGE_OIDC_CLIENT_SECRET: "fixture-secret",
    ABRIDGE_ALLOW_INSECURE_HTTP: "false",
  };
  let running: ChildProcess | undefined;
  try {
    const disabled = spawnSync(process.execPath, [serverCli, "--data-dir", dir, "--port", "0"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    assert.notEqual(disabled.status, 0);
    assert.match(disabled.stderr, /public origin requires HTTPS/);
    for (const cli of [true, false]) {
      const args = ["--data-dir", dir, "--port", "0"];
      if (cli) args.push("--allow-insecure-http");
      const task = launch(args, dir, { ...env, ABRIDGE_ALLOW_INSECURE_HTTP: cli ? "false" : "true" });
      running = task.child;
      const { url, adminUrl } = await task.ready;
      assert.equal(adminUrl, env.ABRIDGE_PUBLIC_ORIGIN);
      const script = await fetch(url + "/static/app.js", { headers: { Origin: env.ABRIDGE_PUBLIC_ORIGIN } });
      assert.equal(script.status, 200);
      await script.arrayBuffer();
      const auth = await fetch(url + "/api/auth/oidc/config");
      assert.equal(auth.status, 200);
      assert.equal(((await auth.json()) as { enabled: boolean }).enabled, true);
      await stop(running);
      running = undefined;
    }
    const invalid = spawnSync(process.execPath, [serverCli, "--data-dir", dir, "--port", "0"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, ...env, ABRIDGE_ALLOW_INSECURE_HTTP: "yes" },
    });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /ABRIDGE_ALLOW_INSECURE_HTTP must be true or false/);
  } finally {
    if (running) await stop(running);
    await rm(dir, { recursive: true, force: true });
  }
});
