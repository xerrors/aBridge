/** Reject private state, desktop native dependencies and source-only inputs in Server packages. */
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { unzipSync } from "fflate";
const root = resolve(import.meta.dirname, ".."),
  dist = join(root, "dist/releases");
const files = await readdir(dist),
  tarballs = files.filter((n) => n.endsWith(".tgz"));
if (tarballs.length !== 1) throw new Error("Expected exactly one Server tarball");
const listing = spawnSync("tar", ["-tzf", join(dist, tarballs[0]!)], { encoding: "utf8" });
if (listing.status !== 0) throw new Error("Cannot inspect Server tarball");
const entries = listing.stdout.trim().split("\n");
for (const name of entries) {
  if (
    !/^package\/(cli\.js|package\.json|npm-shrinkwrap\.json|README\.md|THIRD_PARTY_NOTICES\.md|web\/)/.test(
      name,
    )
  )
    throw new Error(`Unexpected Server package entry: ${name}`);
}
const pkg = JSON.parse(await readFile(join(root, ".local/release/server/package.json"), "utf8")) as Record<
  string,
  unknown
>;
if (pkg.optionalDependencies || JSON.stringify(pkg.dependencies).includes("cua-driver"))
  throw new Error("Server must not install desktop native dependencies");
const lock = JSON.parse(await readFile(join(root, ".local/release/server/npm-shrinkwrap.json"), "utf8")) as {
  packages: Record<string, unknown>;
};
if (Object.keys(lock.packages).some((name) => /cua-driver|@ubjs|typescript|esbuild/.test(name)))
  throw new Error("Server dependency lock contains desktop or build dependencies");
const browser = files.find((n) => n.endsWith(".zip"));
if (!browser) throw new Error("Browser ZIP missing");
for (const name of Object.keys(unzipSync(await readFile(join(dist, browser))))) {
  if (name.includes("..") || /\.local|node_modules|tests\/|\.ts$|\.map$/.test(name))
    throw new Error(`Unexpected extension entry: ${name}`);
}
console.log(`Verified Server tarball (${entries.length} files) and extension ZIP`);
