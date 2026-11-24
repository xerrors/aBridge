import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { createServer } from "../src/server.js";
import { commandOutputPage, characterLength } from "../src/command-output.js";
import { contentResponse } from "../src/mcp.js";
import { BridgeError, type JsonObject } from "../src/types.js";
import { WebSocketTransport } from "../src/transport.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "abridge-node-server-"));
  const server = await createServer({ dbPath: join(dir, "server.db"), port: 0 });
  const url = await server.start();
  return {
    ...server,
    url,
    dir,
    async dispose() {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
async function rpc(url: string, key: string, name: string, args: JsonObject = {}, signal?: AbortSignal) {
  const response = await fetch(url + "/mcp", {
    method: "POST",
    signal,
    headers: {
      authorization: "Bearer " + key,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    result: { content: { type: string; text?: string; data?: string }[]; isError?: boolean };
  };
  return { ...body.result, value: JSON.parse(body.result.content.find((c) => c.type === "text")!.text!) };
}
async function connect(
  f: Awaited<ReturnType<typeof fixture>>,
  key: string,
  kind = "computer",
  onDispatch?: (frame: JsonObject, socket: WebSocket) => void,
  platform = kind === "browser" ? "Browser extension" : "darwin",
  autoPong = true,
) {
  const socket = new WebSocket(
    f.url.replace("http:", "ws:") + "/ws/" + (kind === "browser" ? "browser" : "device"),
    kind === "browser"
      ? { origin: "chrome-extension://" + "a".repeat(32), autoPong }
      : { headers: { authorization: "Bearer " + key } },
  );
  socket.on("message", (data) => {
    const frame = JSON.parse(data.toString());
    if (frame.type === "dispatch") onDispatch?.(frame, socket);
  });
  await once(socket, "open");
  const welcome = once(socket, "message");
  socket.send(
    JSON.stringify({
      type: "hello",
      protocol: "abridge/1",
      platform,
      version: "0.3.0",
      paused: false,
      instance_id: "server-test-instance",
      device_key: key,
      capabilities: { screen: true, input: true, shell: true, files: true, browser: true },
    }),
  );
  const [data] = await welcome;
  return { socket, welcome: JSON.parse(data.toString()) };
}

test("HTTP bootstrap, exact origin scopes, account auth, and same-data-dir process guard", async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(f.url + "/api/setup")).status, 404);
    let res = await fetch(f.url + "/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + f.adminToken },
      body: JSON.stringify({ username: "owner", password: "test-password-long" }),
    });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get("set-cookie"), null, "Creating a user does not log in as that user");
    assert.equal(((await res.json()) as { username: string }).username, "owner");
    res = await fetch(f.url + "/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "test-password-long" }),
    });
    assert.equal(res.status, 200);
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    assert.equal((await fetch(f.url + "/api/me", { headers: { cookie } })).status, 200);
    assert.equal(
      (
        await fetch(f.url + "/api/devices", {
          headers: { cookie, origin: "chrome-extension://" + "a".repeat(32) },
        })
      ).status,
      403,
    );
    assert.equal(
      (await f.app.inject({ method: "GET", url: "/health", headers: { host: "evil.example" } })).statusCode,
      421,
    );
    await assert.rejects(
      createServer({ dbPath: join(f.dir, "server.db"), port: 0 }),
      (error) => error instanceof BridgeError && error.code === "instance_running",
    );
    res = await fetch(f.url + "/api/browser/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "test-password-long", name: "Browser" }),
    });
    assert.equal(res.status, 404, "Password-based extension registration is no longer exposed");
  } finally {
    await f.dispose();
  }
});

test("device names are editable by their account or device key while capabilities stay client-controlled", async () => {
  const f = await fixture();
  try {
    const owner = await f.store.createUser("name-owner", "synthetic-owner-password");
    const foreign = await f.store.createUser("other-owner", "synthetic-owner-password");
    const computer = f.store.createDevice(owner.id, "Mac", ["screen", "input", "files", "shell"]);
    const browser = f.store.createDevice(owner.id, "Browser", ["browser"], "browser");
    const other = f.store.createDevice(foreign.id, "Other Mac", ["files"]);
    assert.match(computer.device.id, /^[A-Za-z0-9_-]{12}$/);
    assert.match(browser.device.id, /^[A-Za-z0-9_-]{12}$/);
    assert.notEqual(computer.device.id, browser.device.id);
    const session = await f.store.login("name-owner", "synthetic-owner-password");
    const call = (url: string, payload: unknown, headers: Record<string, string>) =>
      f.app.inject({
        method: "PATCH",
        url,
        headers: { "content-type": "application/json", ...headers },
        payload: JSON.stringify(payload),
      });
    const headers = { cookie: `abridge_session=${session!.token}` };
    assert.equal((await call(`/api/devices/${other.device.id}`, { name: "Other" }, headers)).statusCode, 404);
    for (const body of [
      { name: "Mac", capabilities: ["files"] },
      { name: "Mac", kind: "browser" },
    ])
      assert.equal((await call(`/api/devices/${computer.device.id}`, body, headers)).statusCode, 422);
    const { socket, welcome } = await connect(f, computer.key);
    try {
      assert.equal(welcome.device_name, "Mac");
      const renamed = await call(`/api/devices/${computer.device.id}`, { name: "  Work Mac  " }, headers);
      assert.equal(renamed.statusCode, 200);
      assert.equal(renamed.json().name, "Work Mac");
      const ack = once(socket, "message");
      socket.send(JSON.stringify({ type: "heartbeat", connection_epoch: welcome.connection_epoch }));
      assert.equal(JSON.parse(String((await ack)[0])).device_name, "Work Mac");
    } finally {
      socket.close();
    }
    const selfHeaders = {
      authorization: `Bearer ${browser.key}`,
      origin: `chrome-extension://${"a".repeat(32)}`,
    };
    const renamed = await call("/api/device", { name: "Work Browser" }, selfHeaders);
    assert.equal(renamed.statusCode, 200);
    assert.deepEqual(renamed.json(), { id: browser.device.id, name: "Work Browser" });
    assert.equal(
      (await call("/api/device", { name: "No", id: other.device.id }, selfHeaders)).statusCode,
      422,
    );
    assert.equal((await call("/api/device", { name: "No" }, headers)).statusCode, 401);
    assert.equal(
      (await call("/api/device", { name: "No" }, { ...selfHeaders, origin: "https://evil.fixture" }))
        .statusCode,
      403,
    );
    assert.equal((await call("/api/device", { name: " " }, selfHeaders)).statusCode, 422);
    f.store.revokeDevice(browser.device.id);
    assert.equal((await call("/api/device", { name: "No" }, selfHeaders)).statusCode, 401);
    assert.deepEqual(f.store.device(computer.device.id)!.capabilities, computer.device.capabilities);
    assert.equal(f.store.authenticateDevice(computer.key)!.id, computer.device.id);
  } finally {
    await f.dispose();
  }
});

