/** Project the tested production graph without asking the registry to resolve it again. */
import { posix } from "node:path";
export type LockedPackage = {
  version?: string;
  link?: boolean;
  dev?: boolean;
  devOptional?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  [key: string]: unknown;
};
export type PackageLock = { packages: Record<string, LockedPackage> };
export type DistributionManifest = {
  name: string;
  version: string;
  dependencies: Record<string, string>;
};
export function serverPackageLock(lock: PackageLock, manifest: DistributionManifest) {
  const packages: Record<string, LockedPackage> = {
    "": { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies },
  };
  const visited = new Set<string>();
  function locate(name: string, from: string): string | undefined {
    let directory = from;
    while (true) {
      const candidate = posix.join(directory, "node_modules", name);
      if (lock.packages[candidate]) return candidate;
      if (!directory) return undefined;
      directory = posix.dirname(directory);
      if (directory === ".") directory = "";
    }
  }
  function visit(name: string, from: string, optional = false): void {
    const path = locate(name, from);
    if (!path) {
      if (optional) return;
      throw Error(`Production lock omits ${name} required by ${from || "Server"}`);
    }
    const source = lock.packages[path]!;
    if (source.link || !source.version || !path.startsWith("node_modules/"))
      throw Error(`Server distribution requires a registry dependency in the root lock: ${path}`);
    if (visited.has(path)) return;
    visited.add(path);
    const entry = { ...source };
    delete entry.dev;
    delete entry.devOptional;
    packages[path] = entry;
    const optionalDependencies = source.optionalDependencies ?? {};
    for (const dependency of Object.keys(source.dependencies ?? {}))
      visit(dependency, path, Object.hasOwn(optionalDependencies, dependency));
    for (const dependency of Object.keys(optionalDependencies)) visit(dependency, path, true);
    for (const dependency of Object.keys(source.peerDependencies ?? {}))
      visit(dependency, path, source.peerDependenciesMeta?.[dependency]?.optional === true);
  }
  for (const name of Object.keys(manifest.dependencies)) visit(name, "apps/server");
  return {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    requires: true,
    packages: Object.fromEntries(Object.entries(packages).sort(([a], [b]) => a.localeCompare(b, "en"))),
  };
}
