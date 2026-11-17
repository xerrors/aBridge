/** Real Codex agent on frozen public tasks. No task-solving scripts or evaluator tools reach the actor. */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { cpus, arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import suite from "./agent-suite.json" with { type: "json" };
import manifest from "./miniwob-agent-source.json" with { type: "json" };
import { createBenchmarkEnvironment } from "./environment.js";
import { createAgentGateway } from "./gateway.js";
import { runCodexAgent } from "./codex-agent.js";

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
const { values } = parseArgs({
  options: {
    out: { type: "string" },
    chrome: { type: "string" },
    preflight: { type: "boolean" },
    holdout: { type: "boolean" },
  },
});
const root = resolve(import.meta.dirname, "../..");
const interrupted = new AbortController();
let signalCode: number | undefined;
const sigint = () => {
  signalCode = 130;
  interrupted.abort(Error("Suite interrupted"));
};
const sigterm = () => {
  signalCode = 143;
  interrupted.abort(Error("Suite interrupted"));
};
process.once("SIGINT", sigint);
process.once("SIGTERM", sigterm);
let environment: Awaited<ReturnType<typeof createBenchmarkEnvironment>> | undefined;
type AgentResult = Awaited<ReturnType<typeof runCodexAgent>>;
interface Episode {
  task: string;
  seed: number;
  success: boolean;
  businessSuccess: boolean;
  done: boolean;
  rawReward: number | null;
  envReward: number | null;
  officialLimitMs: number | null;
  elapsedMs: number | null;
  toolCalls: number;
  usage: AgentResult["usage"];
  exitCode: number | null;
  timedOut: boolean;
  budgetExceeded: boolean;
  toolViolations: number;
  cleanup: boolean;
  failure: string | null;
}
const episodes: Episode[] = [];
let persisting = Promise.resolve();
try {
  environment = await createBenchmarkEnvironment({
    manifest,
    chromeExecutable: values.chrome,
    signal: interrupted.signal,
  });
  const env = environment;
  console.log(`Agent benchmark evidence: ${env.runDirectory}`);
  const benchmarkFiles: Record<string, string> = {};
  for (const name of (await readdir(join(root, "tools/bench"))).sort())
    benchmarkFiles[name] = createHash("sha256")
      .update(await readFile(join(root, "tools/bench", name)))
      .digest("hex");
  const taskNames = values.preflight ? ["click-test"] : suite.tasks;
  const seeds = values.preflight ? [0] : values.holdout ? [2] : suite.seeds;
  const plan = seeds.flatMap((seed) => taskNames.map((task) => ({ task, seed })));
  const protocol = {
    ...suite,
    tasks: taskNames,
    seeds,
    mode: values.preflight
      ? "agent-preflight-not-scored"
      : values.holdout
        ? "real-agent-holdout"
        : "real-agent-public-task-subset",
    actions:
      "rendered DOM and native screenshots; only observe/read/act/wait; no executable JS, source access or hidden grader",
    officialLimitsOverridden: true,
    costUsd: null,
    costNote:
      "CLI does not return billed monetary cost; usage missing on interrupted/error turns is unknown, not zero",
    retries: 0,
  };
  await writeFile(
    join(env.runDirectory, "frozen-protocol.json"),
    JSON.stringify({ protocol, benchmarkFiles, upstream: manifest }, null, 2),
  );
  async function execute(task: string, seed: number, index: number) {
    const result: Episode = {
      task,
      seed,
      success: false,
      businessSuccess: false,
      done: false,
      rawReward: null,
      envReward: null,
      officialLimitMs: null,
      elapsedMs: null,
      toolCalls: 0,
      usage: null,
      exitCode: null,
      timedOut: false,
      budgetExceeded: false,
      toolViolations: 0,
      cleanup: false,
      failure: null,
    };
    let session: string | undefined;
    let gateway: Awaited<ReturnType<typeof createAgentGateway>> | undefined;
    const budget = new AbortController();
    const caseId = randomUUID();
    const caseDir = join(env.runDirectory, `${String(index).padStart(2, "0")}-${task}-${seed}`);
    await mkdir(caseDir, { recursive: true, mode: 0o700 });
    try {
      interrupted.signal.throwIfAborted();
      const opened = await env.call("session_open", { device_id: env.deviceId, capabilities: ["browser"] });
      if (typeof opened.id !== "string") throw Error("Session ID missing");
      session = opened.id;
      await env.call("browser_open", {
        session_id: session,
        url: `${env.fixtureUrl}/miniwob/${task}.html?bench_case=${caseId}`,
        screenshot: false,
      });
      const initialized = (
        await env.runCode(
          session,
          `return await page.evaluate((settings) => { const original=core.EPISODE_MAX_TIME; Math.seedrandom(settings.seed); core.setDataMode('test'); core.EPISODE_MAX_TIME=settings.limit; core.startEpisodeReal(); return {original,query:document.querySelector('#query').innerText}; }, ${JSON.stringify({ seed, limit: suite.episodeLimitMs })});`,
        )
      ).value;
      if (
        !record(initialized) ||
        typeof initialized.original !== "number" ||
        typeof initialized.query !== "string"
      )
        throw Error("Task initialization missing visible query");
      result.officialLimitMs = initialized.original;
      gateway = await createAgentGateway({
        targetUrl: env.url,
        targetToken: env.token,
        sessionId: session,
        maxToolCalls: suite.maxToolCalls,
        onBudgetExceeded: () => budget.abort(Error("Tool call budget exceeded")),
      });
      const workDir = join(caseDir, "workspace");
      await mkdir(workDir, { mode: 0o700 });
      const started = performance.now();
      const agent = await runCodexAgent({
        workDir,
        logDir: join(caseDir, "agent"),
        serverUrl: new URL(gateway.url).origin,
        bearerToken: gateway.token,
        sessionId: session,
        taskPrompt: `Complete the task on the already-open local page using this aBridge session. First observe the page with screenshot=true; the goal may be visual. Follow the rendered instruction and finish the required UI action.\nVisible task instruction: ${initialized.query}\nUse fresh observation references. Do not access task scripts, hidden state, rewards, or grading code. Do not use any tool outside the attached aBridge browser tools. Do not open another page or session. Work autonomously within ${suite.episodeLimitMs / 1000} seconds and ${suite.maxToolCalls} tool calls; then briefly report completion.`,
        model: suite.requestedModel,
        timeoutMs: suite.episodeLimitMs,
        signal: AbortSignal.any([interrupted.signal, budget.signal]),
      });
      result.elapsedMs = performance.now() - started;
      result.usage = agent.usage;
      result.exitCode = agent.exitCode;
      result.timedOut = agent.timedOut;
      result.toolCalls = gateway.calls.length;
      result.budgetExceeded = gateway.budgetExceeded;
      result.toolViolations = agent.toolViolations.length + gateway.violations.length;
      await writeFile(
        join(caseDir, "trace.json"),
        JSON.stringify(
          { agent, gatewayCalls: gateway.calls, gatewayViolations: gateway.violations },
          null,
          2,
        ),
      );
      const graded = (
        await env.runCode(
          session,
          "return await page.evaluate(() => ({done:WOB_DONE_GLOBAL,raw:WOB_RAW_REWARD_GLOBAL,reward:WOB_REWARD_GLOBAL}));",
        )
      ).value;
      if (
        !record(graded) ||
        typeof graded.done !== "boolean" ||
        typeof graded.raw !== "number" ||
        typeof graded.reward !== "number"
      )
        throw Error("Task grader unavailable");
      result.done = graded.done;
      result.rawReward = graded.raw;
      result.envReward = graded.reward;
      result.businessSuccess = result.done && result.rawReward === 1;
      result.success =
        result.businessSuccess &&
        agent.exitCode === 0 &&
        !agent.timedOut &&
        !result.budgetExceeded &&
        result.toolViolations === 0;
      result.failure = result.success
        ? null
        : result.toolViolations
          ? "tool_violation"
          : result.budgetExceeded
            ? "tool_budget"
            : agent.timedOut
              ? "time_budget"
              : agent.exitCode !== 0 || agent.error
                ? !agent.usage && result.toolCalls === 0
                  ? "agent_initialization_error"
                  : "agent_error"
                : !result.done
                  ? "goal_not_finished"
                  : "goal_incorrect";
    } catch (error) {
      // A product action may deliberately close its own task tab on uncertain input.
      // This is an end-to-end execution failure with unavailable grading, not a harness startup failure.
      const message = error instanceof Error ? error.message : String(error);
      result.failure = interrupted.signal.aborted
        ? "interrupted"
        : result.elapsedMs !== null && message.includes('"code":"task_tab_missing"')
          ? result.timedOut
            ? "time_budget"
            : "task_tab_lost"
          : "setup_or_grading_error";
      await writeFile(join(caseDir, "error.txt"), error instanceof Error ? error.message : String(error));
    } finally {
      await gateway?.close();
      if (session && !interrupted.signal.aborted) {
        try {
          await env.call("session_close", { session_id: session });
          const deadline = performance.now() + 10000;
          while (performance.now() < deadline) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            let urls: string[];
            try {
              urls = await Promise.race([
                env.targetUrls(),
                new Promise<never>((_, reject) => {
                  timer = setTimeout(
                    () => reject(Error("Cleanup observation timed out")),
                    Math.max(0, deadline - performance.now()),
                  );
                }),
              ]);
            } finally {
              clearTimeout(timer);
            }
            if (
              !urls.some((value) => {
                const url = new URL(value);
                return url.origin === env.fixtureUrl && url.searchParams.get("bench_case") === caseId;
              })
            ) {
              result.cleanup = true;
              break;
            }
            await delay(Math.min(50, Math.max(0, deadline - performance.now())));
          }
        } catch {}
      }
      episodes.push(result);
      persisting = persisting.then(() =>
        writeFile(join(env.runDirectory, "episodes.json"), JSON.stringify(episodes, null, 2) + "\n"),
      );
      await persisting;
      console.log(
        `${task} seed=${seed} ${result.success ? "PASS" : "FAIL"} reason=${result.failure ?? "none"} agent_ms=${result.elapsedMs?.toFixed(0) ?? "n/a"} calls=${result.toolCalls} usage=${result.usage ? "known" : "unknown"}`,
      );
    }
  }
  let next = 0;
  await Promise.all(
    Array.from({ length: values.preflight ? 1 : suite.concurrency }, async () => {
      while (!interrupted.signal.aborted) {
        const i = next++;
        const task = plan[i];
        if (!task) return;
        await execute(task.task, task.seed, i);
      }
    }),
  );
  interrupted.signal.throwIfAborted();
  if (episodes.length !== plan.length) throw Error("Incomplete suite");
  for (const [name, hash] of Object.entries(benchmarkFiles))
    if (
      createHash("sha256")
        .update(await readFile(join(root, "tools/bench", name)))
        .digest("hex") !== hash
    )
      throw Error(`Benchmark source changed during run: ${name}`);
  const report = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    productVersion: JSON.parse(await readFile(join(root, "package.json"), "utf8")).version as string,
    productCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    benchmarkFiles,
    workerSha256: createHash("sha256")
      .update(await readFile(join(root, "dist/browser/worker.js")))
      .digest("hex"),
    upstream: manifest,
    environment: {
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      node: process.version,
      chrome: env.browserVersion,
      codex: execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(),
    },
    protocol,
    episodes: episodes.sort(
      (a, b) => taskNames.indexOf(a.task) - taskNames.indexOf(b.task) || a.seed - b.seed,
    ),
  };
  await writeFile(join(env.runDirectory, "report.json"), JSON.stringify(report, null, 2) + "\n");
  if (values.out) {
    const path = resolve(values.out);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(report, null, 2) + "\n");
  }
  console.log(
    `Agent tasks: ${episodes.filter((e) => e.success).length}/${episodes.length}; usage coverage ${episodes.filter((e) => e.usage).length}/${episodes.length}`,
  );
  // Task failures are benchmark results, not a runner error; infrastructure/violations still fail the command.
  if (
    episodes.some(
      (e) =>
        !e.cleanup ||
        e.toolViolations ||
        ["setup_or_grading_error", "agent_initialization_error"].includes(e.failure ?? ""),
    ) ||
    (values.preflight && episodes.some((e) => !e.success))
  )
    process.exitCode = 1;
} finally {
  try {
    await environment?.close();
  } finally {
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigterm);
    if (signalCode) process.exitCode = signalCode;
  }
}
