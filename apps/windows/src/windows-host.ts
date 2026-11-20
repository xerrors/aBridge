/** Private stdio bridge for the native Windows UI; all device policy remains in TypeScript. */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { defaultDataDirectory } from "@abridge/shared/paths";
import {
  deviceBindingInputSchema,
  windowsShellRequestSchema,
  VERSION,
  type WindowsShellRequest,
} from "@abridge/protocol";
import { getStatus } from "./runtime.js";
import { localControl } from "./local-control.js";
import { loadConfig, normalizeServerUrl } from "./storage.js";
import { desktopActivity } from "./windows-activity.js";
import { windowsView } from "./windows-view.js";

const { values } = parseArgs({
  options: { "state-dir": { type: "string" }, "parent-pid": { type: "string" } },
});
const stateDir = resolve(values["state-dir"] ?? defaultDataDirectory());
const parentPid = Number(values["parent-pid"]);
if (values["parent-pid"] && (!Number.isSafeInteger(parentPid) || parentPid <= 0))
  throw Error("Invalid parent PID");
const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
let runtime: ChildProcess | undefined;
let authorization: ChildProcess | undefined;
let cancelAuthorization: (() => boolean) | undefined;
let starting: Promise<void> | undefined;
let busy = false;
let quitting = false;
let lastError = "";
let generation = 0;
let lastId = 0;
let refreshing = false;
let lastStatusAt = 0;

