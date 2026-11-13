import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createServer } from "../src/server.js";
import type { JsonObject } from "../src/types.js";

test("act MCP schemas expose the shared delay and forward validated defaults without dispatching invalid waits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "abridge-act-wait-"));
  const server = await createServer({ dbPath: join(directory, "server.db"), port: 0 });
  const sockets: WebSocket[] = [];
  const dispatches: JsonObject[] = [];
  try {
    const url = await server.start();
    const user = await server.store.createUser("wait-fixture", "wait-fixture-password");
    const grant = server.store.createGrant(user.id, "Wait fixture", {
      mode: "all",
      capabilities: ["screen", "input", "browser"],
      overrides: [],
    });
    let sequence = 0;
    async function rpc(method: string, params: JsonObject = {}) {
      const response = await fetch(url + "/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer " + grant.key,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
      });
      assert.equal(response.status, 200);
      return (await response.json()) as {
        result?: {
          tools?: {
            name: string;
            inputSchema: {
              properties: Record<string, { default?: unknown; minimum?: number; maximum?: number }>;
            };
          }[];
          isError?: boolean;
          content?: { text?: string }[];
        };
        error?: unknown;
      };
    }
    const listed = (await rpc("tools/list")).result!.tools!;
    for (const name of ["computer_act", "browser_act"]) {
      const shape = listed.find((tool) => tool.name === name)!.inputSchema.properties.wait_after_ms;
      assert.ok(shape, `${name} must advertise wait_after_ms`);
      assert.equal(shape.default, 2000);
      assert.equal(shape.minimum, 0);
      assert.equal(shape.maximum, 10000);
    }
    for (const kind of ["computer", "browser"] as const) {
      const capabilities = kind === "computer" ? (["screen", "input"] as const) : (["browser"] as const);
      const device = server.store.createDevice(user.id, kind, [...capabilities], kind);
      const socket = new WebSocket(
        url.replace("http:", "ws:") + `/ws/${kind === "computer" ? "device" : "browser"}`,
        kind === "computer"
          ? { headers: { authorization: "Bearer " + device.key } }
          : { origin: `chrome-extension://${"a".repeat(32)}` },
      );
      sockets.push(socket);
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as JsonObject;
        if (frame.type !== "dispatch") return;
        dispatches.push(frame);
        socket.send(
          JSON.stringify({
            type: "result",
            operation_id: frame.operation_id,
            connection_epoch: frame.connection_epoch,
            status: "executed",
            result: { received: frame.arguments },
          }),
        );
      });
      await once(socket, "open");
      const welcomed = once(socket, "message");
      socket.send(
        JSON.stringify({
          type: "hello",
          protocol: "abridge/1",
          platform: "fixture",
          version: "0.4.0",
          paused: false,
          instance_id: `wait-${kind}`,
          device_key: device.key,
          capabilities: {
            screen: kind === "computer",
            input: kind === "computer",
            browser: kind === "browser",
            shell: false,
            files: false,
          },
        }),
      );
      await welcomed;
      const opened = await rpc("tools/call", {
        name: "session_open",
        arguments: { device_id: device.device.id, capabilities: [...capabilities] },
      });
      const session = JSON.parse(opened.result!.content![0]!.text!) as { id: string };
      const args: JsonObject = {
        session_id: session.id,
        observation_id: kind === "computer" ? "obs_" + "a".repeat(32) : "browser-fixture-observation",
        action: { type: "click", element_ref: "e1" },
      };
      for (const value of [undefined, 0, 25, 10000]) {
        const response = await rpc("tools/call", {
          name: `${kind}_act`,
          arguments: {
            ...args,
            operation_id: `wait-${kind}-${sequence}`,
            ...(value === undefined ? {} : { wait_after_ms: value }),
          },
        });
        assert.notEqual(response.result?.isError, true, JSON.stringify(response));
        assert.equal(response.error, undefined);
        assert.equal((dispatches.at(-1)!.arguments as JsonObject).wait_after_ms, value ?? 2000);
      }
      for (const value of [-1, 10001, 0.5, "2000", null]) {
        const count = dispatches.length;
        const response = await rpc("tools/call", {
          name: `${kind}_act`,
          arguments: { ...args, wait_after_ms: value },
        });
        assert.ok(response.error || response.result?.isError, JSON.stringify(response));
        assert.equal(dispatches.length, count, "Invalid wait must be rejected before device dispatch");
      }
    }
  } finally {
    for (const socket of sockets) socket.terminate();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
