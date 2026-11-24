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
import type { DeviceConnection, JsonObject, OperationResponse } from "../src/types.js";
import { Store } from "../src/store.js";
import { ControlService } from "../src/control.js";

test("browser code shares session state, forwards steps, deduplicates and yields cancellation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "abridge-browser-code-"));
  const server = await createServer({ dbPath: join(directory, "server.db"), port: 0 });
  let socket: WebSocket | undefined;
  try {
    const url = await server.start();
    const user = await server.store.createUser("code-fixture", "code-fixture-password");
    const agentConnection = server.store.createAgentConnection(user.id, "Code fixture", {
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
    const session = await server.control.openSession(agentConnection.agentConnection, device.device.id, [
      "browser",
    ]);
    async function run(code: string, id: string, timeout = 20000): Promise<OperationResponse> {
      const started = await server.control.execute(
        agentConnection.agentConnection,
        session.id,
        "browser_exec",
        { code, timeout_ms: timeout },
        id,
        false,
      );
      return server.control.waitOperation(agentConnection.agentConnection, started.operation_id, 5);
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
    assert.deepEqual({ ...replay, session: undefined }, { ...second, session: undefined });
    assert.equal(replay.session!.id, session.id);
    assert.ok(replay.session!.lease_until >= second.session!.lease_until);
    assert.equal(messages.filter((frame) => frame.type === "dispatch").length, 1);
    await assert.rejects(run("return 9;", "code-second"), /different arguments/);
    for (const completed of [0, 1]) {
      const before = messages.filter((frame) => frame.type === "dispatch").length;
      const invalid = await run(
        `${completed ? "await page.read();" : ""} await page.evaluate('');`,
        `code-invalid-step-${completed}`,
      );
      assert.equal(invalid.status, completed ? "failed" : "refused", JSON.stringify(invalid));
      const result = invalid.result as JsonObject;
      assert.equal(result.steps_completed, completed);
      const step = result.failed_step as JsonObject;
      assert.equal(step.method, "evaluate");
      assert.equal(step.status, "refused");
      assert.equal(
        server.store.operation(String(step.operation_id)),
        undefined,
        "Invalid step was never dispatched",
      );
      assert.ok((step.error as JsonObject).code);
      assert.equal(messages.filter((frame) => frame.type === "dispatch").length, before + completed);
    }
    const nextStep = once(socket, "message");
    const waiting = await server.control.execute(
      agentConnection.agentConnection,
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
    await server.control.cancelOperation(agentConnection.agentConnection, waiting.operation_id);
    await server.control.waitOperation(
      agentConnection.agentConnection,
      heldDispatch.operation_id as string,
      1,
    );
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
    const timedOut = await run(
      "await page.locator('#hold').click(); await page.locator('#after-timeout').click();",
      "code-timeout",
      100,
    );
    assert.equal(timedOut.status, "outcome_unknown", JSON.stringify(timedOut));
    const timedOutStep = (timedOut.result as JsonObject).failed_step as JsonObject;
    assert.equal(timedOutStep.method, "locate_act");
    assert.equal(timedOutStep.status, "outcome_unknown");
    await server.control.waitOperation(agentConnection.agentConnection, String(timedOutStep.operation_id), 1);
    assert.ok(
      messages.some(
        (message) =>
          message.type === "cancel" &&
          (message.operation_ids as string[]).includes(String(timedOutStep.operation_id)),
      ),
    );
    assert.equal(
      messages.some(
        (message) =>
          message.type === "dispatch" && (message.arguments as JsonObject).selector === "#after-timeout",
      ),
      false,
    );
    const held = await server.control.execute(
      agentConnection.agentConnection,
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
    const stillRunning = await server.control.waitOperation(
      agentConnection.agentConnection,
      held.operation_id,
      0.03,
    );
    assert.notEqual(stillRunning.status, "executed", "Device receipts cannot finish a server-owned runtime");
    await server.control.cancelOperation(agentConnection.agentConnection, held.operation_id);
    const cancelled = await server.control.execute(
      agentConnection.agentConnection,
      session.id,
      "browser_exec",
      { code: "await page.sleep(10000);", timeout_ms: 20000 },
      "code-cancel",
      false,
    );
    await assert.rejects(
      server.control.execute(
        agentConnection.agentConnection,
        session.id,
        "browser_observe",
        {},
        "code-external",
      ),
      /owns this session/,
    );
    const stopped = await server.control.cancelOperation(
      agentConnection.agentConnection,
      cancelled.operation_id,
    );
    assert.ok(["outcome_unknown", "cancelled"].includes(stopped.status), JSON.stringify(stopped));
    await server.control.closeSession(agentConnection.agentConnection, session.id);
    const next = await server.control.openSession(agentConnection.agentConnection, device.device.id, [
      "browser",
    ]);
    const clean = await server.control.execute(
      agentConnection.agentConnection,
      next.id,
      "browser_exec",
      { code: "return state.count === undefined;", timeout_ms: 20000 },
      "code-clean",
      false,
    );
    const result = await server.control.waitOperation(agentConnection.agentConnection, clean.operation_id, 5);
    assert.equal(result.status, "executed", JSON.stringify(result));
    assert.equal((result.result as JsonObject).value, true);
  } finally {
    socket?.terminate();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const ending of [
  "disconnect",
  "disconnect-zero",
  "before-dispatch",
  "rotate",
  "confirmed-receipt",
] as const)
  test(`browser execution preserves step diagnostics on ${ending}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "abridge-browser-progress-"));
    const store = new Store(join(directory, "server.db"));
    const control = new ControlService(store);
    let ticket: DeviceConnection | undefined;
    let reached!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const frames: JsonObject[] = [];
    try {
      const user = await store.createUser("progress-fixture", "progress-fixture-password");
      const device = store.createDevice(user.id, "Progress browser", ["browser"], "browser");
      let { agentConnection } = store.createAgentConnection(user.id, "Progress agent", {
        mode: "all",
        capabilities: ["browser"],
        overrides: [],
      });
      ticket = await control.attachConnection(
        device.key,
        "browser",
        { capabilities: { browser: true } },
        {
          async probe() {
            if (ending === "before-dispatch" && frames.length === 1) {
              reached();
              return false;
            }
            return true;
          },
          async send(frame) {
            if (frame.type !== "dispatch") return;
            frames.push(frame);
            if (ending === "disconnect-zero") {
              reached();
              return;
            }
            if (frames.length === 1) {
              await control.receive(ticket!, {
                type: "result",
                connection_epoch: ticket!.epoch,
                operation_id: frame.operation_id,
                status: "executed",
                result: { text: "fixture" },
              });
              if (ending === "confirmed-receipt") {
                // Disconnect before execute's awaiting continuation counts the receipt.
                control.dropConnection(ticket!);
                reached();
              }
            } else reached();
          },
          async close() {},
        },
      );
      const session = await control.openSession(agentConnection, device.device.id, ["browser"]);
      const started = await control.execute(
        agentConnection,
        session.id,
        "browser_exec",
        {
          code: "await page.read(); await page.locator('#hold').click(); await page.read();",
          timeout_ms: 20000,
        },
        "progress-outer",
        false,
      );
      await dispatched;
      if (ending === "disconnect" || ending === "disconnect-zero" || ending === "before-dispatch")
        control.dropConnection(ticket);
      if (ending === "rotate") ({ agentConnection } = await control.rotateAgentConnection(agentConnection));
      const result = control.operationStatus(agentConnection, started.operation_id);
      assert.equal(result.status, "outcome_unknown");
      const progress = result.result as JsonObject;
      assert.equal(progress.steps_completed, ending === "disconnect-zero" ? 0 : 1, JSON.stringify(result));
      if (ending === "confirmed-receipt") assert.equal(progress.failed_step, undefined);
      else if (ending === "before-dispatch") {
        const failed = progress.failed_step as JsonObject;
        assert.equal(store.operation(String(failed.operation_id)), undefined);
        assert.equal(failed.method, "locate_act");
        assert.equal(failed.status, "refused");
      } else {
        const failed = progress.failed_step as JsonObject;
        assert.equal(failed.operation_id, frames[ending === "disconnect-zero" ? 0 : 1]!.operation_id);
        assert.equal(failed.method, ending === "disconnect-zero" ? "read" : "locate_act");
        assert.equal(failed.status, "outcome_unknown");
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(
        frames.length,
        ending === "disconnect" || ending === "rotate" ? 2 : 1,
        "No queued step may run",
      );
      assert.deepEqual(
        { ...control.operationStatus(agentConnection, started.operation_id), session: undefined },
        { ...result, session: undefined },
        "Late runtime completion cannot replace diagnostics",
      );
    } finally {
      await control.shutdown();
      store.close();
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

test("native input receipt deadline includes the hold and verification budgets", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "abridge-receipt-budget-"));
  const store = new Store(join(directory, "server.db"));
  const now = Date.now() / 1000;
  const control = new ControlService(
    store,
    () => now,
    () => 0,
  );
  const frames: JsonObject[] = [];
  try {
    const user = await store.createUser("budget-fixture", "budget-fixture-password");
    const device = store.createDevice(user.id, "Budget browser", ["browser"], "browser");
    const { agentConnection } = store.createAgentConnection(user.id, "Receipt test", {
      mode: "all",
      capabilities: ["browser"],
      overrides: [],
    });
    const ticket = await control.attachConnection(
      device.key,
      "browser",
      { capabilities: { browser: true } },
      {
        async probe() {
          return true;
        },
        async send(frame) {
          frames.push(frame);
        },
        async close() {},
      },
    );
    const session = await control.openSession(agentConnection, device.device.id, ["browser"]);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
    for (const tool of ["browser_act", "browser_locate_act"] as const) {
      const args = {
        ...(tool === "browser_act"
          ? { observation_id: "obs_12345678", wait_after_ms: 10000 }
          : { selector: "#buy" }),
        action: { type: "click", hold_ms: 10000, ...(tool === "browser_act" ? { element_ref: "e1" } : {}) },
        verify: { selector: "#count", state: "value", value: "3", timeout_ms: 20000 },
      };
      const operation = control.execute(agentConnection, session.id, tool, args);
      await nextTurn();
      const frame = frames.at(-1)!;
      assert.equal(frame.type, "dispatch");
      assert.equal(frame.expires_at, now + 30);
      await assert.rejects(control.waitOperation(agentConnection, String(frame.operation_id), 31), {
        code: "invalid_wait",
      });
      t.mock.timers.tick(59999);
      await nextTurn();
      assert.equal(frames.at(-1), frame, "server must not cancel during the declared receipt budget");
      if (tool === "browser_act") {
        await control.receive(ticket, {
          type: "result",
          connection_epoch: ticket.epoch,
          operation_id: frame.operation_id,
          status: "executed",
          result: { input_dispatched: true, verification: { matched: false } },
        });
        assert.equal((await operation).status, "executed");
      } else {
        t.mock.timers.tick(1);
        assert.equal((await operation).error?.code, "result_timeout");
      }
    }
    const read = control.execute(agentConnection, session.id, "browser_read", {});
    await nextTurn();
    t.mock.timers.tick(30000);
    assert.equal((await read).error?.code, "result_timeout");
  } finally {
    await control.shutdown();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
