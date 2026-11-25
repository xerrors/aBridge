import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
const archive = resolve(output, `abridge-client-browser-${version}-linux.tar.gz`);
execFileSync("tar", ["-czf", archive, "-C", output, "abridge-client-browser"]);

const installer = "install-browser-client.sh";
const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
const script = readFileSync(`apps/browser-client/${installer}`, "utf8")
  .replace("@VERSION@", version)
  .replace("@ARCHIVE_SHA256@", sha256);
writeFileSync(resolve(output, installer), script, { mode: 0o755 });
