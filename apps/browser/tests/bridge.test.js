import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserBridge } from "../src/bridge.ts";
import { prepareInput } from "../src/page-tools.ts";
function fixture() {
  const event = () => ({
    listeners: [],
    addListener(fn) {
      this.listeners.push(fn);
    },
    removeListener(fn) {
      this.listeners = this.listeners.filter((item) => item !== fn);
    },
    emit(...args) {
      for (const fn of this.listeners) fn(...args);
    },
  });
  const tabs = new Map([[1, { id: 1, url: "https://personal.example/", title: "Personal" }]]),
    calls = [],
    removed = [];
  let next = 2,
    sequence = 0,
    now = 1000,
    rejectWrite = false;
  const chrome = {
    tabs: {
      onUpdated: event(),
      onRemoved: event(),
      async create(params) {
        calls.push(["create", params]);
        const tab = { id: next++, url: params.url, title: "Task" };
        tabs.set(tab.id, tab);
        return tab;
      },
      async get(id) {
        if (!tabs.has(id)) throw Error("Missing tab");
        return tabs.get(id);
      },
      async update(id, params) {
        calls.push(["update", id, params]);
        tabs.get(id).url = params.url;
        chrome.tabs.onUpdated.emit(id, { status: "loading" });
        return tabs.get(id);
      },
      async remove(id) {
        removed.push(id);
        tabs.delete(id);
        chrome.tabs.onRemoved.emit(id);
      },
    },
    debugger: {
      onDetach: event(),
      onEvent: event(),
      async attach(target) {
        calls.push(["attach", target]);
      },
      async sendCommand(target, method, params) {
        calls.push([method, target, params]);
        if (method === "Accessibility.getFullAXTree")
          return {
            nodes: [
              { backendDOMNodeId: 99, role: { value: "button" }, name: { value: "Save" }, ignored: false },
              { backendDOMNodeId: 100, role: { value: "textbox" }, name: { value: "Name" } },
            ],
          };
        if (method === "Runtime.evaluate")
          return {
            result: { value: { text: "Save\nName", truncated: false, base_uri: "https://example.com/" } },
          };
        if (method === "DOM.resolveNode") return { object: { objectId: "internal-node-99" } };
        if (method === "Input.dispatchMouseEvent" && rejectWrite) throw Error("Transport lost");
        if (method === "Runtime.callFunctionOn") return { result: { value: { x: 10, y: 10 } } };
        if (method === "Page.captureScreenshot") return { data: "YWJj" };
        return {};
      },
    },
  };
  const bridge = new BrowserBridge(chrome, { now: () => now, uuid: () => `observation-${++sequence}` });
  const request = (method, session_id = "s1", params = {}) =>
    bridge.dispatch({
      id: `request-${++sequence}`,
      method,
      session_id,
      params: method === "act" ? { wait_after_ms: 0, ...params } : params,
    });
  return {
    bridge,
    chrome,
    calls,
    removed,
    tabs,
    request,
    advance: () => {
      now += 10000;
    },
    rejectWrite: () => {
      rejectWrite = true;
    },
  };
}
test("owns background task tabs, reuses only that tab, closes only task resources", async () => {
  const f = fixture();
  const first = await f.request("open", "s1", { url: "https://work.example/" });
  assert.equal(first.result.tab_id, 2);
  assert.equal(f.calls[0][1].active, false);
  await f.request("open", "s1", { url: "https://work.example/next" });
  assert.equal(f.tabs.size, 2);
  await f.request("open", "s2", { url: "https://other.example/" });
  await f.request("close");
  assert.deepEqual(f.removed, [2]);
  await f.request("stop");
  assert.deepEqual(f.removed, [2, 3]);
  assert.equal(f.tabs.get(1).url, "https://personal.example/");
});
test("refs resolve backend node handles and click uses native CDP input", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
  const obs = (await f.request("observe")).result;
  const act = await f.request("act", "s1", {
    observation_id: obs.observation_id,
    action: { type: "click", element_ref: "e1" },
  });
  assert.equal(act.result.route, "cdp_input");
  assert.equal(f.calls.find((c) => c[0] === "DOM.resolveNode")[2].backendNodeId, 99);
  const write = f.calls.find((c) => c[0] === "Runtime.callFunctionOn")[2];
  assert.equal(write.objectId, "internal-node-99");
  assert.match(write.functionDeclaration, /elementFromPoint/);
  assert.equal(
    f.calls.filter((c) => c[0] === "Input.dispatchMouseEvent" && c[2].type === "mousePressed").length,
    1,
  );
  const replay = await f.request("act", "s1", {
    observation_id: obs.observation_id,
    action: { type: "click", element_ref: "e1" },
  });
  assert.equal(replay.error.code, "stale_observation");
});
test("cross-session, expired and navigation-invalidated references never write", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
  await f.request("open", "s2", { url: "https://example.com/" });
  const one = (await f.request("observe")).result;
  const two = (await f.request("observe", "s2")).result;
  assert.equal(
    (
      await f.request("act", "s2", {
        observation_id: one.observation_id,
        action: { type: "click", element_ref: "e1" },
      })
    ).error.code,
    "stale_observation",
  );
  f.advance();
  assert.equal(
    (
      await f.request("act", "s1", {
        observation_id: one.observation_id,
        action: { type: "click", element_ref: "e1" },
      })
    ).error.code,
    "stale_observation",
  );
  const fresh = (await f.request("observe")).result;
  f.chrome.tabs.onUpdated.emit(2, { status: "loading" });
  assert.equal(
    (
      await f.request("act", "s1", {
        observation_id: fresh.observation_id,
        action: { type: "click", element_ref: "e1" },
      })
    ).error.code,
    "stale_observation",
  );
  assert.equal(f.calls.filter((c) => c[0] === "Runtime.callFunctionOn").length, 0);
  assert.ok(two);
});
test("fill replaces values and passes text as a CDP argument, never source", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
  const obs = (await f.request("observe")).result;
  const text = '\"; alert(1); //';
  await f.request("act", "s1", {
    observation_id: obs.observation_id,
    action: { type: "fill", element_ref: "e2", text },
  });
  const write = f.calls.find((c) => c[0] === "Input.insertText")[2];
  assert.deepEqual(write, { text });
  const selection = f.calls.filter((c) => c[0] === "Runtime.callFunctionOn").at(-1)[2];
  assert.ok(!selection.functionDeclaration.includes(text));
  assert.match(selection.functionDeclaration, /select/);
});
test("privileged URLs and redirects reject, unknown writes close without retry", async () => {
  const f = fixture();
  assert.equal((await f.request("open", "s1", { url: "chrome://settings" })).error.code, "invalid_url");
  assert.equal(f.tabs.size, 1);
  await f.request("open", "s1", { url: "https://example.com/" });
  f.chrome.tabs.onUpdated.emit(2, { url: "chrome://settings" });
  assert.equal((await f.request("observe")).error.code, "invalid_url");
  await f.request("open", "s1", { url: "https://example.com/" });
  const obs = (await f.request("observe")).result;
  f.rejectWrite();
  const result = await f.request("act", "s1", {
    observation_id: obs.observation_id,
    action: { type: "click", element_ref: "e1" },
  });
  assert.equal(result.error.code, "outcome_unknown");
  assert.deepEqual(f.removed, [2]);
  assert.equal(
    f.calls.filter((c) => c[0] === "Input.dispatchMouseEvent" && c[2].type === "mouseMoved").length,
    1,
  );
});
test("duplicate request IDs do not replay; detach and stop invalidate state", async () => {
  const f = fixture();
  const request = { id: "fixed", method: "open", session_id: "s1", params: { url: "https://example.com/" } };
  await f.bridge.dispatch(request);
  assert.equal((await f.bridge.dispatch(request)).error.code, "duplicate_request");
  await f.request("observe");
  f.chrome.debugger.onDetach.emit({ tabId: 2 });
  assert.equal(f.bridge.sessions.get("s1").observation, null);
  await f.bridge.stop();
  assert.equal(f.bridge.sessions.size, 0);
  assert.equal(f.tabs.size, 1);
});
test("oversized screenshots reject without storing an observation", async () => {
  const f = fixture();
  const original = f.chrome.debugger.sendCommand;
  f.chrome.debugger.sendCommand = async (...args) =>
    args[1] === "Page.captureScreenshot"
      ? { data: Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64") }
      : original(...args);
  await f.request("open", "s1", { url: "https://example.com/" });
  const result = await f.request("observe", "s1", { screenshot: true });
  assert.equal(result.error.code, "screenshot_too_large");
  assert.equal(f.bridge.sessions.get("s1").observation, null);
});
test("stop during tab creation removes the late task tab and cannot resurrect a session", async () => {
  const f = fixture();
  const original = f.chrome.tabs.create;
  let release;
  f.chrome.tabs.create = async (params) => {
    await new Promise((resolve) => {
      release = resolve;
    });
    return original(params);
  };
  const opening = f.request("open", "s1", { url: "https://example.com/" });
  await f.bridge.stop();
  release();
  const result = await opening;
  assert.equal(result.error.code, "session_closed");
  assert.equal(f.bridge.sessions.size, 0);
  assert.equal(f.tabs.size, 1);
});
test("concurrent same-session operations reject instead of racing tab ownership", async () => {
  const f = fixture();
  const original = f.chrome.tabs.create;
  let release;
  f.chrome.tabs.create = async (params) => {
    await new Promise((resolve) => {
      release = resolve;
    });
    return original(params);
  };
  const opening = f.request("open", "s1", { url: "https://example.com/" });
  assert.equal((await f.request("open", "s1", { url: "https://other.example/" })).error.code, "session_busy");
  release();
  await opening;
  assert.equal(f.calls.filter((c) => c[0] === "create").length, 1);
});
test("open waits for pending URL and completed navigation, including navigation reuse", async () => {
  const f = fixture();
  const create = f.chrome.tabs.create;
  f.chrome.tabs.create = async (params) => {
    const tab = await create(params);
    tab.pendingUrl = params.url;
    tab.url = "about:blank";
    tab.status = "loading";
    return tab;
  };
  const opening = f.request("open", "s1", { url: "https://example.com/" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const tab = f.tabs.get(2);
  tab.url = "https://example.com/";
  delete tab.pendingUrl;
  tab.status = "complete";
  f.chrome.tabs.onUpdated.emit(2, { url: tab.url, status: "complete" });
  assert.equal((await opening).result.url, "https://example.com/");
  const update = f.chrome.tabs.update;
  f.chrome.tabs.update = async (id, params) => {
    await update(id, params);
    tab.status = "loading";
    tab.pendingUrl = params.url;
    return tab;
  };
  const navigating = f.request("open", "s1", { url: "https://example.com/next" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  tab.status = "complete";
  delete tab.pendingUrl;
  f.chrome.tabs.onUpdated.emit(2, { status: "complete" });
  assert.equal((await navigating).result.url, "https://example.com/next");
});
test("denied redirect removes the tab while navigation wait retains a recoverable task", async () => {
  const f = fixture();
  f.bridge.navigationTimeout = 15;
  const create = f.chrome.tabs.create;
  f.chrome.tabs.create = async (params) => {
    const tab = await create(params);
    tab.status = "loading";
    return tab;
  };
  const opening = f.request("open", "s1", { url: "https://example.com/" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  f.tabs.get(2).url = "chrome://settings";
  f.chrome.tabs.onUpdated.emit(2, { url: "chrome://settings", status: "complete" });
  assert.equal((await opening).error.code, "invalid_url");
  assert.deepEqual(f.removed, [2]);
  const pending = await f.request("open", "s2", { url: "https://example.com/" });
  assert.equal(pending.result.navigation_state, "loading");
  assert.deepEqual(f.removed, [2]);
  assert.equal(f.tabs.has(3), true);
});
test("stop concurrent with debugger attach leaves no usable session or late observation", async () => {
  const f = fixture();
  let release;
  f.chrome.debugger.attach = async () =>
    new Promise((resolve) => {
      release = resolve;
    });
  let detached = 0;
  f.chrome.debugger.detach = async () => {
    detached++;
  };
  await f.request("open", "s1", { url: "https://example.com/", observe_after: false });
  const observing = f.request("observe");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await f.bridge.stop();
  release();
  assert.equal((await observing).error.code, "session_closed");
  assert.equal(detached, 1);
  assert.equal(f.bridge.sessions.size, 0);
  assert.equal(f.calls.filter((c) => c[0] === "Accessibility.getFullAXTree").length, 0);
});
test("stop during in-flight DOM action reports unknown and never replays", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
  const obs = (await f.request("observe")).result;
  const command = f.chrome.debugger.sendCommand;
  let release,
    writes = 0;
  f.chrome.debugger.sendCommand = async (...args) => {
    if (args[1] === "Input.dispatchMouseEvent" && args[2].type === "mousePressed") {
      writes++;
      await new Promise((resolve) => {
        release = resolve;
      });
      return {};
    }
    return command(...args);
  };
  const acting = f.request("act", "s1", {
    observation_id: obs.observation_id,
    action: { type: "click", element_ref: "e1" },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await f.bridge.stop();
  release();
  assert.equal((await acting).error.code, "outcome_unknown");
  assert.equal(writes, 1);
  assert.equal(f.bridge.sessions.size, 0);
});
test("screenshots use MCP top-level image fields and raw-byte limit", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
  const command = f.chrome.debugger.sendCommand;
  const data = Buffer.alloc(4 * 1024 * 1024).toString("base64");
  f.chrome.debugger.sendCommand = async (...args) =>
    args[1] === "Page.captureScreenshot" ? { data } : command(...args);
  const result = await f.request("observe", "s1", { screenshot: true });
  assert.equal(result.result.image_base64, data);
  assert.equal(result.result.mime_type, "image/png");
  assert.equal(result.result.screenshot, undefined);
});
test("failed tab cleanup remains tracked, blocks new tasks and can be retried by stop", async () => {
  const f = fixture();
  const stored = {};
  f.chrome.storage = {
    session: {
      async set(value) {
        Object.assign(stored, value);
      },
    },
  };
  await f.request("open", "s1", { url: "https://example.com/" });
  const remove = f.chrome.tabs.remove;
  f.chrome.tabs.remove = async () => {
    throw Error("temporary removal failure");
  };
  assert.equal((await f.request("close")).error.code, "cleanup_failed");
  assert.deepEqual(stored.owned_task_tabs, [2]);
  assert.equal(f.bridge.ownedTabs.has(2), true);
  assert.equal((await f.request("open", "s2", { url: "https://example.com/" })).error.code, "cleanup_failed");
  f.chrome.tabs.remove = remove;
  assert.equal((await f.request("stop")).result.closed, true);
  assert.deepEqual(stored.owned_task_tabs, []);
  assert.ok(f.tabs.has(1));
});
test("pending URL on a complete old document still waits for new commit", async () => {
  const f = fixture();
  const create = f.chrome.tabs.create;
  f.chrome.tabs.create = async (params) => {
    const tab = await create(params);
    tab.url = "https://old.example/";
    tab.pendingUrl = params.url;
    tab.status = "complete";
    return tab;
  };
  let settled = false;
  const opening = f.request("open", "s1", { url: "https://example.com/" }).then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(settled, false);
  const tab = f.tabs.get(2);
  tab.url = "https://example.com/";
  delete tab.pendingUrl;
  f.chrome.tabs.onUpdated.emit(2, { url: tab.url, status: "complete" });
  assert.equal((await opening).result.url, "https://example.com/");
});
test("observation keeps visible text once, actionable refs, link destinations and filter state", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://github.example/notifications" });
  const original = f.chrome.debugger.sendCommand;
  const duplicate = Array.from({ length: 600 }, (_, i) => ({
    backendDOMNodeId: i + 1000,
    role: { value: i % 2 ? "InlineTextBox" : "StaticText" },
    name: { value: "Notification title" },
  }));
  const actionable = [
    {
      backendDOMNodeId: 7,
      role: { value: "link" },
      name: { value: "Unread" },
      properties: [{ name: "selected", value: { value: true } }],
    },
    {
      backendDOMNodeId: 8,
      role: { value: "checkbox" },
      name: { value: "Select notification" },
      properties: [
        { name: "checked", value: { value: "mixed" } },
        { name: "disabled", value: { value: false } },
      ],
    },
    {
      backendDOMNodeId: 9,
      role: { value: "button" },
      name: { value: "More filters" },
      properties: [{ name: "expanded", value: { value: false } }],
    },
    { backendDOMNodeId: 10, role: { value: "link" }, name: { value: "Unsafe link" } },
  ];
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "Accessibility.getFullAXTree") return { nodes: [...duplicate, ...actionable] };
    if (method === "Runtime.evaluate")
      return {
        result: {
          value: {
            text: "Unread\nNotification title",
            truncated: false,
            base_uri: "https://github.example/base/",
          },
        },
      };
    if (method === "DOM.describeNode")
      return {
        node: {
          attributes: [
            "href",
            params.backendNodeId === 7 ? "../notifications?query=is%3Aunread" : "javascript:alert(1)",
          ],
        },
      };
    return original(target, method, params);
  };
  const { result } = await f.request("observe");
  assert.equal(result.text, "Unread\nNotification title");
  assert.equal(result.elements.length, 4);
  assert.equal(result.truncated, false);
  assert.equal(result.elements[0].url, "https://github.example/notifications?query=is%3Aunread");
  assert.equal(result.elements[0].selected, true);
  assert.equal(result.elements[1].checked, "mixed");
  assert.equal(result.elements[1].disabled, undefined);
  assert.equal(result.elements[2].expanded, false);
  assert.equal(result.elements[3].url, undefined);
  assert.equal(f.bridge.sessions.get("s1").observation.refs.get("e1"), 7);
});
test("observation reports text and interactive-list truncation explicitly", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
  const original = f.chrome.debugger.sendCommand;
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "Accessibility.getFullAXTree")
      return {
        nodes: Array.from({ length: 700 }, (_, i) => ({
          backendDOMNodeId: i + 1,
          role: { value: "button" },
          name: { value: `Button ${i}` },
        })),
      };
    if (method === "Runtime.evaluate")
      return {
        result: { value: { text: "x".repeat(12001), truncated: true, base_uri: "https://example.com/" } },
      };
    return original(target, method, params);
  };
  const { result } = await f.request("observe");
  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= 4000);
  assert.ok(JSON.stringify(result).length < 7500);
  assert.ok(result.elements.length < 700);
});

