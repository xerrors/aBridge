import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Computer } from "../src/computer.js";
import type { NativeDriver, NativeObservation } from "../src/native.js";

function fixture() {
  let updated = false,
    observations = 0,
    actions = 0;
  let actedAt = 0,
    capturedAt = 0;
  let started!: () => void;
  const actionStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const native: NativeDriver = {
    async diagnostics() {
      return {};
    },
    async apps() {
      return [];
    },
    async windows() {
      return [];
    },
    async open() {},
    async observe(_session, _target, screenshot): Promise<NativeObservation> {
      observations++;
      capturedAt = performance.now();
      const label = updated ? "Updated UI" : "Previous UI";
      return {
        elements: [{ token: "button", role: "AXButton", label, depth: 1 }],
        ...(screenshot
          ? {
              image_base64: Buffer.from(label).toString("base64"),
              mime_type: "image/png",
              width: 100,
              height: 80,
            }
          : {}),
      };
    },
    async act() {
      actions++;
      actedAt = performance.now();
      setTimeout(() => {
        updated = true;
      }, 20);
      started();
      return { action_executed: true };
    },
    async release() {},
    async shutdown() {},
  };
  const computer = new Computer(native);
  return {
    computer,
    actionStarted,
    counts: () => ({ actions, observations }),
    elapsedToCapture: () => capturedAt - actedAt,
  };
}
async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
const args = (observation: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  observation_id: observation.observation_id,
  action: { type: "click", element_ref: "e1" },
  screenshot: true,
  ...extra,
});

test("desktop act waits the default 2000 ms after delivery before observing and capturing updated UI", async () => {
  const f = fixture();
  const first = await f.computer.observe("session", { pid: 10, window_id: 20 });
  const pending = f.computer.act("session", args(first));
  await f.actionStarted;
  await settle();
  await delay(30);
  assert.equal(f.counts().observations, 1, "Follow-up capture must not run before the default settle delay");
  const result = await pending;
  assert.ok(f.elapsedToCapture() >= 1990, "Default capture must follow the 2000 ms settle delay");
  const observation = result.observation as Record<string, unknown>;
  assert.equal(Buffer.from(String(observation.image_base64), "base64").toString(), "Updated UI");
  assert.deepEqual(f.counts(), { actions: 1, observations: 2 });
});

test("desktop act respects configured waits and allows zero to capture immediately", async () => {
  const f = fixture();
  const first = await f.computer.observe("session", { pid: 10, window_id: 20 });
  const pending = f.computer.act("session", args(first, { wait_after_ms: 50 }));
  await f.actionStarted;
  await settle();
  await delay(25);
  assert.equal(f.counts().observations, 1);
  assert.ok((await pending).observation);
  assert.ok(f.elapsedToCapture() >= 45, "Configured settle delay must precede capture");
  const immediate = fixture();
  const before = await immediate.computer.observe("immediate", { pid: 10, window_id: 20 });
  const captured = await immediate.computer.act("immediate", args(before, { wait_after_ms: 0 }));
  assert.equal(
    Buffer.from(String((captured.observation as Record<string, unknown>).image_base64), "base64").toString(),
    "Previous UI",
  );
});

test("desktop act-only skips waiting and invalid wait values refuse before an action", async () => {
  const f = fixture();
  const first = await f.computer.observe("session", { pid: 10, window_id: 20 });
  for (const wait_after_ms of [-1, 0.5, "20", null, NaN, Infinity, 10001]) {
    await assert.rejects(f.computer.act("session", args(first, { wait_after_ms })), {
      code: "invalid_arguments",
    });
    assert.equal(f.counts().actions, 0);
  }
  assert.equal(
    (await f.computer.act("session", args(first, { observe_after: false, screenshot: false })))
      .action_executed,
    true,
  );
  assert.equal(f.counts().observations, 1);
});

test("aborting or closing during the post-act wait prevents capture without repeating the action", async () => {
  for (const close of [false, true]) {
    const f = fixture();
    const controller = new AbortController();
    const first = await f.computer.observe("session", { pid: 10, window_id: 20 });
    const pending = f.computer.act("session", args(first), controller.signal);
    await f.actionStarted;
    await settle();
    const cancelledAt = performance.now();
    const closing = close ? f.computer.closeSession("session") : undefined;
    if (!close) controller.abort();
    await settle();
    const result = await pending;
    await closing;
    assert.ok(performance.now() - cancelledAt < 1000, "Cancellation must interrupt the settle wait");
    assert.equal(result.action_executed, true);
    assert.ok(result.observation_error);
    assert.equal(result.observation, undefined);
    assert.deepEqual(f.counts(), { actions: 1, observations: 1 });
  }
});

test("window selection survives invalidated references and failed follow-up observations", async () => {
  for (const failFollowUp of [false, true]) {
    const f = fixture();
    const target = { pid: 10, window_id: 20 };
    const first = await f.computer.observe("session", target);
    const observe = f.computer.native.observe;
    let failOnce = failFollowUp;
    f.computer.native.observe = async (...arguments_) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("Window temporarily unavailable");
      }
      return observe(...arguments_);
    };
    const result = await f.computer.act(
      "session",
      args(first, { observe_after: failFollowUp, screenshot: false, wait_after_ms: 0 }),
    );
    assert.equal(result.action_executed, true);
    if (failFollowUp) assert.ok(result.observation_error);
    await assert.rejects(f.computer.act("session", args(first)), { code: "stale_observation" });
    const refreshed = await f.computer.observe("session", {});
    assert.deepEqual(refreshed.window, target);
    assert.equal(f.counts().actions, 1);
    f.computer.invalidate("session");
    assert.deepEqual((await f.computer.observe("session", {})).window, target);
    await f.computer.closeSession("session");
    await assert.rejects(f.computer.observe("session", {}), { code: "session_closed" });
  }
});
