import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export async function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<string> {
  const result = await exec(command, [...args], {
    ...options,
    timeout: options.timeout ?? 120000,
    maxBuffer: 8 * 1024 * 1024,
    encoding: "utf8",
  });
  return result.stdout.trim();
}
