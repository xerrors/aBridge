import { test } from "node:test";
import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";
import { BrowserBridge } from "../src/bridge.ts";
import {
  captureContent,
  prepareInput,
  validateInput,
  validateSelect,
  selectValues,
  scrollElement,
} from "../src/page-tools.ts";
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
    webNavigation: { onCreatedNavigationTarget: event() },
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
  const bridge = new BrowserBridge(chrome, { now: () => now });
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
    advance: (milliseconds = 60000) => {
      now += milliseconds;
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
test("a condition timeout preserves the dispatched input receipt", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
  const send = f.chrome.debugger.sendCommand;
  let matched = false;
  f.chrome.debugger.sendCommand = async (target, method, params) =>
    method === "Runtime.evaluate" && params.expression.includes("checkCondition")
      ? { result: { value: matched } }
      : send(target, method, params);
  for (matched of [false, true]) {
    const obs = (await f.request("observe")).result;
    const result = await f.request("act", "s1", {
      observation_id: obs.observation_id,
      action: { type: "click", element_ref: "e1" },
      observe_after: false,
      verify: { selector: "#variant input", state: "value", value: "3", timeout_ms: 10 },
    });
    assert.equal(result.status, "executed");
    assert.equal(result.result.input_dispatched, true);
    assert.equal(result.result.verification.matched, matched);
    if (!matched) assert.equal(result.result.verification.error.code, "wait_timeout");
  }
  assert.equal(
    f.calls.filter((c) => c[0] === "Input.dispatchMouseEvent" && c[2].type === "mousePressed").length,
    2,
  );
});
test("value verification rejects ambiguous fields without losing the input receipt", async () => {
  const f = fixture();
  const opened = await f.request("open", "s1", { url: "https://example.com/" });
  const send = f.chrome.debugger.sendCommand;
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "Runtime.evaluate" && params.expression.includes("checkCondition")) {
      const document = { querySelectorAll: () => [{ value: "1" }, { value: "3" }] };
      return { result: { value: runInNewContext(params.expression, { document }) } };
    }
    return send(target, method, params);
  };
  const response = await f.request("act", "s1", {
    observation_id: opened.result.observation.observation_id,
    action: { type: "click", element_ref: "e1" },
    observe_after: false,
    verify: { selector: ".quantity", state: "value", value: "3" },
  });
  assert.equal(response.status, "executed");
  assert.equal(response.result.input_dispatched, true);
  assert.equal(response.result.verification.matched, false);
  assert.equal(response.result.verification.error.code, "target_not_unique");
});

