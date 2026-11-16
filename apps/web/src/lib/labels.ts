import type { Capability } from "@abridge/protocol";

export const capabilityLabels: Record<Capability, string> = {
  screen: "屏幕",
  input: "键鼠",
  shell: "Shell",
  files: "文件",
  browser: "浏览器",
};
export const stateLabels: Record<string, string> = {
  online: "在线",
  offline: "离线",
  unknown: "状态未知",
  revoked: "已解绑",
  accepted: "已接受",
  dispatched: "执行中",
  executed: "已执行",
  failed: "失败",
  refused: "已拒绝",
  outcome_unknown: "结果未知",
  cancelled: "已取消",
};
