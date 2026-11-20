/** Portable Windows candidate. No installer, global settings, or production credentials. */
import { createReadStream, closeSync, openSync, writeSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { Zip, ZipDeflate } from "fflate";
import { writeWindowsContract } from "./lib/windows-native-contract.js";

if (process.platform !== "win32" || process.arch !== "x64")
  throw Error("Build the Windows x64 package on Windows x64.");
const root = resolve(import.meta.dirname, "..");
const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
const cargo = process.env.CARGO ?? "cargo";
const buildDirectory = join(root, ".local/release/windows/build");
await mkdir(buildDirectory, { recursive: true });
const contractFile = join(buildDirectory, "contract.json");
writeWindowsContract(root, contractFile);
const manifestPath = join(root, "apps/windows/windows-native-shell/Cargo.toml");
const target = "x86_64-pc-windows-msvc";
const cargoEnv = {
  ...process.env,
  ABRIDGE_VERSION: metadata.version,
  ABRIDGE_CONTRACT_PATH: contractFile,
  CARGO_TARGET_DIR: join(buildDirectory, "target"),
};
function runCargo(args: string[]): string {
  const result = spawnSync(cargo, args, {
    cwd: dirname(manifestPath),
    env: cargoEnv,
    encoding: "utf8",
    windowsHide: true,
    timeout: 600000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw Error(
      `Rust Windows build failed: ${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`,
    );
  if (result.stderr) process.stderr.write(result.stderr);
  return result.stdout;
}
// Reuse the canonical 256px PNG already exported in the macOS icon set.
const iconset = await readFile(join(root, "apps/desktop/native/assets/AppIcon.icns"));
let iconPng: Buffer | undefined;
for (let offset = 8; offset + 8 <= iconset.length;) {
  const length = iconset.readUInt32BE(offset + 4);
  if (length < 8 || offset + length > iconset.length) throw Error("Invalid canonical app icon.");
  if (iconset.toString("ascii", offset, offset + 4) === "ic08")
    iconPng = iconset.subarray(offset + 8, offset + length);
  offset += length;
}
if (!iconPng || iconPng.readUInt32BE(16) !== 256 || iconPng.readUInt32BE(20) !== 256)
  throw Error("Canonical app icon must contain a 256px PNG.");
const iconHeader = Buffer.alloc(22);
iconHeader.writeUInt16LE(1, 2);
iconHeader.writeUInt16LE(1, 4);
iconHeader.writeUInt16LE(1, 10);
iconHeader.writeUInt16LE(32, 12);
iconHeader.writeUInt32LE(iconPng.length, 14);
iconHeader.writeUInt32LE(22, 18);
const icon = join(buildDirectory, "app.ico");
await writeFile(icon, Buffer.concat([iconHeader, iconPng]));
const stage = resolve(root, ".local/release/windows/aBridge");
const releaseRoot = resolve(root, ".local/release/windows");
if (dirname(stage) !== releaseRoot || !stage.startsWith(root + sep)) throw Error("Unsafe staging path.");
Object.assign(cargoEnv, { ABRIDGE_ICON: icon });
runCargo(["build", "--manifest-path", manifestPath, "--release", "--locked", "--target", target]);
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await cp(join(cargoEnv.CARGO_TARGET_DIR, target, "release/aBridge.exe"), join(stage, "aBridge.exe"));
const cargoMetadata = JSON.parse(
  runCargo([
    "metadata",
    "--manifest-path",
    manifestPath,
    "--locked",
    "--format-version",
    "1",
    "--filter-platform",
    target,
  ]),
) as {
  resolve: { nodes: { id: string }[] };
  packages: {
    id: string;
    name: string;
    version: string;
    source: string | null;
    license: string | null;
    manifest_path: string;
  }[];
};
const resolved = new Set(cargoMetadata.resolve.nodes.map((node) => node.id));
let notices = "aBridge Windows shell third-party notices\n";
for (const pkg of cargoMetadata.packages
  .filter((pkg) => pkg.source && resolved.has(pkg.id))
  .sort((a, b) => a.name.localeCompare(b.name))) {
  notices += `\n${pkg.name} ${pkg.version}\nLicense: ${pkg.license ?? "See included text"}\n`;
  const directory = dirname(pkg.manifest_path);
  for (const file of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (file.isFile() && /^(LICENSE|COPYING|NOTICE)(?:[._-].*)?$/i.test(file.name))
      notices += `\n--- ${file.name} ---\n${await readFile(join(directory, file.name), "utf8")}\n`;
  }
}
await writeFile(join(stage, "Rust-THIRD-PARTY-NOTICES.txt"), notices);
await cp(join(root, "apps/desktop/native/assets/AppIcon.png"), join(stage, "icon.png"));
const app = join(stage, "runtime");
await mkdir(app, { recursive: true });
await cp(join(root, "LICENSE"), join(app, "LICENSE"));
await cp(join(root, "docs/third-party-notices.md"), join(app, "THIRD_PARTY_NOTICES.md"));
await cp(join(root, "docs/windows-client.md"), join(stage, "README.md"));
const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true });
const changes = spawnSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
});
await writeFile(
  join(app, "runtime-manifest.json"),
  JSON.stringify(
    {
      version: metadata.version,
      platform: "win32",
      source_commit: revision.status === 0 ? revision.stdout.trim() : null,
      source_dirty: changes.status === 0 ? changes.stdout.trim().length > 0 : null,
      arch: "x64",
      shell: "Rust + Win32",
      runtime: "native",
      max_installed_bytes: 10_000_000,
    },
    null,
    2,
  ) + "\n",
);
const cliProbe = spawnSync(join(stage, "aBridge.exe"), ["--help"], {
  cwd: stage,
  encoding: "utf8",
  windowsHide: true,
  timeout: 30000,
});
if (cliProbe.status !== 0 || !cliProbe.stdout.includes("state-dir"))
  throw Error("Packaged native CLI failed its startup probe.");
