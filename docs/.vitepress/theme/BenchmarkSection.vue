<script setup lang="ts">
import { ArrowUpRight } from "@lucide/vue";
import { withBase } from "vitepress";
import { data as scores } from "./benchmarks.data";
</script>
<template>
  <section id="benchmarks" class="benchmark-section" aria-labelledby="benchmark-title">
    <div class="benchmark-intro">
      <h2 id="benchmark-title">公开任务评测</h2>
      <p class="section-lede">
        让 Agent 在真实 Chrome 扩展和 Android 模拟器上完成任务，记录每一次运行的结果。
      </p>
      <p class="bench-method">
        模型为 gpt-6.1-sol（medium）。各任务集单独计分，成功要求在各自的预算内完成任务并正常退出。
      </p>
    </div>
    <div class="scoreboard">
      <div class="score-key">
        <span>每格代表一次运行</span><span class="legend-pass">成功</span
        ><span class="legend-miss">未通过</span>
      </div>
      <div v-for="suite in scores" :key="suite.title" class="score-row">
        <div class="score-title">
          <a :href="withBase(suite.report)"
            >{{ suite.title }} <ArrowUpRight :size="16" aria-hidden="true"
          /></a>
          <span class="score-number"
            ><strong>{{ suite.passed }}</strong> / {{ suite.outcomes.length }}</span
          >
        </div>
        <p>{{ suite.description }} · {{ suite.tasks }} 类任务 × {{ suite.seeds }} 个种子</p>
        <div class="score-strip" aria-hidden="true">
          <i v-for="(passed, index) in suite.outcomes" :key="index" :class="{ passed }"></i>
        </div>
      </div>
    </div>
  </section>
</template>
