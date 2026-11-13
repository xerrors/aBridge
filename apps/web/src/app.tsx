import { render } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import { api, objectResultSchema } from "./api.js";
import { Authentication } from "./authentication.js";
import { Brand, Field, Form, Modal } from "./components.js";
import { ManagementModal, type ManagementDialog } from "./dialogs.js";
import { ActivityPage, DevicePage, DevicesPage, GrantsPage, type Mutate, type RunAction } from "./pages.js";
import { useUserSession } from "./session.js";
import { DeviceAuthorization } from "./device-authorization.js";
import { InstanceAdminPage } from "./instance-admin.js";
import { useInstanceAdminSession } from "./instance-admin-session.js";

type Tab = "devices" | "grants" | "activity" | "admin";
const tabs: readonly [Tab, string][] = [
  ["devices", "设备"],
  ["grants", "Agent 连接"],
  ["activity", "记录"],
];
function ManagementApp() {
  const [notice, setNotice] = useState("");
  const notify = useCallback((message: string) => setNotice(message), []);
  const { user, phase, data, refresh, authenticate, logout } = useUserSession(notify);
  const admin = useInstanceAdminSession(notify);
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const navigate = () => setHash(location.hash);
    const skip = document.querySelector<HTMLAnchorElement>(".skip");
    const focusContent = (event: MouseEvent) => {
      const main = document.querySelector<HTMLElement>("#main");
      if (!main) return;
      event.preventDefault();
      main.focus();
      main.scrollIntoView();
    };
    window.addEventListener("hashchange", navigate);
    skip?.addEventListener("click", focusContent);
    return () => {
      window.removeEventListener("hashchange", navigate);
      skip?.removeEventListener("click", focusContent);
    };
  }, []);
  const route = hash.slice(1).split("/");
  const tab: Tab =
    route[0] === "grants" || route[0] === "activity" || route[0] === "admin" ? route[0] : "devices";
  const deviceId = tab === "devices" ? route[1] : undefined;
  const setTab = (next: Tab) => {
    location.hash = next;
  };
  const [loginDialog, setLoginDialog] = useState(false);
  const userReady = phase === "ready" && user !== null;
  const adminReady = admin.phase === "ready";
  const visibleTab =
    adminReady && (!userReady || tab === "admin") ? "admin" : tab === "admin" ? "devices" : tab;
  const [dialog, setDialog] = useState<ManagementDialog | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!userReady || visibleTab === "admin") setDialog(null);
  }, [userReady, visibleTab]);
  useEffect(() => {
    if (!adminReady) setLoginDialog(false);
  }, [adminReady]);
  const close = () => setDialog(null);
  const mutate: Mutate = async (path, body = {}, method = "POST") => {
    await api(path, objectResultSchema, body, method);
    await refresh();
  };
  const run: RunAction = (action) => {
    void action().catch((error) => notify(error instanceof Error ? error.message : "操作失败"));
  };
  const createGrant = () => setDialog({ kind: "add-grant" });
  if ((!userReady && !adminReady) || admin.phase === "loading")
    return (
      <Authentication
        phase={admin.phase === "loading" ? "loading" : phase}
        notice={notice}
        authenticate={authenticate}
      />
    );
  return (
    <>
      <header class="topbar">
        <Brand />
        <div class="account">
          {userReady ? (
            <div class="account-identity">
              <span class="account-name">{user.username}</span>
              <button class="text-button" onClick={() => run(logout)}>
                退出账户
              </button>
            </div>
          ) : (
            <button class="text-button" onClick={() => setLoginDialog(true)}>
              登录账户
            </button>
          )}
          {adminReady && (
            <div class="account-identity">
              <span class="instance-admin-label">实例管理员</span>
              <button class="text-button" onClick={() => run(admin.logout)}>
                退出管理员
              </button>
            </div>
          )}
        </div>
      </header>
      <div class="shell">
        <nav class="tabs" aria-label="主导航">
          {(userReady ? tabs : []).map(([key, label]) => (
            <button
              class="tab"
              key={key}
              aria-current={visibleTab === key ? "page" : undefined}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
          {adminReady && (
            <button
              class="tab"
              aria-current={visibleTab === "admin" ? "page" : undefined}
              onClick={() => setTab("admin")}
            >
              实例管理
            </button>
          )}
        </nav>
        <main id="main" tabIndex={-1}>
          {visibleTab === "admin" ? (
            <InstanceAdminPage requireLogin={admin.requireLogin} notify={notify} />
          ) : visibleTab === "devices" && deviceId ? (
            <DevicePage
              key={deviceId}
              device={data.devices.find((device) => device.id === deviceId && device.status !== "revoked")}
              data={data}
              refresh={refresh}
              revoke={(device) =>
                setDialog({ kind: "confirm", title: "解除绑定", path: `/api/devices/${device.id}/revoke` })
              }
              mutate={mutate}
              run={run}
              notify={notify}
            />
          ) : visibleTab === "devices" ? (
            <DevicesPage
              devices={data.devices}
              addDevice={() => setDialog({ kind: "add-device" })}
              addBrowser={() => setDialog({ kind: "add-browser" })}
              mutate={mutate}
              run={run}
            />
          ) : visibleTab === "grants" ? (
            <GrantsPage
              grants={data.grants}
              devices={data.devices}
              create={createGrant}
              configure={(grant) => setDialog({ kind: "config", grant })}
              edit={(grant) => setDialog({ kind: "edit-grant", grant })}
              preview={(grant) => setDialog({ kind: "preview-grant", grant })}
              rotate={(grant) => setDialog({ kind: "rotate-grant", grant })}
              reconnect={(grant) =>
                setDialog({
                  kind: "confirm",
                  title: "重新授权（设备权限将清空）",
                  path: `/api/client-grants/${grant.id}/reconnect`,
                })
              }
              revoke={(grant) =>
                setDialog({
                  kind: "confirm",
                  title: "撤销连接",
                  path: `/api/client-grants/${grant.id}/revoke`,
                })
              }
            />
          ) : (
            <ActivityPage data={data} refresh={refresh} run={run} />
          )}
        </main>
      </div>
      {loginDialog && adminReady && (
        <Modal title="登录账户" close={() => setLoginDialog(false)}>
          <Form
            label="登录"
            onSubmit={async (form) => {
              await authenticate(form);
              setLoginDialog(false);
              setTab("devices");
            }}
          >
            <Field name="username" label="账户" />
            <Field name="password" label="密码" type="password" />
          </Form>
        </Modal>
      )}
      {dialog && userReady && visibleTab !== "admin" && (
        <ManagementModal
          key={dialog.kind + ("grant" in dialog ? dialog.grant.id : "")}
          dialog={
            "grant" in dialog
              ? {
                  ...dialog,
                  grant: data.grants.find((grant) => grant.id === dialog.grant.id) ?? dialog.grant,
                }
              : dialog
          }
          devices={data.devices}
          close={close}
          open={setDialog}
          refresh={refresh}
          mutate={mutate}
          run={run}
          notify={notify}
        />
      )}
      {notice && (
        <div id="notice" role="status">
          {notice}
        </div>
      )}
    </>
  );
}
function App() {
  const parameters = new URLSearchParams(location.search);
  return parameters.has("authorize") ? (
    <DeviceAuthorization requestId={parameters.get("authorize") ?? ""} />
  ) : (
    <ManagementApp />
  );
}
const root = document.querySelector("#app");
if (!root) throw new Error("Management console root is missing");
render(<App />, root);