test("real MCP + WebSocket: all 21 tools, direct shell result, idempotency, yielding, files and image blocks", async () => {
  const f = await fixture();
  try {
    const user = await f.store.createUser("owner", "test-password-long"),
      device = f.store.createDevice(user.id, "Mac", ["shell", "files", "screen", "input"]);
    const agentConnection = f.store.createAgentConnection(
      user.id,
      "agent",
      {
        mode: "selected",
        devices: [{ device_id: device.device.id, capabilities: ["shell", "files", "screen", "input"] }],
      },
      Date.now() / 1000 + 600,
    );
    let dispatches = 0;
    const delayed: JsonObject[] = [];
    const { socket } = await connect(f, device.key, "computer", (frame, socket) => {
      dispatches++;
      if ((frame.arguments as JsonObject).command === "delay") {
        delayed.push(frame);
        return;
      }
      const result =
        frame.tool === "command_execute"
          ? { stdout: "hello 😀\n", stderr: "", exit_code: 0 }
          : frame.tool === "computer_observe"
            ? {
                observation_id: "obs_Ab12_-xy",
                image_base64: "aGk=",
                mime_type: "image/png",
              }
            : { content: "file content" };
      socket.send(
        JSON.stringify({
          type: "result",
          connection_epoch: frame.connection_epoch,
          operation_id: frame.operation_id,
          status: "executed",
          result,
        }),
      );
    });
    const list = await fetch(f.url + "/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer " + agentConnection.key,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    const listed = (await list.json()) as {
      result: { tools: { name: string; inputSchema: unknown }[] };
    };
    assert.equal(listed.result.tools.length, 21);
    const toolNames = listed.result.tools.map((tool) => tool.name);
    assert.ok(toolNames.includes("operation_status"));
    assert.ok(toolNames.includes("operation_cancel"));
    assert.ok(!toolNames.includes("command_status"));
    assert.ok(!toolNames.includes("command_cancel"));

    let patterns = 0;
    const checkPatterns = (value: unknown, location: string): void => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (key === "pattern") {
          assert.equal(typeof child, "string", `${location}.pattern must be a string`);
          assert.doesNotThrow(() => new RegExp(child as string, "u"), `${location}.pattern`);
          patterns++;
        } else if (key === "patternProperties" && child && typeof child === "object") {
          for (const pattern of Object.keys(child)) {
            assert.doesNotThrow(() => new RegExp(pattern, "u"), `${location}.patternProperties`);
            patterns++;
          }
        }
        checkPatterns(child, `${location}.${key}`);
      }
    };
    for (const tool of listed.result.tools) checkPatterns(tool.inputSchema, tool.name);
    assert.ok(patterns > 0, "The actual tools/list schemas must contain patterns to validate");
    const opened = await rpc(f.url, agentConnection.key, "session_open", {
        device_id: device.device.id,
        capabilities: ["shell", "files", "screen"],
      }),
      session = opened.value.id;
    for (const [tool, args] of [
      ["command_execute", { command: "echo hello", env: { "BAD=KEY": "value" } }],
      ["command_execute", { command: "echo hello", env: { ["BAD\0KEY"]: "value" } }],
      ["command_execute", { command: "echo hello", env: { VALID: "bad\0value" } }],
      ["command_execute", { command: "echo \uD800" }],
      ["command_execute", { command: "echo hello", cwd: "/tmp/\uD800" }],
      ["command_execute", { command: "echo hello", env: { "\uD800": "value" } }],
      ["command_execute", { command: "echo hello", env: { VALID: "\uD800" } }],
      ["file_read", { path: "/tmp/\uD800" }],
    ] as const) {
      const rejected = await fetch(f.url + "/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer " + agentConnection.key,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: tool, arguments: { session_id: session, ...args } },
        }),
      });
      assert.equal(rejected.status, 200);
      assert.equal(((await rejected.json()) as { result: { isError?: boolean } }).result.isError, true);
      assert.equal(dispatches, 0, "Invalid command and file arguments must never reach the device");
    }
    const command = await rpc(f.url, agentConnection.key, "command_execute", {
      session_id: session,
      command: "echo hello",
      env: { VALID_KEY: "valid value" },
      operation_id: "op_test",
    });
    assert.equal(command.value.status, "executed");
    assert.equal(command.value.result.stdout, "hello 😀\n");
    assert.equal(dispatches, 1);
    await rpc(f.url, agentConnection.key, "command_execute", {
      session_id: session,
      command: "echo hello",
      env: { VALID_KEY: "valid value" },
      timeout: 30,
      operation_id: "op_test",
    });
    assert.equal(dispatches, 1);
    const conflict = await rpc(f.url, agentConnection.key, "command_execute", {
      session_id: session,
      command: "echo different",
      operation_id: "op_test",
    });
    assert.equal(conflict.value.error.code, "operation_conflict");
    const yielded = await rpc(f.url, agentConnection.key, "command_execute", {
      session_id: session,
      command: "delay",
      wait_seconds: 0,
    });
    assert.equal(yielded.value.status, "dispatched");
    assert.equal(yielded.isError, undefined);
    const frame = delayed[0]!;
    socket.send(
      JSON.stringify({
        type: "result",
        connection_epoch: frame.connection_epoch,
        operation_id: frame.operation_id,
        status: "executed",
        result: { stdout: "later", stderr: "", exit_code: 0 },
      }),
    );
    const status = await rpc(f.url, agentConnection.key, "operation_status", {
      operation_id: yielded.value.operation_id,
    });
    assert.equal(status.value.result.stdout, "later");
    const file = await rpc(f.url, agentConnection.key, "file_read", {
      session_id: session,
      path: "/tmp/test",
    });
    assert.equal(file.value.result.content, "file content");
    const observation = await rpc(f.url, agentConnection.key, "computer_observe", { session_id: session });
    assert.equal(observation.content[1]!.type, "image");
    assert.equal(observation.value.result.image_base64, undefined);
    const denied = await rpc(f.url, agentConnection.key, "browser_open", {
      session_id: session,
      url: "https://example.com",
    });
    assert.equal(denied.value.error.code, "forbidden");
    await rpc(f.url, agentConnection.key, "session_close", { session_id: session });
    socket.close();
  } finally {
    await f.dispose();
  }
});

