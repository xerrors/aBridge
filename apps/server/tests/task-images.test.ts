import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createServer } from "../src/server.js";

// A real 1×1 red JPEG, encoded with Pillow (RGB, default JPEG settings).
const jpeg = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z",
  "base64",
);
const image = `data:image/jpeg;base64,${jpeg.toString("base64")}`;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "abridge-task-images-"));
  const dbPath = join(directory, "server.db");
  const server = await createServer({ dbPath, port: 0 });
  const receiver = await server.store.createUser("receiver", "fixture-password-123");
  const stranger = await server.store.createUser("stranger", "fixture-password-123");
  const { device } = server.store.createDevice(receiver.id, "Fixture phone", ["screen", "input"]);
  server.store.updateDeviceMetadata(device.id, device.credential_version, device.epoch, {
    platform: "android",
    version: "fixture",
  });
  const auth = (id: string) => ({
    host: "localhost",
    cookie: `abridge_session=${server.store.createLogin(id)}`,
  });
  const receiverHeaders = auth(receiver.id);
  const strangerHeaders = auth(stranger.id);
  const adminHeaders = { host: "localhost", authorization: `Bearer ${server.adminToken}` };
  const start = (admin = false) => {
    const task = server.store.tasks.create(admin ? server.store.instanceAdminActor() : receiver.id, {
      request_id: admin ? "admin" : "private",
      prompt: "Read the fixture clock",
      recipient_id: receiver.id,
      device_id: device.id,
    });
    const claim = server.store.tasks.claim(() => true);
    assert.equal(claim?.id, task.id);
    assert.ok(claim);
    return claim;
  };
  return {
    server,
    dbPath,
    start,
    receiverHeaders,
    strangerHeaders,
    adminHeaders,
    close: async () => {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("task screenshots archive beyond eight events, expose references and enforce image privacy", async () => {
  const f = await fixture();
  try {
    const task = f.start();
    for (let sequence = 1; sequence <= 12; sequence++) {
      f.server.store.tasks.event(task.id, task.lease_token, {
        sequence,
        status: "running",
        summary: `Screenshot ${sequence}`,
        image,
      });
    }
    const imageDirectory = join(f.dbPath + ".task-images", task.id);
    const names = await readdir(imageDirectory);
    assert.equal(names.length, 12);
    assert.ok(names.every((name) => /^[a-f0-9]{32}\.jpg$/.test(name)));
    for (const name of names) assert.deepEqual(await readFile(join(imageDirectory, name)), jpeg);
    f.server.store.tasks.event(task.id, task.lease_token, {
      sequence: 1,
      status: "running",
      summary: "Duplicate delivery",
      image,
    });
    assert.deepEqual(await readdir(imageDirectory), names);
    const db = new DatabaseSync(f.dbPath);
    try {
      const rows = db
        .prepare("SELECT payload FROM task_events WHERE task_id=? ORDER BY sequence")
        .all(task.id);
      assert.equal(rows.length, 12);
      for (const row of rows) {
        assert.equal(typeof row.payload, "string");
        const payload = JSON.parse(row.payload as string) as { image_ref: string; image?: string };
        assert.match(payload.image_ref, new RegExp(`^${task.id}/[a-f0-9]{32}\\.jpg$`));
        assert.equal(payload.image, undefined);
        assert.equal((row.payload as string).includes("base64"), false);
      }
    } finally {
      db.close();
    }
    const events = f.server.store.tasks.events(task.id);
    assert.equal(events.length, 12);
    assert.equal(events[0]!.summary, "Screenshot 1");
    const url = events[11]!.image!;
    assert.match(url, new RegExp(`^/api/tasks/${task.id}/images/[a-f0-9]{32}\\.jpg$`));
    const response = await f.server.app.inject({ url, headers: f.receiverHeaders });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["content-type"], "image/jpeg");
    assert.equal(response.headers["cache-control"], "private, no-store");
    assert.deepEqual(response.rawPayload, jpeg);
    for (const headers of [f.strangerHeaders, { host: "localhost" }]) {
      assert.equal((await f.server.app.inject({ url, headers })).statusCode, 401);
    }
    assert.equal((await f.server.app.inject({ url, headers: f.adminHeaders })).statusCode, 404);
    for (const name of ["%2e%2e%2fserver.db", "%2fetc%2fpasswd", "unknown.jpg"]) {
      const denied = await f.server.app.inject({
        url: `/api/tasks/${task.id}/images/${name}`,
        headers: f.receiverHeaders,
      });
      assert.equal(denied.statusCode, 404, denied.body);
    }
    f.server.store.tasks.finish(
      task.id,
      task.lease_token,
      { lease_token: task.lease_token, status: "done", cleanup_confirmed: true },
      true,
    );
    const adminTask = f.start(true);
    f.server.store.tasks.event(adminTask.id, adminTask.lease_token, {
      sequence: 1,
      status: "running",
      image,
    });
    const adminUrl = f.server.store.tasks.events(adminTask.id)[0]!.image!;
    for (const headers of [f.adminHeaders, f.receiverHeaders]) {
      const result = await f.server.app.inject({ url: adminUrl, headers });
      assert.equal(result.statusCode, 200, result.body);
      assert.deepEqual(result.rawPayload, jpeg);
    }
    assert.equal((await f.server.app.inject({ url: adminUrl, headers: f.strangerHeaders })).statusCode, 401);
  } finally {
    await f.close();
  }
});

test("invalid thumbnails and unavailable image storage preserve task event receipts", async () => {
  const f = await fixture();
  try {
    const task = f.start();
    const oversized = Buffer.from(jpeg);
    const sof = oversized.indexOf(Buffer.from([0xff, 0xc0]));
    assert.ok(sof >= 0);
    oversized.writeUInt16BE(961, sof + 7);
    const invalid = [
      "data:image/jpeg;base64,bm90LWFuLWltYWdl",
      `data:image/jpeg;base64,${oversized.toString("base64")}`,
      `data:image/jpeg;base64,${jpeg.subarray(0, jpeg.length - 2).toString("base64")}`,
      "data:image/png;base64,aGVsbG8=",
    ];
    for (const [index, value] of invalid.entries()) {
      f.server.store.tasks.event(task.id, task.lease_token, {
        sequence: index + 1,
        status: "running",
        receipt: "Tool completed",
        image: value,
      });
    }
    // A file where the image root should be reliably causes ENOTDIR, even as root.
    await writeFile(f.dbPath + ".task-images", "storage unavailable");
    assert.doesNotThrow(() =>
      f.server.store.tasks.event(task.id, task.lease_token, {
        sequence: 5,
        status: "running",
        receipt: "Tool completed despite storage failure",
        image,
      }),
    );
    const events = f.server.store.tasks.events(task.id);
    assert.equal(events.length, 5);
    assert.ok(events.every((event) => event.image === undefined));
    assert.equal(events[4]!.receipt, "Tool completed despite storage failure");
    assert.equal(f.server.store.tasks.get(task.id).status, "running");
  } finally {
    await f.close();
  }
});
