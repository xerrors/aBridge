/** Presentation only: Windows shell state never grants or restores device access. */
export type WindowsView = {
  kind: "unknown" | "unbound" | "authorizing" | "offline" | "paused" | "ready" | "active";
  label: string;
  title: string;
  detail: string;
  online: boolean;
  bound: boolean;
  paused: boolean;
  operations: number;
};
export function windowsView(status: Record<string, unknown> | undefined, now = Date.now()): WindowsView {
  const bound = status?.bound === true;
  const paused = status?.paused === true;
  const count = Number(status?.active_operations);
  const operations = Number.isSafeInteger(count) && count > 0 ? count : 0;
  const fresh =
    typeof status?.updated_at === "number" &&
    now / 1000 - status.updated_at < 10 &&
    status.updated_at <= now / 1000 + 5;
  const online = status?.connection === "online" && fresh;
  const base = { bound, paused, online, operations: online ? operations : 0 };
  if (!status || (status.connection === "online" && !fresh))
    return {
      ...base,
      online: false,
      operations: 0,
      kind: "unknown",
      label: "状态待确认",
      title: "正在确认设备状态",
      detail: "暂时无法读取最新状态，请刷新或检查连接。",
    };
  if (status.busy && !bound)
    return {
      ...base,
      kind: "authorizing",
      label: "等待授权",
      title: "在浏览器中完成连接",
      detail: "确认服务器上的授权页面，完成后会自动连接。",
    };
  if (!bound)
    return {
      ...base,
      kind: "unbound",
      label: "尚未连接",
      title: "让智能体连接这台电脑",
      detail: "添加服务器并确认授权，即可使用你开放的本机能力。",
    };
  if (!online)
    return {
      ...base,
      kind: "offline",
      label: paused ? "离线 · 已暂停" : "连接中断",
      title: "正在等待服务器连接",
      detail: paused
        ? "暂停状态已保留；连接恢复后仍需手动恢复操作。"
        : "设备绑定已保留，请检查服务器或本机连接后重连。",
    };
  if (paused)
    return {
      ...base,
      kind: "paused",
      label: "已暂停",
      title: "控制权在你手中",
      detail:
        status.pause_reason === "desktop_input"
          ? "检测到本机操作，已暂停自动控制。准备好后可手动恢复。"
          : "新的远程操作已暂停。准备好后，可随时恢复。",
    };
  if (operations)
    return {
      ...base,
      kind: "active",
      label: "正在执行",
      title: "智能体正在使用这台电脑",
      detail: `${operations} 项操作进行中。你可以随时暂停或停止当前任务。`,
    };
  return {
    ...base,
    kind: "ready",
    label: "在线待命",
    title: "已连接，等待任务",
    detail: "已准备好接收授权智能体的任务，当前没有正在执行的操作。",
  };
}
