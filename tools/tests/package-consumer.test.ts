import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { checkInstalledServer } from "../lib/check-installed-package.js";

const fixture = fileURLToPath(new URL("../fixtures/package-server.js", import.meta.url));
// Only the checker's process/error handling is under test here. package:check consumes the real tarball.
for (const scenario of [
  { name: "accepts a working server", health: 200, script: 200, exit: 0 },
  { name: "rejects missing static assets", health: 200, script: 404, exit: 0 },
  { name: "preserves HTTP failure when shutdown also fails", health: 500, script: 200, exit: 7 },
  {
    name: "rejects an abnormal exit after a successful response",
    health: 200,
    script: 200,
    exit: 7,
    earlyExit: true,
  },
]) {
  test(`package consumer ${scenario.name}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "abridge-package-test-"));
    try {
      await writeFile(join(directory, "fixture.json"), JSON.stringify(scenario));
      if (scenario.earlyExit) {
        const fetch = globalThis.fetch;
        t.mock.method(globalThis, "fetch", async (...args: Parameters<typeof fetch>) => {
          const response = await fetch(...args);
          // Keep real HTTP data, but let the child exit before the final response reaches the checker.
          if (String(args[0]).endsWith("/static/app.js")) await sleep(100);
          return response;
        });
      }
      const verification = checkInstalledServer(fixture, directory, "0.0.0", {});
      if (scenario.health === 500) {
        await assert.rejects(verification, (error: unknown) => {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.errors.length, 2);
          assert.equal(error.cause, error.errors[0]);
          assert.ok(error.errors[0] instanceof assert.AssertionError);
          assert.equal(error.errors[0].actual, 500);
          assert.ok(error.errors[1] instanceof assert.AssertionError);
          assert.equal(error.errors[1].actual, 7);
          return true;
        });
      } else if (scenario.earlyExit) {
        await assert.rejects(verification, (error: unknown) => {
          assert.ok(error instanceof assert.AssertionError);
          assert.equal(error.actual, 7);
          assert.match(error.message, /fatal after response/);
          return true;
        });
      } else if (scenario.script === 404) {
        await assert.rejects(verification, (error: unknown) => {
          assert.ok(error instanceof assert.AssertionError);
          assert.equal(error.actual, 404);
          return true;
        });
      } else {
        await verification;
      }
      assert.equal(await readFile(join(directory, "stopped"), "utf8"), "yes");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
