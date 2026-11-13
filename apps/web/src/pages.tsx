import { DESKTOP_CAPABILITIES } from "@abridge/protocol";
import type { Device, Grant } from "./api.js";
import type { AdminData } from "./session.js";
import { capabilityLabels, Field, Form, Scope, stateLabels } from "./components.js";
export type RunAction = (action: () => Promise<void>) => void;
export type Mutate = (path: string, body?: unknown, method?: string) => Promise<void>;
export function DevicesPage({
  devices,
  addDevice,
  addBrowser,
  rotate,
  revoke,
  mutate,
  run,
  notify,
}: {
  devices: Device[];
  addDevice: () => void;
  addBrowser: () => void;
  rotate: (device: Device) => void;
  revoke: (device: Device) => void;
  mutate: Mutate;
  run: RunAction;
  notify: (message: string) => void;
}) {
  const visible = devices.filter((device) => device.status !== "revoked");
  return (
    <>
      <div class="page-title">
        <h1>
          我的设备<span class="count">{visible.length}</span>
        </h1>
        <div>
          <button onClick={addBrowser}>添加浏览器</button>{" "}
          <button class="primary" onClick={addDevice}>
            添加电脑
          </button>
        </div>
      </div>
      <section class="surface" aria-label="设备列表">
        {visible.length ? (
          visible.map((device) => (
            <article class="device-row" key={device.id}>
              <div class="device-name">
                <div>
                  <div class="name">{device.name}</div>
                  <div class="device-meta">
                    <span class={`dot ${device.paused ? "paused" : device.status}`} />
                    {device.paused ? "已暂停" : (stateLabels[device.status] ?? device.status)}
                    <span>/</span>
                    {device.kind === "browser" ? "浏览器" : "电脑"}
                    <span>/</span>
                    {device.platform}
                  </div>
                </div>
              </div>
              <div class="caps" aria-label="能力状态">
                {device.capabilities.map((cap) => (
                  <span key={cap} class={`cap ${device.available?.[cap] ? "ready" : ""}`}>
                    {capabilityLabels[cap]}
                  </span>
                ))}
              </div>
              <div class="actions">
                <button onClick={() => run(() => mutate(`/api/devices/${device.id}/stop`))}>停止</button>
              </div>
              <details class="device-manage">
                <summary>管理设备</summary>
                <Form
                  onSubmit={async (form) => {
                    await mutate(
                      `/api/devices/${device.id}`,
                      {
                        name: form.get("name"),
                        kind: device.kind,
                        capabilities: form.getAll("capabilities"),
                      },
                      "PATCH",
                    );
                    notify("已保存");
                  }}
                >
                  <Field name="name" label="设备名称" value={device.name} />
                  <Scope
                    selected={device.capabilities}
                    allowed={device.kind === "browser" ? ["browser"] : DESKTOP_CAPABILITIES}
                  />
                </Form>
                <div class="manage-foot">
                  <button onClick={() => rotate(device)}>轮换 Key</button>
                  <button class="danger" onClick={() => revoke(device)}>
                    解除绑定
                  </button>
                </div>
              </details>
            </article>
          ))
        ) : (
          <div class="empty">
            <p>尚未添加设备</p>
          </div>
        )}
      </section>
    </>
  );
}
export function GrantsPage({
  grants,
  devices,
  create,
  configure,
  revoke,
}: {
  grants: Grant[];
  devices: Device[];
  create: () => void;
  configure: (grant: Grant) => void;
  revoke: (grant: Grant) => void;
}) {
  return (
    <>
      <div class="page-title">
        <h1>Agent 授权</h1>
        <button class="primary" onClick={create}>
          创建授权
        </button>
      </div>
      <section class="surface" aria-label="Agent 授权列表">
        {grants.length ? (
          grants.map((grant) => (
            <article class="agent-row" key={grant.id}>
              <div>
                <div class="name">{grant.name}</div>
                <div class="device-meta">
                  {grant.revoked_at ? "已撤销" : grant.expires_at < Date.now() / 1000 ? "已到期" : "有效"} /{" "}
                  {new Date(grant.expires_at * 1000).toLocaleDateString("zh-CN")}
                </div>
              </div>
              <div class="agent-scope">
                <div class="small muted">
                  {grant.device_ids
                    .map((id) => devices.find((device) => device.id === id)?.name ?? "已解绑设备")
                    .join("、")}
                </div>
                <div class="caps">
                  {grant.capabilities.map((cap) => (
                    <span class="cap" key={cap}>
                      {capabilityLabels[cap]}
                    </span>
                  ))}
                </div>
              </div>
              <div class="actions">
                <button onClick={() => configure(grant)}>接入配置</button>
                {!grant.revoked_at && grant.expires_at > Date.now() / 1000 && (
                  <button class="danger text-button" onClick={() => revoke(grant)}>
                    撤销
                  </button>
                )}
              </div>
            </article>
          ))
        ) : (
          <div class="empty">
            <p>暂无 Agent 授权</p>
          </div>
        )}
      </section>
    </>
  );
}
export function ActivityPage({
  data,
  refresh,
  run,
}: {
  data: AdminData;
  refresh: () => Promise<void>;
  run: RunAction;
}) {
  return (
    <>
      <div class="page-title">
        <h1>操作记录</h1>
        <button onClick={() => run(refresh)}>刷新</button>
      </div>
      <section class="surface table-wrap" aria-label="操作记录">
        {data.operations.length ? (
          <table class="record-list">
            <thead>
              <tr>
                <th>操作</th>
                <th>设备 / Agent</th>
                <th>结果</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              {data.operations.map((operation) => (
                <tr key={operation.id}>
                  <td>
                    <code>{operation.tool}</code>
                  </td>
                  <td>
                    {data.devices.find((device) => device.id === operation.device_id)?.name ?? "已解绑设备"}
                    <div class="small muted">
                      {data.grants.find((grant) => grant.id === operation.grant_id)?.name ?? "Agent"}
                    </div>
                  </td>
                  <td>{stateLabels[operation.status] ?? operation.status}</td>
                  <td>{new Date(operation.created_at * 1000).toLocaleString("zh-CN")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div class="empty">
            <p>暂无操作记录</p>
          </div>
        )}
      </section>
    </>
  );
}
