/** Configuration and process lifecycle, independent of device connection state. */
import { join } from "node:path";
import { DESKTOP_CAPABILITIES } from "@abridge/protocol";
import { DeviceClient } from "./client.js";
import { LocalExecutor } from "./executor.js";
import { DesktopError, record } from "./errors.js";
import { localControl } from "./local-control.js";
import {
  type ClientConfig,
  loadConfig,
  loadCredential,
  saveConfig,
  saveCredential,
  readPrivateJson,
  normalizeServerUrl,
} from "./storage.js";
export async function configureClient(
  stateDir: string,
  request: { url: string; device_key: string; capabilities?: Record<string, boolean> },
): Promise<ClientConfig> {
  if (
    typeof request.url !== "string" ||
    typeof request.device_key !== "string" ||
    (request.capabilities !== undefined &&
      (!record(request.capabilities) ||
        Object.entries(request.capabilities).some(
          ([cap, value]) =>
            !DESKTOP_CAPABILITIES.includes(cap as (typeof DESKTOP_CAPABILITIES)[number]) ||
            typeof value !== "boolean",
        )))
  )
    throw new DesktopError("invalid_arguments", "Invalid desktop binding");
  const url = normalizeServerUrl(request.url);
  let previous: ClientConfig | undefined;
  try {
    previous = await loadConfig(stateDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const capabilities = Object.fromEntries(
    DESKTOP_CAPABILITIES.map((cap) => [cap, request.capabilities?.[cap] ?? false]),
  );
  const config: ClientConfig = {
    url,
    capabilities,
    paused: previous?.paused ?? false,
    ...(previous?.pause_reason ? { pause_reason: previous.pause_reason } : {}),
  };
  await saveCredential(stateDir, url, request.device_key);
  await saveConfig(stateDir, config);
  return config;
}
export async function getStatus(stateDir: string): Promise<Record<string, unknown>> {
  try {
    return await localControl(stateDir, { command: "status" });
  } catch {
    try {
      const value = await readPrivateJson(join(stateDir, "status.json"), 131072);
      return record(value)
        ? { ...value, connection: "offline", active_operations: 0 }
        : { connection: "offline" };
    } catch {
      return { connection: "offline" };
    }
  }
}
export async function startDeviceClient(
  stateDir: string,
  options: { executor?: LocalExecutor; parentPid?: number } = {},
): Promise<void> {
  const config = await loadConfig(stateDir);
  const key = await loadCredential(stateDir, config.url);
  const client = new DeviceClient({ stateDir, config, deviceKey: key, ...options });
  const stop = () => {
    void client.stop();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await client.run();
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}
