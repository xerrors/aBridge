import { spawn, type ChildProcess } from "node:child_process";
import { open, stat, opendir, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { readBounded } from "./io.js";
import { Computer } from "./computer.js";
import { CuaNativeDriver, type NativeDriver } from "./native.js";
import { DesktopError, checkAbort, integer, invalid, record, stringArg } from "./errors.js";
export type OutputHandler = (operationId: string, stream: "stdout" | "stderr", data: string) => Promise<void>;
const MAX_OUTPUT_BYTES = 131072,
  MAX_FILE_BYTES = 1048576;
function expand(path: string): string {
  return resolve(path === "~" ? homedir() : path.startsWith("~/") ? `${homedir()}/${path.slice(2)}` : path);
}
async function killTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    return;
  }
  await delay(150);
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {}
}
export class LocalExecutor {
  readonly computer: Computer;
  private readonly processes = new Map<string, ChildProcess>();
  constructor(
    native: NativeDriver = new CuaNativeDriver(),
    readonly onOutput?: OutputHandler,
  ) {
    this.computer = new Computer(native);
  }
  async execute(
    operationId: string,
    tool: string,
    args: Record<string, unknown>,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    checkAbort(signal);
    try {
      return await this.executeTool(operationId, tool, args, sessionId, signal);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        ["ENOENT", "EEXIST", "EACCES", "EPERM", "ENOTDIR", "EISDIR"].includes(String(error.code)) &&
        !tool.startsWith("computer_")
      )
        throw new DesktopError(
          "execution_failed",
          `Local ${tool === "command_execute" ? "command" : "file"} access failed (${error.code})`,
          "failed",
        );
      throw error;
    }
  }
  private async executeTool(
    operationId: string,
    tool: string,
    args: Record<string, unknown>,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    switch (tool) {
      case "command_execute":
        return this.commandExecute(operationId, args, signal);
      case "files_list":
        return this.filesList(args, signal);
      case "file_read":
        return this.fileRead(args, signal);
      case "file_write":
        return this.fileWrite(args, signal);
      case "computer_apps":
        return this.computer.apps(args, signal);
      case "computer_windows":
        return this.computer.windows(args, signal);
      case "computer_open":
      case "computer_observe":
      case "computer_act":
        if (!sessionId) throw new DesktopError("session_required", "Desktop actions require a session");
        return tool === "computer_open"
          ? this.computer.open(sessionId, args, signal)
          : tool === "computer_observe"
            ? this.computer.observe(sessionId, args, signal)
            : this.computer.act(sessionId, args, signal);
      default:
        throw new DesktopError("unknown_tool", "This desktop device does not provide that tool");
    }
  }
  async commandExecute(
    id: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const command = stringArg(args, "command");
    const timeout = args.timeout ?? 30;
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 1 || timeout > 120)
      invalid("timeout must be between 1 and 120 seconds");
    if (args.cwd !== undefined && typeof args.cwd !== "string") invalid("cwd must be a path");
    const cwd = expand((args.cwd as string) || homedir());
    try {
      if (!(await stat(cwd)).isDirectory())
        throw new DesktopError("invalid_cwd", "Working directory does not exist");
    } catch (error) {
      if (error instanceof DesktopError) throw error;
      throw new DesktopError("invalid_cwd", "Working directory does not exist or is inaccessible");
    }
    const supplied = args.env ?? {};
    if (
      !record(supplied) ||
      Object.entries(supplied).some(
        ([key, value]) =>
          !key ||
          key.includes("=") ||
          key.includes("\0") ||
          typeof value !== "string" ||
          value.includes("\0"),
      )
    )
      invalid("env must contain string names and values");
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR"])
      if (process.env[key] !== undefined) env[key] = process.env[key];
    Object.assign(env, supplied);
    checkAbort(signal);
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.processes.set(id, child);
    const capture = async (stream: NodeJS.ReadableStream, name: "stdout" | "stderr") => {
      const chunks: Buffer[] = [];
      let length = 0,
        truncated = false;
      const decoder = new StringDecoder("utf8");
      for await (const raw of stream) {
        const chunk = Buffer.from(raw as Uint8Array);
        const take = Math.max(0, MAX_OUTPUT_BYTES - length);
        const accepted = chunk.subarray(0, take);
        chunks.push(accepted);
        length += accepted.length;
        if (accepted.length < chunk.length) truncated = true;
        const text = decoder.write(accepted);
        if (text && !signal?.aborted) await this.onOutput?.(id, name, text);
      }
      const tail = decoder.end();
      if (tail && !signal?.aborted) await this.onOutput?.(id, name, tail);
      return { text: Buffer.concat(chunks).toString("utf8"), truncated };
    };
    let timedOut = false;
    const abort = () => {
      void killTree(child);
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      void killTree(child);
    }, timeout * 1000);
    try {
      const exited = new Promise<number | null>((res, rej) => {
        child.once("error", rej);
        child.once("exit", res);
      });
      const stdout = capture(child.stdout!, "stdout"),
        stderr = capture(child.stderr!, "stderr");
      // Attach handlers to every output promise immediately. A transport failure
      // must reach cleanup without an unhandled rejection while the shell runs.
      const [code, out, err] = await Promise.all([
        exited.then(async (code) => {
          await killTree(child);
          return code;
        }),
        stdout,
        stderr,
      ]);
      checkAbort(signal);
      return {
        exit_code: code ?? -1,
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
        timed_out: timedOut,
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      await killTree(child);
      this.processes.delete(id);
    }
  }
  async filesList(args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const path = expand(stringArg(args, "path")),
      limit = integer(args.limit ?? 200, "limit", 1, 500);
    const entries: Record<string, unknown>[] = [];
    let truncated = false;
    const directory = await opendir(path);
    try {
      for await (const entry of directory) {
        checkAbort(signal);
        if (entries.length === limit) {
          truncated = true;
          break;
        }
        const info = await lstat(resolve(path, entry.name));
        entries.push({
          name: entry.name,
          is_directory: entry.isDirectory(),
          is_symlink: entry.isSymbolicLink(),
          size: info.size,
          modified_at: info.mtimeMs / 1000,
        });
      }
    } finally {
      await directory.close().catch(() => {});
    }
    entries.sort((a, b) => String(a.name).toLowerCase().localeCompare(String(b.name).toLowerCase()));
    return { path, entries, truncated };
  }
  async fileRead(args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const path = expand(stringArg(args, "path")),
      max = integer(args.max_bytes ?? MAX_FILE_BYTES, "max_bytes", 1, MAX_FILE_BYTES);
    const file = await open(path, "r");
    try {
      checkAbort(signal);
      const bytes = await readBounded(file, max);
      const bytesRead = bytes.length;
      checkAbort(signal);
      if (bytesRead > max) throw new DesktopError("file_too_large", "File exceeds the requested size limit");
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead));
      } catch {
        throw new DesktopError("unsupported_encoding", "File must contain UTF-8 text");
      }
      return { path, content, size: bytesRead };
    } finally {
      await file.close();
    }
  }
  async fileWrite(args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const path = expand(stringArg(args, "path"));
    if (typeof args.content !== "string" || !args.content.isWellFormed())
      invalid("content must be a well-formed Unicode string");
    const bytes = Buffer.from(args.content);
    if (bytes.length > MAX_FILE_BYTES)
      throw new DesktopError("file_too_large", "Content exceeds the 1048576 byte limit");
    const overwrite = args.overwrite ?? false;
    if (typeof overwrite !== "boolean") invalid("overwrite must be a boolean");
    checkAbort(signal);
    const file = await open(path, overwrite ? "w" : "wx");
    try {
      checkAbort(signal);
      await file.writeFile(bytes);
      return { path, size: bytes.length, overwritten: overwrite };
    } finally {
      await file.close();
    }
  }
  async diagnostics(initialize = true): Promise<Record<string, unknown>> {
    return {
      runtime: { node: process.versions.node, ready: true },
      ...(await this.computer.native.diagnostics(initialize)),
    };
  }
  async closeSession(id: string): Promise<void> {
    await this.computer.closeSession(id);
  }
  async stop(): Promise<void> {
    await Promise.allSettled([...this.processes.values()].map(killTree));
    await this.computer.stop();
  }
  async shutdown(): Promise<void> {
    await this.stop();
    await this.computer.shutdown();
  }
}