test("closed-loop open and actions return fresh observations and keep successful action on read failure", async () => {
  const f = fixture();
  const opened = await f.request("open", "s1", { url: "https://example.com/" });
  assert.ok(opened.result.observation?.observation_id);
  const acted = await f.request("act", "s1", {
    observation_id: opened.result.observation.observation_id,
    action: { type: "click", element_ref: "e1" },
  });
  assert.equal(acted.result.executed, true);
  assert.notEqual(acted.result.observation.observation_id, opened.result.observation.observation_id);
  const send = f.chrome.debugger.sendCommand;
  f.chrome.debugger.sendCommand = async (...args) => {
    if (args[1] === "Accessibility.getFullAXTree") throw Error("read unavailable");
    return send(...args);
  };
  const result = await f.request("act", "s1", {
    observation_id: acted.result.observation.observation_id,
    action: { type: "click", element_ref: "e1" },
  });
  assert.equal(result.result.executed, true);
  assert.equal(result.result.observation_error.code, "browser_error");
  assert.equal(
    f.calls.filter((c) => c[0] === "Input.dispatchMouseEvent" && c[2].type === "mousePressed").length,
    2,
  );
  assert.ok(f.tabs.has(2));
});

test("parameter errors preserve observation and are rejected before opening or dispatching", async () => {
  const f = fixture();
  const invalid = await f.request("open", "s1", { url: "https://example.com/", observe_after: "yes" });
  assert.equal(invalid.error.code, "invalid_params");
  assert.equal(f.tabs.size, 1);
  await f.request("open", "s1", { url: "https://example.com/", observe_after: false });
  const obs = (await f.request("observe")).result;
  const invalidAct = await f.request("act", "s1", {
    observation_id: obs.observation_id,
    action: { type: "fill", element_ref: "e2", text: 42 },
  });
  assert.equal(invalidAct.error.code, "invalid_action");
  assert.equal(f.bridge.sessions.get("s1").observation.id, obs.observation_id);
  assert.equal((await f.request("observe", "s1", { query: 42 })).error.code, "invalid_params");
  assert.equal(f.bridge.sessions.get("s1").observation.id, obs.observation_id);
  const acted = await f.request("act", "s1", {
    observation_id: obs.observation_id,
    action: { type: "click", element_ref: "e1" },
    observe_after: false,
  });
  assert.equal(acted.result.executed, true);
  assert.equal(acted.result.observation, undefined);
});

