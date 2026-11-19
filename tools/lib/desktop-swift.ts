import { readdir } from "node:fs/promises";
import { join } from "node:path";

export const desktopTarget = "arm64-apple-macosx14.0";

export async function desktopSwiftTargets(root: string) {
  const native = join(root, "apps/desktop/native");
  const runtime = join(native, "runtime");
  const sources = (await readdir(runtime))
    .filter((name) => !name.startsWith(".") && name.endsWith(".swift") && !name.startsWith("Updater"))
    .sort()
    .map((name) => join(runtime, name));
  const swift6 = ["-swift-version", "6", "-target", desktopTarget];

  return {
    aBridge: [
      "-target",
      desktopTarget,
      join(native, "aBridge.swift"),
      "-framework",
      "AppKit",
      "-framework",
      "ApplicationServices",
    ],
    "abridge-desktop": [
      ...swift6,
      "-import-objc-header",
      join(runtime, "cua_driver_abi.h"),
      ...sources,
      "-framework",
      "ApplicationServices",
    ],
    "abridge-updater": [...swift6, join(runtime, "Updater.swift"), join(runtime, "UpdaterMain.swift")],
  };
}
