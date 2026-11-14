import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setImmediate } from "node:timers/promises";
import { build } from "esbuild";
import type { useUserSession } from "../src/session.js";

type Session = ReturnType<typeof useUserSession>;
type Slot = { value?: unknown; dependencies?: unknown[]; cleanup?: () => void };
type Handler = (path: string, options?: RequestInit) => Response | Promise<Response>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const unauthorized = () => Response.json({ error: { message: "Sign in" } }, { status: 401 });
function response(path: string, owner = "A"): Response {
  if (path === "/api/me") return Response.json({ id: owner, username: `Owner ${owner}` });
  if (path === "/api/devices")
    return Response.json({
      devices: [
        {
          id: `device-${owner}`,
          name: `Device ${owner}`,
          kind: "computer",
          capabilities: ["files"],
          status: "online",
          paused: false,
          available: { files: true },
        },
      ],
    });
  if (path === "/api/client-grants")
    return Response.json({
      grants: [
        {
          id: `grant-${owner}`,
          name: `Agent ${owner}`,
          policy: { mode: "all", capabilities: ["files"], overrides: [] },
          expires_at: null,
          revoked_at: null,
        },
      ],
    });
  return Response.json({ ok: true });
}

/** Run the production hook and API code, with only hook scheduling and HTTP replaced. */
async function fixture(handler: Handler = (path) => response(path), management = true) {
  const directory = await mkdtemp(join(tmpdir(), "abridge-session-test-"));
  const output = join(directory, "session.mjs");
  const key = "__abridgeSessionTestHooks";
  await build({
    entryPoints: [new URL("../src/session.ts", import.meta.url).pathname],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    plugins: [
      {
        name: "session-hooks",
        setup(builder) {
          builder.onResolve({ filter: /^preact\/hooks$/ }, () => ({ path: "hooks", namespace: "test" }));
          builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({
            contents: ["useState", "useRef", "useCallback", "useEffect"]
              .map((name) => `export const ${name} = (...args) => globalThis.${key}.${name}(...args);`)
              .join("\n"),
          }));
        },
      },
    ],
  });
  const originalFetch = globalThis.fetch;
  const originalInterval = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const slots: Slot[] = [];
  const effects: (() => void)[] = [];
  const timers = new Set<() => void>();
  const notices: string[] = [];
  const snapshots: Session[] = [];
  let cursor = 0,
    queued = false,
    disposed = false,
    state!: Session;
  let hook!: typeof useUserSession;
  const notify = (message: string) => notices.push(message);
  const render = () => {
    cursor = 0;
    state = hook(notify, management);
    snapshots.push(state);
    for (const effect of effects.splice(0)) effect();
  };
  const schedule = () => {
    if (queued || disposed) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (!disposed) render();
    });
  };
  const changed = (slot: Slot, dependencies: unknown[]) =>
    !slot.dependencies || dependencies.some((value, index) => value !== slot.dependencies![index]);
  Object.assign(globalThis, {
    [key]: {
      useState(initial: unknown) {
        const index = cursor++;
        if (!slots[index]) slots[index] = { value: typeof initial === "function" ? initial() : initial };
        const slot = slots[index]!;
        return [
          slot.value,
          (value: unknown) => {
            slot.value = typeof value === "function" ? value(slot.value) : value;
            schedule();
          },
        ];
      },
      useRef(initial: unknown) {
        const index = cursor++;
        if (!slots[index]) slots[index] = { value: { current: initial } };
        return slots[index]!.value;
      },
      useCallback(callback: unknown, dependencies: unknown[]) {
        const slot = (slots[cursor++] ??= {});
        if (changed(slot, dependencies)) Object.assign(slot, { value: callback, dependencies });
        return slot.value;
      },
      useEffect(callback: () => (() => void) | undefined, dependencies: unknown[]) {
        const slot = (slots[cursor++] ??= {});
        if (!changed(slot, dependencies)) return;
        slot.dependencies = dependencies;
        effects.push(() => {
          slot.cleanup?.();
          slot.cleanup = callback();
        });
      },
    },
  });
  globalThis.fetch = (input, options) => Promise.resolve(handler(String(input), options));
  globalThis.setInterval = ((callback: () => void) => {
    timers.add(callback);
    return callback;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((timer: () => void) => timers.delete(timer)) as unknown as typeof clearInterval;
  Object.defineProperty(globalThis, "document", { configurable: true, value: { hidden: false } });
  hook = (await import(pathToFileURL(output).href)).useUserSession as typeof useUserSession;
  render();
  return {
    get state() {
      return state;
    },
    notices,
    snapshots,
    async settle() {
      for (let turn = 0; turn < 5; turn++) await setImmediate();
    },
    tick() {
      for (const timer of timers) timer();
    },
    async dispose() {
      disposed = true;
      for (const slot of slots) slot.cleanup?.();
      globalThis.fetch = originalFetch;
      globalThis.setInterval = originalInterval;
      globalThis.clearInterval = originalClear;
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
      Reflect.deleteProperty(globalThis, key);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("poll failures invalidate realtime state, preserve metadata, recover, and sign out on 401", async () => {
  let failure: "network" | "partial" | "401" | undefined;
  const f = await fixture((path) => {
    if (failure === "network") throw new Error("Network unavailable");
    if (failure === "401") return unauthorized();
    if (failure === "partial" && path === "/api/client-grants")
      return Response.json({ error: { message: "Unavailable" } }, { status: 503 });
    return response(path);
  });
  try {
    await f.settle();
    for (const kind of ["network", "partial"] as const) {
      failure = kind;
      f.tick();
      await f.settle();
      assert.equal(f.state.phase, "ready");
      assert.equal(f.state.data.devices[0]?.status, "unknown");
      assert.equal(f.state.data.devices[0]?.available, undefined);
      assert.equal(f.state.data.devices[0]?.paused, undefined);
      assert.equal(f.state.data.devices[0]?.name, "Device A");
      assert.equal(f.state.data.grants[0]?.name, "Agent A");
      failure = undefined;
      await f.state.refresh();
      await f.settle();
      assert.equal(f.state.data.devices[0]?.status, "online");
      assert.deepEqual(f.state.data.devices[0]?.available, { files: true });
    }
    failure = "401";
    f.tick();
    await f.settle();
    assert.equal(f.state.phase, "login");
    assert.equal(f.state.user, null);
    assert.deepEqual(f.state.data, { devices: [], grants: [] });
  } finally {
    await f.dispose();
  }
});

test("cross-tab account changes clear old data and advance the revision used to close dialogs", async () => {
  let owner = "A";
  const f = await fixture((path) => response(path, owner));
  try {
    await f.settle();
    const revision = f.state.identityRevision;
    owner = "B";
    f.tick();
    await f.settle();
    assert.equal(f.state.user?.id, "B");
    assert.equal(f.state.data.devices[0]?.id, "device-B");
    assert.ok(f.state.identityRevision > revision);
    assert.ok(f.snapshots.some((state) => state.user?.id === "B" && !state.data.devices.length));
    assert.ok(
      !f.snapshots.some((state) => state.user?.id === "B" && state.data.devices[0]?.id === "device-A"),
    );
  } finally {
    await f.dispose();
  }
});

test("an identity change during the data requests retries instead of publishing mixed account data", async () => {
  let owner = "A",
    switchDuringRead = false;
  const f = await fixture((path) => {
    const result = response(path, owner);
    if (switchDuringRead && path === "/api/client-grants") {
      switchDuringRead = false;
      owner = "B";
    }
    return result;
  });
  try {
    await f.settle();
    switchDuringRead = true;
    await f.state.refresh();
    await f.settle();
    assert.equal(f.state.user?.id, "B");
    assert.equal(f.state.data.devices[0]?.id, "device-B");
    assert.equal(f.state.data.grants[0]?.id, "grant-B");
    assert.ok(
      !f.snapshots.some((state) => state.user?.id === "B" && state.data.devices[0]?.id === "device-A"),
    );
  } finally {
    await f.dispose();
  }
});

test("a late refresh cannot replace a newer account or restore a signed-out session", async () => {
  let owner = "A";
  let delayed: ReturnType<typeof deferred<Response>> | undefined;
  const f = await fixture((path) =>
    path === "/api/devices" && delayed ? delayed.promise : response(path, owner),
  );
  try {
    await f.settle();
    delayed = deferred<Response>();
    const old = f.state.refresh();
    await f.settle();
    const pending = delayed;
    delayed = undefined;
    owner = "B";
    await f.state.refresh();
    pending.resolve(response("/api/devices", "A"));
    await old;
    await f.settle();
    assert.equal(f.state.user?.id, "B");
    assert.equal(f.state.data.devices[0]?.id, "device-B");
    delayed = deferred<Response>();
    const late = f.state.refresh();
    await f.settle();
    await f.state.logout();
    delayed.resolve(response("/api/devices", "B"));
    await late;
    await f.settle();
    assert.equal(f.state.user, null);
    assert.equal(f.state.phase, "login");
    assert.deepEqual(f.state.data, { devices: [], grants: [] });
  } finally {
    await f.dispose();
  }
});

test("binding identity reload clears the previous identity and never reads management data", async () => {
  let owner = "A";
  const paths: string[] = [];
  const f = await fixture((path) => {
    paths.push(path);
    assert.equal(path, "/api/me");
    return response(path, owner);
  }, false);
  try {
    await f.settle();
    const revision = f.state.identityRevision;
    owner = "B";
    f.state.reloadIdentity();
    await f.settle();
    assert.equal(f.state.user?.id, "B");
    assert.equal(f.state.phase, "ready");
    assert.ok(f.state.identityRevision > revision);
    assert.ok(f.snapshots.some((state) => state.user === null && state.phase === "loading"));
    assert.equal(paths.length, 2);
  } finally {
    await f.dispose();
  }
});

test("logout waits for a pending login cookie and late login completion cannot restore identity", async () => {
  const login = deferred<Response>();
  let signedIn = false;
  const methods: string[] = [];
  const f = await fixture(async (path) => {
    if (path === "/api/login") {
      methods.push("login");
      const result = await login.promise;
      signedIn = true;
      return result;
    }
    if (path === "/api/logout") {
      methods.push("logout");
      signedIn = false;
      return response(path);
    }
    return signedIn ? response(path) : unauthorized();
  });
  try {
    await f.settle();
    const form = new FormData();
    form.set("username", "owner");
    form.set("password", "fixture-password");
    const authenticating = f.state.authenticate(form);
    await f.settle();
    const loggingOut = f.state.logout();
    await f.settle();
    assert.deepEqual(methods, ["login"]);
    login.resolve(response("/api/me"));
    await Promise.all([authenticating, loggingOut]);
    await f.settle();
    assert.deepEqual(methods, ["login", "logout"]);
    assert.equal(signedIn, false);
    assert.equal(f.state.user, null);
    assert.equal(f.state.phase, "login");
  } finally {
    login.resolve(response("/api/me"));
    await f.dispose();
  }
});

test("successful login supersedes an earlier pending identity read", async () => {
  const initial = deferred<Response>();
  let first = true;
  const f = await fixture((path) => {
    if (path === "/api/me" && first) {
      first = false;
      return initial.promise;
    }
    return response(path === "/api/login" ? "/api/me" : path);
  });
  try {
    const form = new FormData();
    form.set("username", "owner");
    form.set("password", "fixture-password");
    await f.state.authenticate(form);
    initial.resolve(response("/api/me", "B"));
    await f.settle();
    assert.equal(f.state.phase, "ready");
    assert.equal(f.state.user?.id, "A");
    assert.equal(f.state.data.devices[0]?.id, "device-A");
  } finally {
    initial.resolve(unauthorized());
    await f.dispose();
  }
});
