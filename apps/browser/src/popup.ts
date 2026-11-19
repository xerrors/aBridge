import { CONNECTION_PAGE, element, errorDetails, type BrowserStatus } from "./types.js";
import { request, describeState, isBound, watchStatus } from "./browser-ui.js";

const $ = (id: string) => element(id, HTMLElement);
const button = (id: string) => element(id, HTMLButtonElement);
const connectionURL = chrome.runtime.getURL(CONNECTION_PAGE);
let state: BrowserStatus | undefined;
let pending = false;

function render() {
  const bound = isBound(state);
  const active = !!state?.connected && (state.active_sessions > 0 || state.active_operations > 0);
  button("pause").hidden = !bound;
  button("pause").disabled = pending;
  button("pause").textContent = state?.paused ? "恢复访问" : "暂停访问";
  button("stop").disabled = pending;
  button("stop").hidden = !bound || !active;
  button("retry").disabled = pending;
  const open = button("open-connection");
  open.hidden = false;
  open.disabled = pending;
  open.classList.toggle("primary", !!state && !bound);
  open.classList.toggle("secondary", !state || bound);
  open.textContent =
    !state || bound
      ? "管理连接"
      : state.authorizing
        ? "查看绑定进度"
        : state.revoked
          ? "重新绑定"
          : "连接浏览器";
}

function showError(error: unknown) {
  $("error").textContent = errorDetails(error).message;
  $("error").hidden = false;
}

async function refresh() {
  try {
    state = await request({ type: "status" });
    const status = describeState(state);
    $("connection").className = `status-chip ${status.kind}`;
    $("device-name").textContent = state.label || "当前浏览器";
    $("status-label").textContent = state.authorizing
      ? state.binding_method === "token"
        ? "正在验证设备凭证"
        : "正在绑定"
      : status.title;
    $("error").hidden = true;
    $("retry").hidden = true;
  } catch (error) {
    state = undefined;
    $("connection").className = "status-chip attention";
    $("status-label").textContent = "状态读取失败";
    $("retry").hidden = false;
    showError(error);
  }
  render();
}

async function action(run: () => Promise<unknown>) {
  if (pending) return;
  pending = true;
  $("error").hidden = true;
  render();
  try {
    await run();
  } catch (error) {
    showError(error);
  } finally {
    pending = false;
    render();
  }
}

button("pause").onclick = () =>
  void action(async () => {
    await request({ type: state?.paused ? "resume" : "pause" });
    await refresh();
  });
button("stop").onclick = () =>
  void action(async () => {
    await request({ type: "stop" });
    await refresh();
  });
button("retry").onclick = () => void action(refresh);
button("open-connection").onclick = () =>
  void action(async () => {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const existing = tabs.find((tab) => tab.url === connectionURL || tab.pendingUrl === connectionURL);
    if (existing?.id !== undefined) {
      const focused = await chrome.tabs.update(existing.id, { active: true }).catch(() => undefined);
      if (focused) return;
    }
    await chrome.tabs.create({ url: connectionURL });
  });
watchStatus(refresh);
void refresh();
