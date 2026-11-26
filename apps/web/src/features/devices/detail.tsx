import { platformName, CapabilityIcon } from "../../components/icons.js";
import { ActionButton } from "../../components/actions.js";
import { capabilityLabels, deviceScreenStatus, stateLabels } from "../../lib/labels.js";
import { Field, Form, Modal } from "../../components/forms.js";
import { useState } from "preact/hooks";
import type { Device, ManagementData, Mutate, RunAction } from "../../lib/types.js";
import { ArrowLeft, ChevronRight, Square } from "lucide-preact";
import { ActivityPage } from "../activity/page.js";
import { connectionCapabilities } from "../connections/policy.js";
import { browserLabel, deviceTypeLabel, systemLabel } from "./metadata.js";
export function DevicePage({
  device,
  data,
  refresh,
  revoke,
  rotateToken,
  mutate,
  run,
  notify,
  section = "overview",
}: {
  device: Device | undefined;
  data: ManagementData;
  refresh: () => Promise<void>;
  revoke: (device: Device) => void;
  rotateToken: (device: Device) => void;
  mutate: Mutate;
  run: RunAction;
  notify: (message: string) => void;
  section?: string;
}) {
  const [renaming, setRenaming] = useState(false);
  const activeSection = ["activity", "settings"].includes(section) ? section : "overview";
  const details = device?.details;
  const screenStatus = device && deviceScreenStatus(device);
  return (
    <>
      <a class="device-back" href="#devices">
        <ArrowLeft aria-hidden="true" />
        我的设备
      </a>
      {!device ? (
        <section class="surface empty">
          <p>设备不存在或已解除绑定</p>
        </section>
      ) : (
        <>
          <section class="device-overview" aria-label="设备信息">
            <div class="device-heading">
              <div class="device-title">
                <h1>{device.name}</h1>
                <span class="device-state">
                  <span class={`dot ${device.paused ? "paused" : device.status}`} />
                  {device.paused ? "已暂停" : (stateLabels[device.status] ?? device.status)}
                  {screenStatus && <> · {screenStatus}</>}
                </span>
              </div>
              <div class="actions">
                <ActionButton
                  icon={<Square aria-hidden="true" />}
                  run={run}
                  busyLabel="停止中…"
                  successLabel="已停止"
                  action={async () => {
                    await mutate(`/api/devices/${device.id}/stop`);
                    notify("已停止设备操作");
                  }}
                >
                  停止操作
                </ActionButton>
              </div>
            </div>
          </section>
          <nav class="subnav" aria-label="设备详情">
            {(
              [
                ["overview", "概况"],
                ["activity", "操作记录"],
                ["settings", "设置"],
              ] as const
            ).map(([key, label]) => (
              <a
                href={`#devices/${encodeURIComponent(device.id)}/${key}`}
                aria-current={activeSection === key ? "page" : undefined}
              >
                {label}
              </a>
            ))}
          </nav>
          {activeSection === "settings" ? (
            <section class="settings-panel">
              <div class="settings-section">
                <div>
                  <h2>设备名称</h2>
                  <p>{device.name}</p>
                </div>
                <button onClick={() => setRenaming(true)}>编辑名称</button>
              </div>
              <div class="settings-section">
                <div>
                  <h2>重新生成设备凭据</h2>
                  <p>旧凭据立即失效，需要在客户端重新绑定。</p>
                </div>
                <button onClick={() => rotateToken(device)}>重新生成</button>
              </div>
              <div class="settings-section">
                <div>
                  <h2>解除绑定</h2>
                  <p>停止当前会话并移除此设备的访问权限。</p>
                </div>
                <button class="danger" onClick={() => revoke(device)}>
                  解除绑定
                </button>
              </div>
            </section>
          ) : activeSection === "activity" ? (
            <ActivityPage key={device.id} data={data} deviceId={device.id} refresh={refresh} run={run} />
          ) : (
            <>
              {device.status !== "online" || device.paused || screenStatus ? (
                <div class="status-banner" role="status">
                  {device.status === "unknown"
                    ? "无法获取设备状态，请检查服务连接。"
                    : device.paused
                      ? "已暂停，请在客户端恢复。"
                      : device.status !== "online"
                        ? "设备离线，请打开客户端。"
                        : device.interaction_state === "locked"
                          ? "请在设备上解锁，恢复屏幕和键鼠操作。"
                          : "请在设备上亮屏，恢复屏幕和键鼠操作。"}
                </div>
              ) : null}
              <section class="device-summary">
                <div class="device-local-capabilities">
                  <div class="device-capability-heading">
                    <h2>本机能力</h2>
                    <span class="small muted">由客户端管理</span>
                  </div>
                  <ul class="device-capability-list" aria-label="客户端能力状态">
                    {device.capabilities.map((cap) => (
                      <li key={cap}>
                        <span>
                          <CapabilityIcon capability={cap} />
                          {capabilityLabels[cap]}
                        </span>
                        <span
                          class={
                            device.status === "online" && !device.paused && device.available?.[cap]
                              ? "capability-ready"
                              : "muted"
                          }
                        >
                          {device.status === "unknown"
                            ? "状态未知"
                            : device.status !== "online"
                              ? "离线"
                              : device.paused
                                ? "已暂停"
                                : device.available?.[cap]
                                  ? "可用"
                                  : "未就绪"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
                <dl class="device-facts">
                  <div>
                    <dt>设备类型</dt>
                    <dd>{deviceTypeLabel(device)}</dd>
                  </div>
                  {[
                    [
                      "操作系统",
                      systemLabel(device) ??
                        (device.kind === "computer" ? platformName(device.platform) : undefined),
                    ],
                    ["架构", details?.architecture],
                    [
                      "浏览器",
                      device.kind === "browser"
                        ? (browserLabel(device) ?? platformName(device.platform))
                        : undefined,
                    ],
                    [device.kind === "browser" ? "扩展版本" : "客户端版本", device.version],
                    ["主机名", details?.hostname],
                    ["设备型号", details?.model],
                    ["内核版本", details?.kernel_version],
                    ["归属账户", device.owner_name],
                    ["运行用户", details?.runtime_user],
                  ].map(([label, value]) =>
                    value ? (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                      </div>
                    ) : null,
                  )}
                  <div>
                    <dt>设备 ID</dt>
                    <dd>
                      <code>{device.id}</code>
                    </dd>
                  </div>
                </dl>
              </section>
              <section class="device-access">
                <div class="section-heading">
                  <h2>授权的 Agent</h2>
                  <a href="#connections/new">连接 Agent</a>
                </div>
                <div class="access-list">
                  {data.connections
                    .filter(
                      (connection) =>
                        connection.revoked_at === null &&
                        (connection.expires_at === null || connection.expires_at > Date.now() / 1000) &&
                        connectionCapabilities(connection, device).length,
                    )
                    .map((connection) => (
                      <a
                        class="access-row"
                        href={`#connections/${encodeURIComponent(connection.id)}`}
                        key={connection.id}
                      >
                        <span class="name">{connection.name}</span>
                        <div class="caps">
                          {connectionCapabilities(connection, device).map((cap) => (
                            <span class="cap" key={cap}>
                              <CapabilityIcon capability={cap} />
                              {capabilityLabels[cap]}
                            </span>
                          ))}
                        </div>
                        <ChevronRight aria-hidden="true" />
                      </a>
                    ))}
                  {!data.connections.some(
                    (connection) =>
                      connection.revoked_at === null &&
                      (connection.expires_at === null || connection.expires_at > Date.now() / 1000) &&
                      connectionCapabilities(connection, device).length,
                  ) && <div class="compact-empty">暂无授权</div>}
                </div>
              </section>
            </>
          )}
          {renaming && (
            <Modal title="编辑设备名称" close={() => setRenaming(false)}>
              <Form
                cancel={() => setRenaming(false)}
                onSubmit={async (form) => {
                  await mutate(`/api/devices/${device.id}`, { name: form.get("name") }, "PATCH");
                  setRenaming(false);
                  notify("设备名称已更新");
                }}
              >
                <Field name="name" label="设备名称" value={device.name} />
              </Form>
            </Modal>
          )}
        </>
      )}
    </>
  );
}
