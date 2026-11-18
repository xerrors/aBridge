<script setup lang="ts">
import { ref } from "vue";
import { withBase } from "vitepress";
import RuntimeSection from "./RuntimeSection.vue";
import BenchmarkSection from "./BenchmarkSection.vue";
import { ChevronRight } from "@lucide/vue";
import BridgeFigure from "./BridgeFigure.vue";
import chrome from "../../assets/brand/platforms/chrome.svg";
import macos from "../../assets/brand/platforms/macos.svg";
import linux from "../../assets/brand/platforms/linux.svg";
import android from "../../assets/brand/platforms/android.svg";
import wordmark from "../../assets/brand/wordmark.svg";
import { version } from "../../../package.json";

const clients = [
  {
    name: "Chrome",
    icon: chrome,
    type: "浏览器扩展",
    title: "在已登录的浏览器里工作",
    summary:
      "将扩展装在你选定的 Chrome 用户配置中。Agent 可以沿用已有的登录状态，在独立标签页里查资料、填表单。",
    requirement: "Chrome 116+",
    link: "/browser-profile-design.html",
    prompt: "打开项目看板，找出本周到期的任务。",
    capabilities: ["观察页面", "导航", "表单操作"],
  },
  {
    name: "macOS",
    icon: macos,
    type: "桌面客户端",
    title: "让 Agent 操作桌面应用",
    summary:
      "在 Mac 上开启所需的系统权限。Agent 可以查看应用窗口、使用键盘和鼠标，也可以通过 Shell 和文件工具处理本机资料。",
    requirement: "Apple Silicon · macOS 14+",
    link: "/deployment.html#macos-app",
    prompt: "打开日历，查看我明天上午的安排。",
    capabilities: ["屏幕与键鼠", "Shell", "文件读写"],
  },
  {
    name: "Linux",
    icon: linux,
    type: "命令行客户端",
    title: "把开发机接入工作流",
    summary:
      "用 Device Token 绑定 Linux 主机，按需启用 Shell 和文件权限。客户端支持通过 systemd 在后台运行。",
    requirement: "Linux amd64 / arm64",
    link: "/deployment.html#linux-cli",
    prompt: "查看这个项目最新一次构建的日志。",
    capabilities: ["Shell", "文件读写"],
  },
  {
    name: "Android",
    icon: android,
    type: "移动客户端预览",
    title: "在 Android 设备上执行任务",
    summary:
      "从源码构建预览客户端和配套 Server。授权后，Agent 可以查看屏幕、点按和滑动，也可以读写你选定的目录。",
    requirement: "Android 13+ · 源码构建",
    link: "https://github.com/xerrors/aBridge/tree/main/apps/android",
    prompt: "打开设置，查看这台手机的系统版本。",
    capabilities: ["屏幕与触控", "文本输入", "授权目录"],
  },
];
const selected = ref(clients[0]);
</script>

<template>
  <main class="brand-page">
    <section class="bridge-hero">
      <div class="hero-copy">
        <a class="release-link" :href="withBase('/changelog.html')"
          ><span>v{{ version }}</span> 版本记录 <ChevronRight :size="14" aria-hidden="true"
        /></a>
        <h1>让 Agent 用上<br />你的设备。</h1>
        <p>
          通过自托管的 MCP 服务，让 Agent 在你的浏览器、电脑或手机上执行任务。你来选择设备、权限和有效期。
        </p>
        <div class="hero-actions">
          <a class="primary-link" :href="withBase('/guide/start.html')">快速开始</a
          ><a class="quiet-link" href="#runtime">了解工作原理</a>
        </div>
      </div>
      <div class="figure-frame"><BridgeFigure /></div>
    </section>
    <section class="device-section" aria-labelledby="client-title">
      <div class="device-heading">
        <h2 id="client-title">接入你的设备</h2>
        <div class="client-switch" role="group" aria-label="选择客户端">
          <button
            v-for="client in clients"
            :key="client.name"
            type="button"
            :aria-pressed="selected.name === client.name"
            @click="selected = client"
          >
            <img :src="client.icon" alt="" />{{ client.name }}
          </button>
        </div>
      </div>
      <div class="device-detail" aria-live="polite">
        <div class="device-copy">
          <small>{{ selected.type }}</small>
          <h3>{{ selected.title }}</h3>
          <p>{{ selected.summary }}</p>
          <a class="quiet-link" :href="withBase(selected.link)">查看接入说明</a>
        </div>
        <div class="example">
          <small>任务示例</small>
          <blockquote>“{{ selected.prompt }}”</blockquote>
          <div class="capabilities">
            <span v-for="cap in selected.capabilities" :key="cap">{{ cap }}</span>
          </div>
          <p>{{ selected.requirement }}</p>
        </div>
      </div>
    </section>
    <RuntimeSection />
    <BenchmarkSection />
    <footer class="brand-footer">
      <img :src="wordmark" alt="aBridge" /><a href="https://github.com/xerrors/aBridge/blob/main/LICENSE"
        >Apache License 2.0</a
      >
    </footer>
  </main>
</template>
