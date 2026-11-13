import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/server.js";
import { Store } from "../src/store.js";
import { ControlService } from "../src/control.js";
import type { ConnectionPolicy } from "@abridge/protocol";
import type { JsonObject } from "../src/types.js";

const files = (id: string): ConnectionPolicy => ({
  mode: "selected",
  devices: [{ device_id: id, capabilities: ["files"] }],
});

test("foreign connection management and known-device probes reveal no foreign or ungranted device", async () => {
  const directory = await mkdtemp(join(tmpdir(), "abridge-independent-owner-"));
  const server = await createServer({ dbPath: join(directory, "server.db"), port: 0 });
  try {
    const url = await server.start();
    const owner = await server.store.createUser("owner", "synthetic-owner-password");
    const foreign = await server.store.createUser("foreign", "synthetic-foreign-password");
    const visible = server.store.createDevice(owner.id, "Visible synthetic device", ["files"]);
    const hidden = server.store.createDevice(owner.id, "Hidden synthetic device", ["files"]);
    const otherDevice = server.store.createDevice(foreign.id, "Foreign synthetic device", ["files"]);
    const connection = server.store.createGrant(owner.id, "Owner agent", files(visible.device.id));
    const otherConnection = server.store.createGrant(
      foreign.id,
      "Foreign agent",
      files(otherDevice.device.id),
    );
    const login = await fetch(url + "/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "synthetic-owner-password" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    for (const [suffix, method, body] of [
      ["/preview", "GET", undefined],
      ["/rotate", "POST", {}],
      ["/revoke", "POST", {}],
      ["", "PATCH", { name: "stolen", policy: files(visible.device.id), expires_at: null }],
    ] as const) {
      const response = await fetch(`${url}/api/client-grants/${otherConnection.grant.id}${suffix}`, {
        method,
        headers: { cookie, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      assert.equal(response.status, 404);
      const payload = await response.text();
      assert.ok(!payload.includes("Foreign"));
    }
    assert.ok(server.store.authenticateAgent(otherConnection.key), "foreign key must remain valid");
    for (const device_id of [hidden.device.id, otherDevice.device.id, "dev_nonexistent"]) {
      const response = await fetch(url + "/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer " + connection.key,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "device_get", arguments: { device_id } },
        }),
      });
      assert.equal(response.status, 200);
      const result = (await response.json()) as { result: { isError: boolean; content: { text: string }[] } };
      assert.equal(result.result.isError, true);
      assert.deepEqual(JSON.parse(result.result.content[0]!.text), {
        error: { code: "not_found", message: "Device does not exist or is not granted" },
      });
    }
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rotating one connection preserves another connection's session, operation and key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "abridge-independent-rotate-"));
  const store = new Store(join(directory, "server.db"));
  const control = new ControlService(store);
  try {
    const owner = await store.createUser("owner", "synthetic-owner-password");
    const device = store.createDevice(owner.id, "Synthetic device", ["files"]);
    const first = store.createGrant(owner.id, "First", files(device.device.id));
    const second = store.createGrant(owner.id, "Second", files(device.device.id));
    const frames: JsonObject[] = [];
    const ticket = await control.attachConnection(
      device.key,
      "computer",
      { capabilities: { files: true } },
      {
        async send(frame) {
          frames.push(frame);
        },
        async close() {},
      },
    );
    const firstSession = control.openSession(first.grant, device.device.id, ["files"]);
    const secondSession = control.openSession(second.grant, device.device.id, ["files"]);
    const firstOperation = await control.execute(
      first.grant,
      firstSession.id,
      "file_read",
      { path: "/first" },
      undefined,
      false,
    );
    const secondOperation = await control.execute(
      second.grant,
      secondSession.id,
      "file_read",
      { path: "/second" },
      undefined,
      false,
    );
    const rotated = await control.rotateGrant(first.grant);
    assert.equal(store.authenticateAgent(first.key), undefined);
    assert.ok(store.authenticateAgent(rotated.key));
    assert.ok(store.authenticateAgent(second.key));
    assert.equal(store.session(firstSession.id)!.status, "revoked");
    assert.equal(store.session(secondSession.id)!.status, "active");
    const cancelled = frames
      .filter((frame) => frame.type === "cancel")
      .flatMap((frame) => frame.operation_ids as string[]);
    assert.ok(cancelled.includes(firstOperation.operation_id));
    assert.ok(!cancelled.includes(secondOperation.operation_id));
    await control.receive(ticket, {
      type: "result",
      connection_epoch: ticket.epoch,
      operation_id: secondOperation.operation_id,
      status: "executed",
      result: { content: "second connection private fixture" },
    });
    assert.deepEqual((await control.waitOperation(second.grant, secondOperation.operation_id, 0)).result, {
      content: "second connection private fixture",
    });
    assert.throws(() => control.operationStatus(rotated.grant, secondOperation.operation_id), {
      code: "not_found",
    });
    assert.throws(() => control.operationStatus(second.grant, firstOperation.operation_id), {
      code: "not_found",
    });
  } finally {
    await control.shutdown();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const reason of ["expiry", "revocation"] as const) {
  test(`${reason} blocks cached content and a receipt finishing an already active wait`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "abridge-independent-expiry-"));
    const store = new Store(join(directory, "server.db"));
    let now = Date.now() / 1000;
    const control = new ControlService(store, () => now);
    try {
      const owner = await store.createUser("owner", "synthetic-owner-password");
      const device = store.createDevice(owner.id, "Synthetic device", ["files"]);
      const { grant } = store.createGrant(owner.id, "Agent", files(device.device.id), now + 10);
      const ticket = await control.attachConnection(
        device.key,
        "computer",
        { capabilities: { files: true } },
        { async send() {}, async close() {} },
      );
      const session = control.openSession(grant, device.device.id, ["files"]);
      const cached = await control.execute(
        grant,
        session.id,
        "file_read",
        { path: "/cached" },
        undefined,
        false,
      );
      await control.receive(ticket, {
        type: "result",
        connection_epoch: ticket.epoch,
        operation_id: cached.operation_id,
        status: "executed",
        result: { content: "cached fixture" },
      });
      const pending = await control.execute(
        grant,
        session.id,
        "file_read",
        { path: "/pending" },
        undefined,
        false,
      );
      const denied = assert.rejects(control.waitOperation(grant, pending.operation_id, 1), {
        code: "unauthorized",
      });
      if (reason === "expiry") now += 11;
      else await control.revokeGrant(grant);
      await control.receive(ticket, {
        type: "result",
        connection_epoch: ticket.epoch,
        operation_id: pending.operation_id,
        status: "executed",
        result: { content: "late fixture" },
      });
      await denied;
      assert.throws(() => control.operationStatus(grant, cached.operation_id), { code: "unauthorized" });
      assert.throws(() => control.devices(grant), { code: "unauthorized" });
    } finally {
      await control.shutdown();
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
