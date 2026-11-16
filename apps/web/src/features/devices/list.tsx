import { platformName, CapabilityIcon, DeviceIcon } from "../../components/icons.js";
import { ActionButton } from "../../components/actions.js";
import { capabilityLabels, stateLabels } from "../../lib/labels.js";
import { Select } from "../../components/forms.js";
import { useState } from "preact/hooks";
import type { Device } from "../../lib/api.js";
import type { Mutate, RunAction } from "../../lib/types.js";
import { ChevronRight, Plus, Search, Square } from "lucide-preact";
function DeviceStatus({ device }: { device: Device }) {
  return (
    <span class="device-state">
      <span class={`dot ${device.paused ? "paused" : device.status}`} />
      {device.paused ? "已暂停" : (stateLabels[device.status] ?? device.status)}
    </span>
  );
}
function DeviceCapabilities({ device }: { device: Device }) {
  return (
    <div class="caps" aria-label="能力状态">
      {device.capabilities.map((cap) => (
        <span
          key={cap}
          class={`cap ${device.status === "online" && !device.paused && device.available?.[cap] ? "ready" : ""}`}
        >
          <CapabilityIcon capability={cap} />
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
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [status, setStatus] = useState("all");
  const visible = devices.filter((device) => device.status !== "revoked");
  const filtered = visible.filter(
    (device) =>
      (kind === "all" || device.kind === kind) &&
      (status === "all" || (device.paused ? "paused" : device.status) === status) &&
      `${device.name} ${platformName(device.platform)} ${device.id}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  );
  const resetFilters = () => {
    setQuery("");
    setKind("all");
    setStatus("all");
  };
  return (
    <>
      <div class="page-title">
        <h1>
          我的设备<span class="count">{visible.length}</span>
        </h1>
        {visible.length > 0 && (
          <button class="primary" onClick={addDevice}>
            <Plus aria-hidden="true" />
            添加设备
          </button>
        )}
      </div>
      {visible.length > 0 && (
        <div class="device-toolbar" role="group" aria-label="筛选设备">
          <label class="device-search">
            <span class="sr-only">搜索设备</span>
            <Search aria-hidden="true" />
            <input
              type="search"
              placeholder="搜索设备…"
              value={query}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          <Select aria-label="设备类型" value={kind} onChange={(event) => setKind(event.currentTarget.value)}>
            <option value="all">全部类型</option>
            <option value="computer">电脑</option>
            <option value="browser">浏览器</option>
          </Select>
          <Select
            aria-label="设备状态"
            value={status}
            onChange={(event) => setStatus(event.currentTarget.value)}
          >
            <option value="all">全部状态</option>
            <option value="online">在线</option>
            <option value="offline">离线</option>
            <option value="paused">已暂停</option>
            <option value="unknown">状态未知</option>
          </Select>
        </div>
      )}
      <section class={filtered.length ? "device-grid" : "surface"} aria-label="设备列表">
        {filtered.length ? (
          filtered.map((device) => (
            <article class="device-card" key={device.id}>
              <div class="device-card-head">
                <DeviceIcon kind={device.kind} platform={device.platform} />
                <DeviceStatus device={device} />
              </div>
              <div class="device-card-identity">
                <a class="device-card-link" href={`#devices/${encodeURIComponent(device.id)}`}>
                  {device.name}
                </a>
                <span class="small muted">
                  {device.platform
                    ? platformName(device.platform)
                    : device.kind === "browser"
                      ? "浏览器"
                      : "电脑"}
                </span>
              </div>
              <div class="device-card-footer">
                <DeviceCapabilities device={device} />
                <ActionButton
                  icon={<Square aria-hidden="true" />}
                  run={run}
                  action={() => mutate(`/api/devices/${device.id}/stop`)}
                  label={`停止 ${device.name} 的操作`}
                  className="text-button"
                  busyLabel="停止中…"
                  successLabel="已停止"
                >
                  停止操作
                </ActionButton>
              </div>
            </article>
          ))
        ) : visible.length ? (
          <div class="empty">
            <p>没有符合条件的设备</p>
            <button onClick={resetFilters}>清除筛选</button>
          </div>
        ) : (
          <div class="empty device-onboarding">
            <div>
              <h2>添加第一台设备</h2>
            </div>
            <div class="setup-options">
              <button onClick={addDevice}>
                <DeviceIcon kind="computer" />
                <span>
                  添加电脑<span class="small muted">macOS 客户端</span>
                </span>
                <ChevronRight aria-hidden="true" />
              </button>
              <button onClick={addBrowser}>
                <DeviceIcon kind="browser" />
                <span>
                  添加浏览器<span class="small muted">Chromium 扩展</span>
                </span>
                <ChevronRight aria-hidden="true" />
              </button>
            </div>
          </div>
        )}
      </section>
    </>
  );
}
