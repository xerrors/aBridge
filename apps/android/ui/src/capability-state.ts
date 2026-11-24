export type Capability = "screen" | "input" | "files";

export type Connection =
  "Online" | "Connecting" | "Offline" | "ServiceUnavailable" | "KeyRequired" | "Revoked" | "Unbound";

export const connectionLabel: Record<Connection, string> = {
  Online: "已连接",
  Connecting: "连接中",
  Offline: "设备离线",
  ServiceUnavailable: "无障碍未连接",
  KeyRequired: "服务器未接受免 Key 连接",
  Revoked: "Device Key 无效或已撤销",
  Unbound: "尚未绑定",
};

export type CapabilityState = {
  connection: Connection;
  agentAllowed: boolean;
  interactionState: "ready" | "screen_off" | "locked";
  enabledCapabilities: Capability[];
  grantedCapabilities: Capability[];
  directoryAuthorized: boolean;
};

export function capabilityStatus(state: CapabilityState, key: Capability): string | null {
  if (!state.enabledCapabilities.includes(key)) return "本机未开启";
  if (state.connection !== "Online") return connectionLabel[state.connection];
  if (!state.agentAllowed) return "Agent 访问已关闭";
  if (key === "files" && !state.directoryAuthorized) return "未授权工作目录";
  if (key !== "files" && state.interactionState !== "ready")
    return state.interactionState === "locked" ? "等待解锁" : "等待亮屏";
  return state.grantedCapabilities.includes(key) ? null : "服务器未授权";
}
