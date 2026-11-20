/** Simulated CLI over real pipes and authenticated local IPC; never connects to a server. */
import { appendFile, access } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { listenLocalControl } from "../../apps/windows/src/local-control.js";
import { configureClient } from "../../apps/windows/src/runtime.js";
import { loadConfig, saveConfig } from "../../apps/windows/src/storage.js";
const stateDir = process.argv[process.argv.indexOf("--state-dir") + 1];
if (!stateDir || !stateDir.includes("windows-shell-test-")) throw Error("Fixture state path required");
const log = join(stateDir, "fixture-events.log");
const event = (name: string) => appendFile(log, name + "\n");
await event(`child-start:${process.pid}`);
process.on("exit", () => appendFileSync(log, `child-exit:${process.pid}\n`));
const exists = async (name: string) =>
  access(join(stateDir, name)).then(
    () => true,
    () => false,
  );
if (process.argv.includes("authorize")) {
  await event("authorize-start");
  let input: { url: string; device_key: string } | undefined;
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    const value = JSON.parse(line);
    if (!input) {
      input = value;
      console.log(
        JSON.stringify({ event: "authorization", authorization_url: new URL("/authorize", input!.url).href }),
      );
      console.log(JSON.stringify({ event: "ready" }));
    } else if (value.command === "commit") {
      await event("commit");
      while (await exists("hold-commit")) await delay(20);
      await configureClient(stateDir, { ...input!, capabilities: value.capabilities });
      await event("commit-saved");
      console.log(JSON.stringify({ event: "complete" }));
      break;
    }
  }
  lines.close();
  process.stdin.pause();
  await event("authorize-exit");
} else if (process.argv.includes("run")) {
  await event("run-start");
  const control = await listenLocalControl(stateDir, async (request) => {
    try {
      const config = await loadConfig(stateDir);
      if (request.command === "status")
        return {
          connection: "online",
          url: config.url,
          paused: config.paused,
          capabilities: config.capabilities,
        };
      if (request.command === "shutdown") {
        await event("shutdown-start");
        while (await exists("hold-shutdown")) await delay(20);
        setTimeout(() => {
          void control.close().then(() => process.exit(0));
        }, 50);
        return { shutdown_requested: true };
      }
      if (request.command === "unbind") {
        await saveConfig(stateDir, { ...config, revoked: true });
        return { unbound: true };
      }
      if (request.command === "pause" || request.command === "resume") {
        await saveConfig(stateDir, { ...config, paused: request.command === "pause" });
        await event(String(request.command));
        return { paused: request.command === "pause" };
      }
      if (
        request.command === "capability" &&
        typeof request.capability === "string" &&
        typeof request.enabled === "boolean"
      ) {
        await saveConfig(stateDir, {
          ...config,
          capabilities: { ...config.capabilities, [request.capability]: request.enabled },
        });
        await event(`capability:${request.capability}:${request.enabled}`);
        return {};
      }
      throw Error("Unsupported fixture command");
    } catch (error) {
      // This fixture has synthetic state only; preserve the cause in test failures.
      await event(`fixture-error:${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  });
  await event("run-ready");
} else throw Error("Unknown fixture mode");
