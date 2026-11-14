import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer, type WebSocket } from "ws";
import { MAX_DEVICE_OPERATIONS } from "@abridge/protocol";
import { DeviceClient } from "../src/client.js";
import { LocalExecutor } from "../src/executor.js";
import type { NativeDriver } from "../src/native.js";
import { configureClient } from "../src/runtime.js";
import { localControl } from "../src/local-control.js";

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await delay(5);
  }
  assert.ok(check(), "Expected device state did not arrive");
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "abridge-admission-"));
  const gates: { entered: ReturnType<typeof deferred>; released: ReturnType<typeof deferred> }[] = [];
  const waiting = new Set<ReturnType<typeof deferred>>();
  const native: NativeDriver = {
    async diagnostics(initialize = true) {
      const gate = initialize ? gates.shift() : undefined;
      if (gate) {
        waiting.add(gate.released);
        gate.entered.resolve();
        await gate.released.promise;
        waiting.delete(gate.released);
      }
      return { driver: { ready: true }, permissions: { screen: true, input: true } };
    },
    async apps() {
      return [];
    },
    async windows() {
      return [];
    },
    async open() {
      throw Error("No OS launch allowed in this fixture");
    },
    async observe() {
      throw Error("No OS observation allowed in this fixture");
    },
    async act() {
      throw Error("No OS input allowed in this fixture");
    },
    async release() {},
    async shutdown() {},
  };
  const executor = new LocalExecutor(native);
  const effects: string[] = [];
  executor.execute = async (id) => {
    effects.push(id);
    return { executed: true };
  };
  const server = new WebSocketServer({ port: 0 });
  let peer: WebSocket | undefined;
  const messages: Record<string, unknown>[] = [];
  server.on("connection", (socket) => {
    peer = socket;
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      messages.push(message);
      if (message.type === "hello")
        socket.send(
          JSON.stringify({
            type: "welcome",
            protocol: "abridge/1",
            device_id: "fixture",
            connection_epoch: 1,
            capabilities: ["files", "screen"],
            owner_name: "fixture",
            lease_seconds: 30,
            heartbeat_interval: 10,
          }),
        );
      if (message.type === "heartbeat")
        socket.send(JSON.stringify({ type: "heartbeat_ack", connection_epoch: 1 }));
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const config = await configureClient(directory, {
    url: `http://localhost:${address.port}`,
    device_key: "abr_device_fixture",
    capabilities: { files: true, screen: true },
  });
  const client = new DeviceClient({ stateDir: directory, config, deviceKey: "abr_device_fixture", executor });
  const run = client.run();
  await until(() => client["status"] === "online");
  let sequence = 0;
  const send = (frame: Record<string, unknown>) =>
    peer!.send(JSON.stringify({ connection_epoch: 1, ...frame }));
  return {
    client,
    directory,
    effects,
    messages,
    send,
    frame(id: string, session = "session") {
      return {
        type: "dispatch",
        protocol: "abridge/1",
        device_id: "fixture",
        connection_epoch: 1,
        sequence: ++sequence,
        grant_version: 1,
        session_capabilities: ["files"],
        operation_id: id,
        session_id: session,
        tool: "file_write",
        arguments: { path: "/mock-only", content: "mock" },
        expires_at: Date.now() / 1000 + 30,
      };
    },
    gate() {
      const gate = { entered: deferred(), released: deferred() };
      gates.push(gate);
      return { entered: gate.entered.promise, release: gate.released.resolve };
    },
    async barrier() {
      send({ type: "heartbeat_ack", device_name: "controls_processed" });
      await until(() => client["deviceName"] === "controls_processed");
    },
    async result(id: string) {
      await until(() => messages.some((message) => message.type === "result" && message.operation_id === id));
      return messages.find((message) => message.type === "result" && message.operation_id === id)!;
    },
    async close() {
      for (const gate of gates) gate.released.resolve();
      for (const release of waiting) release.resolve();
      await client.stop();
      await run;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

for (const control of ["cancel", "session_close", "stop", "local_pause", "local_stop"] as const) {
  test(`${control} bypasses pending capability admission and prevents a late side effect`, async () => {
    const f = await fixture();
    try {
      const gate = f.gate();
      f.send(f.frame("pending"));
      await gate.entered;
      if (control === "local_pause" || control === "local_stop")
        await localControl(f.directory, { command: control === "local_pause" ? "pause" : "stop" });
      else f.send({ type: control, operation_ids: ["pending"], session_id: "session" });
      // A later frame must be handled while the dispatch preflight is still blocked.
      await f.barrier();
      assert.deepEqual(f.effects, []);
      gate.release();
      assert.equal((await f.result("pending")).status, "refused");
      assert.deepEqual(f.effects, []);
      if (control === "cancel") {
        f.send(f.frame("next"));
        assert.equal((await f.result("next")).status, "executed");
        assert.deepEqual(f.effects, ["next"]);
      }
    } finally {
      await f.close();
    }
  });
}

test("closing one preflight session leaves another pending session executable", async () => {
  const f = await fixture();
  try {
    const first = f.gate();
    f.send(f.frame("first", "first_session"));
    await first.entered;
    const second = f.gate();
    f.send(f.frame("second", "second_session"));
    await second.entered;
    f.send({ type: "session_close", session_id: "first_session" });
    await f.barrier();
    first.release();
    second.release();
    assert.equal((await f.result("first")).status, "refused");
    assert.equal((await f.result("second")).status, "executed");
    assert.deepEqual(f.effects, ["second"]);
  } finally {
    await f.close();
  }
});

test("pending admissions reserve operation identities and preserve parameter conflict checks", async () => {
  const f = await fixture();
  try {
    const gate = f.gate();
    const original = f.frame("original");
    f.send(original);
    await gate.entered;
    f.send(original);
    assert.equal((await f.result("original")).status, "outcome_unknown");
    f.send({ ...original, arguments: { path: "/mock-only", content: "changed" } });
    await until(() => f.messages.filter((message) => message.operation_id === "original").length === 2);
    const conflict = f.messages.filter((message) => message.operation_id === "original")[1];
    assert.deepEqual(conflict.error, {
      code: "idempotency_conflict",
      message: "Operation identity reused with different arguments",
    });
    gate.release();
    await until(() => f.effects.length === 1);
    await until(() =>
      f.messages.some((message) => message.operation_id === "original" && message.status === "executed"),
    );
    assert.deepEqual(f.effects, ["original"]);
  } finally {
    await f.close();
  }
});

test("pending admissions count toward the device operation limit", async () => {
  const f = await fixture();
  try {
    const gates = [];
    for (let index = 0; index < MAX_DEVICE_OPERATIONS; index++) {
      const gate = f.gate();
      gates.push(gate);
      f.send(f.frame(`pending_${index}`, `session_${index}`));
      await gate.entered;
    }
    f.send(f.frame("excess"));
    const result = await f.result("excess");
    assert.equal((result.error as { code: string }).code, "device_busy");
    f.send({ type: "stop" });
    await f.barrier();
    for (const gate of gates) gate.release();
    await Promise.all(gates.map((_, index) => f.result(`pending_${index}`)));
    assert.deepEqual(f.effects, []);
  } finally {
    await f.close();
  }
});
