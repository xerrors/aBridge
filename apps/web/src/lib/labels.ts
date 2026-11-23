import type { Capability } from "@abridge/protocol";
import type { Device } from "./types.js";

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

export function deviceScreenStatus(device: Device): string | undefined {
  if (device.status !== "online" || device.paused) return;
  if (device.interaction_state === "locked") return "已锁屏";
  if (device.interaction_state === "screen_off") return "已熄屏";
}
