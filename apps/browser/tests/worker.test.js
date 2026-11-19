import { test } from "node:test";
import { BrowserDeviceClient } from "../src/client.js";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
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
const storage = (data) => ({
  async get() {
    return structuredClone(data);
  },
  async set(values) {
    Object.assign(data, structuredClone(values));
  },
  async remove(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
  },
});
function harness(t, local = {}, session = {}, settings = {}) {
  if (local.device?.key) local.device.instance_id = "test-instance";
  const resultWaiters = new Set();
  const nextResult = (operationId) =>
    new Promise((resolve, reject) => {
      const waiter = (message) => {
        if (message.type !== "result" || message.operation_id !== operationId) return;
        clearTimeout(timeout);
        resultWaiters.delete(waiter);
        resolve(message);
      };
      const timeout = setTimeout(() => {
        resultWaiters.delete(waiter);
        reject(new Error(`No result for operation ${operationId}`));
      }, 5000);
      resultWaiters.add(waiter);
    });
  const sockets = [],
    messages = [],
    removed = [],
    tabsAtConnect = [],
    tabs = new Map([[1, { id: 1, url: "https://personal.example/" }]]);
  let next = 2;
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 0;
    constructor(url) {
      super();
      assert.equal(url, settings.socketUrl || "wss://abridge.example/ws/browser");
      sockets.push(this);
      tabsAtConnect.push([...tabs.keys()]);
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      });
    }
    receive(message) {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
    }
    send(raw) {
      const message = JSON.parse(raw);
      messages.push(message);
      for (const waiter of resultWaiters) waiter(message);
      if (message.type === "hello")
        queueMicrotask(() =>
          this.receive({
            type: "welcome",
            protocol: "abridge/1",
            device_id: "browser-device",
            capabilities: ["browser"],
            owner_name: "fixture",
            device_name: settings.deviceName,
            connection_epoch: sockets.length,
            heartbeat_interval: 10,
            lease_seconds: settings.leaseSeconds ?? 30,
          }),
        );
    }
    close() {
      if (this.readyState >= 2) return;
      this.readyState = 2;
      const finish = () => {
        this.readyState = 3;
        this.dispatchEvent(new Event("close"));
      };
      this.finishClose = finish;
      if (!settings.deferredClose) settings.asyncClose ? queueMicrotask(finish) : finish();
    }
  }
  const alarms = new Map();
  const chrome = {
    alarms: {
      onAlarm: event(),
      async get(name) {
        return alarms.get(name);
      },
      async create(name, info) {
        alarms.set(name, { name, ...info });
      },
      async clear(name) {
        return alarms.delete(name);
      },
    },
    storage: { local: storage(local), session: storage(session) },
    runtime: {
      id: "extension",
      onMessage: event(),
      onStartup: event(),
      getURL: (path) => `chrome-extension://extension/${path}`,
      getManifest: () => ({ version: "0.2.0" }),
      async sendMessage() {},
    },
    identity: {
      getRedirectURL: (path) => `https://${"a".repeat(32)}.chromiumapp.org/${path}`,
      launchWebAuthFlow: (details) => settings.authorize(details.url),
    },
    action: { onClicked: event() },
    tabs: {
      onUpdated: event(),
      onRemoved: event(),
      async create({ url, active }) {
        assert.equal(active, false);
        const tab = { id: next++, url, title: "Task" };
        tabs.set(tab.id, tab);
        return tab;
      },
      async get(id) {
        if (!tabs.has(id)) throw Error("no tab");
        return tabs.get(id);
      },
      async remove(id) {
        removed.push(id);
        tabs.delete(id);
      },
    },
    debugger: { onDetach: event() },
  };
  const timeouts = new Set(),
    intervals = new Set();
  const environment = {
    fetch: globalThis.fetch,
    now: Date.now,
    crypto: {
      subtle: { digest: crypto.subtle.digest.bind(crypto.subtle) },
      randomUUID: crypto.randomUUID.bind(crypto),
    },
    timers: {
      setTimeout(callback, ms) {
        const timer = setTimeout(() => {
          timeouts.delete(timer);
          callback();
        }, ms);
        timeouts.add(timer);
        return timer;
      },
      clearTimeout(timer) {
        timeouts.delete(timer);
        clearTimeout(timer);
      },
      setInterval(callback, ms) {
        const timer = setInterval(callback, ms);
        intervals.add(timer);
        return timer;
      },
      clearInterval(timer) {
        intervals.delete(timer);
        clearInterval(timer);
      },
    },
  };
  const client = new BrowserDeviceClient({
    chrome,
    WebSocket: Socket,
    navigator: settings.navigator ?? {},
    fetch: (...args) => environment.fetch(...args),
    crypto: environment.crypto,
    timers: settings.defaultTimers ? undefined : environment.timers,
    now: () => environment.now(),
  });
  t.after(() => client.close());
  const fromPage = (message, page = "popup.html") =>
    new Promise((resolve) =>
      (
        chrome.runtime.onMessage.listeners[0] ??
        ((_message, _sender, respond) => respond({ ok: false, error: { code: "client_closed" } }))
      )(message, { id: "extension", url: chrome.runtime.getURL(page) }, resolve),
    );
  const popup = (message) => fromPage(message);
  const dispatch = (id, sequence = 1, extra = {}) => ({
    type: "dispatch",
    protocol: "abridge/1",
    operation_id: id,
    device_id: "browser-device",
    connection_epoch: sockets.length,
    session_id: "task",
    session_capabilities: ["browser"],
    expires_at: Date.now() / 1000 + 30,
    sequence,
    device_credential_version: 1,
    tool: "browser_open",
    arguments: { url: "https://example.com/" },
    ...extra,
  });
  return {
    client,
    environment,
    timeouts,
    intervals,
    start: () => client.start().catch(() => {}),
    sockets,
    messages,
    removed,
    tabs,
    chrome,
    popup,
    dispatch,
    alarms,
    tabsAtConnect,
    fromPage,
    nextResult,
  };
}
test("default browser timers preserve their global receiver through connection, retry and shutdown", async (t) => {
  const calls = new Set();
  for (const method of ["setTimeout", "clearTimeout", "setInterval", "clearInterval"]) {
    const original = globalThis[method];
    t.mock.method(globalThis, method, function (...args) {
      assert.equal(this, globalThis, `${method} requires the browser global receiver`);
      calls.add(method);
      return original(...args);
    });
  }
  const h = harness(
    t,
    { device: { server: "https://abridge.example", key: "key", device_id: "browser-device" } },
    {},
    { defaultTimers: true },
  );
  await h.start();
  await delay(10);
  assert.equal((await h.popup({ type: "status" })).connected, true);
  h.sockets[0].close();
  await delay(2100);
  assert.equal(h.sockets.length, 2);
  assert.equal((await h.popup({ type: "status" })).connected, true);
  await h.client.close();
  assert.equal(h.sockets[1].readyState, 3);
  assert.deepEqual([...calls].sort(), ["clearInterval", "clearTimeout", "setInterval", "setTimeout"]);
});

