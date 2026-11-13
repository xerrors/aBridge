import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNativeBuildOptions, plist, nativeBuildInputs } from "../build-native.js";
import { createServer } from "node:net";
import { controlSocketPath } from "../../apps/desktop/src/local-control.js";
import { assertClientStopped, parseDesktopInstallOptions } from "../install-desktop.js";
import { checksumFor, nonSystemLibraries } from "../lib/node-runtime.js";
import { externalPackages, copyDependencyClosure } from "../lib/dependency-closure.js";
test("native and installer options keep explicit Node/CLI binding and default user paths", () => {
  assert.throws(() => parseNativeBuildOptions([]), /output/);
  const options = parseNativeBuildOptions([
    "--output",
    "/tmp/fixture.app",
    "--node",
    "/tmp/node",
    "--cli",
    "/tmp/client.js",
    "--force",
    "--signing-identity",
    "fixture",
  ]);
  assert.equal(options.force, true);
  assert.equal(options.signingIdentity, "fixture");
  const install = parseDesktopInstallOptions([], "/fixture/home", "/fixture/project");
  assert.equal(install.stateDir, "/fixture/home/Library/Application Support/aBridge");
  assert.equal(install.app, "/fixture/home/Applications/aBridge.app");
  assert.equal(install.cli, "/fixture/project/dist/desktop/cli.js");
  assert.match(plist({ Name: "a<&", Enabled: true }), /<string>a&lt;&amp;<\/string>/);
});
test("Node provenance and library checks reject missing hashes and non-system runtime libraries", () => {
  const hash = "a".repeat(64);
  assert.equal(checksumFor(hash + "  node.tar.gz\n", "node.tar.gz"), hash);
  assert.throws(() => checksumFor(hash + "  different.tar.gz", "node.tar.gz"), /omit/);
  assert.deepEqual(
    nonSystemLibraries(
      "/tmp/node:\n\t/usr/lib/libSystem.B.dylib (version)\n\t/System/Library/F.framework/F (version)",
    ),
    [],
  );
  assert.deepEqual(
    nonSystemLibraries("/tmp/node:\n\t@rpath/libnode.dylib (version)\n\t/opt/homebrew/lib.dylib (version)"),
    ["@rpath/libnode.dylib", "/opt/homebrew/lib.dylib"],
  );
});
test("bundle metadata selects package roots without importing server or builtin modules", () => {
  assert.deepEqual(
    externalPackages({
      outputs: {
        "client.js": {
          imports: [
            { path: "node:fs", external: true },
            { path: "@trycua/cua-driver/embedded", external: true },
            { path: "ws", external: true },
            { path: "zod/v4", external: true },
            { path: "./internal.js", external: true },
          ],
        },
      },
    }),
    ["@trycua/cua-driver", "ws", "zod"],
  );
});
test("dependency copying resolves the owning workspace and preserves nested versions and licenses", async () => {
  const root = await mkdtemp(join(tmpdir(), "abridge-closure-"));
  const target = join(root, "runtime/node_modules");
  try {
    const packages: Record<string, unknown> = {};
    const write = async (path: string, metadata: Record<string, unknown>) => {
      await mkdir(join(root, path), { recursive: true });
      await writeFile(join(root, path, "package.json"), JSON.stringify(metadata));
      await writeFile(join(root, path, "LICENSE"), "fixture license");
      packages[path] = { version: metadata.version };
    };
    await write("node_modules/a", { name: "a", version: "old-root" });
    await write("apps/desktop/node_modules/a", {
      name: "a",
      version: "1",
      dependencies: { b: "2" },
      devDependencies: { unused: "1" },
      optionalDependencies: { foreign: "1" },
    });
    await write("apps/desktop/node_modules/a/node_modules/b", { name: "b", version: "2" });
    await write("node_modules/b", { name: "b", version: "1" });
    await write("node_modules/unused", { name: "unused", version: "1" });
    await write("node_modules/foreign", { name: "foreign", version: "1", os: ["linux"] });
    await writeFile(join(root, "package-lock.json"), JSON.stringify({ packages }));
    const copied = await copyDependencyClosure(root, target, ["a"], {
      platform: "darwin",
      arch: "arm64",
      resolveFrom: join(root, "apps/desktop"),
    });
    assert.deepEqual(
      copied.map((p) => [p.name, p.version]),
      [
        ["a", "1"],
        ["b", "2"],
      ],
    );
    assert.equal(await readFile(join(target, "a/node_modules/b/LICENSE"), "utf8"), "fixture license");
    assert.equal((await lstat(join(target, "a"))).mode & 0o777, 0o700);
    assert.equal((await lstat(join(target, "a/LICENSE"))).mode & 0o777, 0o600);
    await assert.rejects(lstat(join(target, "unused")), { code: "ENOENT" });
    await assert.rejects(lstat(join(target, "a/node_modules/foreign")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installer refuses an active local client before replacing runtime files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "abridge-installer-live-"));
  const server = createServer((socket) => socket.end());
  try {
    await new Promise<void>((resolve) => server.listen(controlSocketPath(dir), resolve));
    await assert.rejects(assertClientStopped(dir), /Quit aBridge/);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await assertClientStopped(dir);
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("native fingerprint binds the selected state directory into runtime metadata", async () => {
  const options = {
    output: "/tmp/fixture.app",
    node: "/tmp/node",
    cli: "/tmp/client.js",
    signingIdentity: "-",
  };
  const first = await nativeBuildInputs({ ...options, stateDir: "/tmp/first-state" }),
    second = await nativeBuildInputs({ ...options, stateDir: "/tmp/second-state" });
  assert.equal(first.runtime.state_dir, "/tmp/first-state");
  assert.notEqual(first.fingerprint, second.fingerprint);
});
