import { deviceTypeLabel } from "../devices/metadata.js";
import { CapabilityIcon } from "../../components/icons.js";
import { useState } from "preact/hooks";
import {
  CAPABILITIES,
  connectionPolicySchema,
  agentConnectionInputSchema,
  type AgentConnectionInput,
  deviceCapabilities,
  type Capability,
  type ConnectionPolicy,
  type AgentConnectionView,
} from "@abridge/protocol";
import type { Device } from "../../lib/types.js";
import { capabilityLabels, stateLabels } from "../../lib/labels.js";
import { Field, Form, Modal, Select } from "../../components/forms.js";

type DeviceChoices = Record<string, Capability[]>;
function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function connectionExpiry(enabled: boolean, date: string, original?: number | null): number | null {
  if (!enabled) return null;
  if (original != null && date === localDate(new Date(original * 1000))) return original;
  return new Date(`${date}T23:59:59`).getTime() / 1000;
}
function initialChoices(connection?: AgentConnectionView): DeviceChoices {
  if (!connection) return {};
  const entries =
    connection.policy.mode === "selected" ? connection.policy.devices : connection.policy.overrides;
  return Object.fromEntries(entries.map((entry) => [entry.device_id, [...entry.capabilities]]));
}
function CapabilityChecks({
  capabilities,
  allowed,
  label,
  onChange,
}: {
  capabilities: readonly Capability[];
  allowed: readonly Capability[];
  label: string;
  onChange: (capabilities: Capability[]) => void;
}) {
  return (
    <div class="permission-checks" role="group" aria-label={`${label}能力`}>
      {[...allowed, ...capabilities.filter((cap) => !allowed.includes(cap))].map((cap) => (
        <label key={cap}>
          <input
            type="checkbox"
            aria-label={`${label} · ${capabilityLabels[cap]}`}
            checked={capabilities.includes(cap)}
            onChange={(event) =>
              onChange(
                event.currentTarget.checked
                  ? [...capabilities, cap]
                  : capabilities.filter((value) => value !== cap),
              )
            }
          />
          <CapabilityIcon capability={cap} />
          {capabilityLabels[cap]}
          {!allowed.includes(cap) && <span class="small muted">设备未开放</span>}
        </label>
      ))}
    </div>
  );
}