test("Chrome-compatible browser identity is reported on connection and worker restart", async (t) => {
  const local = {
    device: { server: "https://abridge.example", key: "key", device_id: "browser-device", paused: true },
  };
  const settings = { navigator: { userAgentData: { brands: [{ brand: "Google Chrome", version: "156" }] } } };
  const h = harness(t, local, {}, settings);
  await h.start();
  await delay(10);
  assert.equal(h.messages.find((m) => m.type === "hello").platform, "chrome");
  assert.equal(local.device.key, "key");
  assert.equal(local.device.paused, true);
  await h.client.close();
  const restored = harness(t, local, {}, settings);
  await restored.start();
  await delay(10);
  assert.equal(restored.messages.find((m) => m.type === "hello").platform, "chrome");
});

test("browser hello reports the browser separately from the host OS and extension version", async (t) => {
  const h = harness(
    t,
    { device: { server: "https://abridge.example", key: "key", device_id: "browser-device" } },
    {},
    {
      navigator: {
        userAgent: "Chrome/151.0.0.0 Edg/151.0.1.0",
        userAgentData: {
          brands: [
            { brand: "Chromium", version: "151" },
            { brand: "Microsoft Edge", version: "151" },
          ],
          async getHighEntropyValues() {
            return { platformVersion: "27.0.1" };
          },
        },
      },
    },
  );
  h.chrome.runtime.getPlatformInfo = async () => ({ os: "mac", arch: "arm64" });
  await h.start();
  await delay(10);
  assert.deepEqual(h.messages.find((message) => message.type === "hello").details, {
    os: "macos",
    os_version: "27.0.1",
    architecture: "arm64",
    browser_name: "Microsoft Edge",
    browser_version: "151",
  });
});

test("a Chromium brand remains Chromium when its UA contains a Chrome token", async (t) => {
  const h = harness(
    t,
    { device: { server: "https://abridge.example", key: "key", device_id: "browser-device" } },
    {},
    {
      navigator: {
        userAgent: "Mozilla/5.0 Chrome/151.0.0.0 Safari/537.36",
        userAgentData: { brands: [{ brand: "Chromium", version: "151" }] },
      },
    },
  );
  await h.start();
  await delay(10);
  const hello = h.messages.find((message) => message.type === "hello");
  assert.equal(hello.platform, "Browser extension");
  assert.deepEqual(hello.details, { browser_name: "Chromium", browser_version: "151" });
});

test("a slow browser version probe keeps the known device details in the hello", async (t) => {
  const h = harness(
    t,
    { device: { server: "https://abridge.example", key: "key", device_id: "browser-device" } },
    {},
    {
      navigator: {
        userAgentData: {
          brands: [{ brand: "Google Chrome", version: "151" }],
          getHighEntropyValues() {
            return new Promise(() => {});
          },
        },
      },
    },
  );
  h.chrome.runtime.getPlatformInfo = async () => ({ os: "mac", arch: "arm64" });
  await h.start();
  for (let attempt = 0; attempt < 100 && !h.messages.some((message) => message.type === "hello"); attempt++)
    await delay(10);
  assert.deepEqual(h.messages.find((message) => message.type === "hello").details, {
    os: "macos",
    architecture: "arm64",
    browser_name: "Google Chrome",
    browser_version: "151",
  });
});

test("standalone extension registers once, authenticates directly, isolates browser tools, persists no-replay and pauses", async (t) => {
  let authorizationRequest;
  const local = {},
    session = { owned_task_tabs: [9] },
    h = harness(t, local, session, {
      authorize: async (url) => {
        assert.equal(new URL(url).origin, "https://abridge.example");
        return (
          authorizationRequest.redirect_uri +
          "?code=" +
          "c".repeat(43) +
          "&state=" +
          authorizationRequest.state
        );
      },
    });
  const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
  let firstDigest = true;
  h.environment.crypto.subtle.digest = async function (...args) {
    if (firstDigest) {
      firstDigest = false;
      // The OS crypto pool can complete after a fixed 10 ms sleep on busy CI runners.
      await delay(30);
    }
    return originalDigest.apply(this, args);
  };
  t.after(() => {
    h.environment.crypto.subtle.digest = originalDigest;
  });
  let requests = 0;
  h.environment.fetch = async (url, request) => {
    requests++;
    if (url.endsWith("/api/device-authorizations")) {
      authorizationRequest = JSON.parse(request.body);
      assert.equal(authorizationRequest.kind, "browser");
      assert.deepEqual(authorizationRequest.capabilities, ["browser"]);
      assert.equal(authorizationRequest.name, "Work");
      assert.equal(request.redirect, "error");
      return Response.json({
        id: "r".repeat(43),
        authorization_url: "https://abridge.example/?authorize=" + "r".repeat(43),
        expires_at: Date.now() / 1000 + 300,
      });
    }
    assert.equal(url, "https://abridge.example/api/device-authorizations/token");
    const body = JSON.parse(request.body);
    assert.equal(body.redirect_uri, authorizationRequest.redirect_uri);
    assert.ok(body.code_verifier);
    return Response.json({
      device_id: "browser-device",
      key: "abr_device_private-key",
      name: "Work",
      kind: "browser",
      capabilities: ["browser"],
    });
  };
  await h.start();
  await delay(10);
  assert.equal(h.sockets.length, 0);
  assert.deepEqual(h.removed, [9]);
  assert.equal(
    h.chrome.runtime.onMessage.listeners[0](
      { type: "authorize" },
      { id: "other", url: h.chrome.runtime.getURL("popup.html") },
      () => assert.fail(),
    ),
    false,
  );
  assert.equal(
    (await h.popup({ type: "authorize", server: "http://remote.example", label: "Work" })).ok,
    false,
  );
  assert.equal(
    (
      await h.popup({
        type: "authorize",
        server: "https://abridge.example",
        label: "Work",
      })
    ).ok,
    true,
  );
  const deadline = performance.now() + 3000;
  while (!(await h.popup({ type: "status" })).configured) {
    if (performance.now() > deadline) assert.fail("browser authorization did not complete");
    await delay(5);
  }
  assert.equal(requests, 2);
  assert.equal(local.device.key, "abr_device_private-key");
  assert.ok(local.device.instance_id);
  assert.equal(JSON.stringify(local).includes("secret"), false);
  assert.equal(h.messages[0].device_key, local.device.key);
  assert.deepEqual(h.messages[0].capabilities, { browser: true });
  const firstResult = h.nextResult("open-first");
  h.sockets[0].receive(h.dispatch("open-first"));
  const first = await firstResult;
  assert.equal(first.status, "executed");
  assert.equal(first.result.tab_id, 2);
  assert.equal(local.operation_journal["open-first"].status, "executed");
  const duplicateResult = h.nextResult("open-first");
  h.sockets[0].receive(h.dispatch("open-first", 2));
  assert.equal((await duplicateResult).result.deduplicated, true);
  assert.equal(h.tabs.size, 2);
  const conflictResult = h.nextResult("open-first");
  h.sockets[0].receive(h.dispatch("open-first", 3, { arguments: { url: "https://changed.example/" } }));
  assert.equal((await conflictResult).error.code, "operation_conflict");
  const unsupportedResult = h.nextResult("shell");
  h.sockets[0].receive(h.dispatch("shell", 4, { tool: "shell_exec" }));
  assert.equal((await unsupportedResult).error.code, "unsupported_tool");
  const expiredResult = h.nextResult("expired");
  h.sockets[0].receive(h.dispatch("expired", 5, { expires_at: 0 }));
  assert.equal((await expiredResult).error.code, "operation_expired");
  h.sockets[0].close();
  await delay(2100);
  assert.equal(h.sockets.length, 2);
  assert.ok(h.tabs.has(1));
  assert.ok(h.removed.includes(2));
  assert.equal(requests, 2);
  assert.equal((await h.popup({ type: "status" })).connected, true);
  const closedResult = h.nextResult("after-close");
  h.sockets[1].receive(h.dispatch("after-close", 1));
  assert.equal((await closedResult).error.code, "session_closed");
  await h.popup({ type: "pause" });
  assert.equal(local.device.paused, true);
  assert.equal(h.messages.at(-1).paused, true);
  await h.popup({ type: "resume" });
  assert.equal(local.device.paused, false);
  await h.popup({ type: "unbind" });
  await delay(10);
  assert.equal(local.device.revoked, true);
  assert.equal(
    h.messages.some((m) => m.type === "unbind"),
    true,
  );
});
test("startup retains failed cleanup IDs and refuses connection", async (t) => {
  const local = { device: { server: "https://abridge.example", key: "key", device_id: "browser-device" } },
    session = { owned_task_tabs: [9] },
    h = harness(t, local, session);
  const remove = h.chrome.tabs.remove;
  h.chrome.tabs.remove = async () => {
    throw Error("remove failed");
  };
  h.chrome.tabs.get = async (id) => ({ id });
  try {
    await h.start();
    await delay(10);
    assert.equal(h.sockets.length, 0);
    assert.deepEqual(session.owned_task_tabs, [9]);
    const status = await h.popup({ type: "status" });
    assert.equal(status.error.code, "cleanup_failed");
  } finally {
    h.chrome.tabs.remove = remove;
  }
});

