import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile, symlink, stat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer, type WebSocket } from "ws";
import { Computer } from "../src/computer.js";
import { DesktopError } from "../src/errors.js";
import {
  CuaNativeDriver,
  type NativeDriver,
  type NativeAction,
  type NativeObservation,
} from "../src/native.js";
import { LocalExecutor } from "../src/executor.js";
import { DeviceClient } from "../src/client.js";
import { configureClient } from "../src/runtime.js";
import { localControl } from "../src/local-control.js";
import { windowsPrivatePath } from "../src/windows-security.js";
import { OperationJournal, loadCredential } from "../src/storage.js";
const directory = () => mkdtemp(join(tmpdir(), "abridge-desktop-"));
class Native implements NativeDriver {
  actions: NativeAction[] = [];
  released: string[] = [];
  observations: NativeObservation = {
    elements: [
      { token: "native-secret-reference", role: "AXButton", label: "Continue", depth: 1 },
      {
        token: "password-ref",
        role: "AXSecureTextField",
        label: "Password",
        value: "protected-value",
        depth: 1,
      },
    ],
    image_base64: Buffer.from("image").toString("base64"),
    mime_type: "image/png",
    width: 100,
    height: 80,
  };
  async diagnostics() {
    return {
      driver: { installed: true, ready: true },
      permissions: { checked: true, screen: true, input: true },
    };
  }
  async apps() {
    return [{ pid: 10, name: "Fixture", bundle_id: "dev.abridge.fixture", running: true, active: true }];
  }
  async windows() {
    return [
      {
        pid: 10,
        window_id: 20,
        app_name: "Fixture",
        title: "Fixture",
        bounds: { x: 0, y: 0, width: 100, height: 80 },
        layer: 0,
        z_index: 1,
        is_on_screen: true,
      },
    ];
  }
  async open() {}
  async observe() {
    return structuredClone(this.observations);
  }
  async act(_id: string, action: NativeAction) {
    this.actions.push(action);
    return { action_executed: true, business_verified: false };
  }
  async release(id: string) {
    this.released.push(id);
  }
  async shutdown() {}
}
test("application discovery matches localized window titles and ranks running instances first", async () => {
  const native = new Native();
  native.apps = async () => [
    { pid: 0, name: "文档工具", bundle_id: "fixture.installed", running: false, active: false },
    {
      pid: 10,
      name: "EditorHost",
      window_title: "报告 — 文档工具",
      bundle_id: "fixture.running",
      running: true,
      active: false,
    },
  ];
  const computer = new Computer(native);
  const matches = await computer.apps({ query: "文档工具" });
  assert.deepEqual(
    (matches.apps as { bundle_id: string }[]).map((a) => a.bundle_id),
    ["fixture.running", "fixture.installed"],
  );
  assert.equal((await computer.apps({ query: "EditorHost" })).matches_total, 1);
  assert.equal((await computer.apps({ query: "不存在" })).matches_total, 0);
  assert.equal((await computer.apps({})).matches_total, 1);
});

test("Windows unmatched localized launcher exposes separate running identities without guessing a match", async () => {
  const native = Object.assign(new Native(), { platform: "win32" as const });
  native.apps = async () => [
    { pid: 0, name: "协作工具", bundle_id: "fixture.launcher", running: false, active: false },
    { pid: 11, name: "WorkspaceHost", bundle_id: "fixture.process", running: true, active: true },
  ];
  const computer = new Computer(native);
  const result = await computer.apps({ query: "协作工具" });
  assert.deepEqual(
    (result.apps as { bundle_id: string }[]).map((a) => a.bundle_id),
    ["fixture.launcher"],
  );
  assert.deepEqual(
    (result.running_alternatives as { bundle_id: string }[]).map((a) => a.bundle_id),
    ["fixture.process"],
  );
  assert.equal(result.matches_total, 1);
  assert.equal((await computer.apps({ query: "WorkspaceHost" })).running_alternatives, undefined);
  assert.equal((await computer.apps({})).running_alternatives, undefined);
  assert.equal(native.actions.length, 0);
});