function emit(value: unknown): void {
  if (!process.stdout.destroyed) process.stdout.write(JSON.stringify(value) + "\n");
}
function hideActivity(): void {
  generation++;
  emit({ event: "activity", active: false });
}
function child(args: string[]): ChildProcess {
  const running = spawn(process.execPath, [cli, ...args, "--state-dir", stateDir], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ABRIDGE_PARENT_PID: String(process.pid),
      ABRIDGE_INDICATOR_PID: String(parentPid || process.pid),
      ABRIDGE_PROTECTED_PIDS: [process.pid, ...(parentPid ? [parentPid] : [])].join(","),
    },
  });
  running.stderr?.resume();
  return running;
}
function start(): Promise<void> {
  if (starting) return starting;
  starting = startRuntime().finally(() => {
    starting = undefined;
  });
  return starting;
}
async function startRuntime(): Promise<void> {
  if (quitting || (runtime && runtime.exitCode === null && runtime.signalCode === null)) return;
  await loadConfig(stateDir);
  if (quitting) return;
  lastError = "";
  const running = child(["run"]);
  runtime = running;
  running.stdout?.resume();
  running.on("error", () => {
    lastError = "无法启动设备进程，请检查安装文件。";
  });
  running.on("exit", (code) => {
    hideActivity();
    if (runtime === running) runtime = undefined;
    if (code && !quitting) lastError = "设备进程已退出，请查看运行诊断后重连。";
  });
}
async function waitExit(running: ChildProcess, milliseconds: number): Promise<void> {
  if (running.exitCode !== null || running.signalCode !== null) return;
  await new Promise<void>((accept, reject) => {
    const ended = () => {
      clearTimeout(timer);
      accept();
    };
    const timer = setTimeout(() => {
      running.off("exit", ended);
      reject(Error("设备进程尚未退出，请稍后重试。"));
    }, milliseconds);
    running.once("exit", ended);
  });
}
async function stopRuntime(): Promise<void> {
  hideActivity();
  await starting;
  const running = runtime;
  if (!running || running.exitCode !== null || running.signalCode !== null) return;
  // A newly spawned runtime may still be opening its authenticated control socket.
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      await localControl(stateDir, { command: "shutdown" }, 20000);
      break;
    } catch (error) {
      if (running.exitCode !== null || running.signalCode !== null) return;
      if (Date.now() >= deadline) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
  await waitExit(running, 15000);
}
async function bind(
  value: Extract<WindowsShellRequest, { action: "bind" }>["args"],
): Promise<Record<string, unknown>> {
  if (busy) throw Error("正在连接，请先完成或取消当前授权。");
  busy = true;
  let cancelled = false;
  cancelAuthorization = () => {
    cancelled = true;
    return true;
  };
  try {
    const existing = await loadConfig(stateDir).catch(() => undefined);
    if (existing && !existing.revoked) throw Error("此电脑已绑定。请先解除绑定再更换服务器。");
    const input = deviceBindingInputSchema.parse({
      url: value.url,
      ...(value.device_key ? { device_key: value.device_key } : {}),
      ...(value.http_confirmed_origin ? { http_confirmed_origin: value.http_confirmed_origin } : {}),
    });
    normalizeServerUrl(input.url, input.http_confirmed_origin);
    if (cancelled || quitting) throw Error("已取消连接。");
    const origin = new URL(input.url).origin;
    const pending = child(["authorize", "--stdin"]);
    authorization = pending;
    try {
      return await new Promise((accept, reject) => {
        let complete = false;
        let committing = false;
        let handling = Promise.resolve();
        const fail = (error: unknown) => {
          if (complete) return;
          complete = true;
          clearTimeout(timeout);
          pending.stdin?.end();
          reject(error);
        };
        cancelAuthorization = () => {
          if (committing) return false;
          cancelled = true;
          fail(Error("授权已取消。"));
          return true;
        };
        const timeout = setTimeout(() => fail(Error("授权已超时，请重新连接。")), 305000);
        pending.stdin?.on("error", () => fail(Error("授权连接已关闭。")));
        const lines = createInterface({ input: pending.stdout!, crlfDelay: Infinity });
        lines.on("line", (line) => {
          handling = handling
            .then(async () => {
              if (complete) return;
              if (line.length > 65536) throw Error("授权响应过大。");
              const result = JSON.parse(line) as Record<string, unknown>;
              if (result.event === "authorization") {
                const url = new URL(String(result.authorization_url));
                if (url.origin !== origin || !["http:", "https:"].includes(url.protocol))
                  throw Error("授权页面地址不匹配。");
                emit({ event: "authorization", url: url.href });
              } else if (result.event === "ready") {
                await stopRuntime();
                if (complete || cancelled || quitting || pending.stdin?.writableEnded) return;
                committing = true;
                pending.stdin!.write(
                  JSON.stringify({ command: "commit", capabilities: value.capabilities }) + "\n",
                );
              } else if (result.event === "complete") {
                if (cancelled || quitting) return;
                await start();
                if (complete || cancelled || quitting) return;
                complete = true;
                clearTimeout(timeout);
                accept({ bound: true });
              } else if (result.event === "error") throw Error(String(result.error || "授权失败"));
            })
            .catch(fail);
        });
        pending.once("error", () => fail(Error("无法启动授权进程。")));
        pending.once("exit", () => {
          clearTimeout(timeout);
          void handling.then(() => {
            if (!complete) fail(Error("授权已取消或连接已关闭。"));
          });
        });
        pending.stdin!.write(JSON.stringify(input) + "\n");
      });
    } finally {
      pending.stdin?.end();
      await waitExit(pending, 20000);
      if (authorization === pending) authorization = undefined;
    }
  } finally {
    cancelAuthorization = undefined;
    busy = false;
  }
}
async function status(snapshot?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const config = await loadConfig(stateDir).catch(() => undefined);
  const value = {
    url: config?.url,
    requested_capabilities: config?.capabilities,
    paused: config?.paused,
    ...(snapshot ?? (await getStatus(stateDir))),
    version: VERSION,
    bound: !!config && !config.revoked,
    busy,
    local_error: lastError,
  };
  return { ...value, view: windowsView(value) };
}
async function quit(): Promise<void> {
  quitting = true;
  hideActivity();
  cancelAuthorization?.();
  try {
    if (authorization) await waitExit(authorization, 20000);
    await stopRuntime();
  } catch (error) {
    quitting = false;
    throw error;
  }
}
async function action(request: WindowsShellRequest): Promise<Record<string, unknown>> {
  if (quitting) throw Error("客户端正在退出。");
  const { action, args } = request;
  if (action === "status") return status();
  if (action === "bind") return bind(args);
  if (action === "cancel") {
    if (cancelAuthorization?.() === false) throw Error("绑定正在保存，请等待完成后解除绑定。");
    return {};
  }
  if (action === "connect") {
    await start();
    return {};
  }
  if (action === "quit") {
    await quit();
    return {};
  }
  if (["pause", "stop", "unbind", "capability"].includes(action)) hideActivity();
  return localControl(stateDir, { ...args, command: action }, 20000);
}
async function refresh(): Promise<void> {
  if (refreshing || quitting) return;
  refreshing = true;
  const current = generation;
  try {
    let snapshot: Record<string, unknown>;
    try {
      snapshot = runtime
        ? await localControl(stateDir, { command: "status" }, 750)
        : { connection: "offline" };
    } catch {
      snapshot = { connection: "offline", active_operations: 0 };
    }
    if (current === generation && !quitting) emit({ event: "activity", active: desktopActivity(snapshot) });
    if (Date.now() - lastStatusAt >= 2000) {
      const full = await status(snapshot);
      if (current === generation && !quitting) {
        emit({ event: "status", status: full });
        lastStatusAt = Date.now();
      }
    }
  } finally {
    refreshing = false;
  }
}
// Inherited private pipes, never a TCP listener. Bound framing and monotonically
// increasing IDs prevent duplicate UI commands from replaying a write.
let input = "";
let outstanding = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  input += chunk;
  if (Buffer.byteLength(input) > 65536) {
    void abandoned();
    return;
  }
  let end: number;
  while ((end = input.indexOf("\n")) >= 0) {
    const line = input.slice(0, end);
    input = input.slice(end + 1);
    let request: WindowsShellRequest;
    let candidate: unknown;
    try {
      candidate = JSON.parse(line);
      request = windowsShellRequestSchema.parse(candidate);
    } catch {
      const id = candidate && typeof candidate === "object" && "id" in candidate ? candidate.id : 0;
      emit({
        id: typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : 0,
        ok: false,
        error: "请求无效。",
      });
      continue;
    }
    if (request.id <= lastId || outstanding >= 32) {
      emit({ id: request.id, ok: false, error: "请求重复或客户端正忙。" });
      continue;
    }
    lastId = request.id;
    outstanding++;
    void action(request)
      .then((result) => {
        emit({ id: request.id, ok: true, ...result });
        lastStatusAt = 0;
        if (request.action === "quit") process.stdout.write("", () => process.exit(0));
      })
      .catch((error: unknown) => {
        emit({ id: request.id, ok: false, error: error instanceof Error ? error.message : "操作失败。" });
      })
      .finally(() => {
        outstanding--;
      });
  }
});
let abandoning = false;
async function abandoned(): Promise<void> {
  if (abandoning) return;
  abandoning = true;
  // Parent loss must stop input even when the normal control socket is broken.
  const deadline = setTimeout(() => process.exit(1), 22000);
  try {
    await quit();
  } catch {}
  clearTimeout(deadline);
  process.exit(0);
}
process.stdin.once("end", () => void abandoned());
process.stdout.on("error", () => void abandoned());
process.once("SIGTERM", () => void abandoned());
process.once("SIGINT", () => void abandoned());
if (parentPid)
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") void abandoned();
    }
  }, 500).unref();
setInterval(() => void refresh().catch(() => hideActivity()), 200).unref();
await start().catch(() => {});
await refresh();