test("bounded observations preserve late query matches without sending the full page", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/", observe_after: false });
  const send = f.chrome.debugger.sendCommand;
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "Accessibility.getFullAXTree")
      return {
        nodes: Array.from({ length: 500 }, (_, i) => ({
          backendDOMNodeId: i + 1,
          role: { value: "button" },
          name: { value: i === 499 ? "Person Zebra" : `Person ${i}` },
        })),
      };
    if (method === "Runtime.evaluate")
      return {
        result: {
          value: {
            text: "Header\n".repeat(1500) + "Person Zebra\nLocation: Shanghai",
            truncated: false,
            base_uri: "https://example.com/",
          },
        },
      };
    return send(target, method, params);
  };
  const normal = (await f.request("observe")).result;
  assert.ok(JSON.stringify(normal).length < 7500);
  assert.equal(normal.truncated, true);
  const queried = (await f.request("observe", "s1", { query: "Person Zebra" })).result;
  assert.ok(JSON.stringify(queried).length < 7500);
  assert.match(queried.text, /Person Zebra/);
  assert.equal(queried.elements.length, 1);
  assert.equal(queried.elements[0].name, "Person Zebra");
  assert.equal(f.bridge.sessions.get("s1").observation.refs.get(queried.elements[0].element_ref), 500);
});

