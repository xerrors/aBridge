import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseNativeBuildOptions, plist } from "../build-native.js";
import { createServer } from "node:net";
import { assertClientStopped, controlSocketPath, parseDesktopInstallOptions } from "../install-desktop.js";

test("native build accepts portable metadata and rejects obsolete Node paths", () => {
  assert.throws(() => parseNativeBuildOptions([]), /output/);
  const options = parseNativeBuildOptions([
    "--output",
    "/tmp/fixture.app",
    "--force",
    "--signing-identity",
    "fixture",
  ]);
  assert.equal(options.force, true);
  assert.equal(options.signingIdentity, "fixture");
  assert.equal(options.stateDir, undefined);
  assert.throws(
    () => parseNativeBuildOptions(["--output", "/tmp/fixture.app", "--node", "/tmp/node"]),
    /Unknown option/,
  );
  const install = parseDesktopInstallOptions([], "/fixture/home");
  assert.equal(install.stateDir, resolve("/fixture/home/Library/Application Support/aBridge"));
  assert.equal(install.app, resolve("/fixture/home/Applications/aBridge.app"));
  assert.match(plist({ Name: "a<&", Enabled: true }), /<string>a&lt;&amp;<\/string>/);
});

test("installer socket identity stays within Unix socket limits for long state paths", () => {
  const path = "/tmp/" + "long-state-".repeat(25);
  assert.match(controlSocketPath(path), /^\/tmp\/abridge-(?:\d+|user)-[a-f0-9]{24}\.sock$/);
  assert.equal(controlSocketPath("/tmp/state"), join("/tmp/state", "control.sock"));
});

test(
  "installer refuses an active native client before replacing application files",
  { skip: process.platform === "win32" && "macOS installer uses Unix sockets" },
  async () => {
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
  },
);