test("real MCP marks failed device receipts as tool errors without rejecting executed partial observations", async () => {
  const f = await fixture();
  try {
    const user = await f.store.createUser("owner", "test-password-long"),
      device = f.store.createDevice(user.id, "Mac", ["files", "screen", "input"]),
      agentConnection = f.store.createAgentConnection(user.id, "agent", {
        mode: "all",
        capabilities: ["files", "screen", "input"],
        overrides: [],
      });
    const observationError = { code: "observation_failed", message: "Action completed; refresh observation" };
    const { socket } = await connect(f, device.key, "computer", (frame, socket) => {
      const status = frame.tool === "computer_act" ? "executed" : (frame.arguments as JsonObject).path;
      socket.send(
        JSON.stringify({
          type: "result",
          connection_epoch: frame.connection_epoch,
          operation_id: frame.operation_id,
          status,
          ...(status === "executed"
            ? { result: { executed: true, observation_error: observationError } }
            : status === "cancelled"
              ? {}
              : { error: { code: "fixture_" + status, message: "Synthetic device failure" } }),
        }),
      );
    });
    const opened = await rpc(f.url, agentConnection.key, "session_open", {
      device_id: device.device.id,
      capabilities: ["files", "screen", "input"],
    });
    for (const status of ["failed", "refused", "outcome_unknown", "cancelled"]) {
      const receipt = await rpc(f.url, agentConnection.key, "file_read", {
        session_id: opened.value.id,
        operation_id: "op_error_" + status,
        path: status,
      });
      const isError = status === "cancelled" ? undefined : true;
      assert.equal(receipt.value.status, status);
      assert.equal(f.store.operation(receipt.value.operation_id)?.session_id, opened.value.id);
      assert.equal(receipt.isError, isError);
      if (isError) assert.equal(receipt.value.error.code, "fixture_" + status);
      const retained = await rpc(f.url, agentConnection.key, "operation_status", {
        operation_id: receipt.value.operation_id,
        wait_seconds: 0,
      });
      assert.equal(retained.isError, isError);
      assert.deepEqual({ ...retained.value, session: undefined }, { ...receipt.value, session: undefined });
      assert.equal(retained.value.session.id, opened.value.id);
      assert.ok(retained.value.session.lease_until >= receipt.value.session.lease_until);
    }
    const action = await rpc(f.url, agentConnection.key, "computer_act", {
      session_id: opened.value.id,
      observation_id: "obs_Ab12_-xy",
      action: { type: "key", key: "Enter" },
    });
    assert.equal(action.value.status, "executed");
    assert.equal(action.isError, undefined);
    assert.deepEqual(action.value.result.observation_error, observationError);
    socket.close();
  } finally {
    await f.dispose();
  }
});

