import { globSync } from "node:fs";
import { spawnSync } from "node:child_process";
const files = [
  ...new Set([
    ...globSync("packages/**/tests/**/*.test.ts"),
    ...globSync("apps/**/tests/**/*.test.ts"),
    ...globSync("apps/browser/tests/*.test.js"),
    ...globSync("tools/tests/*.test.ts"),
  ]),
].sort();
if (!files.length) throw new Error("No tests found");
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], { stdio: "inherit" });
process.exitCode = result.status ?? 1;
