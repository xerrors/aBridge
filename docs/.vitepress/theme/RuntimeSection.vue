<script setup lang="ts">
import { Terminal, Server, MonitorSmartphone, ChevronRight } from "@lucide/vue";
import { withBase } from "vitepress";
</script>

<template>
  <section id="runtime" class="runtime-section" aria-labelledby="runtime-title">
    <div class="section-heading">
      <h2 id="runtime-title">一次任务如何执行</h2>
      <a class="quiet-link" :href="withBase('/architecture.html')">阅读架构文档</a>
    </div>
    <p class="section-lede">比如让 Agent 查看项目看板，这次请求会经过三个地方。</p>
    <ol class="runtime-path">
      <li>
        <div class="path-head">
          <span class="node-icon"><Terminal /></span
          ><span class="path-wire">MCP<ChevronRight :size="14" aria-hidden="true" /></span>
        </div>
        <h3>Agent 发起请求</h3>
        <p>Agent 列出你授权的设备，选中浏览器，为这次任务开启会话。</p>
      </li>
      <li>
        <div class="path-head">
          <span class="node-icon server-icon"><Server /></span
          ><span class="path-wire">WebSocket<ChevronRight :size="14" aria-hidden="true" /></span>
        </div>
        <h3>aBridge 核对权限</h3>
        <p>客户端主动连到你的服务。每次派发操作前，服务都会核对目标设备、所需能力和授权有效期。</p>
      </li>
      <li>
        <div class="path-head">
          <span class="node-icon"><MonitorSmartphone /></span>
        </div>
        <h3>客户端在设备上执行</h3>
        <p>扩展在专用标签页打开看板，沿用所选浏览器配置的登录状态，将结果经由服务返回 Agent。</p>
      </li>
    </ol>
  </section>
</template>