export function ConnectionEditor({
  connection,
  devices,
  close,
  submit,
  inline = false,
}: {
  connection?: AgentConnectionView;
  inline?: boolean;
  devices: Device[];
  close: () => void;
  submit: (input: AgentConnectionInput) => Promise<void>;
}) {
  const [mode, setMode] = useState<ConnectionPolicy["mode"]>(connection?.policy.mode ?? "selected");
  const [selectedChoices, setSelectedChoices] = useState<DeviceChoices>(() =>
    connection?.policy.mode === "selected" ? initialChoices(connection) : {},
  );
  const [overrides, setOverrides] = useState<DeviceChoices>(() =>
    connection?.policy.mode === "all" ? initialChoices(connection) : {},
  );
  const choices = mode === "selected" ? selectedChoices : overrides;
  const setChoices = mode === "selected" ? setSelectedChoices : setOverrides;
  const [defaults, setDefaults] = useState<Capability[]>(() =>
    connection?.policy.mode === "all" ? [...connection.policy.capabilities] : [...CAPABILITIES],
  );
  const [expires, setExpires] = useState(connection?.expires_at != null);
  const [expiry, setExpiry] = useState(() =>
    localDate(
      new Date(connection?.expires_at != null ? connection.expires_at * 1000 : Date.now() + 30 * 86400000),
    ),
  );
  const available = devices.filter((device) => device.status !== "revoked");
  const updateChoice = (id: string, capabilities?: Capability[]) => {
    setChoices((current) => {
      const next = { ...current };
      if (capabilities === undefined) delete next[id];
      else next[id] = capabilities;
      return next;
    });
  };
  const changeMode = (next: ConnectionPolicy["mode"]) => {
    setMode(next);
  };
  const form = (
    <Form
      cancel={close}
      label={connection ? "保存连接" : "创建连接"}
      onSubmit={async (form) => {
        const permitted = new Set(available.map((device) => device.id));
        const entries = Object.entries(choices)
          .filter(([deviceId]) => permitted.has(deviceId))
          .map(([device_id, capabilities]) => ({ device_id, capabilities }));
        if (mode === "selected" && !entries.length && !connection)
          throw new Error("请选择至少一台设备，或选择全部设备范围");
        if (mode === "selected" && entries.some((entry) => entry.capabilities.length === 0))
          throw new Error("请为所选设备选择至少一项能力");
        if (mode === "all" && !defaults.length) throw new Error("请选择至少一项默认能力");
        const policy = connectionPolicySchema.parse(
          mode === "selected"
            ? { mode, devices: entries }
            : { mode, capabilities: defaults, overrides: entries },
        );
        const expiresAt = connectionExpiry(expires, expiry, connection?.expires_at);
        if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now() / 1000))
          throw new Error("请选择将来的到期日期");
        await submit(
          agentConnectionInputSchema.parse({ name: form.get("name"), policy, expires_at: expiresAt }),
        );
      }}
    >
      <section class="editor-section">
        <Field name="name" label="连接名称" value={connection?.name} />
      </section>
      <section class="editor-section">
        <h2>设备权限</h2>
        <div class="scope-options" role="radiogroup" aria-label="设备范围">
          <label class={`scope-option ${mode === "selected" ? "selected" : ""}`}>
            <input
              type="radio"
              name="scope"
              value="selected"
              checked={mode === "selected"}
              onChange={() => changeMode("selected")}
            />
            <span>
              <strong>选择设备</strong>
            </span>
          </label>
          <label class={`scope-option ${mode === "all" ? "selected" : ""}`}>
            <input
              type="radio"
              name="scope"
              value="all"
              checked={mode === "all"}
              onChange={() => changeMode("all")}
            />
            <span>
              <strong>
                全部设备<span class="small muted">含新设备</span>
              </strong>
            </span>
          </label>
        </div>
        {mode === "all" && (
          <div class="default-permissions">
            <div class="scope-label">默认能力</div>
            <CapabilityChecks
              label="默认"
              capabilities={defaults}
              allowed={CAPABILITIES}
              onChange={setDefaults}
            />
          </div>
        )}
        <div class="permission-devices" aria-label="设备权限">
          {available.map((device) => {
            const customized = Object.hasOwn(choices, device.id);
            const allowed = deviceCapabilities(device.kind).filter((cap) =>
              device.capabilities.includes(cap),
            );
            const inherited = defaults.filter((cap) => allowed.includes(cap));
            const selected = choices[device.id] ?? (mode === "all" ? inherited : []);
            return (
              <section class="permission-device" key={device.id} aria-label={device.name}>
                <div class="permission-device-head">
                  <div>
                    <div class="name">{device.name}</div>
                    <div class="device-meta">
                      <span class={`dot ${device.paused ? "paused" : device.status}`} />
                      {device.paused ? "已暂停" : (stateLabels[device.status] ?? device.status)}
                      <span>/</span>
                      {deviceTypeLabel(device)}
                    </div>
                  </div>
                  <label class="inline-check">
                    <input
                      type="checkbox"
                      aria-label={mode === "selected" ? `授权 ${device.name}` : `自定义 ${device.name}`}
                      checked={customized}
                      onChange={(event) =>
                        updateChoice(
                          device.id,
                          event.currentTarget.checked
                            ? mode === "all"
                              ? inherited
                              : [...allowed]
                            : undefined,
                        )
                      }
                    />
                    {mode === "selected" ? "授权" : "自定义"}
                  </label>
                </div>
                {customized ? (
                  <CapabilityChecks
                    label={device.name}
                    allowed={allowed}
                    capabilities={selected}
                    onChange={(caps) => updateChoice(device.id, caps)}
                  />
                ) : mode === "all" ? (
                  <div class="caps inherited-permissions">
                    <span class="small muted">默认</span>
                    {selected.length ? (
                      selected.map((cap) => (
                        <span class="cap" key={cap}>
                          <CapabilityIcon capability={cap} />
                          {capabilityLabels[cap]}
                        </span>
                      ))
                    ) : (
                      <span class="small muted">未授权能力</span>
                    )}
                  </div>
                ) : null}
                {customized && mode === "all" && selected.length === 0 && (
                  <div class="small muted inherited-permissions">此连接不访问该设备</div>
                )}
              </section>
            );
          })}
          {!available.length && (
            <div class="compact-empty">
              尚未添加设备。<a href="#devices/new">添加设备</a>
            </div>
          )}
        </div>
      </section>
      <section class="editor-section">
        <div class="connection-expiry">
          <div class="field">
            <label>
              有效期
              <Select
                value={expires ? "date" : "never"}
                onChange={(event) => setExpires(event.currentTarget.value === "date")}
              >
                <option value="never">直到撤销</option>
                <option value="date">指定日期</option>
              </Select>
            </label>
          </div>
          {expires && (
            <div class="field">
              <label>
                到期日期
                <input
                  name="expiry"
                  type="date"
                  required
                  value={expiry}
                  onInput={(event) => setExpiry(event.currentTarget.value)}
                />
              </label>
            </div>
          )}
        </div>
      </section>
    </Form>
  );
  return inline ? (
    <div class="connection-editor">{form}</div>
  ) : (
    <Modal title={connection ? "编辑连接" : "创建连接"} close={close} className="connection-dialog">
      {form}
    </Modal>
  );
}
