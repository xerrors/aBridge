<script setup lang="ts">
import bridge from "../../assets/brand/bridge.svg";
</script>

<template>
  <svg
    class="bridge-figure"
    viewBox="0 0 560 386"
    role="img"
    aria-label="蓝色桥标连接 MCP 和设备客户端的示意图"
  >
    <defs>
      <pattern id="dots" width="13" height="13" patternUnits="userSpaceOnUse">
        <circle cx="1" cy="1" r=".85" fill="#a6bdce" />
      </pattern>
      <mask
        id="bridge-silhouette"
        maskUnits="userSpaceOnUse"
        x="0"
        y="0"
        width="64"
        height="44"
        style="mask-type: alpha"
      >
        <image :href="bridge" width="64" height="44" />
      </mask>
      <g id="bridge-face"><rect width="64" height="44" mask="url(#bridge-silhouette)" /></g>
    </defs>
    <rect width="560" height="386" fill="url(#dots)" />
    <g fill="none" stroke="#8babc9" stroke-width="1.35" stroke-linejoin="round">
      <path d="M0 261h57l126-73m-183 84h61l126-73m-187 84h65l126-73" />
      <path d="m346 166 99-57h115m-208 67 99-57h109m-204 66 99-57h105" />
      <path d="m303 235 88 51h169m-264-44 91 53h173" />
    </g>
    <g fill="#edf4fa" stroke="#8babc9" stroke-width="1.5">
      <circle cx="55" cy="261" r="3.5" />
      <circle cx="449" cy="119" r="3.5" />
      <circle cx="392" cy="286" r="3.5" />
    </g>
    <g transform="translate(99 169)">
      <g transform="translate(0 37) matrix(3.46 -2 3.46 2 0 0)" fill="#91b3d0" opacity=".28">
        <use href="#bridge-face" />
      </g>
      <g
        v-for="depth in 30"
        :key="depth"
        :transform="'translate(0 ' + (30 - depth) + ') matrix(3.46 -2 3.46 2 0 0)'"
      >
        <use href="#bridge-face" fill="#0049ab" />
      </g>
      <g transform="matrix(3.46 -2 3.46 2 0 0)"><use href="#bridge-face" fill="#1676eb" /></g>
    </g>
    <g fill="#496882" font-size="11" font-family="ui-monospace, monospace">
      <text x="23" y="245">MCP</text>
      <text x="459" y="99">WebSocket</text>
    </g>
  </svg>
</template>