test("link metadata collection uses bounded concurrency instead of serial round trips", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/", observe_after: false });
  const send = f.chrome.debugger.sendCommand;
  let active = 0,
    peak = 0;
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "Accessibility.getFullAXTree")
      return {
        nodes: Array.from({ length: 12 }, (_, i) => ({
          backendDOMNodeId: i + 1,
          role: { value: "link" },
          name: { value: `Person ${i}` },
        })),
      };
    if (method === "DOM.describeNode") {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return { node: { attributes: ["href", `/person-${params.backendNodeId}`] } };
    }
    return send(target, method, params);
  };
  const result = (await f.request("observe")).result;
  assert.ok(peak > 1);
  assert.ok(peak <= 4);
  assert.equal(result.elements.length, 12);
  assert.equal(result.elements[0].url, "https://example.com/person-1");
});

test("navigation wait yields pending state and preserves the same task tab for later observation", async () => {
  const f = fixture();
  f.bridge.navigationTimeout = 10;
  const create = f.chrome.tabs.create;
  f.chrome.tabs.create = async (params) => {
    const tab = await create(params);
    tab.pendingUrl = params.url;
    tab.url = "about:blank";
    tab.status = "loading";
    return tab;
  };
  const opening = await f.request("open", "s1", { url: "https://example.com/" });
  assert.equal(opening.error, undefined);
  assert.equal(opening.result.navigation_state, "loading");
  assert.equal(opening.result.observation_error.code, "navigation_pending");
  assert.equal(f.tabs.size, 2);
  assert.deepEqual(f.removed, []);
  const stillPending = await f.request("observe");
  assert.equal(stillPending.result.navigation_state, "loading");
  assert.equal(stillPending.result.observation_id, undefined);
  const tab = f.tabs.get(2);
  tab.url = "https://example.com/";
  tab.status = "complete";
  delete tab.pendingUrl;
  f.chrome.tabs.onUpdated.emit(2, { status: "complete" });
  assert.ok((await f.request("observe")).result.observation_id);
  assert.equal(f.calls.filter((c) => c[0] === "create").length, 1);
});

test("post-action navigation wait reports loading without losing or repeating the completed action", async () => {
  const f = fixture();
  f.bridge.navigationTimeout = 10;
  const opened = await f.request("open", "s1", { url: "https://example.com/" });
  const send = f.chrome.debugger.sendCommand;
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    const result = await send(target, method, params);
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
      f.tabs.get(2).status = "loading";
      f.chrome.tabs.onUpdated.emit(2, { status: "loading" });
    }
    return result;
  };
  const acted = await f.request("act", "s1", {
    observation_id: opened.result.observation.observation_id,
    action: { type: "click", element_ref: "e1" },
  });
  assert.equal(acted.result.executed, true);
  assert.equal(acted.result.navigation_state, "loading");
  assert.equal(acted.result.observation_error.code, "navigation_pending");
  assert.equal(acted.result.observation, undefined);
  assert.equal(
    f.calls.filter((c) => c[0] === "Input.dispatchMouseEvent" && c[2].type === "mousePressed").length,
    1,
  );
  assert.equal(f.tabs.has(2), true);
  assert.deepEqual(f.removed, []);
  f.tabs.get(2).status = "complete";
  f.chrome.tabs.onUpdated.emit(2, { status: "complete" });
  assert.ok((await f.request("observe")).result.observation_id);
});

