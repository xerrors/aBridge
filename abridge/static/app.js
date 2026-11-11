(() => {
  "use strict";
  const app = document.querySelector("#app");
  const dialog = document.querySelector("#dialog");
  const labels = {
    screen: "屏幕",
    input: "键鼠",
    shell: "Shell",
    files: "文件",
  };
  const statuses = {
    online: "在线",
    offline: "离线",
    revoked: "已解绑",
    accepted: "已接受",
    dispatched: "执行中",
    executed: "已执行",
    failed: "失败",
    refused: "已拒绝",
    outcome_unknown: "结果未知",
    cancelled: "已取消",
  };
  const icons = {
    bridge:
      '<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><use href="/static/brand.svg#mark"/></svg>',
    monitor:
      '<svg viewBox="0 0 28 28" fill="none" aria-hidden="true"><rect x="3" y="4" width="22" height="15" rx="2.5" stroke="currentColor" stroke-width="1.7"/><path d="M10 24h8m-4-5v5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  };
  let state = {
    user: null,
    devices: [],
    grants: [],
    operations: [],
    tab: "devices",
  };
  let polling = false;
  let noticeTimer;
  let dialogReturnFocus = null;

  async function start() {
    try {
      state.user = await api("/api/me");
      await refresh();
    } catch (error) {
      if (error.status !== 401) toast(error.message);
      renderLogin();
    }
  }

  async function api(path, data, method = data === undefined ? "GET" : "POST") {
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: data === undefined ? {} : { "Content-Type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail =
        result.error?.message ||
        (Array.isArray(result.detail)
          ? result.detail.map((item) => item.msg).join("；")
          : result.detail);
      const error = new Error(detail || `请求失败 (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return result;
  }

  async function refresh() {
    const [devices, grants, activity] = await Promise.all([
      api("/api/devices"),
      api("/api/client-grants"),
      api("/api/activity"),
    ]);
    state.devices = devices.devices;
    state.grants = grants.grants;
    state.operations = activity.operations;
    render();
  }

  function render() {
    const focused = focusSelector(document.activeElement);
    app.innerHTML = `<header class="topbar"><div class="brand">${icons.bridge}<span>aBridge</span></div><div class="account"><span class="account-name">${esc(state.user.username)}</span><button class="text-button" data-action="logout">退出</button></div></header><div class="shell"><nav class="tabs" aria-label="主导航">${[
      ["devices", "设备"],
      ["grants", "Agent 授权"],
      ["activity", "记录"],
    ]
      .map(
        ([tab, label]) =>
          `<button class="tab" data-tab="${tab}" ${state.tab === tab ? 'aria-current="page"' : ""}>${label}</button>`,
      )
      .join(
        "",
      )}</nav><main id="main">${state.tab === "devices" ? devicesPage() : state.tab === "grants" ? grantsPage() : activityPage()}</main></div>`;
    if (focused) app.querySelector(focused)?.focus({ preventScroll: true });
  }

  function devicesPage() {
    const devices = state.devices.filter(
      (device) => device.status !== "revoked",
    );
    return `<div class="page-title"><h1>我的设备<span class="count">${devices.length}</span></h1><button class="primary" data-action="add-device">添加设备</button></div><section class="surface" aria-label="设备列表">${devices.length ? devices.map(deviceRow).join("") : `<div class="empty">${icons.monitor}<p>连接第一台 Mac</p><button data-action="add-device">添加设备</button></div>`}</section>`;
  }

  function deviceRow(device) {
    const status = device.paused ? "已暂停" : statuses[device.status];
    return `<article class="device-row"><div class="device-name"><span class="device-icon">${icons.monitor}</span><div><div class="name">${esc(device.name)}</div><div class="device-meta"><span class="dot ${device.paused ? "paused" : device.status}"></span>${esc(status)}<span aria-hidden="true">/</span>${esc(device.platform)}${device.active_operations.length ? `<span>/ ${device.active_operations.length} 项执行中</span>` : ""}</div></div></div><div class="caps" aria-label="能力状态">${caps(device.capabilities, device.available)}</div><div class="actions"><button data-action="stop-device" data-id="${device.id}" ${device.active_operations.length ? "" : "disabled"}>停止</button></div><details class="device-manage"><summary>管理设备</summary><form class="edit-form" data-form="edit-device" data-id="${device.id}"><div class="edit-row"><div class="field"><label for="name-${device.id}">设备名称</label><input id="name-${device.id}" name="name" value="${esc(device.name)}" maxlength="80" required></div><button type="submit">保存</button></div><div class="scope-label">设备授权</div>${capChecks(device.capabilities)}<div class="error" role="alert"></div></form><div class="manage-foot"><button data-action="rotate-device" data-id="${device.id}">轮换设备 Key</button><button class="danger" data-action="revoke-device" data-id="${device.id}">解除绑定</button></div></details></article>`;
  }

  function grantsPage() {
    const active = state.grants.filter(
      (grant) => !grant.revoked_at && grant.expires_at > Date.now() / 1000,
    );
    return `<div class="page-title"><h1>Agent 授权<span class="count">${active.length}</span></h1><button class="primary" data-action="add-grant">创建授权</button></div><section class="surface" aria-label="Agent 授权列表">${
      state.grants.length
        ? state.grants
            .map((grant) => {
              const isActive =
                !grant.revoked_at && grant.expires_at > Date.now() / 1000;
              const names = grant.device_ids.map(
                (id) =>
                  state.devices.find((device) => device.id === id)?.name ||
                  "已解绑设备",
              );
              return `<article class="agent-row"><div><div class="name">${esc(grant.name)}</div><div class="device-meta"><span class="agent-state ${isActive ? "" : "revoked"}">${grant.revoked_at ? "已撤销" : isActive ? "有效" : "已到期"}</span><span>/</span>${date(grant.expires_at)} 到期</div></div><div class="agent-scope"><div class="small muted scope-devices">${names.map(esc).join("、")}</div><div class="caps">${caps(grant.capabilities)}</div></div><div class="actions"><button data-action="grant-config" data-id="${grant.id}">接入配置</button>${isActive ? `<button class="text-button danger" data-action="revoke-grant" data-id="${grant.id}">撤销</button>` : ""}</div></article>`;
            })
            .join("")
        : '<div class="empty"><p>为 Agent 创建独立授权</p><button data-action="add-grant">创建授权</button></div>'
    }</section>`;
  }

  function activityPage() {
    return `<div class="page-title"><h1>操作记录</h1><button data-action="refresh">刷新</button></div><section class="surface table-wrap" aria-label="操作记录">${state.operations.length ? `<table class="record-list"><thead><tr><th>操作</th><th>设备 / Agent</th><th>结果</th><th>时间</th></tr></thead><tbody>${state.operations.map((operation) => `<tr><td><code>${esc(operation.tool)}</code><div class="small muted">${esc(operation.id.slice(-12))}</div></td><td>${esc(state.devices.find((device) => device.id === operation.device_id)?.name || "已解绑设备")}<div class="small muted">${esc(state.grants.find((grant) => grant.id === operation.grant_id)?.name || "Agent")}</div></td><td class="state ${operation.status}">${esc(statuses[operation.status] || operation.status)}</td><td>${datetime(operation.created_at)}</td></tr>`).join("")}</tbody></table>` : '<div class="empty"><p>暂无操作记录</p></div>'}</section>`;
  }

  function renderLogin() {
    state.user = null;
    app.innerHTML = `<main class="login-wrap" id="main"><div class="login-panel"><div class="brand">${icons.bridge}<span>aBridge</span></div><h1>登录管理台</h1><form data-form="login"><div class="field"><label for="username">账户</label><input id="username" name="username" autocomplete="username" required autofocus maxlength="80"></div><div class="field"><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024"></div><div class="error" role="alert"></div><button class="primary" type="submit">登录</button></form></div></main>`;
  }

  function addDevice() {
    openDialog(
      "添加设备",
      `<form data-form="add-device"><div class="field"><label for="device-name">设备名称</label><input id="device-name" name="name" placeholder="例如：我的 MacBook" required maxlength="80" autofocus></div><div class="scope-label">持续开放的能力</div>${capChecks(["screen", "input"])}<p class="consent">本机可随时暂停。Shell 与文件可访问当前 macOS 用户有权访问的资源。</p><div class="error" role="alert"></div><div class="dialog-actions"><button type="button" data-action="close-dialog">取消</button><button type="submit" class="primary">创建设备 Key</button></div></form>`,
    );
  }

  function addGrant() {
    const devices = state.devices.filter(
      (device) => device.status !== "revoked",
    );
    if (!devices.length) {
      toast("请先添加设备");
      return;
    }
    const expiry = new Date(Date.now() + 30 * 86400000);
    openDialog(
      "创建 Agent 授权",
      `<form data-form="add-grant"><div class="field"><label for="grant-name">授权名称</label><input id="grant-name" name="name" placeholder="例如：我的 OpenCode" required maxlength="80" autofocus></div><div class="scope-label">可访问设备</div><div class="device-checks">${devices.map((device, index) => `<label class="check"><input type="checkbox" name="devices" value="${device.id}" ${index === 0 ? "checked" : ""}>${esc(device.name)}</label>`).join("")}</div><div class="scope-label">允许的能力</div>${capChecks(["screen", "input"])}<div class="field"><label for="expiry">到期日期</label><input id="expiry" name="expiry" type="date" value="${localISO(expiry)}" min="${localISO(new Date())}" required></div><div class="error" role="alert"></div><div class="dialog-actions"><button type="button" data-action="close-dialog">取消</button><button type="submit" class="primary">创建 Agent Key</button></div></form>`,
    );
  }

  function showKey(kind, key) {
    const isDevice = kind === "device";
    openDialog(
      isDevice ? "设备 Key 已创建" : "Agent Key 已创建",
      `<p class="secret-notice">仅此一次显示，请安全保存。</p><textarea class="key-area" aria-label="${isDevice ? "设备 Key" : "Agent Key"}" readonly>${esc(key)}</textarea><p class="endpoint">${isDevice ? "服务地址" : "MCP 地址"}<br><strong>${esc(location.origin)}${isDevice ? "" : "/mcp"}</strong></p>${isDevice ? '<p class="plain-copy">在本机 aBridge 中填写服务地址和设备 Key，确认能力后连接。</p>' : '<p class="plain-copy">请求头：Authorization: Bearer &lt;Agent Key&gt;</p>'}<div class="dialog-actions"><button data-action="close-dialog">完成</button><button class="primary" data-action="copy-key">复制 Key</button></div>`,
    );
  }

  function config(grantId) {
    const grant = state.grants.find((item) => item.id === grantId);
    const configuration = JSON.stringify(
      {
        url: location.origin + "/mcp",
        headers: { Authorization: "Bearer <YOUR_AGENT_KEY>" },
      },
      null,
      2,
    );
    openDialog(
      `${grant.name} · 接入配置`,
      `<textarea class="key-area config-area" aria-label="MCP 接入参数" readonly>${esc(configuration)}</textarea><p class="endpoint">Agent Key 仅在创建时显示；遗失后请撤销并创建新授权。</p><div class="dialog-actions"><button data-action="close-dialog">完成</button><button class="primary" data-action="copy-key">复制参数</button></div>`,
    );
  }

  function confirmAction(title, message, action, id) {
    openDialog(
      title,
      `<p class="plain-copy">${esc(message)}</p><div class="error" role="alert"></div><div class="dialog-actions"><button data-action="close-dialog">取消</button><button class="danger" data-action="${action}" data-id="${id}">确认${title.replace("？", "")}</button></div>`,
    );
  }

  function openDialog(title, content) {
    if (dialog.open) dialog.close();
    else dialogReturnFocus = focusSelector(document.activeElement);
    dialog.innerHTML = `<div class="dialog-head"><h2>${esc(title)}</h2><button class="text-button" data-action="close-dialog" aria-label="关闭">×</button></div>${content}`;
    dialog.showModal();
    dialog.querySelector("[autofocus]")?.focus();
  }

  function closeDialog() {
    dialog.close();
    dialog.innerHTML = "";
    if (dialogReturnFocus)
      app.querySelector(dialogReturnFocus)?.focus({ preventScroll: true });
    dialogReturnFocus = null;
  }

  function focusSelector(element) {
    if (!element || !app.contains(element)) return null;
    if (element.dataset.tab)
      return `[data-tab="${CSS.escape(element.dataset.tab)}"]`;
    if (element.dataset.action) {
      const id = element.dataset.id
        ? `[data-id="${CSS.escape(element.dataset.id)}"]`
        : "";
      return `[data-action="${CSS.escape(element.dataset.action)}"]${id}`;
    }
    return element.id ? `#${CSS.escape(element.id)}` : null;
  }

  function capChecks(selected) {
    return `<div class="checks">${Object.entries(labels)
      .map(
        ([value, label]) =>
          `<label class="check"><input type="checkbox" name="capabilities" value="${value}" ${selected.includes(value) ? "checked" : ""}>${label}</label>`,
      )
      .join("")}</div>`;
  }
  function caps(capabilities, available) {
    return capabilities
      .map(
        (cap) =>
          `<span class="cap ${available?.[cap] ? "ready" : ""}" ${available ? `title="${available[cap] ? "已就绪" : "本机未就绪"}"` : ""}>${labels[cap]}</span>`,
      )
      .join("");
  }
  function esc(value) {
    return String(value ?? "").replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char],
    );
  }
  function localISO(value) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  function date(value) {
    return new Date(value * 1000).toLocaleDateString("zh-CN");
  }
  function datetime(value) {
    return new Date(value * 1000).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }
  function toast(message) {
    const notice = document.querySelector("#notice");
    notice.textContent = message;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      notice.textContent = "";
    }, 5000);
  }

  document.addEventListener("submit", async (event) => {
    const form = event.target.closest("[data-form]");
    if (!form) return;
    event.preventDefault();
    const submit = form.querySelector("[type=submit]");
    const errorBox = form.querySelector(".error");
    if (errorBox) errorBox.textContent = "";
    submit.disabled = true;
    const data = new FormData(form);
    try {
      if (
        ["add-device", "edit-device", "add-grant"].includes(
          form.dataset.form,
        ) &&
        !data.getAll("capabilities").length
      ) {
        throw new Error("至少选择一项能力");
      }
      if (form.dataset.form === "add-grant" && !data.getAll("devices").length) {
        throw new Error("至少选择一台设备");
      }
      switch (form.dataset.form) {
        case "login":
          state.user = await api("/api/login", {
            username: data.get("username"),
            password: data.get("password"),
          });
          await refresh();
          break;
        case "add-device": {
          const result = await api("/api/devices", {
            name: data.get("name"),
            capabilities: data.getAll("capabilities"),
          });
          await refresh();
          showKey("device", result.key);
          break;
        }
        case "edit-device":
          await api(
            `/api/devices/${form.dataset.id}`,
            {
              name: data.get("name"),
              capabilities: data.getAll("capabilities"),
            },
            "PATCH",
          );
          await refresh();
          toast("设备已保存");
          break;
        case "add-grant": {
          const result = await api("/api/client-grants", {
            name: data.get("name"),
            device_ids: data.getAll("devices"),
            capabilities: data.getAll("capabilities"),
            expires_at:
              new Date(data.get("expiry") + "T23:59:59").getTime() / 1000,
          });
          await refresh();
          showKey("agent", result.key);
          break;
        }
      }
    } catch (error) {
      if (errorBox) errorBox.textContent = error.message;
      else toast(error.message);
    } finally {
      submit.disabled = false;
    }
  });

  document.addEventListener("click", async (event) => {
    const tab = event.target.closest("[data-tab]");
    if (tab) {
      state.tab = tab.dataset.tab;
      render();
      return;
    }
    const button = event.target.closest("[data-action]");
    if (!button || button.disabled) return;
    const { action, id } = button.dataset;
    try {
      switch (action) {
        case "add-device":
          addDevice();
          break;
        case "add-grant":
          addGrant();
          break;
        case "close-dialog":
          closeDialog();
          break;
        case "refresh":
          await refresh();
          break;
        case "logout":
          await api("/api/logout", {});
          renderLogin();
          break;
        case "grant-config":
          config(id);
          break;
        case "copy-key": {
          const area = dialog.querySelector("textarea");
          try {
            await navigator.clipboard.writeText(area.value);
            toast("已复制");
          } catch {
            area.focus();
            area.select();
            toast("请复制已选中的内容");
          }
          break;
        }
        case "stop-device":
          await api(`/api/devices/${id}/stop`, {});
          await refresh();
          toast("已请求停止，等待本机回执");
          break;
        case "rotate-device":
          confirmAction(
            "轮换设备 Key？",
            "旧 Key 和当前连接将失效。请使用新 Key 在本机重新连接。",
            "confirm-rotate",
            id,
          );
          break;
        case "revoke-device":
          confirmAction(
            "解除绑定？",
            "设备 Key 将失效，当前执行终止。历史记录保留。",
            "confirm-revoke-device",
            id,
          );
          break;
        case "revoke-grant":
          confirmAction(
            "撤销授权？",
            "此 Agent 的新请求和正在执行的操作将停止。",
            "confirm-revoke-grant",
            id,
          );
          break;
        case "confirm-rotate": {
          button.disabled = true;
          const result = await api(`/api/devices/${id}/credentials`, {});
          await refresh();
          showKey("device", result.key);
          break;
        }
        case "confirm-revoke-device":
          button.disabled = true;
          await api(`/api/devices/${id}/revoke`, {});
          closeDialog();
          await refresh();
          toast("设备已解绑");
          break;
        case "confirm-revoke-grant":
          button.disabled = true;
          await api(`/api/client-grants/${id}/revoke`, {});
          closeDialog();
          await refresh();
          toast("授权已撤销");
          break;
      }
    } catch (error) {
      button.disabled = false;
      const errorBox = dialog.open ? dialog.querySelector(".error") : null;
      if (errorBox) errorBox.textContent = error.message;
      else toast(error.message);
    }
  });

  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDialog();
  });
  setInterval(async () => {
    if (
      !state.user ||
      polling ||
      document.hidden ||
      dialog.open ||
      app.querySelector("details[open]")
    )
      return;
    polling = true;
    try {
      await refresh();
    } catch (error) {
      if (error.status === 401) renderLogin();
    } finally {
      polling = false;
    }
  }, 5000);
  start();
})();
