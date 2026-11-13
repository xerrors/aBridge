/** Copy the production dependency graph without retaining npm-cache symlinks. */
import { isBuiltin } from "node:module";
import { cp, chmod, lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
type PackageInfo = {
  name: string;
  version: string;
  os?: string[];
  cpu?: string[];
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};
type Lock = { packages: Record<string, { version?: string; dev?: boolean }> };
export type ClosureEntry = { name: string; version: string; path: string };
export function packageName(specifier: string): string {
  return specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
}
export function externalPackages(metafile: {
  outputs: Record<string, { imports?: { path: string; external?: boolean }[] }>;
}): string[] {
  return [
    ...new Set(
      Object.values(metafile.outputs).flatMap((output) =>
        (output.imports ?? [])
          .filter(
            (item) =>
              item.external &&
              !isBuiltin(item.path) &&
              !item.path.startsWith(".") &&
              !item.path.startsWith("/"),
          )
          .map((item) => packageName(item.path)),
      ),
    ),
  ].sort();
}
export async function resolvePackageDirectory(name: string, from: string): Promise<string> {
  let directory = resolve(from);
  while (true) {
    const path = join(directory, "node_modules", name);
    try {
      await lstat(join(path, "package.json"));
      return await realpath(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory)
      throw Error(
        `Missing runtime dependency ${name}; install locked dependencies including optional native packages`,
      );
    directory = parent;
  }
}
function matches(values: string[] | undefined, value: string): boolean {
  return (
    !values ||
    (!values.includes("!" + value) && (values.every((v) => v.startsWith("!")) || values.includes(value)))
  );
}
export async function privateTree(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw Error("Runtime copies must not contain symlinks");
  await chmod(path, info.isDirectory() ? 0o700 : info.mode & 0o111 ? 0o700 : 0o600);
  if (info.isDirectory()) for (const entry of await readdir(path)) await privateTree(join(path, entry));
}
export async function copyDependencyClosure(
  root: string,
  targetNodeModules: string,
  roots: string[],
  {
    platform = process.platform,
    arch = process.arch,
    resolveFrom = root,
  }: {
    platform?: NodeJS.Platform;
    arch?: string;
    resolveFrom?: string;
  } = {},
): Promise<ClosureEntry[]> {
  root = await realpath(root);
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8")) as Lock;
  const entries: ClosureEntry[] = [];
  const copy = async (
    name: string,
    from: string,
    destination: string,
    ancestors: Set<string>,
    optional = false,
  ): Promise<void> => {
    let source: string;
    try {
      source = await resolvePackageDirectory(name, from);
    } catch (error) {
      if (optional) return;
      throw error;
    }
    const info = JSON.parse(await readFile(join(source, "package.json"), "utf8")) as PackageInfo;
    if (!matches(info.os, platform) || !matches(info.cpu, arch)) {
      if (optional) return;
      throw Error(`${name} does not support ${platform}-${arch}`);
    }
    const lockKey = relative(root, source).split(sep).join("/"),
      locked = lock.packages[lockKey];
    if (!locked || locked.version !== info.version || locked.dev === true)
      throw Error(`Runtime dependency ${name}@${info.version} does not match the production lockfile`);
    if (ancestors.has(source)) return;
    const target = join(destination, name);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await cp(source, target, {
      recursive: true,
      dereference: true,
      filter: (path) => relative(source, path).split(sep)[0] !== "node_modules",
    });
    entries.push({
      name: info.name,
      version: info.version,
      path: relative(targetNodeModules, target).split(sep).join("/"),
    });
    const next = new Set(ancestors).add(source);
    for (const dep of Object.keys(info.dependencies ?? {}).sort())
      await copy(dep, source, join(target, "node_modules"), next);
    for (const dep of Object.keys(info.optionalDependencies ?? {}).sort())
      await copy(dep, source, join(target, "node_modules"), next, true);
  };
  await mkdir(targetNodeModules, { recursive: true, mode: 0o700 });
  for (const name of [...new Set(roots)].sort()) await copy(name, resolveFrom, targetNodeModules, new Set());
  await privateTree(targetNodeModules);
  return entries;
}