test("cross-session, expired and navigation-invalidated references never write", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
  await f.request("open", "s2", { url: "https://example.com/" });
  const one = (await f.request("observe")).result;
  const two = (await f.request("observe", "s2")).result;
  assert.match(one.observation_id, /^obs_[A-Za-z0-9_-]{8}$/);
  assert.notEqual(one.observation_id, two.observation_id);
  assert.equal(
    (
      await f.request("act", "s2", {
        observation_id: one.observation_id,
        action: { type: "click", element_ref: "e1" },
      })
    ).error.code,
    "stale_observation",
  );
  const replacement = (await f.request("observe")).result;
  assert.notEqual(replacement.observation_id, one.observation_id);
  assert.equal(
    (
      await f.request("act", "s1", {
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
        observation_id: replacement.observation_id,
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
  assert.equal(f.bridge.tabs.tasks.get("s1").observation, null);
  await f.bridge.stop();
  assert.equal(f.bridge.tabs.tasks.size, 0);
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
  assert.equal(f.bridge.tabs.tasks.get("s1").observation, null);
});
test("stop during tab creation removes the late task tab and cannot resurrect a session", async () => {
  const f = fixture();
  const original = f.chrome.tabs.create;
  let release, entered;
  const started = new Promise((resolve) => (entered = resolve));
  f.chrome.tabs.create = async (params) => {
    entered();
    await new Promise((resolve) => {
      release = resolve;
    });
    return original(params);
  };
  const opening = f.request("open", "s1", { url: "https://example.com/" });
  await started;
  const stopping = f.bridge.stop();
  release();
  await stopping;
  const result = await opening;
  assert.equal(result.error.code, "session_closed");
  assert.equal(f.bridge.tabs.tasks.size, 0);
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
  f.bridge.tabs.navigationTimeout = 15;
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
  await f.request("open", "s1", { url: "https://example.com/" });
  f.chrome.debugger.onDetach.emit({ tabId: 2 });
  f.calls.length = 0;
  let release;
  f.chrome.debugger.attach = async () =>
    new Promise((resolve) => {
      release = resolve;
    });
  let detached = 0;
  f.chrome.debugger.detach = async () => {
    detached++;
  };
  const observing = f.request("observe");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await f.bridge.stop();
  release();
  assert.equal((await observing).error.code, "session_closed");
  assert.equal(detached, 1);
  assert.equal(f.bridge.tabs.tasks.size, 0);
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
  assert.equal(f.bridge.tabs.tasks.size, 0);
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
  assert.equal((await f.request("close")).error.code, "cleanup_failed");
  assert.deepEqual(stored.owned_task_tabs, [2]);
  assert.equal(f.bridge.tabs.ownedTabs.has(2), true);
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
  assert.ok(result.elements.length > 4);
  assert.equal(result.truncated, true);
  assert.equal(result.elements[4].role, "statictext");
  assert.equal(result.elements[0].url, "https://github.example/notifications?query=is%3Aunread");
  assert.equal(result.elements[0].selected, true);
  assert.equal(result.elements[1].checked, "mixed");
  assert.equal(result.elements[1].disabled, undefined);
  assert.equal(result.elements[2].expanded, false);
  assert.equal(result.elements[3].url, undefined);
  assert.equal(f.bridge.tabs.tasks.get("s1").observation.refs.get("e1"), 7);
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
  assert.equal(result.scan.ax_nodes, 700);
  assert.equal(result.elements_returned, result.elements.length);
  const names = result.elements.map((element) => element.name);
  let offset = result.next_element_offset;
  while (offset !== undefined) {
    assert.equal(offset, names.length);
    const next = (await f.request("observe", "s1", { element_offset: offset })).result;
    names.push(...next.elements.map((element) => element.name));
    offset = next.next_element_offset;
  }
  assert.deepEqual(
    names,
    Array.from({ length: 700 }, (_, i) => `Button ${i}`),
  );
  const empty = (await f.request("observe", "s1", { query: "missing" })).result;
  assert.ok(empty.page_summary);
  assert.equal(empty.elements_total, 0);
});

test("observe preserves a full-size excerpt when the controls and URL fit", async () => {
  const f = fixture(),
    url = "https://example.com/" + "a".repeat(1600),
    text = "x".repeat(3997);
  await f.request("open", "s1", { url });
  const send = f.chrome.debugger.sendCommand;
  f.chrome.debugger.sendCommand = async (target, method, params) =>
    method === "Runtime.evaluate" && params.expression.includes("document.body?.innerText")
      ? { result: { value: { text, truncated: false, base_uri: url } } }
      : send(target, method, params);
  const obs = (await f.request("observe")).result;
  assert.equal(obs.text, text);
  assert.ok(obs.elements.length > 0);
  assert.ok(JSON.stringify(obs).length <= 7000);
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
  await f.request("open", "s1", { url: "https://example.com/" });
  const obs = (await f.request("observe")).result;
  const invalidAct = await f.request("act", "s1", {
    observation_id: obs.observation_id,
    action: { type: "fill", element_ref: "e2", text: 42 },
  });
  assert.equal(invalidAct.error.code, "invalid_action");
  assert.equal(f.bridge.tabs.tasks.get("s1").observation.id, obs.observation_id);
  assert.equal((await f.request("observe", "s1", { query: 42 })).error.code, "invalid_params");
  assert.equal(f.bridge.tabs.tasks.get("s1").observation.id, obs.observation_id);
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
  await f.request("open", "s1", { url: "https://example.com/" });
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
  assert.equal(f.bridge.tabs.tasks.get("s1").observation.refs.get(queried.elements[0].element_ref), 500);
});

test("link metadata collection uses bounded concurrency instead of serial round trips", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
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
  f.bridge.tabs.navigationTimeout = 10;
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
  f.bridge.tabs.navigationTimeout = 10;
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
  await f.request("open", "s1", { url: "https://example.com/" });
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
  assert.equal(f.bridge.tabs.tasks.size, 0);
});

test("retry shares the original readiness budget and never reattaches after debugger detach", async () => {
  const f = fixture();
  f.bridge.tabs.navigationTimeout = 20;
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
  assert.equal(f.bridge.tabs.tasks.get("s1").observation, null);
  release({ nodes: [] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.bridge.tabs.tasks.get("s1").observation, null);
  assert.equal(f.calls.filter((c) => c[0] === "create").length, 1);
});

test("attach and setup obey observation deadline and late cleanup precedes a later attach", async () => {
  const f = fixture();
  f.bridge.tabs.navigationTimeout = 20;
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
  assert.equal(f.bridge.tabs.tasks.get("s1").observation, null);
  const later = f.request("observe");
  release();
  const observed = await later;
  assert.ok(observed.result.observation_id);
  assert.equal(attaches, 2);
  assert.equal(detaches, 1);
  assert.equal(f.bridge.tabs.tasks.get("s1").attached, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(detaches, 1);
});

test("Page.enable obeys observation deadline and its late result cannot detach a new session", async () => {
  const f = fixture();
  f.bridge.tabs.navigationTimeout = 20;
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
  assert.equal(f.bridge.tabs.tasks.get("s1").observation, null);
  await f.bridge.close("s1");
  const next = await f.request("open", "s2", { url: "https://other.example/" });
  assert.ok(next.result.observation.observation_id);
  const before = detaches;
  release({});
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(detaches, before);
  assert.equal(f.bridge.tabs.tasks.get("s2").attached, true);
});

test("late attach cleanup never detaches a replacement session that owns the same tab id", async () => {
  const f = fixture();
  f.bridge.tabs.navigationTimeout = 20;
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
  assert.equal(f.bridge.tabs.tasks.get("s2").attached, true);
});

test("protected field values never affect query matches, truncation or returned metadata", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
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
  assert.match(first.snapshot_id, /^snap_[A-Za-z0-9_-]{8}$/);
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
  const other = (await f.request("read", "s2")).result;
  assert.notEqual(other.snapshot_id, first.snapshot_id);
  assert.equal(
    (await f.request("read", "s2", { snapshot_id: first.snapshot_id })).error.code,
    "snapshot_missing",
  );
  const replacement = (await f.request("read", "s1")).result;
  assert.notEqual(replacement.snapshot_id, first.snapshot_id);
  assert.equal(
    (await f.request("read", "s1", { snapshot_id: first.snapshot_id })).error.code,
    "snapshot_missing",
  );
});

test("escaped observation previews fit the envelope while retaining a usable ref on each page", async () => {
  const f = fixture();
  const url = "https://example.com/" + "u".repeat(1930);
  await f.request("open", "s1", { url });
  const send = f.chrome.debugger.sendCommand;
  const escaped = (code) => String.fromCharCode(code).repeat(240);
  f.tabs.get(2).title = escaped(3);
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "Accessibility.getFullAXTree")
      return {
        nodes: [1, 2].map((i) => ({
          backendDOMNodeId: i,
          role: { value: "textbox" },
          name: { value: "Find" + escaped(1) },
          description: { value: escaped(2) },
          value: { value: escaped(4) },
        })),
      };
    if (method === "Runtime.evaluate" && params.returnByValue)
      return { result: { value: { text: escaped(5) + "Find", base_uri: url } } };
    if (method === "DOM.describeNode") return { node: { attributes: ["type", escaped(6)] } };
    return send(target, method, params);
  };
  const request = { query: "Find" };
  const first = (await f.request("observe", "s1", request)).result;
  assert.equal(first.elements.length, 1);
  assert.equal(first.next_element_offset, 1);
  assert.equal(first.truncated, true);
  assert.ok(JSON.stringify(first).length <= 7000);
  assert.equal(f.bridge.tabs.tasks.get("s1").observation.refs.get(first.elements[0].element_ref), 1);
  const second = (await f.request("observe", "s1", { ...request, element_offset: first.next_element_offset }))
    .result;
  assert.equal(second.elements.length, 1);
  assert.ok(JSON.stringify(second).length <= 7000);
  assert.equal(second.next_element_offset, undefined);
  assert.equal(f.bridge.tabs.tasks.get("s1").observation.refs.get(second.elements[0].element_ref), 2);
});

test("escaped snapshot text continues at the encoded page budget without losing characters", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
  const send = f.chrome.debugger.sendCommand;
  const content = "\u0001".repeat(12000);
  f.chrome.debugger.sendCommand = async (target, method, params) =>
    method === "Runtime.evaluate" && params.expression.includes("captureContent")
      ? { result: { value: content } }
      : send(target, method, params);
  let page = (await f.request("read")).result;
  let text = page.text;
  assert.equal(page.next_offset, 3999);
  while (page.next_offset !== null) {
    page = (await f.request("read", "s1", { snapshot_id: page.snapshot_id, offset: page.next_offset }))
      .result;
    assert.ok(JSON.stringify(page.text).length <= 24000);
    text += page.text;
  }
  assert.equal(text, content);
});