test("Windows explicit actions retain unlabeled controls with image bounds but never invent read-only actions", async () => {
  const native = Object.assign(new Native(), { platform: "win32" as const });
  native.observations.element_actions = "explicit";
  native.observations.is_focused = true;
  native.observations.elements = [
    { role: "Pane", depth: 1, token: "container", actions: [] },
    { role: "Document", label: "Read only", depth: 2, token: "readonly", actions: [] },
    {
      role: "Button",
      depth: 18,
      token: "deep-button",
      actions: ["click"],
      bounds: { x: 75, y: 60, width: 20, height: 15 },
    },
  ];
  const computer = new Computer(native);
  const result = await computer.observe("explicit", { pid: 10, window_id: 20 });
  const rows = result.elements as Record<string, unknown>[];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].element_ref, undefined);
  assert.deepEqual(rows[1].actions, ["click"]);
  assert.deepEqual(rows[1].bounds, { x: 75, y: 60, width: 20, height: 15 });
  assert.equal(result.element_bounds_space, "screenshot_pixels");
  assert.equal(result.is_focused, true);
  await computer.act("explicit", {
    observation_id: result.observation_id,
    action: { type: "click", element_ref: rows[1].element_ref },
    observe_after: false,
  });
  assert.equal(native.actions[0].native_ref, "deep-button");
  native.observations.image_base64 = undefined;
  const noImage = await computer.observe("explicit", { pid: 10, window_id: 20, screenshot: false });
  assert.equal((noImage.elements as Record<string, unknown>[])[1].bounds, undefined);
  assert.equal(noImage.element_bounds_space, undefined);
  const noMatch = await computer.observe("explicit", { pid: 10, window_id: 20, query: '["Read","Button"]' });
  assert.equal(noMatch.elements_total, 0);
  assert.match(String(noMatch.next_step), /literal substring/);
});

test("Windows focus loss after dispatch preserves the receipt and requires verification without replay", async () => {
  const native = Object.assign(new Native(), { platform: "win32" as const });
  const computer = new Computer(native);
  const observation = await computer.observe("focus", { pid: 10, window_id: 20 });
  native.observe = async () => {
    throw new DesktopError("focus_changed", "fixture focus moved");
  };
  const result = await computer.act("focus", {
    observation_id: observation.observation_id,
    action: { type: "click", element_ref: "e1" },
    screenshot: true,
    wait_after_ms: 0,
  });
  assert.equal(result.action_executed, true);
  assert.equal(native.actions.length, 1);
  const error = result.observation_error as { code: string; next_step: string };
  assert.equal(error.code, "focus_changed");
  assert.match(error.next_step, /Do not repeat/);
  await assert.rejects(
    computer.act("focus", {
      observation_id: observation.observation_id,
      action: { type: "click", element_ref: "e1" },
    }),
    { code: "stale_observation" },
  );
  assert.equal(native.actions.length, 1);
});

test("Windows UIA failure keeps screenshot coordinate input available without inventing elements", async () => {
  const native = Object.assign(new Native(), { platform: "win32" as const });
  native.observations.element_actions = "explicit";
  native.observations.accessibility_status = "unavailable";
  native.observations.elements = [];
  const computer = new Computer(native);
  const result = await computer.observe("visual", { pid: 10, window_id: 20, screenshot: true });
  assert.equal(result.accessibility_status, "unavailable");
  assert.equal(result.pixel_actions, true);
  assert.deepEqual(result.elements, []);
  assert.match(String(result.interaction_guidance), /use this window screenshot/);
  await computer.act("visual", {
    observation_id: result.observation_id,
    action: { type: "click", x: 20, y: 30 },
    observe_after: false,
  });
  assert.equal(native.actions.length, 1);
  assert.equal(native.actions[0].x, 20);
  assert.equal(native.actions[0].y, 30);
});

