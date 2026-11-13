import { useState } from "preact/hooks";
import { DESKTOP_CAPABILITIES, type Capability } from "@abridge/protocol";
import type { Device, Grant } from "./api.js";
import type { ManagementData } from "./session.js";
import { capabilityLabels, Field, Form, Scope, stateLabels } from "./components.js";
import { ActivityPage } from "./activity.js";
export { ActivityPage } from "./activity.js";
export type RunAction = (action: () => Promise<void>) => void;
export type Mutate = (path: string, body?: unknown, method?: string) => Promise<void>;
function DeviceStatus({ device }: { device: Device }) {
  return (
    <div class="device-meta">
      <span class={`dot ${device.paused ? "paused" : device.status}`} />
      {device.paused ? "已暂停" : (stateLabels[device.status] ?? device.status)}
      <span>/</span>
      {device.kind === "browser" ? "浏览器" : "电脑"}
      {device.platform && (
        <>
          <span>/</span>
          {device.platform}
        </>
      )}
    </div>
  );
}
function DeviceCapabilities({ device }: { device: Device }) {
  return (
    <div class="caps" aria-label="能力状态">
      {device.capabilities.map((cap) => (
        <span key={cap} class={`cap ${device.available?.[cap] ? "ready" : ""}`}>
          {capabilityLabels[cap]}
        </span>
      ))}
    </div>
  );
}
export function DevicesPage({
  devices,
  addDevice,
  addBrowser,
  mutate,
  run,
}: {
  devices: Device[];
  addDevice: () => void;
  addBrowser: () => void;
  mutate: Mutate;
  run: RunAction;
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
                  <a class="name device-link" href={`#devices/${encodeURIComponent(device.id)}`}>
                    {device.name}
                  </a>
                  <DeviceStatus device={device} />
                </div>
              </div>
              <DeviceCapabilities device={device} />
              <div class="actions">
                <button onClick={() => run(() => mutate(`/api/devices/${device.id}/stop`))}>停止</button>
                <span class="device-chevron" aria-hidden="true">
                  ›
                </span>
              </div>
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
export function DevicePage({
  device,
  data,
  refresh,
  revoke,
  mutate,
  run,
  notify,
}: {
  device: Device | undefined;
  data: ManagementData;
  refresh: () => Promise<void>;
  revoke: (device: Device) => void;
  mutate: Mutate;
  run: RunAction;
  notify: (message: string) => void;
}) {
  const [section, setSection] = useState<"activity" | "settings">("activity");
  return (
    <>
      <a class="device-back" href="#devices">
        ← 我的设备
      </a>
      {!device ? (
        <section class="surface empty">
          <p>设备不存在或已解除绑定</p>
        </section>
      ) : (
        <>
          <div class="page-title device-heading">
            <div>
              <h1>{device.name}</h1>
              <DeviceStatus device={device} />
            </div>
            <button
              onClick={() =>
                run(async () => {
                  await mutate(`/api/devices/${device.id}/stop`);
                  notify("已停止设备操作");
                })
              }
            >
              停止
            </button>
          </div>
          <DeviceCapabilities device={device} />
          <nav class="detail-tabs" aria-label="设备详情">
            <button
              aria-current={section === "activity" ? "page" : undefined}
              onClick={() => setSection("activity")}
            >
              执行记录
            </button>
            <button
              aria-current={section === "settings" ? "page" : undefined}
              onClick={() => setSection("settings")}
            >
              设备设置
            </button>
          </nav>
          {section === "activity" ? (
            <ActivityPage key={device.id} data={data} deviceId={device.id} refresh={refresh} run={run} />
          ) : (
            <section class="surface device-settings" aria-label="设备设置">
              <h2>设备设置</h2>
              <Form
                onSubmit={async (form) => {
                  await mutate(
                    `/api/devices/${device.id}`,
                    { name: form.get("name"), kind: device.kind, capabilities: form.getAll("capabilities") },
                    "PATCH",
                  );
                  notify("已保存");
                }}
              >
                <Field name="name" label="设备名称" value={device.name} />
                <div class="scope-label">允许的能力</div>
                <Scope
                  selected={device.capabilities}
                  allowed={device.kind === "browser" ? ["browser"] : DESKTOP_CAPABILITIES}
                />
              </Form>
              <div class="manage-foot">
                <button class="danger" onClick={() => revoke(device)}>
                  解除绑定
                </button>
              </div>
            </section>
          )}
        </>
      )}
    </>
  );
}
function connectionCapabilities(grant: Grant, device: Device): Capability[] {
  const policy = grant.policy;
  const configured =
    policy.mode === "selected"
      ? (policy.devices.find((entry) => entry.device_id === device.id)?.capabilities ?? [])
      : (policy.overrides.find((entry) => entry.device_id === device.id)?.capabilities ??
        policy.capabilities);
  return device.capabilities.filter((cap) => configured.includes(cap));
}
function connectionExpiry(grant: Grant): string {
  if (grant.revoked_at !== null) return "已撤销";
  if (grant.expires_at === null) return "直到撤销";
  const date = new Date(grant.expires_at * 1000).toLocaleDateString("zh-CN");
  return `${grant.expires_at <= Date.now() / 1000 ? "已到期" : "有效至"} ${date}`;
}
export function GrantsPage({
  grants,
  devices,
  create,
  configure,
  edit,
  preview,
  rotate,
  revoke,
}: {
  grants: Grant[];
  devices: Device[];
  create: () => void;
  configure: (grant: Grant) => void;
  edit: (grant: Grant) => void;
  preview: (grant: Grant) => void;
  rotate: (grant: Grant) => void;
  revoke: (grant: Grant) => void;
}) {
  const active = grants.filter((grant) => grant.revoked_at === null);
  const revoked = grants.filter((grant) => grant.revoked_at !== null);
  const owned = devices.filter((device) => device.status !== "revoked");
  return (
    <>
      <div class="page-title">
        <h1>
          Agent 连接<span class="count">{active.length}</span>
        </h1>
        <button class="primary" onClick={create}>
          创建连接
        </button>
      </div>
      <section class="surface" aria-label="Agent 连接列表">
        {active.length ? (
          active.map((grant) => {
            const permitted = owned.filter((device) => connectionCapabilities(grant, device).length > 0);
            return (
              <article class="agent-row" key={grant.id} data-connection-id={grant.id} aria-label={grant.name}>
                <div>
                  <div class="name">{grant.name}</div>
                  <div class="device-meta">{connectionExpiry(grant)}</div>
                </div>
                <div class="agent-scope">
                  <div class="scope-devices">
                    {grant.policy.mode === "all" ? "全部设备（含新设备）" : "指定设备"}
                  </div>
                  <div class="small muted">
                    {permitted.map((device) => device.name).join("、") || "暂无已授权设备"}
                  </div>
                </div>
                <div class="actions">
                  <button onClick={() => preview(grant)} aria-label={`${grant.name} 设备权限`}>
                    设备权限{" "}
                    <span class="permission-count">
                      {permitted.length} / {owned.length}
                    </span>
                  </button>
                  <button onClick={() => edit(grant)} aria-label={`编辑 ${grant.name}`}>
                    编辑
                  </button>
                  <details class="connection-menu">
                    <summary aria-label={`${grant.name} 更多操作`}>更多</summary>
                    <div>
                      <button onClick={() => configure(grant)}>接入配置</button>
                      <button onClick={() => rotate(grant)}>轮换 Key</button>
                      <button class="danger" onClick={() => revoke(grant)}>
                        撤销连接
                      </button>
                    </div>
                  </details>
                </div>
              </article>
            );
          })
        ) : (
          <div class="empty">
            <p>尚未创建连接</p>
          </div>
        )}
      </section>
      {revoked.length > 0 && (
        <details class="revoked-connections">
          <summary>
            已撤销连接 <span class="count">{revoked.length}</span>
          </summary>
          <div class="surface">
            {revoked.map((grant) => (
              <article class="revoked-row" key={grant.id}>
                <span>{grant.name}</span>
                <span class="small muted">已撤销</span>
              </article>
            ))}
          </div>
        </details>
      )}
    </>
  );
}