test("worker recovery marks persisted executing intent unknown without replay", async (t) => {
  const local = { operation_journal: { pending: { status: "executing", request_hash: "opaque-hash" } } },
    h = harness(t, local, {});
  await h.start();
  await delay(10);
  assert.equal(local.operation_journal.pending.status, "outcome_unknown");
  assert.equal(h.sockets.length, 0);
  assert.equal(h.tabs.size, 1);
});

test("cancel during digest or intent persistence prevents late page effects", async (t) => {
  for (const phase of ["digest", "journal"]) {
    const local = { device: { server: "https://abridge.example", key: "key", device_id: "browser-device" } },
      h = harness(t, local, {});
    await h.start();
    await delay(10);
    let release, entered;
    const reached = new Promise((resolve) => {
      entered = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    const originalSet = h.chrome.storage.local.set;
    if (phase === "digest")
      h.environment.crypto.subtle.digest = async function (...args) {
        entered();
        await gate;
        return originalDigest.apply(this, args);
      };
    else
      h.chrome.storage.local.set = async (values) => {
        if (values.operation_journal?.cancelled?.status === "executing") {
          entered();
          await gate;
        }
        return originalSet(values);
      };
    h.sockets[0].receive(h.dispatch("cancelled"));
    await reached;
    h.sockets[0].receive({ type: "cancel", operation_ids: ["cancelled"] });
    release();
    await delay(20);
    assert.equal(h.tabs.size, 1, `${phase}: cancelled open must not create a task tab`);
    assert.equal(h.messages.at(-1).operation_id, "cancelled");
    assert.notEqual(h.messages.at(-1).status, "executed");
    assert.equal(local.operation_journal.cancelled.status, "outcome_unknown");
    h.environment.crypto.subtle.digest = originalDigest;
    h.chrome.storage.local.set = originalSet;
    await h.popup({ type: "unbind" });
    await delay(5);
  }
});

test("recovery alarm restores connection when worker-local reconnect timer is lost", async (t) => {
  const local = {
      device: { server: "https://abridge.example", key: "key", device_id: "browser-device", paused: true },
    },
    h = harness(t, local, {});
  t.after(() => {
    local.device.revoked = true;
    for (const s of h.sockets) s.close();
  });
  await h.start();
  await delay(10);
  assert.equal(h.sockets.length, 1);
  const recovery = [...h.alarms.values()][0];
  assert.ok(recovery, "authorized worker must install a browser-managed wake-up alarm");
  const originalSetTimeout = h.environment.timers.setTimeout;
  // Worker termination loses its JS timer. A browser-managed alarm still wakes it.
  h.environment.timers.setTimeout = () => 0;
  h.sockets[0].close();
  await delay(10);
  h.environment.timers.setTimeout = originalSetTimeout;
  assert.equal(h.sockets.length, 1);
  h.chrome.alarms.onAlarm.emit(recovery);
  await delay(20);
  assert.equal(h.sockets.length, 2, "alarm reconnects without opening the extension UI");
  const hellos = h.messages.filter((m) => m.type === "hello");
  assert.equal(hellos[1].device_key, hellos[0].device_key);
  assert.equal(hellos[1].paused, true, "recovery never clears a persistent pause");
  assert.equal((await h.popup({ type: "status" })).connected, true);
  await h.popup({ type: "unbind" });
  await delay(10);
  assert.equal(h.alarms.size, 0, "revocation removes background recovery");
  h.chrome.alarms.onAlarm.emit(recovery);
  await delay(10);
  assert.equal(h.sockets.length, 2, "revoked credentials never reconnect");
});

test("recovery alarm replaces a stale apparently-open socket only after async task cleanup", async (t) => {
  const local = { device: { server: "https://abridge.example", key: "key", device_id: "browser-device" } },
    h = harness(t, local, {}, { asyncClose: true });
  t.after(() => {
    local.device.revoked = true;
    for (const s of h.sockets) s.close();
  });
  await h.start();
  await delay(10);
  const recovery = [...h.alarms.values()][0];
  h.chrome.alarms.onAlarm.emit(recovery);
  await delay(10);
  assert.equal(h.sockets.length, 1, "healthy connection is not replaced by every alarm");
  h.sockets[0].receive(h.dispatch("owned-before-sleep"));
  await delay(10);
  assert.equal(h.tabs.size, 2);
  const now = Date.now;
  h.environment.now = () => now() + 60000;
  try {
    assert.equal(
      (await h.popup({ type: "status" })).connected,
      false,
      "stale heartbeat cannot be reported connected",
    );
    h.chrome.alarms.onAlarm.emit(recovery);
    await delay(20);
  } finally {
    h.environment.now = now;
  }
  assert.equal(h.sockets.length, 2, "missed heartbeat lease replaces an apparently-open socket");
  assert.equal(h.sockets[0].readyState, 3);
  assert.deepEqual(h.tabsAtConnect[1], [1], "old task tab is removed before reconnect");
  assert.equal((await h.popup({ type: "status" })).connected, true);
  await h.popup({ type: "unbind" });
  await delay(5);
});

test("alarm reconnect during CLOSING completes old task cleanup before replacing the socket", async (t) => {
  const local = { device: { server: "https://abridge.example", key: "key", device_id: "browser-device" } },
    h = harness(t, local, {}, { deferredClose: true });
  t.after(() => {
    local.device.revoked = true;
    for (const s of h.sockets) {
      s.close();
      s.finishClose?.();
    }
  });
  await h.start();
  await delay(10);
  h.sockets[0].receive(h.dispatch("before-closing"));
  await delay(10);
  assert.equal(h.tabs.size, 2);
  const old = h.sockets[0];
  old.close();
  assert.equal(old.readyState, 2);
  h.chrome.alarms.onAlarm.emit([...h.alarms.values()][0]);
  await delay(20);
  assert.equal(h.sockets.length, 2);
  assert.deepEqual(h.tabsAtConnect[1], [1], "CLOSING old socket cannot skip task cleanup");
  old.finishClose();
  await delay(10);
  assert.equal(
    (await h.popup({ type: "status" })).connected,
    true,
    "late old close cannot clear new connection",
  );
  assert.equal(h.tabs.size, 1);
  await h.popup({ type: "unbind" });
  h.sockets[1].finishClose();
  await delay(5);
});

test("only trusted extension pages can message the worker and the binding page cannot control tasks", async (t) => {
  const local = { device: { server: "https://abridge.example", key: "key", device_id: "browser-device" } },
    h = harness(t, local, {});
  await h.start();
  await delay(10);
  for (const page of [
    "untrusted.html",
    "options.html",
    "popup.html?spoof=1",
    "popup.html#spoof",
    "connection.html",
  ]) {
    assert.equal(
      h.chrome.runtime.onMessage.listeners[0](
        { type: "pause" },
        { id: "extension", url: h.chrome.runtime.getURL(page) },
        () => assert.fail(),
      ),
      false,
    );
  }
  assert.equal((await h.fromPage({ type: "status" }, "connection.html")).connected, true);
  assert.equal((await h.fromPage({ type: "status" }, "popup.html")).connected, true);
  h.sockets[0].receive(h.dispatch("popup-task"));
  await delay(10);
  assert.equal((await h.fromPage({ type: "status" }, "popup.html")).active_sessions, 1);
  assert.equal((await h.fromPage({ type: "stop" }, "popup.html")).ok, true);
  assert.equal(h.messages.at(-1).type, "local_stop");
  const status = await h.fromPage({ type: "status" }, "popup.html");
  assert.equal(status.active_sessions, 0);
  assert.equal(status.connected, true);
  assert.equal(local.device.key, "key");
  assert.notEqual(local.device.paused, true);
  assert.deepEqual([...h.tabs.keys()], [1], "stop only removes task pages");
  await h.fromPage({ type: "pause" }, "popup.html");
  assert.equal(local.device.paused, true);
  await h.fromPage({ type: "resume" }, "popup.html");
  assert.equal(local.device.paused, false);
  await h.popup({ type: "unbind" });
  await delay(5);
});

test("closing another session does not cancel a dispatch waiting on durable intent", async (t) => {
  const local = { device: { server: "https://abridge.example", key: "key", device_id: "browser-device" } },
    h = harness(t, local, {});
  t.after(() => {
    local.device.revoked = true;
    for (const socket of h.sockets) socket.close();
  });
  await h.start();
  await delay(10);
  let release, entered;
  const reached = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const originalSet = h.chrome.storage.local.set;
  h.chrome.storage.local.set = async (values) => {
    if (values.operation_journal?.["other-session"]?.status === "executing") {
      entered();
      await gate;
    }
    return originalSet(values);
  };
  h.sockets[0].receive(h.dispatch("other-session", 1, { session_id: "session-b" }));
  await reached;
  h.sockets[0].receive({ type: "session_close", connection_epoch: 1, session_id: "session-a" });
  release();
  await delay(20);
  const result = h.messages.find((message) => message.operation_id === "other-session");
  assert.equal(result.status, "executed");
  assert.equal(h.tabs.size, 2);
  assert.deepEqual(h.tabsAtConnect[0], [1]);
  await h.popup({ type: "unbind" });
  await delay(10);
});

test("an open popup is notified when remote work starts, completes and closes its task session", async (t) => {
  const local = { device: { server: "https://abridge.example", key: "key", device_id: "browser-device" } };
  const h = harness(t, local, {});
  t.after(async () => {
    await h.popup({ type: "unbind" });
    local.device.revoked = true;
    for (const socket of h.sockets) socket.close();
  });
  await h.start();
  await h.popup({ type: "status" });
  // Wait for authentication rather than assuming the first status read is online.
  while (!(await h.popup({ type: "status" })).connected) await delay(1);
  const updates = [];
  h.chrome.runtime.sendMessage = async (message) => {
    if (message.type === "status_changed") updates.push(h.popup({ type: "status" }));
  };
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const originalSet = h.chrome.storage.local.set;
  h.chrome.storage.local.set = async (values) => {
    if (values.operation_journal?.["notified-task"]?.status === "executing") await gate;
    return originalSet(values);
  };
  const result = h.nextResult("notified-task");
  h.sockets[0].receive(h.dispatch("notified-task"));
  assert.equal((await updates[0]).active_operations, 1, "Start notification enables local stop controls");
  release();
  await result;
  const completed = await updates.at(-1);
  assert.equal(completed.active_operations, 0);
  assert.equal(completed.active_sessions, 1);
  let closed;
  const closing = new Promise((resolve) => {
    closed = resolve;
  });
  h.chrome.runtime.sendMessage = async () => closed(await h.popup({ type: "status" }));
  h.sockets[0].receive({ type: "session_close", connection_epoch: 1, session_id: "task" });
  assert.equal((await closing).active_sessions, 0, "Remote close also updates the open popup");
});

test("independent: cancelling digest-waiting A keeps executing B and the control session usable", async (t) => {
  const local = { device: { server: "https://abridge.example", key: "key", device_id: "browser-device" } };
  const session = {},
    h = harness(t, local, session);
  const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
  t.after(async () => {
    h.environment.crypto.subtle.digest = originalDigest;
    await h.popup({ type: "unbind" });
  });
  await h.start();
  await delay(10);
  let releaseA,
    enteredA,
    releaseB,
    enteredB,
    first = true;
  const aReady = new Promise((resolve) => (enteredA = resolve));
  const aGate = new Promise((resolve) => (releaseA = resolve));
  const bReady = new Promise((resolve) => (enteredB = resolve));
  const bGate = new Promise((resolve) => (releaseB = resolve));
  h.environment.crypto.subtle.digest = async function (...args) {
    if (first) {
      first = false;
      enteredA();
      await aGate;
    }
    return originalDigest.apply(this, args);
  };
  h.chrome.tabs.update = async (id, values) => {
    Object.assign(h.tabs.get(id), values);
    return h.tabs.get(id);
  };
  const createTab = h.chrome.tabs.create;
  h.chrome.tabs.create = async (...args) => {
    enteredB();
    await bGate;
    return createTab(...args);
  };
  h.sockets[0].receive(h.dispatch("cancel-a", 1));
  await aReady;
  h.sockets[0].receive(h.dispatch("keep-b", 2));
  await bReady;
  h.sockets[0].receive({ type: "cancel", operation_ids: ["cancel-a"], connection_epoch: 1 });
  releaseA();
  releaseB();
  await delay(30);
  assert.equal(h.messages.find((m) => m.operation_id === "keep-b").status, "executed");
  assert.equal(h.messages.find((m) => m.operation_id === "cancel-a").status, "outcome_unknown");
  assert.deepEqual(session.closed_sessions ?? [], []);
  assert.equal(h.tabs.size, 2);
  h.sockets[0].receive(h.dispatch("reuse-session", 3));
  await delay(25);
  assert.equal(h.messages.find((m) => m.operation_id === "reuse-session").status, "executed");
});

test("independent: cancelling after navigation completion preserves its receipt and permits session recovery", async (t) => {
  const local = { device: { server: "https://abridge.example", key: "key", device_id: "browser-device" } };
  const session = {},
    h = harness(t, local, session);
  t.after(async () => {
    await h.popup({ type: "unbind" });
  });
  await h.start();
  await delay(10);
  let release,
    entered,
    blocked = false;
  const reached = new Promise((resolve) => (entered = resolve));
  const gate = new Promise((resolve) => (release = resolve));
  const save = h.chrome.storage.local.set;
  h.chrome.storage.local.set = async (values) => {
    if (!blocked && values.operation_journal?.late?.status === "executed") {
      blocked = true;
      entered();
      await gate;
    }
    return save(values);
  };
  h.sockets[0].receive(h.dispatch("late", 1));
  await reached;
  h.sockets[0].receive({ type: "cancel", connection_epoch: 1, operation_ids: ["late"] });
  await delay(5);
  release();
  await delay(25);
  const receipt = h.messages.find((m) => m.operation_id === "late");
  assert.equal(receipt.status, "executed");
  assert.equal(receipt.result.executed, true);
  assert.equal(receipt.result.url, "https://example.com/");
  assert.equal(local.operation_journal.late.status, "executed");
  assert.deepEqual(session.closed_sessions ?? [], []);
  assert.equal(h.tabs.size, 1);
  h.sockets[0].receive(h.dispatch("recovery-open", 2));
  await delay(25);
  assert.equal(h.messages.find((m) => m.operation_id === "recovery-open").status, "executed");
});

for (const fence of ["revoke", "deadline"])
  test(`independent: ${fence} during digest blocks later page effects`, async (t) => {
    const local = { device: { server: "https://abridge.example", key: "key", device_id: "browser-device" } };
    const h = harness(t, local, {}, { deferredClose: true });
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    t.after(async () => {
      h.environment.crypto.subtle.digest = originalDigest;
      await h.popup({ type: "unbind" });
      for (const socket of h.sockets) socket.finishClose?.();
    });
    await h.start();
    await delay(10);
    let release, entered;
    const reached = new Promise((resolve) => (entered = resolve));
    const gate = new Promise((resolve) => (release = resolve));
    h.environment.crypto.subtle.digest = async function (...args) {
      entered();
      await gate;
      return originalDigest.apply(this, args);
    };
    h.sockets[0].receive(
      h.dispatch(`fence-${fence}`, 1, {
        expires_at: Date.now() / 1000 + (fence === "deadline" ? 0.03 : 30),
      }),
    );
    await reached;
    if (fence === "revoke") h.sockets[0].receive({ type: "revoke", connection_epoch: 1 });
    else await delay(50);
    release();
    await delay(25);
    assert.equal(h.tabs.size, 1, "No task tab may be created after admission expires");
    assert.notEqual(h.messages.find((m) => m.operation_id === `fence-${fence}`)?.status, "executed");
    assert.equal(local.operation_journal[`fence-${fence}`].status, "outcome_unknown");
  });

test("independent: an expired device lease blocks dispatch even before the heartbeat timer runs", async (t) => {
  const local = { device: { server: "https://abridge.example", key: "key", device_id: "browser-device" } };
  const h = harness(t, local, {}, { leaseSeconds: 1 });
  const originalNow = Date.now;
  t.after(async () => {
    h.environment.now = originalNow;
    await h.popup({ type: "unbind" });
  });
  await h.start();
  await delay(10);
  const frame = h.dispatch("lease-expired", 1);
  h.environment.now = () => originalNow() + 2000;
  h.sockets[0].receive(frame);
  await delay(25);
  assert.equal(h.tabs.size, 1, "An expired connection lease cannot admit browser page work");
  assert.notEqual(h.messages.find((m) => m.operation_id === "lease-expired")?.status, "executed");
});

test("browser consent completes without an open popup and a reopened popup restores pending details", async (t) => {
  let finishBrowser;
  let started;
  let tokenRequests = 0;
  const local = {
    device: { server: "https://old.example", label: "Old profile", paused: true, revoked: true },
  };
  const h = harness(
    t,
    local,
    {},
    {
      authorize: () =>
        new Promise((resolve) => {
          finishBrowser = resolve;
        }),
    },
  );

  h.environment.fetch = async (url, init) => {
    if (url.endsWith("/token")) {
      tokenRequests++;
      return Response.json({
        device_id: "browser-device",
        key: "abr_device_private-key",
        name: "Work",
        kind: "browser",
        capabilities: ["browser"],
      });
    }
    started = JSON.parse(init.body);
    return Response.json({
      id: "r".repeat(43),
      authorization_url: "https://abridge.example/?authorize=" + "r".repeat(43),
      expires_at: Date.now() / 1000 + 300,
    });
  };
  try {
    await h.start();
    assert.equal(
      (
        await h.fromPage(
          { type: "authorize", server: "https://abridge.example", label: "Work" },
          "connection.html",
        )
      ).ok,
      true,
    );
    const deadline = performance.now() + 2000;
    while (!finishBrowser) {
      if (performance.now() > deadline) assert.fail("authorization browser did not open");
      await delay(5);
    }
    // Each request uses a fresh popup sender. No UI object or open message port owns this flow.
    const reopened = await h.fromPage({ type: "status" });
    assert.equal(reopened.authorizing, true);
    assert.equal(reopened.server, "https://abridge.example");
    assert.equal(reopened.label, "Work");
    assert.equal(
      local.device.server,
      "https://old.example",
      "Pending details cannot replace the saved binding",
    );
    finishBrowser(started.redirect_uri + "?code=" + "c".repeat(43) + "&state=" + started.state);
    // Complete with no further popup messages; the worker must redeem and save the credential itself.
    while (!local.device.key) {
      if (performance.now() > deadline) assert.fail("authorization did not complete without a popup");
      await delay(5);
    }
    assert.equal(tokenRequests, 1);
    assert.equal(local.device.server, "https://abridge.example");
    assert.equal(local.device.label, "Work");
    assert.equal(local.device.paused, true);
    assert.equal((await h.fromPage({ type: "status" })).authorizing, false);
    await h.popup({ type: "unbind" });
  } finally {
  }
});

test("browser consent waits outside control queue and a cancelled late approval cannot bind", async (t) => {
  let finishBrowser;
  let started;
  let tokenRequests = 0;
  const local = { device: { paused: true } },
    session = {};
  const h = harness(t, local, session, {
    authorize: () =>
      new Promise((resolve) => {
        finishBrowser = resolve;
      }),
  });

  h.environment.fetch = async (url, init) => {
    if (init.method === "DELETE") return Response.json({ ok: true });
    if (url.endsWith("/token")) {
      tokenRequests++;
      throw Error("Cancelled code must not be redeemed");
    }
    started = JSON.parse(init.body);
    return Response.json({
      id: "r".repeat(43),
      authorization_url: "https://abridge.example/?authorize=" + "r".repeat(43),
      expires_at: Date.now() / 1000 + 300,
    });
  };
  try {
    await h.start();
    assert.equal(
      (await h.popup({ type: "authorize", server: "https://abridge.example", label: "Work" })).ok,
      true,
    );
    const deadline = performance.now() + 2000;
    while (!finishBrowser) {
      if (performance.now() > deadline) assert.fail("authorization browser did not open");
      await delay(5);
    }
    const status = await Promise.race([
      h.popup({ type: "status" }),
      delay(500).then(() => {
        throw Error("Consent blocked the configuration queue");
      }),
    ]);
    assert.equal(status.authorizing, true);
    assert.equal(status.paused, true);
    assert.equal((await h.popup({ type: "authorize_cancel" })).ok, true);
    finishBrowser(started.redirect_uri + "?code=" + "c".repeat(43) + "&state=" + started.state);
    await delay(20);
    assert.equal(tokenRequests, 0);
    assert.equal((await h.popup({ type: "status" })).authorizing, false);
    assert.equal(local.device.key, undefined);
    assert.equal(local.device.paused, true);
  } finally {
  }
});

test("browser names synchronize from Server and rename without blocking pause or exposing its key", async (t) => {
  const local = {
    device: { server: "https://abridge.example", key: "key", device_id: "browser-device", label: "Old name" },
  };
  const h = harness(t, local, {}, { deviceName: "Server name" });
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  t.after(async () => {
    release();
    await h.popup({ type: "unbind" });
  });
  await h.start();
  await delay(10);
  assert.equal((await h.popup({ type: "status" })).label, "Server name");
  let entered;
  const requested = new Promise((resolve) => {
    entered = resolve;
  });
  h.environment.fetch = async (url, options) => {
    assert.equal(url, "https://abridge.example/api/device");
    assert.equal(options.method, "PATCH");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer key");
    assert.deepEqual(JSON.parse(options.body), { name: "Renamed browser" });
    entered();
    await pending;
    return Response.json({ id: "browser-device", name: "Renamed browser" });
  };
  const renamed = h.fromPage({ type: "rename", name: " Renamed browser " }, "connection.html");
  await requested;
  assert.equal(
    (await h.popup({ type: "status" })).label,
    "Server name",
    "Do not publish an unconfirmed draft",
  );
  assert.equal((await h.popup({ type: "pause" })).ok, true, "Rename HTTP wait must not block local pause");
  h.sockets[0].receive({ type: "heartbeat_ack", connection_epoch: 1, device_name: "Stale pre-save name" });
  release();
  assert.equal((await renamed).ok, true);
  const saved = await h.popup({ type: "status" });
  assert.equal(saved.label, "Renamed browser");
  assert.equal(saved.paused, true);
  assert.equal(JSON.stringify(saved).includes('"key"'), false);
  assert.equal(local.device.label, "Renamed browser");
  h.sockets[0].receive({ type: "heartbeat_ack", connection_epoch: 1, device_name: "Renamed in console" });
  assert.equal((await h.popup({ type: "status" })).label, "Renamed in console");
  assert.equal(local.device.label, "Renamed in console");
});

test("failed or invalid browser renames preserve the saved device name", async (t) => {
  const local = {
    device: {
      server: "https://abridge.example",
      key: "key",
      device_id: "browser-device",
      label: "Keep name",
    },
  };
  const h = harness(t, local, {});
  t.after(async () => {
    await h.popup({ type: "unbind" });
  });
  await h.start();
  await delay(10);
  h.environment.fetch = async () =>
    Response.json({ error: { message: "Server unavailable" } }, { status: 503 });
  assert.equal((await h.popup({ type: "rename", name: "Draft" })).ok, false);
  assert.equal((await h.popup({ type: "status" })).label, "Keep name");
  assert.equal(local.device.label, "Keep name");
  h.environment.fetch = async () => Response.json({ id: "other-device", name: "Wrong device" });
  assert.equal((await h.popup({ type: "rename", name: "Draft" })).ok, false);
  assert.equal((await h.popup({ type: "rename", name: " " })).ok, false);
  assert.equal((await h.popup({ type: "rename", name: "x".repeat(121) })).ok, false);
  assert.equal((await h.popup({ type: "status" })).label, "Keep name");
});

test("manual browser Token validates identity before replacing a binding and requires exact HTTP consent", async (t) => {
  const local = {
    device: {
      server: "https://abridge.example",
      key: "abr_device_old",
      device_id: "old-device",
      label: "Old",
      paused: true,
    },
  };
  const h = harness(t, local, {}, { socketUrl: "ws://192.0.2.1:8765/ws/browser" });
  // Keep the old binding paused and invalid so no old socket is created in this fixture.
  local.device.revoked = true;
  let requests = 0,
    kind = "computer";
  h.environment.fetch = async (url, init) => {
    requests++;
    assert.equal(url, "http://192.0.2.1:8765/api/device");
    assert.equal(init.headers.Authorization, "Bearer abr_device_new");
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    return Response.json({ id: "browser-device", name: "Token Browser", kind, capabilities: ["browser"] });
  };
  t.after(async () => {
    await h.popup({ type: "authorize_cancel" });
    for (let i = 0; i < 50; i++) {
      if ((await h.popup({ type: "status" })).connected) break;
      await delay(5);
    }
    await h.popup({ type: "unbind" });
    await delay(10);
  });
  await h.start();
  await delay(10);
  const message = { type: "bind_token", server: "http://192.0.2.1:8765", device_key: "abr_device_new" };
  assert.equal((await h.popup(message)).ok, false);
  assert.equal(requests, 0);
  assert.equal((await h.popup({ ...message, http_confirmed_origin: "http://other.example" })).ok, false);
  assert.equal(requests, 0);
  const accepted = { ...message, http_confirmed_origin: "http://192.0.2.1:8765" };
  assert.equal((await h.popup(accepted)).ok, true);
  for (let i = 0; i < 50; i++) {
    if (!(await h.popup({ type: "status" })).authorizing) break;
    await delay(5);
  }
  assert.equal(local.device.key, "abr_device_old");
  assert.match((await h.popup({ type: "status" })).authorization_error, /浏览器设备/);
  kind = "browser";
  assert.equal((await h.popup(accepted)).ok, true);
  for (let i = 0; i < 50; i++) {
    if (!(await h.popup({ type: "status" })).authorizing) break;
    await delay(5);
  }
  assert.equal(local.device.key, "abr_device_new");
  assert.equal(local.device.paused, true);
  assert.equal(local.device.http_confirmed_origin, "http://192.0.2.1:8765");
  const status = await h.popup({ type: "status" });
  assert.equal(status.label, "Token Browser");
  assert.ok(!JSON.stringify(status).includes("abr_device_new"));
});

test("cancelling in-flight Token verification cannot commit a late reply", async (t) => {
  const local = {};
  const h = harness(t, local);
  let release, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  h.environment.fetch = async () => {
    entered();
    return new Promise((resolve) => {
      release = () =>
        resolve(
          Response.json({ id: "browser-device", name: "Late", kind: "browser", capabilities: ["browser"] }),
        );
    });
  };
  t.after(() => {
    release?.();
  });
  await h.start();
  await delay(10);
  assert.equal(
    (await h.popup({ type: "bind_token", server: "https://abridge.example", device_key: "abr_device_new" }))
      .ok,
    true,
  );
  await started;
  assert.equal((await h.popup({ type: "authorize_cancel" })).ok, true);
  release();
  await delay(15);
  assert.equal(local.device?.key, undefined);
});

test("late close and revoke from a replaced browser binding cannot revoke the new Token", async (t) => {
  const local = {
    device: {
      server: "https://abridge.example",
      key: "abr_device_old",
      device_id: "browser-device",
      label: "Old",
    },
  };
  const h = harness(t, local, {}, { deferredClose: true });
  h.environment.fetch = async () =>
    Response.json({ id: "browser-device", name: "New", kind: "browser", capabilities: ["browser"] });
  t.after(async () => {
    await h.popup({ type: "unbind" });
    for (const s of h.sockets) s.finishClose?.();
    await delay(10);
  });
  await h.start();
  for (let i = 0; i < 50; i++) {
    if ((await h.popup({ type: "status" })).connected) break;
    await delay(5);
  }
  const old = h.sockets[0];
  assert.ok(old);
  assert.equal(
    (await h.popup({ type: "bind_token", server: "https://abridge.example", device_key: "abr_device_new" }))
      .ok,
    true,
  );
  for (let i = 0; i < 50; i++) {
    if (local.device.key === "abr_device_new") break;
    await delay(5);
  }
  assert.equal(local.device.key, "abr_device_new");
  old.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "revoke" }) }));
  old.dispatchEvent(Object.assign(new Event("close"), { code: 4403 }));
  await delay(10);
  assert.equal(local.device.revoked, undefined);
  assert.equal((await h.popup({ type: "status" })).configured, true);
});

