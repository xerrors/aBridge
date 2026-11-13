/** Publish-shaped local candidates; this script never publishes to a registry. */
import { cp, mkdir, readFile, readdir, rm, writeFile, chmod } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { zipSync } from "fflate";
const { values } = parseArgs({ options: { public: { type: "boolean" } } });
const publish = values.public ?? false;
const root = resolve(import.meta.dirname, ".."),
  dist = join(root, "dist/releases"),
  stage = join(root, ".local/release/server");
const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
  version: string;
  engines: Record<string, string>;
  license?: string;
};
const server = JSON.parse(await readFile(join(root, "apps/server/package.json"), "utf8")) as {
  dependencies: Record<string, string>;
};
const dependencies = Object.fromEntries(
  Object.entries(server.dependencies).filter(([name]) => !name.startsWith("@abridge/")),
);
const packageName = publish ? (process.env.NPM_PACKAGE_NAME ?? "@xerrors/abridge") : "@abridge/server";
if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(packageName))
  throw Error("Invalid public npm package name");
if (publish && !metadata.license)
  throw Error("Choose the project license in root package.json before publishing");
await mkdir(dist, { recursive: true });
for (const file of await readdir(dist)) if (file.endsWith(".tgz")) await rm(join(dist, file));
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await cp(join(root, "dist/server/cli.js"), join(stage, "cli.js"));
await chmod(join(stage, "cli.js"), 0o755);
await cp(join(root, "dist/server/web"), join(stage, "web"), { recursive: true });
await cp(join(root, "apps/server/README.md"), join(stage, "README.md"));
await cp(join(root, "docs/third-party-notices.md"), join(stage, "THIRD_PARTY_NOTICES.md"));
await cp(join(root, "LICENSE"), join(stage, "LICENSE"));
await writeFile(
  join(stage, "package.json"),
  JSON.stringify(
    {
      name: packageName,
      version: metadata.version,
      private: !publish,
      type: "module",
      description: "aBridge MCP and device gateway",
      engines: metadata.engines,
      bin: { abridge: "cli.js" },
      files: ["cli.js", "web", "LICENSE", "THIRD_PARTY_NOTICES.md", "README.md", "npm-shrinkwrap.json"],
      license: metadata.license ?? "UNLICENSED",
      repository: { type: "git", url: "git+https://github.com/xerrors/aBridge.git" },
      ...(publish ? { publishConfig: { access: "public" } } : {}),
      dependencies,
    },
    null,
    2,
  ) + "\n",
);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
for (const args of [
  [
    "install",
    "--package-lock-only",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--fetch-retry-mintimeout=1000",
  ],
  ["shrinkwrap", "--ignore-scripts"],
  ["pack", "--ignore-scripts", "--pack-destination", dist],
]) {
  const result = spawnSync(npm, args, { cwd: stage, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`npm ${args[0]} failed`);
}
const archive: Record<string, Uint8Array> = {};
async function collect(directory: string): Promise<void> {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, item.name);
    if (item.isSymbolicLink()) throw new Error("Extension artifacts cannot contain symlinks");
    if (item.isDirectory()) await collect(file);
    else if (!item.name.endsWith(".map"))
      archive[relative(join(root, "dist/browser"), file).replaceAll("\\", "/")] = await readFile(file);
  }
}
await collect(join(root, "dist/browser"));
archive["LICENSE"] = await readFile(join(root, "LICENSE"));
await writeFile(
  join(dist, `abridge-browser-${metadata.version}.zip`),
  zipSync(archive, { level: 9, mtime: new Date("2020-01-01T00:00:00Z") }),
);
console.log(`Packaged Node-only Server and standalone extension ${metadata.version}`);
