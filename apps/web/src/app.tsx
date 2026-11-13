import { render } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import { api, objectResultSchema } from "./api.js";
import { Authentication } from "./authentication.js";
import { Brand } from "./components.js";
import { ManagementModal, type ManagementDialog } from "./dialogs.js";
import { ActivityPage, DevicesPage, GrantsPage, type Mutate, type RunAction } from "./pages.js";
import { useAdminSession } from "./session.js";

type Tab = "devices" | "grants" | "activity";
const tabs: readonly [Tab, string][] = [
  ["devices", "设备"],
  ["grants", "Agent 授权"],
  ["activity", "记录"],
];
function App() {
  const [notice, setNotice] = useState("");
  const notify = useCallback((message: string) => setNotice(message), []);
  const { user, phase, data, refresh, authenticate, logout } = useAdminSession(notify);
  const [tab, setTab] = useState<Tab>("devices");
  const [dialog, setDialog] = useState<ManagementDialog | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (phase !== "ready") setDialog(null);
  }, [phase]);
  const close = () => setDialog(null);
  const mutate: Mutate = async (path, body = {}, method = "POST") => {
    await api(path, objectResultSchema, body, method);
    await refresh();
  };
  const run: RunAction = (action) => {
    void action().catch((error) => notify(error instanceof Error ? error.message : "操作失败"));
  };
  const createGrant = () => {
    if (!data.devices.some((device) => device.status !== "revoked")) {
      notify("请先添加设备");
      return;
    }
    setDialog({ kind: "add-grant" });
  };
  if (phase !== "ready" || !user)
    return <Authentication phase={phase} notice={notice} authenticate={authenticate} />;
  return (
    <>
      <header class="topbar">
        <Brand />
        <div class="account">
          <span>{user.username}</span>
          <button class="text-button" onClick={() => run(logout)}>
            退出
          </button>
        </div>
      </header>
      <div class="shell">
        <nav class="tabs" aria-label="主导航">
          {tabs.map(([key, label]) => (
            <button
              class="tab"
              key={key}
              aria-current={tab === key ? "page" : undefined}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </nav>
        <main id="main">
          {tab === "devices" ? (
            <DevicesPage
              devices={data.devices}
              addDevice={() => setDialog({ kind: "add-device" })}
              addBrowser={() => setDialog({ kind: "add-browser" })}
              rotate={(device) => setDialog({ kind: "rotate", device })}
              revoke={(device) =>
                setDialog({ kind: "confirm", title: "解除绑定", path: `/api/devices/${device.id}/revoke` })
              }
              mutate={mutate}
              run={run}
              notify={notify}
            />
          ) : tab === "grants" ? (
            <GrantsPage
              grants={data.grants}
              devices={data.devices}
              create={createGrant}
              configure={(grant) => setDialog({ kind: "config", grant })}
              revoke={(grant) =>
                setDialog({
                  kind: "confirm",
                  title: "撤销授权",
                  path: `/api/client-grants/${grant.id}/revoke`,
                })
              }
            />
          ) : (
            <ActivityPage data={data} refresh={refresh} run={run} />
          )}
        </main>
      </div>
      {dialog && (
        <ManagementModal
          key={dialog.kind}
          dialog={dialog}
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
const root = document.querySelector("#app");
if (!root) throw new Error("Management console root is missing");
render(<App />, root);