test("manual binding during reconnect cleanup cannot create another old-Token connection", async (t) => {
  const local = {
    device: {
      server: "https://abridge.example",
      key: "abr_device_old",
      device_id: "browser-device",
      label: "Old",
    },
  };
  const h = harness(t, local, {}, { deferredClose: true });
  let releaseCleanup;
  t.after(async () => {
    releaseCleanup?.();
    await h.popup({ type: "authorize_cancel" });
    await h.popup({ type: "unbind" });
    for (const socket of h.sockets) socket.finishClose?.();
    await delay(10);
  });
  await h.start();
  for (let i = 0; i < 50; i++) {
    if ((await h.popup({ type: "status" })).connected) break;
    await delay(5);
  }
  assert.equal((await h.popup({ type: "status" })).connected, true);
  const old = h.sockets[0];
  const setSession = h.chrome.storage.session.set;
  let cleanupEntered;
  const cleaning = new Promise((resolve) => {
    cleanupEntered = resolve;
  });
  let held = false;
  h.chrome.storage.session.set = async (values) => {
    if (!held && values.closed_sessions) {
      held = true;
      const released = new Promise((resolve) => {
        releaseCleanup = resolve;
      });
      cleanupEntered();
      await released;
    }
    await setSession(values);
  };
  // Recover an unhealthy socket while retaining its delayed close callback.
  old.readyState = 2;
  h.chrome.alarms.onAlarm.emit({ name: "abridge-connection-recovery" });
  await cleaning;
  h.environment.fetch = async () =>
    Response.json({ id: "browser-device", name: "New", kind: "browser", capabilities: ["browser"] });
  assert.equal(
    (await h.popup({ type: "bind_token", server: "https://abridge.example", device_key: "abr_device_new" }))
      .ok,
    true,
  );
  // Let verification enqueue its commit, which waits for the held reconnect.
  await delay(0);
  releaseCleanup();
  for (let i = 0; i < 50; i++) {
    const status = await h.popup({ type: "status" });
    if (!status.authorizing && status.connected) break;
    await delay(5);
  }
  assert.equal(local.device.key, "abr_device_new");
  assert.deepEqual(
    h.messages.filter((message) => message.type === "hello").map((message) => message.device_key),
    ["abr_device_old", "abr_device_new"],
  );
  assert.equal(h.sockets.length, 2);
  old.receive({ type: "revoke" });
  old.dispatchEvent(Object.assign(new Event("close"), { code: 4403 }));
  await delay(0);
  assert.equal(local.device.revoked, undefined);
  assert.equal((await h.popup({ type: "status" })).connected, true);
});

