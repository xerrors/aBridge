/** Install a standalone Node desktop runtime and its signed AppKit shell. */
import { parseArgs } from "node:util";
import { homedir, tmpdir } from "node:os";
import { constants } from "node:fs";
import { access, chmod, cp, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { controlSocketPath } from "../apps/desktop/src/local-control.js";
import { randomUUID } from "node:crypto";
import { buildNative, PROJECT_ROOT } from "./build-native.js";
import {
  copyDependencyClosure,
  externalPackages,
  privateTree,
  resolvePackageDirectory,
  type ClosureEntry,
} from "./lib/dependency-closure.js";
import { acquireOfficialNode, validateNodeBinary } from "./lib/node-runtime.js";
import { run } from "./lib/process.js";
export type DesktopInstallOptions = {
  app: string;
  stateDir: string;
  cacheDir: string;
  node?: string;
  cli: string;
  metafile: string;
  force: boolean;
  signingIdentity: string;
};
export function parseDesktopInstallOptions(
  args: string[],
  home = homedir(),
  root = PROJECT_ROOT,
): DesktopInstallOptions {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      app: { type: "string" },
      "state-dir": { type: "string" },
      "cache-dir": { type: "string" },
      node: { type: "string" },
      cli: { type: "string" },
      metafile: { type: "string" },
      force: { type: "boolean" },
      "signing-identity": { type: "string" },
    },
  });
  return {
    app: resolve(values.app ?? join(home, "Applications/aBridge.app")),
    stateDir: resolve(values["state-dir"] ?? join(home, "Library/Application Support/aBridge")),
    cacheDir: resolve(values["cache-dir"] ?? join(home, "Library/Caches/aBridge/Node")),
    node: values.node ? resolve(values.node) : undefined,
    cli: resolve(values.cli ?? join(root, "dist/desktop/cli.js")),
    metafile: resolve(values.metafile ?? join(root, "dist/desktop/cli.meta.json")),
    force: values.force ?? false,
    signingIdentity: values["signing-identity"] ?? process.env.ABRIDGE_SIGNING_IDENTITY ?? "-",
  };
}
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function ownerDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()))
    throw Error("Desktop state must be an owner-only directory");
  await chmod(path, 0o700);
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
export async function smokeDesktopRuntime(runtime: string): Promise<Record<string, unknown>> {
  const home = join(runtime, ".smoke-home");
  await mkdir(home, { mode: 0o700 });
  const script = `
 import {CuaDriver,ConfiguredDriverOptions,RuntimeAuthorizationOptions,SessionPermissionMode,DriverAuthorizationAction,DriverAuthorizationDecision,DriverExecutionMode} from '@trycua/cua-driver';
 await import('ws');await import('zod');
 let authorizations=0;
 const driver=CuaDriver.createConfiguredWithAuthorizationHost(ConfiguredDriverOptions.new({claudeCodeCompatibility:false,authorization:RuntimeAuthorizationOptions.new({allowedModes:[SessionPermissionMode.Standard],compatibilityMode:SessionPermissionMode.Standard,unrestrictedAcknowledged:false,maxSessionTtlSeconds:28800n,maxIdleTtlSeconds:1800n})}),{async authorize(request){authorizations++;return DriverAuthorizationDecision.new({action:DriverAuthorizationAction.Deny,requestDigest:request.requestDigest});}});
 const result={node:process.versions.node,platform:process.platform,arch:process.arch,embedded:driver.executionMode()===DriverExecutionMode.Embedded,socket_path:driver.socketPath(),authorizations,desktop_actions:0};
 try{if(!result.embedded||result.socket_path!=='')throw Error('Unexpected native execution mode');}finally{await driver.shutdown();if('uniffiDestroy'in driver&&typeof driver.uniffiDestroy==='function')driver.uniffiDestroy();}
 if(authorizations!==0)throw Error('Unexpected native authorization request');console.log(JSON.stringify(result));`;
  try {
    const env = { HOME: home, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", TMPDIR: tmpdir() };
    const result = JSON.parse(
      await run(join(runtime, "node"), ["--input-type=module", "-e", script], {
        cwd: runtime,
        env,
        timeout: 30000,
      }),
    ) as Record<string, unknown>;
    await run(
      join(runtime, "node"),
      [join(runtime, "cli.js"), "status", "--state-dir", join(home, "state")],
      { cwd: runtime, env, timeout: 10000 },
    );
    return result;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
export async function installDesktop(
  options: DesktopInstallOptions,
  root = PROJECT_ROOT,
): Promise<{
  app: string;
  runtime: string;
  node: string;
  cli: string;
  native_reused: boolean;
  dependencies: ClosureEntry[];
  smoke: Record<string, unknown>;
}> {
  if (
    process.platform !== "darwin" ||
    process.arch !== "arm64" ||
    Number((await run("/usr/bin/sw_vers", ["-productVersion"])).split(".")[0]) < 14
  )
    throw Error("Desktop installation requires Apple Silicon macOS 14+");
  await access(options.cli, constants.R_OK);
  await access(options.metafile, constants.R_OK);
  const meta = JSON.parse(await readFile(options.metafile, "utf8")) as Parameters<typeof externalPackages>[0],
    roots = externalPackages(meta);
  if (!roots.includes("@trycua/cua-driver"))
    throw Error("Desktop bundle metadata omits the native SDK; rebuild dist/desktop/cli.js");
  const packageInfo = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
  const desktopRoot = join(root, "apps/desktop"),
    desktop = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8")) as {
      optionalDependencies: Record<string, string>;
    };
  const sdkDirectory = await resolvePackageDirectory("@trycua/cua-driver", desktopRoot);
  const sdk = JSON.parse(await readFile(join(sdkDirectory, "package.json"), "utf8")) as { version: string };
  if (sdk.version !== desktop.optionalDependencies["@trycua/cua-driver"])
    throw Error("Installed Cua SDK does not match the exact product dependency");
  const selected = options.node
    ? { node: options.node, license: join(dirname(dirname(options.node)), "LICENSE") }
    : await acquireOfficialNode(options.cacheDir);
  await validateNodeBinary(selected.node);
  await access(selected.license, constants.R_OK);
  await ownerDirectory(options.stateDir);
  await assertClientStopped(options.stateDir);
  const runtime = join(options.stateDir, "runtime");
  if (await exists(runtime)) {
    const info = await lstat(runtime);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw Error("Existing runtime must be a directory, not a symbolic link");
  }
  const staging = runtime + ".install-" + randomUUID(),
    backup = runtime + ".previous-" + randomUUID();
  await ownerDirectory(staging);
  let previousMoved = false,
    runtimeMoved = false;
  try {
    await cp(selected.node, join(staging, "node"));
    await chmod(join(staging, "node"), 0o700);
    await cp(selected.license, join(staging, "Node-LICENSE"));
    await cp(options.cli, join(staging, "cli.js"));
    await chmod(join(staging, "cli.js"), 0o600);
    const dependencies = await copyDependencyClosure(root, join(staging, "node_modules"), roots, {
      resolveFrom: desktopRoot,
    });
    for (const name of ["@trycua/cua-driver-darwin-arm64", "@ubjs/node-darwin-arm64"])
      if (!dependencies.some((dep) => dep.name === name))
        throw Error(
          `Missing current-platform native dependency ${name}; reinstall with optional dependencies`,
        );
    const native = dependencies.find((dep) => dep.name === "@trycua/cua-driver-darwin-arm64");
    if (native?.version !== sdk.version) throw Error("Cua SDK and native ABI package versions differ");
    await writeFile(
      join(staging, "package.json"),
      JSON.stringify(
        { name: "@abridge/desktop-runtime", version: packageInfo.version, private: true, type: "module" },
        null,
        2,
      ) + "\n",
    );
    await writeFile(join(staging, "dependencies.json"), JSON.stringify(dependencies, null, 2) + "\n");
    await cp(join(root, "docs/third-party-notices.md"), join(staging, "THIRD_PARTY_NOTICES.md"));
    await privateTree(staging);
    const smoke = await smokeDesktopRuntime(staging);
    if (await exists(runtime)) {
      await rename(runtime, backup);
      previousMoved = true;
    }
    await rename(staging, runtime);
    runtimeMoved = true;
    let nativeBuild;
    try {
      nativeBuild = await buildNative(
        {
          output: options.app,
          node: join(runtime, "node"),
          cli: join(runtime, "cli.js"),
          stateDir: options.stateDir,
          signingIdentity: options.signingIdentity,
          force: options.force,
        },
        root,
      );
    } catch (error) {
      await rm(runtime, { recursive: true, force: true });
      runtimeMoved = false;
      if (previousMoved) {
        await rename(backup, runtime);
        previousMoved = false;
      }
      throw error;
    }
    if (previousMoved) {
      await rm(backup, { recursive: true, force: true });
      previousMoved = false;
    }
    return {
      app: nativeBuild.app,
      runtime,
      node: join(runtime, "node"),
      cli: join(runtime, "cli.js"),
      native_reused: nativeBuild.reused,
      dependencies,
      smoke,
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
    if (previousMoved && !runtimeMoved) await rename(backup, runtime);
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
