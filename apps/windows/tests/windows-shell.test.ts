import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, unlink, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { configureClient } from "../src/runtime.js";
import { privateDirectory, loadConfig, loadCredential } from "../src/storage.js";

// Production stdio host + real Node children running a fixture CLI. No native UI,
// accounts, network connections or device input are involved in these tests.
const options = { skip: process.platform !== "win32", timeout: 45000 };
const binding = { url: "https://fixture.example", device_key: "abr_device_fixture", capabilities: {} };
type Reply = Record<string, unknown> & { id: number; ok: boolean };
async function until(check: () => Promise<boolean>, message: string): Promise<void> {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(20);
  }
  throw Error(message);
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function setup(bound = false) {
  const base = resolve(".local");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "windows-shell-test-"));
  const stateDir = join(dir, "state");
  await privateDirectory(stateDir);
  if (bound) await configureClient(stateDir, binding);
  for (const [source, name] of [
    ["apps/windows/src/windows-host.ts", "host.mjs"],
    ["tools/fixtures/windows-shell-child.ts", "cli.js"],
  ]) {
    await build({
      entryPoints: [resolve(source!)],
      outfile: join(dir, name!),
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      plugins: [
        {
          name: "workspace-sources",
          setup(builder) {
            builder.onResolve({ filter: /^@abridge\// }, ({ path }) => {
              const entries: Record<string, string> = {
                "@abridge/protocol": "packages/protocol/src/index.ts",
                "@abridge/shared/paths": "packages/shared/src/paths.ts",
              };
              assert.ok(entries[path], `Unknown workspace package ${path}`);
              return { path: resolve(entries[path]!) };
            });
          },
        },
      ],
    });
  }
  const host = spawn(
    process.execPath,
    [join(dir, "host.mjs"), "--state-dir", stateDir, "--parent-pid", String(process.pid)],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stderr = "";
  host.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const closed = once(host, "close");
  const pending = new Map<number, { resolve: (reply: Reply) => void; reject: (error: Error) => void }>();
  const notifications: Record<string, unknown>[] = [];
  const lines = createInterface({ input: host.stdout });
  lines.on("line", (line) => {
    const reply = JSON.parse(line) as Reply;
    if (typeof reply.id === "number") {
      pending.get(reply.id)?.resolve(reply);
      pending.delete(reply.id);
    } else notifications.push(reply);
  });
  host.on("close", () => {
    for (const request of pending.values()) request.reject(Error(`Host closed: ${stderr}`));
    pending.clear();
  });
  let nextId = 0;
  const send = (id: number, action: string, args: Record<string, unknown> = {}) =>
    new Promise<Reply>((resolve, reject) => {
      if (host.exitCode !== null || host.signalCode !== null) {
        reject(Error(`Host already closed: ${stderr}`));
        return;
      }
      pending.set(id, { resolve, reject });
      host.stdin.write(JSON.stringify({ id, action, args }) + "\n");
    });
  const invoke = (action: string, args: Record<string, unknown> = {}) => send(++nextId, action, args);
  const events = async () =>
    (await readFile(join(stateDir, "fixture-events.log"), "utf8").catch(() => "")).trim().split("\n");
  const waitEvent = (event: string) =>
    until(async () => (await events()).includes(event), `Missing ${event}: ${stderr}`);
  const ownedPids = async () =>
    (await events())
      .filter((event) => event.startsWith("child-start:"))
      .map((event) => Number(event.split(":")[1]));
  const waitChildren = () =>
    until(async () => (await ownedPids()).every((pid) => !alive(pid)), "Owned CLI children did not exit");
  const fixture = {
    host,
    invoke,
    send,
    events,
    waitEvent,
    notifications,
    stateDir,
    waitChildren,
    closed,
    ownedPids,
    async close() {
      // Bound teardown before awaiting IPC; a hung host must not hold CI forever.
      const timer = setTimeout(() => host.kill(), 10000);
      try {
        await unlink(join(stateDir, "hold-shutdown")).catch(() => {});
        await unlink(join(stateDir, "hold-commit")).catch(() => {});
        if (host.exitCode === null && host.signalCode === null) {
          await invoke("cancel").catch(() => {});
          await invoke("quit").catch(() => {});
        }
        await closed;
        // Only PIDs recorded by this isolated fixture CLI can be cleaned up.
        for (const pid of await ownedPids()) if (alive(pid)) process.kill(pid);
        await waitChildren();
        await rm(dir, { recursive: true, force: true });
      } finally {
        clearTimeout(timer);
      }
    },
  };
  try {
    assert.equal((await invoke("status")).bound, bound);
    assert.equal((await invoke("connect")).ok, bound);
    if (bound) await waitEvent("run-ready");
    return fixture;
  } catch (error) {
    await fixture.close();
    throw error;
  }
}

