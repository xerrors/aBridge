import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deviceMetadataSchema, type Capability, type DeviceKind } from "@abridge/protocol";
import { Store } from "../src/store.js";
import { ControlService } from "../src/control.js";
import type { DeviceTransport, JsonObject } from "../src/types.js";

const transport: DeviceTransport = { async send() {}, async close() {} };
function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => (resolve = done)), resolve: () => resolve() };
}
async function fixture(
  kind: DeviceKind = "computer",
  capabilities: Capability[] = kind === "browser" ? ["browser"] : ["shell"],
) {
  const dir = await mkdtemp(join(tmpdir(), "abridge-device-metadata-"));
  const path = join(dir, "server.db");
  let store = new Store(path);
  let control = new ControlService(store);
  const owner = await store.createUser("metadata-fixture", "synthetic-metadata-password");
  const { device, key } = store.createDevice(owner.id, "Fixture", capabilities, kind);
  const { agentConnection } = store.createAgentConnection(owner.id, "Fixture agent", {
    mode: "selected",
    devices: [{ device_id: device.id, capabilities }],
  });
  const hello = { capabilities: Object.fromEntries(capabilities.map((cap) => [cap, true])) };
  return {
    get store() {
      return store;
    },
    get control() {
      return control;
    },
    device,
    key,
    agentConnection,
    hello,
    kind,
    view() {
      return control.deviceView(store.device(device.id)!, agentConnection);
    },
    attach(metadata: JsonObject, connection = transport) {
      return control.attachConnection(key, kind, { ...hello, ...metadata }, connection);
    },
    async restart() {
      await control.shutdown();
      store.close();
      store = new Store(path);
      store.recoverAfterRestart();
      control = new ControlService(store);
    },
    async close() {
      await control.shutdown();
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

for (const [kind, platform] of [
  ["computer", "win32"],
  ["browser", "Browser extension"],
  ["browser", "chrome"],
] as const) {
  test(`${kind} ${platform} metadata survives disconnect and restart, and updates on reconnect`, async () => {
    const f = await fixture(kind);
    try {
      assert.deepEqual(deviceMetadataSchema.parse(f.view()), { platform: null, version: null });
      const ticket = await f.attach({ platform: ` ${platform} `, version: " 0.4.13 " });
      const metadata = { platform, version: "0.4.13" };
      assert.deepEqual(deviceMetadataSchema.parse(f.view()), metadata);
      f.control.dropConnection(ticket);
      assert.equal(f.view().status, "offline");
      assert.deepEqual(deviceMetadataSchema.parse(f.view()), metadata);
      await f.restart();
      assert.equal(f.view().status, "offline");
      assert.deepEqual(deviceMetadataSchema.parse(f.view()), metadata);
      await f.attach({ platform, version: "0.4.14" });
      assert.deepEqual(deviceMetadataSchema.parse(f.view()), { platform, version: "0.4.14" });
      assert.equal(f.view().kind, kind);
      await f.attach({ platform: "  ", version: null });
      assert.deepEqual(deviceMetadataSchema.parse(f.view()), { platform: null, version: null });
    } finally {
      await f.close();
    }
  });
}

test("invalid identity or metadata cannot replace a connected device's metadata", async () => {
  const f = await fixture();
  try {
    await f.attach({ platform: "linux", version: "fixture-1" });
    await assert.rejects(
      f.control.attachConnection(
        f.key,
        "browser",
        {
          capabilities: { browser: true },
          platform: "forged",
          version: "forged",
        },
        transport,
      ),
      { code: "unauthorized" },
    );
    for (const invalid of [
      { platform: 1 },
      { platform: "x".repeat(81) },
      { version: "x".repeat(31) },
      { details: { runtime_user: "test\0user" } },
      { details: { os_version: "x".repeat(129) } },
      { details: { browser_version: "137.2" } },
      { details: { owner_name: "forged" } },
    ])
      await assert.rejects(f.attach(invalid));
    assert.equal(f.view().status, "online");
    assert.deepEqual(deviceMetadataSchema.parse(f.view()), { platform: "linux", version: "fixture-1" });
  } finally {
    await f.close();
  }
});

test("system details persist, while discovery omits local account and host labels", async () => {
  const f = await fixture();
  try {
    const summary = { os: "linux", os_version: "24.04", distribution: "Ubuntu", architecture: "arm64" };
    const details = {
      ...summary,
      hostname: "fixture-host",
      runtime_user: "fixture-unix",
      model: "Fixture model",
      kernel_version: "6.8.0",
    };
    await f.attach({ platform: "linux", version: "fixture-1", details, owner_name: "forged" });
    assert.deepEqual(f.view().details, summary);
    assert.equal(f.view().owner_name, undefined);
    await f.restart();
    const device = f.store.device(f.device.id)!;
    for (const view of [
      f.control.deviceView(device),
      f.control.deviceView(device, f.agentConnection, true),
    ]) {
      assert.deepEqual(view.details, details);
      assert.equal(view.owner_name, "metadata-fixture");
      assert.equal(view.status, "offline");
    }
    await f.attach({ platform: "linux", version: "fixture-2", details: summary });
    assert.deepEqual(f.store.device(device.id)?.details, summary);
    await f.attach({ platform: "linux", version: "fixture-3" });
    assert.equal(f.store.device(device.id)?.details, undefined);
  } finally {
    await f.close();
  }
});

test("a failed welcome does not replace the last successful metadata", async () => {
  const f = await fixture();
  try {
    await f.attach({ platform: "linux", version: "fixture-1" });
    await assert.rejects(
      f.attach(
        { platform: "darwin", version: "fixture-2" },
        {
          async send() {
            throw new Error("fixture transport failed");
          },
          async close() {},
        },
      ),
      /fixture transport failed/,
    );
    assert.equal(f.view().status, "offline");
    assert.deepEqual(deviceMetadataSchema.parse(f.view()), { platform: "linux", version: "fixture-1" });
  } finally {
    await f.close();
  }
});

test("delayed welcomes cannot publish metadata after disconnect, credential rotation or revocation", async () => {
  for (const interruption of ["disconnect", "rotate", "revoke"] as const) {
    const f = await fixture();
    const entered = deferred(),
      release = deferred();
    try {
      await f.attach({ platform: "linux", version: "fixture-1" });
      const attaching = f.attach(
        { platform: "darwin", version: "fixture-2" },
        {
          async send(frame) {
            if (frame.type === "welcome") {
              entered.resolve();
              await release.promise;
            }
          },
          async close() {},
        },
      );
      await entered.promise;
      if (interruption === "disconnect") await f.control.shutdown();
      else if (interruption === "rotate") f.store.rotateDevice(f.device.id);
      else f.store.revokeDevice(f.device.id);
      release.resolve();
      await attaching;
      assert.deepEqual(deviceMetadataSchema.parse(f.store.device(f.device.id)), {
        platform: "linux",
        version: "fixture-1",
      });
    } finally {
      release.resolve();
      await f.close();
    }
  }
});

test("replacement rechecks credentials after waiting for the old connection to close", async () => {
  const f = await fixture();
  const entered = deferred(),
    release = deferred();
  try {
    await f.attach(
      { platform: "linux", version: "fixture-1" },
      {
        async send() {},
        async close() {
          entered.resolve();
          await release.promise;
        },
      },
    );
    const rejected = assert.rejects(f.attach({ platform: "darwin", version: "fixture-2" }), {
      code: "unauthorized",
    });
    await entered.promise;
    f.store.rotateDevice(f.device.id);
    release.resolve();
    await rejected;
    assert.deepEqual(deviceMetadataSchema.parse(f.view()), { platform: "linux", version: "fixture-1" });
  } finally {
    release.resolve();
    await f.close();
  }
});

test("queued reconnects leave the newest successful metadata when an old close arrives late", async () => {
  const f = await fixture();
  const entered = deferred(),
    release = deferred();
  try {
    const first = f.attach(
      { platform: "linux", version: "fixture-1" },
      {
        async send(frame) {
          if (frame.type === "welcome") {
            entered.resolve();
            await release.promise;
          }
        },
        async close() {},
      },
    );
    await entered.promise;
    const second = f.attach({ platform: "darwin", version: "fixture-2" });
    release.resolve();
    const old = await first;
    await second;
    f.control.dropConnection(old);
    assert.equal(f.view().status, "online");
    assert.deepEqual(deviceMetadataSchema.parse(f.view()), { platform: "darwin", version: "fixture-2" });
  } finally {
    release.resolve();
    await f.close();
  }
});

test("Android interaction state gates UI capabilities independently of connectivity and files", async () => {
  const f = await fixture("computer", ["screen", "input", "files"]);
  try {
    const ticket = await f.attach({ platform: "android", interaction_state: "ready" });
    const ui = f.control.openSession(f.agentConnection, f.device.id, ["screen", "input"]);
    const files = f.control.openSession(f.agentConnection, f.device.id, ["files"]);
    const report = (interaction_state: "locked" | "screen_off" | "ready") =>
      f.control.receive(ticket, {
        type: "heartbeat",
        connection_epoch: ticket.epoch,
        interaction_state,
        capabilities: { screen: true, input: true, files: true },
      });
    for (const [state, code] of [
      ["locked", "device_locked"],
      ["screen_off", "screen_off"],
    ] as const) {
      await report(state);
      const view = f.control.devices(f.agentConnection)[0];
      assert.equal(view.status, "online");
      assert.equal(view.interaction_state, state);
      assert.deepEqual(view.available, { screen: false, input: false, files: true });
      assert.throws(() => f.control.openSession(f.agentConnection, f.device.id, ["screen"]), { code });
      assert.equal(f.store.session(ui.id)?.status, "stopped");
      assert.equal(f.store.session(files.id)?.status, "active");
    }
    await report("ready");
    assert.equal(f.view().interaction_state, "ready");
    assert.notEqual(f.control.openSession(f.agentConnection, f.device.id, ["screen", "input"]).id, ui.id);
    f.control.dropConnection(ticket);
    assert.equal(f.view().status, "offline");
    assert.equal(f.view().interaction_state, undefined);
  } finally {
    await f.close();
  }
});