test("nested table rows and cells retain their owning table", () => {
  class Table {
    constructor(rows) {
      this.rows = rows;
    }
  }
  const cell = (innerText) => ({ innerText, rowSpan: 1, colSpan: 1 });
  const inner = new Table([{ cells: [cell("SKU")] }]);
  const outer = new Table([{ cells: [cell("Product SKU")] }]);
  const body = { querySelectorAll: () => [outer, inner] };
  const read = new Function(
    "document",
    "HTMLTableElement",
    "selector",
    "return (" + captureContent.toString() + ")(selector, 'table')",
  );
  const document = { body, querySelector: () => outer };
  const all = read(document, Table, undefined);
  assert.deepEqual(
    all.map(({ table, row, cells }) => [table, row, cells.map((c) => c.text)]),
    [
      [0, 0, ["Product SKU"]],
      [1, 0, ["SKU"]],
    ],
  );
  assert.deepEqual(read(document, Table, "#outer"), all.slice(0, 1));
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
  const continuation = { snapshot_id: first.snapshot_id, offset: first.next_offset };
  const last = (await f.request("read", "s1", continuation)).result;
  assert.equal(last.cached, true);
  assert.equal(last.mode, "tables");
  assert.deepEqual(last.rows, rows.slice(200));
  assert.equal(last.next_offset, null);
  for (const changedScope of [{ selector: "#other" }, { frame_selector: "#other-frame" }]) {
    const refused = await f.request("read", "s1", { ...continuation, ...changedScope });
    assert.equal(refused.error.code, "invalid_params");
  }
  const pastEnd = (await f.request("read", "s1", { ...continuation, offset: 999 })).result;
  assert.deepEqual(pastEnd.rows, []);
  assert.equal(pastEnd.offset, rows.length);
  assert.equal(pastEnd.next_offset, null);
  assert.equal(
    (await f.request("read", "s1", { ...continuation, mode: "text" })).error.code,
    "snapshot_missing",
  );
});

test("wait allows the target iframe to mount before the condition matches", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
  let polls = 0;
  f.bridge.pageValue = async (_session, _expression, _timeout, frame) => {
    assert.equal(frame, "#editor");
    if (++polls === 1) throw Object.assign(new Error("Frame has not mounted"), { code: "target_missing" });
    return true;
  };
  const receipt = await f.request("wait", "s1", {
    frame_selector: "#editor",
    selector: "#ready",
    timeout_ms: 1000,
  });
  assert.equal(receipt.result.matched, true);
  assert.equal(polls, 2);
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
  assert.equal(f.bridge.tabs.tasks.size, 0);
});

test("locator actions resolve each target anew and reject ambiguous selectors", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
  const send = f.chrome.debugger.sendCommand;
  let ambiguous = false;
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "Accessibility.getFullAXTree") {
      const ax = { role: { value: "StaticText" }, name: { value: "Add" } };
      return {
        nodes: [
          { ...ax, backendDOMNodeId: 101 },
          { ...ax, backendDOMNodeId: 102 },
          { ...ax, ignored: true, backendDOMNodeId: 103 },
          { role: ax.role, description: ax.name, backendDOMNodeId: 104 },
        ],
      };
    }
    if (method === "DOM.resolveNode" && params.objectGroup === "abridge-locator-scope")
      return { object: { objectId: String(params.backendNodeId) } };
    if (method === "Runtime.callFunctionOn" && params.objectId === "100") {
      assert.deepEqual(params.arguments, [{ objectId: "101" }, { objectId: "102" }]);
      const doc = {};
      const scope = { ownerDocument: doc, isConnected: true };
      const host = { parentNode: scope };
      const slot = { parentNode: { nodeType: 11, host } };
      const slotted = { ownerDocument: doc, isConnected: true, assignedSlot: slot };
      const other = { ownerDocument: {}, isConnected: true, parentNode: scope };
      const check = Function("return (" + params.functionDeclaration + ")")();
      return { result: { value: check.call(scope, slotted, other) } };
    }
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
  const semantic = await f.request("locate_act", "s1", {
    selector: { within: "#row", role: "statictext", name: "Add" },
    action: { type: "click" },
  });
  assert.equal(semantic.result.input_dispatched, true);
  ambiguous = true;
  assert.equal(
    (await f.request("locate_act", "s1", { selector: "button", action: { type: "click" } })).error.code,
    "target_not_unique",
  );
});

test("scoped semantic locator checks later batches for duplicates before dispatch", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
  const send = f.chrome.debugger.sendCommand;
  const sizes = [];
  let released = 0;
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "DOM.querySelectorAll") return { nodeIds: [5] };
    if (method === "DOM.describeNode") return { node: { backendNodeId: 5 } };
    if (method === "Accessibility.getFullAXTree")
      return {
        nodes: Array.from({ length: 23 }, (_, i) => ({
          role: { value: "button" },
          name: { value: "Add" },
          backendDOMNodeId: i + 100,
        })),
      };
    if (method === "DOM.resolveNode" && params.objectGroup === "abridge-locator-scope")
      return { object: { objectId: String(params.backendNodeId) } };
    if (method === "Runtime.callFunctionOn" && params.objectId === "5") {
      sizes.push(params.arguments.length);
      return { result: { value: params.arguments.map(({ objectId }) => ["100", "122"].includes(objectId)) } };
    }
    if (method === "Runtime.releaseObjectGroup" && params.objectGroup === "abridge-locator-scope") released++;
    return send(target, method, params);
  };
  const response = await f.request("locate_act", "s1", {
    selector: { within: "#sku", role: "button", name: "Add" },
    action: { type: "click" },
  });
  assert.equal(response.error.code, "target_not_unique");
  assert.deepEqual(sizes, [16, 7]);
  assert.equal(released, 2);
  assert.equal(
    f.calls.some(([method]) => method.startsWith("Input.")),
    false,
  );
});

test("locator refusal distinguishes missing, invalid, ambiguous and transport failures before input", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
  const original = f.bridge.tabs.tasks.get("s1").observation;
  const send = f.chrome.debugger.sendCommand;
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "DOM.querySelectorAll") {
      if (["[", "#broken"].includes(params.selector)) throw Error("CDP lookup error");
      return {
        nodeIds: params.selector === "#missing" ? [] : params.selector === ".duplicate" ? [1, 2] : [1],
      };
    }
    if (method === "DOM.describeNode") return { node: { backendNodeId: 100, frameId: "frame" } };
    if (method === "Accessibility.getFullAXTree") return { nodes: [] };
    if (method === "Runtime.evaluate") {
      if (params.objectGroup === "abridge-frame") return { result: { objectId: "frame" } };
      return { result: { value: params.expression.includes('document.querySelector("[")') } };
    }
    if (method === "Runtime.callFunctionOn" && params.objectId === "frame")
      return { result: { value: params.arguments[0].value === "[" ? "invalid_selector" : 0 } };
    return send(target, method, params);
  };
  for (const [selector, frame_selector, status, code] of [
    ["#missing", undefined, "refused", "target_missing"],
    [{ role: "button", name: "Absent" }, undefined, "refused", "target_missing"],
    [".duplicate", undefined, "refused", "target_not_unique"],
    ["[", undefined, "refused", "invalid_selector"],
    ["[", "#frame", "refused", "invalid_selector"],
    ["#missing", "#frame", "refused", "target_missing"],
    ["#broken", undefined, "failed", "browser_error"],
  ]) {
    const response = await f.request("locate_act", "s1", {
      selector,
      frame_selector,
      action: { type: "click" },
    });
    assert.equal(response.status, status);
    assert.equal(response.error.code, code);
  }
  assert.equal(f.bridge.tabs.tasks.get("s1").observation, original);
  assert.equal(
    f.calls.some(([method]) => method.startsWith("Input.")),
    false,
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
    0,
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
        verify: { selector: "#name", state: "value", value: "framed" },
      })
    ).result.verification.matched,
    true,
  );
  f.chrome.debugger.onEvent.emit({ tabId: 2 }, "Runtime.executionContextDestroyed", {
    executionContextId: 73,
  });
  assert.equal(
    (await f.request("evaluate", "s1", { ...args, expression: "6*7" })).error.code,
    "unsupported_frame",
  );
  assert.equal(evaluations.length, 4, "Destroyed contexts cannot run in the main document");
  unsupported = true;
  const before = f.calls.length;
  for (const method of ["read", "wait", "evaluate", "locate_act"]) {
    const params = {
      read: { ...args, selector: "#name" },
      wait: { ...args, selector: "#name" },
      evaluate: { ...args, expression: "6*7" },
      locate_act: { ...args, selector: "#name", action: { type: "fill", text: "wrong document" } },
    };
    const result = await f.request(method, "s1", params[method]);
    assert.equal(result.error.code, "unsupported_frame");
  }
  assert.equal(f.calls.slice(before).filter((call) => call[0].startsWith("Input.")).length, 0);
});