test(
  "Windows host unbound startup rejects unconfirmed HTTP and invalid requests without spawning CLI",
  options,
  async () => {
    const fixture = await setup();
    try {
      assert.equal((await fixture.invoke("bind", { ...binding, url: "http://192.0.2.1" })).ok, false);
      assert.equal((await fixture.invoke("unsupported-action")).ok, false);
      assert.equal((await fixture.invoke("capability", { capability: "shell", enabled: "yes" })).ok, false);
      assert.equal((await fixture.invoke("status")).busy, false);
      assert.deepEqual(await fixture.ownedPids(), []);
    } finally {
      await fixture.close();
    }
  },
);

test("Windows host preserves existing binding and coalesces reconnects into one child", options, async () => {
  const fixture = await setup();
  try {
    await configureClient(fixture.stateDir, binding);
    const replies = await Promise.all(Array.from({ length: 5 }, () => fixture.invoke("connect")));
    assert.ok(replies.every((reply) => reply.ok));
    await fixture.waitEvent("run-ready");
    assert.equal((await fixture.events()).filter((event) => event === "run-start").length, 1);
    const before = await loadConfig(fixture.stateDir);
    assert.equal((await fixture.invoke("bind", binding)).ok, false);
    assert.deepEqual(await loadConfig(fixture.stateDir), before);
    assert.equal((await fixture.invoke("unbind")).ok, true);
    assert.equal((await fixture.invoke("status")).bound, false);
    await fixture.invoke("quit");
    await fixture.closed;
    await fixture.waitChildren();
    assert.equal(fixture.host.exitCode, 0);
  } finally {
    await fixture.close();
  }
});

test("Windows host cancels authorization during runtime shutdown before committing", options, async () => {
  const fixture = await setup(true);
  try {
    assert.equal((await fixture.invoke("unbind")).ok, true);
    await writeFile(join(fixture.stateDir, "hold-shutdown"), "hold");
    const bindingResult = fixture.invoke("bind", binding);
    await fixture.waitEvent("shutdown-start");
    assert.equal((await fixture.invoke("cancel")).ok, true);
    assert.equal((await bindingResult).ok, false);
    await fixture.waitEvent("authorize-exit");
    await unlink(join(fixture.stateDir, "hold-shutdown"));
    await fixture.waitChildren();
    assert.ok(!(await fixture.events()).includes("commit"));
    assert.equal((await fixture.invoke("status")).busy, false);
    assert.ok(fixture.notifications.some((message) => message.event === "authorization"));
  } finally {
    await fixture.close();
  }
});

test(
  "Windows host refuses cancellation after commit; quit waits for durable binding and child exit",
  options,
  async () => {
    const fixture = await setup();
    try {
      await writeFile(join(fixture.stateDir, "hold-commit"), "hold");
      const bindingResult = fixture.invoke("bind", binding);
      await fixture.waitEvent("commit");
      assert.equal((await fixture.invoke("cancel")).ok, false);
      assert.equal((await fixture.invoke("status")).busy, true);
      assert.equal((await fixture.invoke("bind", binding)).ok, false);
      const quitting = fixture.invoke("quit");
      await delay(150);
      assert.equal(fixture.host.exitCode, null);
      assert.ok(!(await fixture.events()).includes("commit-saved"));
      await unlink(join(fixture.stateDir, "hold-commit"));
      await bindingResult;
      assert.equal((await quitting).ok, true);
      await fixture.closed;
      await fixture.waitChildren();
      assert.equal((await loadConfig(fixture.stateDir)).url, binding.url);
      assert.equal(await loadCredential(fixture.stateDir, binding.url), binding.device_key);
      assert.equal((await fixture.ownedPids()).length, 1, "Quit must not restart runtime after commit");
    } finally {
      await fixture.close();
    }
  },
);

test("Windows host forwards pause/resume/capability and rejects replayed request IDs", options, async () => {
  const fixture = await setup(true);
  try {
    const pause = await fixture.invoke("pause");
    assert.equal(pause.ok, true);
    assert.equal((await loadConfig(fixture.stateDir)).paused, true);
    assert.equal((await fixture.send(pause.id, "resume")).ok, false);
    assert.equal((await loadConfig(fixture.stateDir)).paused, true, "Reused ID cannot dispatch a new write");
    assert.equal((await fixture.invoke("capability", { capability: "input", enabled: true })).ok, true);
    assert.equal((await loadConfig(fixture.stateDir)).capabilities.input, true);
    const resumed = await fixture.invoke("resume");
    assert.equal(resumed.ok, true, JSON.stringify({ resumed, events: await fixture.events() }));
    assert.equal((await loadConfig(fixture.stateDir)).paused, false);
    await until(
      async () => fixture.notifications.some((message) => message.event === "status"),
      "Missing status event",
    );
    await fixture.invoke("quit");
    await fixture.closed;
    await fixture.waitChildren();
  } finally {
    await fixture.close();
  }
});
