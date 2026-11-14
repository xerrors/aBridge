import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "../src/server.js";
import { deviceHelloSchema, operationFrameSchema, PROTOCOL_VERSION } from "@abridge/protocol";
import type { JsonObject } from "../src/types.js";
import { browserWorkerFixture, SCREENSHOT } from "./fixtures/browser-worker.js";

type Content = { type: string; text?: string; data?: string; mimeType?: string };
type Observation = {
  observation_id: string;
  elements: { element_ref: string; role: string; name: string; value?: string }[];
  text: string;
};
type OperationResult = {
  status: string;
  operation_id: string;
  result: JsonObject & { observation?: Observation };
  error?: { code: string };
};
async function until(predicate: () => boolean, description: string) {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() > deadline) throw Error(`Timed out waiting for ${description}`);
    await delay(5);
  }
}
test(
  "real MCP → Node Server → actual extension worker/bridge → fixed Chrome page → scoped session close",
  { timeout: 15000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "abridge-browser-wire-"));
    const server = await createServer({ dbPath: join(dir, "server.db"), port: 0 });
    let worker: ReturnType<typeof browserWorkerFixture> | undefined;
    t.after(async () => {
      try {
        await worker?.dispose();
      } finally {
        await server.close();
        await rm(dir, { recursive: true, force: true });
      }
    });
    const url = await server.start();
    const user = await server.store.createUser("wire-fixture", "wire-fixture-password");
    const { device, key } = server.store.createDevice(user.id, "Synthetic Chrome", ["browser"], "browser");
    const { key: agentKey } = server.store.createGrant(
      user.id,
      "wire-agent",
      { mode: "selected", devices: [{ device_id: device.id, capabilities: ["browser"] }] },
      Date.now() / 1000 + 600,
    );
    let requestId = 0;
    async function rpc(method: string, params: JsonObject) {
      const response = await fetch(url + "/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${agentKey}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { result?: JsonObject; error?: unknown };
      assert.equal(body.error, undefined, JSON.stringify(body));
      assert.ok(body.result);
      return body.result;
    }
    async function tool<T>(name: string, args: JsonObject, expectedError = false) {
      const response = await rpc("tools/call", { name, arguments: args });
      assert.equal(response.isError === true, expectedError, JSON.stringify(response));
      const content = response.content as Content[];
      const text = content.find((item) => item.type === "text")?.text;
      assert.ok(text);
      return { value: JSON.parse(text) as T, content, text };
    }
    const initialized = await rpc("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "independent-browser-wire", version: "1.0" },
    });
    assert.equal((initialized.serverInfo as JsonObject).name, "aBridge");
    const listed = await rpc("tools/list", {});
    for (const name of ["browser_open", "browser_observe", "browser_act", "session_close"])
      assert.ok((listed.tools as { name: string }[]).some((tool) => tool.name === name));
    worker = browserWorkerFixture(url, device.id, key);
    await worker.load();
    await until(() => server.control.deviceView(device).status === "online", "real worker WebSocket welcome");
    assert.equal(worker.sockets.length, 1);
    const hello = worker.outgoing.find((frame) => frame.type === "hello");
    assert.ok(deviceHelloSchema.safeParse(hello).success);
    assert.equal(hello?.protocol, PROTOCOL_VERSION);
    const a = (
      await tool<{ id: string }>("session_open", { device_id: device.id, capabilities: ["browser"] })
    ).value;
    const b = (
      await tool<{ id: string }>("session_open", { device_id: device.id, capabilities: ["browser"] })
    ).value;
    const opened = await tool<OperationResult>("browser_open", {
      session_id: a.id,
      operation_id: "wire-open-a",
      url: "https://page.fixture/form",
    });
    assert.equal(opened.value.status, "executed");
    const first = opened.value.result.observation;
    assert.ok(first?.observation_id, "Default open must return an actual bridge observation");
    assert.equal(first.elements.find((item) => item.role === "textbox")?.name, "Message");
    assert.equal(worker.tabs.size, 2);
    const aTab = Number(opened.value.result.tab_id);
    assert.notEqual(aTab, 1);
    const withImage = await tool<OperationResult>("browser_open", {
      session_id: b.id,
      operation_id: "wire-open-b",
      url: "https://page.fixture/other",
      screenshot: true,
    });
    assert.equal(withImage.value.status, "executed");
    assert.ok(withImage.value.result.observation?.observation_id);
    assert.deepEqual(
      withImage.content.filter((item) => item.type === "image"),
      [{ type: "image", data: SCREENSHOT, mimeType: "image/png" }],
    );
    assert.ok(!withImage.text.includes("image_base64"), "MCP text must not duplicate the image payload");
    const bTab = Number(withImage.value.result.tab_id);
    assert.notEqual(aTab, bTab);
    const input = '你好 😀 "quoted"\n</script>';
    const fillArgs = {
      session_id: a.id,
      operation_id: "wire-fill",
      observation_id: first.observation_id,
      action: {
        type: "fill",
        element_ref: first.elements.find((item) => item.role === "textbox")!.element_ref,
        text: input,
      },
    };
    const filled = await tool<OperationResult>("browser_act", fillArgs);
    assert.equal(filled.value.status, "executed");
    assert.equal(filled.value.result.route, "replace_value");
    assert.equal(worker.tabs.get(aTab)?.text, input);
    const filledObservation = filled.value.result.observation;
    assert.ok(filledObservation?.observation_id);
    assert.equal(filledObservation.elements.find((item) => item.role === "textbox")?.value, input);
    const fillCommand = worker.commands.find((command) => command.method === "Runtime.callFunctionOn");
    assert.ok(fillCommand);
    assert.deepEqual(
      fillCommand.params.arguments,
      [{ value: input }],
      "User text is sent as a CDP argument, never interpolated into JavaScript",
    );
    assert.equal(fillCommand.params.objectId, `${aTab}:7`);
    const sideEffects = () =>
      worker!.commands.filter((command) => command.method === "Runtime.callFunctionOn");
    const effectsAfterFill = sideEffects().length;
    const replay = await tool<OperationResult>("browser_act", fillArgs);
    assert.equal(replay.value.operation_id, filled.value.operation_id);
    assert.equal(replay.value.status, "executed");
    assert.equal(
      sideEffects().length,
      effectsAfterFill,
      "A retried operation ID must not repeat a page effect",
    );
    const stale = await tool<OperationResult>(
      "browser_act",
      { ...fillArgs, operation_id: "wire-stale-ref" },
      true,
    );
    assert.equal(stale.value.status, "refused");
    assert.equal(stale.value.error?.code, "stale_observation");
    assert.equal(sideEffects().length, effectsAfterFill);
    const clicked = await tool<OperationResult>("browser_act", {
      session_id: a.id,
      operation_id: "wire-click",
      observation_id: filledObservation.observation_id,
      action: {
        type: "click",
        element_ref: filledObservation.elements.find((item) => item.role === "button")!.element_ref,
      },
    });
    assert.equal(clicked.value.status, "executed");
    assert.equal(clicked.value.result.route, "dom_event");
    assert.equal(worker.tabs.get(aTab)?.clicks, 1);
    assert.equal(worker.tabs.get(bTab)?.clicks, 0);
    assert.match(clicked.value.result.observation!.text, /Clicks: 1/);
    assert.deepEqual(sideEffects().at(-1)!.params.arguments, []);
    assert.equal(sideEffects().at(-1)!.params.objectId, `${aTab}:8`);
    for (const frame of worker.incoming.filter((frame) => frame.type === "dispatch")) {
      assert.ok(operationFrameSchema.safeParse(frame).success, JSON.stringify(frame));
      assert.equal(frame.protocol, PROTOCOL_VERSION);
      assert.equal(frame.device_id, device.id);
      assert.ok(Number(frame.grant_version) > 0);
    }
    assert.equal(
      worker.incoming.filter((frame) => frame.type === "dispatch" && frame.operation_id === "wire-fill")
        .length,
      1,
    );
    await tool("session_close", { session_id: a.id });
    await until(() => !worker!.tabs.has(aTab), "session A owned tab removal");
    assert.ok(worker.tabs.has(1));
    assert.ok(worker.tabs.has(bTab), "Closing A must preserve session B's task tab");
    assert.deepEqual(worker.session.owned_task_tabs, [bTab]);
    const remaining = await tool<OperationResult>("browser_observe", {
      session_id: b.id,
      operation_id: "wire-observe-b",
    });
    assert.equal(remaining.value.status, "executed");
    assert.ok(remaining.value.result.observation_id);
    await tool("session_close", { session_id: b.id });
    await until(() => worker!.tabs.size === 1, "session B owned tab removal");
    assert.deepEqual(worker.session.owned_task_tabs, []);
    assert.equal(worker.tabs.get(1)?.text, "personal fixture");
    assert.equal(worker.tabs.get(1)?.clicks, 0);
    assert.deepEqual(
      [...worker.removed].sort((a, b) => a - b),
      [aTab, bTab].sort((a, b) => a - b),
    );
    assert.ok(worker.attached.every((tab) => tab !== 1));
    assert.ok(worker.commands.every((command) => command.tabId !== 1));
  },
);