test("bounded default output preserves the first ten profile cards before unrelated footer content", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/", observe_after: false });
  const send = f.chrome.debugger.sendCommand;
  const cards = Array.from(
    { length: 10 },
    (_, i) => `Person ${i}\nLocation ${i}\nOrganization ${i}\n${"Profile biography. ".repeat(8)}`,
  ).join("\n");
  f.chrome.debugger.sendCommand = async (target, method, params) =>
    method === "Runtime.evaluate"
      ? {
          result: {
            value: {
              text: "Navigation\n".repeat(50) + cards + "\nFooter\n".repeat(1500),
              truncated: false,
              base_uri: "https://example.com/",
            },
          },
        }
      : send(target, method, params);
  const { result } = await f.request("observe");
  assert.match(result.text, /Person 9/);
  assert.match(result.text, /Organization 9/);
  assert.ok(JSON.stringify(result).length < 7500);
  assert.equal(result.truncated, true);
});

test("pending navigation refuses old observation before any DOM input", async () => {
  const f = fixture();
  const opened = await f.request("open", "s1", { url: "https://example.com/" });
  f.tabs.get(2).pendingUrl = "https://example.com/next";
  f.tabs.get(2).status = "complete";
  const result = await f.request("act", "s1", {
    observation_id: opened.result.observation.observation_id,
    action: { type: "click", element_ref: "e1" },
  });
  assert.equal(result.error.code, "stale_observation");
  assert.equal(f.calls.filter((c) => c[0] === "Runtime.callFunctionOn").length, 0);
});

for (const stage of ["Accessibility.getFullAXTree", "Page.captureScreenshot"])
  test(`post-observation recovers one navigation race during ${stage} without reopening`, async () => {
    const f = fixture(),
      send = f.chrome.debugger.sendCommand;
    let races = 0,
      reads = 0;
    f.chrome.debugger.sendCommand = async (target, method, params) => {
      if (method === "Accessibility.getFullAXTree") reads++;
      if (method === stage && races++ === 0) {
        const tab = f.tabs.get(2);
        tab.url = "https://example.com/settled";
        tab.status = "complete";
        f.chrome.tabs.onUpdated.emit(2, { url: tab.url, status: "complete" });
      }
      return send(target, method, params);
    };
    const result = await f.request("open", "s1", {
      url: "https://example.com/",
      screenshot: stage === "Page.captureScreenshot",
    });
    assert.equal(result.result.observation_error, undefined);
    assert.ok(result.result.observation.observation_id);
    assert.equal(result.result.observation.url, "https://example.com/settled");
    assert.equal(reads, 2);
    assert.equal(f.calls.filter((c) => c[0] === "create").length, 1);
    assert.equal(f.calls.filter((c) => c[0] === "update").length, 0);
    assert.equal(f.calls.filter((c) => c[0] === "Runtime.callFunctionOn").length, 0);
  });

test("post-observation retry stops after bounded repeated navigation and honors session closure", async () => {
  const f = fixture(),
    send = f.chrome.debugger.sendCommand;
  let reads = 0;
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "Accessibility.getFullAXTree") {
      reads++;
      f.chrome.tabs.onUpdated.emit(2, { url: "https://example.com/", status: "complete" });
    }
    return send(target, method, params);
  };
  const result = await f.request("open", "s1", { url: "https://example.com/" });
  assert.equal(result.result.observation, undefined);
  assert.equal(result.result.observation_error.code, "stale_observation");
  assert.equal(reads, 3);
  assert.equal(f.calls.filter((c) => c[0] === "create").length, 1);
  reads = 0;
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "Accessibility.getFullAXTree") {
      reads++;
      await f.bridge.close("s1");
    }
    return send(target, method, params);
  };
  const closed = await f.request("open", "s1", { url: "https://example.com/next" });
  assert.equal(closed.result.observation_error.code, "session_closed");
  assert.equal(reads, 1);
  assert.equal(f.bridge.sessions.size, 0);
});

test("retry shares the original readiness budget and never reattaches after debugger detach", async () => {
  const f = fixture();
  f.bridge.navigationTimeout = 20;
  const send = f.chrome.debugger.sendCommand;
  let reads = 0;
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "Accessibility.getFullAXTree") {
      reads++;
      f.tabs.get(2).status = "loading";
      f.chrome.tabs.onUpdated.emit(2, { status: "loading" });
    }
    return send(target, method, params);
  };
  const result = await f.request("open", "s1", { url: "https://example.com/" });
  assert.equal(result.result.navigation_state, "loading");
  assert.equal(result.result.observation_error.code, "navigation_pending");
  assert.equal(reads, 1);
  f.tabs.get(2).status = "complete";
  reads = 0;
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "Accessibility.getFullAXTree") {
      reads++;
      f.chrome.debugger.onDetach.emit({ tabId: 2 });
    }
    return send(target, method, params);
  };
  const detached = await f.request("open", "s1", { url: "https://example.com/next" });
  assert.equal(detached.result.observation_error.code, "stale_observation");
  assert.equal(reads, 1);
  assert.equal(f.calls.filter((c) => c[0] === "attach").length, 1);
});

test("timed-out read retry cannot publish a late observation", async () => {
  const f = fixture(),
    send = f.chrome.debugger.sendCommand;
  let reads = 0,
    release;
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "Accessibility.getFullAXTree") {
      reads++;
      if (reads === 1) f.chrome.tabs.onUpdated.emit(2, { url: "https://example.com/", status: "complete" });
      else
        return new Promise((resolve) => {
          release = resolve;
        });
    }
    return send(target, method, params);
  };
  const result = await f.request("open", "s1", { url: "https://example.com/" });
  assert.equal(result.result.observation_error.code, "observation_timeout");
  assert.equal(reads, 2);
  assert.equal(f.bridge.sessions.get("s1").observation, null);
  release({ nodes: [] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.bridge.sessions.get("s1").observation, null);
  assert.equal(f.calls.filter((c) => c[0] === "create").length, 1);
});

