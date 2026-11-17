/** Exercise the candidate through npm, outside the workspace and without a populated cache. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function checkInstalledPackage(tarball: string, name: string, version: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "abridge-consumer-"));
  const failures: unknown[] = [];
  // Do not inherit real service configuration, Node loaders or npm credentials/configuration.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|TEMP|TMP|TMPDIR)$/i.test(key)),
  );
  try {
    await writeFile(join(directory, "package.json"), '{"private":true}\n');
    await writeFile(join(directory, "user.npmrc"), "");
    await writeFile(join(directory, "global.npmrc"), "");
    const install = spawnSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      [
        "install",
        tarball,
        "--prefix",
        directory,
        "--cache",
        join(directory, "cache"),
        "--userconfig",
        join(directory, "user.npmrc"),
        "--globalconfig",
        join(directory, "global.npmrc"),
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-save",
      ],
      { cwd: directory, env, encoding: "utf8", timeout: 60000 },
    );
    assert.equal(
      install.status,
      0,
      `Candidate offline installation failed: ${install.error ?? install.stderr}`,
    );
    const cli = join(directory, "node_modules", name, "cli.js");
    const executable = join(directory, "node_modules/.bin/abridge");
    const installedVersion = spawnSync(process.execPath, [executable, "--version"], {
      cwd: directory,
      env,
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(installedVersion.status, 0, installedVersion.stderr);
    assert.equal(installedVersion.stdout.trim(), version);

    // Import relative to the installed package so the repository cannot supply a missing WASM asset.
    const runtimeCheck = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      const require = createRequire(${JSON.stringify(cli)});
      const { getQuickJS } = require('quickjs-emscripten');
      const vm = (await getQuickJS()).newContext();
      try {
        const value = vm.unwrapResult(vm.evalCode('6 * 7'));
        try { assert.equal(vm.dump(value), 42); } finally { value.dispose(); }
      } finally { vm.dispose(); }
    `,
      ],
      { cwd: directory, env, encoding: "utf8", timeout: 15000 },
    );
    assert.equal(
      runtimeCheck.status,
      0,
      `Installed QuickJS/WASM failed: ${runtimeCheck.error ?? runtimeCheck.stderr}`,
    );

    await checkInstalledServer(executable, directory, version, env);
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Installed package verification and cleanup failed", {
      cause: failures[0],
    });
}

/** Verify the installed CLI's public HTTP behavior; fixtures exercise failure and shutdown paths. */
export async function checkInstalledServer(
  executable: string,
  directory: string,
  version: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    const child = spawn(
      process.execPath,
      [executable, "--host", "127.0.0.1", "--port", "0", "--data-dir", join(directory, "state")],
      {
        cwd: directory,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    let stdout = "",
      stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-20000);
    });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Installed CLI startup timed out: ${stderr}`)),
          10000,
        );
        const finish = (error?: Error, address?: string) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve(address!);
        };
        child.once("error", (error) => finish(error));
        child.once("exit", (code) => finish(new Error(`Installed CLI exited ${code}: ${stderr}`)));
        child.stdout.on("data", (chunk) => {
          stdout = (stdout + String(chunk)).slice(-20000);
          const match = stdout.match(/aBridge [^:]+: (http:\/\/127\.0\.0\.1:\d+)/);
          if (match) finish(undefined, match[1]);
        });
      });
      const health = await fetch(url + "/health", { signal: AbortSignal.timeout(5000) });
      assert.equal(health.status, 200);
      assert.equal(((await health.json()) as { version: string }).version, version);
      const page = await fetch(url + "/", { signal: AbortSignal.timeout(5000) });
      assert.equal(page.status, 200);
      assert.match(await page.text(), /\/static\/app\.js/);
      const script = await fetch(url + "/static/app.js", { signal: AbortSignal.timeout(5000) });
      assert.equal(script.status, 200);
      assert.ok((await script.text()).length > 0);
    } catch (error) {
      failures.push(error);
    } finally {
      if (child.pid) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        try {
          assert.equal(await exited, 0, `Installed CLI shutdown failed: ${stderr}`);
        } finally {
          clearTimeout(timer);
        }
      }
    }
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Installed server verification and shutdown failed", {
      cause: failures[0],
    });
}