test("session_open returns the same device summary as devices_list across platforms", async () => {
  const f = await fixture();
  try {
    const user = await f.store.createUser("owner", "test-password-long");
    for (const { name, kind, platform, capability } of [
      { name: "工作 Mac", kind: "computer", platform: "darwin", capability: "shell" },
      { name: "工作 Chrome", kind: "browser", platform: "Browser extension", capability: "browser" },
      { name: "Windows PC", kind: "computer", platform: "win32", capability: "shell" },
      { name: "Android 设备", kind: "computer", platform: "android", capability: "shell" },
    ] as const) {
      const { device, key } = f.store.createDevice(user.id, name, [capability], kind);
      const agentConnection = f.store.createAgentConnection(user.id, "agent", {
        mode: "selected",
        devices: [{ device_id: device.id, capabilities: [capability] }],
      });
      const { socket } = await connect(f, key, kind, undefined, platform);
      try {
        const opened = await rpc(f.url, agentConnection.key, "session_open", {
          device_id: device.id,
          capabilities: [capability],
        });
        assert.equal(opened.isError, undefined);
        assert.equal(opened.value.device_id, device.id);
        assert.equal(opened.value.status, "active");
        assert.deepEqual(opened.value.capabilities, [capability]);
        assert.equal(opened.value.device.id, device.id);
        assert.equal(opened.value.device.name, name);
        assert.equal(opened.value.device.kind, kind);
        assert.equal(opened.value.device.platform, platform);
        const detail = await rpc(f.url, agentConnection.key, "device_get", { device_id: device.id });
        const listed = await rpc(f.url, agentConnection.key, "devices_list");
        const stableDevice = (value: JsonObject): JsonObject => ({
          ...value,
          sessions: (value.sessions as JsonObject[]).map(({ server_time, ...session }) => {
            assert.equal(typeof server_time, "number");
            assert.equal(session.id, opened.value.id);
            return session;
          }),
        });
        const { owner_name, ...deviceDetail } = stableDevice(detail.value);
        assert.equal(owner_name, user.username);
        assert.deepEqual(stableDevice(opened.value.device), deviceDetail);
        assert.deepEqual(listed.value.devices.map(stableDevice), [stableDevice(opened.value.device)]);
        await rpc(f.url, agentConnection.key, "session_close", { session_id: opened.value.id });
        const closed = once(socket, "close");
        socket.close();
        await closed;
        // The client's close event can precede the server's close callback.
        const deadline = Date.now() + 5000;
        while (f.control.deviceView(device).status !== "offline" && Date.now() < deadline) await delay(10);
        const offline = await rpc(f.url, agentConnection.key, "device_get", { device_id: device.id });
        assert.equal(offline.value.status, "offline");
        assert.equal(offline.value.platform, platform);
        assert.equal(offline.value.version, opened.value.device.version);
      } finally {
        socket.close();
      }
    }
  } finally {
    await f.dispose();
  }
});

test("a new browser session waits for the same device to reconnect after a stale socket", async () => {
  const f = await fixture();
  try {
    const user = await f.store.createUser("resume-browser", "synthetic-fixture-password");
    const device = f.store.createDevice(user.id, "Browser", ["browser"], "browser");
    const agent = f.store.createAgentConnection(user.id, "Fixture", {
      mode: "all",
      capabilities: ["browser"],
      overrides: [],
    });
    const open = () =>
      rpc(f.url, agent.key, "session_open", { device_id: device.device.id, capabilities: ["browser"] });
    const oldDispatches: JsonObject[] = [];
    const stale = await connect(
      f,
      device.key,
      "browser",
      (frame) => oldDispatches.push(frame),
      undefined,
      false,
    );
    const echo = (nonce: Buffer) => stale.socket.pong(nonce);
    stale.socket.on("ping", echo);
    const oldSession = (await open()).value;
    const inFlight = await f.control.execute(
      agent.agentConnection,
      oldSession.id,
      "browser_open",
      { url: "https://fixture.invalid/" },
      "old-navigation",
      false,
    );
    stale.socket.off("ping", echo);

    const challenged = once(stale.socket, "ping");
    const retired = once(stale.socket, "close");
    const opening = open();
    assert.equal(
      await Promise.race([challenged.then(() => "challenged"), opening.then(() => "opened")]),
      "challenged",
    );
    const [nonce] = await challenged;
    const wrongNonce = Buffer.from(nonce);
    wrongNonce[0] ^= 1;
    stale.socket.pong(wrongNonce);
    await retired;
    assert.equal(f.store.session(oldSession.id)?.status, "connection_lost");
    assert.equal(f.store.operation(inFlight.operation_id)?.status, "outcome_unknown");
    assert.equal(oldDispatches.length, 1);
    assert.equal(oldDispatches[0]!.operation_id, inFlight.operation_id);
    assert.deepEqual(f.store.sessions(device.device.id), []);
    const offlineOpening = f.control.openSession(agent.agentConnection, device.device.id, ["browser"]);
    assert.equal(await Promise.race([offlineOpening.then(() => "opened"), delay(50, "waiting")]), "waiting");

    const dispatches: JsonObject[] = [];
    const fresh = await connect(f, device.key, "browser", (frame, socket) => {
      dispatches.push(frame);
      socket.send(
        JSON.stringify({
          type: "result",
          operation_id: frame.operation_id,
          connection_epoch: frame.connection_epoch,
          status: "executed",
          result: { text: "fresh browser" },
        }),
      );
    });
    const opened = await opening;
    assert.equal(opened.isError, undefined);
    assert.notEqual(opened.value.id, oldSession.id);
    const offlineOpened = await offlineOpening;
    assert.notEqual(offlineOpened.id, oldSession.id);
    assert.notEqual(offlineOpened.id, opened.value.id);
    assert.equal(offlineOpened.device_id, device.device.id);
    assert.ok(fresh.welcome.connection_epoch > stale.welcome.connection_epoch);
    await assert.rejects(f.control.execute(agent.agentConnection, oldSession.id, "browser_read", {}), {
      code: "session_connection_lost",
    });
    const read = () =>
      rpc(f.url, agent.key, "browser_read", { session_id: opened.value.id, operation_id: "fresh-read" });
    const receipts = await Promise.all([read(), read()]);
    const receipt = receipts.find(({ value }) => value.status === "executed");
    assert.ok(receipt);
    assert.equal(receipt.value.status, "executed");
    assert.equal(receipt.value.result.text, "fresh browser");
    assert.equal(receipts[0]!.value.operation_id, receipts[1]!.value.operation_id);
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0]!.connection_epoch, fresh.welcome.connection_epoch);
  } finally {
    await f.dispose();
  }
});

