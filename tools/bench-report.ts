/** Generate the README from recorded real-agent outcomes; never runs a model or browser. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { format as prettier, resolveConfig } from "prettier";
import androidRegression from "../docs/benchmarks/android-world-results.json" with { type: "json" };
import androidChallenge from "../docs/benchmarks/android-world-challenge-results.json" with { type: "json" };
import suite from "./bench/agent-suite.json" with { type: "json" };
import manifest from "./bench/miniwob-agent-source.json" with { type: "json" };
import { summarizeAgent, type AgentEpisode } from "./bench/agent-metrics.js";

const root = resolve(import.meta.dirname, "..");
const { values } = parseArgs({ options: { check: { type: "boolean" } } });
const snapshotPath = resolve(root, "docs/benchmarks/miniwob-v2-results.json");
const snapshotText = await readFile(snapshotPath, "utf8");
type Snapshot = {
  schemaVersion: number;
  productVersion: string;
  productCommit: string;
  modelCatalogSha256: string | null;
  benchmarkFiles: Record<string, string>;
  recordedAt: string;
  upstream: { commit: string };
  environment: { cpu: string; platform: string; arch: string; chrome: string; node: string; codex: string };
  protocol: typeof suite & { mode: string; costUsd: null; retries: number };
  episodes: AgentEpisode[];
};
const snapshot = JSON.parse(snapshotText) as Snapshot;
const baseline = JSON.parse(
  await readFile(resolve(root, "docs/benchmarks/miniwob-v2-baseline.json"), "utf8"),
) as Snapshot;
const holdout = JSON.parse(
  await readFile(resolve(root, "docs/benchmarks/miniwob-v2-extra.json"), "utf8"),
) as Snapshot;
function validateSnapshot(snapshot: Snapshot, heldOut = false) {
  const expectedSeeds = heldOut ? [2] : suite.seeds;

  if (
    snapshot.schemaVersion !== 1 ||
    snapshot.upstream.commit !== manifest.commit ||
    snapshot.protocol.mode !== (heldOut ? "real-agent-holdout" : "real-agent-public-task-subset") ||
    snapshot.protocol.costUsd !== null ||
    snapshot.protocol.retries !== 0 ||
    !Array.isArray(snapshot.episodes)
  )
    throw Error("Unsupported agent snapshot");
  for (const key of Object.keys(suite) as (keyof typeof suite)[])
    if (
      JSON.stringify(snapshot.protocol[key]) !== JSON.stringify(key === "seeds" ? expectedSeeds : suite[key])
    )
      throw Error(`Protocol mismatch: ${key}`);
  const seen = new Set<string>();
  for (const e of snapshot.episodes) {
    if (!e || typeof e !== "object") throw Error("Invalid episode");
    for (const n of [e.rawReward, e.envReward, e.officialLimitMs])
      if (n !== null && (typeof n !== "number" || !Number.isFinite(n))) throw Error("Invalid grader metric");
    if (e.usage !== null && (typeof e.usage !== "object" || Array.isArray(e.usage)))
      throw Error("Invalid usage");
    if (e.failure !== null && typeof e.failure !== "string") throw Error("Invalid failure reason");
    const id = `${e.task}:${e.seed}`;
    if (!suite.tasks.includes(e.task) || !expectedSeeds.includes(e.seed) || seen.has(id))
      throw Error("Unexpected/duplicate episode");
    seen.add(id);
    for (const key of [
      "success",
      "businessSuccess",
      "done",
      "timedOut",
      "budgetExceeded",
      "cleanup",
    ] as const)
      if (typeof e[key] !== "boolean") throw Error(`Invalid outcome: ${key}`);
    for (const n of [e.toolCalls, e.toolViolations, ...(e.elapsedMs === null ? [] : [e.elapsedMs])])
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw Error("Invalid episode metric");
    if (
      e.businessSuccess !== (e.done && e.rawReward === 1) ||
      e.success !==
        (e.businessSuccess &&
          e.exitCode === 0 &&
          !e.timedOut &&
          !e.budgetExceeded &&
          e.toolViolations === 0) ||
      e.success !== (e.failure === null)
    )
      throw Error("Inconsistent outcome");
    if (e.usage) {
      const reasoning = e.usage.reasoningTokens;
      if (reasoning !== null && (!Number.isSafeInteger(reasoning) || reasoning < 0))
        throw Error("Invalid reasoning count");
      for (const n of [e.usage.inputTokens, e.usage.cachedInputTokens, e.usage.outputTokens])
        if (!Number.isSafeInteger(n) || n < 0) throw Error("Invalid token count");
      if (e.usage.cachedInputTokens > e.usage.inputTokens) throw Error("Invalid cached token count");
    }
  }
  if (seen.size !== suite.tasks.length * expectedSeeds.length) throw Error("Incomplete suite");
}
validateSnapshot(snapshot);
validateSnapshot(baseline);
validateSnapshot(holdout, true);
if (
  !snapshot.modelCatalogSha256 ||
  snapshot.modelCatalogSha256 !== baseline.modelCatalogSha256 ||
  snapshot.modelCatalogSha256 !== holdout.modelCatalogSha256
)
  throw Error("Comparison requires the same frozen model catalog");
if (
  JSON.stringify(snapshot.environment) !== JSON.stringify(baseline.environment) ||
  JSON.stringify(snapshot.benchmarkFiles) !== JSON.stringify(baseline.benchmarkFiles)
)
  throw Error("Before/after comparison requires the same environment and benchmark adapter");
const baselineRows = summarizeAgent(baseline.episodes, suite.tasks);
const previousSuccess = baseline.episodes.filter((e) => e.success).length;
const heldSuccess = holdout.episodes.filter((e) => e.success).length;
const rows = summarizeAgent(snapshot.episodes, suite.tasks);
const total = summarizeAgent(
  snapshot.episodes.map((e) => ({ ...e, task: "all" })),
  ["all"],
)[0]!;
const history = await Promise.all(
  [
    { version: "早期0.4.12原始基线（不同配置）", file: "miniwob-agent-results.json" },
    { version: "清理Docker后历史重跑（不同配置）", file: "miniwob-clean-host-results.json" },
    { version: "本轮stage1基线", file: "miniwob-v2-stage1-baseline.json" },
    { version: "本轮stage1候选原始判分", file: "miniwob-v2-stage1-results.json" },
    { version: "本轮stage1候选全量重解析", file: "miniwob-v2-stage1-rescored.json" },
    { version: "整合0.4.16前的0.4.14完整修复版", file: "miniwob-v2-premerge-results.json" },
  ].map(async (entry) => {
    const data = JSON.parse(await readFile(resolve(root, "docs/benchmarks", entry.file), "utf8")) as Snapshot;
    validateSnapshot(data);
    return { ...entry, data };
  }),
);
const casePolicy = JSON.parse(await readFile(resolve(root, "tools/bench-case-policy.json"), "utf8")) as {
  version: string;
  exclusionReasons: { id: string; definition: string }[];
  neverExcludeFor: string[];
  exclusions: { group: "paired" | "extra"; task: string; seed: number; reason: string; evidence: string }[];
};
const allowedReasons = new Set([
  "source_integrity_violation",
  "task_not_initialized",
  "undeclared_external_prerequisite",
  "outside_declared_task_scope",
]);
if (casePolicy.version !== "task-validity-v1" || !Array.isArray(casePolicy.exclusions))
  throw Error("Invalid case validity policy");
const allCases = [
  ...snapshot.episodes.map((e) => ({ ...e, group: "paired" as const })),
  ...holdout.episodes.map((e) => ({ ...e, group: "extra" as const })),
];
const exclusionKeys = new Set<string>();
for (const exclusion of casePolicy.exclusions) {
  const key = `${exclusion.group}:${exclusion.task}:${exclusion.seed}`;
  if (
    !allCases.some((e) => `${e.group}:${e.task}:${e.seed}` === key) ||
    exclusionKeys.has(key) ||
    !allowedReasons.has(exclusion.reason) ||
    typeof exclusion.evidence !== "string" ||
    !exclusion.evidence.trim()
  )
    throw Error("Exclusion requires a unique existing case, permitted reason and independent evidence");
  exclusionKeys.add(key);
}
const reports = [false, true].map((filtered) => {
  const cases = filtered
    ? allCases.filter((e) => !exclusionKeys.has(`${e.group}:${e.task}:${e.seed}`))
    : allCases;
  const lines = [
    `# ${filtered ? "按任务标准审核后的报告" : "全量案例报告"}`,
    "",
    filtered
      ? `审核按 ${casePolicy.version} 执行，本轮排除 ${casePolicy.exclusions.length} 例。`
      : `本表列出每次最终尝试，包括失败、超时和采集异常。审核规则版本为 ${casePolicy.version}。`,
    "",
    "| 集合 | 严格成功 / 分母 |",
    "| --- | --- |",
    ...(["paired", "extra"] as const).map((group) => {
      const es = cases.filter((e) => e.group === group);
      return `| ${group === "paired" ? "主对照 seed 0/1" : "额外 seed 2"} | ${es.filter((e) => e.success).length}/${es.length} |`;
    }),
    "",
    "两侧使用相同的模型目录和评测器。网络、模型响应和工具等待都计入端到端时间。超时按失败计入分母，即使原始奖励未知。判定任务未初始化时，以 Agent 动作前取得的独立证据为准。判分采集异常另行记录。",
    "",
    "| 集合 | 任务 | seed | 严格成功 | 原始奖励 | 失败记录 | 标准审核 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...cases.map((e) => {
      const ex = casePolicy.exclusions.find(
        (x) => x.group === e.group && x.task === e.task && x.seed === e.seed,
      );
      return `| ${e.group} | ${e.task} | ${e.seed} | ${e.success ? "是" : "否"} | ${e.rawReward ?? "未知"} | ${e.failure ?? "—"}${e.timedOut ? "（已超时）" : ""} | ${ex ? ex.reason : "符合，保留"} |`;
    }),
    "",
    "## 历史运行",
    "",
    "| 版本 | 全量严格成功 | 原始数据 |",
    "| --- | --- | --- |",
    `| 0.4.14启动修复后基线 | ${previousSuccess}/${baseline.episodes.length} | [基线](miniwob-v2-baseline.json) |`,
    ...history.map(
      (h) =>
        `| ${h.version} | ${h.data.episodes.filter((e) => e.success).length}/${h.data.episodes.length} | [逐次结果](${h.file}) |`,
    ),
    `| 当前版本 | ${total.succeeded}/${snapshot.episodes.length} | [逐次结果](miniwob-v2-results.json) |`,
    "",
    "历史运行和额外种子各自统计。第一阶段原始得分为 8/12，其中一例的 CLI 诊断消息被误判为越权。重新解析完整日志后，得分为 9/12，分母仍为 12。[修正记录](miniwob-v2-stage1-adjudication.json)",
    "",
    "## 剔除清单",
    "",
    ...(casePolicy.exclusions.length
      ? casePolicy.exclusions.map((x) => `- ${x.group}/${x.task}/${x.seed}：${x.reason}；证据：${x.evidence}`)
      : ["本轮所有任务均保留。"]),
    "",
    "## 审核标准",
    "",
    ...casePolicy.exclusionReasons.map((r) => `- ${r.id}：${r.definition}`),
    "",
    "在本机运行固定版本的上游任务，保留原有日期范围与界面。任务难度、语义标注缺失和工具能力不足均记录在试验结果中。",
    "",
    "[原始逐次结果](miniwob-v2-results.json) · [额外种子结果](miniwob-v2-extra.json) · [通用修复报告](browser-reliability-v2.md)",
    "",
    "本次测量覆盖一个模型和这组适配任务。评测范围和复现方式见 [MiniWoB++ 方法](miniwob.md)。",
  ];
  return { name: filtered ? "cases-conforming.md" : "cases-all.md", text: lines.join("\n") };
});
const env = snapshot.environment;
const fmt = (n: number | null) => (n === null ? "—" : (n / 1000).toFixed(1));
const content = [
  "<!-- benchmark:miniwob:start -->",
  "",
  `使用 **${suite.requestedModel}（${suite.reasoningEffort}）** 运行 MiniWoB++ 适配任务，共完成 **${total.succeeded}/${total.episodes}（${((100 * total.succeeded) / total.episodes).toFixed(1)}%）**。任务、种子和预算在运行前确定，每例运行一次。`,
  "",
  `主对照使用种子 0 和 1，基线完成 **${previousSuccess}/${baseline.episodes.length}**，修复后完成 **${total.succeeded}/${total.episodes}**。基线已包含浏览器启动修复。两侧使用相同的模型目录、评测器、任务提示和预算。额外种子 2 单独运行，完成 **${heldSuccess}/${holdout.episodes.length}**。审核排除 **${casePolicy.exclusions.length}** 例。`,
  "",
  "![浏览器工具优化前后对照](docs/benchmarks/miniwob-v2-comparison.svg)",
  "",
  "| 任务 | 修复前 | 修复后 | Agent P50（秒） | 工具调用总数 | 已知输入 / 输出 tokens | 用量覆盖 |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  ...rows.map(
    (r) =>
      `| \`${r.task}\` | ${baselineRows.find((b) => b.task === r.task)!.succeeded}/${r.episodes} | ${r.succeeded}/${r.episodes} | ${fmt(r.agentP50Ms)} | ${r.toolCalls} | ${r.knownInputTokens} / ${r.knownOutputTokens} | ${r.usageEpisodes}/${r.episodes} |`,
  ),
  "",
  `每例限 ${suite.episodeLimitMs / 1000} 秒和 ${suite.maxToolCalls} 次工具调用，并发 ${suite.concurrency}。Agent 可以通过 DOM 和截图观察页面，也可以读取、操作和等待。P50 从 CLI 启动开始计时，包含模型调用及已启动的失败任务。表中的 token 是已报告样本的合计，输入包含缓存。缺少用量的样本记为未知。`,
  "",
  `失败分类：${
    Object.entries(total.failures)
      .map(([k, v]) => k + " × " + v)
      .join("；") || "无"
  }。用量覆盖 ${total.usageEpisodes}/${total.episodes}，会话清理 ${total.cleaned}/${total.episodes}。`,
  "",
  "两侧都通过 CLI 参数加载同一份从缓存逐字复制的模型目录，以避开目录刷新超时。实际耗时仍会随模型服务和网络变化。",
  "",
  `模型目录的 SHA-256 为 \`${snapshot.modelCatalogSha256}\`。`,
  "",
  `测量版本为 v${snapshot.productVersion}（${snapshot.productCommit.slice(0, 7)}）。环境为 ${env.cpu} / ${env.platform} ${env.arch} / ${env.chrome} / Node ${env.node} / ${env.codex}，记录于 ${snapshot.recordedAt}。`,
  "",
  "结果对应 Chrome 扩展上的 6 类适配任务，每类 2 个种子，采用这里列出的时间预算。早期固定策略的 30/30 见执行链冒烟记录。[评测方法](docs/benchmarks/miniwob.md) · [工具修复报告](docs/benchmarks/browser-reliability-v2.md) · [全量报告](docs/benchmarks/cases-all.md) · [标准审核报告](docs/benchmarks/cases-conforming.md) · [逐次实测数据](docs/benchmarks/miniwob-v2-results.json)",
  "",
  "```sh",
  "npm run benchmark:miniwob",
  "```",
  "<!-- benchmark:miniwob:end -->",
].join("\n");
for (const report of reports) {
  const file = resolve(root, "docs/benchmarks", report.name);
  const content = await prettier(report.text, { ...(await resolveConfig(file)), filepath: file });
  if (values.check) {
    if (content !== (await readFile(file, "utf8"))) throw Error(`Case report stale: ${report.name}`);
  } else await writeFile(file, content);
}
function androidScore(run: typeof androidRegression | typeof androidChallenge) {
  const passed = run.episodes.filter((episode) => episode.success).length;
  const total = run.episodes.length;
  if (total === 0 || passed !== run.summary.passed || total !== run.summary.total)
    throw Error("Inconsistent AndroidWorld summary");
  return `${passed}/${total}（${((100 * passed) / total).toFixed(0)}%）`;
}

const coverage = [
  "<!-- benchmark:coverage:start -->",
  "",
  "| 客户端 | 公开 Agent 任务 | 已验证的范围 | 证据 |",
  "| --- | --- | --- | --- |",
  `| **Chrome 扩展** | MiniWoB++ **${total.succeeded}/${total.episodes}** | 实际 Chrome 扩展，${suite.tasks.length} 类网页任务 | [方法](docs/benchmarks/miniwob.md) · [数据](docs/benchmarks/miniwob-v2-results.json) |`,
  `| **Android 预览** | AndroidWorld 回归 **${androidScore(androidRegression)}**；挑战 **${androidScore(androidChallenge)}** | Android 13 模拟器，覆盖文件管理、笔记和跨应用任务 | [方法](docs/benchmarks/android-world.md) · [回归数据](docs/benchmarks/android-world-results.json) · [挑战数据](docs/benchmarks/android-world-challenge-results.json) |`,
  "| **macOS App** | 暂无公开任务分数 | 原生 App 构建、设备连接与执行回归 | [原生验证](tools/README.md) |",
  "| **Windows 客户端预览** | 暂无公开任务分数 | Windows x64 CI 验包，覆盖设备绑定、权限控制、Shell 和文件操作 | [Windows 验证](docs/windows-client.md#验证) |",
  "| **Linux CLI** | 暂无公开任务分数 | amd64 / arm64 CI，真实 Server 联调覆盖 Shell 和文件工具 | [Linux 验证](apps/linux-client/README.md) |",
  "",
  "<!-- benchmark:coverage:end -->",
].join("\n");

const path = resolve(root, "README.md");
const original = await readFile(path, "utf8");
const block = /<!-- benchmark:miniwob:start -->[\s\S]*?<!-- benchmark:miniwob:end -->/;
const coverageBlock = /<!-- benchmark:coverage:start -->[\s\S]*?<!-- benchmark:coverage:end -->/;
if (!block.test(original) || !coverageBlock.test(original)) throw Error("README benchmark markers missing");
const updated = await prettier(original.replace(coverageBlock, coverage).replace(block, content), {
  ...(await resolveConfig(path)),
  filepath: path,
});
if (values.check) {
  if (updated !== original) throw Error("README benchmark table is stale; run npm run benchmark:report");
  const digest = createHash("sha256");
  for (const name of ["miniwob-v2-baseline.json", "miniwob-v2-results.json", "miniwob-v2-extra.json"])
    digest.update(await readFile(resolve(root, "docs/benchmarks", name)));
  const chart = await readFile(resolve(root, "docs/benchmarks/miniwob-v2-comparison.svg"), "utf8");
  if (!chart.includes(`abridge-input-sha256:${digest.digest("hex")}`))
    throw Error("Benchmark chart is stale; run tools/bench-plot.py after formatting the result snapshots");
  console.log(
    `Verified README against ${snapshot.episodes.length} Chrome and ${androidRegression.episodes.length + androidChallenge.episodes.length} Android real-agent episodes`,
  );
} else {
  for (const name of ["miniwob-v2-baseline.json", "miniwob-v2-results.json", "miniwob-v2-extra.json"]) {
    const file = resolve(root, "docs/benchmarks", name);
    await writeFile(
      file,
      await prettier(await readFile(file, "utf8"), { ...(await resolveConfig(file)), filepath: file }),
    );
  }
  await writeFile(path, updated);
}
