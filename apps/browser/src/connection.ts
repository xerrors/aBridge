import { normalizeDeviceServer, isInsecureDeviceServer } from "@abridge/protocol";
import { element, errorDetails, type BrowserStatus } from "./types.js";
import { isBound, renderDiagnostics, request, watchStatus } from "./browser-ui.js";
import { fallbackProfileName, profileDeviceName, registrationDeviceName } from "./profile-name.js";

const $ = (id: string) => element(id, HTMLElement);
const button = (id: string) => element(id, HTMLButtonElement);
const input = (id: string) => element(id, HTMLInputElement);
const unbindDialog = element("unbind-dialog", HTMLDialogElement);
let state: BrowserStatus | undefined;
let pending = false;
let nameDirty = false;
let serverDirty = false;
let registrationNameDirty = false;
let profileName = fallbackProfileName;
let bindingError = "";
let showWorkerError = true;
let unbindTarget: BrowserStatus | undefined;

function setError(id: string, message = "") {
  $(id).textContent = message;
  $(id).hidden = !message;
}

function bindingTarget() {
  let address: URL;
  try {
    address = new URL(input("server").value.trim());
  } catch {
    throw new Error("请填写完整的 Server 地址。");
  }
  const server = normalizeDeviceServer(address.href, address.origin);
  return { server, httpOrigin: isInsecureDeviceServer(server) ? address.origin : undefined };
}

function needsHttpConfirmation(origin?: string) {
  return !!origin && origin !== state?.http_confirmed_origin;
}

function renderRegistrationName() {
  const label = input("label");
  label.value = registrationDeviceName(label.value, registrationNameDirty, state?.label, profileName);
}

function render() {
  const bound = isBound(state);
  if (state) {
    $("page-title").textContent = bound ? "管理连接" : state.revoked ? "重新绑定浏览器" : "连接浏览器";
  }
  $("register").hidden = !state || bound;
  $("management").hidden = !bound;
  button("retry").disabled = pending;
  button("refresh-details").disabled = pending;
  if (bound) {
    const connected = !!state?.connected;
    $("management-offline").hidden = connected;
    button("unbind").disabled = pending || !connected;
    input("device-label").disabled = pending;
    const name = input("device-label").value.trim();
    button("rename-save").disabled = pending || !connected || !name || name === state?.label;
    return;
  }

  const authorizing = !!state?.authorizing;
  const busy = pending || authorizing;
  const token = input("method-token").checked;
  const submit = button("submit");
  element("binding-methods", HTMLFieldSetElement).disabled = busy;
  $("register").setAttribute("aria-busy", String(busy));
  $("browser-fields").hidden = token;
  $("token-fields").hidden = !token;
  input("device-token").required = token;
  input("label").required = !token;
  for (const id of ["server", "device-token", "label", "allow-http", "show-token"]) input(id).disabled = busy;
  button("profile-account").disabled = busy || registrationNameDirty;
  $("authorization-status").hidden = !authorizing;
  $("authorization-status").textContent =
    state?.binding_method === "token"
      ? "正在向 Server 验证设备凭证。"
      : state?.authorization_expires_at
        ? "请在打开的授权窗口中确认绑定。"
        : "正在向 Server 发起授权。";
  button("cancel-authorization").hidden = !authorizing;
  button("cancel-authorization").disabled = pending;
  setError("binding-error", bindingError || (showWorkerError ? state?.authorization_error : undefined));
  let needsConsent = false;
  try {
    needsConsent = needsHttpConfirmation(bindingTarget().httpOrigin);
  } catch {
    // Report address validation on submission.
  }
  $("http-warning").hidden = !needsConsent;
  submit.disabled = busy || !state || (needsConsent && !input("allow-http").checked);
  submit.textContent = authorizing ? "正在绑定…" : token ? "验证并连接" : "在浏览器授权";
}

async function refresh() {
  try {
    const next = await request({ type: "status" });
    const wasBound = isBound(state);
    const bound = isBound(next);
    if (next.device_id !== state?.device_id || wasBound !== bound) nameDirty = false;
    state = next;
    $("page-retry").hidden = true;
    $("page-status").hidden = true;
    if (bound) {
      input("device-token").value = "";
      $("saved-server").textContent = next.server || "尚未配置";
      if (!nameDirty) input("device-label").value = next.label || "";
      renderDiagnostics($("connection-details"), next);
    } else {
      if (wasBound) {
        serverDirty = false;
        registrationNameDirty = false;
        input("allow-http").checked = false;
        setError("profile-error");
      }
      if (!serverDirty) input("server").value = next.server || "http://127.0.0.1:8765";
      if (next.authorizing)
        input(next.binding_method === "token" ? "method-token" : "method-browser").checked = true;
      renderRegistrationName();
    }
  } catch (error) {
    state = undefined;
    $("page-status").hidden = true;
    $("page-retry").hidden = false;
    setError("page-error", errorDetails(error).message);
  }
  render();
}

