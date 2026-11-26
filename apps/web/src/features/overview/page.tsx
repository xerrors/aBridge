import { deviceTypeLabel } from "../devices/metadata.js";
import { ChevronRight, Plus } from "lucide-preact";
import type { ManagementData } from "../../lib/types.js";
import { DeviceIcon } from "../../components/icons.js";
import { stateLabels } from "../../lib/labels.js";
import { connectionCapabilities } from "../connections/policy.js";

export function OverviewPage({ data }: { data: ManagementData }) {
  const devices = data.devices.filter((device) => device.status !== "revoked");
  const connections = data.connections.filter(
    (connection) =>
      connection.revoked_at === null &&
      (connection.expires_at === null || connection.expires_at > Date.now() / 1000),
  );
  const ready = devices.filter(
    (device) =>
      device.status === "online" &&
      !device.paused &&
      device.capabilities.some((cap) => device.available?.[cap]),
  );
  const hasAccess = devices.some((device) =>
    connections.some((connection) => connectionCapabilities(connection, device).length > 0),
  );
  return (
    <>
      <div class="page-title">
        <h1>概览</h1>
        <a class="button primary" href="#devices/new">
          <Plus aria-hidden="true" />
          添加设备
        </a>
      </div>
      <div class="overview-status">
        <span>
          <span class="dot online" />
          {ready.length} 台就绪
        </span>
        <span>{devices.length} 台设备</span>
        <span>{connections.length} 个有效连接</span>
      </div>
      {!hasAccess && (
        <section class="next-action">
          <div>
            <span class="step-number">{devices.length ? "2" : "1"}</span>
            <h2>{devices.length ? "连接你的 Agent" : "添加第一台设备"}</h2>
          </div>
          <a class="button primary" href={devices.length ? "#connections/new" : "#devices/new"}>
            {devices.length ? "创建连接" : "选择设备"}
          </a>
        </section>
      )}
      {devices.length > 0 && (
        <div class="overview-columns">
          <section>
            <div class="section-heading">
              <h2>设备</h2>
              <a href="#devices">查看全部</a>
            </div>
            <div class="overview-device-grid">
              {devices.map((device) => (
                <a class="overview-device" href={`#devices/${encodeURIComponent(device.id)}`} key={device.id}>
                  <DeviceIcon kind={device.kind} platform={device.platform} describePlatform />
                  <div>
                    <span class="name">{device.name}</span>
                    <p class="small muted">
                      {device.active_operations.length
                        ? `${device.active_operations.length} 项进行中`
                        : deviceTypeLabel(device)}
                    </p>
                  </div>
                  <span class="device-state">
                    <span class={`dot ${device.paused ? "paused" : device.status}`} />
                    {device.paused ? "已暂停" : (stateLabels[device.status] ?? device.status)}
                  </span>
                </a>
              ))}
            </div>
          </section>
          <section>
            <div class="section-heading">
              <h2>Agent 连接</h2>
              <a href="#connections/new" aria-label="创建 Agent 连接">
                <Plus aria-hidden="true" />
              </a>
            </div>
            <div class="overview-inventory">
              {connections.length ? (
                connections.map((connection) => (
                  <a
                    class="overview-connection"
                    href={`#connections/${encodeURIComponent(connection.id)}`}
                    key={connection.id}
                  >
                    <span class="name">{connection.name}</span>
                    <span class="small muted">
                      {connection.policy.mode === "all"
                        ? "全部设备"
                        : `${devices.filter((device) => connectionCapabilities(connection, device).length).length} 台设备`}
                    </span>
                    <ChevronRight aria-hidden="true" />
                  </a>
                ))
              ) : (
                <div class="compact-empty">暂无连接</div>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
