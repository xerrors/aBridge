/** Generate the README from recorded real-agent outcomes; never runs a model or browser. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { format as prettier, resolveConfig } from "prettier";
import suite from "./bench/agent-suite.json" with { type: "json" };
import manifest from "./bench/miniwob-agent-source.json" with { type: "json" };
import { summarizeAgent, type AgentEpisode } from "./bench/agent-metrics.js";

const root = resolve(import.meta.dirname, "..");
const { values } = parseArgs({ options: { check: { type: "boolean" } } });
const snapshotPath = resolve(root, "docs/benchmarks/miniwob-tools-results.json");
const snapshotText = await readFile(snapshotPath, "utf8");
type Snapshot = {
  schemaVersion: number;
  productVersion: string;
  productCommit: string;
  recordedAt: string;
  upstream: { commit: string };
  environment: { cpu: string; platform: string; arch: string; chrome: string; node: string; codex: string };
  protocol: typeof suite & { mode: string; costUsd: null; retries: number };
  episodes: AgentEpisode[];
};
const snapshot = JSON.parse(snapshotText) as Snapshot;
const baseline = JSON.parse(
  await readFile(resolve(root, "docs/benchmarks/miniwob-agent-results.json"), "utf8"),
) as Snapshot;
const holdout = JSON.parse(
  await readFile(resolve(root, "docs/benchmarks/miniwob-tools-holdout.json"), "utf8"),
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
const baselineRows = summarizeAgent(baseline.episodes, suite.tasks);
const previousSuccess = baseline.episodes.filter((e) => e.success).length;
const heldSuccess = holdout.episodes.filter((e) => e.success).length;
const rows = summarizeAgent(snapshot.episodes, suite.tasks);
const total = summarizeAgent(
  snapshot.episodes.map((e) => ({ ...e, task: "all" })),
  ["all"],
)[0]!;
const history = await Promise.all(
  ["stage1", "stage2", "stage3", "stage4"].map(async (version) => {
    const file = `miniwob-tools-${version}-results.json`;
    const data = JSON.parse(await readFile(resolve(root, "docs/benchmarks", file), "utf8")) as Snapshot;
    validateSnapshot(data);
    return { version, file, data };
  }),
);
const casePolicy = JSON.parse(await readFile(resolve(root, "tools/bench/case-policy.json"), "utf8")) as {
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
    `政策版本：${casePolicy.version}。${filtered ? `本轮剔除 ${casePolicy.exclusions.length} 例。` : "包含全部最终尝试，失败、超时和采集异常不隐去。"}`,
    "",
    "| 集合 | 严格成功 / 分母 |",
    "| --- | --- |",
    ...(["paired", "extra"] as const).map((group) => {
      const es = cases.filter((e) => e.group === group);
      return `| ${group === "paired" ? "主对照 seed 0/1" : "额外 seed 2"} | ${es.filter((e) => e.success).length}/${es.length} |`;
    }),
    "",
    "最终运行存在CLI模型目录刷新超时记录，端到端等待受工具之外因素干扰，详见通用修复报告。超时全部保留；此运行质量问题不属于任务不合规，不能据此剔除。",
    "",
    "任务未初始化仅指Agent动作前已由独立证据确认的错误。操作后的异常、任务失败、预算耗尽、模型或工具能力不足都不是排除理由。判分采集异常与任务合规性分别记录；已超时即严格失败，不因奖励未知而剔除。",
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
    "## 版本历史（不混入最终分母）",
    "",
    "| 版本 | 全量严格成功 | 原始数据 |",
    "| --- | --- | --- |",
    `| 原始基线 | ${previousSuccess}/${baseline.episodes.length} | [基线](miniwob-agent-results.json) |`,
    ...history.map(
      (h) =>
        `| ${h.version} | ${h.data.episodes.filter((e) => e.success).length}/${h.data.episodes.length} | [逐次结果](${h.file}) |`,
    ),
    `| 当前版本 | ${total.succeeded}/${snapshot.episodes.length} | [逐次结果](miniwob-tools-results.json) |`,
    "",
    "历史数据保留，不用不同版本的最好成绩拼接最终结果。额外种子另列，不将重复尝试混入主对照。",
    "",
    "## 剔除清单",
    "",
    ...(casePolicy.exclusions.length
      ? casePolicy.exclusions.map((x) => `- ${x.group}/${x.task}/${x.seed}：${x.reason}；证据：${x.evidence}`)
      : ["无。当前没有证据证明这些任务违反约定，不能为提高分数而强行剔除。"]),
    "",
    "## 审核标准",
    "",
    ...casePolicy.exclusionReasons.map((r) => `- ${r.id}：${r.definition}`),
    "",
    "固定上游任务在本地运行；日期范围和界面变化属于原始任务内容，不因难度或缺少语义标注而排除。工具不足应作为产品问题修复。",
    "",
    "[原始逐次结果](miniwob-tools-results.json) · [额外种子结果](miniwob-tools-holdout.json) · [通用修复报告](browser-reliability.md)",
    "",
    "这是小样本、单模型的探索性结果，不是官方榜单或大样本泛化结论。",
  ];
  return { name: filtered ? "cases-conforming.md" : "cases-all.md", text: lines.join("\n") };
});
const env = snapshot.environment;
const fmt = (n: number | null) => (n === null ? "—" : (n / 1000).toFixed(1));
const content = [
  "<!-- benchmark:miniwob:start -->",
  "",
  `真实 **${suite.requestedModel}（${suite.reasoningEffort}）Agent** 通过 aBridge 完成公开 MiniWoB++ 任务：**${total.succeeded}/${total.episodes}（${((100 * total.succeeded) / total.episodes).toFixed(1)}%）**。任务、种子和预算在跑分前冻结，无重试，全部结果保留。`,
  "",
  `通用工具修复前 **${previousSuccess}/${baseline.episodes.length}** → 修复后 **${total.succeeded}/${total.episodes}**；模型、任务 prompt、seed 0/1 和预算不变。另用额外 seed=2 验证：**${heldSuccess}/${holdout.episodes.length}**，单独统计。标准审核剔除 **${casePolicy.exclusions.length}** 例。`,
  "",
  "![浏览器工具优化前后对照](docs/benchmarks/miniwob-comparison.svg)",
  "",
  "| 任务 | 修复前 | 修复后 | Agent P50（秒） | 工具调用总数 | 已知输入 / 输出 tokens | 用量覆盖 |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  ...rows.map(
    (r) =>
      `| \`${r.task}\` | ${baselineRows.find((b) => b.task === r.task)!.succeeded}/${r.episodes} | ${r.succeeded}/${r.episodes} | ${fmt(r.agentP50Ms)} | ${r.toolCalls} | ${r.knownInputTokens} / ${r.knownOutputTokens} | ${r.usageEpisodes}/${r.episodes} |`,
  ),
  "",
  `每例限 ${suite.episodeLimitMs / 1000} 秒 / ${suite.maxToolCalls} 次工具调用，并发 ${suite.concurrency}；仅开放观察、读取、操作、等待，支持 DOM 与截图，不开放 JS 执行、源码直接读取或判分接口。P50 包含 CLI 启动和模型调用，已启动的失败也计时。表中 token 为已知样本合计（输入含缓存），超时未返回用量视为未知，不能按 0 计费；CLI 不提供实际美元账单。`,
  "",
  `失败分类：${
    Object.entries(total.failures)
      .map(([k, v]) => k + " × " + v)
      .join("；") || "无"
  }。用量覆盖 ${total.usageEpisodes}/${total.episodes}；会话清理 ${total.cleaned}/${total.episodes}。`,
  "",
  "最终运行的 CLI 日志出现模型目录刷新超时，端到端耗时受工具之外等待影响；失败全部保留，不能据此宣称稳定速度或成本优势。详见工具修复报告。",
  "",
  `测量快照：v${snapshot.productVersion} / ${snapshot.productCommit.slice(0, 7)}。环境：${env.cpu} / ${env.platform} ${env.arch} / ${env.chrome} / Node ${env.node} / ${env.codex}；记录时间 ${snapshot.recordedAt}。`,
  "",
  "这是 **6 类任务、每类 2 个种子的小样本适配子集**，原始任务限时统一延长至 180 秒，不是官方榜单成绩；单次前后对照仍有模型随机性，也不能单独证明 aBridge 优于其他工具或覆盖 macOS App。固定策略的 30/30 仅作为执行链冒烟历史数据，与 Agent 分数分开。[方法与限制](docs/benchmarks/miniwob.md) · [工具修复报告](docs/benchmarks/browser-reliability.md) · [全量报告](docs/benchmarks/cases-all.md) · [标准审核报告](docs/benchmarks/cases-conforming.md) · [逐次实测数据](docs/benchmarks/miniwob-tools-results.json)。",
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
const path = resolve(root, "README.md");
const original = await readFile(path, "utf8");
const block = /<!-- benchmark:miniwob:start -->[\s\S]*?<!-- benchmark:miniwob:end -->/;
if (!block.test(original)) throw Error("README benchmark markers missing");
const updated = await prettier(original.replace(block, content), {
  ...(await resolveConfig(path)),
  filepath: path,
});
if (values.check) {
  if (updated !== original) throw Error("README benchmark table is stale; run npm run benchmark:report");
  const digest = createHash("sha256");
  for (const name of [
    "miniwob-agent-results.json",
    "miniwob-tools-results.json",
    "miniwob-tools-holdout.json",
  ])
    digest.update(await readFile(resolve(root, "docs/benchmarks", name)));
  const chart = await readFile(resolve(root, "docs/benchmarks/miniwob-comparison.svg"), "utf8");
  if (!chart.includes(`abridge-input-sha256:${digest.digest("hex")}`))
    throw Error("Benchmark chart is stale; run tools/bench-plot.py after formatting the result snapshots");
  console.log(`Verified README and chart against ${snapshot.episodes.length} real-agent episodes`);
} else {
  for (const name of [
    "miniwob-agent-results.json",
    "miniwob-tools-results.json",
    "miniwob-tools-holdout.json",
  ]) {
    const file = resolve(root, "docs/benchmarks", name);
    await writeFile(
      file,
      await prettier(await readFile(file, "utf8"), { ...(await resolveConfig(file)), filepath: file }),
    );
  }
  await writeFile(path, updated);
}
