import { test } from "node:test";
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
    return { ...data };
  },
  async set(values) {
    Object.assign(data, values);
  },
  async remove(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
  },
});
function harness(local = {}, session = {}, settings = {}) {
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
      assert.equal(url, "wss://abridge.example/ws/browser");
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
  globalThis.chrome = chrome;
  globalThis.WebSocket = Socket;
  const fromPage = (message, page = "popup.html") =>
    new Promise((resolve) =>
      chrome.runtime.onMessage.listeners[0](
        message,
        { id: "extension", url: chrome.runtime.getURL(page) },
        resolve,
      ),
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
    grant_version: 1,
    tool: "browser_open",
    arguments: { url: "https://example.com/" },
    ...extra,
  });
  return {
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
test("standalone extension registers once, authenticates directly, isolates browser tools, persists no-replay and pauses", async (t) => {
  const originalDigest = crypto.subtle.digest;
  let firstDigest = true;
  crypto.subtle.digest = async function (...args) {
    if (firstDigest) {
      firstDigest = false;
      // The OS crypto pool can complete after a fixed 10 ms sleep on busy CI runners.
      await delay(30);
    }
    return originalDigest.apply(this, args);
  };
  t.after(() => {
    crypto.subtle.digest = originalDigest;
  });
  let authorizationRequest;
  const local = {},
    session = { owned_task_tabs: [9] },
    h = harness(local, session, {
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
  let requests = 0;
  globalThis.fetch = async (url, request) => {
    requests++;
    if (url.endsWith("/api/device-authorizations")) {
      authorizationRequest = JSON.parse(request.body);
      assert.equal(authorizationRequest.kind, "browser");
      assert.deepEqual(authorizationRequest.capabilities, ["browser"]);
      assert.equal(authorizationRequest.name, "Work");
      assert.equal(request.redirect, "error");
      return {
        ok: true,
        async json() {
          return {
            id: "r".repeat(43),
            authorization_url: "https://abridge.example/?authorize=" + "r".repeat(43),
            expires_at: Date.now() / 1000 + 300,
          };
        },
      };
    }
    assert.equal(url, "https://abridge.example/api/device-authorizations/token");
    const body = JSON.parse(request.body);
    assert.equal(body.redirect_uri, authorizationRequest.redirect_uri);
    assert.ok(body.code_verifier);
    return {
      ok: true,
      async json() {
        return {
          device_id: "browser-device",
          key: "abr_device_private-key",
          name: "Work",
          kind: "browser",
          capabilities: ["browser"],
        };
      },
    };
  };
  await import("../src/worker.ts?standalone");
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
  delete globalThis.fetch;
  delete globalThis.chrome;
  delete globalThis.WebSocket;
});
test("startup retains failed cleanup IDs and refuses connection", async () => {
  const local = { device: { server: "https://abridge.example", key: "key", device_id: "browser-device" } },
    session = { owned_task_tabs: [9] },
    h = harness(local, session);
  h.chrome.tabs.remove = async () => {
    throw Error("remove failed");
  };
  h.chrome.tabs.get = async (id) => ({ id });
  await import("../src/worker.ts?startup-cleanup");
  await delay(10);
  assert.equal(h.sockets.length, 0);
  assert.deepEqual(session.owned_task_tabs, [9]);
  const status = await h.popup({ type: "status" });
  assert.equal(status.error.code, "cleanup_failed");
  delete globalThis.chrome;
  delete globalThis.WebSocket;
});

test("worker recovery marks persisted executing intent unknown without replay", async () => {
  const local = { operation_journal: { pending: { status: "executing", request_hash: "opaque-hash" } } },
    h = harness(local, {});
  await import("../src/worker.ts?recover-intent");
  await delay(10);
  assert.equal(local.operation_journal.pending.status, "outcome_unknown");
  assert.equal(h.sockets.length, 0);
  assert.equal(h.tabs.size, 1);
  delete globalThis.chrome;
  delete globalThis.WebSocket;
});

test("cancel during digest or intent persistence prevents late page effects", async () => {
  for (const phase of ["digest", "journal"]) {
    const local = { device: { server: "https://abridge.example", key: "key", device_id: "browser-device" } },
      h = harness(local, {});
    await import(`../src/worker.ts?cancel-${phase}`);
    await delay(10);
    let release, entered;
    const reached = new Promise((resolve) => {
      entered = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const originalDigest = crypto.subtle.digest;
    const originalSet = h.chrome.storage.local.set;
    if (phase === "digest")
      crypto.subtle.digest = async function (...args) {
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
    crypto.subtle.digest = originalDigest;
    h.chrome.storage.local.set = originalSet;
    await h.popup({ type: "unbind" });
    await delay(5);
    delete globalThis.chrome;
    delete globalThis.WebSocket;
  }
});

test("recovery alarm restores connection when worker-local reconnect timer is lost", async (t) => {
  const local = {
      device: { server: "https://abridge.example", key: "key", device_id: "browser-device", paused: true },
    },
    h = harness(local, {});
  t.after(() => {
    local.device.revoked = true;
    for (const s of h.sockets) s.close();
  });
  await import("../src/worker.ts?lost-local-timer");
  await delay(10);
  assert.equal(h.sockets.length, 1);
  const recovery = [...h.alarms.values()][0];
  assert.ok(recovery, "authorized worker must install a browser-managed wake-up alarm");
  const originalSetTimeout = globalThis.setTimeout;
  // Worker termination loses its JS timer. A browser-managed alarm still wakes it.
  globalThis.setTimeout = () => 0;
  h.sockets[0].close();
  await delay(10);
  globalThis.setTimeout = originalSetTimeout;
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
  delete globalThis.chrome;
  delete globalThis.WebSocket;
});

test("recovery alarm replaces a stale apparently-open socket only after async task cleanup", async (t) => {
  const local = { device: { server: "https://abridge.example", key: "key", device_id: "browser-device" } },
    h = harness(local, {}, { asyncClose: true });
  t.after(() => {
    local.device.revoked = true;
    for (const s of h.sockets) s.close();
  });
  await import("../src/worker.ts?stale-socket-alarm");
  await delay(10);
  const recovery = [...h.alarms.values()][0];
  h.chrome.alarms.onAlarm.emit(recovery);
  await delay(10);
  assert.equal(h.sockets.length, 1, "healthy connection is not replaced by every alarm");
  h.sockets[0].receive(h.dispatch("owned-before-sleep"));
  await delay(10);
  assert.equal(h.tabs.size, 2);
  const now = Date.now;
  Date.now = () => now() + 60000;
  try {
    assert.equal(
      (await h.popup({ type: "status" })).connected,
      false,
      "stale heartbeat cannot be reported connected",
    );
    h.chrome.alarms.onAlarm.emit(recovery);
    await delay(20);
  } finally {
    Date.now = now;
  }
  assert.equal(h.sockets.length, 2, "missed heartbeat lease replaces an apparently-open socket");
  assert.equal(h.sockets[0].readyState, 3);
  assert.deepEqual(h.tabsAtConnect[1], [1], "old task tab is removed before reconnect");
  assert.equal((await h.popup({ type: "status" })).connected, true);
  await h.popup({ type: "unbind" });
  await delay(5);
  delete globalThis.chrome;
  delete globalThis.WebSocket;
});

test("alarm reconnect during CLOSING completes old task cleanup before replacing the socket", async (t) => {
  const local = { device: { server: "https://abridge.example", key: "key", device_id: "browser-device" } },
    h = harness(local, {}, { deferredClose: true });
  t.after(() => {
    local.device.revoked = true;
    for (const s of h.sockets) {
      s.close();
      s.finishClose?.();
    }
  });
  await import("../src/worker.ts?closing-socket-alarm");
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
  delete globalThis.chrome;
  delete globalThis.WebSocket;
});

test("only the exact popup page controls the worker; stopping tasks preserves connection and authorization", async () => {
  const local = { device: { server: "https://abridge.example", key: "key", device_id: "browser-device" } },
    h = harness(local, {});
  await import("../src/worker.ts?popup-controls");
  await delay(10);
  for (const page of ["untrusted.html", "options.html", "popup.html?spoof=1", "popup.html#spoof"]) {
    assert.equal(
      h.chrome.runtime.onMessage.listeners[0](
        { type: "pause" },
        { id: "extension", url: h.chrome.runtime.getURL(page) },
        () => assert.fail(),
      ),
      false,
    );
  }
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
  delete globalThis.chrome;
  delete globalThis.WebSocket;
});

test("closing another session does not cancel a dispatch waiting on durable intent", async (t) => {
  const local = { device: { server: "https://abridge.example", key: "key", device_id: "browser-device" } },
    h = harness(local, {});
  t.after(() => {
    local.device.revoked = true;
    for (const socket of h.sockets) socket.close();
    delete globalThis.chrome;
    delete globalThis.WebSocket;
  });
  await import("../src/worker.ts?cross-session-close");
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
  delete globalThis.chrome;
  delete globalThis.WebSocket;
});

test("an open popup is notified when remote work starts, completes and closes its task session", async (t) => {
  const local = { device: { server: "https://abridge.example", key: "key", device_id: "browser-device" } };
  const h = harness(local, {});
  t.after(async () => {
    await h.popup({ type: "unbind" });
    local.device.revoked = true;
    for (const socket of h.sockets) socket.close();
  });
  await import("../src/worker.ts?task-status-notifications");
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
    h = harness(local, session);
  const originalDigest = crypto.subtle.digest;
  t.after(async () => {
    crypto.subtle.digest = originalDigest;
    await h.popup({ type: "unbind" });
    delete globalThis.chrome;
    delete globalThis.WebSocket;
  });
  await import("../src/worker.ts?independent-cancel-scope");
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
  crypto.subtle.digest = async function (...args) {
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

test("independent: cancelling a completed page action before result publication redacts it and permits session recovery", async (t) => {
  const local = { device: { server: "https://abridge.example", key: "key", device_id: "browser-device" } };
  const session = {},
    h = harness(local, session);
  t.after(async () => {
    await h.popup({ type: "unbind" });
    delete globalThis.chrome;
    delete globalThis.WebSocket;
  });
  await import("../src/worker.ts?independent-cancel-late");
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
  assert.equal(receipt.status, "outcome_unknown");
  assert.deepEqual(receipt.result, {});
  assert.equal(local.operation_journal.late.status, "outcome_unknown");
  assert.deepEqual(session.closed_sessions ?? [], []);
  assert.equal(h.tabs.size, 1);
  h.sockets[0].receive(h.dispatch("recovery-open", 2));
  await delay(25);
  assert.equal(h.messages.find((m) => m.operation_id === "recovery-open").status, "executed");
});

for (const fence of ["revoke", "deadline"])
  test(`independent: ${fence} during digest blocks later page effects`, async (t) => {
    const local = { device: { server: "https://abridge.example", key: "key", device_id: "browser-device" } };
    const h = harness(local, {}, { deferredClose: true });
    const originalDigest = crypto.subtle.digest;
    t.after(async () => {
      crypto.subtle.digest = originalDigest;
      await h.popup({ type: "unbind" });
      for (const socket of h.sockets) socket.finishClose?.();
      delete globalThis.chrome;
      delete globalThis.WebSocket;
    });
    await import(`../src/worker.ts?independent-fence-${fence}`);
    await delay(10);
    let release, entered;
    const reached = new Promise((resolve) => (entered = resolve));
    const gate = new Promise((resolve) => (release = resolve));
    crypto.subtle.digest = async function (...args) {
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
  const h = harness(local, {}, { leaseSeconds: 1 });
  const originalNow = Date.now;
  t.after(async () => {
    Date.now = originalNow;
    await h.popup({ type: "unbind" });
    delete globalThis.chrome;
    delete globalThis.WebSocket;
  });
  await import("../src/worker.ts?independent-lease-expired");
  await delay(10);
  const frame = h.dispatch("lease-expired", 1);
  Date.now = () => originalNow() + 2000;
  h.sockets[0].receive(frame);
  await delay(25);
  assert.equal(h.tabs.size, 1, "An expired connection lease cannot admit browser page work");
  assert.notEqual(h.messages.find((m) => m.operation_id === "lease-expired")?.status, "executed");
});

test("browser consent completes without an open popup and a reopened popup restores pending details", async () => {
  let finishBrowser;
  let started;
  let tokenRequests = 0;
  const local = {
    device: { server: "https://old.example", label: "Old profile", paused: true, revoked: true },
  };
  const h = harness(
    local,
    {},
    {
      authorize: () =>
        new Promise((resolve) => {
          finishBrowser = resolve;
        }),
    },
  );
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
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
    await import("../src/worker.ts?popup-consent-lifetime");
    assert.equal(
      (await h.popup({ type: "authorize", server: "https://abridge.example", label: "Work" })).ok,
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
    globalThis.fetch = previousFetch;
    delete globalThis.chrome;
    delete globalThis.WebSocket;
  }
});

test("browser consent waits outside control queue and a cancelled late approval cannot bind", async () => {
  let finishBrowser;
  let started;
  let tokenRequests = 0;
  const local = { device: { paused: true } },
    session = {};
  const h = harness(local, session, {
    authorize: () =>
      new Promise((resolve) => {
        finishBrowser = resolve;
      }),
  });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
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
    await import("../src/worker.ts?browser-consent-cancel");
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
    globalThis.fetch = previousFetch;
    delete globalThis.chrome;
    delete globalThis.WebSocket;
  }
});
