import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";

const docsDir = fileURLToPath(new URL("../", import.meta.url));

const base = process.env.DOCS_BASE ?? "/";

export default defineConfig({
  base,
  lang: "zh-CN",
  title: "aBridge",
  description: "自托管的 MCP 服务，让 Agent 在你授权的设备和浏览器中执行任务。",
  appearance: false,
  srcExclude: ["assets/**"],
  head: [["link", { rel: "icon", href: base + "assets/brand/bridge.svg", type: "image/svg+xml" }]],
  themeConfig: {
    siteTitle: false,
    logo: { src: "/assets/brand/wordmark.svg", alt: "aBridge 首页" },
    nav: [
      { text: "工作原理", link: "/#runtime" },
      { text: "任务评测", link: "/#benchmarks" },
      { text: "文档", link: "/guide/start" },
      { text: "GitHub", link: "https://github.com/xerrors/aBridge" },
    ],
    sidebar: [
      {
        text: "使用指南",
        items: [
          { text: "快速开始", link: "/guide/start" },
          { text: "安装与维护", link: "/deployment" },
          { text: "Windows 客户端", link: "/windows-client" },
          { text: "浏览器客户端", link: "/browser-profile-design" },
          { text: "变更记录", link: "/changelog" },
        ],
      },
      {
        text: "评测报告",
        collapsed: true,
        items: [
          { text: "MiniWoB++", link: "/benchmarks/miniwob" },
          { text: "浏览器可靠性", link: "/benchmarks/browser-reliability-v2" },
          { text: "全量案例", link: "/benchmarks/cases-all" },
          { text: "案例审核", link: "/benchmarks/cases-conforming" },
          { text: "AndroidWorld", link: "/benchmarks/android-world" },
        ],
      },
      {
        text: "开发参考",
        collapsed: true,
        items: [
          { text: "架构与执行契约", link: "/architecture" },
          { text: "设计与资产", link: "/design" },
          { text: "版本发布", link: "/releasing" },
          { text: "Chrome 商店发布", link: "/chrome-store" },
          { text: "隐私政策", link: "/privacy" },
          { text: "第三方许可", link: "/third-party-notices" },
        ],
      },
    ],
    outline: { label: "本页内容" },
    docFooter: { prev: "上一页", next: "下一页" },
    sidebarMenuLabel: "文档目录",
    returnToTopLabel: "返回顶部",
    skipToContentLabel: "跳至正文",
  },
  async buildEnd({ outDir }) {
    // Markdown links to raw reports and theme URLs retain their original paths.
    const reports = await readdir(join(docsDir, "benchmarks"));
    const assets = [
      "assets/brand/bridge.svg",
      "assets/brand/wordmark.svg",
      ...reports.filter((name) => name.endsWith(".json")).map((name) => `benchmarks/${name}`),
    ];
    for (const asset of assets) {
      const destination = join(outDir, asset);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(docsDir, asset), destination);
    }
  },
});
