import assert from "node:assert/strict";
import { test } from "node:test";
import { serverPackageLock, type PackageLock } from "../lib/server-lock.js";

const manifest = { name: "@example/server", version: "1.0.0", dependencies: { a: "1.0.0" } };
test("Server production lock preserves hoisted, nested, cyclic, optional and peer resolutions", () => {
  const lock: PackageLock = {
    packages: {
      "apps/server": { dependencies: manifest.dependencies },
      "node_modules/a": {
        version: "1.0.0",
        integrity: "sha512-fixture-a",
        dependencies: { shared: "^2", b: "1" },
        optionalDependencies: { missing: "1" },
        peerDependencies: { peer: "1", absentPeer: "1" },
        peerDependenciesMeta: { absentPeer: { optional: true } },
      },
      "node_modules/a/node_modules/shared": { version: "2.1.0", resolved: "fixture:shared2" },
      "node_modules/shared": { version: "1.2.0", integrity: "sha512-fixture-shared" },
      "node_modules/b": { version: "1.0.0", dependencies: { a: "1", shared: "1" } },
      "node_modules/peer": { version: "1.0.0", dev: true, devOptional: true },
      "node_modules/build-tool": { version: "9.0.0", dev: true },
      "node_modules/@trycua/cua-driver": { version: "1.0.0", optional: true },
    },
  };
  const projected = serverPackageLock(lock, manifest);
  assert.deepEqual(Object.keys(projected.packages).sort(), [
    "",
    "node_modules/a",
    "node_modules/a/node_modules/shared",
    "node_modules/b",
    "node_modules/peer",
    "node_modules/shared",
  ]);
  assert.equal(projected.packages["node_modules/a"]!.integrity, "sha512-fixture-a");
  assert.equal(projected.packages["node_modules/a/node_modules/shared"]!.version, "2.1.0");
  assert.equal(projected.packages["node_modules/peer"]!.dev, undefined);
  assert.equal(projected.packages["node_modules/peer"]!.devOptional, undefined);
  assert.equal(lock.packages["node_modules/peer"]!.dev, true, "Do not modify the source lock");
  assert.deepEqual(serverPackageLock(lock, manifest), projected);
});

test("Server production lock refuses missing production dependencies and workspace links", () => {
  assert.throws(() => serverPackageLock({ packages: {} }, manifest), /Production lock omits a/);
  assert.throws(
    () => serverPackageLock({ packages: { "node_modules/a": { link: true } } }, manifest),
    /requires a registry dependency/,
  );
});
