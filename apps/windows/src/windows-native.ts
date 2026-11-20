import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { DesktopError, checkAbort } from "./errors.js";
import type { NativeDriver, AppInfo, WindowInfo, Target, NativeObservation, NativeAction } from "./native.js";
import { WINDOWS_SCRIPT } from "./windows-script.js";
import { privateDirectory } from "./storage.js";
import { powershellPath } from "./windows-security.js";

/** One private, serialized UIA host. A lost reply never retries an input. */
export class WindowsNativeDriver implements NativeDriver {
  readonly platform = "win32" as const;
  private child?: ChildProcessWithoutNullStreams;
  private directory?: string;
  private starting?: Promise<void>;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private sequence = 0;
  private lastDiagnostics: Record<string, unknown> = {
    driver: { ready: false },
    permissions: { checked: false, screen: false, input: false },
  };
  private pending?: { id: number; resolve(value: unknown): void; reject(error: Error): void };
  private async start(): Promise<void> {
    if (this.closed) throw new DesktopError("driver_closed", "Windows driver is closed");
    if (this.child) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if (process.platform !== "win32") throw new DesktopError("driver_unavailable", "Windows is required");
      this.directory ??= await mkdtemp(join(tmpdir(), "abridge-native-"));
      await privateDirectory(this.directory);
      const script = join(this.directory, "host.ps1");
      await writeFile(script, "\ufeff" + WINDOWS_SCRIPT, "utf8");
      if (this.closed) throw new DesktopError("driver_closed", "Windows driver is closed");
      const child = spawn(
        powershellPath,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-MTA", "-ExecutionPolicy", "Bypass", "-File", script],
        {
          windowsHide: true,
          env: {
            ...process.env,
            ABRIDGE_CANCEL_FILE: join(this.directory, "cancel"),
            ABRIDGE_OCCLUSION_DIAGNOSTIC: join(this.directory, "last-occlusion.json"),
            ABRIDGE_PROTECTED_PIDS: [process.pid, process.env.ABRIDGE_PROTECTED_PIDS ?? ""].join(","),
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      this.child = child;
      child.stderr.resume();
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        const pending = this.pending;
        if (!pending) return;
        try {
          const reply = JSON.parse(line) as {
            id: number;
            ok: boolean;
            data: unknown;
            error?: string;
            outcome?: "refused" | "outcome_unknown";
          };
          if (reply.id !== pending.id) return;
          this.pending = undefined;
          if (reply.ok) pending.resolve(reply.data);
          else
            pending.reject(
              new DesktopError(
                reply.error ?? "native_error",
                reply.error === "focus_changed"
                  ? "Target window is not in the foreground or focus changed. Activate the intended existing application, then observe its window again."
                  : (reply.error ?? "Windows driver failed"),
                reply.outcome ?? "outcome_unknown",
              ),
            );
        } catch {
          this.fail();
        }
      });
      child.on("error", () => {
        if (this.child === child) this.fail();
      });
      child.on("exit", () => {
        if (this.child === child) {
          this.child = undefined;
          this.fail();
        }
        lines.close();
      });
    })().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  private fail(): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(
      new DesktopError("outcome_unknown", "Windows helper reply was lost; observe again", "outcome_unknown"),
    );
  }
  private call<T>(op: string, args: unknown, signal?: AbortSignal): Promise<T> {
    const run = async (): Promise<T> => {
      checkAbort(signal);
      await this.start();
      checkAbort(signal);
      return new Promise<T>((resolve, reject) => {
        const id = ++this.sequence;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const abort = () => {
          // Cooperative cancellation gives the helper's finally blocks time to release held keys.
          try {
            writeFileSync(join(this.directory!, "cancel"), String(id));
          } catch {}
          killTimer ??= setTimeout(() => {
            this.child?.kill();
            this.fail();
          }, 5000);
        };
        const timer = setTimeout(abort, 30000);
        const cleanup = () => {
          clearTimeout(timer);
          clearTimeout(killTimer);
          signal?.removeEventListener("abort", abort);
        };
        this.pending = {
          id,
          resolve: (value) => {
            cleanup();
            resolve(value as T);
          },
          reject: (error) => {
            cleanup();
            reject(error);
          },
        };
        signal?.addEventListener("abort", abort, { once: true });
        this.child!.stdin.write(JSON.stringify({ id, op, args }) + "\n", (error) => {
          if (error) abort();
        });
      });
    };
    const task = this.queue.catch(() => {}).then(run);
    this.queue = task;
    return task;
  }
  async diagnostics(initialize = true): Promise<Record<string, unknown>> {
    if (!initialize) return this.lastDiagnostics;
    try {
      this.lastDiagnostics = await this.call("diagnostics", {});
    } catch (error) {
      this.lastDiagnostics = {
        driver: { ready: false, error: error instanceof DesktopError ? error.code : "driver_unavailable" },
        permissions: { checked: true, screen: false, input: false },
      };
    }
    return this.lastDiagnostics;
  }
  apps(signal?: AbortSignal): Promise<AppInfo[]> {
    return this.call("apps", {}, signal);
  }
  windows(pid?: number, signal?: AbortSignal): Promise<WindowInfo[]> {
    return this.call("windows", { pid }, signal);
  }
  async open(bundleId: string, signal?: AbortSignal): Promise<void> {
    await this.call("open", { bundle_id: bundleId }, signal);
  }
  observe(
    sessionId: string,
    target: Target,
    screenshot: boolean,
    signal?: AbortSignal,
  ): Promise<NativeObservation> {
    return this.call("observe", { session: sessionId, target, screenshot }, signal);
  }
  act(sessionId: string, action: NativeAction, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.call("act", { session: sessionId, ...action }, signal);
  }
  async release(sessionId: string): Promise<void> {
    if (this.child) await this.call("release", { session: sessionId });
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.pending && this.directory) {
      try {
        writeFileSync(join(this.directory, "cancel"), String(this.pending.id));
      } catch {}
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.queue.catch(() => {}),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 5000);
        }),
      ]);
      clearTimeout(timer);
    }
    this.child?.kill();
    this.fail();
    await this.starting?.catch(() => {});
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}