test("files use exclusive writes, strict UTF8 and sorted truncated listings", async () => {
  const dir = await directory();
  try {
    const executor = new LocalExecutor(new Native());
    await executor.fileWrite({ path: join(dir, "b"), content: "😀 中文" });
    await executor.fileWrite({ path: join(dir, "a"), content: "a" });
    assert.equal((await executor.fileRead({ path: join(dir, "b") })).content, "😀 中文");
    await assert.rejects(executor.fileWrite({ path: join(dir, "b"), content: "bad" }), {
      code: "EEXIST",
    });
    await writeFile(join(dir, "binary"), Buffer.from([0xff]));
    await assert.rejects(executor.fileRead({ path: join(dir, "binary") }), {
      code: "unsupported_encoding",
    });
    const list = await executor.filesList({ path: dir, limit: 2 });
    assert.equal(list.truncated, true);
    const names = (list.entries as { name: string }[]).map((e) => e.name);
    assert.deepEqual(names, [...names].sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test(
  "file tools reject FIFOs without blocking worker threads",
  { skip: process.platform === "win32" },
  async () => {
    const dir = await directory();
    try {
      const path = join(dir, "pipe");
      execFileSync("mkfifo", [path]);
      // Bound the entire child: a blocking fs.open cannot be cancelled by a JS timer,
      // and would otherwise keep the test runner alive after an assertion timeout.
      const code = `
      import assert from "node:assert/strict";
      import { constants } from "node:fs";
      import { open } from "node:fs/promises";
      import { LocalExecutor } from ${JSON.stringify(new URL("../src/executor.ts", import.meta.url).href)};
      const executor = new LocalExecutor();
      const path = ${JSON.stringify(path)};
      await assert.rejects(executor.execute("read", "file_read", { path }), { code: "unsupported_file_type" });
      await assert.rejects(executor.execute("write", "file_write", { path, content: "bad", overwrite: true }), { code: "execution_failed" });
      const peer = await open(path, constants.O_RDWR | constants.O_NONBLOCK);
      try {
        await assert.rejects(executor.execute("write-with-peer", "file_write", { path, content: "bad", overwrite: true }), { code: "unsupported_file_type" });
      } finally { await peer.close(); }
    `;
      const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
        timeout: 5000,
        killSignal: "SIGKILL",
        encoding: "utf8",
      });
      assert.equal(result.error, undefined, `Child failed: ${result.error?.message}`);
      assert.equal(result.status, 0, `Child signal=${result.signal}\n${result.stdout}\n${result.stderr}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
test("regular files remain readable and overwritable through symlinks", async () => {
  const dir = await directory();
  try {
    const targetDir = join(dir, "target-dir");
    await mkdir(targetDir);
    const path = join(targetDir, "target");
    const link = process.platform === "win32" ? join(dir, "junction", "target") : join(dir, "link");
    const executor = new LocalExecutor(new Native());
    await writeFile(path, "original long content");
    if (process.platform === "win32") await symlink(targetDir, join(dir, "junction"), "junction");
    else await symlink(path, link);
    assert.equal((await executor.fileRead({ path: link })).content, "original long content");
    await executor.fileWrite({ path: link, content: "short", overwrite: true });
    assert.equal(await readFile(path, "utf8"), "short");
    await assert.rejects(executor.fileRead({ path: dir }), { code: "unsupported_file_type" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("Shell captures unicode output directly, strips unrequested env and bounds both streams", async () => {
  const executor = new LocalExecutor(new Native());
  process.env.ABRIDGE_PRIVATE_FIXTURE = "must-not-inherit";
  const result = await executor.commandExecute("shell", {
    command:
      process.platform === "win32"
        ? "[Console]::Write('😀 中文'); [Console]::Error.Write('error'); if (-not $env:ABRIDGE_PRIVATE_FIXTURE) { [Console]::Write('unset') }"
        : "printf '😀 中文'; printf error >&2; printf \"${ABRIDGE_PRIVATE_FIXTURE-unset}\"",
  });
  assert.equal(result.timed_out, false, JSON.stringify(result));
  assert.equal(result.stdout, "😀 中文unset", JSON.stringify(result));
  assert.equal(result.stderr, "error");
  assert.equal(result.exit_code, 0);
  const large = await executor.commandExecute("large", {
    command: "node -e \"process.stdout.write('x'.repeat(140000)); process.stderr.write('y'.repeat(140000))\"",
  });
  assert.equal((large.stdout as string).length, 131072);
  assert.equal((large.stderr as string).length, 131072);
  assert.equal(large.truncated, true);
  delete process.env.ABRIDGE_PRIVATE_FIXTURE;
});
test("Shell timeout and cancellation reap descendant process groups", async () => {
  const executor = new LocalExecutor(new Native());
  const timeout = await executor.commandExecute("timeout", {
    command: process.platform === "win32" ? "Start-Sleep 30" : "sleep 30 & wait",
    timeout: 1,
  });
  assert.equal(timeout.timed_out, true);
  const controller = new AbortController();
  const command = executor.commandExecute(
    "cancel",
    { command: process.platform === "win32" ? "Start-Sleep 30" : "sleep 30 & wait" },
    controller.signal,
  );
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(command, { name: "AbortError" });
});
test("credential binding is private, rejects symlinks and does not resume a paused device", async () => {
  const dir = await directory();
  try {
    await configureClient(dir, { url: "http://localhost:8765", device_key: "abr_device_fixture" });
    assert.equal(await loadCredential(dir, "http://localhost:8765"), "abr_device_fixture");
    if (process.platform === "win32") await windowsPrivatePath(join(dir, "credentials", "device.json"));
    else assert.equal((await stat(join(dir, "credentials", "device.json"))).mode & 0o777, 0o600);
    await assert.rejects(loadCredential(dir, "https://other.example"), { code: "credential_mismatch" });
    const config = JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
    config.paused = true;
    config.pause_reason = "manual";
    await writeFile(join(dir, "config.json"), JSON.stringify(config), { mode: 0o600 });
    assert.equal(
      (await configureClient(dir, { url: config.url, device_key: "abr_device_rebound" })).paused,
      true,
    );
    await rm(join(dir, "credentials", "device.json"));
    await writeFile(join(dir, "secret"), "{}", { mode: 0o600 });
    if (process.platform === "win32") {
      await rm(join(dir, "credentials"), { recursive: true });
      const elsewhere = join(dir, "elsewhere");
      await mkdir(elsewhere);
      await symlink(elsewhere, join(dir, "credentials"), "junction");
    } else await symlink(join(dir, "secret"), join(dir, "credentials", "device.json"));
    await assert.rejects(loadCredential(dir, config.url));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("journal persists only intent metadata and recovers interrupted effects without replay", async () => {
  const dir = await directory();
  try {
    const file = join(dir, "operations.sqlite3");
    const first = new OperationJournal(file);
    first.start("one", "hash-only");
    first.close();
    const recovered = new OperationJournal(file);
    assert.deepEqual({ ...recovered.get("one") }, { request_hash: "hash-only", status: "outcome_unknown" });
    recovered.finish("one", "executed");
    assert.equal(recovered.get("one")?.status, "executed");
    recovered.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("protected values cannot match query and native tokens never leave desktop", async () => {
  const native = new Native(),
    computer = new Computer(native);
  const hidden = await computer.observe("session", { pid: 10, window_id: 20, query: "protected-value" });
  assert.deepEqual(hidden.elements, []);
  const result = await computer.observe("session", { pid: 10, window_id: 20 });
  assert.ok(!JSON.stringify(result).includes("native-secret-reference"));
  assert.ok(!JSON.stringify(result).includes("protected-value"));
  assert.equal(result.pixel_actions, true);
});
test("correctable action errors preserve observation, native dispatch consumes it", async () => {
  const native = new Native(),
    computer = new Computer(native);
  const first = await computer.observe("one", { pid: 10, window_id: 20 });
  const obs = first.observation_id;
  await assert.rejects(
    computer.act("one", {
      observation_id: obs,
      action: { type: "click", x: 999, y: 2 },
      observe_after: false,
    }),
    { code: "invalid_arguments" },
  );
  await computer.act("one", {
    observation_id: obs,
    action: { type: "click", element_ref: "e1" },
    observe_after: false,
  });
  assert.equal(native.actions[0].native_ref, "native-secret-reference");
  await assert.rejects(
    computer.act("one", {
      observation_id: obs,
      action: { type: "click", element_ref: "e1" },
      observe_after: false,
    }),
    { code: "stale_observation" },
  );
});

test("explicit normalized coordinates convert once against the current frame and never change pixel defaults", async () => {
  const native = new Native(),
    computer = new Computer(native);
  native.observations.width = 2160;
  native.observations.height = 1440;
  const capture = () => computer.observe("normalized", { pid: 10, window_id: 20 });
  const first = await capture();
  await assert.rejects(
    computer.act("normalized", {
      observation_id: first.observation_id,
      action: { type: "click", x: 1001, y: 500, coordinate_space: "normalized_1000" },
      observe_after: false,
    }),
    { code: "invalid_arguments" },
  );
  assert.equal(native.actions.length, 0);
  await computer.act("normalized", {
    observation_id: first.observation_id,
    action: { type: "click", x: 381, y: 912, coordinate_space: "normalized_1000" },
    observe_after: false,
  });
  assert.equal(native.actions[0].x, 822);
  assert.equal(native.actions[0].y, 1313);
  const second = await capture();
  await computer.act("normalized", {
    observation_id: second.observation_id,
    action: { type: "click", x: 381, y: 912 },
    observe_after: false,
  });
  assert.equal(native.actions[1].x, 381);
  assert.equal(native.actions[1].y, 912);
  const third = await capture();
  await computer.act("normalized", {
    observation_id: third.observation_id,
    action: { type: "drag", x: 0, y: 0, to_x: 1000, to_y: 1000, coordinate_space: "normalized_1000" },
    observe_after: false,
  });
  assert.equal(native.actions[2].to_x, 2159);
  assert.equal(native.actions[2].to_y, 1439);
  const fourth = await capture();
  await assert.rejects(
    computer.act("normalized", {
      observation_id: fourth.observation_id,
      action: { type: "click", element_ref: "e1", coordinate_space: "normalized_1000" },
      observe_after: false,
    }),
    { code: "invalid_arguments" },
  );
  await computer.shutdown();
});
test("scroll targets explicit screenshot locations and preserves the center default", async () => {
  const native = new Native(),
    computer = new Computer(native);
  native.observations.width = 2160;
  native.observations.height = 1440;
  for (const [action, expected] of [
    [
      { type: "scroll", delta_y: 40 },
      { x: 1080, y: 720, delta_x: 0, delta_y: 40 },
    ],
    [
      { type: "scroll", delta_y: -40, x: 1830, y: 640 },
      { x: 1830, y: 640, delta_x: 0, delta_y: -40 },
    ],
    [
      { type: "scroll", delta_y: 0, delta_x: 80, x: 900, y: 500, coordinate_space: "normalized_1000" },
      { x: 1944, y: 720, delta_x: 80, delta_y: 0 },
    ],
  ] as const) {
    const observation = await computer.observe("scroll", { pid: 10, window_id: 20 });
    await computer.act("scroll", {
      observation_id: observation.observation_id,
      action,
      observe_after: false,
    });
    const dispatched = native.actions.at(-1)!;
    assert.deepEqual(
      { x: dispatched.x, y: dispatched.y, delta_x: dispatched.delta_x, delta_y: dispatched.delta_y },
      expected,
    );
    assert.equal(dispatched.native_ref, undefined);
  }
  assert.equal(native.actions.length, 3);
  await computer.shutdown();
});

test("scroll rejects incomplete or stale coordinates, refs and invalid axes before dispatch", async () => {
  const native = new Native(),
    computer = new Computer(native);
  const observation = await computer.observe("scroll", { pid: 10, window_id: 20 });
  for (const fields of [
    { x: 10 },
    { y: 10 },
    { coordinate_space: "normalized_1000" },
    { x: 100, y: 20 },
    { x: 10, y: 80 },
    { x: 1001, y: 500, coordinate_space: "normalized_1000" },
    { element_ref: "e1" },
    { delta_x: 40 },
    { delta_y: 0 },
  ]) {
    await assert.rejects(
      computer.act("scroll", {
        observation_id: observation.observation_id,
        action: { type: "scroll", delta_y: 40, ...fields },
        observe_after: false,
      }),
      { code: "invalid_arguments" },
    );
  }
  await computer.observe("scroll", { pid: 10, window_id: 20 });
  await assert.rejects(
    computer.act("scroll", {
      observation_id: observation.observation_id,
      action: { type: "scroll", delta_y: 40, x: 20, y: 30 },
      observe_after: false,
    }),
    { code: "stale_observation" },
  );
  native.observations = { elements: [] };
  const noImage = await computer.observe("scroll", { pid: 10, window_id: 20, screenshot: false });
  for (const location of [{}, { x: 10, y: 20 }]) {
    await assert.rejects(
      computer.act("scroll", {
        observation_id: noImage.observation_id,
        action: { type: "scroll", delta_y: 40, ...location },
        observe_after: false,
      }),
      { code: "screenshot_required" },
    );
  }
  assert.equal(native.actions.length, 0);
  await computer.shutdown();
});

test("observation TTL, session boundaries and close scopes are enforced", async () => {
  let now = 0;
  const native = new Native(),
    computer = new Computer(native, () => now);
  const a = await computer.observe("a", { pid: 10, window_id: 20 });
  const b = await computer.observe("b", { pid: 10, window_id: 20 });
  await assert.rejects(
    computer.act("b", {
      observation_id: a.observation_id,
      action: { type: "key", key: "Enter" },
      observe_after: false,
    }),
    { code: "stale_observation" },
  );
  await computer.closeSession("a");
  await computer.act("b", {
    observation_id: b.observation_id,
    action: { type: "key", key: "Enter" },
    observe_after: false,
  });
  const next = await computer.observe("b", { pid: 10, window_id: 20 });
  now = 120001;
  await assert.rejects(
    computer.act("b", {
      observation_id: next.observation_id,
      action: { type: "key", key: "Enter" },
      observe_after: false,
    }),
    { code: "stale_observation" },
  );
  assert.deepEqual(native.released, ["a"]);
});
test("same-session actions serialize and cannot use one observation twice", async () => {
  const native = new Native(),
    computer = new Computer(native);
  let resume!: () => void;
  native.act = async (_id, action) => {
    native.actions.push(action);
    await new Promise<void>((resolve) => {
      resume = resolve;
    });
    return { action_executed: true, business_verified: false };
  };
  const observed = await computer.observe("a", { pid: 10, window_id: 20 });
  const args = {
    observation_id: observed.observation_id,
    action: { type: "click", element_ref: "e1" },
    observe_after: false,
  };
  const first = computer.act("a", args);
  while (!resume) await delay(1);
  const second = computer.act("a", args);
  resume();
  await first;
  await assert.rejects(second, { code: "stale_observation" });
  assert.equal(native.actions.length, 1);
});
async function waitUntil(predicate: () => boolean, timeout = 3000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw Error("Condition timed out");
    await delay(5);
  }
}
test("real WS client executes one effect, deduplicates and obeys local pause", async () => {
  const dir = await directory();
  const ws = new WebSocketServer({ port: 0 });
  const address = ws.address();
  assert.ok(address && typeof address === "object");
  const messages: Record<string, unknown>[] = [];
  let peer: WebSocket | undefined;
  ws.on("connection", (socket) => {
    peer = socket;
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      messages.push(message);
      if (message.type === "hello")
        socket.send(
          JSON.stringify({
            type: "welcome",
            protocol: "abridge/1",
            device_id: "dev_fixture",
            connection_epoch: 1,
            capabilities: ["shell", "files", "screen", "input"],
            owner_name: "fixture",
            lease_seconds: 30,
            heartbeat_interval: 10,
          }),
        );
      if (message.type === "heartbeat")
        socket.send(JSON.stringify({ type: "heartbeat_ack", connection_epoch: 1 }));
    });
  });
  const config = await configureClient(dir, {
    url: `http://localhost:${address.port}`,
    device_key: "abr_device_fixture",
    capabilities: { shell: true, files: true, screen: true, input: true },
  });
  const client = new DeviceClient({
    stateDir: dir,
    config,
    deviceKey: "abr_device_fixture",
    executor: new LocalExecutor(new Native()),
  });
  const run = client.run();
  try {
    // Native local-control credentials and the initial private status file are
    // prepared before the WebSocket exists. Their Windows ACL subprocesses can
    // take longer than a localhost handshake when other test files are running.
    // Bound startup separately; retain the short protocol/effect deadlines below.
    await waitUntil(() => client["socket"] !== undefined, 15000);
    await waitUntil(() => messages.some((m) => m.type === "hello"));
    await waitUntil(() => Boolean(peer));
    await waitUntil(() => client["epoch"] === 1);
    const statusPath = join(dir, "status.json");
    // Welcome changes the epoch before its serialized status write completes.
    // Wait for that existing write, including any prior periodic snapshot/ACL
    // validation, rather than assuming the file is current after three seconds.
    await client["statusWrite"];
    const initial = JSON.parse(await readFile(statusPath, "utf8"));
    assert.equal(initial.connection, "online");
    const previousWrite = client["statusWrite"];
    await previousWrite;
    // No explicit refresh: the idle timer must itself enqueue the next write.
    // Keep the original three-second scheduling deadline, then await its commit.
    await waitUntil(() => client["statusWrite"] !== previousWrite);
    await client["statusWrite"];
    const idle = JSON.parse(await readFile(statusPath, "utf8"));
    assert.ok(idle.updated_at > initial.updated_at, "Idle clients must keep the native UI status fresh");
    assert.equal(idle.connection, "online");
    const frame = {
      type: "dispatch",
      protocol: "abridge/1",
      device_id: "dev_fixture",
      connection_epoch: 1,
      operation_id: "op_fixture",
      session_id: "sess_fixture",
      session_capabilities: ["files"],
      device_credential_version: 1,
      sequence: 1,
      expires_at: Date.now() / 1000 + 30,
      tool: "file_write",
      arguments: { path: join(dir, "effect"), content: "once" },
    };
    peer!.send(JSON.stringify(frame));
    await waitUntil(() => messages.some((m) => m.type === "result" && m.operation_id === "op_fixture"));
    assert.equal(await readFile(join(dir, "effect"), "utf8"), "once");
    peer!.send(JSON.stringify(frame));
    await waitUntil(
      () => messages.filter((m) => m.type === "result" && m.operation_id === "op_fixture").length === 2,
    );
    assert.equal(
      (messages.filter((m) => m.type === "result")[1].result as Record<string, unknown>).deduplicated,
      true,
    );
    await localControl(dir, { command: "pause" });
    peer!.send(
      JSON.stringify({
        ...frame,
        operation_id: "paused_op",
        sequence: 2,
        arguments: { path: join(dir, "forbidden"), content: "bad" },
      }),
    );
    await waitUntil(() => messages.some((m) => m.operation_id === "paused_op"));
    assert.equal(
      (messages.find((m) => m.operation_id === "paused_op")!.error as Record<string, unknown>).code,
      "device_paused",
    );
    assert.equal((await localControl(dir, { command: "status" })).paused, true);
  } finally {
    await client.stop();
    await run;
    const stopped = await readFile(join(dir, "status.json"), "utf8");
    assert.equal(JSON.parse(stopped).connection, "offline");
    await delay(1100);
    assert.equal(await readFile(join(dir, "status.json"), "utf8"), stopped);
    await new Promise<void>((resolve) => ws.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
test("failed observation sessions are released and launch evidence survives follow-up failure", async () => {
  const native = new Native();
  const observe = native.observe.bind(native);
  native.observe = async () => {
    throw Error("private native diagnostic");
  };
  const computer = new Computer(native);
  await assert.rejects(computer.observe("failed", { pid: 10, window_id: 20 }));
  await computer.stop();
  assert.deepEqual(native.released, ["failed"]);
  const next = new Computer(native);
  const result = await next.open("launch", { bundle_id: "dev.abridge.fixture" });
  assert.equal(result.launch_requested, true);
  assert.equal(result.bundle_id, "dev.abridge.fixture");
  assert.ok(!JSON.stringify(result).includes("private native diagnostic"));
  assert.deepEqual(result.window, { pid: 10, window_id: 20 });
  native.observe = observe;
  const recovered = await next.observe("launch", { screenshot: true });
  assert.deepEqual(recovered.window, { pid: 10, window_id: 20 });
  await next.shutdown();
});

test("Windows first capture can finish beyond the former shared eight-second budget", async () => {
  const fixture = new Native();
  const native: NativeDriver = Object.assign(fixture, { platform: "win32" as const });
  native.observe = async (_session, _target, _screenshot, signal) => {
    await delay(8100, undefined, { signal });
    return structuredClone(fixture.observations);
  };
  const computer = new Computer(native);
  try {
    const result = await computer.open("slow-first-capture", {
      bundle_id: "dev.abridge.fixture",
      screenshot: true,
    });
    assert.equal(result.observation_error, undefined);
    assert.equal((result.observation as Record<string, unknown>).pixel_actions, true);
  } finally {
    await computer.shutdown();
  }
});

test("Windows launch follow-up uses remaining budget and distinguishes timeout from external cancellation", async () => {
  for (const phase of ["discovery", "observation", "expired", "external"] as const) {
    let clock = 0;
    const fixture = new Native();
    const native: NativeDriver = Object.assign(fixture, { platform: "win32" as const });
    let opened = 0;
    native.open = async () => {
      opened++;
      clock = phase === "expired" ? 25001 : phase === "external" ? 0 : 24980;
    };
    const inventory = native.apps.bind(native);
    let inventories = 0;
    native.apps = async (signal) => {
      inventories++;
      if (phase === "discovery" && inventories > 1) await delay(200, undefined, { signal });
      return inventory(signal);
    };
    let entered!: () => void;
    const observing = new Promise<void>((resolve) => (entered = resolve));
    native.observe = async (_session, _target, _screenshot, signal) => {
      entered();
      await delay(200, undefined, { signal });
      return structuredClone(fixture.observations);
    };
    const computer = new Computer(native, () => clock);
    const controller = new AbortController();
    try {
      const pending = computer.open("bounded-open", { bundle_id: "dev.abridge.fixture" }, controller.signal);
      if (phase === "external") {
        await observing;
        controller.abort();
        await assert.rejects(pending, { name: "AbortError" });
      } else {
        const result = await pending;
        assert.equal(
          (result.observation_error as Record<string, unknown>).code,
          phase === "observation" ? "observation_timeout" : "window_discovery_timeout",
        );
        if (phase === "expired") assert.equal(inventories, 1, "expired budget does not start more discovery");
        if (phase === "observation") {
          assert.deepEqual(result.window, { pid: 10, window_id: 20 });
          native.observe = async () => structuredClone(fixture.observations);
          const recovered = await computer.observe("bounded-open", { screenshot: true });
          assert.equal(recovered.pixel_actions, true);
        }
      }
      assert.equal(opened, 1, "timeout recovery never relaunches");
      assert.deepEqual(fixture.actions, []);
    } finally {
      await computer.shutdown();
    }
  }
});

test("partial Windows UIA explains screenshot recovery without suggesting an extended query", async () => {
  const native = new Native();
  native.observations.element_actions = "explicit";
  native.observations.accessibility_status = "partial";
  native.observations.accessibility_limit = "time_budget";
  native.observations.truncated = true;
  native.observations.elements = [
    { token: "real-button", role: "Button", label: "Continue", depth: 1, actions: ["click"] },
  ];
  const computer = new Computer(native);
  try {
    const result = await computer.observe("partial", { pid: 10, window_id: 20, screenshot: true });
    assert.equal(result.accessibility_limit, "time_budget");
    assert.equal(result.accessibility_status, "partial");
    assert.equal(result.pixel_actions, true);
    assert.match(String(result.next_step), /does not extend traversal/);
    assert.equal((result.elements as Record<string, unknown>[])[0].element_ref, "e1");
    const missing = await computer.observe("partial", { query: "not visited", screenshot: true });
    assert.equal(missing.pixel_actions, true);
    assert.match(String(missing.next_step), /does not prove the control is absent/);
  } finally {
    await computer.shutdown();
  }
});
test("output transport failure aborts Shell without an unhandled rejection", async () => {
  const executor = new LocalExecutor(new Native(), async () => {
    throw Error("fixture transport closed");
  });
  await assert.rejects(
    executor.commandExecute("transport-failure", {
      command:
        process.platform === "win32"
          ? "[Console]::Write('fixture'); Start-Sleep 5"
          : "printf fixture; sleep 5",
    }),
    /fixture transport closed/,
  );
  await executor.shutdown();
});

test("binding only enables explicitly selected capabilities and known file failures are failed", async () => {
  const dir = await directory();
  try {
    const config = await configureClient(dir, {
      url: "http://localhost:8765",
      device_key: "abr_device_fixture",
      capabilities: { shell: true },
    });
    assert.deepEqual(config.capabilities, { screen: false, input: false, shell: true, files: false });
    const executor = new LocalExecutor(new Native());
    await assert.rejects(
      executor.execute("missing", "file_read", { path: join(dir, "missing") }),
      (error: unknown) =>
        error instanceof DesktopError && error.code === "execution_failed" && error.outcome === "failed",
    );
    await assert.rejects(executor.commandExecute("cwd", { command: "true", cwd: join(dir, "missing") }), {
      code: "invalid_cwd",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SDK generic modified clicks request foreground and element typing sends only its tool fields", async () => {
  const adapter = new CuaNativeDriver();
  const internals = adapter as unknown as {
    sdk: unknown;
    driver: unknown;
    sessions: Map<string, Promise<void>>;
  };
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  internals.sdk = {
    ActionTarget: {
      Window: class {
        constructor(readonly inner: unknown) {}
      },
    },
    ActionEffect: { Refused: 4 },
    DriverError: { Tool: { instanceOf: () => false }, InvalidArguments: { instanceOf: () => false } },
  };
  internals.driver = {
    callTool: async (tool: string, json: string) => {
      calls.push({ tool, args: JSON.parse(json) });
      return { isError: false };
    },
  };
  internals.sessions.set("fixture", Promise.resolve());
  await adapter.act("fixture", {
    action: "click",
    target: { pid: 10, window_id: 20 },
    native_ref: "opaque",
    modifiers: ["shift"],
  });
  await adapter.act("fixture", {
    action: "type",
    target: { pid: 10, window_id: 20 },
    native_ref: "opaque",
    text: "hello",
  });
  assert.equal(calls[0].args.delivery_mode, "foreground");
  assert.deepEqual(calls[1], {
    tool: "type_text",
    args: {
      session: "fixture",
      target: { kind: "window", pid: 10, window_id: 20 },
      element_token: "opaque",
      text: "hello",
    },
  });
});

test("open selects the focused window, retaining largest-window behavior when focus is unavailable", async () => {
  for (const hasFocus of [true, false]) {
    const native = new Native();
    const [base] = await native.windows();
    native.windows = async () => [
      { ...base, window_id: 21, bounds: { x: 0, y: 0, width: 900, height: 800 } },
      { ...base, is_focused: hasFocus ? true : undefined },
    ];
    const computer = new Computer(native);
    const result = await computer.open("launch", { bundle_id: "dev.abridge.fixture" });
    const observation = result.observation as { window: { window_id: number } };
    assert.equal(observation.window.window_id, hasFocus ? 20 : 21);
    await computer.shutdown();
  }
});

test("open returns its ready observation at the same nested path as act, and invalid native frames disable pixels", async () => {
  const native = new Native(),
    computer = new Computer(native);
  const result = await computer.open("launch", { bundle_id: "dev.abridge.fixture" });
  assert.equal(typeof (result.observation as Record<string, unknown>).observation_id, "string");
  native.observations.frame_valid = false;
  const invalid = await computer.observe("invalid", { pid: 10, window_id: 20 });
  assert.equal(invalid.pixel_actions, false);
  await assert.rejects(
    computer.act("invalid", {
      observation_id: invalid.observation_id,
      action: { type: "click", x: 2, y: 2 },
      observe_after: false,
    }),
    { code: "screenshot_required" },
  );
  await computer.shutdown();
});

test("dispatch rechecks its start deadline after asynchronous native diagnostics", async () => {
  const dir = await directory();
  const native = new Native();
  native.diagnostics = async () => {
    await delay(60);
    return {
      driver: { installed: true, ready: true },
      permissions: { checked: true, screen: true, input: true },
    };
  };
  const executor = new LocalExecutor(native),
    journal = new OperationJournal(join(dir, "operations.sqlite3"));
  const client = new DeviceClient({
    stateDir: dir,
    deviceKey: "abr_device_fixture",
    config: {
      url: "http://localhost:1",
      capabilities: { screen: true, input: true, shell: true, files: true },
      paused: false,
    },
    executor,
  });
  const receipts: Record<string, unknown>[] = [];
  Object.assign(client, {
    epoch: 1,
    deviceId: "fixture",
    lastAck: performance.now(),
    serverCapabilities: new Set(["screen", "input", "shell", "files"]),
    journal,
    socket: {
      readyState: 1,
      send: (text: string, callback: (error?: Error) => void) => {
        receipts.push(JSON.parse(text));
        callback();
      },
    },
  });
  try {
    await client.dispatch({
      type: "dispatch",
      protocol: "abridge/1",
      device_id: "fixture",
      connection_epoch: 1,
      sequence: 1,
      device_credential_version: 1,
      session_capabilities: ["files"],
      operation_id: "expired",
      session_id: "fixture",
      tool: "file_write",
      arguments: { path: join(dir, "forbidden"), content: "bad" },
      expires_at: Date.now() / 1000 + 0.03,
    });
    assert.equal((receipts[0].error as Record<string, unknown>).code, "dispatch_expired");
    assert.equal(journal.get("expired"), undefined);
    await assert.rejects(readFile(join(dir, "forbidden")), { code: "ENOENT" });
  } finally {
    journal.close();
    await executor.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});