// Deployment-specific paths and credentials are deliberately absent from this package.
await writeFile(
  join(stage, "Start-aBridge.ps1"),
  `param([string]$StateDir)
$ErrorActionPreference = 'Stop'
if (-not $StateDir) {
  $deploymentPath = Join-Path $PSScriptRoot 'deployment.json'
  if (Test-Path -LiteralPath $deploymentPath) {
    $deployment = Get-Content -LiteralPath $deploymentPath -Raw | ConvertFrom-Json
    $StateDir = $deployment.state_dir
  }
}
if ($StateDir) {
  & (Join-Path $PSScriptRoot 'aBridge.exe') --state-dir $StateDir
} else {
  & (Join-Path $PSScriptRoot 'aBridge.exe')
}
`,
);
async function installedSize(directory: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw Error("No external package dependencies are permitted.");
    bytes += entry.isDirectory() ? await installedSize(path) : (await stat(path)).size;
  }
  return bytes;
}
const installedBytes = await installedSize(stage);
if (installedBytes >= 10_000_000)
  throw Error(`Native installation exceeds the 10 MB limit: ${installedBytes} bytes`);
const dist = join(root, "dist/releases");
await mkdir(dist, { recursive: true });
const output = join(dist, `aBridge-${metadata.version}-windows-x64-unsigned.zip`);
const descriptor = openSync(output, "w");
try {
  const zip = new Zip((error, data) => {
    if (error) throw error;
    writeSync(descriptor, data);
  });
  const collect = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const file = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw Error("Windows packages cannot contain symbolic links.");
      if (entry.isDirectory()) await collect(file);
      else {
        const compressed = new ZipDeflate("aBridge/" + relative(stage, file).split(sep).join("/"), {
          level: 6,
        });
        compressed.mtime = new Date("2020-01-01T00:00:00Z");
        zip.add(compressed);
        for await (const chunk of createReadStream(file)) compressed.push(chunk, false);
        compressed.push(new Uint8Array(), true);
      }
    }
  };
  await collect(stage);
  zip.end();
} finally {
  closeSync(descriptor);
}
const checksum = createHash("sha256");
for await (const chunk of createReadStream(output)) checksum.update(chunk);
await writeFile(output + ".sha256", `${checksum.digest("hex")}  ${relative(dist, output)}\n`);
console.log(
  `Packaged unsigned Windows x64 ${metadata.version}, native runtime, installed ${installedBytes} bytes: ${output}\n` +
    `ZIP ${((await stat(output)).size / 1024 / 1024).toFixed(2)} MiB; shell ${((await stat(join(stage, "aBridge.exe"))).size / 1024 / 1024).toFixed(2)} MiB`,
);
