import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configureClient } from "../src/runtime.js";
import { LocalExecutor } from "../src/executor.js";
import { CuaNativeDriver } from "../src/native.js";

test("independent: selecting only Shell never enables other local capabilities", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abridge-independent-binding-"));
  try {
    const config = await configureClient(dir, {
      url: "http://localhost:8765",
      device_key: "abr_device_fixture",
      capabilities: { shell: true },
    });
    assert.deepEqual(config.capabilities, { screen: false, input: false, shell: true, files: false });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("independent: missing read and missing cwd have definite failure contracts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abridge-independent-errors-"));
  const executor = new LocalExecutor(); // Native driver remains lazy and unused.
  try {
    await assert.rejects(executor.execute("fixture", "file_read", { path: join(dir, "missing") }), {
      code: "execution_failed",
    });
    await assert.rejects(
      executor.execute("fixture", "command_execute", {
        command: "echo must-not-run",
        cwd: join(dir, "missing"),
      }),
      { code: "invalid_cwd" },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("independent: typed native refusal keeps error code without OS input", async () => {
  const sdk = await import("@trycua/cua-driver");
  const native = new CuaNativeDriver();
  const driver = {
    async click() {
      throw sdk.DriverError.Tool.new({
        tool: "click",
        message: "sensitive native detail",
        errorCode: "action_refused",
      });
    },
  };
  Object.assign(native, { sdk, driver, sessions: new Map([["fixture", Promise.resolve()]]) });
  await assert.rejects(
    native.act("fixture", { action: "click", target: { pid: 1, window_id: 1 }, native_ref: "synthetic" }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "action_refused" &&
      !error.message.includes("sensitive native detail"),
  );
});

test("independent: final offline status never initializes a driver after shutdown", async () => {
  const { DeviceClient } = await import("../src/client.js");
  const { localControl } = await import("../src/local-control.js");
  const { setTimeout: delay } = await import("node:timers/promises");
  const dir = await mkdtemp(join(tmpdir(), "abridge-independent-shutdown-"));
  let closed = false,
    diagnosticsAfterShutdown = 0;
  const native = {
    async diagnostics() {
      if (closed) diagnosticsAfterShutdown++;
      return { driver: { ready: false }, permissions: { screen: false, input: false } };
    },
    async shutdown() {
      closed = true;
    },
    async release() {},
  };
  const executor = new LocalExecutor(native as never);
  const client = new DeviceClient({
    stateDir: dir,
    deviceKey: "abr_device_fixture",
    config: {
      url: "http://localhost:1",
      capabilities: { screen: false, input: false, shell: false, files: false },
      paused: false,
      revoked: true,
    },
    executor,
  });
  const run = client.run();
  try {
    let connected = false;
    for (let n = 0; n < 100 && !connected; n++) {
      try {
        await localControl(dir, { command: "status" });
        connected = true;
      } catch {
        await delay(5);
      }
    }
    assert.equal(connected, true);
    await client.stop();
    await run;
    assert.equal(closed, true);
    assert.equal(diagnosticsAfterShutdown, 0, "shutdown must be the last native lifecycle operation");
  } finally {
    await client.stop();
    await run;
    await rm(dir, { recursive: true, force: true });
  }
});

test("independent: dispatch expires while native capability diagnostics are pending", async () => {
  const { DeviceClient } = await import("../src/client.js");
  const { OperationJournal } = await import("../src/storage.js");
  const { setTimeout: delay } = await import("node:timers/promises");
  const { access } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "abridge-independent-deadline-"));
  let release!: () => void, entered!: () => void;
  const reached = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  const native = {
    async diagnostics() {
      entered();
      await gate;
      return { driver: { ready: true }, permissions: { screen: true, input: true } };
    },
  };
  const executor = new LocalExecutor(native as never);
  const config = {
    url: "http://localhost:1",
    paused: false,
    capabilities: { screen: true, input: false, shell: false, files: true },
  };
  const client = new DeviceClient({ stateDir: dir, deviceKey: "abr_device_fixture", config, executor });
  const journal = new OperationJournal(join(dir, "journal.db"));
  const messages: Record<string, unknown>[] = [];
  const socket = {
    readyState: 1,
    send(value: string, callback: () => void) {
      messages.push(JSON.parse(value));
      callback();
    },
    terminate() {},
  };
  Object.assign(client, {
    journal,
    socket,
    epoch: 1,
    deviceId: "dev_fixture",
    lastAck: performance.now(),
    serverCapabilities: new Set(["files", "screen"]),
  });
  try {
    const dispatch = client.dispatch({
      type: "dispatch",
      protocol: "abridge/1",
      device_id: "dev_fixture",
      connection_epoch: 1,
      sequence: 1,
      grant_version: 1,
      session_capabilities: ["files"],
      operation_id: "expires",
      session_id: "fixture",
      tool: "file_write",
      arguments: { path: join(dir, "must-not-exist"), content: "bad" },
      expires_at: Date.now() / 1000 + 0.03,
    });
    await reached;
    await delay(50);
    release();
    await dispatch;
    await delay(10);
    await assert.rejects(access(join(dir, "must-not-exist")), { code: "ENOENT" });
    assert.equal(
      (messages.find((m) => m.type === "result")?.error as { code: string })?.code,
      "dispatch_expired",
    );
  } finally {
    release();
    await client.stopOperations();
    journal.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("independent: an invalid screenshot frame never enables pixel input", async () => {
  const { Computer } = await import("../src/computer.js");
  let actions = 0;
  const native = {
    async observe() {
      return {
        elements: [],
        image_base64: "aGk=",
        mime_type: "image/png",
        width: 100,
        height: 100,
        frame_valid: false,
      };
    },
    async act() {
      actions++;
      return {};
    },
  };
  const computer = new Computer(native as never);
  const observed = await computer.observe("fixture", { pid: 1, window_id: 1, screenshot: true });
  assert.equal(observed.pixel_actions, false);
  await assert.rejects(
    computer.act("fixture", {
      observation_id: observed.observation_id,
      action: { type: "click", x: 10, y: 10 },
      observe_after: false,
    }),
    { code: "screenshot_required" },
  );
  assert.equal(actions, 0);
});

test("shutdown while the SDK loader is pending prevents native construction", async () => {
  const native = new CuaNativeDriver();
  let release!: (sdk: unknown) => void;
  const loaded = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  let constructed = 0;
  Object.assign(native, { loadSdk: () => loaded });
  const pending = native.apps();
  await native.shutdown(); // Shutdown does not wait for an unbounded module loader.
  release({
    CuaDriver: {
      createConfiguredWithAuthorizationHost() {
        constructed++;
        throw Error("A closed driver must not construct");
      },
    },
  });
  await assert.rejects(pending, { code: "driver_closed" });
  assert.equal(constructed, 0);
  assert.equal(((await native.diagnostics(false)).driver as Record<string, unknown>).ready, false);
});

test("journal startup failure releases the local control listener", async () => {
  const { mkdir } = await import("node:fs/promises");
  const { DeviceClient } = await import("../src/client.js");
  const { listenLocalControl } = await import("../src/local-control.js");
  const dir = await mkdtemp(join(tmpdir(), "abridge-startup-cleanup-"));
  try {
    await mkdir(join(dir, "operations.sqlite3"));
    const client = new DeviceClient({
      stateDir: dir,
      deviceKey: "abr_device_fixture",
      config: { url: "http://localhost:1", capabilities: {}, paused: false },
    });
    await assert.rejects(client.run());
    const listener = await listenLocalControl(dir, async () => ({}));
    await listener.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
