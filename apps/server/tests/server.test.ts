import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
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
async function rpc(url: string, key: string, name: string, args: JsonObject = {}) {
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
) {
  const socket = new WebSocket(
    f.url.replace("http:", "ws:") + "/ws/" + (kind === "browser" ? "browser" : "device"),
    kind === "browser"
      ? { origin: "chrome-extension://" + "a".repeat(32) }
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
      platform: kind === "browser" ? "Browser extension" : "darwin",
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
    assert.equal((await fetch(f.url + "/api/setup")).status, 200);
    let res = await fetch(f.url + "/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + f.setupToken },
      body: JSON.stringify({ username: "owner", password: "test-password-long" }),
    });
    assert.equal(res.status, 200);
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    assert.equal(((await res.json()) as { username: string }).username, "owner");
    assert.equal((await fetch(f.url + "/api/me", { headers: { cookie } })).status, 200);
    assert.equal(
      (
        await fetch(f.url + "/api/setup", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + f.setupToken },
          body: JSON.stringify({ username: "other", password: "test-password-long" }),
        })
      ).status,
      403,
    );
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
      headers: { "content-type": "application/json", origin: "chrome-extension://" + "a".repeat(32) },
      body: JSON.stringify({ username: "owner", password: "test-password-long", name: "Browser" }),
    });
    assert.equal(res.status, 200);
    const browser = (await res.json()) as { id: string; key: string };
    assert.ok(browser.key.startsWith("abr_device_"));
    assert.equal(f.store.device(browser.id)!.kind, "browser");
  } finally {
    await f.dispose();
  }
});

test("real MCP + WebSocket: all 18 tools, direct shell result, idempotency, yielding, files and image blocks", async () => {
  const f = await fixture();
  try {
    const user = await f.store.createUser("owner", "test-password-long"),
      device = f.store.createDevice(user.id, "Mac", ["shell", "files", "screen", "input"]);
    const grant = f.store.createGrant(
      user.id,
      "agent",
      [device.device.id],
      ["shell", "files", "screen", "input"],
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
                observation_id: "obs_" + "a".repeat(32),
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
        authorization: "Bearer " + grant.key,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    assert.equal(((await list.json()) as { result: { tools: unknown[] } }).result.tools.length, 18);
    const opened = await rpc(f.url, grant.key, "session_open", {
        device_id: device.device.id,
        capabilities: ["shell", "files", "screen"],
      }),
      session = opened.value.id;
    const command = await rpc(f.url, grant.key, "command_execute", {
      session_id: session,
      command: "echo hello",
      operation_id: "op_test",
    });
    assert.equal(command.value.status, "executed");
    assert.equal(command.value.result.stdout, "hello 😀\n");
    assert.equal(dispatches, 1);
    await rpc(f.url, grant.key, "command_execute", {
      session_id: session,
      command: "echo hello",
      operation_id: "op_test",
    });
    assert.equal(dispatches, 1);
    const conflict = await rpc(f.url, grant.key, "command_execute", {
      session_id: session,
      command: "echo different",
      operation_id: "op_test",
    });
    assert.equal(conflict.value.error.code, "operation_conflict");
    const yielded = await rpc(f.url, grant.key, "command_execute", {
      session_id: session,
      command: "delay",
      wait_seconds: 0,
    });
    assert.equal(yielded.value.status, "dispatched");
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
    const status = await rpc(f.url, grant.key, "command_status", {
      operation_id: yielded.value.operation_id,
    });
    assert.equal(status.value.result.stdout, "later");
    const file = await rpc(f.url, grant.key, "file_read", { session_id: session, path: "/tmp/test" });
    assert.equal(file.value.result.content, "file content");
    const observation = await rpc(f.url, grant.key, "computer_observe", { session_id: session });
    assert.equal(observation.content[1]!.type, "image");
    assert.equal(observation.value.result.image_base64, undefined);
    const denied = await rpc(f.url, grant.key, "browser_open", {
      session_id: session,
      url: "https://example.com",
    });
    assert.equal(denied.value.error.code, "forbidden");
    await rpc(f.url, grant.key, "session_close", { session_id: session });
    socket.close();
  } finally {
    await f.dispose();
  }
});

test("browser is an independent device; revocation during wait blocks result access", async () => {
  const f = await fixture();
  try {
    const user = await f.store.createUser("owner", "test-password-long"),
      device = f.store.createDevice(user.id, "Chrome", ["browser"], "browser"),
      g = f.store.createGrant(user.id, "agent", [device.device.id], ["browser"], Date.now() / 1000 + 600);
    let dispatch: JsonObject | undefined;
    const { socket } = await connect(f, device.key, "browser", (frame) => {
      dispatch = frame;
    });
    const session = f.control.openSession(g.grant, device.device.id, ["browser"]);
    const pending = f.control.execute(g.grant, session.id, "browser_open", {
      url: "https://example.com",
      observe_after: true,
    });
    while (!dispatch) await new Promise((resolve) => setTimeout(resolve, 1));
    f.store.revokeGrant(g.grant.id);
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
    assert.throws(() => f.control.openSession(g.grant, device.device.id, ["shell"]), BridgeError);
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