test("frame selector reports syntax, count and unsupported document before running page code", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
  class Frame {
    contentDocument = null;
  }
  const send = f.chrome.debugger.sendCommand;
  let submitted = false;
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "Runtime.evaluate" && params.objectGroup === "abridge-frame") {
      const document = {
        querySelectorAll(selector) {
          switch (selector) {
            case "[":
              throw new DOMException("invalid selector", "SyntaxError");
            case ".missing":
              return [];
            case ".duplicate":
              return [new Frame(), new Frame()];
            case "#not-frame":
              return [{}];
            case "#cross-origin":
              return [new Frame()];
            default:
              throw Error("document unavailable");
          }
        },
      };
      try {
        return {
          result: {
            value: Function("document", "HTMLIFrameElement", `return ${params.expression}`)(document, Frame),
          },
        };
      } catch (error) {
        return { exceptionDetails: { text: error.message } };
      }
    }
    if (method === "Runtime.evaluate") submitted = true;
    return send(target, method, params);
  };
  for (const [selector, code, status] of [
    ["[", "invalid_selector", "refused"],
    [".missing", "target_missing", "refused"],
    [".duplicate", "target_not_unique", "refused"],
    ["#not-frame", "unsupported_frame", "refused"],
    ["#cross-origin", "unsupported_frame", "refused"],
    ["#unavailable", "locator_failed", "failed"],
  ]) {
    const result = await f.request("evaluate", "s1", {
      frame_selector: selector,
      expression: "window.executed=true",
    });
    assert.equal(result.status, status);
    assert.equal(result.error.code, code);
  }
  assert.equal(submitted, false);
});
test("frame context tracking clears on context reset, detach and tab release", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
  const created = () =>
    f.chrome.debugger.onEvent.emit({ tabId: 2 }, "Runtime.executionContextCreated", {
      context: { id: 9, auxData: { frameId: "child", isDefault: true } },
    });
  created();
  assert.equal(f.bridge.tabs.frameContexts.get(2).get("child"), 9);
  f.chrome.debugger.onEvent.emit({ tabId: 2 }, "Runtime.executionContextsCleared", {});
  assert.equal(f.bridge.tabs.frameContexts.has(2), false);
  created();
  f.chrome.debugger.onDetach.emit({ tabId: 2 });
  assert.equal(f.bridge.tabs.frameContexts.has(2), false);
  created();
  await f.request("close");
  assert.equal(f.bridge.tabs.frameContexts.has(2), false);
  created();
  assert.equal(f.bridge.tabs.frameContexts.has(2), false);
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
    assert.equal(f.bridge.tabs.tasks.get("s1").snapshot, undefined);
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
  assert.equal(result.result.elements[0].accessible_name, "");
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

test("concurrent cleanup waits for the same removal before a new task starts", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
  const remove = f.chrome.tabs.remove;
  let release, entered;
  const started = new Promise((resolve) => (entered = resolve));
  let calls = 0;
  f.chrome.tabs.remove = async (id) => {
    calls++;
    entered();
    await new Promise((resolve) => (release = resolve));
    await remove(id);
  };
  let secondDone = false;
  const first = f.bridge.close("s1");
  await started;
  const second = f.bridge.close("s1").then(() => (secondDone = true));
  const opening = f.request("open", "s2", { url: "https://example.com/new" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(secondDone, false);
  assert.equal(f.calls.filter((entry) => entry[0] === "create").length, 1);
  release();
  await Promise.all([first, second]);
  assert.equal((await opening).result.tab_id, 3);
  assert.equal(calls, 1);
});

test("evaluate timeout waits for one cleanup and reports failure without losing the original cause", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
  const send = f.chrome.debugger.sendCommand;
  f.chrome.debugger.sendCommand = async (...args) =>
    args[1] === "Runtime.evaluate" && args[2].expression === "pending-script"
      ? new Promise(() => {})
      : send(...args);
  let release, entered;
  const started = new Promise((resolve) => (entered = resolve));
  let removals = 0;
  f.chrome.tabs.remove = async () => {
    removals++;
    entered();
    await new Promise((resolve) => (release = resolve));
    throw Error("removal denied");
  };
  let settled = false;
  const evaluating = f
    .request("evaluate", "s1", { expression: "pending-script", timeout_ms: 10 })
    .then((r) => {
      settled = true;
      return r;
    });
  await started;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false);
  release();
  const result = await evaluating;
  assert.equal(result.error.code, "outcome_unknown");
  assert.equal(removals, 1);
  assert.ok(f.bridge.tabs.ownedTabs.has(2));
  assert.match(JSON.stringify(result.error), /cleanup|清理/);
  assert.match(JSON.stringify(result.error), /timeout|超时/);
});

test("missing task tab requires reopening and never replays an old action", async () => {
  const f = fixture();
  const opened = await f.request("open", "s1", { url: "https://example.com/" });
  await f.chrome.tabs.remove(2);
  const missing = await f.request("act", "s1", {
    observation_id: opened.result.observation.observation_id,
    action: { type: "click", element_ref: "e1" },
  });
  assert.equal(missing.error.code, "task_tab_missing");
  const reopened = await f.request("open", "s1", { url: "https://example.com/new" });
  assert.equal(reopened.result.tab_id, 3);
  assert.equal(f.calls.filter((entry) => entry[0] === "Input.dispatchMouseEvent").length, 0);
});

test("query arrays reject empty, blank and oversized terms before changing observations", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
  const original = f.bridge.tabs.tasks.get("s1").observation;
  for (const query of ["", " ", [], [""], ["valid", " "], ["x".repeat(201)], Array(21).fill("x")]) {
    assert.equal((await f.request("observe", "s1", { query })).error.code, "invalid_params");
    assert.equal(f.bridge.tabs.tasks.get("s1").observation, original);
  }
});

