import { useState } from "preact/hooks";
import {
  CAPABILITIES,
  connectionPolicySchema,
  deviceCapabilities,
  type Capability,
  type ConnectionPolicy,
} from "@abridge/protocol";
import type { Device, Grant } from "./api.js";
import { capabilityLabels, Field, Form, Modal, stateLabels } from "./components.js";

type DeviceChoices = Record<string, Capability[]>;
export interface ConnectionInput {
  name: FormDataEntryValue | null;
  policy: ConnectionPolicy;
  expires_at: number | null;
}
function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function connectionExpiry(enabled: boolean, date: string, original?: number | null): number | null {
  if (!enabled) return null;
  if (original != null && date === localDate(new Date(original * 1000))) return original;
  return new Date(`${date}T23:59:59`).getTime() / 1000;
}
function initialChoices(grant?: Grant): DeviceChoices {
  if (!grant) return {};
  const entries = grant.policy.mode === "selected" ? grant.policy.devices : grant.policy.overrides;
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
          {capabilityLabels[cap]}
          {!allowed.includes(cap) && <span class="small muted">设备未开放</span>}
        </label>
      ))}
    </div>
  );
}

export function ConnectionEditor({
  grant,
  devices,
  close,
  submit,
}: {
  grant?: Grant;
  devices: Device[];
  close: () => void;
  submit: (input: ConnectionInput) => Promise<void>;
}) {
  const [mode, setMode] = useState<ConnectionPolicy["mode"]>(grant?.policy.mode ?? "selected");
  const [choices, setChoices] = useState<DeviceChoices>(() => initialChoices(grant));
  const [defaults, setDefaults] = useState<Capability[]>(() =>
    grant?.policy.mode === "all" ? [...grant.policy.capabilities] : [...CAPABILITIES],
  );
  const [expires, setExpires] = useState(grant?.expires_at != null);
  const [expiry, setExpiry] = useState(() =>
    localDate(new Date(grant?.expires_at != null ? grant.expires_at * 1000 : Date.now() + 30 * 86400000)),
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
    // A selected-device permission is not an override in the all-device policy.
    setChoices({});
  };
  return (
    <Modal title={grant ? "编辑连接" : "创建连接"} close={close} className="connection-dialog">
      <Form
        label={grant ? "保存连接" : "创建连接"}
        onSubmit={async (form) => {
          const permitted = new Set(available.map((device) => device.id));
          const entries = Object.entries(choices)
            .filter(([deviceId]) => permitted.has(deviceId))
            .map(([device_id, capabilities]) => ({ device_id, capabilities }));
          if (mode === "selected" && entries.some((entry) => entry.capabilities.length === 0))
            throw new Error("请为所选设备选择至少一项能力");
          if (mode === "all" && !defaults.length) throw new Error("请选择至少一项默认能力");
          const policy = connectionPolicySchema.parse(
            mode === "selected"
              ? { mode, devices: entries }
              : { mode, capabilities: defaults, overrides: entries },
          );
          const expiresAt = connectionExpiry(expires, expiry, grant?.expires_at);
          if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now() / 1000))
            throw new Error("请选择将来的到期日期");
          await submit({ name: form.get("name"), policy, expires_at: expiresAt });
        }}
      >
        <Field name="name" label="连接名称" value={grant?.name} />
        <div class="field">
          <label>
            设备范围
            <select
              name="scope"
              value={mode}
              onChange={(event) => changeMode(event.currentTarget.value as ConnectionPolicy["mode"])}
            >
              <option value="selected">指定设备</option>
              <option value="all">全部设备（含新设备）</option>
            </select>
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
                      {device.kind === "browser" ? "浏览器" : "电脑"}
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
          {!available.length && <div class="compact-empty">尚未添加设备</div>}
        </div>
        <div class="connection-expiry">
          <div class="field">
            <label>
              有效期
              <select
                value={expires ? "date" : "never"}
                onChange={(event) => setExpires(event.currentTarget.value === "date")}
              >
                <option value="never">直到撤销</option>
                <option value="date">指定日期</option>
              </select>
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
      </Form>
    </Modal>
  );
}
