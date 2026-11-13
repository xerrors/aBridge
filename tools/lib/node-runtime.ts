/** Official relocatable Node distribution. Homebrew binaries are not self-contained. */
import { mkdir, readFile, rename, rm, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { run } from "./process.js";
export const DESKTOP_NODE_VERSION = "26.13.1";
export function checksumFor(checksums: string, filename: string): string {
  const line = checksums
    .split(/\r?\n/)
    .find((line) => line.trim().split(/\s+/)[1]?.replace(/^\*/, "") === filename);
  if (!line || !/^([a-f0-9]{64})\s+/.test(line)) throw Error(`Official Node checksums omit ${filename}`);
  return line.slice(0, 64);
}
export function nonSystemLibraries(otoolOutput: string): string[] {
  return otoolOutput
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(" (")[0])
    .filter((line) => line && !line.startsWith("/usr/lib/") && !line.startsWith("/System/Library/"));
}
export async function validateNodeBinary(path: string): Promise<void> {
  const dependencies = nonSystemLibraries(await run("/usr/bin/otool", ["-L", path]));
  if (dependencies.length)
    throw Error(
      `Node binary is not relocatable (${dependencies.join(", ")}). Use the official Node ${DESKTOP_NODE_VERSION} darwin-arm64 distribution.`,
    );
  const version = JSON.parse(
    await run(path, [
      "-p",
      "JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch})",
    ]),
  ) as { version: string; platform: string; arch: string };
  const [major, minor] = version.version.split(".").map(Number);
  if (major !== 26 || minor < 7 || version.platform !== "darwin" || version.arch !== "arm64")
    throw Error("Desktop runtime requires Node >=26.7 <27, darwin-arm64");
}
export async function acquireOfficialNode(
  cacheDirectory: string,
): Promise<{ node: string; license: string; version: string; sha256: string }> {
  const basename = `node-v${DESKTOP_NODE_VERSION}-darwin-arm64`,
    filename = basename + ".tar.gz",
    base = `https://nodejs.org/dist/v${DESKTOP_NODE_VERSION}/`,
    directory = resolve(cacheDirectory, DESKTOP_NODE_VERSION);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const archive = join(directory, filename),
    sumsFile = join(directory, "SHASUMS256.txt");
  let sums: string;
  try {
    sums = await readFile(sumsFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const partial = sumsFile + "." + randomUUID();
    try {
      await run(
        "/usr/bin/curl",
        [
          "--fail",
          "--location",
          "--proto",
          "=https",
          "--tlsv1.2",
          "--max-time",
          "120",
          "--output",
          partial,
          base + "SHASUMS256.txt",
        ],
        { timeout: 125000 },
      );
      sums = await readFile(partial, "utf8");
      checksumFor(sums, filename);
      await rename(partial, sumsFile);
    } finally {
      await rm(partial, { force: true });
    }
  }
  const expected = checksumFor(sums, filename);
  let bytes: Buffer | undefined;
  try {
    bytes = await readFile(archive);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!bytes) {
    const partial = archive + "." + randomUUID();
    try {
      await run(
        "/usr/bin/curl",
        [
          "--fail",
          "--location",
          "--proto",
          "=https",
          "--tlsv1.2",
          "--max-time",
          "180",
          "--output",
          partial,
          base + filename,
        ],
        { timeout: 185000 },
      );
      bytes = await readFile(partial);
      if (createHash("sha256").update(bytes).digest("hex") !== expected)
        throw Error("Official Node archive checksum mismatch");
      await rename(partial, archive);
    } finally {
      await rm(partial, { force: true });
    }
  }
  if (createHash("sha256").update(bytes).digest("hex") !== expected)
    throw Error("Cached Node archive checksum mismatch; remove the cache and retry");
  const extracted = join(directory, basename);
  await mkdir(extracted, { recursive: true, mode: 0o700 });
  await run("/usr/bin/tar", [
    "-xzf",
    archive,
    "-C",
    directory,
    `${basename}/bin/node`,
    `${basename}/LICENSE`,
  ]);
  const node = join(extracted, "bin/node");
  await chmod(node, 0o700);
  await validateNodeBinary(node);
  return { node, license: join(extracted, "LICENSE"), version: DESKTOP_NODE_VERSION, sha256: expected };
}
