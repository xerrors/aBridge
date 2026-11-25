import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { taskDetailSchema, taskViewSchema } from "@abridge/protocol";
import { createServer } from "../src/server.js";
import type { DeviceConnection, JsonObject } from "../src/types.js";

test("Android task handoff waits for the receiver's previous session cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "abridge-tasks-"));
  const key = "test-worker-key-not-for-production";
  const server = await createServer({ dbPath: join(directory, "server.db"), taskWorkerKey: key, port: 0 });
  try {
    const password = "test-password-only";
    const [sender, receiver, other] = await Promise.all(
      ["Sender", "Receiver", "Other"].map((username) => server.store.createUser(username, password)),
    );
    const auth = (id: string) => ({
      host: "localhost",
      cookie: "abridge_session=" + server.store.createLogin(id),
    });
    const senderHeaders = auth(sender!.id),
      receiverHeaders = auth(receiver!.id),
      otherHeaders = auth(other!.id);
    const workerHeaders = { host: "localhost", authorization: "Bearer " + key };
    const adminHeaders = { host: "localhost", authorization: "Bearer " + server.adminToken };
    let pendingAck: { id: string; resolve: (request: JsonObject) => void } | undefined;
    const nextAck = (id: string) =>
      new Promise<JsonObject>((resolve) => {
        pendingAck = { id, resolve };
      });
    const connect = async (owner: string, name: string) => {
      const { device, key: deviceKey } = server.store.createDevice(owner, name, ["screen", "input"]);
      const ticket: DeviceConnection = await server.control.attachConnection(
        deviceKey,
        "computer",
        {
          platform: "android",
          version: "fixture",
          task_session_ack: true,
          capabilities: { screen: true, input: true },
        },
        {
          send: async (frame) => {
            if (
              frame.type === "session_close" &&
              frame.acknowledge === true &&
              pendingAck?.id === frame.session_id
            )
              pendingAck!.resolve(frame);
          },
          close: async () => {},
        },
      );
      return { device, ticket };
    };
    const phone = await connect(receiver!.id, "Phone");
    const tablet = await connect(receiver!.id, "Tablet");
    const otherPhone = await connect(other!.id, "Other phone");
    const post = (url: string, headers: Record<string, string>, payload: Record<string, unknown> = {}) =>
      server.app.inject({ method: "POST", url, headers, payload });
    const submit = async (
      requestId: string,
      deviceId: string,
      recipientId: string,
      headers: Record<string, string>,
    ) => {
      const res = await post("/api/tasks", headers, {
        request_id: requestId,
        device_id: deviceId,
        recipient_id: recipientId,
        prompt: "Read the fixture clock",
      });
      assert.equal(res.statusCode, 201, res.body);
      return taskViewSchema.parse(res.json().task);
    };

    const first = await submit("first", phone.device.id, receiver!.id, senderHeaders);
    const second = await submit("second", tablet.device.id, receiver!.id, receiverHeaders);
    const claim = async () => {
      const res = await post("/api/task-worker/claim", workerHeaders);
      assert.equal(res.statusCode, 200, res.body);
      return res.json<{
        task: null | { id: string; device_id: string; lease_token: string; agent_key: string };
      }>().task;
    };
    assert.equal(first.status, "approval");
    // Approval determines arrival in the queue. The tablet is already queued.
    assert.equal(
      (await post(`/api/tasks/${first.id}/decision`, senderHeaders, { approve: true })).statusCode,
      404,
    );
    assert.equal(
      (await post(`/api/tasks/${first.id}/decision`, receiverHeaders, { approve: true })).statusCode,
      200,
    );
    assert.equal((await submit("first", phone.device.id, receiver!.id, senderHeaders)).id, first.id);

    const firstClaim = await claim();
    assert.equal(firstClaim?.id, second.id);
    const connection = server.store.authenticateAgent(firstClaim!.agent_key)!;
    await assert.rejects(server.control.openSession(connection, phone.device.id, ["input"]), {
      code: "not_found",
    });
    const session = await server.control.openSession(connection, tablet.device.id, ["screen", "input"]);
    const direct = server.store.createAgentConnection(receiver!.id, "Unrelated MCP", {
      mode: "selected",
      devices: [{ device_id: phone.device.id, capabilities: ["input"] }],
    }).agentConnection;
    await assert.rejects(server.control.openSession(direct, phone.device.id, ["input"]), {
      code: "recipient_busy",
    });

    const parallel = await submit("parallel", otherPhone.device.id, other!.id, otherHeaders);
    assert.equal((await claim())?.id, parallel.id);
    assert.equal(await claim(), null);
    assert.equal((await post(`/api/tasks/${second.id}/stop`, senderHeaders)).statusCode, 404);
    assert.equal(
      (await post(`/api/tasks/${second.id}/stop`, receiverHeaders)).json().task.status,
      "stopping",
    );
    await assert.rejects(server.control.openSession(connection, tablet.device.id, ["input"]), {
      code: "task_stopped",
    });
    assert.deepEqual(
      (
        await post(`/api/task-worker/${second.id}/heartbeat`, workerHeaders, {
          lease_token: firstClaim!.lease_token,
        })
      ).json(),
      { stop: true },
    );

    const ack = nextAck(session.id);
    const closing = server.control.closeSession(connection, session.id);
    await ack;
    const response = await post(`/api/task-worker/${second.id}/finish`, workerHeaders, {
      lease_token: firstClaim!.lease_token,
      status: "stopped",
      cleanup_confirmed: true,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(await claim(), null);
    const blocked = taskDetailSchema.parse(
      (
        await server.app.inject({
          url: `/api/admin/tasks/${second.id}`,
          headers: adminHeaders,
        })
      ).json(),
    );
    assert.equal(blocked.task.status, "unknown");
    assert.equal(blocked.task.queue_blocked, true);
    assert.equal(blocked.task.prompt, null);
    assert.equal(blocked.details_visible, false);

    await server.control.receive(tablet.ticket, {
      type: "session_closed",
      session_id: session.id,
      connection_epoch: tablet.ticket.epoch,
    });
    await closing;
    server.store.tasks.releaseAfterRecovery(second.id);
    assert.equal((await claim())?.id, first.id);
    assert.equal(server.store.authenticateAgent(firstClaim!.agent_key), undefined);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