test("browser session waiting offline rechecks the device key and Agent connection", async () => {
  const f = await fixture();
  try {
    const owner = await f.store.createUser("offline-browser", "synthetic-fixture-password");
    const { device } = f.store.createDevice(owner.id, "Browser", ["browser"], "browser");
    const policy = { mode: "all" as const, capabilities: ["browser" as const], overrides: [] };
    const revoked = f.store.createAgentConnection(owner.id, "Revoked", policy);
    const active = f.store.createAgentConnection(owner.id, "Active", policy);
    const mustReject = async (opening: Promise<unknown>, code: string) => {
      await assert.rejects(opening, { code });
      assert.deepEqual(f.store.sessions(device.id), []);
    };
    const revokedWait = mustReject(
      f.control.openSession(revoked.agentConnection, device.id, ["browser"]),
      "unauthorized",
    );
    f.store.revokeAgentConnection(revoked.agentConnection.id);
    await revokedWait;
    const rotatedWait = mustReject(
      f.control.openSession(active.agentConnection, device.id, ["browser"]),
      "device_offline",
    );
    f.store.rotateDevice(device.id);
    await rotatedWait;
  } finally {
    await f.dispose();
  }
});

test("browser session opening respects a local pause after its socket closes", async () => {
  const f = await fixture();
  try {
    const owner = await f.store.createUser("paused-offline-browser", "synthetic-fixture-password");
    const { device, key } = f.store.createDevice(owner.id, "Browser", ["browser"], "browser");
    const agent = f.store.createAgentConnection(owner.id, "Fixture", {
      mode: "all",
      capabilities: ["browser"],
      overrides: [],
    });
    const { socket, welcome } = await connect(f, key, "browser");
    const message = once(socket, "message");
    socket.send(
      JSON.stringify({ type: "heartbeat", paused: true, connection_epoch: welcome.connection_epoch }),
    );
    assert.equal(JSON.parse((await message)[0].toString()).type, "stop");
    const closed = once(socket, "close");
    socket.close();
    await closed;
    const deadline = Date.now() + 5000;
    while (f.control.deviceView(device).status !== "offline" && Date.now() < deadline) await delay(10);
    assert.equal(f.control.deviceView(device).status, "offline");
    await assert.rejects(f.control.openSession(agent.agentConnection, device.id, ["browser"]), {
      code: "device_paused",
    });
  } finally {
    await f.dispose();
  }
});

test("a browser transport without liveness confirmation cannot create a session", async () => {
  const f = await fixture();
  try {
    const owner = await f.store.createUser("unverified-browser", "synthetic-fixture-password");
    const device = f.store.createDevice(owner.id, "Browser", ["browser"], "browser");
    const agent = f.store.createAgentConnection(owner.id, "Fixture", {
      mode: "all",
      capabilities: ["browser"],
      overrides: [],
    });
    await f.control.attachConnection(
      device.key,
      "browser",
      { capabilities: { browser: true } },
      {
        async send() {},
        async close() {},
      },
    );
    const refused = await rpc(f.url, agent.key, "session_open", {
      device_id: device.device.id,
      capabilities: ["browser"],
    });
    assert.equal(refused.value.error.code, "device_offline");
    assert.deepEqual(f.store.sessions(device.device.id), []);
  } finally {
    await f.dispose();
  }
});

test("browser dispatch rechecks authorization after its WebSocket challenge", async () => {
  const f = await fixture();
  try {
    const user = await f.store.createUser("revoked-browser", "synthetic-fixture-password");
    const device = f.store.createDevice(user.id, "Browser", ["browser"], "browser");
    const agent = f.store.createAgentConnection(user.id, "Fixture", {
      mode: "all",
      capabilities: ["browser"],
      overrides: [],
    });
    const dispatches: JsonObject[] = [];
    const { socket } = await connect(
      f,
      device.key,
      "browser",
      (frame) => dispatches.push(frame),
      undefined,
      false,
    );
    const echo = (nonce: Buffer) => socket.pong(nonce);
    socket.on("ping", echo);
    const session = await f.control.openSession(agent.agentConnection, device.device.id, ["browser"]);
    socket.off("ping", echo);

    const challenged = once(socket, "ping");
    const execution = f.control.execute(
      agent.agentConnection,
      session.id,
      "browser_read",
      {},
      undefined,
      false,
    );
    assert.equal(
      await Promise.race([challenged.then(() => "challenged"), execution.then(() => "dispatched")]),
      "challenged",
    );
    f.store.revokeAgentConnection(agent.agentConnection.id);
    socket.pong((await challenged)[0]);
    await assert.rejects(execution, { code: "unauthorized" });
    assert.deepEqual(dispatches, []);
  } finally {
    await f.dispose();
  }
});

