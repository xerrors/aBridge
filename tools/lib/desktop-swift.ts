import { readdir } from "node:fs/promises";
import { join } from "node:path";

export const desktopTarget = "arm64-apple-macosx14.0";
export const desktopRuntimeExecutables = ["abridge-desktop", "abridge-desktop-http"] as const;

export async function desktopSwiftTargets(root: string) {
  const native = join(root, "apps/desktop/native");
  const runtime = join(native, "runtime");
  const sources = (await readdir(runtime))
    .filter((name) => !name.startsWith(".") && name.endsWith(".swift") && !name.startsWith("Updater"))
    .sort()
    .map((name) => join(runtime, name));
  const swift6 = ["-swift-version", "6", "-target", desktopTarget];
  const deviceRuntime = [
    ...swift6,
    "-import-objc-header",
    join(runtime, "cua_driver_abi.h"),
    ...sources,
    "-framework",
    "ApplicationServices",
  ];

  return {
    aBridge: [
      "-target",
      desktopTarget,
      join(native, "aBridge.swift"),
      join(native, "main.swift"),
      join(runtime, "DeviceServerTransport.swift"),
      "-framework",
      "AppKit",
      "-framework",
      "ApplicationServices",
    ],
    "abridge-desktop": deviceRuntime,
    "abridge-desktop-http": [...deviceRuntime, "-D", "ABRIDGE_CONFIRMED_HTTP"],
    "abridge-updater": [...swift6, join(runtime, "Updater.swift"), join(runtime, "UpdaterMain.swift")],
  };
}
