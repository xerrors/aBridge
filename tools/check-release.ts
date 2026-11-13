/** Refuse mismatched, off-main or non-semver release tags before privileged jobs. */
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const tag = process.env.GITHUB_REF_NAME ?? process.argv[2];
const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};
if (!tag || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag) || tag !== `v${version}`)
  throw Error("Release tag must exactly match v + package.json version");
execFileSync("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"]);
console.log(`Verified ${tag} on main history`);