test("stop or close while a new open waits for old cleanup prevents the new tab", async () => {
  for (const ending of ["stop", "close"]) {
    const f = fixture();
    await f.request("open", "s1", { url: "https://example.com/" });
    const remove = f.chrome.tabs.remove;
    let release, entered;
    const started = new Promise((resolve) => (entered = resolve));
    f.chrome.tabs.remove = async (id) => {
      entered();
      await new Promise((resolve) => (release = resolve));
      await remove(id);
    };
    const closing = f.bridge.close("s1");
    await started;
    const opening = f.request("open", "s2", { url: "https://example.com/new" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const endingTask = ending === "stop" ? f.bridge.stop() : f.bridge.close("s2");
    release();
    await Promise.all([closing, endingTask]);
    const result = await opening;
    assert.equal(result.error.code, "session_closed", ending);
    assert.equal(f.calls.filter((entry) => entry[0] === "create").length, 1, ending);
  }
});

test("cancelled open during tab creation removes the late tab and does not navigate or observe", async () => {
  const f = fixture();
  const create = f.chrome.tabs.create;
  let release,
    entered,
    cancelled = false;
  const started = new Promise((resolve) => (entered = resolve));
  f.chrome.tabs.create = async (params) => {
    entered();
    await new Promise((resolve) => (release = resolve));
    return create(params);
  };
  const opening = f.bridge.dispatch({
    id: "cancel-pending-open",
    method: "open",
    session_id: "s1",
    params: { url: "https://example.com/" },
    isCancelled: () => cancelled,
  });
  await started;
  cancelled = true;
  release();
  const result = await opening;
  assert.ok(result.error, JSON.stringify(result));
  assert.deepEqual(f.removed, [2]);
  assert.equal(f.bridge.tabs.tasks.size, 0);
  assert.equal(f.calls.filter((entry) => entry[0] === "Accessibility.getFullAXTree").length, 0);
});

test("shared action validation rejects malformed input before CDP preparation and keeps the observation", async () => {
  const f = fixture();
  const opened = await f.request("open", "s1", { url: "https://example.com/" });
  const observation = opened.result.observation;
  const before = f.calls.length;
  for (const action of [
    { type: "press", element_ref: "e1", key: "k".repeat(33) },
    { type: "select", element_ref: "e1", values: Array.from({ length: 101 }, () => "x") },
  ]) {
    const response = await f.request("act", "s1", {
      observation_id: observation.observation_id,
      action,
      observe_after: false,
    });
    assert.equal(response.status, "refused");
    assert.equal(response.error.code, "invalid_action");
  }
  assert.equal(f.calls.length, before, "Rejected input must not scroll, focus or dispatch native input");
  assert.equal(f.bridge.tabs.tasks.get("s1").observation.id, observation.observation_id);
});

test("locator resolution preserves the prior observation when the resolved node disappears", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
  const previous = f.bridge.tabs.tasks.get("s1").observation;
  const send = f.chrome.debugger.sendCommand;
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "DOM.querySelectorAll") return { nodeIds: [3] };
    if (method === "DOM.describeNode") return { node: { backendNodeId: 100 } };
    if (method === "DOM.resolveNode") return {};
    return send(target, method, params);
  };
  const before = f.calls.length;
  const response = await f.request("locate_act", "s1", {
    selector: "#missing-after-lookup",
    action: { type: "click" },
  });
  assert.equal(response.status, "refused");
  assert.equal(response.error.code, "stale_observation");
  assert.equal(f.bridge.tabs.tasks.get("s1").observation, previous);
  assert.equal(
    f.calls
      .slice(before)
      .some(([method]) => method.startsWith("Input.") || method === "Runtime.callFunctionOn"),
    false,
  );
});

test("disposing the browser runtime releases task resources and event subscriptions", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
  const events = [
    f.chrome.tabs.onUpdated,
    f.chrome.tabs.onRemoved,
    f.chrome.debugger.onDetach,
    f.chrome.debugger.onEvent,
  ];
  assert.equal(
    events.every((event) => event.listeners.length > 0),
    true,
  );
  await f.bridge.dispose();
  assert.equal(f.bridge.sessionCount, 0);
  assert.deepEqual([...f.bridge.sessionIds], []);
  assert.equal(f.tabs.size, 1);
  assert.equal(
    events.every((event) => event.listeners.length === 0),
    true,
  );
  const result = await f.request("open", "s1", { url: "https://example.com/" });
  assert.equal(result.error.code, "session_closed");
  assert.equal(f.tabs.size, 1);
  await f.bridge.dispose();
});

test("visible non-semantic text has a reference and query can focus its click target", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
  const send = f.chrome.debugger.sendCommand;
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "Accessibility.getFullAXTree")
      return {
        nodes: [
          { backendDOMNodeId: 401, role: { value: "StaticText" }, name: { value: "Open detail" } },
          { backendDOMNodeId: 402, role: { value: "InlineTextBox" }, name: { value: "Open detail" } },
        ],
      };
    return send(target, method, params);
  };
  const observation = (await f.request("observe", "s1", { query: "Open detail" })).result;
  assert.equal(observation.elements.length, 1);
  assert.equal(observation.elements[0].name, "Open detail");
  const action = await f.request("act", "s1", {
    observation_id: observation.observation_id,
    action: { type: "click", element_ref: observation.elements[0].element_ref },
  });
  assert.equal(action.result.executed, true);
  assert.equal(f.calls.find((c) => c[0] === "DOM.resolveNode")[2].backendNodeId, 401);
});

test("readonly validation refuses before focus or input and keeps the session available", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
  const observation = (await f.request("observe")).result;
  const send = f.chrome.debugger.sendCommand;
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "Runtime.callFunctionOn" && params.functionDeclaration.includes("validateInput"))
      return { result: { value: "Readonly: use the page picker" } };
    return send(target, method, params);
  };
  const before = f.calls.length;
  const result = await f.request("act", "s1", {
    observation_id: observation.observation_id,
    action: { type: "fill", element_ref: "e2", text: "2020-01-01" },
  });
  assert.equal(result.error.code, "invalid_action");
  assert.equal(f.removed.length, 0);
  assert.equal(f.calls.slice(before).filter((c) => c[0].startsWith("Input.")).length, 0);
  assert.ok((await f.request("observe")).result.observation_id);
});

test("pure validation accepts root keyboard actions and rejects readonly without focusing", () => {
  assert.equal(validateInput.call({ nodeType: 9 }, "press"), null);
  assert.match(validateInput.call({ nodeType: 9 }, "click"), /根节点/);
  assert.match(validateInput.call({ nodeType: 1, readOnly: true }, "fill"), /只读/);
});

test("text references target glyph bounds rather than a mixed container's center", () => {
  const win = {
    innerWidth: 1000,
    innerHeight: 1000,
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
  };
  win.top = win;
  const parent = {
    isConnected: true,
    scrollIntoView() {},
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 400, height: 100 }),
    matches: () => false,
    closest: () => null,
    contains: () => true,
    focus() {},
  };
  const text = { nodeType: 3, parentElement: parent };
  parent.ownerDocument = {
    defaultView: win,
    elementFromPoint: () => parent,
    createRange: () => ({
      selectNodeContents(node) {
        assert.equal(node, text);
      },
      getBoundingClientRect: () => ({ x: 10, y: 20, width: 30, height: 10 }),
    }),
  };
  assert.deepEqual(prepareInput.call(text, "click"), { x: 25, y: 25 });
  assert.match(
    validateInput.call({ nodeType: 3, parentElement: { isContentEditable: true } }, "fill"),
    /文本引用/,
  );
});

