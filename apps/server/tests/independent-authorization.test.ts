import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { ControlService } from "../src/control.js";
import type { DeviceTransport } from "../src/types.js";

for (const change of ["revoke", "pause", "disable"] as const)
  test(`sensitive cached results denied after device ${change}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "abridge-independent-auth-"));
    const store = new Store(join(dir, "server.db"));
    const control = new ControlService(store);
    try {
      const user = await store.createUser("fixture", "fixture-password-123");
      const { device, key } = store.createDevice(user.id, "fixture", ["files"]);
      const { grant } = store.createGrant(
        user.id,
        "fixture",
        [device.id],
        ["files"],
        Date.now() / 1000 + 600,
      );
      const transport: DeviceTransport = { async send() {}, async close() {} };
      const ticket = await control.attachConnection(
        key,
        "computer",
        { capabilities: { files: true } },
        transport,
      );
      const session = control.openSession(grant, device.id, ["files"]);
      const started = await control.execute(
        grant,
        session.id,
        "file_read",
        { path: "/synthetic" },
        undefined,
        false,
      );
      await control.receive(ticket, {
        type: "result",
        connection_epoch: ticket.epoch,
        operation_id: started.operation_id,
        status: "executed",
        result: { content: "sensitive-fixture" },
      });
      assert.equal(
        (control.operationStatus(grant, started.operation_id).result as { content: string }).content,
        "sensitive-fixture",
      );
      if (change === "revoke") {
        store.revokeDevice(device.id);
        await control.invalidateDevice(device.id);
      }
      if (change === "pause")
        await control.receive(ticket, {
          type: "capabilities",
          connection_epoch: ticket.epoch,
          paused: true,
          capabilities: { files: true },
        });
      if (change === "disable")
        await control.receive(ticket, {
          type: "capabilities",
          connection_epoch: ticket.epoch,
          paused: false,
          capabilities: { files: false },
        });
      await assert.rejects(
        control.waitOperation(grant, started.operation_id, 0),
        "sensitive content must not remain readable",
      );
    } finally {
      await control.shutdown();
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

test("explicit public Origin supports same-site administration behind a TLS reverse proxy", async () => {
  const { createServer } = await import("../src/server.js");
  const dir = await mkdtemp(join(tmpdir(), "abridge-independent-origin-"));
  const server = await createServer({
    dbPath: join(dir, "server.db"),
    publicOrigin: "https://fixture.example",
    allowedOrigins: ["https://mcp.fixture.example"],
  });
  try {
    const response = await server.app.inject({
      method: "POST",
      url: "/api/login",
      headers: {
        host: "fixture.example",
        origin: "https://fixture.example",
        "content-type": "application/json",
      },
      payload: { username: "missing", password: "fixture-password" },
    });
    assert.equal(
      response.statusCode,
      401,
      "A configured HTTPS public Origin should reach account auth through a local HTTP proxy hop",
    );
    for (const origin of [
      "https://mcp.fixture.example",
      "http://fixture.example",
      "https://fixture.example:444",
    ]) {
      const denied = await server.app.inject({
        method: "POST",
        url: "/api/login",
        headers: { host: "fixture.example", origin, "content-type": "application/json" },
        payload: { username: "missing", password: "fixture-password" },
      });
      assert.equal(denied.statusCode, 403, "MCP and scheme/port variants must not gain management access");
    }
    const mcp = await server.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        host: "fixture.example",
        origin: "https://mcp.fixture.example",
        "content-type": "application/json",
      },
      payload: {},
    });
    assert.equal(mcp.statusCode, 401, "Explicit MCP Origin reaches MCP credential auth");
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("sensitive result that finishes after a local pause cannot escape an existing wait", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abridge-independent-wait-"));
  const store = new Store(join(dir, "server.db")),
    control = new ControlService(store);
  try {
    const user = await store.createUser("fixture", "fixture-password-123");
    const { device, key } = store.createDevice(user.id, "fixture", ["files"]);
    const { grant } = store.createGrant(user.id, "fixture", [device.id], ["files"], Date.now() / 1000 + 600);
    const ticket = await control.attachConnection(
      key,
      "computer",
      { capabilities: { files: true } },
      { async send() {}, async close() {} },
    );
    const session = control.openSession(grant, device.id, ["files"]);
    const started = await control.execute(
      grant,
      session.id,
      "file_read",
      { path: "/synthetic" },
      undefined,
      false,
    );
    const denied = assert.rejects(control.waitOperation(grant, started.operation_id, 1));
    await control.receive(ticket, {
      type: "capabilities",
      connection_epoch: ticket.epoch,
      paused: true,
      capabilities: { files: true },
    });
    await control.receive(ticket, {
      type: "result",
      connection_epoch: ticket.epoch,
      operation_id: started.operation_id,
      status: "executed",
      result: { content: "late-sensitive-fixture" },
    });
    await denied;
  } finally {
    await control.shutdown();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("terminal results survive a normal disconnect but retain the last local pause policy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abridge-independent-offline-"));
  const store = new Store(join(dir, "server.db")),
    control = new ControlService(store);
  const transport = { async send() {}, async close() {} };
  try {
    const user = await store.createUser("fixture", "fixture-password-123");
    const { device, key } = store.createDevice(user.id, "fixture", ["files"]);
    const { grant } = store.createGrant(user.id, "fixture", [device.id], ["files"], Date.now() / 1000 + 600);
    const ticket = await control.attachConnection(
      key,
      "computer",
      { capabilities: { files: true } },
      transport,
    );
    const session = control.openSession(grant, device.id, ["files"]);
    const started = await control.execute(
      grant,
      session.id,
      "file_read",
      { path: "/synthetic" },
      undefined,
      false,
    );
    await control.receive(ticket, {
      type: "result",
      connection_epoch: ticket.epoch,
      operation_id: started.operation_id,
      status: "executed",
      result: { content: "retained-fixture" },
    });
    control.dropConnection(ticket);
    assert.equal((await control.waitOperation(grant, started.operation_id, 0)).status, "executed");
    const paused = await control.attachConnection(
      key,
      "computer",
      { capabilities: { files: true }, paused: true },
      transport,
    );
    control.dropConnection(paused);
    await assert.rejects(control.waitOperation(grant, started.operation_id, 0), { code: "device_paused" });
    await control.attachConnection(
      key,
      "computer",
      { capabilities: { files: true }, paused: false },
      transport,
    );
    assert.equal(
      ((await control.waitOperation(grant, started.operation_id, 0)).result as { content: string }).content,
      "retained-fixture",
    );
  } finally {
    await control.shutdown();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("public Origin rejects non-origins before locking the data directory", async () => {
  const { createServer } = await import("../src/server.js");
  const dir = await mkdtemp(join(tmpdir(), "abridge-independent-origin-parse-"));
  try {
    for (const publicOrigin of [
      "https://fixture.example/",
      "https://fixture.example/path",
      "https://user:secret@fixture.example",
      "https://fixture.example?x=1",
      "https://fixture.example#x",
      "file:///tmp/example",
    ])
      await assert.rejects(createServer({ dbPath: join(dir, "server.db"), publicOrigin }), {
        code: "invalid_public_origin",
      });
    const server = await createServer({
      dbPath: join(dir, "server.db"),
      publicOrigin: "https://fixture.example",
    });
    await server.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
