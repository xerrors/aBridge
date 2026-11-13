import { element, errorDetails, type BrowserStatus, type ControlType } from "./types.js";
import { request, describeState, renderDiagnostics } from "./browser-ui.js";
const $ = (id: string) => element(id, HTMLElement);
const button = (id: string) => element(id, HTMLButtonElement);
const input = (id: string) => element(id, HTMLInputElement);
let state: BrowserStatus | undefined;
function report(value: unknown) {
  const error = errorDetails(value);
  state = undefined;
  button("pause").disabled = true;
  button("stop").disabled = true;
  $("connection").className = "connection-card attention";
  $("status-title").textContent = "无法读取状态";
  $("error").textContent = error.message;
  $("error").hidden = false;
}
async function refresh() {
  state = await request({ type: "status" });
  const presentation = describeState(state),
    registered = state.configured && !state.revoked;
  $("connection").className = `connection-card ${presentation.kind}`;
  $("status-title").textContent = presentation.title;
  $("device-name").textContent = state.label || "当前浏览器";
  $("error").hidden = true;
  $("registration-section").hidden = registered;
  $("registered-info").hidden = !registered;
  $("unbind-section").hidden = !registered;
  $("controls").hidden = !registered;
  button("pause").textContent = state.paused ? "恢复访问" : "暂停访问";
  button("pause").disabled = false;
  button("stop").disabled = !state.connected || !(state.active_sessions > 0 || state.active_operations > 0);
  $("saved-label").textContent = state.label || "当前浏览器";
  $("saved-server").textContent = state.server || "尚未配置";
  $("saved-device").textContent = state.device_id || "尚未注册";
  if (state.server && !input("server").value) input("server").value = state.server;
  if (state.label && !input("label").value) input("label").value = state.label;
  renderDiagnostics($("connection-details"), state);
}
$("register").addEventListener("submit", async (event) => {
  event.preventDefault();
  button("submit").disabled = true;
  try {
    const url = new URL(input("server").value.trim());
    const allowed = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
    if (!allowed) throw new Error("连接所填 Server 需要允许访问这个地址");
    await request({
      type: "register",
      server: input("server").value,
      username: input("username").value,
      password: input("password").value,
      label: input("label").value,
    });
    input("password").value = "";
    await refresh();
  } catch (error) {
    report(error);
  } finally {
    button("submit").disabled = false;
  }
});
async function control(type: ControlType, clicked: HTMLButtonElement) {
  clicked.disabled = true;
  try {
    await request({ type });
    await refresh();
  } catch (error) {
    report(error);
  } finally {
    clicked.disabled = false;
    button("pause").disabled = !state;
    button("stop").disabled =
      !state || !state.connected || !(state.active_sessions > 0 || state.active_operations > 0);
  }
}
button("pause").addEventListener("click", () => {
  void control(state?.paused ? "resume" : "pause", button("pause"));
});
button("stop").addEventListener("click", () => {
  void control("stop", button("stop"));
});
$("unbind").addEventListener("click", () => {
  void control("unbind", button("unbind"));
});
$("refresh-status").addEventListener("click", () => {
  void refresh().catch(report);
});
chrome.runtime.onMessage.addListener((message: unknown) => {
  if (message && typeof message === "object" && "type" in message && message.type === "status_changed")
    void refresh().catch(report);
});
void refresh().catch(report);
