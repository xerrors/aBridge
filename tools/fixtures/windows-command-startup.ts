/** Failure-only CI probe: fixed commands, phase timings, no environment values or device state. */
import childProcess, { type SpawnOptions } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";

if (process.platform !== "win32") throw Error("Windows diagnostic only");
const spawn = childProcess.spawn;
let inheritEnvironment = false;
childProcess.spawn = ((command: string, args: string[], options: SpawnOptions) => {
  if (!args.includes("-EncodedCommand")) return spawn(command, args, options);
  const encoded = args.indexOf("-EncodedCommand") + 1;
  let script = Buffer.from(args[encoded]!, "base64").toString("utf16le");
  const phase = (name: string) =>
    `[Console]::Error.WriteLine('probe:${name} ' + [DateTime]::UtcNow.ToString('O'))\n`;
  script = phase("started") + script;
  script = script.replace("Add-Type -TypeDefinition", phase("before-compile") + "Add-Type -TypeDefinition");
  script = script.replace(
    "[ABridgeCommandJob]::Attach()",
    phase("after-compile") + "[ABridgeCommandJob]::Attach()\n" + phase("after-job"),
  );
  const updated = args.slice();
  updated[encoded] = Buffer.from(script, "utf16le").toString("base64");
  return spawn(command, updated, {
    ...options,
    env: inheritEnvironment ? { ...process.env, ...options.env } : options.env,
  });
}) as typeof childProcess.spawn;
syncBuiltinESMExports();
const { LocalExecutor } = await import("../../apps/windows/src/executor.js");
for (const inherited of [false, true]) {
  inheritEnvironment = inherited;
  const executor = new LocalExecutor();
  const started = performance.now();
  try {
    const result = await executor.execute("startup-probe", "command_execute", {
      command: "[Console]::Write('fixture-ready 中文 😀'); [Console]::Write($env:ABRIDGE_TEST_VALUE)",
      env: { ABRIDGE_TEST_VALUE: "中文 😀" },
      timeout: 75,
    });
    console.log(JSON.stringify({ inherited, elapsed_ms: performance.now() - started, result }));
  } finally {
    await executor.shutdown();
  }
}
