<script setup lang="ts">
import { Blocks, Cable, Terminal } from "@lucide/vue";
import { withBase } from "vitepress";
import bridge from "../../assets/brand/bridge.svg";
import wordmark from "../../assets/brand/wordmark.svg";
import chrome from "../../assets/brand/platforms/chrome.svg";
import macos from "../../assets/brand/platforms/macos.svg";
import linux from "../../assets/brand/platforms/linux.svg";
import android from "../../assets/brand/platforms/android.svg";

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
    <figure class="topology">
      <div class="connection-map">
        <ul class="endpoints agents" aria-label="Agent 接入示例">
          <li><Terminal aria-hidden="true" />Codex CLI</li>
          <li><Blocks aria-hidden="true" />Yuxi</li>
          <li><Cable aria-hidden="true" />其他 MCP 客户端</li>
        </ul>
        <div class="wires inbound">
          <span>MCP</span>
          <svg viewBox="0 0 160 224" preserveAspectRatio="none" aria-hidden="true">
            <path d="M0 56 H16 C64 56 46 112 95 112 H160 M0 112 H95 M0 168 H16 C64 168 46 112 95 112" />
          </svg>
        </div>
        <div class="server-node">
          <img class="hub-mark" :src="bridge" alt="" /><img class="hub-word" :src="wordmark" alt="aBridge" />
          <span>自托管服务</span>
        </div>
        <div class="wires outbound">
          <span>WebSocket</span>
          <svg viewBox="0 0 160 224" preserveAspectRatio="none" aria-hidden="true">
            <path
              d="M0 112 H45 C91 112 80 28 137 28 H160 M45 112 C91 112 87 84 137 84 H160 M45 112 C91 112 87 140 137 140 H160 M45 112 C91 112 80 196 137 196 H160"
            />
          </svg>
        </div>
        <ul class="endpoints devices" aria-label="设备客户端">
          <li v-for="device in devices" :key="device.name">
            <img :src="device.icon" alt="" /><strong>{{ device.name }}</strong
            ><small>{{ device.capability }}</small>
          </li>
        </ul>
      </div>
      <figcaption>
        <strong>以查看项目看板为例</strong
        ><span
          >Agent 选中获准访问的 Chrome。扩展在专用标签页中打开看板，沿用你的登录状态，再通过 aBridge
          返回结果。</span
        >
      </figcaption>
    </figure>
  </section>
</template>

<style scoped>
.topology {
  margin: 28px 0 0;
  border: 1px solid #d9e4ee;
  border-radius: 12px;
  overflow: hidden;
  background: #f6f9fc;
}
.connection-map {
  display: grid;
  grid-template-columns: max-content minmax(44px, 1fr) 152px minmax(70px, 1.15fr) max-content;
  align-items: center;
  max-width: 1080px;
  margin: auto;
  padding: 34px clamp(20px, 3vw, 44px);
}
.endpoints {
  list-style: none;
  padding: 0;
  margin: 0;
}
.endpoints li {
  display: flex;
  align-items: center;
  height: 56px;
  gap: 10px;
  font-size: 17px;
  font-weight: 580;
}
.agents {
  padding-right: 12px;
}
.agents svg {
  width: 21px;
  height: 21px;
  stroke-width: 1.65;
  color: #46576a;
}
.devices {
  padding-left: 14px;
}
.devices img {
  width: 24px;
  height: 24px;
  object-fit: contain;
}
.devices strong {
  font-weight: 600;
}
.devices small {
  font-size: 13px;
  font-weight: 400;
  color: #516377;
  margin-left: 4px;
}
.server-node {
  display: grid;
  justify-items: center;
  align-content: center;
  height: 152px;
  background: white;
  border: 1px solid #a8c7e9;
  border-radius: 18px;
  box-shadow: 0 3px 0 #dfeaf5;
}
.hub-mark {
  width: 54px;
  margin-bottom: 10px;
}
.hub-word {
  width: 84px;
}
.server-node span {
  color: #52667b;
  font-size: 13px;
  margin-top: 9px;
}
.wires {
  position: relative;
  height: 224px;
  color: #476480;
}
.wires svg {
  width: 100%;
  height: 100%;
  fill: none;
  stroke: #82a8ce;
}
.wires path {
  vector-effect: non-scaling-stroke;
  stroke-width: 1.5;
}
.wires span {
  position: absolute;
  bottom: calc(50% + 7px);
  font:
    13px ui-monospace,
    monospace;
  background: #f6f9fc;
  padding: 0 3px;
}
.inbound span {
  right: 4px;
}
.outbound span {
  left: 4px;
}
figcaption {
  display: flex;
  align-items: baseline;
  gap: 24px;
  border-top: 1px solid #dce5ec;
  background: white;
  padding: 18px clamp(20px, 3vw, 44px);
  font-size: 14px;
  line-height: 1.75;
  color: #4b5b6a;
}
figcaption strong {
  flex-shrink: 0;
  color: #1c3349;
}
@media (max-width: 760px) {
  .connection-map {
    display: flex;
    flex-direction: column;
    padding: 24px 16px;
    gap: 0;
  }
  .endpoints {
    display: flex;
    justify-content: center;
    flex-wrap: wrap;
    gap: 6px 14px;
    padding: 0;
  }
  .endpoints li {
    font-size: 14px;
    height: 30px;
    gap: 5px;
  }
  .devices small {
    display: none;
  }
  .wires {
    height: 42px;
    border-left: 1px solid #82a8ce;
  }
  .wires span {
    left: 8px;
    right: auto;
    bottom: 14px;
  }
  .wires svg {
    display: none;
  }
  .server-node {
    width: 148px;
    height: 135px;
  }
  figcaption {
    display: block;
  }
  figcaption strong {
    display: block;
    margin-bottom: 4px;
  }
}
</style>