test("worker browser_open enforces the shared contract before task tab side effects", async (t) => {
  const local = {
    device: { server: "https://abridge.example", key: "key", device_id: "browser-device" },
  };
  const h = harness(t, local, {});
  try {
    await h.start();
    await delay(10);
    let sequence = 0;
    for (const args of [
      { url: "https://example.com/", observe_after: false },
      { url: "https://example.com/", observe_after: true },
      { url: "https://example.com/" + "a".repeat(8192) },
    ]) {
      const id = `invalid-open-${++sequence}`;
      const receipt = h.nextResult(id);
      h.sockets[0].receive(h.dispatch(id, sequence, { arguments: args }));
      const response = await receipt;
      assert.equal(response.status, "refused");
      assert.equal(response.error.code, "invalid_params");
      assert.equal(h.tabs.size, 1, "Invalid open must not create a task tab");
      assert.equal(h.tabs.get(1).url, "https://personal.example/");
    }
  } finally {
    await h.popup({ type: "unbind" });
    await delay(5);
  }
});

function assertClientReleased(h) {
  for (const source of [
    h.chrome.runtime.onMessage,
    h.chrome.runtime.onStartup,
    h.chrome.alarms.onAlarm,
    h.chrome.tabs.onUpdated,
    h.chrome.tabs.onRemoved,
    h.chrome.debugger.onDetach,
  ])
    assert.equal(source.listeners.length, 0);
  assert.equal(h.timeouts.size, 0);
  assert.equal(h.intervals.size, 0);
}

