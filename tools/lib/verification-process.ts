/** Exercise real CLI shutdown handlers without assuming POSIX signal delivery on Windows. */
import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from "node:child_process";
const preload = new URL("../fixtures/graceful-stop.mjs", import.meta.url).href;

export function spawnVerificationProcess(args: string[], options: SpawnOptionsWithoutStdio) {
  return spawn(process.execPath, [...(process.platform === "win32" ? ["--import", preload] : []), ...args], {
    ...options,
    windowsHide: true,
    stdio: process.platform === "win32" ? ["pipe", "pipe", "pipe", "ipc"] : ["pipe", "pipe", "pipe"],
  });
}

export async function stopVerificationProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    if (!child.connected) throw Error("Verification child has no shutdown channel");
    await new Promise<void>((resolve, reject) =>
      child.send!("abridge-test-stop", (error) => (error ? reject(error) : resolve())),
    );
  } else child.kill("SIGTERM");
}
