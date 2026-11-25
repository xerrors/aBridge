import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { controllerChatSchema, controllerMessageSchema, taskViewSchema } from "@abridge/protocol";
import { createServer } from "../src/server.js";

test("controller chat preserves one account history and creates tasks only after confirmation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abridge-controller-"));
  const web = join(dir, "web"),
    controller = join(dir, "controller");
  await mkdir(web);
  await mkdir(controller);
  await writeFile(join(web, "index.html"), "existing aBridge console");
  await writeFile(join(controller, "index.html"), "AI Home");
  await writeFile(join(controller, "app.js"), 'console.log("AI Home");');
  const server = await createServer({
    dbPath: join(dir, "database.sqlite"),
    staticRoot: web,
    adminToken: "fixture-admin-device-token-12345678",
    controllerStaticRoot: controller,
  });
  try {
    const password = "fixture-chat-password";
    const sender = await server.store.createUser("Sender", password);
    const receiver = await server.store.createUser("Receiver", password);
    const { device } = server.store.createDevice(receiver.id, "Synthetic Android", ["screen", "input"]);
    server.store.updateDeviceMetadata(device.id, device.credential_version, device.epoch, {
      platform: "android",
      version: "fixture",
    });
    const headers = (id: string) => ({
      host: "localhost",
      cookie: "abridge_session=" + server.store.createLogin(id),
    });
    const auth = headers(sender.id),
      other = headers(receiver.id);
    const prefix = "/api/controller/chat";
    const get = (url: string, h = auth) => server.app.inject({ url, headers: h });
    const send = (method: "POST" | "PATCH", url: string, payload: Record<string, unknown>, h = auth) =>
      server.app.inject({ method, url, headers: h, payload });

    const root = await get("/");
    assert.equal(root.statusCode, 302);
    assert.equal(root.headers.location, "/admin");
    assert.equal((await get("/?authorize=fixture")).body, "existing aBridge console");
    assert.equal((await get("/admin")).body, "existing aBridge console");
    const newDevice = { name: "Admin provisioned Android", owner_id: receiver.id };
    assert.equal((await send("POST", "/api/admin/devices", newDevice)).statusCode, 401);
    const admin = { ...auth, authorization: "Bearer fixture-admin-device-token-12345678" };
    assert.equal(
      (await send("POST", "/api/admin/devices", { ...newDevice, owner_id: "missing" }, admin)).statusCode,
      404,
    );
    const provisioned = await send("POST", "/api/admin/devices", newDevice, admin);
    assert.equal(provisioned.statusCode, 201);
    assert.equal(provisioned.headers["cache-control"], "no-store");
    assert.equal(server.store.device(provisioned.json().id)?.owner_id, receiver.id);
    assert.ok(provisioned.json().key);
    for (const entry of ["/controller", "/controller/"]) {
      const page = await get(entry);
      assert.equal(page.statusCode, 200);
      assert.equal(page.body, "AI Home");
      assert.match(String(page.headers["content-security-policy"]), /frame-src 'none'/);
    }
    const asset = await get("/controller/static/app.js");
    assert.equal(asset.statusCode, 200);
    assert.equal(asset.body, 'console.log("AI Home");');
    assert.equal((await get("/api/admin/tasks")).statusCode, 401);
    const draft = (
      await send("POST", prefix, { request_id: "request-1", text: "Read the next alarm" })
    ).json();
    const { id } = controllerMessageSchema.parse(draft.message);
    assert.equal(
      (await send("POST", prefix, { request_id: "request-1", text: "Read the next alarm" })).json().message
        .id,
      id,
    );
    assert.equal(
      (await send("POST", prefix, { request_id: "request-1", text: "Edit a different alarm" })).statusCode,
      409,
    );
    assert.equal((await get("/api/tasks")).json().tasks.length, 0);
    assert.equal((await send("POST", prefix + "/" + id + "/confirm", {})).statusCode, 422);
    assert.equal(
      (await send("PATCH", prefix + "/" + id, { recipient_id: receiver.id, device_id: device.id }, other))
        .statusCode,
      404,
    );
    assert.equal(
      (await send("PATCH", prefix + "/" + id, { recipient_id: receiver.id, device_id: device.id }))
        .statusCode,
      200,
    );
    assert.equal((await get("/api/tasks")).json().tasks.length, 0);

    const confirm = () => send("POST", prefix + "/" + id + "/confirm", {});
    const [a, b] = await Promise.all([confirm(), confirm()]);
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(b.statusCode, 200, b.body);
    const task = taskViewSchema.parse(a.json().task);
    assert.equal(b.json().task.id, task.id);
    assert.equal(task.status, "approval");
    assert.equal((await get("/api/tasks")).json().tasks.length, 1);
    const history = controllerChatSchema.parse((await get(prefix)).json());
    assert.equal(history.messages[0]?.status, "confirmed");
    assert.equal(history.messages[0]?.task_id, task.id);
    assert.equal((await get(prefix, other)).json().messages.length, 0);
    const draft2 = (await send("POST", prefix, { request_id: "request-2", text: "View the calendar" })).json()
      .message.id;
    assert.equal(
      (await send("POST", prefix + "/" + draft2 + "/cancel", {})).json().message.status,
      "cancelled",
    );
    assert.equal((await send("POST", prefix + "/" + draft2 + "/confirm", {})).statusCode, 409);
    assert.equal((await get("/api/tasks")).json().tasks.length, 1);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
