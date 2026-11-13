import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer, type WebSocket } from "ws";
import { DeviceClient } from "../src/client.js";
import { configureClient } from "../src/runtime.js";
import { localControl } from "../src/local-control.js";

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (!(await check())) {
    if (Date.now() > deadline) throw Error("Name did not synchronize");
    await delay(5);
  }
}

test("desktop names synchronize from welcome and heartbeat, and local rename only changes the current device", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abridge-device-name-"));
  const initialName = "Original Mac".padEnd(120, "x");
  let responseId = "dev_fixture";
  let status = 200;
  const writes: unknown[] = [];
  const http = createServer(async (request, response) => {
    assert.equal(request.url, "/api/device");
    assert.equal(request.method, "PATCH");
    assert.equal(request.headers.authorization, "Bearer abr_device_fixture");
    let body = "";
    for await (const chunk of request) body += chunk;
    const value = JSON.parse(body);
    writes.push(value);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: responseId, name: value.name }));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address === "object");
  const ws = new WebSocketServer({ server: http });
  let peer: WebSocket | undefined;
  ws.on("connection", (socket) => {
    peer = socket;
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === "hello")
        socket.send(
          JSON.stringify({
            type: "welcome",
            protocol: "abridge/1",
            device_id: "dev_fixture",
            device_name: initialName,
            connection_epoch: 1,
            capabilities: ["shell"],
            owner_name: "fixture",
            lease_seconds: 30,
            heartbeat_interval: 10,
          }),
        );
    });
  });
  const config = await configureClient(dir, {
    url: `http://127.0.0.1:${address.port}`,
    device_key: "abr_device_fixture",
    capabilities: { shell: true },
  });
  config.paused = true;
  const before = await readFile(join(dir, "credentials/device.json"), "utf8");
  const client = new DeviceClient({ stateDir: dir, config, deviceKey: "abr_device_fixture" });
  const run = client.run();
  try {
    await until(async () => (await client.snapshot()).connection === "online");
    assert.equal((await localControl(dir, { command: "status" })).device_name, initialName);
    const renamed = await localControl(dir, { command: "rename", name: "  Work Mac  " });
    assert.equal(renamed.device_name, "Work Mac");
    assert.deepEqual(writes, [{ name: "Work Mac" }]);
    assert.equal(renamed.paused, true);
    assert.equal(await readFile(join(dir, "credentials/device.json"), "utf8"), before);
    assert.equal(JSON.stringify(renamed).includes("abr_device_fixture"), false);
    const longName = "Long Mac".padEnd(120, "x");
    assert.equal((await localControl(dir, { command: "rename", name: longName })).device_name, longName);
    peer!.send(JSON.stringify({ type: "heartbeat_ack", connection_epoch: 1, device_name: "From console" }));
    await until(async () => (await client.snapshot()).device_name === "From console");
    peer!.send(
      JSON.stringify({ type: "heartbeat_ack", connection_epoch: 0, device_name: "Stale connection" }),
    );
    await assert.rejects(localControl(dir, { command: "rename", name: " " }), { code: "invalid_name" });
    await assert.rejects(localControl(dir, { command: "rename", name: "x".repeat(121) }), {
      code: "invalid_name",
    });
    assert.equal(writes.length, 2, "Invalid names must not reach the Server");
    responseId = "another_device";
    await assert.rejects(localControl(dir, { command: "rename", name: "Wrong response" }), {
      code: "invalid_response",
    });
    assert.equal((await client.snapshot()).device_name, "From console");
    status = 503;
    await assert.rejects(localControl(dir, { command: "rename", name: "Unavailable" }), {
      code: "rename_failed",
    });
    assert.equal((await client.snapshot()).device_name, "From console");
    await client.stop();
    await run;
    await assert.rejects(client.control({ command: "rename", name: "Offline" }), { code: "device_offline" });
  } finally {
    await client.stop();
    await run;
    await new Promise<void>((resolve) => ws.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
