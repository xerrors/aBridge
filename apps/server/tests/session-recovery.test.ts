import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionInfoSchema, type Capability } from "@abridge/protocol";
import { ControlService } from "../src/control.js";
import { Store } from "../src/store.js";
import { commandOutputPage, characterLength } from "../src/command-output.js";
import { BridgeError, type DeviceTransport, type JsonObject } from "../src/types.js";

async function fixture() {
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
  const { grant } = store.createGrant(owner.id, "Fixture agent", policy);
  const { grant: otherGrant } = store.createGrant(owner.id, "Another fixture agent", policy);
  const frames: JsonObject[] = [];
  const transport: DeviceTransport = {
    async send(frame) {
      frames.push(frame);
    },
    async close() {},
  };
  const hello = { capabilities: { screen: true, input: true, shell: true } };
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
    grant,
    otherGrant,
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

test("activity returns fresh leases for dispatch, completion, status and duplicate requests", async () => {
  const f = await fixture();
  try {
    const session = f.control.openSession(f.grant, f.device.id, ["screen"]);
    f.advance(100);
    const accepted = await f.control.execute(f.grant, session.id, "computer_apps", {}, "apps", false);
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
    const result = await f.control.waitOperation(f.grant, accepted.operation_id, 0);
    assert.equal(result.session?.lease_until, f.now + 300);
    assert.equal(result.session?.server_time, f.now);
    f.advance(100);
    const duplicate = await f.control.execute(f.grant, session.id, "computer_apps", {}, "apps", false);
    assert.equal(duplicate.operation_id, accepted.operation_id);
    assert.equal(duplicate.session?.lease_until, f.now + 300);
    f.advance(10);
    const returnedId = await f.control.execute(
      f.grant,
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

test("discovery and input occupancy expose only this grant's sessions without renewing or taking over", async () => {
  const f = await fixture();
  try {
    const session = f.control.openSession(f.grant, f.device.id, ["screen", "input"]);
    assert.match(session.id, /^ses_[A-Za-z0-9_-]{8}$/);
    f.advance(60);
    const own = f.control.devices(f.grant)[0];
    assert.deepEqual(
      (own.sessions as unknown[]).map((value) => sessionInfoSchema.parse(value).id),
      [session.id],
    );
    assert.deepEqual(f.control.devices(f.otherGrant)[0].sessions, []);
    assert.equal(f.store.session(session.id)?.lease_until, session.lease_until);
    assert.throws(
      () => f.control.openSession(f.grant, f.device.id, ["input"]),
      (error) => {
        assert.ok(error instanceof BridgeError);
        assert.equal(error.code, "desktop_busy");
        assert.equal(error.details.sessions?.[0].id, session.id);
        return true;
      },
    );
    assert.throws(
      () => f.control.openSession(f.otherGrant, f.device.id, ["input"]),
      (error) => {
        assert.ok(error instanceof BridgeError);
        assert.deepEqual(error.details.sessions, []);
        return true;
      },
    );
    assert.equal(f.store.session(session.id)?.status, "active");
    await f.control.closeSession(f.grant, session.id);
    assert.equal(f.control.openSession(f.grant, f.device.id, ["input"]).status, "active");
  } finally {
    await f.close();
  }
});

test("unauthorized requests do not renew and retained results never revive stopped or expired sessions", async () => {
  const f = await fixture();
  try {
    const session = f.control.openSession(f.grant, f.device.id, ["screen"]);
    const operation = await f.control.execute(f.grant, session.id, "computer_apps", {}, "apps", false);
    await f.complete(operation.operation_id);
    const lease = f.store.session(session.id)!.lease_until;
    f.advance(50);
    assert.throws(() => f.control.operationStatus(f.otherGrant, operation.operation_id), {
      code: "not_found",
    });
    await assert.rejects(
      f.control.execute(f.grant, session.id, "computer_apps", { query: "changed" }, "apps", false),
      { code: "operation_conflict" },
    );
    assert.equal(f.store.session(session.id)?.lease_until, lease);
    await f.control.closeSession(f.grant, session.id);
    f.advance(50);
    const stopped = f.control.operationStatus(f.grant, operation.operation_id);
    assert.equal(stopped.status, "executed");
    assert.equal(stopped.session?.status, "stopped");
    assert.equal(stopped.session?.lease_until, lease);
    const idle = f.control.openSession(f.grant, f.device.id, ["screen"]);
    const idleOperation = await f.control.execute(f.grant, idle.id, "computer_apps", {}, "idle", false);
    await f.complete(idleOperation.operation_id);
    f.advance(301);
    const expired = f.control.operationStatus(f.grant, idleOperation.operation_id);
    assert.equal(expired.session?.status, "expired");
    assert.equal(expired.session?.lease_until, idle.lease_until);
    await assert.rejects(f.control.execute(f.grant, idle.id, "computer_apps", {}, "new", false), {
      code: "session_expired",
    });
  } finally {
    await f.close();
  }
});

test("renewal cannot exceed grant expiry, including a late completion", async () => {
  const f = await fixture();
  try {
    const expires = f.now + 100;
    const grant = await f.control.updateGrant(f.grant, f.grant.name, f.grant.policy, expires);
    const session = f.control.openSession(grant, f.device.id, ["screen"]);
    const operation = await f.control.execute(grant, session.id, "computer_apps", {}, "apps", false);
    f.advance(60);
    assert.equal(f.control.operationStatus(grant, operation.operation_id).session?.lease_until, expires);
    f.advance(41);
    await f.complete(operation.operation_id);
    assert.equal(f.store.session(session.id)?.lease_until, expires);
    assert.throws(() => f.control.operationStatus(grant, operation.operation_id), { code: "unauthorized" });
  } finally {
    await f.close();
  }
});

test("request keys are session scoped while returned operation IDs survive restart without replay", async () => {
  const f = await fixture();
  try {
    const first = f.control.openSession(f.grant, f.device.id, ["screen"]);
    const second = f.control.openSession(f.grant, f.device.id, ["screen"]);
    const other = f.control.openSession(f.otherGrant, f.device.id, ["screen"]);
    const a = await f.control.execute(f.grant, first.id, "computer_apps", {}, "apps", false);
    const b = await f.control.execute(f.grant, second.id, "computer_apps", {}, "apps", false);
    const c = await f.control.execute(f.otherGrant, other.id, "computer_apps", {}, "apps", false);
    assert.equal(new Set([a.operation_id, b.operation_id, c.operation_id]).size, 3);
    assert.notEqual(a.operation_id, "apps");
    await assert.rejects(f.control.execute(f.grant, second.id, "computer_apps", {}, a.operation_id, false), {
      code: "operation_conflict",
    });
    await assert.rejects(
      f.control.execute(f.otherGrant, other.id, "computer_apps", {}, a.operation_id, false),
      { code: "not_found" },
    );
    await f.complete(a.operation_id);
    await f.restart();
    const before = f.frames.filter((frame) => frame.type === "dispatch").length;
    const retained = f.control.operationStatus(f.grant, a.operation_id);
    assert.equal(retained.status, "executed");
    assert.equal(retained.result_available, false);
    assert.equal(retained.session?.status, "server_restarted");
    assert.equal(f.control.operationStatus(f.grant, b.operation_id).status, "outcome_unknown");
    const fresh = f.control.openSession(f.grant, f.device.id, ["screen"]);
    await assert.rejects(f.control.execute(f.grant, fresh.id, "computer_apps", {}, a.operation_id, false), {
      code: "operation_conflict",
    });
    assert.equal(f.frames.filter((frame) => frame.type === "dispatch").length, before);
  } finally {
    await f.close();
  }
});

test("diagnostics preserve desktop causes and heartbeat expiry; session metadata fits minimum output pages", async () => {
  const f = await fixture();
  try {
    const session = f.control.openSession(f.grant, f.device.id, ["screen", "shell"]);
    const operation = await f.control.execute(f.grant, session.id, "computer_apps", {}, "apps", false);
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
      f.control.operationStatus(f.grant, operation.operation_id).error?.cause?.code,
      "execution_timeout",
    );
    const shell = await f.control.execute(
      f.grant,
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
    const page = commandOutputPage(f.control.operationStatus(f.grant, shell.operation_id), 1024);
    assert.ok(characterLength(JSON.stringify(page)) <= 1024);
    assert.ok((page.result as { stdout: string }).stdout.length > 0);
    assert.equal(sessionInfoSchema.parse(page.session).id, session.id);
    const pending = await f.control.execute(f.grant, session.id, "computer_apps", {}, "pending", false);
    f.ageHeartbeat(31);
    await f.control.tick();
    const lost = f.control.operationStatus(f.grant, pending.operation_id);
    assert.equal(lost.status, "outcome_unknown");
    assert.equal(lost.error?.connection?.reason, "heartbeat_expired");
    assert.equal(lost.error?.connection?.close_code, 4408);
    assert.equal(lost.error?.connection?.heartbeat_age_seconds, 31);
    assert.equal(lost.session?.status, "connection_lost");
    assert.equal(
      (f.control.devices(f.grant)[0].last_disconnect as { reason: string }).reason,
      "heartbeat_expired",
    );
  } finally {
    await f.close();
  }
});