test("independent client instances keep bindings, sockets and lifecycle cleanup isolated", async (t) => {
  const first = {
    device: { server: "https://abridge.example", key: "first-key", device_id: "browser-device" },
  };
  const second = {
    device: { server: "https://abridge.example", key: "second-key", device_id: "browser-device" },
  };
  const a = harness(t, first),
    b = harness(t, second);
  await Promise.all([a.start(), b.start()]);
  await delay(10);
  assert.equal(a.messages.find((message) => message.type === "hello").device_key, "first-key");
  assert.equal(b.messages.find((message) => message.type === "hello").device_key, "second-key");
  assert.notEqual(a.sockets[0], b.sockets[0]);
  const socket = a.sockets[0];
  await a.client.close();
  assertClientReleased(a);
  socket.receive({ type: "revoke" });
  socket.dispatchEvent(Object.assign(new Event("close"), { code: 4403 }));
  a.chrome.alarms.onAlarm.emit({ name: "abridge-connection-recovery" });
  a.chrome.runtime.onStartup.emit();
  await delay(10);
  assert.equal(first.device.key, "first-key");
  assert.equal(first.device.revoked, undefined);
  assert.equal(a.sockets.length, 1);
  assert.equal((await b.popup({ type: "status" })).connected, true);
  assert.equal((await b.popup({ type: "pause", paused: true })).ok, true);
  assert.equal(second.device.paused, true);
  assert.equal(first.device.paused, undefined);
  await assert.rejects(a.client.start(), { code: "client_closed" });
});

