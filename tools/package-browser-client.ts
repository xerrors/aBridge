import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const output = resolve(".local/release/browser-client");
const bundle = resolve(output, "abridge-client-browser");
const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
rmSync(bundle, { recursive: true, force: true });
mkdirSync(bundle, { recursive: true });
cpSync("apps/browser-client/abridge-client-browser", resolve(bundle, "abridge-client-browser"));
cpSync("apps/browser-client/requirements.txt", resolve(bundle, "requirements.txt"));
cpSync("dist/browser", resolve(bundle, "extension"), { recursive: true });
cpSync("LICENSE", resolve(bundle, "LICENSE"));
writeFileSync(resolve(bundle, "version"), version + "\n");
execFileSync("tar", [
  "-czf",
  resolve(output, `abridge-client-browser-${version}-linux.tar.gz`),
  "-C",
  output,
  "abridge-client-browser",
]);
