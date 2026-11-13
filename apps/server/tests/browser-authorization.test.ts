import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "../src/server.js";
import { browserWorkerFixture, EXTENSION_ID } from "./fixtures/browser-worker.js";

test(
  "actual extension worker exchanges browser approval with actual Server and connects while retaining pause",
  { timeout: 10000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "abridge-browser-authorization-"));
    const server = await createServer({ dbPath: join(directory, "server.db"), port: 0 });
    const url = await server.start();
    const user = await server.store.createUser("browser-consent", "browser-consent-fixture-password");
    const login = (await server.store.login("browser-consent", "browser-consent-fixture-password"))!;
    const originalFetch = globalThis.fetch;
    let worker: ReturnType<typeof browserWorkerFixture> | undefined;
    t.after(async () => {
      try {
        await worker?.dispose();
      } finally {
        globalThis.fetch = originalFetch;
        await server.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
    globalThis.fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("origin", `chrome-extension://${EXTENSION_ID}`);
      return originalFetch(input, { ...init, headers });
    };
    worker = browserWorkerFixture(url, "", "", async (page) => {
      assert.equal(new URL(page).origin, new URL(url).origin);
      assert.equal(
        server.store.devices(user.id).length,
        0,
        "Starting authorization must not create a device",
      );
      const id = new URL(page).searchParams.get("authorize")!;
      const approved = await server.app.inject({
        method: "POST",
        url: `/api/device-authorizations/${id}/decision`,
        headers: { cookie: `abridge_session=${login.token}` },
        payload: { approve: true, expected_user_id: user.id },
      });
      assert.equal(approved.statusCode, 200);
      assert.equal(server.store.devices(user.id).length, 0, "Consent alone must not create a device");
      return (approved.json() as { redirect_url: string }).redirect_url;
    });
    (worker.local.device as Record<string, unknown>).paused = true;
    await worker.load();
    assert.equal(
      (await worker.options({ type: "authorize", server: url, label: "Consent Browser" })).ok,
      true,
    );
    const deadline = performance.now() + 5000;
    while (!(await worker.options({ type: "status" })).connected) {
      if (performance.now() > deadline) assert.fail("Authorized worker did not connect");
      await delay(5);
    }
    const status = await worker.options({ type: "status" });
    assert.equal(status.paused, true);
    assert.equal(status.authorizing, false);
    assert.ok(!("key" in status));
    assert.equal(server.store.devices(user.id).length, 1);
    const device = server.store.devices(user.id)[0]!;
    assert.equal(device.kind, "browser");
    assert.equal(device.name, "Consent Browser");
    assert.deepEqual(device.capabilities, ["browser"]);
    assert.equal(server.control.deviceView(device).status, "online");
    assert.equal(server.control.deviceView(device).paused, true);
    assert.equal(worker.outgoing[0]?.device_key, (worker.local.device as Record<string, unknown>).key);
  },
);
