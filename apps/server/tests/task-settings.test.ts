import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "../src/server.js";

test("receiver settings govern new tasks across entry points and persist without changing pending tasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abridge-task-settings-"));
  const options = {
    dbPath: join(dir, "server.sqlite"),
    adminToken: "fixture-settings-admin-12345678901234567890",
  };
  let server = await createServer(options);
  try {
    const receiver = await server.store.createUser("receiver", "fixture-password-123");
    const sender = await server.store.createUser("sender", "fixture-password-123");
    const { device } = server.store.createDevice(receiver.id, "Fixture phone", ["screen", "input"]);
    server.store.updateDeviceMetadata(device.id, device.credential_version, device.epoch, {
      platform: "android",
      version: "fixture",
    });
    const auth = (id: string) => ({
      host: "localhost",
      cookie: `abridge_session=${server.store.createLogin(id)}`,
    });
    const receiverHeaders = auth(receiver.id),
      senderHeaders = auth(sender.id);
    const adminHeaders = { host: "localhost", authorization: `Bearer ${options.adminToken}` };
    const settings = "/api/controller/settings";
    const put = (payload: Record<string, unknown>, headers: Record<string, string> = receiverHeaders) =>
      server.app.inject({ method: "PUT", url: settings, headers, payload });
    const send = (
      url: string,
      payload: Record<string, unknown>,
      headers: Record<string, string> = senderHeaders,
    ) => server.app.inject({ method: "POST", url, headers, payload });
    const submit = (request_id: string, headers = senderHeaders, extra = {}) =>
      send(
        "/api/tasks",
        {
          request_id,
          recipient_id: receiver.id,
          device_id: device.id,
          prompt: "View clock",
          ...extra,
        },
        headers,
      );
    assert.equal(
      (await server.app.inject({ url: settings, headers: { host: "localhost" } })).statusCode,
      401,
    );
    assert.equal((await put({ require_task_approval: true }, adminHeaders)).statusCode, 401);
    assert.deepEqual((await server.app.inject({ url: settings, headers: receiverHeaders })).json(), {
      require_task_approval: false,
    });
    assert.equal((await put({ require_task_approval: "true" })).statusCode, 422);
    assert.equal(
      (await put({ require_task_approval: true, user_id: receiver.id }, senderHeaders)).statusCode,
      422,
    );
    const immediate = (await submit("default-off")).json().task;
    assert.equal(immediate.status, "approval");
    assert.equal(
      (
        await send(
          `/api/admin/devices/${device.id}/chat`,
          { request_id: "admin-default", prompt: "View clock" },
          adminHeaders,
        )
      ).json().task.status,
      "queued",
    );
    assert.equal((await put({ require_task_approval: true }, senderHeaders)).statusCode, 200);
    assert.equal((await submit("sender-cannot-change-receiver")).json().task.status, "approval");
    assert.equal((await put({ require_task_approval: true })).statusCode, 200);
    assert.equal(
      (await submit("caller-override", senderHeaders, { require_task_approval: false })).statusCode,
      422,
    );
    const pending = (await submit("receiver-on")).json().task;
    assert.equal(pending.status, "approval");
    assert.equal((await submit("own", receiverHeaders)).json().task.status, "queued");
    assert.equal(
      (
        await send(
          `/api/admin/devices/${device.id}/chat`,
          { request_id: "admin-on", prompt: "View clock" },
          adminHeaders,
        )
      ).json().task.status,
      "approval",
    );
    const adminPending = (
      await send(
        `/api/admin/devices/${device.id}/chat`,
        { request_id: "admin-on", prompt: "View clock" },
        adminHeaders,
      )
    ).json().task;
    assert.equal(
      (
        await send(
          `/api/admin/devices/${device.id}/chat`,
          { request_id: "admin-default", prompt: "View clock" },
          adminHeaders,
        )
      ).json().task.status,
      "queued",
    );
    const draft = (await send("/api/controller/chat", { request_id: "chat-on", text: "View clock" })).json()
      .message;
    const target = await server.app.inject({
      method: "PATCH",
      url: `/api/controller/chat/${draft.id}`,
      headers: senderHeaders,
      payload: { recipient_id: receiver.id, device_id: device.id },
    });
    assert.equal(target.statusCode, 200, target.body);
    const confirmed = await send(`/api/controller/chat/${draft.id}/confirm`, {});
    assert.equal(confirmed.statusCode, 200, confirmed.body);
    assert.equal(confirmed.json().task.status, "approval");
    assert.equal((await submit("default-off")).json().task.status, "approval");
    assert.equal((await send(`/api/tasks/${pending.id}/decision`, { approve: true })).statusCode, 404);
    await server.close();
    server = await createServer(options);
    assert.deepEqual((await server.app.inject({ url: settings, headers: receiverHeaders })).json(), {
      require_task_approval: true,
    });
    assert.equal((await put({ require_task_approval: false })).statusCode, 200);
    assert.equal(server.store.tasks.get(pending.id).status, "approval");
    assert.equal(server.store.tasks.get(adminPending.id).status, "approval");
    const adminRetry = (
      await send(
        `/api/admin/devices/${device.id}/chat`,
        { request_id: "admin-on", prompt: "View clock" },
        adminHeaders,
      )
    ).json().task;
    assert.equal(adminRetry.id, adminPending.id);
    assert.equal(adminRetry.status, "approval");
    assert.equal((await submit("receiver-on")).json().task.status, "approval");
    assert.equal((await send(`/api/controller/chat/${draft.id}/confirm`, {})).json().task.status, "approval");
    assert.equal((await submit("off-again")).json().task.status, "approval");
    assert.equal(
      (
        await send(
          `/api/admin/devices/${device.id}/chat`,
          { request_id: "admin-off-again", prompt: "View clock" },
          adminHeaders,
        )
      ).json().task.status,
      "queued",
    );
    assert.equal(
      (await send(`/api/tasks/${pending.id}/decision`, { approve: true }, receiverHeaders)).json().task
        .status,
      "queued",
    );
    server.store.revokeDevice(device.id);
    assert.equal((await submit("revoked")).statusCode, 404);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
