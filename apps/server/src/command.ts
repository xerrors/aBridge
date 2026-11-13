#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { defaultDataDirectory } from "@abridge/shared/paths";
import { VERSION } from "@abridge/protocol";

async function openWeb(url: string): Promise<void> {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
  await new Promise<void>((ok, fail) => {
    const child = spawn(command, [url], { stdio: "ignore", windowsHide: true });
    child.once("error", fail);
    child.once("exit", (code) => (code === 0 ? ok() : fail(new Error("No browser opener is available"))));
  });
}
const help = `aBridge ${VERSION}\n\nUsage: abridge [serve] [--web] [--host 127.0.0.1] [--port 8765]\n\nServer options:\n  --db <file>              Persistent SQLite database\n  --data-dir <dir>         Persistent application state\n  --public-origin <url>    Trusted external HTTPS origin behind a proxy\n  --allowed-hosts <list>   Additional exact Host values, comma-separated\n  --allowed-origins <list> Additional MCP origins, comma-separated\n  --web                   Open the instance administration console\n  --reset-admin-token     Generate a new administrator token and invalidate admin sessions\n  --version               Print version\n`;
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
      "reset-admin-token": { type: "boolean" },
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
  if (
    process.env.ABRIDGE_DELEGATION_ENABLED &&
    !["true", "false"].includes(process.env.ABRIDGE_DELEGATION_ENABLED)
  )
    throw new Error("ABRIDGE_DELEGATION_ENABLED must be true or false");
  const server = await createServer({
    dbPath,
    identity: {
      issuer: process.env.ABRIDGE_OIDC_ISSUER_URL,
      backchannelOrigin: process.env.ABRIDGE_OIDC_BACKCHANNEL_ORIGIN,
      clientId: process.env.ABRIDGE_OIDC_CLIENT_ID,
      clientSecret: process.env.ABRIDGE_OIDC_CLIENT_SECRET,
      delegationEnabled: process.env.ABRIDGE_DELEGATION_ENABLED === "true",
    },
    adminToken: process.env.ABRIDGE_ADMIN_TOKEN,
    resetAdminToken: values["reset-admin-token"],
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
    const adminUrl = new URL(values["public-origin"] ?? process.env.ABRIDGE_PUBLIC_ORIGIN ?? url);
    adminUrl.hash = new URLSearchParams({ admin_token: server.adminToken }).toString();
    console.log(`Admin console: ${adminUrl.origin}`);
    if (values.web) {
      try {
        await openWeb(adminUrl.href);
      } catch {
        console.error("Could not open a browser. Open the Admin console URL printed above.");
      }
    }
  } catch (error) {
    process.off("SIGINT", close);
    process.off("SIGTERM", close);
    await server.close();
    throw error;
  }
}
