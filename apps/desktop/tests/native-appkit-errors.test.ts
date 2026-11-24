import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { plist } from "../../../tools/build-native.js";
import { desktopSwiftTargets } from "../../../tools/lib/desktop-swift.js";
import { run } from "../../../tools/lib/process.js";

const secret = "abr_device_fixture_secret";

test(
  "native AppKit settings and diagnostics show actionable binding and startup errors",
  { skip: process.platform !== "darwin" || process.arch !== "arm64", timeout: 120_000 },
  async () => {
    const work = await mkdtemp(join(tmpdir(), "abridge-appkit-errors-"));
    const root = resolve(import.meta.dirname, "../../..");
    const contents = join(work, "aBridge Test.app", "Contents");
    const executable = join(contents, "MacOS", "AppKitErrorTest");
    const state = join(work, "state");
    try {
      await mkdir(join(contents, "MacOS"), { recursive: true });
      await mkdir(join(contents, "Resources"));
      await mkdir(state, { mode: 0o700 });
      await writeFile(
        join(contents, "Info.plist"),
        plist({
          CFBundleIdentifier: "dev.abridge.appkit-error-test",
          CFBundleExecutable: "AppKitErrorTest",
          CFBundlePackageType: "APPL",
          LSUIElement: true,
        }),
      );
      await writeFile(join(contents, "Resources", "runtime.json"), JSON.stringify({ state_dir: state }));
      await writeFile(
        join(contents, "MacOS", "abridge-desktop"),
        String.raw`#!/bin/sh
set -eu
test "$1" = "--state-dir"
case "$3" in
  diagnose)
    printf '%s\n' '{"runtime":{"ready":true,"version":"fixture"}}'
    ;;
  run)
    test -f "$2/credentials/device.json"
    printf '%s\n' '{"ok":false,"error":{"code":"already_running","message":"${secret}"}}'
    exit 1
    ;;
  authorize)
    test "$4" = "--stdin"
    if [ ! -e "$2/first-attempt" ]; then
      exec 0<&-
      touch "$2/first-attempt"
      printf '%s\n' '{"ok":false,"error":{"code":"invalid_contract","message":"${secret}"}}'
      exit 1
    fi
    IFS= read -r request
    test -n "$request"
    printf '%s\n' 'unexpected stdout: ${secret}'
    exit 7
    ;;
  *) exit 99 ;;
esac
`,
        { mode: 0o700 },
      );

      const swift = await desktopSwiftTargets(root);
      await run("/usr/bin/swiftc", [
        "-parse-as-library",
        ...swift.aBridge.filter((argument) => argument !== join(root, "apps/desktop/native/main.swift")),
        join(import.meta.dirname, "native-appkit-errors.swift"),
        "-o",
        executable,
      ]);
      assert.match(await run(executable, [state, secret], { timeout: 20_000 }), /PASS native AppKit errors/);
      assert.ok(!(await readFile(join(state, "logs/client.log"), "utf8")).includes(secret));
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
);
