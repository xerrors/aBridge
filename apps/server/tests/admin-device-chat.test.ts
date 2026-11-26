import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "../src/server.js";

test("admin device chat keeps its own identity, approval, idempotency and task privacy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abridge-admin-chat-"));
  const server = await createServer({
    dbPath: join(dir, "db.sqlite"),
    adminToken: "fixture-admin-chat-12345678901234567890",
  });
  try {
    const owner = await server.store.createUser("receiver", "fixture-password-123");
    const stranger = await server.store.createUser("stranger", "fixture-password-123");
    const { device } = server.store.createDevice(owner.id, "Fixture phone", ["screen", "input"]);
    server.store.updateDeviceMetadata(device.id, device.credential_version, device.epoch, {
      platform: "android",
      version: "fixture",
    });
    const path = `/api/admin/devices/${device.id}/chat`;
    const admin = { host: "localhost", authorization: "Bearer fixture-admin-chat-12345678901234567890" };
    const user = (id: string) => ({
      host: "localhost",
      cookie: `abridge_session=${server.store.createLogin(id)}`,
    });
    const send = (url: string, payload: Record<string, unknown>, headers: Record<string, string> = admin) =>
      server.app.inject({ method: "POST", url, payload, headers });
    const get = (url: string, headers: Record<string, string> = admin) => server.app.inject({ url, headers });
    assert.equal((await get(path, user(owner.id))).statusCode, 401);
    assert.equal(
      (await send(path, { request_id: "one", prompt: "查看时钟" }, user(owner.id))).statusCode,
      401,
    );
    assert.equal((await send(path, { request_id: "one", prompt: " " })).statusCode, 422);
    assert.equal(
      (await send(path, { request_id: "one", prompt: "查看时钟", recipient_id: stranger.id })).statusCode,
      422,
    );
    server.store.tasks.updateSettings(owner.id, { require_task_approval: true });
    const created = await send(path, { request_id: "one", prompt: "查看时钟" });
    assert.equal(created.statusCode, 201, created.body);
    const task = created.json().task;
    assert.equal(task.actor_id, "sys_instance_admin");
    assert.equal(task.recipient_id, owner.id);
    assert.equal(task.status, "approval");
    assert.equal((await send(path, { request_id: "one", prompt: "查看时钟" })).json().task.id, task.id);
    assert.equal((await send(path, { request_id: "one", prompt: "其他目标" })).statusCode, 409);
    assert.equal(
      server.store.tasks.claim(() => true),
      null,
    );
    assert.equal((await get(path)).json().tasks.length, 1);
    assert.equal((await get(`/api/admin/tasks/${task.id}`)).json().task.prompt, "查看时钟");
    assert.equal((await get(`/api/tasks/${task.id}`, user(stranger.id))).statusCode, 404);
    assert.equal((await get(`/api/tasks/${task.id}`, user(owner.id))).json().task.prompt, "查看时钟");
    const privateTask = server.store.tasks.create(stranger.id, {
      request_id: "private",
      prompt: "private prompt",
      recipient_id: owner.id,
      device_id: device.id,
    });
    assert.equal((await get(`/api/admin/tasks/${privateTask.id}`)).json().task.prompt, null);
    assert.equal((await get(path)).json().tasks.length, 1);
    assert.equal(
      server.store.users().some((u) => u.id === task.actor_id),
      false,
    );
    assert.equal(server.store.user(task.actor_id), undefined);
    assert.equal(
      await server.store.verifyUser("__abridge_instance_admin__", "fixture-password-123"),
      undefined,
    );
    assert.equal(
      (await send("/api/admin/devices", { owner_id: task.actor_id, name: "Forbidden" })).statusCode,
      404,
    );
    assert.equal(
      (await send(`/api/tasks/${task.id}/decision`, { approve: true }, user(stranger.id))).statusCode,
      404,
    );
    assert.equal(
      (await send(`/api/tasks/${task.id}/decision`, { approve: true }, user(owner.id))).json().task.status,
      "queued",
    );
    assert.equal((await send(`/api/admin/tasks/${task.id}/stop`, {})).json().task.status, "cancelled");
    assert.equal((await get(path)).json().tasks[0].status, "cancelled");
    const { device: secondPhone } = server.store.createDevice(owner.id, "Other phone", ["screen", "input"]);
    server.store.updateDeviceMetadata(secondPhone.id, secondPhone.credential_version, secondPhone.epoch, {
      platform: "android",
      version: "fixture",
    });
    for (let index = 0; index < 251; index++) {
      const other = server.store.tasks.create(task.actor_id, {
        request_id: `other-${index}`,
        prompt: "other device history",
        recipient_id: owner.id,
        device_id: secondPhone.id,
      });
      server.store.tasks.stop(other.id, null, true);
    }
    assert.deepEqual(
      (await get(path)).json().tasks.map((entry: { id: string }) => entry.id),
      [task.id],
    );
    const { device: computer } = server.store.createDevice(owner.id, "Desktop", ["screen", "input"]);
    assert.equal((await get(`/api/admin/devices/${computer.id}/chat`)).statusCode, 404);
    server.store.revokeDevice(device.id);
    assert.equal((await send(path, { request_id: "revoked", prompt: "查看时钟" })).statusCode, 404);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
