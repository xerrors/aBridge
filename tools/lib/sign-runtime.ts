/** Sign nested native code before sealing the enclosing App bundle. */
import { open, readdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { run } from "./process.js";
export async function signBundledRuntime(root: string, identity: string): Promise<void> {
  const entitlements = join(root, ".node-entitlements.plist");
  await writeFile(
    entitlements,
    '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>',
  );
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw Error("Bundled runtime cannot contain symlinks");
      if (entry.isDirectory()) {
        await visit(file);
        continue;
      }
      const handle = await open(file, "r"),
        magic = Buffer.alloc(4);
      try {
        await handle.read(magic, 0, 4, 0);
      } finally {
        await handle.close();
      }
      if (!["cffaedfe", "cefaedfe", "cafebabe", "bebafeca"].includes(magic.toString("hex"))) continue;
      await run("/usr/bin/codesign", [
        "--force",
        "--sign",
        identity,
        ...(identity === "-" ? [] : ["--options", "runtime", "--timestamp"]),
        ...(file === join(root, "node") && identity !== "-" ? ["--entitlements", entitlements] : []),
        file,
      ]);
    }
  }
  try {
    await visit(root);
  } finally {
    await unlink(entitlements);
  }
}