test("close during storage initialization retires startup before resources or credentials can change", async (t) => {
  const local = { device: { server: "https://abridge.example", key: "key", device_id: "browser-device" } };
  const h = harness(t, local, { owned_task_tabs: [9] });
  let release;
  h.chrome.storage.local.get = () =>
    new Promise((resolve) => {
      release = () => resolve(local);
    });
  const initial = structuredClone(local);
  const starting = h.client.start();
  // MV3 wake listeners are present before the first storage read resolves.
  assert.equal(h.chrome.runtime.onMessage.listeners.length, 1);
  assert.equal(h.chrome.alarms.onAlarm.listeners.length, 1);
  const closing = h.client.close();
  const rejected = assert.rejects(starting, { code: "client_closed" });
  release();
  await Promise.all([closing, rejected]);
  assertClientReleased(h);
  assert.deepEqual(local, initial);
  assert.equal(h.sockets.length, 0);
  assert.deepEqual(h.removed, []);
});

test("close aborts pending credential verification and ignores an uncooperative late reply", async (t) => {
  const local = {},
    h = harness(t, local);
  let release, requestSignal, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  h.environment.fetch = async (_url, request) => {
    requestSignal = request.signal;
    entered();
    return new Promise((resolve) => {
      release = () =>
        resolve(
          Response.json({ id: "browser-device", name: "Late", kind: "browser", capabilities: ["browser"] }),
        );
    });
  };
  await h.start();
  assert.equal(
    (await h.popup({ type: "bind_token", server: "https://abridge.example", device_key: "abr_device_late" }))
      .ok,
    true,
  );
  await started;
  await h.client.close();
  assert.equal(requestSignal.aborted, true);
  assertClientReleased(h);
  const closed = structuredClone(local);
  release();
  await delay(10);
  assert.deepEqual(local, closed);
  assert.equal(local.device?.key, undefined);
  assert.equal(h.sockets.length, 0);
});

