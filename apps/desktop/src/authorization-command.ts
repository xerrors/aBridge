import { createInterface } from "node:readline";
import { z } from "zod";
import { authorizeDevice } from "./authorization.js";
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
          if (process.ppid !== parent) cancel();
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
    const start = z
      .object({ url: z.string().min(1) })
      .strict()
      .parse(await next());
    const result = await authorizeDevice(start.url, { signal, onAuthorization: emit });
    emit({ event: "ready" });
    const commit = z
      .object({ command: z.literal("commit"), capabilities: z.record(z.string(), z.boolean()) })
      .strict()
      .parse(await next());
    signal.throwIfAborted();
    await configureClient(stateDir, {
      url: result.url,
      device_key: result.device.key,
      capabilities: commit.capabilities,
    });
    emit({ event: "complete", ok: true, url: result.url });
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
