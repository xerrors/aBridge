import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { defaultDataDirectory } from "@abridge/shared/paths";
import { startDeviceClient, configureClient, getStatus } from "./runtime.js";
import { localControl } from "./local-control.js";
import { LocalExecutor } from "./executor.js";
import { authorizationCommand } from "./authorization-command.js";
async function stdinJson(): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of process.stdin) {
    text += String(chunk);
    if (Buffer.byteLength(text) > 65536) throw new Error("Input exceeds 64 KiB");
  }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("A JSON object is required");
  return value as Record<string, unknown>;
}
export async function desktopMain(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      "state-dir": { type: "string" },
      stdin: { type: "boolean" },
      json: { type: "boolean" },
      "if-desktop-active": { type: "boolean" },
      capability: { type: "string" },
      enabled: { type: "string" },
      name: { type: "string" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: abridge-desktop <run|authorize --stdin|configure --stdin|status|control <command>|diagnose> [--state-dir <dir>]",
    );
    return;
  }
  const stateDir = resolve(values["state-dir"] ?? defaultDataDirectory()),
    action = positionals[0] ?? "status";
  if (action === "run") {
    const parent = Number(process.env.ABRIDGE_PARENT_PID);
    await startDeviceClient(stateDir, {
      ...(Number.isSafeInteger(parent) && parent > 0 ? { parentPid: parent } : {}),
    });
    return;
  }
  if (action === "authorize") {
    if (!values.stdin) throw new Error("Use authorize --stdin");
    await authorizationCommand(stateDir);
    return;
  }
  if (action === "configure") {
    if (!values.stdin)
      throw new Error("Use configure --stdin; credentials must not be command-line arguments");
    const data = await stdinJson();
    if (typeof data.url !== "string" || typeof data.device_key !== "string")
      throw new Error("url and device_key are required");
    const config = await configureClient(stateDir, {
      url: data.url,
      device_key: data.device_key,
      ...(data.capabilities ? { capabilities: data.capabilities as Record<string, boolean> } : {}),
    });
    console.log(JSON.stringify({ ok: true, ...config }));
    return;
  }
  if (action === "status") {
    console.log(JSON.stringify(await getStatus(stateDir)));
    return;
  }
  if (action === "control") {
    const operation = positionals[1];
    if (!operation) throw new Error("A local control command is required");
    if (values.enabled !== undefined && !["true", "false"].includes(values.enabled))
      throw new Error("--enabled must be true or false");
    const result = await localControl(stateDir, {
      command: operation,
      ...(values["if-desktop-active"] ? { if_desktop_active: true } : {}),
      ...(values.capability ? { capability: values.capability } : {}),
      ...(values.enabled ? { enabled: values.enabled === "true" } : {}),
      ...(values.name !== undefined ? { name: values.name } : {}),
    });
    console.log(JSON.stringify({ ok: true, ...result }));
    return;
  }
  if (action === "diagnose") {
    const runtime = new LocalExecutor();
    try {
      console.log(JSON.stringify(await runtime.diagnostics()));
    } finally {
      await runtime.shutdown();
    }
    return;
  }
  throw new Error(`Unknown client command: ${action}`);
}
