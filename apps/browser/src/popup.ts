import { element, errorDetails, type BrowserStatus, type ControlType } from "./types.js";
import { request, describeState, renderDiagnostics } from "./browser-ui.js";
import { fallbackProfileName, profileDeviceName, registrationDeviceName } from "./profile-name.js";
const $ = (id: string) => element(id, HTMLElement);
const button = (id: string) => element(id, HTMLButtonElement);
const input = (id: string) => element(id, HTMLInputElement);

let state: BrowserStatus | undefined;
let settingsOpen = false;
let pending = false;
let nameDirty = false;
let registrationNameDirty = false;
let profileName = fallbackProfileName;
let profilePending = false;
function renderRegistrationName() {
  input("label").value = registrationDeviceName(
    input("label").value,
    registrationNameDirty,
    state?.label,
    profileName,
  );
}
function showError(value: unknown) {
  $("error").textContent = errorDetails(value).message;
  $("error").hidden = false;
}
function report(value: unknown) {
  state = undefined;
  renderControls();
  $("connection").className = "connection-summary attention";
  $("status-label").textContent = "无法读取状态";
  showError(value);
}
function renderControls() {
  const registered = !!state?.configured && !state.revoked;
  button("pause").disabled = pending || !registered;
  button("stop").disabled =
    pending ||
    !registered ||
    !state?.connected ||
    !(state.active_sessions > 0 || state.active_operations > 0);
  button("refresh").disabled = pending;
  button("submit").disabled = pending || !state || !!state.authorizing;
  button("unbind").disabled = pending || !registered;
  button("cancel-authorization").disabled = pending;
  input("device-label").disabled = pending || !registered;
  button("rename-save").disabled =
    pending ||
    !registered ||
    !state?.connected ||
    !input("device-label").value.trim() ||
    input("device-label").value.trim() === state.label;
  input("server").disabled = pending || !state || !!state.authorizing;
  input("label").disabled = pending || !state || !!state.authorizing;
  button("profile-account").disabled =
    pending || profilePending || !state || registered || !!state.authorizing || registrationNameDirty;
}
function renderSettings() {
  const registered = !!state?.configured && !state.revoked;
  const expanded = !!state && (!registered || settingsOpen);
  $("settings-panel").hidden = !expanded;
  button("settings").hidden = !registered;
  button("settings").setAttribute("aria-expanded", String(expanded));
  button("settings").setAttribute("aria-label", expanded ? "收起连接设置" : "展开连接设置");
  $("settings-title").textContent = registered ? "连接设置" : "连接当前浏览器";
  $("registered-info").hidden = !registered;
  $("register").hidden = registered;
}
async function refresh() {
  const next = await request({ type: "status" });
  if (next.device_id !== state?.device_id) nameDirty = false;
  state = next;
  const status = describeState(state);
  $("connection").className = `connection-summary ${status.kind}`;
  $("status-label").textContent = state.authorizing ? "等待浏览器授权" : status.title;
  $("device-name").textContent = state.label || "当前浏览器";
  $("ready-controls").hidden = !state.configured || state.revoked;
  $("pause-label").textContent = state.paused ? "恢复访问" : "暂停访问";
  document
    .getElementById("pause-icon")
    ?.setAttribute("d", state.paused ? "M6 3.5 12 8l-6 4.5Z" : "M6 4v8M10 4v8");
  $("error").textContent = state.authorization_error || "";
  $("error").hidden = !state.authorization_error;
  button("submit").textContent = state.authorizing ? "等待浏览器授权…" : "在浏览器授权";
  button("cancel-authorization").hidden = !state.authorizing;
  $("authorization-status").hidden = !state.authorizing;
  if (!nameDirty) input("device-label").value = state.label || "";
  $("saved-server").textContent = state.server || "尚未配置";
  // Preserve an unfinished form across status notifications; restore a pending flow on reopen.
  if (!input("server").value) input("server").value = state.server || "http://127.0.0.1:8765";
  renderRegistrationName();
  renderSettings();
  renderControls();
  renderDiagnostics($("connection-details"), state);
}
async function control(type: ControlType | "authorize_cancel") {
  if (pending) return;
  pending = true;
  renderControls();
  try {
    await request({ type });
    if (type === "unbind") settingsOpen = false;
    await refresh();
  } catch (error) {
    showError(error);
  } finally {
    pending = false;
    renderControls();
  }
}
button("settings").addEventListener("click", () => {
  settingsOpen = !settingsOpen;
  renderSettings();
});
button("refresh").addEventListener("click", () => {
  void refresh().catch(report);
});
button("pause").addEventListener("click", () => {
  void control(state?.paused ? "resume" : "pause");
});
button("stop").addEventListener("click", () => {
  void control("stop");
});
button("unbind").addEventListener("click", () => {
  void control("unbind");
});
button("cancel-authorization").addEventListener("click", () => {
  void control("authorize_cancel");
});
input("device-label").addEventListener("input", () => {
  nameDirty = true;
  renderControls();
});
input("label").addEventListener("input", () => {
  registrationNameDirty = true;
  renderControls();
});
button("profile-account").addEventListener("click", async () => {
  if (
    pending ||
    profilePending ||
    !state ||
    (state.configured && !state.revoked) ||
    state.authorizing ||
    registrationNameDirty
  )
    return;
  profilePending = true;
  renderControls();
  try {
    // Keep the optional permission request directly in the user gesture.
    const allowed = await chrome.permissions.request({ permissions: ["identity.email"] });
    if (!allowed) throw new Error("未允许读取 Profile 账户，可继续手动命名");
    profileName = await profileDeviceName(chrome);
    renderRegistrationName();
    if (profileName === fallbackProfileName) throw new Error("当前 Profile 未提供账户邮箱，可继续手动命名");
  } catch (error) {
    showError(error);
  } finally {
    profilePending = false;
    renderControls();
  }
});
$("rename").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (pending || !state?.connected) return;
  pending = true;
  renderControls();
  try {
    await request({ type: "rename", name: input("device-label").value.trim() });
    nameDirty = false;
    await refresh();
  } catch (error) {
    showError(error);
  } finally {
    pending = false;
    renderControls();
  }
});
$("register").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (pending || !state || state.authorizing) return;
  pending = true;
  renderControls();
  try {
    const server = input("server").value.trim();
    const url = new URL(server);
    const allowed = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
    if (!allowed) throw new Error("连接所填 Server 需要允许访问这个地址");
    await request({ type: "authorize", server, label: input("label").value.trim() });
    await refresh();
  } catch (error) {
    showError(error);
  } finally {
    pending = false;
    renderControls();
  }
});
chrome.runtime.onMessage.addListener((message: unknown) => {
  if (message && typeof message === "object" && "type" in message && message.type === "status_changed")
    void refresh().catch(report);
});
void refresh()
  .then(async () => {
    if ((state?.configured && !state.revoked) || state?.label) return;
    profileName = await profileDeviceName(chrome);
    renderRegistrationName();
  })
  .catch(report);
