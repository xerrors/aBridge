/** Reject private state, desktop native dependencies and source-only inputs in Server packages. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { list, extract } from "tar";
import { unzipSync } from "fflate";
import { serverPackageLock, type PackageLock } from "./lib/server-lock.js";
import { checkInstalledPackage } from "./lib/check-installed-package.js";
const root = resolve(import.meta.dirname, ".."),
  dist = join(root, "dist/releases");
const files = await readdir(dist),
  tarballs = files.filter((n) => !n.startsWith("._") && n.endsWith(".tgz"));
if (tarballs.length !== 1) throw new Error("Expected exactly one Server tarball");
const tarball = join(dist, tarballs[0]!);
// Use the same portable tar implementation as npm. Some Windows inbox tar
// versions reject npm's valid PAX headers before the package can be inspected.
const entries: string[] = [];
await list({
  file: tarball,
  onReadEntry: (entry) => {
    entries.push(entry.path);
  },
});
for (const name of entries) {
  if (
    name.split("/").includes("..") ||
    !/^package\/(?:(?:cli\.js|package\.json|README\.md|LICENSE|THIRD_PARTY_NOTICES\.md)$|(?:web|node_modules)\/)/.test(
      name,
    )
  )
    throw new Error(`Unexpected Server package entry: ${name}`);
}
const server = JSON.parse(await readFile(join(root, "apps/server/package.json"), "utf8")) as {
  dependencies: Record<string, string>;
};
const dependencies = Object.fromEntries(
  Object.entries(server.dependencies).filter(([name]) => !name.startsWith("@abridge/")),
);
const sourceLock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8")) as PackageLock;
const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
const extracted = await mkdtemp(join(tmpdir(), "abridge-package-"));
try {
  await extract({ file: tarball, cwd: extracted });
  const pkg = JSON.parse(await readFile(join(extracted, "package/package.json"), "utf8")) as {
    name: string;
    version: string;
    dependencies: Record<string, string>;
    bundleDependencies?: string[];
    optionalDependencies?: unknown;
  };
  if (pkg.optionalDependencies) throw new Error("Server must not declare optional dependencies");
  assert.deepEqual(pkg.dependencies, dependencies, "Packaged Server dependencies must match source");
  assert.equal(pkg.version, metadata.version, "Packaged Server version must match the product version");
  const lock = serverPackageLock(sourceLock, { name: pkg.name, version: metadata.version, dependencies });
  if (Object.keys(lock.packages).some((name) => /cua-driver|@ubjs|typescript|esbuild/.test(name)))
    throw new Error("Server dependency lock contains desktop or build dependencies");
  assert.deepEqual(
    pkg.bundleDependencies?.slice().sort(),
    Object.keys(dependencies).sort(),
    "Server must bundle every production dependency",
  );
  const packaged = entries
    .filter((name) => /^package\/(node_modules\/(?:@[^/]+\/)?[^/]+\/)+package\.json$/.test(name))
    .map((name) => name.slice("package/".length, -"/package.json".length))
    .sort();
  const locked = Object.keys(lock.packages).filter(Boolean).sort();
  assert.deepEqual(packaged, locked, "Bundled dependency tree must match the Server lock");
  for (const name of locked) {
    if (lock.packages[name]!.dev) throw new Error(`Server bundles a development dependency: ${name}`);
    const bundled = JSON.parse(await readFile(join(extracted, "package", name, "package.json"), "utf8")) as {
      version: string;
    };
    assert.equal(bundled.version, lock.packages[name]!.version, `Bundled version differs from lock: ${name}`);
  }
  await checkInstalledPackage(tarball, pkg.name, metadata.version);
} finally {
  await rm(extracted, { recursive: true, force: true });
}
const browser = `abridge-browser-${metadata.version}.zip`;
if (!files.includes(browser)) throw new Error("Browser ZIP for the current version is missing");
const archive = unzipSync(await readFile(join(dist, browser)));
const manifest = JSON.parse(new TextDecoder().decode(archive["manifest.json"])) as Record<string, unknown>;
if ("key" in manifest) throw new Error("Chrome Web Store manifest must not contain a key field");
if (manifest.version !== metadata.version)
  throw new Error("Browser manifest version must match the product version");
for (const name of Object.keys(archive)) {
  if (name.includes("..") || /\.local|node_modules|tests\/|\.ts$|\.map$/.test(name))
    throw new Error(`Unexpected extension entry: ${name}`);
}
console.log(
  `Verified Server tarball (${entries.length} files), offline installation, CLI, HTTP, WASM and extension ZIP`,
);