test("attach and setup obey observation deadline and late cleanup precedes a later attach", async () => {
  const f = fixture();
  f.bridge.navigationTimeout = 20;
  let release,
    attaches = 0,
    detaches = 0;
  f.chrome.debugger.attach = async () => {
    attaches++;
    if (attaches === 1)
      await new Promise((resolve) => {
        release = resolve;
      });
  };
  f.chrome.debugger.detach = async () => {
    detaches++;
  };
  const result = await f.request("open", "s1", { url: "https://example.com/" });
  assert.equal(result.result.observation_error.code, "observation_timeout");
  assert.equal(attaches, 1);
  assert.equal(detaches, 0);
  assert.equal(f.bridge.sessions.get("s1").observation, null);
  const later = f.request("observe");
  release();
  const observed = await later;
  assert.ok(observed.result.observation_id);
  assert.equal(attaches, 2);
  assert.equal(detaches, 1);
  assert.equal(f.bridge.sessions.get("s1").attached, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(detaches, 1);
});

test("Page.enable obeys observation deadline and its late result cannot detach a new session", async () => {
  const f = fixture();
  f.bridge.navigationTimeout = 20;
  const send = f.chrome.debugger.sendCommand;
  let release,
    detaches = 0,
    setups = 0;
  f.chrome.debugger.detach = async () => {
    detaches++;
  };
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "Page.enable" && setups++ === 0)
      return new Promise((resolve) => {
        release = resolve;
      });
    return send(target, method, params);
  };
  const result = await f.request("open", "s1", { url: "https://example.com/" });
  assert.equal(result.result.observation_error.code, "observation_timeout");
  assert.equal(f.bridge.sessions.get("s1").observation, null);
  await f.bridge.close("s1");
  const next = await f.request("open", "s2", { url: "https://other.example/" });
  assert.ok(next.result.observation.observation_id);
  const before = detaches;
  release({});
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(detaches, before);
  assert.equal(f.bridge.sessions.get("s2").attached, true);
});

test("late attach cleanup never detaches a replacement session that owns the same tab id", async () => {
  const f = fixture();
  f.bridge.navigationTimeout = 20;
  let release,
    attaches = 0,
    detaches = 0;
  f.chrome.debugger.attach = async () => {
    if (++attaches === 1)
      await new Promise((resolve) => {
        release = resolve;
      });
  };
  f.chrome.debugger.detach = async () => {
    detaches++;
  };
  const expired = await f.request("open", "s1", { url: "https://example.com/" });
  assert.equal(expired.result.observation_error.code, "observation_timeout");
  await f.bridge.close("s1");
  const create = f.chrome.tabs.create;
  f.chrome.tabs.create = async (params) => {
    const tab = await create(params);
    f.tabs.delete(tab.id);
    tab.id = 2;
    f.tabs.set(2, tab);
    return tab;
  };
  const replacement = await f.request("open", "s2", { url: "https://other.example/" });
  assert.ok(replacement.result.observation.observation_id);
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(detaches, 0);
  assert.equal(f.bridge.sessions.get("s2").attached, true);
});

test("protected field values never affect query matches, truncation or returned metadata", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/", observe_after: false });
  const send = f.chrome.debugger.sendCommand;
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "Accessibility.getFullAXTree")
      return {
        nodes: [
          {
            backendDOMNodeId: 99,
            role: { value: "textbox" },
            name: { value: "Password" },
            value: { value: "secret-needle".repeat(100) },
            properties: [{ name: "protected", value: { value: true } }],
          },
        ],
      };
    if (method === "Runtime.evaluate")
      return { result: { value: { text: "Password", truncated: false, base_uri: "https://example.com/" } } };
    return send(target, method, params);
  };
  const hidden = (await f.request("observe", "s1", { query: "secret-needle" })).result;
  assert.equal(hidden.elements_total, 0);
  assert.equal(hidden.elements.length, 0);
  assert.equal(hidden.truncated, false);
  const visible = (await f.request("observe", "s1", { query: "Password" })).result;
  assert.equal(visible.elements.length, 1);
  assert.equal(visible.truncated, false);
  assert.equal(visible.elements[0].value, undefined);
  assert.ok(!JSON.stringify(visible).includes("secret-needle"));
});

test("saved text snapshots page without recapturing changed content and isolate sessions", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
  const send = f.chrome.debugger.sendCommand;
  let reads = 0;
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "Runtime.evaluate" && params.expression.includes("captureContent")) {
      reads++;
      return { result: { value: "0123456789" } };
    }
    return send(target, method, params);
  };
  const first = (await f.request("read", "s1", { mode: "text", limit: 4 })).result;
  assert.equal(first.text, "0123");
  assert.equal(first.next_offset, 4);
  const next = (
    await f.request("read", "s1", { mode: "text", snapshot_id: first.snapshot_id, offset: 4, limit: 6 })
  ).result;
  assert.equal(next.text, "456789");
  assert.equal(next.next_offset, null);
  assert.equal(next.cached, true);
  assert.equal(reads, 1);
  await f.request("open", "s2", { url: "https://example.com/" });
  assert.equal(
    (await f.request("read", "s2", { snapshot_id: first.snapshot_id })).error.code,
    "snapshot_missing",
  );
});

test("table snapshots preserve row and merged-cell metadata with pagination", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
  const send = f.chrome.debugger.sendCommand;
  const rows = Array.from({ length: 205 }, (_, i) => ({
    table: 0,
    row: i,
    cells: [{ text: String(i), row_span: 2, col_span: 1 }],
  }));
  f.chrome.debugger.sendCommand = async (target, method, params) =>
    method === "Runtime.evaluate" && params.expression.includes("captureContent")
      ? { result: { value: rows } }
      : send(target, method, params);
  const first = (await f.request("read", "s1", { mode: "tables", limit: 12000 })).result;
  assert.equal(first.rows.length, 200);
  assert.equal(first.rows[0].cells[0].row_span, 2);
  assert.equal(first.next_offset, 200);
  assert.equal(first.coverage, "loaded_main_document");
});

test("condition waits poll without input, time out, and stop promptly when task closes", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
  const send = f.chrome.debugger.sendCommand;
  let checks = 0;
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "Runtime.evaluate" && params.expression.includes("checkCondition"))
      return { result: { value: ++checks > 1 } };
    return send(target, method, params);
  };
  assert.equal((await f.request("wait", "s1", { selector: "#ready", timeout_ms: 500 })).result.matched, true);
  checks = -100;
  assert.equal(
    (await f.request("wait", "s1", { selector: "#missing", timeout_ms: 0 })).error.code,
    "wait_timeout",
  );
  const waiting = f.request("wait", "s1", { selector: "#missing", timeout_ms: 20000 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await f.request("close");
  assert.equal((await waiting).error.code, "session_closed");
  assert.equal(f.calls.filter((call) => call[0].startsWith("Input.")).length, 0);
});

test("evaluate returns bounded serializable values and never replays failed scripts", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
  const send = f.chrome.debugger.sendCommand;
  let runs = 0;
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "Runtime.evaluate" && params.expression === "test-script") {
      runs++;
      return { result: { value: { saved: 3 } } };
    }
    if (method === "Runtime.evaluate" && params.expression === "failed-script") {
      runs++;
      throw Error("lost");
    }
    return send(target, method, params);
  };
  assert.deepEqual((await f.request("evaluate", "s1", { expression: "test-script" })).result.value, {
    saved: 3,
  });
  assert.equal(
    (await f.request("evaluate", "s1", { expression: "failed-script" })).error.code,
    "outcome_unknown",
  );
  assert.equal(runs, 2);
  assert.equal(f.bridge.sessions.size, 0);
});