async function run(operation: () => Promise<void>, onError: (message: string) => void) {
  if (pending) return;
  pending = true;
  render();
  try {
    await operation();
  } catch (error) {
    onError(errorDetails(error).message);
  } finally {
    pending = false;
    render();
  }
}

function clearBindingError() {
  bindingError = "";
  showWorkerError = false;
}

input("server").oninput = () => {
  serverDirty = true;
  input("allow-http").checked = false;
  clearBindingError();
  render();
};
input("allow-http").onchange = render;
input("label").oninput = () => {
  registrationNameDirty = true;
  setError("profile-error");
  clearBindingError();
  render();
};
$("binding-methods").onchange = () => {
  input("device-token").value = "";
  input("device-token").type = "password";
  input("show-token").checked = false;
  clearBindingError();
  render();
};
input("device-token").oninput = () => {
  clearBindingError();
  render();
};
input("show-token").onchange = () => {
  input("device-token").type = input("show-token").checked ? "text" : "password";
};
button("profile-account").onclick = () => {
  if (!state || state.authorizing || isBound(state) || registrationNameDirty) return;
  setError("profile-error");
  void run(
    async () => {
      const allowed = await chrome.permissions.request({ permissions: ["identity.email"] });
      if (!allowed) throw new Error("未允许读取 Profile 账户，可继续手动命名。");
      profileName = await profileDeviceName(chrome);
      renderRegistrationName();
      if (profileName === fallbackProfileName)
        throw new Error("当前 Profile 未提供账户邮箱，可继续手动命名。");
    },
    (message) => setError("profile-error", message),
  );
};
$("register").onsubmit = (event) => {
  event.preventDefault();
  if (!state || state.authorizing || isBound(state) || pending) return;
  clearBindingError();
  void run(
    async () => {
      const { server, httpOrigin } = bindingTarget();
      if (needsHttpConfirmation(httpOrigin) && !input("allow-http").checked)
        throw new Error("请先确认此 Server 使用未加密的 HTTP 连接。");
      // Keep the site permission request in the click gesture and the form in the tab.
      const allowed = await chrome.permissions.request({ origins: [`${new URL(server).origin}/*`] });
      if (!allowed) throw new Error("Chrome 未授予此站点的访问权限。请重新提交并点击「允许」。");
      if (input("method-token").checked) {
        await request({
          type: "bind_token",
          server,
          device_key: input("device-token").value.trim(),
          http_confirmed_origin: httpOrigin,
        });
      } else {
        await request({
          type: "authorize",
          server,
          label: input("label").value.trim(),
          http_confirmed_origin: httpOrigin,
        });
      }
      showWorkerError = true;
      await refresh();
    },
    (message) => {
      bindingError = message;
    },
  );
};
button("cancel-authorization").onclick = () =>
  void run(
    async () => {
      await request({ type: "authorize_cancel" });
      clearBindingError();
      await refresh();
    },
    (message) => {
      bindingError = message;
    },
  );

input("device-label").oninput = () => {
  nameDirty = true;
  setError("rename-error");
  render();
};
$("rename").onsubmit = (event) => {
  event.preventDefault();
  if (!isBound(state)) return;
  setError("rename-error");
  void run(
    async () => {
      await request({ type: "rename", name: input("device-label").value.trim() });
      nameDirty = false;
      await refresh();
    },
    (message) => setError("rename-error", message),
  );
};
button("unbind").onclick = () => {
  if (!isBound(state) || pending) return;
  setError("unbind-error");
  unbindTarget = state;
  $("unbind-address").textContent = state?.server || "";
  unbindDialog.returnValue = "";
  unbindDialog.showModal();
};
unbindDialog.onclose = () => {
  if (unbindDialog.returnValue !== "unbind") return;
  if (
    !isBound(state) ||
    !unbindTarget ||
    state?.device_id !== unbindTarget.device_id ||
    state?.server !== unbindTarget.server
  )
    return;
  void run(
    async () => {
      await request({ type: "unbind" });
      await refresh();
      input("server").focus();
    },
    (message) => setError("unbind-error", message),
  );
};
button("refresh-details").onclick = () => void refresh();
button("retry").onclick = () => void refresh();
watchStatus(refresh);
void refresh().then(async () => {
  if (!state || isBound(state) || state.label) return;
  profileName = await profileDeviceName(chrome);
  renderRegistrationName();
});
