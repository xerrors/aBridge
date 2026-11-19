import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { desktopSwiftTargets } from "./lib/desktop-swift.ts";
import { run } from "./lib/process.ts";

const targets = await desktopSwiftTargets(resolve(import.meta.dirname, ".."));
const work = await mkdtemp(join(tmpdir(), "abridge-swift-check-"));
try {
  for (const [name, args] of Object.entries(targets)) {
    const start = performance.now();
    await run("/usr/bin/swiftc", [
      "-Onone",
      "-whole-module-optimization",
      "-emit-object",
      ...args,
      "-o",
      join(work, name + ".o"),
    ]);
    console.log(`Compiled ${name} in ${((performance.now() - start) / 1000).toFixed(1)}s`);
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