for (const tool of ["session_open", "browser_read", "browser_exec"] as const) {
  test(`closing the MCP HTTP request prevents ${tool} admission during a browser challenge`, async (t) => {
    const f = await fixture();
    try {
      const user = await f.store.createUser("cancelled-browser", "synthetic-fixture-password");
      const device = f.store.createDevice(user.id, "Browser", ["browser"], "browser");
      const agent = f.store.createAgentConnection(user.id, "Fixture", {
        mode: "all",
        capabilities: ["browser"],
        overrides: [],
      });
      const dispatches: JsonObject[] = [];
      const collect = (frame: JsonObject) => dispatches.push(frame);
      const { socket, welcome } = await connect(f, device.key, "browser", collect, undefined, false);
      const openSession = t.mock.method(f.control, "openSession");
      const execute = t.mock.method(f.control, "execute");
      const echo = (nonce: Buffer) => socket.pong(nonce);
      const operationId = "fixture-cancel";
      let sessionId: string | undefined;
      let args: JsonObject = { device_id: device.device.id, capabilities: ["browser"] };
      if (tool !== "session_open") {
        socket.on("ping", echo);
        const session = await f.control.openSession(agent.agentConnection, device.device.id, ["browser"]);
        socket.off("ping", echo);
        sessionId = session.id;
        args = {
          session_id: sessionId,
          operation_id: operationId,
          ...(tool === "browser_exec" ? { code: "return await page.read();" } : {}),
        };
      }

      const caller = new AbortController();
      const disconnected = new Promise<void>((resolve) => {
        f.app.server.once("request", (_request, response) => response.once("close", () => resolve()));
      });
      const challenge = once(socket, "ping");
      const requested = rpc(f.url, agent.key, tool, args, caller.signal);
      assert.equal(
        await Promise.race([challenge.then(() => "challenged"), requested.then(() => "accepted")]),
        "challenged",
      );
      const surviving =
        tool === "session_open"
          ? f.control.openSession(agent.agentConnection, device.device.id, ["browser"])
          : undefined;
      caller.abort();
      await assert.rejects(requested, { name: "AbortError" });
      await disconnected;
      const admission = (tool === "session_open" ? openSession : execute).mock.calls[0]?.result;
      assert.ok(admission);
      assert.equal(
        await Promise.race([
          assert.rejects(admission, /aborted|connection closed/i).then(() => "cancelled"),
          delay(1000, "waiting"),
        ]),
        "cancelled",
        "the request should be released before the shared probe times out",
      );

      if (sessionId) {
        const [nonce] = await challenge;
        const acknowledgement = once(socket, "message");
        socket.pong(nonce);
        socket.send(JSON.stringify({ type: "heartbeat", connection_epoch: welcome.connection_epoch }));
        assert.equal(JSON.parse((await acknowledgement)[0].toString()).type, "heartbeat_ack");
        const keyHash = createHash("sha256")
          .update(JSON.stringify([agent.agentConnection.id, sessionId, operationId]))
          .digest("base64url");
        assert.equal(f.store.operationForKey(keyHash), undefined);
      } else {
        assert.deepEqual(f.store.sessions(device.device.id), []);
        const [nonce] = await challenge;
        socket.pong(nonce);
        const session = await surviving;
        assert.ok(session);
        assert.deepEqual(
          f.store.sessions(device.device.id).map(({ id }) => id),
          [session.id],
        );
      }
      assert.deepEqual(dispatches, []);
    } finally {
      await f.dispose();
    }
  });
}

test("MCP input occupancy exposes only this connection's recoverable sessions", async () => {
  const f = await fixture();
  try {
    const user = await f.store.createUser("recovery-fixture", "synthetic-fixture-password");
    const device = f.store.createDevice(user.id, "Fixture desktop", ["input", "screen"]);
    const policy = {
      mode: "all" as const,
      capabilities: ["input" as const, "screen" as const],
      overrides: [],
    };
    const own = f.store.createAgentConnection(user.id, "First", policy);
    const other = f.store.createAgentConnection(user.id, "Second", policy);
    await f.control.attachConnection(
      device.key,
      "computer",
      { capabilities: { input: true, screen: true } },
      { async send() {}, async close() {} },
    );
    const args = { device_id: device.device.id, capabilities: ["input", "screen"] };
    const opened = await rpc(f.url, own.key, "session_open", args);
    assert.match(opened.value.id, /^ses_[A-Za-z0-9_-]{8}$/);
    assert.equal(typeof opened.value.server_time, "number");
    const busy = await rpc(f.url, own.key, "session_open", args);
    assert.equal(busy.value.error.code, "desktop_busy");
    assert.equal(busy.value.error.sessions[0].id, opened.value.id);
    const hidden = await rpc(f.url, other.key, "session_open", args);
    assert.equal(hidden.value.error.code, "desktop_busy");
    assert.deepEqual(hidden.value.error.sessions, []);
    const detail = await rpc(f.url, own.key, "device_get", { device_id: device.device.id });
    assert.equal(detail.value.sessions[0].id, opened.value.id);
    assert.equal(detail.value.sessions[0].lease_until, opened.value.lease_until);
    await rpc(f.url, own.key, "session_close", { session_id: detail.value.sessions[0].id });
    const fresh = await rpc(f.url, other.key, "session_open", args);
    assert.equal(fresh.value.status, "active");
  } finally {
    await f.dispose();
  }
});

test("browser is an independent device; revocation during wait blocks result access", async () => {
  const f = await fixture();
  try {
    const user = await f.store.createUser("owner", "test-password-long"),
      device = f.store.createDevice(user.id, "Chrome", ["browser"], "browser"),
      g = f.store.createAgentConnection(
        user.id,
        "agent",
        { mode: "selected", devices: [{ device_id: device.device.id, capabilities: ["browser"] }] },
        Date.now() / 1000 + 600,
      );
    let dispatch: JsonObject | undefined;
    const { socket } = await connect(f, device.key, "browser", (frame) => {
      dispatch = frame;
    });
    const session = await f.control.openSession(g.agentConnection, device.device.id, ["browser"]);
    const pending = f.control.execute(g.agentConnection, session.id, "browser_open", {
      url: "https://example.com",
    });
    while (!dispatch) await new Promise((resolve) => setTimeout(resolve, 1));
    f.store.revokeAgentConnection(g.agentConnection.id);
    socket.send(
      JSON.stringify({
        type: "result",
        connection_epoch: dispatch.connection_epoch,
        operation_id: dispatch.operation_id,
        status: "executed",
        result: { observation: { text: "private" } },
      }),
    );
    await assert.rejects(pending, (error) => error instanceof BridgeError && error.code === "unauthorized");
    await assert.rejects(
      () => f.control.openSession(g.agentConnection, device.device.id, ["shell"]),
      BridgeError,
    );
    socket.close();
  } finally {
    await f.dispose();
  }
});