test("terminal journal failure preserves the confirmed result without replay and restart remains conservative", async (t) => {
  const local = { device: { server: "https://abridge.example", key: "key", device_id: "browser-device" } };
  const h = harness(t, local);
  await h.start();
  await delay(10);
  const set = h.chrome.storage.local.set;
  h.chrome.storage.local.set = async (values) => {
    if (values.operation_journal?.confirmed?.status === "executed")
      throw Error("terminal journal unavailable");
    return set(values);
  };
  const receipt = h.nextResult("confirmed");
  h.sockets[0].receive(h.dispatch("confirmed"));
  const response = await receipt;
  assert.equal(response.status, "executed");
  assert.equal(response.result.executed, true);
  assert.equal(response.result.url, "https://example.com/");
  assert.equal(response.error.code, "journal_persistence_failed");
  assert.equal(local.operation_journal.confirmed.status, "executing");
  const repeated = h.nextResult("confirmed");
  h.sockets[0].receive(h.dispatch("confirmed", 2));
  assert.equal((await repeated).result.deduplicated, true);
  assert.equal(h.tabs.size, 2);
  await h.client.close();
  const restarted = harness(t, local);
  await restarted.start();
  await delay(10);
  assert.equal(local.operation_journal.confirmed.status, "outcome_unknown");
  const recovered = restarted.nextResult("confirmed");
  restarted.sockets[0].receive(restarted.dispatch("confirmed"));
  assert.equal((await recovered).status, "outcome_unknown");
  assert.equal(restarted.tabs.size, 1, "Restart must not repeat the navigation");
});

test("terminal persistence warnings remain visible alongside a maximum-length execution error", async (t) => {
  const h = harness(t, {
    device: { server: "https://abridge.example", key: "key", device_id: "browser-device" },
  });
  await h.start();
  await delay(10);
  h.chrome.tabs.create = async () => {
    throw Error("x".repeat(2500));
  };
  const set = h.chrome.storage.local.set;
  h.chrome.storage.local.set = async (values) => {
    if (values.operation_journal?.failed?.status === "failed") throw Error("terminal journal unavailable");
    return set(values);
  };
  const receipt = h.nextResult("failed");
  h.sockets[0].receive(h.dispatch("failed"));
  const response = await receipt;
  assert.equal(response.status, "failed");
  assert.equal(response.error.code, "browser_error");
  assert.match(response.error.message, /操作终态日志保存失败/);
  assert.match(response.error.message, /x{100}/);
  assert.ok(response.error.message.length <= 2000);
});

test("stop and session close retire task pages before delayed or failed tombstone persistence", async (t) => {
  for (const control of ["stop", "session_close"]) {
    const h = harness(t, {
      device: { server: "https://abridge.example", key: "key", device_id: "browser-device" },
    });
    await h.start();
    await delay(10);
    const opened = h.nextResult("opened");
    h.sockets[0].receive(h.dispatch("opened"));
    await opened;
    const set = h.chrome.storage.session.set;
    let release, entered;
    const reached = new Promise((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise((_, reject) => {
      release = () => reject(Error("tombstone persistence failed"));
    });
    h.chrome.storage.session.set = async (values) => {
      if (values.closed_sessions) {
        entered();
        return blocked;
      }
      return set(values);
    };
    let stopping;
    try {
      if (control === "stop") stopping = h.popup({ type: "stop" });
      else h.sockets[0].receive({ type: "session_close", connection_epoch: 1, session_id: "task" });
      await reached;
      await delay(10);
      assert.deepEqual([...h.tabs.keys()], [1], `${control}: cleanup must not wait for storage`);
      assert.ok(h.removed.includes(2));
      release();
      if (stopping) assert.equal((await stopping).ok, false);
      await delay(10);
      assert.deepEqual([...h.tabs.keys()], [1]);
    } finally {
      release?.();
      h.chrome.storage.session.set = set;
      await stopping;
    }
  }
});

test("pause still clears task pages and refuses new work when saving the paused profile fails", async (t) => {
  const local = { device: { server: "https://abridge.example", key: "key", device_id: "browser-device" } };
  const h = harness(t, local);
  await h.start();
  await delay(10);
  const opened = h.nextResult("opened");
  h.sockets[0].receive(h.dispatch("opened"));
  await opened;
  const set = h.chrome.storage.local.set;
  h.chrome.storage.local.set = async (values) => {
    if (values.device) throw Error("profile persistence failed");
    return set(values);
  };
  const paused = await h.popup({ type: "pause" });
  assert.equal(paused.ok, false);
  assert.deepEqual([...h.tabs.keys()], [1]);
  assert.equal((await h.popup({ type: "status" })).paused, true);
  assert.notEqual(local.device.paused, true, "Failed writes must not mutate durable storage by reference");
  const refused = h.nextResult("after-pause");
  h.sockets[0].receive(h.dispatch("after-pause", 2, { session_id: "another-task" }));
  assert.equal((await refused).status, "refused");
  assert.equal(h.tabs.size, 1);
  const resumed = await h.popup({ type: "resume" });
  assert.equal(resumed.ok, false);
  assert.equal(
    (await h.popup({ type: "status" })).paused,
    true,
    "Failed resume must retain the in-memory pause",
  );
  assert.equal(
    h.messages.some((message) => message.type === "heartbeat" && message.paused === false),
    false,
  );
  h.chrome.storage.local.set = set;
});

test("startup preserves uncertain orphan ownership but clears a confirmed missing tab", async (t) => {
  for (const missing of [false, true]) {
    const session = { owned_task_tabs: [9] };
    const h = harness(
      t,
      { device: { server: "https://abridge.example", key: "key", device_id: "browser-device" } },
      session,
    );
    if (!missing) h.tabs.set(9, { id: 9, url: "https://example.com/old-task" });
    const remove = h.chrome.tabs.remove,
      get = h.chrome.tabs.get;
    h.chrome.tabs.remove = async () => {
      throw Error("temporary removal failure");
    };
    h.chrome.tabs.get = async () => {
      throw Error(missing ? "No tab with id: 9." : "temporary lookup failure");
    };
    try {
      if (missing) {
        await h.client.start();
        await delay(10);
        assert.deepEqual(session.owned_task_tabs, []);
        assert.equal(h.sockets.length, 1);
      } else {
        await assert.rejects(h.client.start(), { code: "cleanup_failed" });
        assert.deepEqual(session.owned_task_tabs, [9]);
        assert.equal(h.tabs.has(9), true);
        assert.equal(h.sockets.length, 0);
      }
    } finally {
      h.chrome.tabs.remove = remove;
      h.chrome.tabs.get = get;
    }
  }
});
