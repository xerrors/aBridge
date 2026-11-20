import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { windowsDesktopContract } from "@abridge/protocol/desktop-contract";
import { WINDOWS_SCRIPT } from "../../apps/windows/src/windows-script.js";
import { windowsCommand } from "../../apps/windows/src/windows-command.js";

/** Keep the retained TS driver reference and the native embedded driver identical. */
export function writeWindowsContract(root: string, output: string): void {
  const clean = (text: string) => text.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
  const source = resolve(root, "apps/windows/windows-native-shell/src/runtime");
  assert.equal(
    clean(readFileSync(resolve(source, "driver-host.ps1"), "utf8")),
    clean(WINDOWS_SCRIPT),
    "Native desktop driver drifted from its reference",
  );
  const encoded = windowsCommand("ABRIDGE_COMMAND_PLACEHOLDER").at(-1);
  assert.ok(encoded);
  assert.equal(
    clean(readFileSync(resolve(source, "command-host.ps1"), "utf8")),
    clean(Buffer.from(encoded, "base64").toString("utf16le")),
    "Native Shell wrapper drifted from its reference",
  );
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(windowsDesktopContract()) + "\n");
}