test("pagination uses Unicode code points and native images never duplicate base64", () => {
  const stdout = "😀你".repeat(1000),
    stderr = "err".repeat(700);
  let stdout_offset = 0,
    stderr_offset = 0,
    allOut = "",
    allErr = "";
  for (let i = 0; i < 30; i++) {
    const page = commandOutputPage(
      { operation_id: "op", status: "executed", result: { stdout, stderr, exit_code: 0 } },
      1024,
      stdout_offset,
      stderr_offset,
    );
    assert.ok(characterLength(JSON.stringify(page)) <= 1024);
    const result = page.result as JsonObject;
    allOut += result.stdout;
    allErr += result.stderr;
    ({ stdout_offset, stderr_offset } = page.next_output_offsets as {
      stdout_offset: number;
      stderr_offset: number;
    });
    if (!page.output_truncated) break;
  }
  assert.equal(allOut, stdout);
  assert.equal(allErr, stderr);
  const response = contentResponse({
    result: { observation: { image_base64: "aGk=", mime_type: "image/png" } },
  });
  assert.equal(response.content.length, 2);
  const text = response.content[0]!;
  assert.equal(text.type, "text");
  assert.ok(!text.text.includes("aGk="));
});

test("desktop MCP response puts action context before the element list", () => {
  const observation = {
    elements: [{ label: "A".repeat(7000) }],
    observation_id: "obs_Fixture1",
    available_actions: ["element_click"],
    hint: "Refresh this window",
    image_base64: "aGk=",
  };
  for (const result of [observation, { observation, effect: "unverifiable" }]) {
    const response = contentResponse({ result, status: "executed", operation_id: "op_Fixture1" });
    const text = response.content[0]!;
    assert.equal(text.type, "text");
    assert.deepEqual(
      response.content.map((block) => block.type),
      ["text", "image"],
    );
    const prefix = text.text.split('"elements"')[0]!;
    for (const key of ["operation_id", "observation_id", "available_actions", "hint"])
      assert.ok(prefix.includes(`"${key}"`), key);
  }
  const failure = contentResponse(
    {
      result: { elements: observation.elements },
      error: { code: "focus_changed", hint: "Refresh this window" },
    },
    true,
  );
  const first = failure.content[0]!;
  assert.equal(first.type, "text");
  assert.ok(first.text.split('"elements"')[0]!.includes('"hint"'));
});

test("bounded transport terminates a non-draining socket", async () => {
  let terminated = false;
  const socket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send() {},
    terminate() {
      terminated = true;
    },
  } as unknown as WebSocket;
  const transport = new WebSocketTransport(socket, 20);
  await assert.rejects(transport.send({ type: "stop" }), /deadline/);
  assert.equal(terminated, true);
});

