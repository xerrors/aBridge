/** Generate the shared contract before building/testing the Windows native runtime. */
import { writeWindowsContract } from "./lib/windows-native-contract.js";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const action = process.argv[2];
if (!["contract", "check"].includes(action ?? "")) throw Error("Expected contract or check");
const contract = resolve(root, ".local/build/windows-native/contract.json");
writeWindowsContract(root, contract);
if (action === "check") {
  const manifest = resolve(root, "apps/windows/windows-native-shell/Cargo.toml");
  for (const args of [
    ["fmt", "--manifest-path", manifest, "--", "--check"],
    ["test", "--manifest-path", manifest, "--locked"],
    ["clippy", "--manifest-path", manifest, "--locked", "--all-targets", "--", "-D", "warnings"],
  ]) {
    const result = spawnSync(process.env.CARGO ?? "cargo", args, {
      cwd: dirname(manifest),
      env: { ...process.env, ABRIDGE_CONTRACT_PATH: contract },
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.error || result.status !== 0)
      throw Error(`Windows native ${args[0]} failed`, { cause: result.error });
  }
}