test("references tolerate model latency within 60s while expiry still refuses before writing", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
  let obs = (await f.request("observe")).result;
  assert.equal(obs.expires_in, 60);
  f.advance(30000);
  assert.equal(
    (
      await f.request("act", "s1", {
        observation_id: obs.observation_id,
        action: { type: "click", element_ref: "e1" },
      })
    ).result.executed,
    true,
  );
  obs = (await f.request("observe")).result;
  f.advance(61000);
  const before = f.calls.length;
  assert.equal(
    (
      await f.request("act", "s1", {
        observation_id: obs.observation_id,
        action: { type: "click", element_ref: "e1" },
      })
    ).error.code,
    "stale_observation",
  );
  assert.equal(f.calls.slice(before).filter((c) => c[0].startsWith("Input.")).length, 0);
});

test("pointer preparation preserves native focus ordering; targeted key input still focuses", () => {
  let focused = 0;
  const win = {
    innerWidth: 100,
    innerHeight: 100,
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
  };
  win.top = win;
  const target = {
    isConnected: true,
    scrollIntoView() {},
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10 }),
    matches: () => false,
    closest: () => null,
    contains: () => false,
    focus() {
      focused++;
    },
  };
  target.ownerDocument = { defaultView: win, elementFromPoint: () => target };
  for (const action of ["click", "hover", "scroll", "fill"]) prepareInput.call(target, action);
  assert.equal(focused, 0);
  prepareInput.call(target, "press");
  assert.equal(focused, 1);
});

test("neutral visual targets keep original DOM identity and reject malformed geometry", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
  const send = f.chrome.debugger.sendCommand;
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "Runtime.evaluate" && params.expression.includes("capturePointerTargets"))
      return { result: { objectId: "pointer-root" } };
    if (method === "Runtime.getProperties")
      return params.objectId === "pointer-root"
        ? { result: [{ name: "targets", value: { objectId: "pointer-array" } }] }
        : {
            result: [
              { name: "0", value: { objectId: "original-icon" } },
              { name: "1", value: { objectId: "bad-icon" } },
              { name: "2", value: { objectId: "duplicate-icon" } },
            ],
          };
    if (method === "Runtime.callFunctionOn" && params.functionDeclaration.includes("pointerTargetDetails"))
      return {
        result: {
          value:
            params.objectId === "bad-icon"
              ? { name: "invalid", bounds: { x: -1, y: 0, width: 0, height: 10 } }
              : { name: "Unlabelled clickable target", bounds: { x: 10, y: 20, width: 24, height: 24 } },
        },
      };
    if (method === "DOM.describeNode" && params.objectId) return { node: { backendNodeId: 701 } };
    if (method === "DOM.getNodeForLocation") throw Error("Must never rebind by coordinates");
    return send(target, method, params);
  };
  const obs = (await f.request("observe")).result;
  assert.equal(obs.elements[0].role, "button");
  const visual = obs.elements.filter((e) => e.role === "visualtarget");
  assert.equal(visual.length, 1);
  assert.deepEqual(visual[0].bounds, { x: 10, y: 20, width: 24, height: 24 });
  assert.equal(f.bridge.tabs.tasks.get("s1").observation.refs.get(visual[0].element_ref), 701);
  assert.equal(
    (
      await f.request("act", "s1", {
        observation_id: obs.observation_id,
        action: { type: "click", element_ref: visual[0].element_ref },
      })
    ).result.executed,
    true,
  );
  assert.equal(f.calls.filter((c) => c[0] === "DOM.resolveNode").at(-1)[2].backendNodeId, 701);
  assert.ok(
    f.calls.some(
      (c) => c[0] === "Runtime.releaseObjectGroup" && c[2].objectGroup.startsWith("abridge-pointer-"),
    ),
  );
});

test("native hit tests validate the target and every retargeted shadow host", async () => {
  const f = fixture();
  const opened = await f.request("open", "s1", { url: "https://example.com/" });
  await f.request("act", "s1", {
    observation_id: opened.result.observation.observation_id,
    action: { type: "click", element_ref: "e1" },
    observe_after: false,
  });
  const sources = f.calls
    .filter(
      ([method, , params]) => method === "Runtime.callFunctionOn" && params.arguments?.[0]?.value === "click",
    )
    .map(([, , params]) => params.functionDeclaration);
  const [validate, prepare] = sources.map((source) => Function("return (" + source + ")")());
  const win = {
    innerWidth: 200,
    innerHeight: 200,
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
  };
  win.top = win;
  const doc = { defaultView: win };
  const outerHost = { ownerDocument: doc, getRootNode: () => doc };
  const outerRoot = { host: outerHost };
  const innerHost = { ownerDocument: doc, getRootNode: () => outerRoot };
  const innerRoot = { host: innerHost };
  const target = {
    nodeType: 1,
    isConnected: true,
    ownerDocument: doc,
    getRootNode: () => innerRoot,
    contains: () => false,
    closest: () => null,
    matches: () => false,
    scrollIntoView() {},
    getBoundingClientRect: () => ({ x: 10, y: 10, width: 20, height: 20 }),
  };
  for (const occluded of [null, innerRoot, outerRoot, doc]) {
    innerRoot.elementFromPoint = () => (occluded === innerRoot ? {} : target);
    outerRoot.elementFromPoint = () => (occluded === outerRoot ? {} : innerHost);
    doc.elementFromPoint = () => (occluded === doc ? {} : outerHost);
    if (occluded) {
      assert.match(validate.call(target, "click"), /覆盖/);
      assert.throws(() => prepare.call(target, "click"), /obscured/);
    } else {
      assert.equal(validate.call(target, "click"), null);
      assert.deepEqual(prepare.call(target, "click"), { x: 20, y: 20 });
    }
  }
});

test("current visible occlusion is rejected without scroll, focus or native input", () => {
  let mutations = 0;
  const el = {
    nodeType: 1,
    isConnected: true,
    tagName: "INPUT",
    type: "text",
    closest: () => null,
    getBoundingClientRect: () => ({ x: 5, y: 5, width: 20, height: 20 }),
    contains: () => false,
    focus() {
      mutations++;
    },
    scrollIntoView() {
      mutations++;
    },
    ownerDocument: { defaultView: { innerWidth: 100, innerHeight: 100 }, elementFromPoint: () => ({}) },
  };
  assert.match(validateInput.call(el, "fill"), /覆盖/);
  assert.equal(mutations, 0);
});

test("DOM scroll chooses the nearest scroll container, reports actual delta and does not center the page", () => {
  const calls = [];
  const page = {
    scrollTop: 0,
    scrollLeft: 0,
    scrollBy(options) {
      calls.push([this, options]);
      this.scrollTop += options.top;
      this.scrollLeft += options.left;
    },
  };
  const box = {
    parentElement: page,
    scrollHeight: 2000,
    clientHeight: 160,
    scrollWidth: 300,
    clientWidth: 300,
    scrollTop: 0,
    scrollLeft: 0,
    scrollBy: page.scrollBy,
  };
  const doc = {
    scrollingElement: page,
    documentElement: page,
    defaultView: {
      getComputedStyle: (el) =>
        el === box
          ? { overflowY: "auto", overflowX: "hidden" }
          : { overflowY: "visible", overflowX: "visible" },
    },
  };
  const leaf = { nodeType: 1, ownerDocument: doc, parentElement: box, scrollHeight: 20, clientHeight: 20 };
  const result = scrollElement.call(leaf, 0, 650);
  assert.deepEqual(result, {
    target: "element",
    before: { x: 0, y: 0 },
    after: { x: 0, y: 650 },
    delta: { x: 0, y: 650 },
  });
  assert.equal(page.scrollTop, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].behavior, "instant");
  assert.equal(scrollElement.call({ ...doc, nodeType: 9 }, 0, 100).delta.y, 100);
  assert.equal(page.scrollTop, 100);
});

