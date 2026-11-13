import { element, errorDetails, type BrowserStatus, type ControlType } from "./types.js";
import { request, describeState, renderDiagnostics } from "./browser-ui.js";
const $ = (id: string) => element(id, HTMLElement);
const button = (id: string) => element(id, HTMLButtonElement);

let state: BrowserStatus | undefined;
function report(value: unknown) {
  const error = errorDetails(value);
  state = undefined;
  button("pause").disabled = true;
  button("stop").disabled = true;
  $("connection").className = "connection-summary attention";
  $("status-label").textContent = "无法读取状态";
  $("error").textContent = error.message;
  $("error").hidden = false;
}
function busy(value: boolean) {
  for (const id of ["pause", "stop", "refresh"]) button(id).disabled = value;
}
async function refresh() {
  state = await request({ type: "status" });
  const status = describeState(state);
  $("connection").className = `connection-summary ${status.kind}`;
  $("status-label").textContent = status.title;
  $("device-name").textContent = state.label || "当前浏览器";
  $("ready-controls").hidden = !state.configured || state.revoked;
  $("setup").hidden = state.configured && !state.revoked;
  button("pause").textContent = state.paused ? "恢复访问" : "暂停访问";
  button("pause").disabled = false;
  button("stop").disabled = !state.connected || !(state.active_sessions > 0 || state.active_operations > 0);
  $("error").hidden = true;
  renderDiagnostics($("connection-details"), state);
}
async function control(type: ControlType) {
  busy(true);
  try {
    await request({ type });
    await refresh();
  } catch (error) {
    report(error);
  } finally {
    busy(false);
    button("pause").disabled = !state;
    button("stop").disabled =
      !state || !state.connected || !(state.active_sessions > 0 || state.active_operations > 0);
  }
}
function openSettings() {
  void chrome.runtime.openOptionsPage();
  window.close();
}
$("settings").addEventListener("click", openSettings);
$("connect").addEventListener("click", openSettings);
button("refresh").addEventListener("click", () => {
  void refresh().catch(report);
});
button("pause").addEventListener("click", () => {
  void control(state?.paused ? "resume" : "pause");
});
button("stop").addEventListener("click", () => {
  void control("stop");
});
chrome.runtime.onMessage.addListener((message: unknown) => {
  if (message && typeof message === "object" && "type" in message && message.type === "status_changed")
    void refresh().catch(report);
});
void refresh().catch(report);
