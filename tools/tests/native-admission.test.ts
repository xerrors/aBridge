import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, readFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer, type WebSocket } from "ws";
import { MAX_DEVICE_OPERATIONS } from "@abridge/protocol";
import { run } from "../lib/process.js";

type Value = Record<string, unknown>;
async function until(check: () => boolean | Promise<boolean>, message: string) {
  for (let i = 0; i < 1000; i++) {
    if (await check()) return;
    await delay(5);
  }
  assert.ok(await check(), message);
}
test(
  "native admissions preserve cancellation, idempotency and session boundaries",
  { skip: process.platform !== "darwin" || process.arch !== "arm64", timeout: 90000 },
  async (t) => {
    const work = await mkdtemp(join(tmpdir(), "abridge-native-admission-"));
    const root = resolve(import.meta.dirname, "../.."),
      runtime = join(root, "apps/desktop/native/runtime"),
      sdk = join(root, "node_modules/@trycua/cua-driver-darwin-arm64");
    try {
      await mkdir(join(work, "bin"));
      await mkdir(join(work, "Resources"));
      await copyFile(
        join(root, "dist/desktop/desktop-contract.json"),
        join(work, "Resources/desktop-contract.json"),
      );
      const executable = join(work, "bin/admission");
      await run("/usr/bin/swiftc", [
        "-swift-version",
        "6",
        "-parse-as-library",
        "-target",
        "arm64-apple-macos14.0",
        "-import-objc-header",
        join(runtime, "cua_driver_abi.h"),
        ...[
          "JSON",
          "Contract",
          "Storage",
          "LocalControl",
          "NativeDriver",
          "Computer",
          "Executor",
          "DeviceServerSession",
          "Client",
        ].map((name) => join(runtime, name + ".swift")),
        join(root, "tools/fixtures/native-admission.swift"),
        "-L",
        sdk,
        "-lcua_driver_sdk",
        "-Xlinker",
        "-rpath",
        "-Xlinker",
        sdk,
        "-o",
        executable,
      ]);
      async function fixture() {
        const directory = await mkdtemp(join(work, "state-"));
        const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
        await once(server, "listening");
        const address = server.address();
        assert.ok(address && typeof address === "object");
        let peer: WebSocket | undefined,
          sequence = 0;
        const messages: Value[] = [],
          events: Value[] = [];
        server.on("connection", (socket) => {
          peer = socket;
          socket.on("message", (data) => {
            const message = JSON.parse(data.toString()) as Value;
            messages.push(message);
            if (message.type === "hello")
              socket.send(
                JSON.stringify({
                  type: "welcome",
                  protocol: "abridge/1",
                  device_id: "fixture",
                  connection_epoch: 1,
                  capabilities: ["files", "screen", "input"],
                  owner_name: "Fixture",
                  lease_seconds: 30,
                  heartbeat_interval: 10,
                }),
              );
            if (message.type === "heartbeat")
              socket.send(JSON.stringify({ type: "heartbeat_ack", connection_epoch: 1 }));
          });
        });
        const child = spawn(executable, [directory, `http://127.0.0.1:${address.port}`], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });
        const exited = once(child, "exit");
        createInterface({ input: child.stdout }).on("line", (line) => events.push(JSON.parse(line) as Value));
        const command = (value: Value) => child.stdin.write(JSON.stringify(value) + "\n");
        const event = async (name: string, id: string) => {
          await until(() => events.some((e) => e.event === name && e.id === id), `${name}/${id}: ${stderr}`);
          return events.find((e) => e.event === name && e.id === id)!;
        };
        await until(() => messages.some((m) => m.type === "hello"), "Native hello: " + stderr);
        async function snapshot() {
          const id = crypto.randomUUID();
          command({ command: "snapshot", id });
          return (await event("snapshot", id)).result as Value;
        }
        for (let i = 0; i < 100; i++) {
          if ((await snapshot()).connection === "online") break;
          await delay(5);
        }
        assert.equal((await snapshot()).connection, "online");
        const send = (value: Value) => peer!.send(JSON.stringify({ connection_epoch: 1, ...value }));
        const path = (id: string) => join(directory, id + ".effect");
        const frame = (id: string, session = "session") => ({
          type: "dispatch",
          protocol: "abridge/1",
          device_id: "fixture",
          connection_epoch: 1,
          sequence: ++sequence,
          device_credential_version: 1,
          session_capabilities: ["files"],
          operation_id: id,
          session_id: session,
          tool: "file_write",
          arguments: { path: path(id), content: id },
          expires_at: Date.now() / 1000 + 30,
        });
        return {
          directory,
          messages,
          send,
          path,
          frame,
          events,
          event,
          snapshot,
          disconnect: () => peer!.terminate(),
          observe(id: string, target: Value = {}, session = "session") {
            send({
              ...frame(id, session),
              tool: "computer_observe",
              arguments: { ...target, screenshot: false },
              session_capabilities: ["screen"],
            });
          },
          clickFrame(id: string, observationId: unknown) {
            return {
              ...frame(id),
              tool: "computer_act",
              arguments: {
                observation_id: observationId,
                action: { type: "click", element_ref: "e1" },
                observe_after: false,
              },
              session_capabilities: ["input"],
            };
          },
          async fail(mode: string) {
            command({ command: "fail", id: mode });
            await event("failed", mode);
          },
          async simulateAction(id: string, confirm: boolean) {
            command({ command: "action", id, confirm });
            await event("armed", id);
          },
          async gate(id: string, observation = false, holdAfterCancel = false) {
            command({ command: "arm", id, observation, holdAfterCancel });
            await event("armed", id);
            return {
              entered: () => event("entered", id),
              release: async () => {
                command({ command: "release", id });
                await event("released", id);
              },
            };
          },
          async control(request: Value) {
            const id = crypto.randomUUID();
            command({ command: "control", request, id });
            const response = await event("control", id);
            assert.equal(response.error, undefined);
            return response.result as Value;
          },
          async barrier() {
            const name = crypto.randomUUID();
            send({ type: "heartbeat_ack", device_name: name });
            for (let i = 0; i < 100; i++) {
              if ((await snapshot()).device_name === name) return;
              await delay(5);
            }
            assert.fail("Control barrier was not processed");
          },
          async result(id: string, count = 1) {
            await until(
              () => messages.filter((m) => m.type === "result" && m.operation_id === id).length >= count,
              "Result " + id,
            );
            return messages.filter((m) => m.type === "result" && m.operation_id === id)[count - 1]!;
          },
          async close() {
            command({ command: "stop" });
            const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
            try {
              assert.equal((await exited)[0], 0, stderr);
            } finally {
              clearTimeout(timeout);
              for (const client of server.clients) client.terminate();
              await new Promise<void>((resolve) => server.close(() => resolve()));
            }
          },
        };
      }
      for (const control of [
        "cancel",
        "session_close",
        "stop",
        "local_pause",
        "local_stop",
        "capability",
      ] as const) {
        await t.test(control + " bypasses pending diagnostics without a late effect", async () => {
          const f = await fixture();
          try {
            const gate = await f.gate("gate");
            f.send(f.frame("pending"));
            await gate.entered();
            if (control === "local_pause" || control === "local_stop")
              await f.control({ command: control === "local_pause" ? "pause" : "stop" });
            else if (control === "capability")
              await f.control({ command: "capability", capability: "files", enabled: false });
            else f.send({ type: control, operation_ids: ["pending"], session_id: "session" });
            await f.barrier();
            await assert.rejects(access(f.path("pending")));
            await gate.release();
            assert.equal((await f.result("pending")).status, "refused");
            await assert.rejects(access(f.path("pending")));
            if (control === "cancel") {
              f.send(f.frame("next"));
              assert.equal((await f.result("next")).status, "executed");
              assert.equal(await readFile(f.path("next"), "utf8"), "next");
            }
          } finally {
            await f.close();
          }
        });
      }
      await t.test("session close affects only its pending admission", async () => {
        const f = await fixture();
        try {
          const first = await f.gate("first");
          f.send(f.frame("first", "session1"));
          await first.entered();
          const second = await f.gate("second");
          f.send(f.frame("second", "session2"));
          await second.entered();
          f.send({ type: "session_close", session_id: "session1" });
          await f.barrier();
          await first.release();
          await second.release();
          assert.equal((await f.result("first")).status, "refused");
          assert.equal((await f.result("second")).status, "executed");
          await assert.rejects(access(f.path("first")));
          assert.equal(await readFile(f.path("second"), "utf8"), "second");
        } finally {
          await f.close();
        }
      });
      await t.test("pending identity reserves deduplication and detects changed arguments", async () => {
        const f = await fixture();
        try {
          const gate = await f.gate("duplicate");
          const frame = f.frame("original");
          f.send(frame);
          await gate.entered();
          f.send(frame);
          assert.equal((await f.result("original")).status, "outcome_unknown");
          f.send({ ...frame, arguments: { ...frame.arguments, content: "changed" } });
          assert.equal(((await f.result("original", 2)).error as Value).code, "idempotency_conflict");
          await gate.release();
          assert.equal((await f.result("original", 3)).status, "executed");
          assert.equal(await readFile(f.path("original"), "utf8"), "original");
        } finally {
          await f.close();
        }
      });
      await t.test(
        "desktop read failures return redacted failure receipts and preserve explicit refusals",
        async () => {
          const f = await fixture();
          try {
            for (const { failure, tool, args, status, code } of [
              {
                failure: "driver_timeout",
                tool: "computer_apps",
                args: {},
                status: "failed",
                code: "driver_timeout",
              },
              {
                failure: "private_sdk_failure",
                tool: "computer_windows",
                args: { pid: 10 },
                status: "failed",
                code: "driver_error",
              },
              {
                failure: "generic",
                tool: "computer_observe",
                args: { pid: 10, window_id: 20, screenshot: false },
                status: "failed",
                code: "driver_error",
              },
              {
                failure: "permission_denied",
                tool: "computer_apps",
                args: {},
                status: "refused",
                code: "permission_denied",
              },
            ]) {
              await f.fail(failure);
              const frame = {
                ...f.frame(`read_${tool}_${status}`),
                tool,
                arguments: args,
                session_capabilities: ["screen"],
              };
              f.send(frame);
              const receipt = await f.result(frame.operation_id);
              assert.equal(receipt.status, status);
              assert.equal((receipt.error as Value).code, code);
              assert.equal(JSON.stringify(receipt).includes("private"), false);
              f.send(frame);
              const duplicate = await f.result(frame.operation_id, 2);
              assert.equal(duplicate.status, status);
              assert.equal((duplicate.error as Value).code, "duplicate_operation");
              assert.equal(
                f.events.filter((event) => event.event === "effect" && event.id === failure).length,
                1,
              );
            }
          } finally {
            await f.close();
          }
        },
      );
      await t.test(
        "cancelling an in-flight desktop read permits a refresh of the selected window",
        async () => {
          const f = await fixture();
          try {
            const target = { pid: 10, window_id: 20 };
            f.observe("initial", target);
            const initial = await f.result("initial");
            assert.equal(initial.status, "executed");
            const slowRead = await f.gate("slow_read", true);
            f.observe("slow");
            await slowRead.entered();
            f.send({ type: "cancel", operation_ids: ["slow"], reason: "Result deadline exceeded" });
            await f.barrier();
            f.send(f.clickFrame("stale", (initial.result as Value).observation_id));
            assert.equal(((await f.result("stale")).error as Value).code, "stale_observation");
            f.observe("refresh");
            const fresh = await f.result("refresh");
            assert.equal(fresh.status, "executed", JSON.stringify(fresh));
            assert.deepEqual((fresh.result as Value).window, target);
            assert.notEqual((fresh.result as Value).observation_id, (initial.result as Value).observation_id);
            const stopped = await f.result("slow");
            assert.equal(stopped.status, "cancelled");
            assert.equal((stopped.error as Value).code, "operation_cancelled");
            f.send({ type: "session_close", session_id: "session" });
            await f.barrier();
            f.observe("closed", target);
            assert.equal(((await f.result("closed")).error as Value).code, "session_closed");
            const revokedRead = await f.gate("revoked_read", true);
            f.observe("revoked", target, "other");
            await revokedRead.entered();
            await f.control({ command: "capability", capability: "screen", enabled: false });
            assert.equal((await f.result("revoked")).status, "cancelled");
            f.observe("disabled", target, "other");
            assert.equal(((await f.result("disabled")).error as Value).code, "capability_unavailable");
            await f.control({ command: "capability", capability: "screen", enabled: true });
            f.observe("ended", target, "other");
            assert.equal(((await f.result("ended")).error as Value).code, "session_closed");
          } finally {
            await f.close();
          }
        },
      );
      await t.test(
        "cancelling a queued read preserves the preceding observation and control traffic",
        async () => {
          const f = await fixture();
          try {
            const active = await f.gate("active", true);
            f.observe("active", { pid: 10, window_id: 20 });
            await active.entered();
            f.observe("queued", { pid: 10, window_id: 21 });
            await until(async () => (await f.snapshot()).active_operations === 2, "Both reads admitted");
            f.send({ type: "cancel", operation_ids: ["queued"] });
            await f.barrier();
            await active.release();
            assert.equal((await f.result("queued")).status, "cancelled");
            const previous = await f.result("active");
            assert.equal(previous.status, "executed");
            f.send(f.clickFrame("retained", (previous.result as Value).observation_id));
            assert.equal(((await f.result("retained")).error as Value).code, "fixture_forbidden");
          } finally {
            await f.close();
          }
        },
      );
      for (const interruption of [
        "caller",
        "unconfirmed",
        "grant",
        "caller_then_policy",
        "session_close",
        "pause",
        "capability",
        "disconnect",
      ] as const) {
        await t.test("confirmed action receipts during " + interruption, async () => {
          const f = await fixture();
          try {
            f.observe("before", { pid: 10, window_id: 20 });
            const observation = (await f.result("before")).result as Value;
            const click = f.clickFrame("click", observation.observation_id);
            const frame = {
              ...click,
              arguments: {
                ...click.arguments,
                observe_after: true,
                wait_after_ms: interruption === "caller_then_policy" ? 0 : 10000,
              },
              session_capabilities: ["input", "screen"],
            };
            const followUp =
              interruption === "caller_then_policy" ? await f.gate("follow_up", true, true) : undefined;
            await f.simulateAction("simulated", interruption !== "unconfirmed");
            f.send(frame);
            await f.event(interruption === "unconfirmed" ? "entered" : "delivered", "simulated");
            if (followUp) await followUp.entered();
            const cancel = { type: "cancel", operation_ids: ["click"] };
            switch (interruption) {
              case "caller":
              case "unconfirmed":
                f.send({ ...cancel, caller_operation_id: "click" });
                break;
              case "caller_then_policy":
                f.send({ ...cancel, caller_operation_id: "click" });
                await f.event("cancelling", "follow_up");
                f.send({ ...cancel, reason: "Connection permissions changed" });
                f.send({ ...cancel, caller_operation_id: "click" });
                await f.barrier();
                await followUp!.release();
                break;
              case "grant":
                f.send({ ...cancel, reason: "Connection permissions changed" });
                break;
              case "session_close":
                f.send({ type: "session_close", session_id: "session" });
                break;
              case "pause":
                await f.control({ command: "pause" });
                break;
              case "capability":
                await f.control({ command: "capability", capability: "screen", enabled: false });
                break;
              case "disconnect":
                f.disconnect();
                await until(
                  () => f.messages.filter((message) => message.type === "hello").length >= 2,
                  "Reconnected",
                );
                await f.barrier();
                assert.equal(
                  f.messages.some((message) => message.operation_id === "click"),
                  false,
                );
                assert.equal(
                  await run("/usr/bin/sqlite3", [
                    join(f.directory, "operations.sqlite3"),
                    "SELECT status FROM operations WHERE id='click'",
                  ]),
                  "outcome_unknown",
                );
                return;
            }
            const receipt = await f.result("click");
            if (interruption === "caller") {
              assert.equal(receipt.status, "executed");
              assert.deepEqual(receipt.result, {
                action_executed: true,
                business_verified: false,
                observation_error: {
                  code: "operation_cancelled",
                  message: "Action delivered; follow-up observation unavailable after cancellation",
                },
              });
            } else {
              assert.equal(receipt.status, "outcome_unknown");
              assert.deepEqual(receipt.result, {});
            }
            assert.equal(
              receipt.error && (receipt.error as Value).code,
              interruption === "caller" ? undefined : "operation_cancelled",
            );
            f.send(frame);
            const duplicate = await f.result("click", 2);
            assert.equal(duplicate.status, receipt.status);
            assert.equal((duplicate.error as Value).code, "duplicate_operation");
            assert.equal(
              f.events.filter((event) => event.event === "delivered").length,
              interruption === "unconfirmed" ? 0 : 1,
            );
          } finally {
            await f.close();
          }
        });
      }
      await t.test("unconfirmed input remains unknown and its identity never replays", async () => {
        const f = await fixture();
        try {
          f.observe("observe", { pid: 10, window_id: 20 });
          const observed = await f.result("observe");
          assert.equal(observed.status, "executed");
          const observationId = (observed.result as Value).observation_id;
          assert.equal(typeof observationId, "string");
          await f.fail("driver_timeout");
          const frame = f.clickFrame("input_timeout", observationId);
          f.send(frame);
          const receipt = await f.result(frame.operation_id);
          assert.equal(receipt.status, "outcome_unknown");
          const error = receipt.error as Value;
          assert.equal(error.code, "outcome_unknown");
          assert.equal((error.cause as Value).code, "execution_timeout");
          assert.equal(JSON.stringify(receipt).includes("private"), false);
          f.send(frame);
          const duplicate = await f.result(frame.operation_id, 2);
          assert.equal(duplicate.status, "outcome_unknown");
          assert.equal((duplicate.error as Value).code, "duplicate_operation");
          assert.equal(
            f.events.filter((event) => event.event === "effect" && event.id === "driver_timeout").length,
            1,
          );
        } finally {
          await f.close();
        }
      });
      await t.test("journal admission failure prevents side effects", async () => {
        const f = await fixture();
        try {
          await run("/usr/bin/sqlite3", [
            join(f.directory, "operations.sqlite3"),
            "CREATE TRIGGER fixture_fail_start BEFORE INSERT ON operations BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;",
          ]);
          f.send(f.frame("journal_start_failure"));
          await until(
            () => f.messages.filter((message) => message.type === "hello").length >= 2,
            "Journal failure closes connection",
          );
          await f.barrier();
          await assert.rejects(access(f.path("journal_start_failure")));
          assert.equal(
            await run("/usr/bin/sqlite3", [
              join(f.directory, "operations.sqlite3"),
              "SELECT count(*) FROM operations",
            ]),
            "0",
          );
          await run("/usr/bin/sqlite3", [
            join(f.directory, "operations.sqlite3"),
            "DROP TRIGGER fixture_fail_start",
          ]);
        } finally {
          await f.close();
        }
      });
      await t.test("journal completion failure cannot replay an uncertain side effect", async () => {
        const f = await fixture();
        try {
          await run("/usr/bin/sqlite3", [
            join(f.directory, "operations.sqlite3"),
            "CREATE TRIGGER fixture_fail_finish BEFORE UPDATE ON operations BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;",
          ]);
          const frame = f.frame("journal_finish_failure");
          f.send(frame);
          await until(
            () => f.messages.filter((message) => message.type === "hello").length >= 2,
            "Journal completion failure closes connection",
          );
          await f.barrier();
          assert.equal(await readFile(f.path("journal_finish_failure"), "utf8"), "journal_finish_failure");
          f.send(frame);
          const receipt = await f.result("journal_finish_failure");
          assert.equal(receipt.status, "outcome_unknown");
          assert.equal((receipt.error as Value).code, "duplicate_operation");
          assert.equal(
            await run("/usr/bin/sqlite3", [
              join(f.directory, "operations.sqlite3"),
              "SELECT status FROM operations WHERE id='journal_finish_failure'",
            ]),
            "executing",
          );
          await run("/usr/bin/sqlite3", [
            join(f.directory, "operations.sqlite3"),
            "DROP TRIGGER fixture_fail_finish",
          ]);
        } finally {
          await f.close();
        }
      });
      await t.test("pending admissions consume the operation limit", async () => {
        const f = await fixture();
        try {
          const gates = [];
          for (let i = 0; i < MAX_DEVICE_OPERATIONS; i++) {
            const gate = await f.gate(String(i));
            gates.push(gate);
            f.send(f.frame("pending_" + i));
            await gate.entered();
          }
          f.send(f.frame("excess"));
          assert.equal(((await f.result("excess")).error as Value).code, "device_busy");
          f.send({ type: "stop" });
          await f.barrier();
          for (const gate of gates) await gate.release();
          for (let i = 0; i < gates.length; i++) {
            assert.equal((await f.result("pending_" + i)).status, "refused");
            await assert.rejects(access(f.path("pending_" + i)));
          }
        } finally {
          await f.close();
        }
      });
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
);
