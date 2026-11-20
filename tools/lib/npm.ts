/** Run npm's Node entry point on Windows; npm.cmd is not a native executable. */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export function npmInvocation(args: string[]): { command: string; args: string[] } {
  if (process.platform !== "win32") return { command: "npm", args };
  const cli = process.env.npm_execpath ?? join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  if (!existsSync(cli)) throw Error("Run this build/check from npm so its CLI path is available");
  return { command: process.execPath, args: [cli, ...args] };
}
