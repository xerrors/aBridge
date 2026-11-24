import { test } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionInfoSchema, type Capability } from "@abridge/protocol";
import { ControlService } from "../src/control.js";
import { Store } from "../src/store.js";
import { commandOutputPage, characterLength } from "../src/command-output.js";
import { BridgeError, type DeviceTransport, type JsonObject } from "../src/types.js";

async function fixture(platform?: string) {
  const directory = await mkdtemp(join(tmpdir(), "abridge-session-recovery-"));
  const path = join(directory, "server.db");
  let now = Date.now() / 1000;
  let monotonic = 0;
  let store = new Store(path);
  let control = new ControlService(
    store,
    () => now,
    () => monotonic,
  );
  const owner = await store.createUser("fixture-owner", "synthetic-owner-password");
  const capabilities: Capability[] = ["screen", "input", "shell"];
  const { device, key } = store.createDevice(owner.id, "Fixture computer", capabilities);
  const policy = { mode: "selected" as const, devices: [{ device_id: device.id, capabilities }] };
  const { agentConnection } = store.createAgentConnection(owner.id, "Fixture agent", policy);
  const { agentConnection: otherAgentConnection } = store.createAgentConnection(
    owner.id,
    "Another fixture agent",
    policy,
  );
  const frames: JsonObject[] = [];
  const transport: DeviceTransport = {
    async send(frame) {
      frames.push(frame);
    },
    async close() {},
  };
  const hello = { platform, capabilities: { screen: true, input: true, shell: true } };
  let ticket = await control.attachConnection(key, "computer", hello, transport);
  return {
    get store() {
      return store;
    },
    get control() {
      return control;
    },
    get now() {
      return now;
    },
    get ticket() {
      return ticket;
    },
    device,
    agentConnection,
    otherAgentConnection,
    frames,
    advance(seconds: number) {
      now += seconds;
    },
    ageHeartbeat(seconds: number) {
      monotonic += seconds;
    },
    async complete(id: string, result: JsonObject = { apps: [] }) {
      await control.receive(ticket, {
        type: "result",
        operation_id: id,
        connection_epoch: ticket.epoch,
        status: "executed",
        result,
      });
    },
    async restart() {
      await control.shutdown();
      store.close();
      store = new Store(path);
      store.recoverAfterRestart();
      control = new ControlService(
        store,
        () => now,
        () => monotonic,
      );
      ticket = await control.attachConnection(key, "computer", hello, transport);
    },
    async close() {
      await control.shutdown();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("Android tool discovery, dispatch and recovery agree with the device profile", async () => {
  const f = await fixture("android");
  try {
    const device = f.control.authorizedDevice(f.agentConnection, f.device.id);
    assert.deepEqual(f.control.deviceView(device, f.agentConnection).available_tools, [
      "computer_observe",
      "computer_act",
    ]);
    const session = await f.control.openSession(f.agentConnection, device.id, ["screen", "input"]);
    const before = f.frames.length;
    await assert.rejects(f.control.execute(f.agentConnection, session.id, "computer_apps", {}), {
      code: "unsupported_tool",
      details: { recovery: { action: "select_supported_tool" } },
    });
    assert.equal(f.frames.length, before);

    for (const [status, code, recovery] of [
      ["refused", "stale_observation", "observe_again"],
      ["refused", "protected_surface", "user_handoff"],
      ["outcome_unknown", "stale_observation", undefined],
    ] as const) {
      const operation = await f.control.execute(
        f.agentConnection,
        session.id,
        "computer_act",
        { observation_id: "obs_12345678", action: { type: "key", key: "home" } },
        undefined,
        false,
      );
      await f.control.receive(f.ticket, {
        type: "result",
        operation_id: operation.operation_id,
        connection_epoch: f.ticket.epoch,
        status,
        error: { code, message: "Synthetic device result" },
      });
      assert.equal(
        f.control.operationStatus(f.agentConnection, operation.operation_id).error?.recovery?.action,
        recovery,
      );
    }
  } finally {
    await f.close();
  }
});

test("activity returns fresh leases for dispatch, completion, status and duplicate requests", async () => {
  const f = await fixture();
  try {
    const session = await f.control.openSession(f.agentConnection, f.device.id, ["screen"]);
    f.advance(100);
    const accepted = await f.control.execute(
      f.agentConnection,
      session.id,
      "computer_apps",
      {},
      "apps",
      false,
    );
    assert.equal(accepted.session?.lease_until, f.now + 300);
    f.advance(310);
    await f.control.tick();
    assert.equal(f.store.session(session.id)?.lease_until, f.now + 300, "In-flight work retains its lease");
    f.advance(20);
    await f.complete(accepted.operation_id);
    assert.equal(
      f.store.session(session.id)?.lease_until,
      f.now + 300,
      "Completion starts the idle interval",
    );
    f.advance(100);
    const result = await f.control.waitOperation(f.agentConnection, accepted.operation_id, 0);
    assert.equal(result.session?.lease_until, f.now + 300);
    assert.equal(result.session?.server_time, f.now);
    f.advance(100);
    const duplicate = await f.control.execute(
      f.agentConnection,
      session.id,
      "computer_apps",
      {},
      "apps",
      false,
    );
    assert.equal(duplicate.operation_id, accepted.operation_id);
    assert.equal(duplicate.session?.lease_until, f.now + 300);
    f.advance(10);
    const returnedId = await f.control.execute(
      f.agentConnection,
      session.id,
      "computer_apps",
      {},
      accepted.operation_id,
      false,
    );
    assert.equal(returnedId.session?.lease_until, f.now + 300);
    assert.equal(f.frames.filter((frame) => frame.type === "dispatch").length, 1);
    assert.ok(
      accepted.session!.lease_until < result.session!.lease_until,
      "Earlier response snapshots remain unchanged",
    );
  } finally {
    await f.close();
  }
});

test("session closure supersedes caller cancellation before a late action receipt", async () => {
  const f = await fixture();
  try {
    const session = await f.control.openSession(f.agentConnection, f.device.id, ["screen", "input"]);
    const action = await f.control.execute(
      f.agentConnection,
      session.id,
      "computer_act",
      { observation_id: "obs_fixture1", action: { type: "click", element_ref: "e1" } },
      undefined,
      false,
    );
    const cancel = () => f.control.cancelOperation(f.agentConnection, action.operation_id);
    const whileActive = cancel();
    await f.control.closeSession(f.agentConnection, session.id);
    const afterClose = cancel();
    const cancellations = f.frames.filter((frame) => frame.type === "cancel");
    assert.deepEqual(
      cancellations.map((frame) => frame.caller_operation_id),
      [action.operation_id, undefined, undefined],
    );
    await f.complete(action.operation_id, { action_executed: true, summary: "private content" });
    for (const receipt of await Promise.all([whileActive, afterClose])) {
      assert.equal(receipt.status, "outcome_unknown");
      assert.equal(receipt.error?.code, "operation_cancelled");
      assert.equal(receipt.result, undefined);
    }
  } finally {
    await f.close();
  }
});

test("a result deadline fails desktop reads in place and keeps unconfirmed writes unknown", async (t) => {
  const f = await fixture();
  try {
    const session = await f.control.openSession(f.agentConnection, f.device.id, ["screen", "input"]);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const missing = [
      f.control.execute(f.agentConnection, session.id, "computer_apps", {}),
      f.control.execute(f.agentConnection, session.id, "computer_windows", { pid: 10 }),
      f.control.execute(f.agentConnection, session.id, "computer_observe", { desktop: true }),
      f.control.execute(f.agentConnection, session.id, "computer_open", { bundle_id: "org.example.Fixture" }),
    ];
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(30_000);
    const receipts = await Promise.all(missing);
    assert.deepEqual(
      receipts.map((result) => result.status),
      ["failed", "failed", "failed", "outcome_unknown"],
    );
    assert.ok(
      receipts.every(
        (result) => result.error?.code === "result_timeout" && result.session?.status === "active",
      ),
    );
    assert.deepEqual(
      f.frames.filter((frame) => frame.type === "cancel").map((frame) => frame.operation_ids),
      receipts.map((result) => [result.operation_id]),
    );
    for (const receipt of receipts) {
      await f.complete(receipt.operation_id);
      assert.equal(f.control.operationStatus(f.agentConnection, receipt.operation_id).status, receipt.status);
    }
    const refresh = await f.control.execute(
      f.agentConnection,
      session.id,
      "computer_observe",
      { desktop: true },
      undefined,
      false,
    );
    await f.complete(refresh.operation_id, { observation_id: "obs_fixture1" });
    assert.equal(f.control.operationStatus(f.agentConnection, refresh.operation_id).status, "executed");
    const write = receipts[3]!;
    const replay = await f.control.execute(
      f.agentConnection,
      session.id,
      "computer_open",
      { bundle_id: "org.example.Fixture" },
      write.operation_id,
    );
    assert.equal(replay.status, "outcome_unknown");
    assert.equal(
      f.frames.filter((frame) => frame.type === "dispatch" && frame.operation_id === write.operation_id)
        .length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("discovery and input occupancy expose only this Agent connection's sessions without renewing or taking over", async () => {
  const f = await fixture();
  try {
    const session = await f.control.openSession(f.agentConnection, f.device.id, ["screen", "input"]);
    assert.match(session.id, /^ses_[A-Za-z0-9_-]{8}$/);
    f.advance(60);
    const own = f.control.devices(f.agentConnection)[0];
    assert.deepEqual(
      (own.sessions as unknown[]).map((value) => sessionInfoSchema.parse(value).id),
      [session.id],
    );
    assert.deepEqual(f.control.devices(f.otherAgentConnection)[0].sessions, []);
    assert.equal(f.store.session(session.id)?.lease_until, session.lease_until);
    await assert.rejects(
      () => f.control.openSession(f.agentConnection, f.device.id, ["input"]),
      (error) => {
        assert.ok(error instanceof BridgeError);
        assert.equal(error.code, "desktop_busy");
        assert.equal(error.details.sessions?.[0].id, session.id);
        return true;
      },
    );
    await assert.rejects(
      () => f.control.openSession(f.otherAgentConnection, f.device.id, ["input"]),
      (error) => {
        assert.ok(error instanceof BridgeError);
        assert.deepEqual(error.details.sessions, []);
        return true;
      },
    );
    assert.equal(f.store.session(session.id)?.status, "active");
    await f.control.closeSession(f.agentConnection, session.id);
    assert.equal((await f.control.openSession(f.agentConnection, f.device.id, ["input"])).status, "active");
  } finally {
    await f.close();
  }
});

test("unauthorized requests do not renew and retained results never revive stopped or expired sessions", async () => {
  const f = await fixture();
  try {
    const session = await f.control.openSession(f.agentConnection, f.device.id, ["screen"]);
    const operation = await f.control.execute(
      f.agentConnection,
      session.id,
      "computer_apps",
      {},
      "apps",
      false,
    );
    await f.complete(operation.operation_id);
    const lease = f.store.session(session.id)!.lease_until;
    f.advance(50);
    assert.throws(() => f.control.operationStatus(f.otherAgentConnection, operation.operation_id), {
      code: "not_found",
    });
    await assert.rejects(
      f.control.execute(f.agentConnection, session.id, "computer_apps", { query: "changed" }, "apps", false),
      { code: "operation_conflict" },
    );
    assert.equal(f.store.session(session.id)?.lease_until, lease);
    await f.control.closeSession(f.agentConnection, session.id);
    f.advance(50);
    const stopped = f.control.operationStatus(f.agentConnection, operation.operation_id);
    assert.equal(stopped.status, "executed");
    assert.equal(stopped.session?.status, "stopped");
    assert.equal(stopped.session?.lease_until, lease);
    const idle = await f.control.openSession(f.agentConnection, f.device.id, ["screen"]);
    const idleOperation = await f.control.execute(
      f.agentConnection,
      idle.id,
      "computer_apps",
      {},
      "idle",
      false,
    );
    await f.complete(idleOperation.operation_id);
    f.advance(301);
    const expired = f.control.operationStatus(f.agentConnection, idleOperation.operation_id);
    assert.equal(expired.session?.status, "expired");
    assert.equal(expired.session?.lease_until, idle.lease_until);
    await assert.rejects(f.control.execute(f.agentConnection, idle.id, "computer_apps", {}, "new", false), {
      code: "session_expired",
    });
  } finally {
    await f.close();
  }
});

test("renewal cannot exceed Agent connection expiry, including a late completion", async () => {
  const f = await fixture();
  try {
    const expires = f.now + 100;
    const agentConnection = await f.control.updateAgentConnection(
      f.agentConnection,
      f.agentConnection.name,
      f.agentConnection.policy,
      expires,
    );
    const session = await f.control.openSession(agentConnection, f.device.id, ["screen"]);
    const operation = await f.control.execute(
      agentConnection,
      session.id,
      "computer_apps",
      {},
      "apps",
      false,
    );
    f.advance(60);
    assert.equal(
      f.control.operationStatus(agentConnection, operation.operation_id).session?.lease_until,
      expires,
    );
    f.advance(41);
    await f.complete(operation.operation_id);
    assert.equal(f.store.session(session.id)?.lease_until, expires);
    assert.throws(() => f.control.operationStatus(agentConnection, operation.operation_id), {
      code: "unauthorized",
    });
  } finally {
    await f.close();
  }
});

test("request keys are session scoped while returned operation IDs survive restart without replay", async () => {
  const f = await fixture();
  try {
    const first = await f.control.openSession(f.agentConnection, f.device.id, ["screen"]);
    const second = await f.control.openSession(f.agentConnection, f.device.id, ["screen"]);
    const other = await f.control.openSession(f.otherAgentConnection, f.device.id, ["screen"]);
    const a = await f.control.execute(f.agentConnection, first.id, "computer_apps", {}, "apps", false);
    const b = await f.control.execute(f.agentConnection, second.id, "computer_apps", {}, "apps", false);
    const c = await f.control.execute(f.otherAgentConnection, other.id, "computer_apps", {}, "apps", false);
    assert.equal(new Set([a.operation_id, b.operation_id, c.operation_id]).size, 3);
    for (const result of [a, b, c]) assert.match(result.operation_id, /^op_[A-Za-z0-9_-]{8}$/);
    assert.notEqual(a.operation_id, "apps");
    await assert.rejects(
      f.control.execute(f.agentConnection, second.id, "computer_apps", {}, a.operation_id, false),
      {
        code: "operation_conflict",
      },
    );
    await assert.rejects(
      f.control.execute(f.otherAgentConnection, other.id, "computer_apps", {}, a.operation_id, false),
      { code: "not_found" },
    );
    await f.complete(a.operation_id);
    await f.restart();
    const before = f.frames.filter((frame) => frame.type === "dispatch").length;
    const retained = f.control.operationStatus(f.agentConnection, a.operation_id);
    assert.equal(retained.status, "executed");
    assert.equal(retained.result_available, false);
    assert.equal(retained.session?.status, "server_restarted");
    assert.equal(f.control.operationStatus(f.agentConnection, b.operation_id).status, "outcome_unknown");
    const fresh = await f.control.openSession(f.agentConnection, f.device.id, ["screen"]);
    await assert.rejects(
      f.control.execute(f.agentConnection, fresh.id, "computer_apps", {}, a.operation_id, false),
      {
        code: "operation_conflict",
      },
    );
    assert.equal(f.frames.filter((frame) => frame.type === "dispatch").length, before);
  } finally {
    await f.close();
  }
});

test("device receipts cannot supply server-owned disconnect diagnostics", async () => {
  const f = await fixture();
  try {
    const session = await f.control.openSession(f.agentConnection, f.device.id, ["screen"]);
    const error = {
      code: "outcome_unknown",
      message: "Not confirmed",
      cause: { code: "execution_timeout", message: "Device execution deadline elapsed" },
    };
    for (const connection of [
      {
        reason: "heartbeat_expired",
        at: f.now,
        connection_epoch: f.ticket.epoch,
        heartbeat_age_seconds: 31,
        close_code: 4408,
      },
      { reason: "invalid fabricated reason", private_detail: "must not escape" },
    ]) {
      const operation = await f.control.execute(
        f.agentConnection,
        session.id,
        "computer_apps",
        {},
        undefined,
        false,
      );
      await f.control.receive(f.ticket, {
        type: "result",
        connection_epoch: f.ticket.epoch,
        operation_id: operation.operation_id,
        status: "outcome_unknown",
        error: { ...error, connection },
      });
      assert.deepEqual(f.control.operationStatus(f.agentConnection, operation.operation_id).error, error);
      const device = f.control.devices(f.agentConnection)[0];
      assert.equal(device.status, "online");
      assert.equal(device.last_disconnect, undefined);
    }
  } finally {
    await f.close();
  }
});

test("diagnostics preserve desktop causes and heartbeat expiry; session metadata fits minimum output pages", async () => {
  const f = await fixture();
  try {
    const session = await f.control.openSession(f.agentConnection, f.device.id, ["screen", "shell"]);
    const operation = await f.control.execute(
      f.agentConnection,
      session.id,
      "computer_apps",
      {},
      "apps",
      false,
    );
    await f.control.receive(f.ticket, {
      type: "result",
      connection_epoch: f.ticket.epoch,
      operation_id: operation.operation_id,
      status: "outcome_unknown",
      error: {
        code: "outcome_unknown",
        message: "Not confirmed",
        cause: { code: "execution_timeout", message: "Device execution deadline elapsed" },
      },
    });
    assert.equal(
      f.control.operationStatus(f.agentConnection, operation.operation_id).error?.cause?.code,
      "execution_timeout",
    );
    const shell = await f.control.execute(
      f.agentConnection,
      session.id,
      "command_execute",
      { command: "fixture-only" },
      "shell",
      false,
    );
    await f.complete(shell.operation_id, {
      stdout: "fixture output ".repeat(300),
      stderr: "",
      exit_code: 0,
      truncated: false,
    });
    const page = commandOutputPage(f.control.operationStatus(f.agentConnection, shell.operation_id), 1024);
    assert.ok(characterLength(JSON.stringify(page)) <= 1024);
    assert.ok((page.result as { stdout: string }).stdout.length > 0);
    assert.equal(sessionInfoSchema.parse(page.session).id, session.id);
    const pending = await f.control.execute(
      f.agentConnection,
      session.id,
      "computer_apps",
      {},
      "pending",
      false,
    );
    f.ageHeartbeat(31);
    await f.control.tick();
    const lost = f.control.operationStatus(f.agentConnection, pending.operation_id);
    assert.equal(lost.status, "outcome_unknown");
    assert.equal(lost.error?.connection?.reason, "heartbeat_expired");
    assert.equal(lost.error?.connection?.close_code, 4408);
    assert.equal(lost.error?.connection?.heartbeat_age_seconds, 31);
    assert.equal(lost.session?.status, "connection_lost");
    assert.equal(
      (f.control.devices(f.agentConnection)[0].last_disconnect as { reason: string }).reason,
      "heartbeat_expired",
    );
  } finally {
    await f.close();
  }
});

test("short operation IDs preserve distinct keys through collisions and restart", async () => {
  const f = await fixture();
  try {
    const session = await f.control.openSession(f.agentConnection, f.device.id, ["screen"]);
    const keyHash = createHash("sha256")
      .update(JSON.stringify([f.agentConnection.id, session.id, "retry-key"]))
      .digest("base64url");
    const occupied = "op_" + keyHash.slice(0, 8);
    const requestHash = createHash("sha256")
      .update(JSON.stringify({ arguments: {}, session_id: session.id, tool: "computer_apps" }))
      .digest("hex");
    // Force the short candidate to belong to a different key with the SAME payload.
    // Payload checks alone must never mistake this collision for a retry.
    f.store.createOperation({
      id: occupied,
      owner_id: f.agentConnection.owner_id,
      agent_connection_id: f.agentConnection.id,
      device_id: f.device.id,
      session_id: session.id,
      tool: "computer_apps",
      request_hash: requestHash,
      key_hash: createHash("sha256").update("another-scoped-key").digest("base64url"),
      epoch: f.ticket.epoch,
    });
    const result = await f.control.execute(
      f.agentConnection,
      session.id,
      "computer_apps",
      {},
      "retry-key",
      false,
    );
    assert.match(result.operation_id, /^op_[A-Za-z0-9_-]{8}$/);
    assert.notEqual(result.operation_id, occupied);
    assert.equal(f.store.operationForKey(keyHash)?.id, result.operation_id);
    assert.equal(f.store.operation(result.operation_id)?.request_hash, requestHash);
    const dispatches = () => f.frames.filter((frame) => frame.type === "dispatch").length;
    const before = dispatches();
    assert.equal(
      (await f.control.execute(f.agentConnection, session.id, "computer_apps", {}, "retry-key", false))
        .operation_id,
      result.operation_id,
    );
    assert.equal(
      (
        await f.control.execute(
          f.agentConnection,
          session.id,
          "computer_apps",
          {},
          result.operation_id,
          false,
        )
      ).operation_id,
      result.operation_id,
    );
    await assert.rejects(
      f.control.execute(
        f.agentConnection,
        session.id,
        "computer_apps",
        { query: "changed" },
        "retry-key",
        false,
      ),
      { code: "operation_conflict" },
    );
    assert.equal(dispatches(), before);
    await f.restart();
    assert.equal(f.store.operationForKey(keyHash)?.id, result.operation_id);
    assert.equal(f.control.operationStatus(f.agentConnection, result.operation_id).status, "outcome_unknown");
    await assert.rejects(
      f.control.execute(f.agentConnection, session.id, "computer_apps", {}, "retry-key", false),
      {
        code: "session_server_restarted",
      },
    );
    assert.equal(dispatches(), before, "restart never replays the unknown write");
  } finally {
    await f.close();
  }
});

test("generated operation IDs stay short and unknown returned-ID syntax cannot start work", async () => {
  const f = await fixture();
  try {
    const session = await f.control.openSession(f.agentConnection, f.device.id, ["screen"]);
    const generated = await f.control.execute(
      f.agentConnection,
      session.id,
      "computer_apps",
      {},
      undefined,
      false,
    );
    assert.match(generated.operation_id, /^op_[A-Za-z0-9_-]{8}$/);
    assert.equal(f.store.operation(generated.operation_id)?.key_hash, null);
    const before = f.frames.filter((frame) => frame.type === "dispatch").length;
    await assert.rejects(
      f.control.execute(f.agentConnection, session.id, "computer_apps", {}, "op_unknown_", false),
      {
        code: "invalid_operation_id",
      },
    );
    assert.equal(f.frames.filter((frame) => frame.type === "dispatch").length, before);
    assert.equal(
      (
        await f.control.execute(
          f.agentConnection,
          session.id,
          "computer_apps",
          {},
          generated.operation_id,
          false,
        )
      ).operation_id,
      generated.operation_id,
    );
  } finally {
    await f.close();
  }
});
