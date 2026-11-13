import { hostname } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** macOS 使用系统电脑名称，其他平台或读取失败时使用主机名。 */
export async function defaultDeviceName(): Promise<string> {
  if (process.platform === "darwin") {
    try {
      const { stdout } = await promisify(execFile)("/usr/sbin/scutil", ["--get", "ComputerName"], {
        timeout: 1000,
        maxBuffer: 4096,
      });
      if (stdout.trim()) return stdout.trim().slice(0, 80);
    } catch {}
  }
  return hostname().trim().slice(0, 80) || "Computer";
}
