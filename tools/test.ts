import { globSync } from "node:fs";
import { spawnSync } from "node:child_process";
const files = [
  ...new Set([
    ...globSync("packages/*/tests/**/*.test.ts"),
    ...globSync("apps/*/tests/**/*.test.ts"),
    ...globSync("apps/browser/tests/*.test.js"),
    ...globSync("tools/tests/*.test.ts"),
  ]),
].sort();
if (!files.length) throw new Error("No tests found");
const result = spawnSync(
  process.execPath,
  // Windows suites launch PowerShell and native helpers. Run files serially so
  // cold startup on hosted runners does not compete with other suites' startup.
  ["--import", "tsx", "--test", ...(process.platform === "win32" ? ["--test-concurrency=1"] : []), ...files],
  { stdio: "inherit" },
);
process.exitCode = result.status ?? 1;
