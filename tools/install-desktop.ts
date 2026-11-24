/** Install the self-contained native macOS application. */
import { parseArgs } from "node:util";
import { homedir, tmpdir } from "node:os";
import { chmod, lstat, mkdir, mkdtemp, rm, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { buildNative, PROJECT_ROOT } from "./build-native.js";
import { desktopRuntimeExecutables } from "./lib/desktop-swift.js";
import { run } from "./lib/process.js";
export type DesktopInstallOptions = {
  app: string;
  stateDir: string;
  force: boolean;
  signingIdentity: string;
};
export function parseDesktopInstallOptions(
  args: string[],
  home = homedir(),
  _root = PROJECT_ROOT,
): DesktopInstallOptions {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      app: { type: "string" },
      "state-dir": { type: "string" },
      force: { type: "boolean" },
      "signing-identity": { type: "string" },
    },
  });
  return {
    app: resolve(values.app ?? join(home, "Applications/aBridge.app")),
    stateDir: resolve(values["state-dir"] ?? join(home, "Library/Application Support/aBridge")),
    force: values.force ?? false,
    signingIdentity: values["signing-identity"] ?? process.env.ABRIDGE_SIGNING_IDENTITY ?? "-",
  };
}
export function controlSocketPath(stateDir: string): string {
  const standard = join(stateDir, "control.sock");
  return Buffer.byteLength(standard) < 100
    ? standard
    : `/tmp/abridge-${process.getuid?.() ?? "user"}-${createHash("sha256").update(stateDir).digest("hex").slice(0, 24)}.sock`;
}
export async function assertClientStopped(stateDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(controlSocketPath(stateDir));
    socket.setTimeout(1000, () => {
      socket.destroy();
      reject(Error("Local client status is uncertain; quit aBridge before updating"));
    });
    socket.once("connect", () => {
      socket.destroy();
      reject(Error("Quit aBridge before updating its desktop runtime"));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve();
      else reject(error);
    });
  });
}
async function assertAppStopped(app: string): Promise<void> {
  const running = (await run("/bin/ps", ["-ww", "-axo", "comm="])).split("\n").map((line) => line.trim());
  if (
    ["aBridge", ...desktopRuntimeExecutables].some((binary) =>
      running.includes(join(app, "Contents/MacOS", binary)),
    )
  )
    throw Error("Quit aBridge before replacing its application bundle");
}
export async function smokeDesktopRuntime(app: string): Promise<Record<string, unknown>> {
  const home = await mkdtemp(join(tmpdir(), "abridge-native-smoke-"));
  try {
    const env = { HOME: home, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", TMPDIR: tmpdir() };
    const results = await Promise.all(
      desktopRuntimeExecutables.map(async (name) => {
        const executable = join(app, "Contents/MacOS", name);
        const result = JSON.parse(
          await run(executable, ["smoke", "--state-dir", join(home, "state")], { env, timeout: 30000 }),
        ) as Record<string, unknown>;
        if (result.embedded !== true || result.desktop_actions !== 0 || result.authorizations !== 0)
          throw Error(`${name} smoke returned unsafe or incomplete evidence`);
        return result;
      }),
    );
    JSON.parse(
      await run(
        join(app, "Contents/MacOS", desktopRuntimeExecutables[0]),
        ["status", "--state-dir", join(home, "state")],
        { env, timeout: 10000 },
      ),
    );
    return results[0]!;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
export async function installDesktop(options: DesktopInstallOptions, root = PROJECT_ROOT) {
  if (
    process.platform !== "darwin" ||
    process.arch !== "arm64" ||
    Number((await run("/usr/bin/sw_vers", ["-productVersion"])).split(".")[0]) < 14
  )
    throw Error("Desktop installation requires Apple Silicon macOS 14+");
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  const info = await lstat(options.stateDir);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()))
    throw Error("Desktop state must be an owner-only directory");
  await chmod(options.stateDir, 0o700);
  await assertClientStopped(options.stateDir);
  await assertAppStopped(options.app);
  const staging = options.app + ".install-" + randomUUID() + ".app",
    backup = options.app + ".previous-" + randomUUID();
  let moved = false;
  try {
    const native = await buildNative(
      {
        output: staging,
        stateDir: options.stateDir,
        force: options.force,
        signingIdentity: options.signingIdentity,
      },
      root,
    );
    const smoke = await smokeDesktopRuntime(native.app);
    await assertClientStopped(options.stateDir);
    await assertAppStopped(options.app);
    try {
      const previous = await lstat(options.app);
      if (previous.isSymbolicLink() || !previous.isDirectory())
        throw Error("Existing App must be a directory, not a symbolic link");
      await rename(options.app, backup);
      moved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rename(staging, options.app);
    } catch (error) {
      if (moved) {
        await rename(backup, options.app);
        moved = false;
      }
      throw error;
    }
    if (moved) {
      await rm(backup, { recursive: true, force: true });
      moved = false;
    }
    return {
      app: options.app,
      runtime: join(options.app, "Contents/MacOS/abridge-desktop"),
      native_reused: false,
      smoke,
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(
      JSON.stringify(await installDesktop(parseDesktopInstallOptions(process.argv.slice(2))), null, 2),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Desktop installation failed");
    process.exitCode = 1;
  }
}
