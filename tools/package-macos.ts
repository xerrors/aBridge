/** Build a relocatable App containing Node and its production dependency closure. */
import { mkdtemp, readFile, mkdir, rm, writeFile, cp, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { installDesktop, parseDesktopInstallOptions, smokeDesktopRuntime } from "./install-desktop.js";
import { buildNative, PROJECT_ROOT } from "./build-native.js";
import { run } from "./lib/process.js";
const { values } = parseArgs({
  options: { "signing-identity": { type: "string" }, notarize: { type: "boolean" } },
});
const identity = values["signing-identity"] ?? "-",
  notarize = values.notarize ?? false;
if (notarize && identity === "-") throw Error("Notarization requires a Developer ID signing identity");
const { version } = JSON.parse(await readFile(join(PROJECT_ROOT, "package.json"), "utf8")) as {
  version: string;
};
const work = await mkdtemp(join(tmpdir(), "abridge-macos-package-")),
  out = resolve(PROJECT_ROOT, "dist/releases");
await mkdir(out, { recursive: true });
let pendingArchive: string | undefined;
try {
  const installed = await installDesktop(
    parseDesktopInstallOptions(["--app", join(work, "development.app"), "--state-dir", join(work, "state")]),
    PROJECT_ROOT,
  );
  const app = join(work, "portable/aBridge.app");
  await buildNative({
    output: app,
    node: installed.node,
    cli: installed.cli,
    bundledRuntime: installed.runtime,
    signingIdentity: identity,
    force: true,
  });
  const metadata = JSON.parse(await readFile(join(app, "Contents/Resources/runtime.json"), "utf8"));
  if (JSON.stringify(metadata) !== JSON.stringify({ runtime_mode: "bundled" }))
    throw Error("Portable metadata contains machine-specific paths");
  await smokeDesktopRuntime(join(app, "Contents/Resources/runtime"));
  const label = notarize ? "notarized" : identity === "-" ? "unsigned" : "signed-unnotarized";
  const archive = join(out, `aBridge-${version}-macos-arm64-${label}.zip`);
  const submission = join(work, "submission.zip");
  await run("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, submission]);
  if (notarize) {
    const { APPLE_API_KEY_FILE: key, APPLE_API_KEY_ID: keyId, APPLE_API_ISSUER: issuer } = process.env;
    if (!key || !keyId || !issuer)
      throw Error("Notarization requires App Store Connect API key file, key ID and issuer");
    const receipt = await run(
      "/usr/bin/xcrun",
      [
        "notarytool",
        "submit",
        submission,
        "--key",
        key,
        "--key-id",
        keyId,
        "--issuer",
        issuer,
        "--wait",
        "--output-format",
        "json",
      ],
      { timeout: 900000 },
    );
    const result = JSON.parse(receipt) as { status: string; id: string };
    if (result.status !== "Accepted")
      throw Error(`Notarization was not accepted: ${result.status} (${result.id})`);
    await run("/usr/bin/xcrun", ["stapler", "staple", app]);
    await run("/usr/bin/xcrun", ["stapler", "validate", app]);
    await run("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, submission]);
  }
  pendingArchive = archive + ".pending";
  await cp(submission, pendingArchive);
  await rename(pendingArchive, archive);
  pendingArchive = undefined;
  await writeFile(
    join(out, `macos-${label}-verification.json`),
    JSON.stringify(
      {
        version,
        architecture: "arm64",
        portable_metadata: true,
        standalone_runtime_smoke: true,
        notarized: notarize,
        signed: identity !== "-",
      },
      null,
      2,
    ),
  );
  console.log(`Packaged ${archive}`);
} finally {
  if (pendingArchive) await rm(pendingArchive, { force: true });
  await rm(work, { recursive: true, force: true });
}
