/** Validate production import graphs against workspace ownership and declared interfaces. */
import { globSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { build } from "esbuild";
const root = resolve(import.meta.dirname, ".."),
  metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    dependencies?: unknown;
    optionalDependencies?: unknown;
  };
if (metadata.dependencies || metadata.optionalDependencies)
  throw Error("Runtime dependencies belong to application workspaces, not the repository root");
type Workspace = {
  name: string;
  private?: boolean;
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  exports?: Record<string, string>;
};
const workspaces = new Map<string, { directory: string; manifest: Workspace }>();
for (const file of globSync("{apps,packages}/*/package.json", { cwd: root })) {
  const manifest = JSON.parse(readFileSync(join(root, file), "utf8")) as Workspace;
  if (!manifest.private || manifest.version)
    throw Error(`${file}: internal workspace is private; the product version belongs to the root`);
  workspaces.set(manifest.name, { directory: resolve(root, dirname(file)), manifest });
}
await build({
  entryPoints: [...globSync("{apps,packages}/*/src/**/*.{ts,tsx}", { cwd: root })].map((file) =>
    join(root, file),
  ),
  outdir: join(root, ".local/architecture-check"),
  write: false,
  bundle: true,
  platform: "neutral",
  format: "esm",
  jsx: "automatic",
  jsxImportSource: "preact",
  plugins: [
    {
      name: "workspace-ownership",
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, ({ path: specifier, importer }) => {
          if (!importer) return;
          const workspace = [...workspaces.values()].find(({ directory }) =>
            importer.startsWith(directory + sep),
          );
          if (!workspace) throw Error(`Unowned source: ${importer}`);
          const { directory, manifest } = workspace,
            location = relative(root, importer);
          if (specifier.startsWith(".")) {
            const target = resolve(dirname(importer), specifier);
            const versionSource =
              manifest.name === "@abridge/protocol" && target === join(root, "package.json");
            if (!versionSource && target !== directory && !target.startsWith(directory + sep))
              throw Error(`${location}: cross-workspace traversal ${specifier}; use its declared interface`);
            return;
          }
          if (isBuiltin(specifier)) {
            if (["@abridge/browser", "@abridge/web", "@abridge/protocol"].includes(manifest.name))
              throw Error(`${location}: browser-compatible workspace imports Node builtin ${specifier}`);
            return { path: specifier, external: true };
          }
          const name = specifier.startsWith("@")
              ? specifier.split("/").slice(0, 2).join("/")
              : specifier.split("/")[0],
            declared = { ...manifest.dependencies, ...manifest.optionalDependencies };
          if (!(name in declared)) throw Error(`${location}: undeclared runtime dependency ${name}`);
          if (name.startsWith("@abridge/")) {
            const dependency = workspaces.get(name),
              subpath = specifier.slice(name.length),
              entry = dependency?.manifest.exports?.[subpath ? "." + subpath : "."];
            if (!dependency || !entry)
              throw Error(`${location}: unexported workspace interface ${specifier}`);
            return { path: resolve(dependency.directory, entry) };
          }
          return { path: specifier, external: true };
        });
      },
    },
  ],
});
console.log(`Verified ${workspaces.size} workspace interfaces and dependency ownership`);
