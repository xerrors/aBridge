import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/server.js";
import { Store } from "../src/store.js";
import { ControlService } from "../src/control.js";
import { BridgeError, type DeviceTransport, type JsonObject } from "../src/types.js";
import { connectionPolicySchema, type Capability, type ConnectionPolicy } from "@abridge/protocol";

const selected = (device: string, capabilities: Capability[]): ConnectionPolicy => ({
  mode: "selected",
  devices: [{ device_id: device, capabilities }],
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "abridge-connections-"));
  const server = await createServer({ dbPath: join(dir, "server.db"), port: 0 });
  const url = await server.start();
  const user = await server.store.createUser("owner", "synthetic-owner-password");
  const login = await fetch(url + "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "owner", password: "synthetic-owner-password" }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  return {
    ...server,
    url,
    user,
    async api(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
      const response = await fetch(url + path, {
        method,
        headers: { cookie, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    },
    async mcp(key: string) {
      const response = await fetch(url + "/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer " + key,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "devices_list", arguments: {} },
        }),
      });
      const envelope = (await response.json()) as { result: { content: { text: string }[] } };
      if (response.status !== 200) return { status: response.status, value: undefined };
      return {
        status: response.status,
        value: JSON.parse(envelope.result.content[0]!.text) as {
          connection: { id: string; name: string };
          devices: { id: string; capabilities: Capability[] }[];
        },
      };
    },
    async dispose() {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("device details use the current policy when another request changes an authenticated connection", async () => {
  const f = await fixture();
  try {
    const { device, key: deviceKey } = f.store.createDevice(f.user.id, "Mini", ["files", "shell"]);
    const { grant, key } = f.store.createGrant(f.user.id, "Agent", selected(device.id, ["files", "shell"]));
    await f.control.attachConnection(
      deviceKey,
      "computer",
      { capabilities: { files: true, shell: true } },
      { async send() {}, async close() {} },
    );
    // An MCP request can retain this snapshot while another HTTP request edits its policy.
    const authenticated = f.store.authenticateAgent(key)!;
    const changed = await f.api(
      `/api/client-grants/${grant.id}`,
      { name: "Agent", policy: selected(device.id, ["shell"]), expires_at: null },
      "PATCH",
    );
    assert.equal(changed.status, 200);
    const listed = f.control.devices(authenticated)[0]!;
    const detail = f.control.deviceView(f.control.authorizedDevice(authenticated, device.id), authenticated);
    const session = f.control.openSession(authenticated, device.id, ["shell"]);
    const sessionDevice = f.control.deviceView(
      f.control.authorizedDevice(authenticated, session.device_id),
      authenticated,
    );
    for (const view of [listed, detail, sessionDevice]) {
      assert.deepEqual(view.capabilities, ["shell"]);
      assert.deepEqual(view.available, { shell: true });
    }
    assert.throws(() => f.control.openSession(authenticated, device.id, ["files"]), { code: "forbidden" });
  } finally {
    await f.dispose();
  }
});

test("connection administration explains the three-account/two-MCP-device difference and edits without replacing the key", async () => {
  const f = await fixture();
  try {
    const mini = f.store.createDevice(f.user.id, "Mini", ["files", "shell"]);
    const air = f.store.createDevice(f.user.id, "Air", ["screen", "input"]);
    const browser = f.store.createDevice(f.user.id, "Chrome", ["browser"], "browser");
    const policy: ConnectionPolicy = {
      mode: "selected",
      devices: [
        { device_id: air.device.id, capabilities: ["screen"] },
        { device_id: browser.device.id, capabilities: ["browser"] },
      ],
    };
    const created = await f.api("/api/client-grants", { name: "My agent", policy });
    assert.equal(created.status, 200);
    assert.equal(created.body.expires_at, null);
    assert.equal("token_digest" in created.body, false);
    const id = String(created.body.id),
      key = String(created.body.key);
    const initial = (await f.mcp(key)).value!;
    assert.equal(initial.connection.id, id);
    assert.deepEqual(new Set(initial.devices.map((d) => d.id)), new Set([air.device.id, browser.device.id]));
    const preview = await f.api(`/api/client-grants/${id}/preview`);
    const devices = preview.body.devices as {
      id: string;
      access: string;
      granted_capabilities: Capability[];
    }[];
    assert.equal(devices.length, 3);
    assert.equal(devices.find((d) => d.id === mini.device.id)!.access, "not_granted");
    assert.deepEqual(devices.find((d) => d.id === air.device.id)!.granted_capabilities, ["screen"]);
    const nextPolicy: ConnectionPolicy = {
      mode: "selected",
      devices: [...policy.devices, { device_id: mini.device.id, capabilities: ["shell"] }],
    };
    const changed = await f.api(
      `/api/client-grants/${id}`,
      { name: "Renamed agent", policy: nextPolicy, expires_at: null },
      "PATCH",
    );
    assert.equal(changed.status, 200);
    assert.equal("key" in changed.body, false);
    const updated = (await f.mcp(key)).value!;
    assert.equal(updated.connection.name, "Renamed agent");
    assert.equal(updated.devices.length, 3);
    assert.deepEqual(updated.devices.find((d) => d.id === mini.device.id)!.capabilities, ["shell"]);
    const foreignUser = await f.store.createUser("foreign", "synthetic-foreign-password");
    const foreign = f.store.createDevice(foreignUser.id, "Foreign", ["files"]);
    assert.equal(
      (
        await f.api(
          `/api/client-grants/${id}`,
          { name: "Invalid", policy: selected(foreign.device.id, ["files"]), expires_at: null },
          "PATCH",
        )
      ).status,
      404,
    );
    const foreignGrant = f.store.createGrant(
      foreignUser.id,
      "Foreign agent",
      selected(foreign.device.id, ["files"]),
    );
    assert.equal((await f.api(`/api/client-grants/${foreignGrant.grant.id}/preview`)).status, 404);
    assert.equal(
      (
        await f.api(
          `/api/client-grants/${id}`,
          { name: "Invalid", policy: selected(browser.device.id, ["shell"]), expires_at: null },
          "PATCH",
        )
      ).status,
      422,
    );
    assert.equal((await f.api("/api/client-grants", { name: "Invalid", policy, expires_at: 0 })).status, 422);
    assert.equal(
      connectionPolicySchema.safeParse({
        mode: "selected",
        devices: [{ device_id: mini.device.id, capabilities: ["files", "files"] }],
      }).success,
      false,
    );
    assert.equal(
      connectionPolicySchema.safeParse({
        mode: "all",
        capabilities: ["files"],
        overrides: [
          { device_id: mini.device.id, capabilities: [] },
          { device_id: mini.device.id, capabilities: ["files"] },
        ],
      }).success,
      false,
    );
    const listed = await f.api("/api/client-grants");
    assert.equal(JSON.stringify(listed.body).includes("token_digest"), false);
    assert.equal(JSON.stringify(listed.body).includes(key), false);
    const rotated = await f.api(`/api/client-grants/${id}/rotate`, {});
    assert.equal(rotated.status, 200);
    assert.equal((await f.mcp(key)).status, 401);
    assert.equal((await f.mcp(String(rotated.body.key))).value!.devices.length, 3);
  } finally {
    await f.dispose();
  }
});

test("all-device connections include future owned devices and exact per-device overrides", async () => {
  const f = await fixture();
  try {
    const created = await f.api("/api/client-grants", {
      name: "All my devices",
      policy: { mode: "all", capabilities: ["screen", "input", "files", "shell", "browser"], overrides: [] },
    });
    assert.equal(created.status, 200);
    const key = String(created.body.key),
      id = String(created.body.id);
    assert.equal((await f.mcp(key)).value!.devices.length, 0);
    const mini = f.store.createDevice(f.user.id, "Mini", ["files", "shell"]);
    const browser = f.store.createDevice(f.user.id, "Chrome", ["browser"], "browser");
    const other = await f.store.createUser("other", "synthetic-other-password");
    f.store.createDevice(other.id, "Other device", ["files"]);
    assert.equal((await f.mcp(key)).value!.devices.length, 2);
    await f.api(
      `/api/client-grants/${id}`,
      {
        name: "All my devices",
        policy: {
          mode: "all",
          capabilities: ["files", "shell", "browser"],
          overrides: [
            { device_id: mini.device.id, capabilities: ["files"] },
            { device_id: browser.device.id, capabilities: [] },
          ],
        },
        expires_at: null,
      },
      "PATCH",
    );
    const scope = (await f.mcp(key)).value!.devices;
    assert.deepEqual(
      scope.map((d) => ({ id: d.id, caps: d.capabilities })),
      [{ id: mini.device.id, caps: ["files"] }],
    );
    f.store.revokeDevice(mini.device.id);
    assert.equal((await f.mcp(key)).value!.devices.length, 0);
  } finally {
    await f.dispose();
  }
});

test("scope reductions cancel affected in-flight sessions and deny cached and waiting sensitive results; rotation invalidates old credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abridge-policy-change-"));
  const store = new Store(join(dir, "server.db")),
    control = new ControlService(store);
  try {
    const user = await store.createUser("owner", "synthetic-owner-password");
    const device = store.createDevice(user.id, "Mini", ["files", "shell"]);
    const { grant, key } = store.createGrant(
      user.id,
      "Agent",
      selected(device.device.id, ["files", "shell"]),
    );
    const frames: JsonObject[] = [];
    const transport: DeviceTransport = {
      async send(frame) {
        frames.push(frame);
      },
      async close() {},
    };
    const ticket = await control.attachConnection(
      device.key,
      "computer",
      { capabilities: { files: true, shell: true }, paused: false },
      transport,
    );
    const session = control.openSession(grant, device.device.id, ["files"]);
    const completed = await control.execute(
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
      operation_id: completed.operation_id,
      status: "executed",
      result: { content: "private fixture" },
    });
    assert.ok(control.operationStatus(grant, completed.operation_id).result);
    const pending = await control.execute(
      grant,
      session.id,
      "file_read",
      { path: "/pending" },
      undefined,
      false,
    );
    const waiting = assert.rejects(
      control.waitOperation(grant, pending.operation_id, 15),
      (error: unknown) => error instanceof BridgeError && error.code === "forbidden",
    );
    await control.updateGrant(grant, "Agent", selected(device.device.id, ["shell"]), null);
    await waiting;
    assert.equal(store.session(session.id)!.status, "revoked");
    assert.ok(
      frames.some(
        (frame) =>
          frame.type === "cancel" && (frame.operation_ids as string[]).includes(pending.operation_id),
      ),
    );
    assert.ok(frames.some((frame) => frame.type === "session_close" && frame.session_id === session.id));
    assert.throws(() => control.operationStatus(grant, completed.operation_id), { code: "forbidden" });
    assert.ok(store.authenticateAgent(key));
    const current = store.grant(grant.id)!;
    const shellSession = control.openSession(current, device.device.id, ["shell"]);
    const command = await control.execute(
      current,
      shellSession.id,
      "command_execute",
      { command: "synthetic" },
      undefined,
      false,
    );
    const oldWaiting = assert.rejects(control.waitOperation(current, command.operation_id, 15), {
      code: "unauthorized",
    });
    const rotated = await control.rotateGrant(current);
    await oldWaiting;
    assert.equal(store.authenticateAgent(key), undefined);
    assert.ok(store.authenticateAgent(rotated.key));
    assert.deepEqual(rotated.grant.policy, current.policy);
    assert.throws(() => control.devices(current), { code: "unauthorized" });
    assert.equal(store.session(shellSession.id)!.status, "revoked");
    await control.revokeGrant(rotated.grant);
    assert.equal(store.authenticateAgent(rotated.key), undefined);
  } finally {
    await control.shutdown();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("indefinite connections retain bounded sessions; shorter expiry applies immediately and expired previews stay unavailable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abridge-expiry-change-"));
  const store = new Store(join(dir, "server.db"));
  let now = Date.now() / 1000;
  const control = new ControlService(store, () => now);
  try {
    const user = await store.createUser("owner", "synthetic-owner-password"),
      device = store.createDevice(user.id, "Mini", ["files"]);
    const { grant } = store.createGrant(user.id, "Agent", selected(device.device.id, ["files"]));
    const transport: DeviceTransport = { async send() {}, async close() {} };
    await control.attachConnection(device.key, "computer", { capabilities: { files: true } }, transport);
    const session = control.openSession(grant, device.device.id, ["files"]);
    assert.equal(session.lease_until, now + 300);
    const updated = await control.updateGrant(grant, "Agent", grant.policy, now + 40);
    assert.equal(store.session(session.id)!.lease_until, now + 40);
    now += 41;
    await control.tick();
    assert.equal(store.session(session.id)!.status, "revoked");
    const preview = control.previewGrant(updated) as {
      connection: { status: string };
      devices: { available: Record<string, boolean> }[];
    };
    assert.equal(preview.connection.status, "expired");
    assert.equal(preview.devices[0]!.available.files, false);
    assert.throws(() => control.devices(updated), { code: "unauthorized" });
  } finally {
    await control.shutdown();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