test("a semantic scroll failure is unknown and never falls back to a second wheel or scroll", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
  const obs = (await f.request("observe")).result;
  const send = f.chrome.debugger.sendCommand;
  let attempts = 0;
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "Runtime.callFunctionOn" && params.functionDeclaration.includes("scrollElement")) {
      attempts++;
      return { exceptionDetails: { text: "execution interrupted" } };
    }
    return send(target, method, params);
  };
  const result = await f.request("act", "s1", {
    observation_id: obs.observation_id,
    action: { type: "scroll", element_ref: "e1", delta_y: 650 },
  });
  assert.equal(result.error.code, "outcome_unknown");
  assert.equal(attempts, 1);
  assert.equal(
    f.calls.filter((c) => c[0] === "Input.dispatchMouseEvent" && c[2].type === "mouseWheel").length,
    0,
  );
});

test("nested scrollport clipping is allowed to reveal, while a real overlay stays a pure refusal", () => {
  const port = {
    clientLeft: 0,
    clientTop: 0,
    clientWidth: 100,
    clientHeight: 100,
    parentElement: null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
  };
  const win = {
    innerWidth: 500,
    innerHeight: 500,
    getComputedStyle: () => ({ overflowX: "hidden", overflowY: "auto", transform: "none" }),
  };
  const target = {
    nodeType: 1,
    isConnected: true,
    parentElement: port,
    contains: () => false,
    getBoundingClientRect: () => ({ x: 10, y: 150, width: 20, height: 20 }),
    ownerDocument: { defaultView: win, elementFromPoint: () => ({}) },
  };
  assert.equal(validateInput.call(target, "click"), null);
  assert.match(validateInput.call(target, "select"), /覆盖/);
  target.getBoundingClientRect = () => ({ x: 10, y: 20, width: 20, height: 20 });
  assert.match(validateInput.call(target, "click"), /覆盖/);
  assert.equal(validateInput.call(target, "scroll"), null);
});

test("observation exposes current readonly and input type metadata without exposing protected values", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
  const send = f.chrome.debugger.sendCommand;
  let readonly = true;
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "Accessibility.getFullAXTree")
      return {
        nodes: [
          { backendDOMNodeId: 801, role: { value: "textbox" }, name: { value: "Choose date" } },
          {
            backendDOMNodeId: 802,
            role: { value: "textbox" },
            name: { value: "Secret" },
            value: { value: "private-value" },
            properties: [{ name: "protected", value: { value: true } }],
          },
        ],
      };
    if (method === "DOM.describeNode")
      return {
        node: {
          attributes:
            params.backendNodeId === 801
              ? [...(readonly ? ["readonly", ""] : []), "type", "date"]
              : ["type", "password"],
        },
      };
    return send(target, method, params);
  };
  const first = (await f.request("observe")).result;
  assert.equal(first.elements[0].read_only, true);
  assert.equal(first.elements[0].input_type, "date");
  assert.equal(first.elements[1].read_only, false);
  assert.equal(first.elements[1].input_type, "password");
  assert.equal(first.elements[1].value, undefined);
  assert.equal(JSON.stringify(first).includes("private-value"), false);
  readonly = false;
  const second = (await f.request("observe")).result;
  assert.equal(second.elements[0].read_only, false);
  assert.match(second.observation_id, /^obs_/);
});

test("select validation rejects wrong kinds and invalid options before mutation, with final revalidation", () => {
  let events = 0;
  const options = [
    { value: "a", selected: true, matches: () => false },
    { value: "b", selected: false, matches: () => false },
    { value: "disabled", selected: false, matches: () => true },
  ];
  const select = {
    nodeType: 1,
    tagName: "SELECT",
    isConnected: true,
    multiple: false,
    matches: () => false,
    closest: () => null,
    options,
    ownerDocument: { defaultView: { Event: class {} } },
    dispatchEvent() {
      events++;
    },
    get selectedOptions() {
      return options.filter((o) => o.selected);
    },
  };
  assert.match(validateSelect.call({ nodeType: 1, tagName: "DIV" }, ["a"]), /原生 SELECT/);
  for (const values of [["missing"], ["disabled"], [], ["a", "b"]]) {
    assert.equal(typeof selectValues.call(select, values), "string");
    assert.deepEqual(
      options.map((o) => o.selected),
      [true, false, false],
    );
    assert.equal(events, 0);
  }
  for (const changed of [{ isConnected: false }, { matches: () => true }, { closest: () => ({}) }])
    assert.equal(typeof validateSelect.call({ ...select, ...changed }, ["b"]), "string");
  assert.equal(validateSelect.call(select, ["b"]), null);
  select.matches = () => true; // Became disabled after preflight.
  assert.equal(typeof selectValues.call(select, ["b"]), "string");
  assert.equal(events, 0);
  select.matches = () => false;
  assert.deepEqual(selectValues.call(select, ["b"]), ["b"]);
  assert.equal(events, 2);
  select.multiple = true;
  assert.deepEqual(selectValues.call(select, ["a", "b"]), ["a", "b"]);
});

test("select final known refusal preserves the task and permits same-page recovery", async () => {
  const f = fixture();
  const opened = await f.request("open", "s1", { url: "https://example.com/" });
  const send = f.chrome.debugger.sendCommand;
  let refuse = true;
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    if (
      method === "Runtime.callFunctionOn" &&
      params.functionDeclaration.includes("return (function selectValues")
    )
      return { result: { value: refuse ? "Option became disabled" : ["a"] } };
    return send(target, method, params);
  };
  const invoke = (observation_id) =>
    f.request("act", "s1", {
      observation_id,
      action: { type: "select", element_ref: "e1", values: ["a"] },
      observe_after: false,
    });
  const refused = await invoke(opened.result.observation.observation_id);
  assert.equal(refused.error.code, "invalid_action");
  assert.equal(f.removed.length, 0);
  assert.equal(f.calls.filter((c) => c[0].startsWith("Input.")).length, 0);
  refuse = false;
  const observation = (await f.request("observe")).result;
  assert.equal((await invoke(observation.observation_id)).result.executed, true);
  assert.equal(f.calls.filter((c) => c[0] === "create").length, 1);
});

