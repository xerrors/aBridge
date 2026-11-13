import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer, type WebSocket } from "ws";
import { Computer } from "../src/computer.js";
import { DesktopError } from "../src/errors.js";
import {
  CuaNativeDriver,
  type NativeDriver,
  type NativeAction,
  type NativeObservation,
} from "../src/native.js";
import { LocalExecutor } from "../src/executor.js";
import { DeviceClient } from "../src/client.js";
import { configureClient } from "../src/runtime.js";
import { localControl } from "../src/local-control.js";
import { OperationJournal, loadCredential } from "../src/storage.js";
const directory = () => mkdtemp(join(tmpdir(), "abridge-desktop-"));
class Native implements NativeDriver {
  actions: NativeAction[] = [];
  released: string[] = [];
  observations: NativeObservation = {
    elements: [
      { token: "native-secret-reference", role: "AXButton", label: "Continue", depth: 1 },
      {
        token: "password-ref",
        role: "AXSecureTextField",
        label: "Password",
        value: "protected-value",
        depth: 1,
      },
    ],
    image_base64: Buffer.from("image").toString("base64"),
    mime_type: "image/png",
    width: 100,
    height: 80,
  };
  async diagnostics() {
    return {
      driver: { installed: true, ready: true },
      permissions: { checked: true, screen: true, input: true },
    };
  }
  async apps() {
    return [{ pid: 10, name: "Fixture", bundle_id: "dev.abridge.fixture", running: true, active: true }];
  }
  async windows() {
    return [
      {
        pid: 10,
        window_id: 20,
        app_name: "Fixture",
        title: "Fixture",
        bounds: { x: 0, y: 0, width: 100, height: 80 },
        layer: 0,
        z_index: 1,
        is_on_screen: true,
      },
    ];
  }
  async open() {}
  async observe() {
    return structuredClone(this.observations);
  }
  async act(_id: string, action: NativeAction) {
    this.actions.push(action);
    return { action_executed: true, business_verified: false };
  }
  async release(id: string) {
    this.released.push(id);
  }
  async shutdown() {}
}
test("files use exclusive writes, strict UTF8 and sorted truncated listings", async () => {
  const dir = await directory();
  try {
    const executor = new LocalExecutor(new Native());
    await executor.fileWrite({ path: join(dir, "b"), content: "😀 中文" });
    await executor.fileWrite({ path: join(dir, "a"), content: "a" });
    assert.equal((await executor.fileRead({ path: join(dir, "b") })).content, "😀 中文");
    await assert.rejects(executor.fileWrite({ path: join(dir, "b"), content: "bad" }), {
      code: "EEXIST",
    });
    await writeFile(join(dir, "binary"), Buffer.from([0xff]));
    await assert.rejects(executor.fileRead({ path: join(dir, "binary") }), {
      code: "unsupported_encoding",
    });
    const list = await executor.filesList({ path: dir, limit: 2 });
    assert.equal(list.truncated, true);
    const names = (list.entries as { name: string }[]).map((e) => e.name);
    assert.deepEqual(names, [...names].sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("Shell captures unicode output directly, strips unrequested env and bounds both streams", async () => {
  const executor = new LocalExecutor(new Native());
  process.env.ABRIDGE_PRIVATE_FIXTURE = "must-not-inherit";
  const result = await executor.commandExecute("shell", {
    command: "printf '😀 中文'; printf error >&2; printf \"${ABRIDGE_PRIVATE_FIXTURE-unset}\"",
  });
  assert.equal(result.stdout, "😀 中文unset");
  assert.equal(result.stderr, "error");
  assert.equal(result.exit_code, 0);
  const large = await executor.commandExecute("large", {
    command: "node -e \"process.stdout.write('x'.repeat(140000)); process.stderr.write('y'.repeat(140000))\"",
  });
  assert.equal((large.stdout as string).length, 131072);
  assert.equal((large.stderr as string).length, 131072);
  assert.equal(large.truncated, true);
  delete process.env.ABRIDGE_PRIVATE_FIXTURE;
});
test("Shell timeout and cancellation reap descendant process groups", async () => {
  const executor = new LocalExecutor(new Native());
  const timeout = await executor.commandExecute("timeout", { command: "sleep 30 & wait", timeout: 1 });
  assert.equal(timeout.timed_out, true);
  const controller = new AbortController();
  const command = executor.commandExecute("cancel", { command: "sleep 30 & wait" }, controller.signal);
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(command, { name: "AbortError" });
});
test("credential binding is private, rejects symlinks and does not resume a paused device", async () => {
  const dir = await directory();
  try {
    await configureClient(dir, { url: "http://localhost:8765", device_key: "abr_device_fixture" });
    assert.equal(await loadCredential(dir, "http://localhost:8765"), "abr_device_fixture");
    assert.equal((await stat(join(dir, "credentials", "device.json"))).mode & 0o777, 0o600);
    await assert.rejects(loadCredential(dir, "https://other.example"), { code: "credential_mismatch" });
    const config = JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
    config.paused = true;
    config.pause_reason = "manual";
    await writeFile(join(dir, "config.json"), JSON.stringify(config), { mode: 0o600 });
    assert.equal(
      (await configureClient(dir, { url: config.url, device_key: "abr_device_rebound" })).paused,
      true,
    );
    await rm(join(dir, "credentials", "device.json"));
    await writeFile(join(dir, "secret"), "{}", { mode: 0o600 });
    await symlink(join(dir, "secret"), join(dir, "credentials", "device.json"));
    await assert.rejects(loadCredential(dir, config.url));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("journal persists only intent metadata and recovers interrupted effects without replay", async () => {
  const dir = await directory();
  try {
    const file = join(dir, "operations.sqlite3");
    const first = new OperationJournal(file);
    first.start("one", "hash-only");
    first.close();
    const recovered = new OperationJournal(file);
    assert.deepEqual({ ...recovered.get("one") }, { request_hash: "hash-only", status: "outcome_unknown" });
    recovered.finish("one", "executed");
    assert.equal(recovered.get("one")?.status, "executed");
    recovered.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("protected values cannot match query and native tokens never leave desktop", async () => {
  const native = new Native(),
    computer = new Computer(native);
  const hidden = await computer.observe("session", { pid: 10, window_id: 20, query: "protected-value" });
  assert.deepEqual(hidden.elements, []);
  const result = await computer.observe("session", { pid: 10, window_id: 20 });
  assert.ok(!JSON.stringify(result).includes("native-secret-reference"));
  assert.ok(!JSON.stringify(result).includes("protected-value"));
  assert.equal(result.pixel_actions, true);
});
test("correctable action errors preserve observation, native dispatch consumes it", async () => {
  const native = new Native(),
    computer = new Computer(native);
  const first = await computer.observe("one", { pid: 10, window_id: 20 });
  const obs = first.observation_id;
  await assert.rejects(
    computer.act("one", {
      observation_id: obs,
      action: { type: "click", x: 999, y: 2 },
      observe_after: false,
    }),
    { code: "invalid_arguments" },
  );
  await computer.act("one", {
    observation_id: obs,
    action: { type: "click", element_ref: "e1" },
    observe_after: false,
  });
  assert.equal(native.actions[0].native_ref, "native-secret-reference");
  await assert.rejects(
    computer.act("one", {
      observation_id: obs,
      action: { type: "click", element_ref: "e1" },
      observe_after: false,
    }),
    { code: "stale_observation" },
  );
});
test("observation TTL, session boundaries and close scopes are enforced", async () => {
  let now = 0;
  const native = new Native(),
    computer = new Computer(native, () => now);
  const a = await computer.observe("a", { pid: 10, window_id: 20 });
  const b = await computer.observe("b", { pid: 10, window_id: 20 });
  await assert.rejects(
    computer.act("b", {
      observation_id: a.observation_id,
      action: { type: "key", key: "Enter" },
      observe_after: false,
    }),
    { code: "stale_observation" },
  );
  await computer.closeSession("a");
  await computer.act("b", {
    observation_id: b.observation_id,
    action: { type: "key", key: "Enter" },
    observe_after: false,
  });
  const next = await computer.observe("b", { pid: 10, window_id: 20 });
  now = 120001;
  await assert.rejects(
    computer.act("b", {
      observation_id: next.observation_id,
      action: { type: "key", key: "Enter" },
      observe_after: false,
    }),
    { code: "stale_observation" },
  );
  assert.deepEqual(native.released, ["a"]);
});
test("same-session actions serialize and cannot use one observation twice", async () => {
  const native = new Native(),
    computer = new Computer(native);
  let resume!: () => void;
  native.act = async (_id, action) => {
    native.actions.push(action);
    await new Promise<void>((resolve) => {
      resume = resolve;
    });
    return { action_executed: true, business_verified: false };
  };
  const observed = await computer.observe("a", { pid: 10, window_id: 20 });
  const args = {
    observation_id: observed.observation_id,
    action: { type: "click", element_ref: "e1" },
    observe_after: false,
  };
  const first = computer.act("a", args);
  while (!resume) await delay(1);
  const second = computer.act("a", args);
  resume();
  await first;
  await assert.rejects(second, { code: "stale_observation" });
  assert.equal(native.actions.length, 1);
});
async function waitUntil(predicate: () => boolean, timeout = 3000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw Error("Condition timed out");
    await delay(5);
  }
}
test("real WS client executes one effect, deduplicates and obeys local pause", async () => {
  const dir = await directory();
  const ws = new WebSocketServer({ port: 0 });
  const address = ws.address();
  assert.ok(address && typeof address === "object");
  const messages: Record<string, unknown>[] = [];
  let peer: WebSocket | undefined;
  ws.on("connection", (socket) => {
    peer = socket;
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      messages.push(message);
      if (message.type === "hello")
        socket.send(
          JSON.stringify({
            type: "welcome",
            protocol: "abridge/1",
            device_id: "dev_fixture",
            connection_epoch: 1,
            capabilities: ["shell", "files", "screen", "input"],
            owner_name: "fixture",
            lease_seconds: 30,
            heartbeat_interval: 10,
          }),
        );
      if (message.type === "heartbeat")
        socket.send(JSON.stringify({ type: "heartbeat_ack", connection_epoch: 1 }));
    });
  });
  const config = await configureClient(dir, {
    url: `http://localhost:${address.port}`,
    device_key: "abr_device_fixture",
    capabilities: { shell: true, files: true, screen: true, input: true },
  });
  const client = new DeviceClient({
    stateDir: dir,
    config,
    deviceKey: "abr_device_fixture",
    executor: new LocalExecutor(new Native()),
  });
  const run = client.run();
  try {
    await waitUntil(() => messages.some((m) => m.type === "hello"));
    await waitUntil(() => Boolean(peer));
    await waitUntil(() => client["epoch"] === 1);
    const frame = {
      type: "dispatch",
      protocol: "abridge/1",
      device_id: "dev_fixture",
      connection_epoch: 1,
      operation_id: "op_fixture",
      session_id: "sess_fixture",
      session_capabilities: ["files"],
      grant_version: 1,
      sequence: 1,
      expires_at: Date.now() / 1000 + 30,
      tool: "file_write",
      arguments: { path: join(dir, "effect"), content: "once" },
    };
    peer!.send(JSON.stringify(frame));
    await waitUntil(() => messages.some((m) => m.type === "result" && m.operation_id === "op_fixture"));
    assert.equal(await readFile(join(dir, "effect"), "utf8"), "once");
    peer!.send(JSON.stringify(frame));
    await waitUntil(
      () => messages.filter((m) => m.type === "result" && m.operation_id === "op_fixture").length === 2,
    );
    assert.equal(
      (messages.filter((m) => m.type === "result")[1].result as Record<string, unknown>).deduplicated,
      true,
    );
    await localControl(dir, { command: "pause" });
    peer!.send(
      JSON.stringify({
        ...frame,
        operation_id: "paused_op",
        sequence: 2,
        arguments: { path: join(dir, "forbidden"), content: "bad" },
      }),
    );
    await waitUntil(() => messages.some((m) => m.operation_id === "paused_op"));
    assert.equal(
      (messages.find((m) => m.operation_id === "paused_op")!.error as Record<string, unknown>).code,
      "device_paused",
    );
    assert.equal((await localControl(dir, { command: "status" })).paused, true);
  } finally {
    await client.stop();
    await run;
    await new Promise<void>((resolve) => ws.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
test("failed observation sessions are released and launch evidence survives follow-up failure", async () => {
  const native = new Native();
  native.observe = async () => {
    throw Error("private native diagnostic");
  };
  const computer = new Computer(native);
  await assert.rejects(computer.observe("failed", { pid: 10, window_id: 20 }));
  await computer.stop();
  assert.deepEqual(native.released, ["failed"]);
  const next = new Computer(native);
  const result = await next.open("launch", { bundle_id: "dev.abridge.fixture" });
  assert.equal(result.launch_requested, true);
  assert.equal(result.bundle_id, "dev.abridge.fixture");
  assert.ok(!JSON.stringify(result).includes("private native diagnostic"));
  await next.shutdown();
});
test("output transport failure aborts Shell without an unhandled rejection", async () => {
  const executor = new LocalExecutor(new Native(), async () => {
    throw Error("fixture transport closed");
  });
  await assert.rejects(
    executor.commandExecute("transport-failure", { command: "printf fixture; sleep 5" }),
    /fixture transport closed/,
  );
  await executor.shutdown();
});

test("binding only enables explicitly selected capabilities and known file failures are failed", async () => {
  const dir = await directory();
  try {
    const config = await configureClient(dir, {
      url: "http://localhost:8765",
      device_key: "abr_device_fixture",
      capabilities: { shell: true },
    });
    assert.deepEqual(config.capabilities, { screen: false, input: false, shell: true, files: false });
    const executor = new LocalExecutor(new Native());
    await assert.rejects(
      executor.execute("missing", "file_read", { path: join(dir, "missing") }),
      (error: unknown) =>
        error instanceof DesktopError && error.code === "execution_failed" && error.outcome === "failed",
    );
    await assert.rejects(executor.commandExecute("cwd", { command: "true", cwd: join(dir, "missing") }), {
      code: "invalid_cwd",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SDK generic modified clicks request foreground and element typing sends only its tool fields", async () => {
  const adapter = new CuaNativeDriver();
  const internals = adapter as unknown as {
    sdk: unknown;
    driver: unknown;
    sessions: Map<string, Promise<void>>;
  };
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  internals.sdk = {
    ActionTarget: {
      Window: class {
        constructor(readonly inner: unknown) {}
      },
    },
    ActionEffect: { Refused: 4 },
    DriverError: { Tool: { instanceOf: () => false }, InvalidArguments: { instanceOf: () => false } },
  };
  internals.driver = {
    callTool: async (tool: string, json: string) => {
      calls.push({ tool, args: JSON.parse(json) });
      return { isError: false };
    },
  };
  internals.sessions.set("fixture", Promise.resolve());
  await adapter.act("fixture", {
    action: "click",
    target: { pid: 10, window_id: 20 },
    native_ref: "opaque",
    modifiers: ["shift"],
  });
  await adapter.act("fixture", {
    action: "type",
    target: { pid: 10, window_id: 20 },
    native_ref: "opaque",
    text: "hello",
  });
  assert.equal(calls[0].args.delivery_mode, "foreground");
  assert.deepEqual(calls[1], {
    tool: "type_text",
    args: {
      session: "fixture",
      target: { kind: "window", pid: 10, window_id: 20 },
      element_token: "opaque",
      text: "hello",
    },
  });
});

test("open returns its ready observation at the same nested path as act, and invalid native frames disable pixels", async () => {
  const native = new Native(),
    computer = new Computer(native);
  const result = await computer.open("launch", { bundle_id: "dev.abridge.fixture" });
  assert.equal(typeof (result.observation as Record<string, unknown>).observation_id, "string");
  native.observations.frame_valid = false;
  const invalid = await computer.observe("invalid", { pid: 10, window_id: 20 });
  assert.equal(invalid.pixel_actions, false);
  await assert.rejects(
    computer.act("invalid", {
      observation_id: invalid.observation_id,
      action: { type: "click", x: 2, y: 2 },
      observe_after: false,
    }),
    { code: "screenshot_required" },
  );
  await computer.shutdown();
});

test("dispatch rechecks its start deadline after asynchronous native diagnostics", async () => {
  const dir = await directory();
  const native = new Native();
  native.diagnostics = async () => {
    await delay(60);
    return {
      driver: { installed: true, ready: true },
      permissions: { checked: true, screen: true, input: true },
    };
  };
  const executor = new LocalExecutor(native),
    journal = new OperationJournal(join(dir, "operations.sqlite3"));
  const client = new DeviceClient({
    stateDir: dir,
    deviceKey: "abr_device_fixture",
    config: {
      url: "http://localhost:1",
      capabilities: { screen: true, input: true, shell: true, files: true },
      paused: false,
    },
    executor,
  });
  const receipts: Record<string, unknown>[] = [];
  Object.assign(client, {
    epoch: 1,
    deviceId: "fixture",
    lastAck: performance.now(),
    serverCapabilities: new Set(["screen", "input", "shell", "files"]),
    journal,
    socket: {
      readyState: 1,
      send: (text: string, callback: (error?: Error) => void) => {
        receipts.push(JSON.parse(text));
        callback();
      },
    },
  });
  try {
    await client.dispatch({
      type: "dispatch",
      protocol: "abridge/1",
      device_id: "fixture",
      connection_epoch: 1,
      sequence: 1,
      grant_version: 1,
      session_capabilities: ["files"],
      operation_id: "expired",
      session_id: "fixture",
      tool: "file_write",
      arguments: { path: join(dir, "forbidden"), content: "bad" },
      expires_at: Date.now() / 1000 + 0.03,
    });
    assert.equal((receipts[0].error as Record<string, unknown>).code, "dispatch_expired");
    assert.equal(journal.get("expired"), undefined);
    await assert.rejects(readFile(join(dir, "forbidden")), { code: "ENOENT" });
  } finally {
    journal.close();
    await executor.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});
