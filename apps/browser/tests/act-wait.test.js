import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserBridge } from "../src/bridge.ts";

const event = () => ({
  listeners: [],
  addListener(listener) {
    this.listeners.push(listener);
  },
  removeListener(listener) {
    this.listeners = this.listeners.filter((item) => item !== listener);
  },
  emit(...args) {
    for (const listener of [...this.listeners]) listener(...args);
  },
});
const flush = async () => {
  await new Promise((resolve) => setImmediate(resolve));
};
function fixture(navigationTimeout = 15000) {
  const updates = event(),
    removed = event(),
    detached = event();
  const tab = { id: 2, url: "https://delayed.fixture/", title: "Delayed interface", status: "complete" };
  let state = "before",
    writes = 0,
    readsAfterWrite = 0,
    sequence = 0;
  const chrome = {
    tabs: {
      onUpdated: updates,
      onRemoved: removed,
      create: async () => tab,
      get: async () => tab,
      remove: async () => removed.emit(tab.id),
    },
    debugger: {
      onDetach: detached,
      attach: async () => {},
      detach: async () => {},
      async sendCommand(_target, method) {
        if (method === "Accessibility.getFullAXTree") {
          if (writes) readsAfterWrite++;
          return { nodes: [{ backendDOMNodeId: 1, role: { value: "button" }, name: { value: "Update" } }] };
        }
        if (method === "Runtime.evaluate") return { result: { value: { text: state, base_uri: tab.url } } };
        if (method === "DOM.resolveNode") return { object: { objectId: "update-button" } };
        if (method === "Runtime.callFunctionOn") return { result: { value: { x: 10, y: 10 } } };
        if (method === "Input.dispatchMouseEvent") {
          if (arguments[2]?.type !== "mouseReleased") return {};
          writes++;
          setTimeout(() => {
            state = "after";
          }, 25);
        }
        if (method === "Page.captureScreenshot") return { data: Buffer.from(state).toString("base64") };
        return {};
      },
    },
  };
  const bridge = new BrowserBridge(chrome, { navigationTimeout, uuid: () => `observation-${++sequence}` });
  const request = (method, params = {}) =>
    bridge.dispatch({ id: `request-${++sequence}`, method, session_id: "s", params });
  return { bridge, chrome, request, writes: () => writes, reads: () => readsAfterWrite };
}
async function prepareAct(f) {
  const opened = await f.request("open", { url: "https://delayed.fixture/" });
  return (params = {}) =>
    f.request("act", {
      observation_id: opened.result.observation.observation_id,
      action: { type: "click", element_ref: "e1" },
      screenshot: true,
      ...params,
    });
}

test("browser act waits the default 2000ms before observing the delayed UI and screenshot", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  const run = await prepareAct(f);
  const result = run();
  await flush();
  assert.equal(f.writes(), 1);
  assert.equal(f.reads(), 0, "The screenshot must not precede the UI response");
  t.mock.timers.tick(1999);
  await flush();
  assert.equal(f.reads(), 0);
  t.mock.timers.tick(1);
  const response = await result;
  assert.equal(response.result.observation.text, "after");
  assert.equal(Buffer.from(response.result.observation.image_base64, "base64").toString(), "after");
  assert.equal(f.writes(), 1);
});

test("custom wait also delays text observations; zero and observe_after=false skip the delay", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  const run = await prepareAct(f);
  const pending = run({ wait_after_ms: 75, screenshot: false });
  await flush();
  t.mock.timers.tick(74);
  await flush();
  assert.equal(f.reads(), 0);
  t.mock.timers.tick(1);
  assert.equal((await pending).result.observation.text, "after");

  for (const params of [{ wait_after_ms: 0 }, { observe_after: false, screenshot: false }]) {
    const other = fixture();
    const start = await prepareAct(other);
    const result = await start(params);
    assert.equal(other.writes(), 1);
    if (params.observe_after === false) {
      assert.equal(other.reads(), 0);
      assert.equal(result.result.observation, undefined);
    } else assert.equal(result.result.observation.text, "before");
  }
});

test("invalid wait parameters are rejected before delivering any input", async () => {
  const f = fixture();
  const run = await prepareAct(f);
  for (const wait_after_ms of [-1, 10001, 1.5, "2000", null, NaN, Infinity]) {
    const result = await run({ wait_after_ms });
    assert.equal(result.error.code, "invalid_params");
    assert.equal(f.writes(), 0);
  }
});

test("close, stop, removed tabs and debugger detach interrupt the wait without observing or replay", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const cancel of [
    (f) => f.request("close"),
    (f) => f.request("stop"),
    (f) => f.chrome.tabs.onRemoved.emit(2),
    (f) => f.chrome.debugger.onDetach.emit({ tabId: 2 }),
  ]) {
    const f = fixture();
    const run = await prepareAct(f);
    const pending = run();
    await flush();
    assert.equal(f.writes(), 1);
    const concurrent = await run();
    assert.equal(concurrent.error.code, "session_busy");
    await cancel(f);
    const response = await pending;
    assert.equal(response.result.executed, true);
    assert.equal(response.result.observation_error.code, "session_closed");
    assert.equal(f.reads(), 0);
    t.mock.timers.tick(2000);
    await flush();
    assert.equal(f.reads(), 0);
    assert.equal(f.writes(), 1);
  }
});

test("post-action delay consumes the existing observation budget instead of extending it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(30);
  const run = await prepareAct(f);
  let settled = false;
  const pending = run({ wait_after_ms: 1000 }).then((result) => {
    settled = true;
    return result;
  });
  await flush();
  t.mock.timers.tick(30);
  await flush();
  assert.equal(settled, true, "The original 30ms budget must also bound a 1000ms requested delay");
  const response = await pending;
  assert.equal(response.result.executed, true);
  assert.equal(response.result.observation_error.code, "observation_timeout");
  assert.equal(f.reads(), 0);
  assert.equal(f.writes(), 1);
});