test("locator actions resolve each target anew and reject ambiguous selectors", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
  const send = f.chrome.debugger.sendCommand;
  let ambiguous = false;
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "DOM.querySelectorAll") return { nodeIds: ambiguous ? [3, 4] : [3] };
    if (method === "DOM.describeNode") return { node: { backendNodeId: 100 } };
    return send(target, method, params);
  };
  for (const text of ["one", "two", "three"])
    assert.equal(
      (await f.request("locate_act", "s1", { selector: "#name", action: { type: "fill", text } })).result
        .executed,
      true,
    );
  ambiguous = true;
  assert.equal(
    (await f.request("locate_act", "s1", { selector: "button", action: { type: "click" } })).error.code,
    "target_not_unique",
  );
});

test("press, select, scroll and hover expose distinct native or semantic routes", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
  for (const action of [
    { type: "press", key: "Enter" },
    { type: "select", values: ["a"] },
    { type: "scroll", delta_y: 300 },
    { type: "hover" },
  ]) {
    const observation = (await f.request("observe")).result;
    assert.equal(
      (
        await f.request("act", "s1", {
          observation_id: observation.observation_id,
          action: { ...action, element_ref: "e1" },
        })
      ).result.executed,
      true,
    );
  }
  assert.deepEqual(
    f.calls.filter((call) => call[0] === "Input.dispatchKeyEvent").map((call) => call[2].type),
    ["keyDown", "keyUp"],
  );
  assert.equal(
    f.calls.filter((call) => call[0] === "Input.dispatchMouseEvent" && call[2].type === "mouseWheel").length,
    1,
  );
});

test("same-origin frames evaluate in their default context and unsupported frames never fall back", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
  const send = f.chrome.debugger.sendCommand;
  let unsupported = false;
  const evaluations = [];
  f.chrome.debugger.onEvent.emit({ tabId: 2 }, "Runtime.executionContextCreated", {
    context: { id: 73, auxData: { frameId: "child-frame", isDefault: true } },
  });
  // An extension isolated world must never replace the site's default world.
  f.chrome.debugger.onEvent.emit({ tabId: 2 }, "Runtime.executionContextCreated", {
    context: { id: 74, auxData: { frameId: "child-frame", isDefault: false } },
  });
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "Runtime.evaluate" && params.objectGroup === "abridge-frame")
      return { result: unsupported ? { value: "unsupported_frame" } : { objectId: "frame-element" } };
    if (method === "DOM.describeNode" && params.objectId === "frame-element")
      return { node: { frameId: "child-frame" } };
    if (method === "Runtime.evaluate" && params.contextId !== undefined) {
      assert.equal(params.contextId, 73);
      evaluations.push(params);
      return {
        result: {
          value: params.expression.includes("checkCondition")
            ? true
            : params.expression.includes("captureContent")
              ? "frame contents"
              : 42,
        },
      };
    }
    if (method === "Runtime.callFunctionOn" && params.objectId === "frame-element") {
      assert.match(params.functionDeclaration, /this.contentDocument.querySelectorAll/);
      return { result: { objectId: "frame-node" } };
    }
    if (method === "DOM.describeNode" && params.objectId === "frame-node")
      return { node: { backendNodeId: 100 } };
    return send(target, method, params);
  };
  const args = { frame_selector: "#embedded" };
  const snapshot = (await f.request("read", "s1", args)).result;
  assert.equal(snapshot.text, "frame contents");
  assert.equal(
    (await f.request("read", "s1", { snapshot_id: snapshot.snapshot_id, offset: 1 })).result.coverage,
    "loaded_same_origin_frame",
  );
  assert.equal((await f.request("wait", "s1", { ...args, selector: "#ready" })).result.matched, true);
  assert.equal(
    (await f.request("evaluate", "s1", { ...args, expression: "window.answer=42; window.answer" })).result
      .value,
    42,
  );
  assert.equal(evaluations.length, 3);
  assert.equal(evaluations[2].expression, "window.answer=42; window.answer");
  assert.equal(
    (
      await f.request("locate_act", "s1", {
        ...args,
        selector: "#name",
        action: { type: "fill", text: "framed" },
      })
    ).result.executed,
    true,
  );
  f.chrome.debugger.onEvent.emit({ tabId: 2 }, "Runtime.executionContextDestroyed", {
    executionContextId: 73,
  });
  assert.equal(
    (await f.request("evaluate", "s1", { ...args, expression: "6*7" })).error.code,
    "unsupported_frame",
  );
  assert.equal(evaluations.length, 3, "Destroyed contexts cannot run in the main document");
  unsupported = true;
  const before = f.calls.length;
  for (const method of ["read", "wait", "evaluate", "locate_act"]) {
    const result = await f.request(method, "s1", {
      ...args,
      selector: "#name",
      expression: "6*7",
      action: { type: "fill", text: "wrong document" },
    });
    assert.equal(result.error.code, "unsupported_frame");
  }
  assert.equal(f.calls.slice(before).filter((call) => call[0].startsWith("Input.")).length, 0);
});

test("frame context tracking clears on context reset, detach and tab release", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
  const created = () =>
    f.chrome.debugger.onEvent.emit({ tabId: 2 }, "Runtime.executionContextCreated", {
      context: { id: 9, auxData: { frameId: "child", isDefault: true } },
    });
  created();
  assert.equal(f.bridge.frameContexts.get(2).get("child"), 9);
  f.chrome.debugger.onEvent.emit({ tabId: 2 }, "Runtime.executionContextsCleared", {});
  assert.equal(f.bridge.frameContexts.has(2), false);
  created();
  f.chrome.debugger.onDetach.emit({ tabId: 2 });
  assert.equal(f.bridge.frameContexts.has(2), false);
  created();
  await f.request("close");
  assert.equal(f.bridge.frameContexts.has(2), false);
  created();
  assert.equal(f.bridge.frameContexts.has(2), false);
});

