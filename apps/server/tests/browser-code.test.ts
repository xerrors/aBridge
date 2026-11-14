import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { WebSocket } from "ws";
import {
  browserWaitSchema,
  browserReadSchema,
  browserEvaluateSchema,
  browserLocateActSchema,
} from "@abridge/protocol";
import { createServer } from "../src/server.js";
import type { JsonObject, OperationResponse } from "../src/types.js";

test("browser code shares session state, forwards steps, deduplicates and yields cancellation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "abridge-browser-code-"));
  const server = await createServer({ dbPath: join(directory, "server.db"), port: 0 });
  let socket: WebSocket | undefined;
  try {
    const url = await server.start();
    const user = await server.store.createUser("code-fixture", "code-fixture-password");
    const grant = server.store.createGrant(user.id, "Code fixture", {
      mode: "all",
      capabilities: ["browser"],
      overrides: [],
    });
    const device = server.store.createDevice(user.id, "Code browser", ["browser"], "browser");
    const messages: JsonObject[] = [];
    socket = new WebSocket(url.replace("http:", "ws:") + "/ws/browser", {
      origin: `chrome-extension://${"a".repeat(32)}`,
    });
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as JsonObject;
      messages.push(frame);
      if (frame.type === "cancel") {
        for (const operation_id of frame.operation_ids as string[])
          socket!.send(
            JSON.stringify({
              type: "result",
              operation_id,
              connection_epoch: frame.connection_epoch,
              status: "cancelled",
            }),
          );
        return;
      }
      if (frame.type !== "dispatch" || (frame.arguments as JsonObject).selector === "#hold") return;
      socket!.send(
        JSON.stringify({
          type: "result",
          operation_id: frame.operation_id,
          connection_epoch: frame.connection_epoch,
          status: "executed",
          result: { text: "fixture result", received: frame.arguments },
        }),
      );
    });
    await once(socket, "open");
    const welcome = once(socket, "message");
    socket.send(
      JSON.stringify({
        type: "hello",
        protocol: "abridge/1",
        platform: "fixture",
        version: "0.4.4",
        paused: false,
        instance_id: "code-browser",
        device_key: device.key,
        capabilities: { browser: true, screen: false, input: false, shell: false, files: false },
      }),
    );
    await welcome;
    const session = server.control.openSession(grant.grant, device.device.id, ["browser"]);
    async function run(code: string, id: string, timeout = 20000): Promise<OperationResponse> {
      const started = await server.control.execute(
        grant.grant,
        session.id,
        "browser_exec",
        { code, timeout_ms: timeout },
        id,
        false,
      );
      return server.control.waitOperation(grant.grant, started.operation_id, 5);
    }
    const first = await run("state.count = 2; return state.count;", "code-first");
    assert.equal(first.status, "executed", JSON.stringify(first));
    assert.equal((first.result as JsonObject).value, 2);
    const second = await run(
      "state.count += 3; const result = await page.read(); return {count: state.count, text: result.text};",
      "code-second",
    );
    assert.equal(second.status, "executed", JSON.stringify(second));
    assert.deepEqual((second.result as JsonObject).value, { count: 5, text: "fixture result" });
    const dispatched = messages.filter((frame) => frame.type === "dispatch");
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0]!.tool, "browser_read");
    assert.equal((dispatched[0]!.arguments as JsonObject).limit, 12000);
    const replay = await run(
      "state.count += 3; const result = await page.read(); return {count: state.count, text: result.text};",
      "code-second",
    );
    assert.deepEqual(replay, second);
    assert.equal(messages.filter((frame) => frame.type === "dispatch").length, 1);
    await assert.rejects(run("return 9;", "code-second"), /different arguments/);
    const nextStep = once(socket, "message");
    const waiting = await server.control.execute(
      grant.grant,
      session.id,
      "browser_exec",
      {
        code: "await page.locator('#hold').click(); await page.locator('#after').click();",
        timeout_ms: 20000,
      },
      "code-held-step",
      false,
    );
    await nextStep;
    const heldDispatch = messages.find(
      (message) => message.type === "dispatch" && (message.arguments as JsonObject).selector === "#hold",
    )!;
    assert.ok(heldDispatch);
    await server.control.cancelOperation(grant.grant, waiting.operation_id);
    await server.control.waitOperation(grant.grant, heldDispatch.operation_id as string, 1);
    assert.ok(
      messages.some(
        (message) =>
          message.type === "cancel" &&
          (message.operation_ids as string[]).includes(heldDispatch.operation_id as string),
      ),
    );
    assert.equal(
      messages.some(
        (message) => message.type === "dispatch" && (message.arguments as JsonObject).selector === "#after",
      ),
      false,
    );
    const held = await server.control.execute(
      grant.grant,
      session.id,
      "browser_exec",
      { code: "await new Promise(() => {});", timeout_ms: 20000 },
      "code-local-receipt",
      false,
    );
    const epoch = messages.find((message) => message.type === "welcome")!.connection_epoch;
    socket.send(
      JSON.stringify({
        type: "result",
        operation_id: held.operation_id,
        connection_epoch: epoch,
        status: "executed",
        result: { value: "forged" },
      }),
    );
    const stillRunning = await server.control.waitOperation(grant.grant, held.operation_id, 0.03);
    assert.notEqual(stillRunning.status, "executed", "Device receipts cannot finish a server-owned runtime");
    await server.control.cancelOperation(grant.grant, held.operation_id);
    const cancelled = await server.control.execute(
      grant.grant,
      session.id,
      "browser_exec",
      { code: "while (true) {}", timeout_ms: 20000 },
      "code-cancel",
      false,
    );
    await assert.rejects(
      server.control.execute(grant.grant, session.id, "browser_observe", {}, "code-external"),
      /owns this session/,
    );
    const stopped = await server.control.cancelOperation(grant.grant, cancelled.operation_id);
    assert.ok(["outcome_unknown", "cancelled"].includes(stopped.status), JSON.stringify(stopped));
    await server.control.closeSession(grant.grant, session.id);
    const next = server.control.openSession(grant.grant, device.device.id, ["browser"]);
    const clean = await server.control.execute(
      grant.grant,
      next.id,
      "browser_exec",
      { code: "return state.count === undefined;", timeout_ms: 20000 },
      "code-clean",
      false,
    );
    const result = await server.control.waitOperation(grant.grant, clean.operation_id, 5);
    assert.equal(result.status, "executed", JSON.stringify(result));
    assert.equal((result.result as JsonObject).value, true);
  } finally {
    socket?.terminate();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("browser conditions compose selector and text and frame scope stays explicit", () => {
  assert.equal(browserWaitSchema.safeParse({ selector: "#status", text: "Saved 1" }).success, true);
  assert.equal(browserWaitSchema.safeParse({}).success, false);
  assert.equal(browserWaitSchema.safeParse({ selector: "input", state: "value" }).success, false);
  assert.equal(browserWaitSchema.safeParse({ selector: "input", state: "value", value: "" }).success, true);
  for (const [schema, args] of [
    [browserReadSchema, {}],
    [browserWaitSchema, { selector: "#status" }],
    [browserEvaluateSchema, { expression: "document.title" }],
    [browserLocateActSchema, { selector: "button", action: { type: "click" } }],
  ] as const) {
    assert.equal(schema.safeParse({ ...args, frame_selector: "iframe#report" }).success, true);
    assert.equal(schema.safeParse({ ...args, frame_selector: "" }).success, false);
  }
});
