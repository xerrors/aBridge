import { LayoutDashboard, Monitor, Link2, ListFilter, ShieldCheck } from "lucide-preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import { api, objectResultSchema } from "../lib/api.js";
import { Authentication, ExternalLogin } from "../features/auth/page.js";
import { ActionMenu } from "../components/actions.js";
import { Brand } from "../components/brand.js";
import { Field, Form, Modal } from "../components/forms.js";
import { ManagementModal, type ManagementDialog } from "./dialogs.js";
import { ActivityPage } from "../features/activity/page.js";
import { DevicePage } from "../features/devices/detail.js";
import { DevicesPage } from "../features/devices/list.js";
import { GrantsPage } from "../features/connections/list.js";
import { type Mutate, type RunAction } from "../lib/types.js";
import { useUserSession } from "../features/auth/session.js";
import { DeviceAuthorization } from "../features/devices/authorization.js";
import { InstanceAdminPage } from "../features/admin/page.js";
import { useInstanceAdminSession } from "../features/admin/session.js";
import { confirmCredentialNavigation } from "../lib/credential-guard.js";
import { parseRoute, type Tab } from "./navigation.js";
import { OverviewPage } from "../features/overview/page.js";
import { DeviceSetupPage } from "../features/devices/setup.js";
import { ConnectionCreatePage, ConnectionPage } from "../features/connections/pages.js";

