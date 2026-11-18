<script setup lang="ts">
import codex from "../../assets/brand/agents/codex-color.svg";
import claude from "../../assets/brand/agents/claudecode-color.svg";
import cursor from "../../assets/brand/agents/cursor.svg";
import deepseek from "../../assets/brand/agents/deepseek-color.svg";
import workbuddy from "../../assets/brand/agents/workbuddy-color.svg";
import opencode from "../../assets/brand/agents/opencode.svg";
import yuxi from "../../assets/brand/agents/yuxi.svg";
import { withBase } from "vitepress";
import bridge from "../../assets/brand/bridge.svg";
import wordmark from "../../assets/brand/wordmark.svg";
import chrome from "../../assets/brand/platforms/chrome.svg";
import macos from "../../assets/brand/platforms/macos.svg";
import linux from "../../assets/brand/platforms/linux.svg";
import android from "../../assets/brand/platforms/android.svg";

const agents = [
  { name: "WorkBuddy", icon: workbuddy, slot: "top" },
  { name: "Codex CLI", icon: codex, slot: "upper-left" },
  { name: "Cursor", icon: cursor, slot: "upper-right" },
  { name: "Yuxi", icon: yuxi, slot: "center" },
  { name: "DeepSeek Harness", icon: deepseek, slot: "lower-left" },
  { name: "Claude Code", icon: claude, slot: "lower-right" },
  { name: "OpenCode", icon: opencode, slot: "bottom" },
];
const devices = [
  { name: "Chrome", icon: chrome, capability: "浏览器扩展" },
  { name: "macOS", icon: macos, capability: "桌面应用" },
  { name: "Linux", icon: linux, capability: "Shell 与文件" },
  { name: "Android", icon: android, capability: "移动端预览" },
];
</script>

<template>
  <section id="runtime" class="runtime-section" aria-labelledby="runtime-title">
    <div class="section-heading">
      <h2 id="runtime-title">工作原理</h2>
      <a class="quiet-link" :href="withBase('/architecture.html')">阅读架构文档</a>
    </div>
    <p class="section-lede">Agent 通过 MCP 发出请求，aBridge 核对权限，再交给你选定的设备执行。</p>
    <div class="topology" role="group" aria-label="支持 MCP 的 Agent 通过自托管的 aBridge 连接设备客户端">
      <ul class="honeycomb" aria-label="Agent 客户端示例">
        <li v-for="agent in agents" :key="agent.name" :style="{ gridArea: agent.slot }">
          <img :src="agent.icon" alt="" /><strong>{{ agent.name }}</strong>
        </li>
      </ul>
      <div class="bridge-lane">
        <span class="protocol">MCP</span>
        <div class="server-node">
          <img class="hub-mark" :src="bridge" alt="" /><img
            class="hub-name"
            :src="wordmark"
            alt="aBridge"
          /><small>自托管服务</small>
        </div>
        <span class="protocol">WebSocket</span>
      </div>
      <ul class="destinations" aria-label="设备客户端">
        <li v-for="device in devices" :key="device.name">
          <img :src="device.icon" alt="" /><strong>{{ device.name }}</strong
          ><small>{{ device.capability }}</small>
        </li>
      </ul>
    </div>
  </section>
</template>
<style scoped>
.topology {
  isolation: isolate;
  position: relative;
  display: grid;
  grid-template-columns: minmax(220px, 1.12fr) minmax(220px, 1.26fr) minmax(190px, 0.78fr);
  align-items: center;
  gap: clamp(10px, 2vw, 32px);
  padding: 36px clamp(16px, 3vw, 44px);
  margin-top: 26px;
  border-radius: 18px;
  background: #f6f9fd;
  overflow: hidden;
}
.topology::before {
  content: "";
  position: absolute;
  z-index: -1;
  left: 8%;
  right: 25%;
  top: 50%;
  height: 58%;
  transform: translateY(-50%);
  background: linear-gradient(95deg, #edf5ff00 0%, #dfedfd 32%, #d2e5fc 71%, #bcd9f8 100%);
  clip-path: polygon(0 27%, 79% 27%, 79% 0, 100% 50%, 79% 100%, 79% 73%, 0 73%);
}
.honeycomb,
.destinations {
  list-style: none;
  margin: 0;
  padding: 0;
}
.honeycomb {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 88px));
  justify-content: center;
  column-gap: 0;
  row-gap: 4px;
  padding: 0 12px;
  grid-template-rows: repeat(6, 42px);
  grid-template-areas:
    ". top ."
    "upper-left top upper-right"
    "upper-left center upper-right"
    "lower-left center lower-right"
    "lower-left bottom lower-right"
    ". bottom .";
}
.honeycomb li {
  position: relative;
  isolation: isolate;
  display: grid;
  align-content: center;
  justify-items: center;
  gap: 5px;
  height: 100%;
  margin-inline: -10%;
  filter: drop-shadow(0 2px 2px #45618b15);
}
.honeycomb li:before,
.honeycomb li:after {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  clip-path: polygon(23% 0, 77% 0, 100% 50%, 77% 100%, 23% 100%, 0 50%);
  background: #d8e2ee;
}
.honeycomb li:after {
  inset: 1px;
  background: white;
}
.honeycomb img {
  width: 31px;
  height: 31px;
  object-fit: contain;
}
.honeycomb strong {
  max-width: 11ch;
  text-align: center;
  font-size: 12px;
  line-height: 1.15;
  font-weight: 580;
}
.bridge-lane {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: clamp(7px, 1.4vw, 22px);
}
.protocol {
  font:
    12px ui-monospace,
    monospace;
  color: #365c82;
}
.server-node {
  display: grid;
  justify-items: center;
  align-content: center;
  gap: 8px;
  flex: none;
  width: clamp(98px, 9vw, 128px);
  aspect-ratio: 1;
  border-radius: 24%;
  background: #fff;
  box-shadow:
    0 2px 2px #345d8b12,
    0 10px 24px #3f76af20,
    inset 0 0 0 1px #bed2e9;
}
.hub-mark {
  width: 36%;
}
.hub-name {
  width: 59%;
}
.server-node small,
.destinations small {
  font-size: 12px;
  line-height: 1.4;
  color: #556a7e;
}
.destinations {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 25px 12px;
}
.destinations li {
  display: grid;
  justify-items: center;
  align-content: start;
}
.destinations img {
  width: 32px;
  height: 32px;
  object-fit: contain;
  margin-bottom: 7px;
}
.destinations strong {
  font-size: 16px;
  line-height: 1.4;
  font-weight: 600;
}
@media (max-width: 760px) {
  .topology {
    grid-template-columns: 1fr;
    padding: 24px 12px;
    gap: 20px;
  }
  .topology::before {
    inset: 18% 18% 12%;
    width: auto;
    height: auto;
    transform: none;
    clip-path: polygon(30% 0, 70% 0, 70% 72%, 90% 72%, 50% 100%, 10% 72%, 30% 72%);
    background: linear-gradient(#e8f2ff00, #d2e7ff);
  }
  .honeycomb {
    grid-template-columns: repeat(3, minmax(0, 76px));
    grid-template-rows: repeat(6, 32px);
    gap: 3px 0;
    padding: 0;
  }
  .honeycomb li {
    margin-inline: -10%;
    gap: 2px;
  }
  .honeycomb img {
    width: 21px;
    height: 21px;
  }
  .destinations {
    grid-template-columns: repeat(4, 1fr);
    width: 100%;
    gap: 4px;
  }
  .destinations img {
    width: 25px;
    height: 25px;
  }
  .bridge-lane {
    gap: 12px;
  }
}
</style>
