/** Build deployable applications; workspace source packages are bundled, external dependencies are not. */
import { build, type Plugin } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, ".."),
  out = join(root, "dist");
const packageInfo = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
const internalEntries: Record<string, string> = {
  "@abridge/protocol": join(root, "packages/protocol/src/index.ts"),
  "@abridge/shared/paths": join(root, "packages/shared/src/paths.ts"),
};
const workspaceSources: Plugin = {
  name: "workspace-sources",
  setup(builder) {
    builder.onResolve({ filter: /^@abridge\// }, ({ path }) => {
      const entry = internalEntries[path];
      if (!entry) throw Error(`Unknown internal workspace interface: ${path}`);
      return { path: entry };
    });
    // The runtime receives the product version, never the development manifest.
    builder.onLoad({ filter: /package\.json$/ }, ({ path }) =>
      path === join(root, "package.json")
        ? { contents: JSON.stringify({ version: packageInfo.version }), loader: "json" }
        : undefined,
    );
  },
};
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const app of ["server", "desktop"] as const) {
  const result = await build({
    entryPoints: [join(root, "apps", app, "src/cli.ts")],
    outfile: join(out, app, "cli.js"),
    bundle: true,
    plugins: [workspaceSources],
    platform: "node",
    format: "esm",
    target: "node26",
    packages: "external",
    metafile: true,
    sourcemap: true,
  });
  await writeFile(join(out, app, "cli.meta.json"), JSON.stringify(result.metafile, null, 2) + "\n");
}
await cp(join(root, "apps/web/public"), join(out, "server/web"), { recursive: true });
await build({
  entryPoints: [join(root, "apps/web/src/app.tsx")],
  outfile: join(out, "server/web/app.js"),
  bundle: true,
  plugins: [workspaceSources],
  platform: "browser",
  format: "esm",
  target: "es2022",
  minify: true,
  jsx: "automatic",
  jsxImportSource: "preact",
  sourcemap: true,
});
const extension = join(out, "browser");
await cp(join(root, "apps/browser/public"), extension, { recursive: true });
const manifest = JSON.parse(await readFile(join(extension, "manifest.json"), "utf8")) as Record<
  string,
  unknown
>;
manifest.version = packageInfo.version;
await writeFile(join(extension, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
await build({
  entryPoints: ["worker", "options", "popup"].map((name) => join(root, "apps/browser/src", name + ".ts")),
  outdir: extension,
  bundle: true,
  plugins: [workspaceSources],
  platform: "browser",
  format: "esm",
  target: "chrome116",
  sourcemap: true,
});
console.log(`Built Server, Desktop, management console and Browser ${packageInfo.version}`);