test("serialized select write embeds its shared validator without extension-scope captures", async () => {
  const f = fixture();
  const opened = await f.request("open", "s1", { url: "https://example.com/" });
  await f.request("act", "s1", {
    observation_id: opened.result.observation.observation_id,
    action: { type: "select", element_ref: "e1", values: ["a"] },
    observe_after: false,
  });
  const declaration = f.calls.find(
    (c) =>
      c[0] === "Runtime.callFunctionOn" &&
      c[2].functionDeclaration.startsWith("function(values){const validateSelect="),
  )[2].functionDeclaration;
  const pageFunction = Function(`return (${declaration})`)();
  assert.match(pageFunction.call({ nodeType: 1, tagName: "DIV" }, ["a"]), /原生 SELECT/);
  let events = 0;
  const option = { value: "a", selected: false, matches: () => false };
  const select = {
    nodeType: 1,
    tagName: "SELECT",
    isConnected: true,
    matches: () => false,
    closest: () => null,
    options: [option],
    multiple: false,
    ownerDocument: { defaultView: { Event: class {} } },
    dispatchEvent() {
      events++;
    },
    get selectedOptions() {
      return option.selected ? [option] : [];
    },
  };
  assert.deepEqual(pageFunction.call(select, ["a"]), ["a"]);
  assert.equal(events, 2);
});

test("select exception with a string result remains unknown after the write and never replays", async () => {
  const f = fixture();
  const opened = await f.request("open", "s1", { url: "https://example.com/" });
  const send = f.chrome.debugger.sendCommand;
  let writes = 0;
  let selected = "a";
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    if (
      method === "Runtime.callFunctionOn" &&
      params.functionDeclaration.startsWith("function(values){const validateSelect=")
    ) {
      writes++;
      selected = "b";
      return {
        result: { type: "string", value: "dispatch failed after selection" },
        exceptionDetails: {
          text: "Uncaught",
          exception: { type: "string", value: "dispatch failed after selection" },
        },
      };
    }
    return send(target, method, params);
  };
  const request = {
    id: "select-write-throws",
    method: "act",
    session_id: "s1",
    params: {
      observation_id: opened.result.observation.observation_id,
      action: { type: "select", element_ref: "e1", values: ["b"] },
      observe_after: false,
    },
  };
  const failed = await f.bridge.dispatch(request);
  assert.equal(selected, "b");
  assert.equal(failed.status, "outcome_unknown");
  assert.equal(failed.error.code, "outcome_unknown");
  assert.equal(failed.error.cause.code, "action_failed");
  assert.match(failed.error.cause.message, /dispatch failed after selection/);
  assert.equal(failed.error.recovery.task_tab, "closed");
  assert.deepEqual(f.removed, [2]);
  assert.equal(f.bridge.sessionCount, 0);
  assert.equal((await f.bridge.dispatch(request)).error.code, "duplicate_request");
  assert.equal((await f.request("act", "s1", request.params)).error.code, "task_tab_missing");
  assert.equal(writes, 1);
});

test("input reports only observed direct child tabs and keeps the task on its own tab", async () => {
  const f = fixture();
  const opened = await f.request("open", "s1", { url: "https://example.com/" });
  const send = f.chrome.debugger.sendCommand;
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
      f.chrome.webNavigation.onCreatedNavigationTarget.emit({
        tabId: 20,
        sourceTabId: 1,
        url: "https://private.example/",
      });
      f.chrome.webNavigation.onCreatedNavigationTarget.emit({
        tabId: 21,
        sourceTabId: 2,
        url: "https://example.com/details",
      });
      f.chrome.tabs.onUpdated.emit(
        21,
        { url: "https://example.com/details" },
        {
          id: 21,
          title: "Details",
          url: "https://example.com/details",
        },
      );
    }
    return send(target, method, params);
  };
  const action = await f.request("act", "s1", {
    observation_id: opened.result.observation.observation_id,
    action: { type: "click", element_ref: "e1" },
  });
  assert.deepEqual(action.result.opened_tabs, [
    {
      tab_id: 21,
      url: "https://example.com/details",
      title: "Details",
      recovery: { action: "browser_open" },
    },
  ]);
  assert.equal((await f.request("observe")).result.opened_tabs[0].tab_id, 21);
  f.chrome.tabs.onRemoved.emit(21);
  assert.equal((await f.request("observe")).result.opened_tabs, undefined);
  await f.request("close");
  assert.deepEqual(f.removed, [2]);
});

test("a registered blank child can report its first URL after input returns", async () => {
  const f = fixture();
  const opened = await f.request("open", "s1", { url: "https://example.com/" });
  const send = f.chrome.debugger.sendCommand;
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased")
      f.chrome.webNavigation.onCreatedNavigationTarget.emit({
        tabId: 21,
        sourceTabId: 2,
        url: "about:blank",
      });
    if (method === "Runtime.evaluate" && params.expression.includes("checkCondition")) {
      f.chrome.webNavigation.onCreatedNavigationTarget.emit({
        tabId: 22,
        sourceTabId: 2,
        url: "https://example.com/unrelated-timer",
      });
      return { result: { value: true } };
    }
    return send(target, method, params);
  };
  const action = await f.request("act", "s1", {
    observation_id: opened.result.observation.observation_id,
    action: { type: "click", element_ref: "e1" },
    observe_after: false,
    verify: { selector: "#status" },
  });
  assert.deepEqual(action.result.opened_tabs, [{ tab_id: 21 }]);
  const url = "https://example.com/details";
  f.chrome.tabs.onUpdated.emit(
    21,
    { status: "loading" },
    { id: 21, url: "about:blank", pendingUrl: url, title: "Please wait", status: "loading" },
  );
  assert.equal((await f.request("observe")).result.opened_tabs[0].title, undefined);
  f.chrome.tabs.onUpdated.emit(
    21,
    { title: "Details" },
    { id: 21, url, title: "Details", status: "complete" },
  );
  f.chrome.tabs.onUpdated.emit(
    21,
    { url: "https://example.com/unrelated" },
    { id: 21, url: "https://example.com/unrelated", title: "Unrelated" },
  );
  assert.deepEqual((await f.request("observe")).result.opened_tabs[0], {
    tab_id: 21,
    url,
    title: "Details",
    recovery: { action: "browser_open" },
  });
});

test("child tab URLs respect observation budget and preserve element pagination", async () => {
  const f = fixture();
  await f.request("open", "s1", { url: "https://example.com/" });
  const original = f.chrome.debugger.sendCommand;
  const urls = [1, 2, 3].map((id) => "https://example.com/" + String(id).repeat(1900));
  const session = f.bridge.tabs.tasks.get("s1");
  session.openedTabs = urls.map((url, tab_id) => ({ tab_id, url, recovery: { action: "browser_open" } }));
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "Accessibility.getFullAXTree")
      return {
        nodes: Array.from({ length: 300 }, (_, i) => ({
          backendDOMNodeId: i + 1,
          role: { value: "button" },
          name: { value: "Button " + i },
        })),
      };
    return original(target, method, params);
  };
  const first = (await f.request("observe")).result;
  assert.ok(JSON.stringify(first).length <= 7000);
  assert.deepEqual(
    first.opened_tabs.map((tab) => tab.tab_id),
    [0, 1, 2],
  );
  assert.ok(first.opened_tabs.some((tab) => tab.url_omitted));
  for (const tab of first.opened_tabs) {
    if (tab.url_omitted) assert.equal(tab.recovery, undefined);
    else assert.equal(tab.url, urls[tab.tab_id]);
  }
  assert.equal(session.observation.refs.size, first.elements.length);
  const next = (await f.request("observe", "s1", { element_offset: first.next_element_offset })).result;
  assert.equal(next.elements[0].name, "Button " + first.elements.length);
});
