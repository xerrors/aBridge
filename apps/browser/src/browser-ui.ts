import type { BrowserStatus, UiMessage, UiResponse } from "./types.js";
export function request(message: { type: "status" }): Promise<BrowserStatus>;
export function request(message: UiMessage): Promise<UiResponse>;
export async function request(message: UiMessage): Promise<UiResponse | BrowserStatus> {
  const response = await chrome.runtime.sendMessage<UiMessage, UiResponse | BrowserStatus>(message);
  if (!response?.ok) throw new Error(response?.error?.message || "无法读取连接状态");
  return response;
}

export function describeState(state: BrowserStatus) {
  if (state.revoked) return { kind: "attention", title: "授权已撤销" };
  if (!state.configured) return { kind: "unconfigured", title: "尚未绑定" };
  if (state.paused) return { kind: "paused", title: "访问已暂停" };
  if (!state.connected) return { kind: "offline", title: "正在重新连接" };
  if (state.active_operations > 0) return { kind: "busy", title: "任务正在执行" };
  return { kind: "connected", title: "已连接" };
}

export function formatTime(value: number | undefined) {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? new Date(value).toLocaleString("zh-CN", { hour12: false })
    : "暂无记录";
}

export function renderDiagnostics(container: HTMLElement, state: BrowserStatus) {
  const history = state.connection_history || {};
  const rows = [
    ["Server", state.server || "尚未配置"],
    ["设备 ID", state.device_id || "尚未注册"],
    ["后台启动", formatTime(history.worker_started_at)],
    ["最近建立连接", formatTime(history.last_connected_at)],
    ["最近心跳确认", formatTime(history.last_ack_at)],
    ["最近恢复检查", formatTime(history.last_recovery_at)],
    ["最近断开", formatTime(history.last_disconnected_at)],
    ["关闭码", Number.isInteger(history.last_close_code) ? String(history.last_close_code) : "暂无记录"],
    ["断开原因", history.last_disconnect_reason || "暂无记录"],
    ["检查时间", formatTime(Date.now())],
  ];
  const fragment = document.createDocumentFragment();
  for (const [name, value] of rows) {
    const term = document.createElement("dt"),
      description = document.createElement("dd");
    term.textContent = name;
    description.textContent = value;
    fragment.append(term, description);
  }
  container.replaceChildren(fragment);
}