test("read refuses navigation races without publishing misattributed snapshots", async () => {
  for (const changedURL of [true, false]) {
    const f = fixture();
    await f.request("open", "s1", { url: "https://a.example/" });
    const send = f.chrome.debugger.sendCommand;
    f.chrome.debugger.sendCommand = async (target, method, params) => {
      if (method === "Runtime.evaluate" && params.expression.includes("captureContent")) {
        if (changedURL) f.tabs.get(2).url = "https://b.example/";
        f.chrome.tabs.onUpdated.emit(2, {
          status: "loading",
          ...(changedURL ? { url: "https://b.example/" } : {}),
        });
        return { result: { value: "Document A text" } };
      }
      return send(target, method, params);
    };
    assert.equal((await f.request("read")).error.code, "stale_observation");
    assert.equal(f.bridge.sessions.get("s1").snapshot, undefined);
  }
});

test("navigation triggered by hover or fill preparation blocks subsequent native input", async () => {
  for (const kind of ["hover", "fill"]) {
    const f = fixture();
    const opened = await f.request("open", "s1", { url: "https://example.com/" });
    const send = f.chrome.debugger.sendCommand;
    f.chrome.debugger.sendCommand = async (target, method, params) => {
      const result = await send(target, method, params);
      if (
        (kind === "hover" && method === "Input.dispatchMouseEvent" && params.type === "mouseMoved") ||
        (kind === "fill" &&
          method === "Runtime.callFunctionOn" &&
          params.functionDeclaration.includes("selectNodeContents"))
      ) {
        f.tabs.get(2).url = "https://example.com/new";
        f.chrome.tabs.onUpdated.emit(2, { status: "loading" });
      }
      return result;
    };
    const action =
      kind === "hover"
        ? { type: "click", element_ref: "e1" }
        : { type: "fill", element_ref: "e2", text: "do not type" };
    assert.equal(
      (await f.request("act", "s1", { observation_id: opened.result.observation.observation_id, action }))
        .error.code,
      "outcome_unknown",
    );
    assert.equal(
      f.calls.filter(
        (call) =>
          call[0] === "Input.insertText" ||
          (call[0] === "Input.dispatchMouseEvent" && call[2].type === "mousePressed"),
      ).length,
      0,
    );
  }
});

test("native frame coordinates reject transformed frame ancestors", () => {
  const top = {
    getComputedStyle: () => ({ transform: "matrix(2,0,0,2,0,0)", perspective: "none", zoom: "1" }),
  };
  const frame = { ownerDocument: { defaultView: top }, parentElement: null };
  const win = {
    innerWidth: 100,
    innerHeight: 100,
    top,
    frameElement: frame,
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
  };
  const target = {
    isConnected: true,
    scrollIntoView() {},
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10 }),
    matches: () => false,
    closest: () => null,
    contains: () => false,
  };
  target.ownerDocument = { defaultView: win, elementFromPoint: () => target };
  assert.throws(() => prepareInput.call(target), /Transformed frames are unsupported/);
});

test("native input waits for compositor readiness and refuses failed or navigated paint without clicking", async () => {
  for (const failure of [false, true, "navigation"]) {
    const f = fixture();
    await f.request("open", "s1", { url: "https://example.com/" });
    const command = f.chrome.debugger.sendCommand;
    let painted = false;
    f.chrome.debugger.sendCommand = async (target, method, params) => {
      if (method === "Page.captureScreenshot") {
        assert.equal(params.clip.width, 1);
        if (failure === true) throw Error("Compositor unavailable");
        if (failure === "navigation") f.chrome.tabs.onUpdated.emit(2, { status: "loading" });
        painted = true;
      }
      if (method.startsWith("Input.")) assert.equal(painted, true);
      return command(target, method, params);
    };
    const observation = (await f.request("observe")).result;
    const result = await f.request("act", "s1", {
      observation_id: observation.observation_id,
      action: { type: "click", element_ref: "e1" },
      observe_after: false,
    });
    assert.equal(Boolean(result.error), Boolean(failure));
    const presses = f.calls.filter(
      (c) => c[0] === "Input.dispatchMouseEvent" && c[2].type === "mousePressed",
    );
    assert.equal(presses.length, failure ? 0 : 1);
    assert.equal(result.result?.image_base64, undefined);
  }
});

test("native click holds before releasing and rejects invalid durations before input", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
  const observation = (await f.request("observe")).result;
  for (const hold_ms of [-1, 10001, 1.5, "10"]) {
    const result = await f.request("act", "s1", {
      observation_id: observation.observation_id,
      action: { type: "click", element_ref: "e1", hold_ms },
      observe_after: false,
    });
    assert.equal(result.error?.code, "invalid_action");
  }
  assert.equal(
    f.calls.some((c) => c[0] === "Input.dispatchMouseEvent"),
    false,
  );
  const command = f.chrome.debugger.sendCommand;
  let pressed, released;
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") pressed = performance.now();
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased")
      released = performance.now();
    return command(target, method, params);
  };
  const result = await f.request("act", "s1", {
    observation_id: observation.observation_id,
    action: { type: "click", element_ref: "e1", hold_ms: 60 },
    observe_after: false,
  });
  assert.equal(result.result?.executed, true);
  assert.ok(released - pressed >= 50);
});

test("observations include explicitly labelled generic controls", async () => {
  const f = fixture();
  const command = f.chrome.debugger.sendCommand;
  f.chrome.debugger.sendCommand = async (target, method, params) =>
    method === "Accessibility.getFullAXTree"
      ? {
          nodes: [
            {
              backendDOMNodeId: 101,
              role: { value: "generic" },
              name: { value: "" },
              description: { value: "点赞（Q）" },
            },
          ],
        }
      : command(target, method, params);
  await f.request("open", "s1", { url: "https://example.com/" });
  const result = await f.request("observe", "s1", { query: "点赞" });
  assert.equal(result.result.elements.length, 1);
  assert.equal(result.result.elements[0].name, "点赞（Q）");
});

test("closing during a held click cancels promptly without replaying input", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
  const observation = (await f.request("observe")).result;
  const command = f.chrome.debugger.sendCommand;
  let pressed;
  const ready = new Promise((resolve) => {
    pressed = resolve;
  });
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    const result = await command(target, method, params);
    if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") pressed();
    return result;
  };
  const pending = f.request("act", "s1", {
    observation_id: observation.observation_id,
    action: { type: "click", element_ref: "e1", hold_ms: 10000 },
    observe_after: false,
  });
  await ready;
  await f.request("close");
  const result = await pending;
  assert.ok(result.error);
  assert.deepEqual(f.removed, [2]);
  assert.equal(
    f.calls.filter((c) => c[0] === "Input.dispatchMouseEvent" && c[2].type === "mousePressed").length,
    1,
  );
});
