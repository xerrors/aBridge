import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { normalizeDeviceServer } from "@abridge/protocol";
import { configureClient } from "../src/runtime.js";
import { loadConfig, loadCredential } from "../src/storage.js";

test(
  "Windows authorization cancels when its monitored parent dies while stdin remains open",
  {
    skip: process.platform !== "win32",
    timeout: 15000,
  },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "abridge-auth-parent-"));
    const parent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await once(parent, "spawn");
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "apps/windows/src/cli.ts", "--state-dir", dir, "authorize", "--stdin"],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, ABRIDGE_PARENT_PID: String(parent.pid) },
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.resume();
    const exited = once(child, "exit", { signal: AbortSignal.timeout(10000) });
    try {
      await delay(1500);
      assert.equal(child.exitCode, null, "A live monitored parent must keep authorization pending");
      const parentExited = once(parent, "exit");
      parent.kill();
      await parentExited;
      assert.equal(child.stdin.destroyed, false, "Parent liveness, not stdin EOF, must trigger cancellation");
      assert.equal((await exited)[0], 1);
      assert.equal(JSON.parse(output.trim()).event, "error");
      assert.deepEqual(await readdir(dir), [], "Cancellation must not create binding state");
    } finally {
      child.stdin.end();
      if (child.exitCode === null) child.kill();
      if (parent.exitCode === null) parent.kill();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("HTTP consent is required, exact-origin bound, persisted, and cannot authorize another server", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abridge-http-consent-"));
  try {
    for (const value of ["http://192.0.2.1:8765", "http://[2001:db8::1]:8765"]) {
      assert.throws(() => normalizeDeviceServer(value), /确认/);
      assert.throws(() => normalizeDeviceServer(value, "http://other.example"), /确认/);
      assert.equal(normalizeDeviceServer(value, new URL(value).origin), value);
    }
    assert.equal(normalizeDeviceServer("http://localhost:8765/"), "http://localhost:8765");
    for (const value of [
      "file:///tmp/a",
      "https://user:secret@example.com",
      "https://example.com/?key=secret",
    ])
      assert.throws(() => normalizeDeviceServer(value));
    await configureClient(dir, { url: "https://previous.example", device_key: "abr_device_old" });
    await assert.rejects(
      configureClient(dir, { url: "http://192.0.2.1", device_key: "abr_device_new" }),
      /确认/,
    );
    assert.equal(await loadCredential(dir, "https://previous.example"), "abr_device_old");
    await configureClient(dir, {
      url: "http://192.0.2.1",
      device_key: "abr_device_new",
      http_confirmed_origin: "http://192.0.2.1",
    });
    assert.equal((await loadConfig(dir)).http_confirmed_origin, "http://192.0.2.1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("manual desktop binding verifies before committing; invalid or wrong-kind tokens preserve the old binding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abridge-token-bind-"));
  let kind = "computer",
    status = 200,
    requests = 0;
  const server = createServer((req, res) => {
    requests++;
    assert.equal(req.url, "/api/device");
    assert.equal(req.headers.authorization, "Bearer abr_device_new");
    res
      .writeHead(status, { "content-type": "application/json" })
      .end(JSON.stringify({ id: "fixture-device", name: "Fixture", kind, capabilities: ["shell"] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    for (const failure of ["invalid", "wrong-kind", "success"]) {
      await configureClient(dir, { url: "https://previous.example", device_key: "abr_device_old" });
      kind = failure === "wrong-kind" ? "browser" : "computer";
      status = failure === "invalid" ? 401 : 200;
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "apps/windows/src/cli.ts", "--state-dir", dir, "authorize", "--stdin"],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      const exited = once(child, "exit");
      const output = [];
      try {
        child.stdin.write(JSON.stringify({ url, device_key: "abr_device_new" }) + "\n");
        for await (const line of createInterface({ input: child.stdout })) {
          output.push(line);
          const event = JSON.parse(line);
          if (event.event === "ready") {
            assert.equal(failure, "success");
            assert.equal(await loadCredential(dir, "https://previous.example"), "abr_device_old");
            child.stdin.write(JSON.stringify({ command: "commit", capabilities: { shell: true } }) + "\n");
          } else if (event.event === "complete") child.stdin.end();
          else {
            assert.equal(event.event, "error");
            assert.notEqual(failure, "success");
          }
        }
        assert.equal((await exited)[0], failure === "success" ? 0 : 1);
        assert.ok(!output.join("").includes("abr_device_new"));
        assert.equal(
          await loadCredential(dir, failure === "success" ? url : "https://previous.example"),
          failure === "success" ? "abr_device_new" : "abr_device_old",
        );
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    }
    assert.equal(requests, 3);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