const tabs: readonly [Tab, string][] = [
  ["overview", "概览"],
  ["devices", "设备"],
  ["grants", "Agent 连接"],
  ["activity", "操作记录"],
];
function NavIcon({ name }: { name: Tab }) {
  const icons = {
    overview: LayoutDashboard,
    devices: Monitor,
    grants: Link2,
    activity: ListFilter,
    admin: ShieldCheck,
  };
  const Icon = icons[name];
  return <Icon aria-hidden="true" />;
}
function ManagementApp() {
  const [notice, setNotice] = useState("");
  const notify = useCallback((message: string) => setNotice(message), []);
  const { user, phase, data, identityRevision, refresh, authenticate, logout } = useUserSession(notify);
  const admin = useInstanceAdminSession(notify);
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const navigate = (event: HashChangeEvent) => {
      if (!confirmCredentialNavigation()) {
        history.replaceState(history.state, "", event.oldURL);
        return;
      }
      setDialog(null);
      setHash(location.hash);
    };
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
  const route = parseRoute(hash);
  const tab = route.tab;
  const [loginDialog, setLoginDialog] = useState(false);
  const userReady = phase === "ready" && user !== null;
  const adminReady = admin.phase === "ready";
  const visibleTab =
    adminReady && (!userReady || tab === "admin") ? "admin" : tab === "admin" ? "overview" : tab;
  const [dialog, setDialog] = useState<ManagementDialog | null>(null);
  useEffect(() => {
    setDialog(null);
    setLoginDialog(false);
  }, [identityRevision]);
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
  useEffect(() => {
    document.title = `${tabs.find(([key]) => key === visibleTab)?.[1] ?? "实例管理"} · aBridge`;
    document.querySelector<HTMLElement>("#main")?.focus();
    window.scrollTo(0, 0);
  }, [hash, visibleTab]);
  const close = () => setDialog(null);
  const mutate: Mutate = async (path, body = {}, method = "POST") => {
    await api(path, objectResultSchema, body, method);
    await refresh();
  };
  const run: RunAction = (action) => {
    void action().catch((error) => notify(error instanceof Error ? error.message : "操作失败"));
  };
  const createGrant = () => {
    location.hash = "grants/new";
  };
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
      <div class="console-layout">
        <aside class="sidebar">
          <a class="brand-home" href={userReady ? "#overview" : "#admin"} aria-label="aBridge 管理台首页">
            <Brand />
          </a>
          <nav class="side-nav" aria-label="主导航">
            {(userReady ? tabs : []).map(([key, label]) => (
              <a key={key} aria-current={visibleTab === key ? "page" : undefined} href={`#${key}`}>
                <NavIcon name={key} />
                {label}
              </a>
            ))}
            {adminReady && (
              <a aria-current={visibleTab === "admin" ? "page" : undefined} href="#admin">
                <NavIcon name="admin" />
                实例管理
              </a>
            )}
          </nav>
          <div class="sidebar-bottom">
            <span class="small muted">当前服务</span>
            <span class="server-host" title={location.host}>
              {location.host}
            </span>
          </div>
        </aside>
        <div class="workspace">
          <header class="workspace-header">
            <span>{tabs.find(([key]) => key === visibleTab)?.[1] ?? "实例管理"}</span>
            <div class="account">
              {userReady && <span class="account-name">{user.username}</span>}
              {adminReady && <span class="instance-admin-label">实例管理员</span>}
              <ActionMenu label="账户菜单">
                {userReady ? (
                  <button onClick={() => run(logout)}>退出账户</button>
                ) : (
                  <button onClick={() => setLoginDialog(true)}>登录账户</button>
                )}
                {adminReady && <button onClick={() => run(admin.logout)}>退出管理员</button>}
              </ActionMenu>
            </div>
          </header>
          <main key={identityRevision} id="main" class="workspace-content" tabIndex={-1}>
            {visibleTab === "admin" ? (
              <InstanceAdminPage requireLogin={admin.requireLogin} notify={notify} />
            ) : visibleTab === "overview" ? (
              <OverviewPage data={data} />
            ) : visibleTab === "devices" && route.id === "new" ? (
              <DeviceSetupPage
                key={identityRevision}
                devices={data.devices}
                initialKind={route.section}
                refresh={refresh}
                run={run}
                notify={notify}
              />
            ) : visibleTab === "devices" && route.id ? (
              <DevicePage
                key={route.id}
                section={route.section}
                device={data.devices.find((device) => device.id === route.id && device.status !== "revoked")}
                data={data}
                refresh={refresh}
                revoke={(device) =>
                  setDialog({
                    kind: "confirm",
                    title: "解除绑定",
                    description: `解除「${device.name}」与此账户的绑定，并停止当前会话。再次使用需要在客户端重新授权。`,
                    path: `/api/devices/${device.id}/revoke`,
                  })
                }
                rotateToken={(device) => setDialog({ kind: "rotate-device", device })}
                mutate={mutate}
                run={run}
                notify={notify}
              />
            ) : visibleTab === "devices" ? (
              <DevicesPage
                devices={data.devices}
                addDevice={() => {
                  location.hash = "devices/new";
                }}
                addBrowser={() => {
                  location.hash = "devices/new/browser";
                }}
                mutate={mutate}
                run={run}
              />
            ) : visibleTab === "grants" && route.id === "new" ? (
              <ConnectionCreatePage
                key={identityRevision}
                devices={data.devices}
                refresh={refresh}
                run={run}
                notify={notify}
              />
            ) : visibleTab === "grants" && route.id ? (
              <ConnectionPage
                key={route.id}
                grant={data.grants.find((grant) => grant.id === route.id)}
                section={route.section}
                run={run}
                activity={
                  <ActivityPage key={route.id} data={data} grantId={route.id} refresh={refresh} run={run} />
                }
                edit={(grant) => setDialog({ kind: "edit-grant", grant })}
                rotate={(grant) => setDialog({ kind: "rotate-grant", grant })}
                reconnect={(grant) =>
                  setDialog({
                    kind: "confirm",
                    title: "重新授权",
                    description: `允许「${grant.name}」访问全部设备，包括以后添加的设备。实际可用能力仍由客户端授权决定。`,
                    tone: "primary",
                    path: `/api/client-grants/${grant.id}/reconnect`,
                  })
                }
                revoke={(grant) =>
                  setDialog({
                    kind: "confirm",
                    title: "撤销连接",
                    description: `撤销「${grant.name}」的访问权限，并停止其当前会话。${grant.authentication === "platform" ? "之后可重新授权。" : "此 Agent Key 将立即失效。"}`,
                    path: `/api/client-grants/${grant.id}/revoke`,
                  })
                }
              />
            ) : visibleTab === "grants" ? (
              <GrantsPage grants={data.grants} devices={data.devices} create={createGrant} />
            ) : (
              <ActivityPage data={data} refresh={refresh} run={run} />
            )}
          </main>
        </div>
      </div>
      {loginDialog && adminReady && (
        <Modal title="登录账户" close={() => setLoginDialog(false)}>
          <ExternalLogin />
          <Form
            label="登录"
            onSubmit={async (form) => {
              await authenticate(form);
              setLoginDialog(false);
              location.hash = "overview";
            }}
          >
            <Field name="username" label="账户" />
            <Field name="password" label="密码" type="password" />
          </Form>
        </Modal>
      )}
      {dialog && userReady && visibleTab !== "admin" && (
        <ManagementModal
          key={identityRevision + dialog.kind + ("grant" in dialog ? dialog.grant.id : "")}
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
export function App() {
  const parameters = new URLSearchParams(location.search);
  return parameters.has("authorize") ? (
    <DeviceAuthorization requestId={parameters.get("authorize") ?? ""} />
  ) : (
    <ManagementApp />
  );
}
