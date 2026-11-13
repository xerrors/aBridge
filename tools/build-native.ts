/** Build a signed AppKit shell; unchanged inputs preserve its existing signature. */
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { access, chmod, cp, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./lib/process.js";
import { signBundledRuntime } from "./lib/sign-runtime.js";
export const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const ICONS = [
  "AppIcon.icns",
  "AppIcon.png",
  "StatusIcon.png",
  "StatusIcon@2x.png",
  "Wordmark.png",
  "Wordmark@2x.png",
] as const;
export type NativeBuildOptions = {
  output: string;
  node: string;
  cli: string;
  stateDir?: string;
  force?: boolean;
  signingIdentity: string;
  bundledRuntime?: string;
};
export function parseNativeBuildOptions(args: string[]): NativeBuildOptions {
  const parsed = parseArgs({
    args,
    options: {
      output: { type: "string" },
      node: { type: "string" },
      cli: { type: "string" },
      "state-dir": { type: "string" },
      force: { type: "boolean" },
      "signing-identity": { type: "string" },
    },
    strict: true,
  });
  for (const key of ["output", "node", "cli"] as const)
    if (!parsed.values[key]) throw Error(`--${key} is required`);
  return {
    output: resolve(parsed.values.output!),
    node: resolve(parsed.values.node!),
    cli: resolve(parsed.values.cli!),
    stateDir: resolve(parsed.values["state-dir"] ?? join(homedir(), "Library/Application Support/aBridge")),
    force: parsed.values.force ?? false,
    signingIdentity: parsed.values["signing-identity"] ?? process.env.ABRIDGE_SIGNING_IDENTITY ?? "-",
  };
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => JSON.stringify(key) + ":" + canonical(v))
      .join(",")}}`;
  return JSON.stringify(value);
}
export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
export function plist(info: Record<string, string | boolean>): string {
  const escape = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n${Object.entries(
    info,
  )
    .map(
      ([key, value]) =>
        `<key>${escape(key)}</key>${typeof value === "boolean" ? (value ? "<true/>" : "<false/>") : `<string>${escape(value)}</string>`}`,
    )
    .join("\n")}\n</dict></plist>\n`;
}
async function existing(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
export async function nativeBuildInputs(
  options: NativeBuildOptions,
  root = PROJECT_ROOT,
): Promise<{
  fingerprint: string;
  info: Record<string, string | boolean>;
  runtime: Record<string, string>;
  target: string;
}> {
  const packageInfo = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
  const info = {
    CFBundleName: "aBridge",
    CFBundleDisplayName: "aBridge",
    CFBundleIdentifier: "dev.abridge.client",
    CFBundleExecutable: "aBridge",
    CFBundlePackageType: "APPL",
    CFBundleShortVersionString: packageInfo.version,
    CFBundleVersion: packageInfo.version,
    CFBundleIconFile: "AppIcon",
    LSMinimumSystemVersion: "14.0",
    LSUIElement: true,
    NSHighResolutionCapable: true,
    NSScreenCaptureUsageDescription: "aBridge 仅在你启用截图后向已授权的 Agent 提供屏幕画面。",
    NSAccessibilityUsageDescription: "aBridge 仅在你启用桌面输入后执行已授权 Agent 的鼠标和键盘操作。",
  };
  const runtime: Record<string, string> = options.bundledRuntime
      ? { runtime_mode: "bundled" }
      : {
          node_path: resolve(options.node),
          cli_path: resolve(options.cli),
          state_dir: resolve(options.stateDir ?? join(homedir(), "Library/Application Support/aBridge")),
        },
    target = "arm64-apple-macosx14.0";
  const files = [
    "apps/desktop/native/aBridge.swift",
    "apps/desktop/native/setup.html",
    "docs/third-party-notices.md",
    "LICENSE",
    "tools/build-native.ts",
    "tools/lib/process.ts",
    ...ICONS.map((name) => "apps/desktop/native/assets/" + name),
  ];
  const hashes = Object.fromEntries(
    await Promise.all(files.map(async (path) => [path, sha256(await readFile(join(root, path)))])),
  );
  return {
    fingerprint: sha256(
      canonical({
        hashes,
        info,
        runtime,
        target,
        signing_identity: options.signingIdentity,
        optimization: "-O",
      }),
    ),
    info,
    runtime,
    target,
  };
}
export async function buildNative(
  options: NativeBuildOptions,
  root = PROJECT_ROOT,
): Promise<{ app: string; fingerprint: string; reused: boolean; executable_sha256: string }> {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw Error("Native builds require Apple Silicon macOS 14+");
  await access(options.node, constants.X_OK);
  await access(options.cli, constants.R_OK);
  if (!options.signingIdentity) throw Error("A signing identity is required");
  if (options.bundledRuntime && !options.force)
    throw Error("Bundled runtime builds require force to include current runtime bytes");
  const app = resolve(options.output);
  if (!app.endsWith(".app")) throw Error("--output must end in .app");
  if (await existing(app)) {
    const stat = await lstat(app);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw Error("App output must be a directory, not a symbolic link");
  }
  const inputs = await nativeBuildInputs(options, root),
    executable = join(app, "Contents/MacOS/aBridge"),
    manifest = join(app, "Contents/Resources/native-build.json");
  if (!options.force && (await existing(manifest)) && (await existing(executable))) {
    const previous = JSON.parse(await readFile(manifest, "utf8")) as {
      fingerprint: string;
      executable_sha256: string;
    };
    const digest = sha256(await readFile(executable));
    if (previous.fingerprint === inputs.fingerprint) {
      await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
      return { app, fingerprint: inputs.fingerprint, reused: true, executable_sha256: digest };
    }
  }
  await mkdir(dirname(app), { recursive: true });
  const staging = app + ".build-" + randomUUID(),
    backup = app + ".previous-" + randomUUID();
  let previousMoved = false;
  try {
    const macos = join(staging, "Contents/MacOS"),
      resources = join(staging, "Contents/Resources");
    await mkdir(macos, { recursive: true });
    await mkdir(resources, { recursive: true });
    await run(
      "/usr/bin/swiftc",
      [
        "-O",
        "-target",
        inputs.target,
        join(root, "apps/desktop/native/aBridge.swift"),
        "-o",
        join(macos, "aBridge"),
        "-framework",
        "AppKit",
        "-framework",
        "ApplicationServices",
      ],
      { env: { ...process.env, MACOSX_DEPLOYMENT_TARGET: "14.0" } },
    );
    await chmod(join(macos, "aBridge"), 0o755);
    await writeFile(join(staging, "Contents/Info.plist"), plist(inputs.info));
    for (const name of ICONS) await cp(join(root, "apps/desktop/native/assets", name), join(resources, name));
    await writeFile(join(resources, "runtime.json"), JSON.stringify(inputs.runtime, null, 2) + "\n");
    await cp(join(root, "apps/desktop/native/setup.html"), join(resources, "setup.html"));
    await cp(join(root, "docs/third-party-notices.md"), join(resources, "third-party-notices.txt"));
    await cp(join(root, "LICENSE"), join(resources, "LICENSE"));
    await writeFile(
      join(resources, "native-build.json"),
      JSON.stringify({ fingerprint: inputs.fingerprint }, null, 2) + "\n",
    );
    if (options.bundledRuntime) {
      await cp(options.bundledRuntime, join(resources, "runtime"), { recursive: true });
      await signBundledRuntime(join(resources, "runtime"), options.signingIdentity);
    }
    await run("/usr/bin/codesign", [
      ...(options.signingIdentity === "-" ? [] : ["--options", "runtime", "--timestamp"]),
      "--force",
      "--sign",
      options.signingIdentity,
      "--identifier",
      "dev.abridge.client",
      staging,
    ]);
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", staging]);
    if (await existing(app)) {
      await rename(app, backup);
      previousMoved = true;
    }
    try {
      await rename(staging, app);
    } catch (error) {
      if (previousMoved) {
        await rename(backup, app);
        previousMoved = false;
      }
      throw error;
    }
    if (previousMoved) {
      await rm(backup, { recursive: true, force: true });
      previousMoved = false;
    }
    return {
      app,
      fingerprint: inputs.fingerprint,
      reused: false,
      executable_sha256: sha256(await readFile(executable)),
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await buildNative(parseNativeBuildOptions(process.argv.slice(2))), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Native build failed");
    process.exitCode = 1;
  }
}
