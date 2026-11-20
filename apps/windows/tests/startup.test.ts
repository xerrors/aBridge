import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
test("startup confirmation is independent of device state and does not change saved data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abridge-startup-"));
  try {
    // Broken binding data must not prevent confirming a working App/runtime installation.
    await writeFile(join(dir, "config.json"), "invalid config fixture", { mode: 0o600 });
    for (const error of [
      "",
      "Server connection unavailable",
      "Device credential revoked; bind this device again",
    ]) {
      const status = JSON.stringify({ connection: "offline", error });
      await writeFile(join(dir, "status.json"), status, { mode: 0o600 });
      const result = await exec(process.execPath, [
        "--import",
        "tsx",
        "apps/windows/src/cli.ts",
        "--state-dir",
        dir,
        "startup-check",
      ]);
      assert.deepEqual(JSON.parse(result.stdout), { ready: true });
      assert.equal(await readFile(join(dir, "status.json"), "utf8"), status);
      assert.equal(await readFile(join(dir, "config.json"), "utf8"), "invalid config fixture");
      assert.deepEqual((await readdir(dir)).sort(), ["config.json", "status.json"]);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
