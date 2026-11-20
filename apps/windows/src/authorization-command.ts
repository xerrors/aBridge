import { createInterface } from "node:readline";
import { z } from "zod";
import { deviceBindingInputSchema } from "@abridge/protocol";
import { normalizeServerUrl } from "./storage.js";
import { authorizeDevice, verifyDesktopToken } from "./authorization.js";
import { configureClient } from "./runtime.js";
import { DesktopError } from "./errors.js";

/** A two-phase private pipe: consent first, then commit after the UI stops the old runtime. */
export async function authorizationCommand(stateDir: string): Promise<void> {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines = input[Symbol.asyncIterator]();
  const abort = new AbortController();
  const cancel = () => abort.abort();
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(300000)]);
  const parent = Number(process.env.ABRIDGE_PARENT_PID);
  const monitor =
    Number.isSafeInteger(parent) && parent > 0
      ? setInterval(() => {
          if (process.platform === "win32") {
            // Windows retains the original ppid after its parent exits.
            try {
              process.kill(parent, 0);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ESRCH") cancel();
            }
          } else if (process.ppid !== parent) cancel();
        }, 500)
      : undefined;
  process.once("SIGTERM", cancel);
  process.once("SIGINT", cancel);
  input.once("close", cancel);
  const emit = (value: unknown) => console.log(JSON.stringify(value));
  const next = async (): Promise<unknown> => {
    signal.throwIfAborted();
    let listener!: () => void;
    try {
      const line = await Promise.race([
        lines.next(),
        new Promise<never>((_resolve, reject) => {
          listener = () => reject(new DesktopError("authorization_cancelled", "授权已取消或过期"));
          signal.addEventListener("abort", listener, { once: true });
        }),
      ]);
      if (line.done || line.value.length > 65536) throw new DesktopError("invalid_arguments", "授权输入无效");
      return JSON.parse(line.value);
    } finally {
      signal.removeEventListener("abort", listener);
    }
  };
  try {
    const start = deviceBindingInputSchema.parse(await next());
    const url = normalizeServerUrl(start.url, start.http_confirmed_origin);
    let key: string;
    if (start.device_key) {
      await verifyDesktopToken(url, start.device_key, start.http_confirmed_origin, signal);
      key = start.device_key;
    } else {
      const result = await authorizeDevice(url, {
        signal,
        onAuthorization: emit,
        httpConfirmedOrigin: start.http_confirmed_origin,
      });
      key = result.device.key;
    }
    emit({ event: "ready" });
    const commit = z
      .object({ command: z.literal("commit"), capabilities: z.record(z.string(), z.boolean()) })
      .strict()
      .parse(await next());
    signal.throwIfAborted();
    await configureClient(stateDir, {
      url,
      device_key: key,
      http_confirmed_origin: start.http_confirmed_origin,
      capabilities: commit.capabilities,
    });
    emit({ event: "complete", ok: true, url });
  } catch (error) {
    emit({
      event: "error",
      error: signal.aborted
        ? "授权已取消或过期，请重新发起"
        : error instanceof Error
          ? error.message
          : "浏览器授权失败",
    });
    process.exitCode = 1;
  } finally {
    if (monitor) clearInterval(monitor);
    process.off("SIGTERM", cancel);
    process.off("SIGINT", cancel);
    input.off("close", cancel);
    input.close();
  }
}
