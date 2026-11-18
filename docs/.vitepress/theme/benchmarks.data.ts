import { defineLoader } from "vitepress";
import { readFile } from "node:fs/promises";

const suites = [
  {
    title: "MiniWoB++ 适配子集",
    description: "Chrome 扩展 · 每例限时 180 秒",
    file: "miniwob-v2-results.json",
    report: "/benchmarks/browser-reliability-v2.html",
  },
  {
    title: "AndroidWorld 回归集",
    description: "Android 13 模拟器 · 文件与笔记",
    file: "android-world-results.json",
    report: "/benchmarks/android-world.html#measured-result",
  },
  {
    title: "AndroidWorld 挑战集",
    description: "Android 13 模拟器 · 跨应用与多步操作",
    file: "android-world-challenge-results.json",
    report: "/benchmarks/android-world.html#challenge-results",
  },
];

interface Score {
  title: string;
  description: string;
  report: string;
  outcomes: boolean[];
  passed: number;
  tasks: number;
  seeds: number;
}

export declare const data: Score[];
export default defineLoader({
  watch: suites.map(({ file }) => "../../benchmarks/" + file),
  async load(files): Promise<Score[]> {
    return Promise.all(
      suites.map(async ({ file, title, description, report }) => {
        const path = files.find((path) => path.endsWith("/" + file));
        if (!path) throw new Error("Missing benchmark snapshot: " + file);
        const { episodes }: { episodes: { success: boolean; task: string; seed: number }[] } = JSON.parse(
          await readFile(path, "utf8"),
        );
        const outcomes = episodes.map((episode) => episode.success);
        return {
          title,
          description,
          report,
          outcomes,
          passed: outcomes.filter(Boolean).length,
          tasks: new Set(episodes.map((e) => e.task)).size,
          seeds: new Set(episodes.map((e) => e.seed)).size,
        };
      }),
    );
  },
});
