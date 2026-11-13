#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { defaultDataDirectory } from "@abridge/shared/paths";
import { VERSION } from "@abridge/protocol";

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
async function openWeb(url: string): Promise<void> {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
  await new Promise<void>((ok, fail) => {
    const child = spawn(command, [url], { stdio: "ignore", windowsHide: true });
    child.once("error", fail);
    child.once("exit", (code) => (code === 0 ? ok() : fail(new Error("No browser opener is available"))));
  });
}
const help = `aBridge ${VERSION}\n\nUsage: abridge [serve] [--web] [--host 127.0.0.1] [--port 8765]\n       abridge user create --stdin [--db <file>]\n\nServer options:\n  --db <file>              Persistent SQLite database\n  --data-dir <dir>         Persistent application state\n  --public-origin <url>    Trusted external HTTPS origin behind a proxy\n  --allowed-hosts <list>   Additional exact Host values, comma-separated\n  --allowed-origins <list> Additional MCP origins, comma-separated\n  --web                   Open the local management console\n  --version               Print version\n`;
export async function serverMain(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
      web: { type: "boolean" },
      host: { type: "string" },
      port: { type: "string" },
      db: { type: "string" },
      "data-dir": { type: "string" },
      "public-origin": { type: "string" },
      "allowed-hosts": { type: "string" },
      "allowed-origins": { type: "string" },
      stdin: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(help);
    return;
  }
  if (values.version) {
    console.log(VERSION);
    return;
  }
  const command = positionals[0] ?? "serve",
    dataDir = resolve(values["data-dir"] ?? defaultDataDirectory()),
    dbPath = resolve(values.db ?? process.env.ABRIDGE_DB ?? join(dataDir, "server", "server.db"));

  if (command === "user") {
    if (positionals[1] !== "create" || !values.stdin)
      throw new Error("Use user create --stdin with a JSON username/password object");
    const data = await stdinJson();
    if (typeof data.username !== "string" || typeof data.password !== "string")
      throw new Error("username and password are required");
    const { Store } = await import("./store.js");
    const store = new Store(dbPath);
    try {
      const user = await store.createUser(data.username, data.password);
      console.log(JSON.stringify(user));
    } finally {
      store.close();
    }
    return;
  }
  if (command !== "serve") throw new Error(`Unknown command: ${command}`);
  const { createServer } = await import("./server.js");
  const port = Number(values.port ?? process.env.ABRIDGE_PORT ?? 8765);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("port must be 0–65535");
  const split = (value: string | undefined) =>
    value
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const staticRoot = resolve(dirname(fileURLToPath(import.meta.url)), "web");
  await access(join(staticRoot, "index.html"));
  const server = await createServer({
    dbPath,
    host: values.host ?? process.env.ABRIDGE_HOST ?? "127.0.0.1",
    port,
    staticRoot,
    allowedHosts: split(values["allowed-hosts"] ?? process.env.ABRIDGE_ALLOWED_HOSTS),
    allowedOrigins: split(values["allowed-origins"] ?? process.env.ABRIDGE_ALLOWED_ORIGINS),
    publicOrigin: values["public-origin"] ?? process.env.ABRIDGE_PUBLIC_ORIGIN,
  });
  const close = () => {
    void server.close().catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  try {
    const url = await server.start();
    console.log(`aBridge ${VERSION}: ${url}`);
    if (values.web) {
      try {
        await openWeb(
          (values["public-origin"] ?? process.env.ABRIDGE_PUBLIC_ORIGIN ?? url) +
            (server.setupToken ? `/#setup=${server.setupToken}` : ""),
        );
      } catch {
        console.error("Could not open a browser. Use user create --stdin to configure an empty server.");
      }
    } else if (server.setupToken) {
      console.error(
        "No management account exists. Create one with abridge user create --stdin or start with --web.",
      );
    }
  } catch (error) {
    process.off("SIGINT", close);
    process.off("SIGTERM", close);
    await server.close();
    throw error;
  }
}