test("Device Token verification returns only its identity, rejects other credentials and revoked devices", async () => {
  const f = await fixture();
  try {
    const owner = await f.store.createUser("token-user", "fixture-password-123");
    const computer = f.store.createDevice(owner.id, "Fixture Mac", ["shell"], "computer");
    const browser = f.store.createDevice(owner.id, "Fixture Browser", ["browser"], "browser");
    for (const device of [computer, browser]) {
      const response = await fetch(f.url + "/api/device", {
        headers: { Authorization: "Bearer " + device.key, Origin: "chrome-extension://" + "a".repeat(32) },
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.deepEqual(result, {
        id: device.device.id,
        name: device.device.name,
        kind: device.device.kind,
        capabilities: device.device.capabilities,
      });
      assert.ok(!JSON.stringify(result).includes(device.key));
      assert.ok(!JSON.stringify(result).includes(owner.id));
    }
    for (const key of ["", f.adminToken, "abr_agent_invalid", "abr_device_invalid"]) {
      assert.equal(
        (await fetch(f.url + "/api/device", { headers: { Authorization: "Bearer " + key } })).status,
        401,
      );
    }
    assert.equal(
      (
        await fetch(f.url + "/api/device", {
          headers: { Authorization: "Bearer " + computer.key, Origin: "https://untrusted.example" },
        })
      ).status,
      403,
    );
    f.store.revokeDevice(computer.device.id);
    assert.equal(
      (await fetch(f.url + "/api/device", { headers: { Authorization: "Bearer " + computer.key } })).status,
      401,
    );
  } finally {
    await f.dispose();
  }
});

test("browser socket distinguishes invalidated Device Keys from protocol errors", async () => {
  const f = await fixture();
  let online: WebSocket | undefined;
  async function rejectedHello(deviceKey: string, code: number, protocol = "abridge/1") {
    const socket = new WebSocket(f.url.replace("http:", "ws:") + "/ws/browser", {
      origin: "chrome-extension://" + "a".repeat(32),
    });
    let received = 0;
    socket.on("message", () => received++);
    try {
      await once(socket, "open", { signal: AbortSignal.timeout(3000) });
      const closed = once(socket, "close", { signal: AbortSignal.timeout(3000) });
      socket.send(
        JSON.stringify({
          type: "hello",
          protocol,
          platform: "Browser extension",
          version: "0.5.0",
          paused: false,
          instance_id: "server-test-instance",
          device_key: deviceKey,
          capabilities: { browser: true },
        }),
      );
      assert.equal((await closed)[0], code);
      assert.equal(received, 0);
    } finally {
      socket.terminate();
    }
  }
  try {
    const owner = await f.store.createUser("browser-owner", "fixture-password-123");
    const { device, key } = f.store.createDevice(owner.id, "Fixture Browser", ["browser"], "browser");
    const session = await f.store.login(owner.username, "fixture-password-123");
    const headers = { cookie: "abridge_session=" + session!.token };
    const path = f.url + "/api/devices/" + device.id;
    const rotation = await fetch(path + "/credentials", { method: "POST", headers });
    assert.equal(rotation.status, 200);
    const freshKey = (await rotation.json()).key as string;
    await rejectedHello(key, 4401);
    await rejectedHello(freshKey, 4400, "abridge/unknown");
    const connected = await connect(f, freshKey, "browser");
    online = connected.socket;
    assert.equal(connected.welcome.device_id, device.id);

    const closed = once(online, "close", { signal: AbortSignal.timeout(3000) });
    assert.equal((await fetch(path + "/revoke", { method: "POST", headers })).status, 200);
    assert.equal((await closed)[0], 4403);
    await rejectedHello(freshKey, 4401);
    assert.ok(f.store.device(device.id)?.revoked_at);
  } finally {
    online?.terminate();
    await f.dispose();
  }
});

test("computer_observe accepts pid alone and rejects invalid window targets before dispatch", async () => {
  const f = await fixture();
  let socket: WebSocket | undefined;
  const dispatches: JsonObject[] = [];
  try {
    const owner = await f.store.createUser("window-owner", "fixture-password-123");
    const device = f.store.createDevice(owner.id, "Fixture Mac", ["screen"], "computer");
    const agentConnection = f.store.createAgentConnection(owner.id, "Window fixture", {
      mode: "all",
      capabilities: ["screen"],
      overrides: [],
    });
    ({ socket } = await connect(f, device.key, "computer", (frame, ws) => {
      dispatches.push(frame);
      ws.send(
        JSON.stringify({
          type: "result",
          connection_epoch: frame.connection_epoch,
          operation_id: frame.operation_id,
          status: "executed",
          result: { received: frame.arguments },
        }),
      );
    }));
    const opened = await rpc(f.url, agentConnection.key, "session_open", {
      device_id: device.device.id,
      capabilities: ["screen"],
    });
    const session = opened.value.id as string;
    const pidOnly = await rpc(f.url, agentConnection.key, "computer_observe", {
      session_id: session,
      pid: 10,
    });
    assert.equal(pidOnly.value.status, "executed");
    assert.equal(pidOnly.value.result.received.pid, 10);
    assert.equal(pidOnly.value.result.received.window_id, undefined);
    const selected = await rpc(f.url, agentConnection.key, "computer_observe", {
      session_id: session,
      pid: 10,
      window_id: 20,
    });
    assert.equal(selected.value.result.received.window_id, 20);
    const missingPid = await rpc(f.url, agentConnection.key, "computer_observe", {
      session_id: session,
      window_id: 20,
    });
    assert.equal(missingPid.isError, true);
    assert.equal(missingPid.value.error.code, "invalid_arguments");
    assert.match(missingPid.value.error.message, /pid is required/);
    for (const windowId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "20", null]) {
      const response = await fetch(f.url + "/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer " + agentConnection.key,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "computer_observe",
            arguments: { session_id: session, pid: 10, window_id: windowId },
          },
        }),
      });
      assert.equal(response.status, 200);
      const rejected = (await response.json()) as { result: { isError?: boolean; content: unknown } };
      assert.equal(rejected.result.isError, true);
      assert.match(JSON.stringify(rejected.result.content), /Provide a valid window_id/);
    }
    assert.equal(dispatches.length, 2, "Invalid targets must not reach the device");
  } finally {
    socket?.terminate();
    await f.dispose();
  }
});

test("public browser action contract rejects overlong keys before dispatch and normalizes defaults for retries", async () => {
  const f = await fixture();
  let socket: WebSocket | undefined;
  try {
    const owner = await f.store.createUser("browser-contract", "synthetic-fixture-password");
    const device = f.store.createDevice(owner.id, "Fixture browser", ["browser"], "browser");
    const agent = f.store.createAgentConnection(owner.id, "Contract fixture", {
      mode: "all",
      capabilities: ["browser"],
      overrides: [],
    });
    const dispatches: JsonObject[] = [];
    ({ socket } = await connect(f, device.key, "browser", (frame, ws) => {
      dispatches.push(frame);
      ws.send(
        JSON.stringify({
          type: "result",
          connection_epoch: frame.connection_epoch,
          operation_id: frame.operation_id,
          status: "executed",
          result: { received: frame.arguments },
        }),
      );
    }));
    const opened = await rpc(f.url, agent.key, "session_open", {
      device_id: device.device.id,
      capabilities: ["browser"],
    });
    const args = {
      session_id: opened.value.id,
      operation_id: "browser-key-boundary",
      observation_id: "obs_12345678",
      action: { type: "press", element_ref: "e1", key: "x".repeat(32) },
    };
    const response = await fetch(f.url + "/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer " + agent.key,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "browser_act",
          arguments: { ...args, action: { ...args.action, key: "x".repeat(33) } },
        },
      }),
    });
    assert.equal(response.status, 200);
    const rejected = (await response.json()) as { result: { isError?: boolean } };
    assert.equal(rejected.result.isError, true);
    assert.equal(dispatches.length, 0, "Rejected arguments never reach the device or create an operation");
    const accepted = await rpc(f.url, agent.key, "browser_act", args);
    assert.equal(accepted.value.status, "executed");
    assert.deepEqual(accepted.value.result.received, {
      observation_id: args.observation_id,
      action: args.action,
      observe_after: true,
      screenshot: false,
      wait_after_ms: 2000,
    });
    const repeated = await rpc(f.url, agent.key, "browser_act", {
      ...args,
      observe_after: true,
      screenshot: false,
      wait_after_ms: 2000,
    });
    assert.equal(repeated.value.operation_id, accepted.value.operation_id);
    assert.equal(dispatches.length, 1, "Omitted and explicit defaults identify the same operation");
  } finally {
    socket?.terminate();
    await f.dispose();
  }
});
