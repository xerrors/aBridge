/** Consume the portable candidate outside the repository, without any real device state. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { checkNativeConsumer } from "./lib/windows-native-consumer.js";

if (process.platform !== "win32" || process.arch !== "x64")
  throw Error("Check the Windows package on Windows x64");
const root = resolve(import.meta.dirname, "..");
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
const archive = join(root, "dist/releases", `aBridge-${version}-windows-x64-unsigned.zip`);
const hash = createHash("sha256");
for await (const chunk of createReadStream(archive)) hash.update(chunk);
assert.equal(await readFile(archive + ".sha256", "utf8"), `${hash.digest("hex")}  ${basename(archive)}\n`);
const listing = spawnSync("tar.exe", ["-tf", archive], {
  encoding: "utf8",
  windowsHide: true,
  maxBuffer: 4 * 1024 * 1024,
});
assert.equal(listing.status, 0, listing.stderr);
const entries = listing.stdout.trim().split(/\r?\n/);
for (const entry of entries) {
  assert.ok(
    !/(?:^|\/)(?:node\.exe|node_modules|Microsoft\.UI\.|Microsoft\.WindowsAppRuntime|naui-)/i.test(entry),
    `External runtime in native bundle: ${entry}`,
  );
  assert.ok(entry.startsWith("aBridge/") && !entry.includes("\\") && !entry.includes(":"), entry);
  assert.ok(!entry.split("/").some((part) => part === ".." || part === ".git" || part === ".local"), entry);
  assert.ok(
    !/(?:^|\/)(?:deployment|config|credential|control-auth)\.json$|\.db(?:-|$)|\.map$|cua-driver/.test(entry),
    entry,
  );
  assert.ok(
    !/\.(?:deps\.json|runtimeconfig\.json)$|DotNet-|(?:^|\/)(?:coreclr|clrjit|hostfxr|hostpolicy|System\.Private\.CoreLib)\.dll$/i.test(
      entry,
    ),
    `Unexpected managed runtime: ${entry}`,
  );
}
const directory = await mkdtemp(join(tmpdir(), "abridge-windows-package-"));
assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
try {
  const unpack = spawnSync("tar.exe", ["-xf", archive, "-C", directory], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(unpack.status, 0, unpack.stderr);
  const app = join(directory, "aBridge"),
    runtime = join(app, "runtime");
  for (const file of [
    "aBridge.exe",
    "README.md",
    "runtime/LICENSE",
    "Rust-THIRD-PARTY-NOTICES.txt",
    "Start-aBridge.ps1",
  ])
    await access(join(app, file));
  for (const entry of entries.filter((entry) => /\.(dll|exe)$/i.test(entry))) {
    const binary = await readFile(join(directory, entry));
    assert.equal(binary.subarray(0, 2).toString(), "MZ", entry);
    const header = binary.readUInt32LE(0x3c);
    assert.equal(binary.subarray(header, header + 4).toString(), "PE\0\0", entry);
    const optional = header + 24;
    const magic = binary.readUInt16LE(optional);
    assert.ok(magic === 0x20b || magic === 0x10b, entry);
    const directories = optional + (magic === 0x20b ? 112 : 96);
    assert.equal(
      binary.readUInt32LE(directories + 14 * 8),
      0,
      `Managed assembly in portable bundle: ${entry}`,
    );
  }
  const executable = await readFile(join(app, "aBridge.exe"));
  async function installedSize(path: string): Promise<number> {
    let bytes = 0;
    for (const file of await readdir(path, { withFileTypes: true })) {
      assert.ok(!file.isSymbolicLink(), "Package must not refer to external dependencies");
      const child = join(path, file.name);
      bytes += file.isDirectory() ? await installedSize(child) : (await stat(child)).size;
    }
    return bytes;
  }
  const installedBytes = await installedSize(app);
  assert.ok(installedBytes < 10_000_000, `Installed bundle must be below 10 MB: ${installedBytes} bytes`);
  assert.equal(executable.subarray(0, 2).toString(), "MZ");
  const pe = executable.readUInt32LE(0x3c);
  assert.equal(executable.subarray(pe, pe + 4).toString(), "PE\0\0");
  assert.equal(executable.readUInt16LE(pe + 4), 0x8664, "Shell must target x64");
  const optional = pe + 24;
  assert.equal(executable.readUInt16LE(optional), 0x20b, "Shell must be PE32+");
  assert.equal(executable.readUInt16LE(optional + 68), 2, "Shell must use the GUI subsystem");
  assert.equal(executable.readUInt32LE(optional + 112 + 14 * 8), 0, "Shell must not load the CLR");
  // A small package must not hide required third-party DLLs outside its directory.
  const sections = pe + 24 + executable.readUInt16LE(pe + 20);
  const offsetOf = (rva: number): number => {
    for (let index = 0; index < executable.readUInt16LE(pe + 6); index++) {
      const section = sections + index * 40;
      const start = executable.readUInt32LE(section + 12);
      const size = Math.max(executable.readUInt32LE(section + 8), executable.readUInt32LE(section + 16));
      if (rva >= start && rva < start + size) return executable.readUInt32LE(section + 20) + rva - start;
    }
    throw Error("Invalid PE import address");
  };
  const systemLibraries = new Set([
    "advapi32.dll",
    "bcrypt.dll",
    "bcryptprimitives.dll",
    "comctl32.dll",
    "crypt32.dll",
    "dwmapi.dll",
    "gdi32.dll",
    "kernel32.dll",
    "msvcrt.dll",
    "ntdll.dll",
    "ole32.dll",
    "oleaut32.dll",
    "secur32.dll",
    "shell32.dll",
    "shlwapi.dll",
    "user32.dll",
    "userenv.dll",
    "uxtheme.dll",
    "version.dll",
    "ws2_32.dll",
  ]);
  const imports = offsetOf(executable.readUInt32LE(optional + 112 + 8));
  for (let descriptor = imports; executable.readUInt32LE(descriptor + 12) !== 0; descriptor += 20) {
    const start = offsetOf(executable.readUInt32LE(descriptor + 12));
    const library = executable.subarray(start, executable.indexOf(0, start)).toString("ascii").toLowerCase();
    assert.ok(
      systemLibraries.has(library) || /^api-ms-win-[a-z0-9-]+\.dll$/.test(library),
      `Non-system DLL dependency: ${library}`,
    );
  }
  const manifest = JSON.parse(await readFile(join(runtime, "runtime-manifest.json"), "utf8")) as {
    version: string;
    platform: string;
    shell: string;
    source_commit: string | null;
    source_dirty: boolean | null;
  };
  assert.equal(manifest.version, version);
  assert.equal(manifest.platform, "win32");
  assert.equal(manifest.shell, "Rust + Win32");
  assert.ok(manifest.source_commit === null || /^[a-f0-9]{40}$/.test(manifest.source_commit));
  // An empty state directory means no credentials, network connection or real desktop actions.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|TEMP|TMP|LOCALAPPDATA)$/i.test(key)),
  );
  const cli = join(app, "aBridge.exe");
  const help = spawnSync(cli, ["--help"], {
    cwd: directory,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /state-dir/);
  const status = spawnSync(cli, ["status", "--state-dir", join(directory, "empty-state")], {
    cwd: directory,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
  });
  assert.equal(status.status, 0, status.stderr);
  const snapshot = JSON.parse(status.stdout) as { connected?: boolean };
  assert.notEqual(snapshot.connected, true);
  await checkNativeConsumer(join(app, "aBridge.exe"), directory);
  console.log(
    `Verified native Windows ZIP, checksum and isolated CLI startup (${installedBytes} installed bytes, ${entries.length} entries; source ${manifest.source_commit ?? "unknown"}, dirty=${manifest.source_dirty})`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
