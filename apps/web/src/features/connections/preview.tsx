import { CapabilityIcon } from "../../components/icons.js";
import { useEffect, useState } from "preact/hooks";
import {
  api,
  connectionPreviewSchema,
  type ConnectionPreview as Preview,
  type Grant,
} from "../../lib/api.js";
import { capabilityLabels, stateLabels } from "../../lib/labels.js";
import { DeviceIcon } from "../../components/icons.js";

export function ConnectionPreview({ grant, edit }: { grant: Grant; edit: () => void }) {
  const [revision, setRevision] = useState(0);
  const policyKey = JSON.stringify([grant.policy, grant.expires_at, grant.revoked_at]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true,
      busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const result = await api(`/api/client-grants/${grant.id}/preview`, connectionPreviewSchema);
        if (active) {
          setPreview(result);
          setError("");
        }
      } catch (error) {
        if (active) {
          setPreview(null);
          setError(error instanceof Error ? error.message : "加载失败");
        }
      } finally {
        busy = false;
      }
    };
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [grant.id, policyKey, revision]);
  const allowed = preview?.devices.filter((device) => device.access === "allowed").length ?? 0;
  return (
    <section class="connection-preview" aria-label="设备访问权限">
      <div class="preview-heading">
        <div class="preview-scope">
          <h2>{grant.policy.mode === "all" ? "全部设备" : "指定设备"}</h2>
          {grant.policy.mode === "all" && <span class="small muted">含新设备</span>}
          {preview && (
            <span class="count">
              {allowed} / {preview.devices.length}
            </span>
          )}
        </div>
        {grant.revoked_at === null && <button onClick={edit}>编辑权限</button>}
      </div>
      {error ? (
        <div class="empty">
          <p class="error" role="alert">
            {error}
          </p>
          <button onClick={() => setRevision((value) => value + 1)}>重新加载权限</button>
        </div>
      ) : !preview ? (
        <div class="compact-empty" role="status">
          加载中…
        </div>
      ) : (
        <div class="preview-devices" aria-label="此连接的设备权限">
          {preview.devices.map((device) => (
            <article class="preview-device" key={device.id}>
              <div class="preview-device-head">
                <DeviceIcon kind={device.kind} platform={device.platform} describePlatform />
                <div>
                  <a class="name" href={`#devices/${encodeURIComponent(device.id)}`}>
                    {device.name}
                  </a>
                  <div class="device-meta">
                    <span class={`dot ${device.paused ? "paused" : device.status}`} />
                    {device.paused ? "已暂停" : (stateLabels[device.status] ?? device.status)}
                  </div>
                </div>
              </div>
              {device.access === "allowed" ? (
                <div class="caps" aria-label={`${device.name}授权能力`}>
                  {device.granted_capabilities.map((cap) => (
                    <span
                      key={cap}
                      class={`cap ${preview.connection.status === "active" && device.status === "online" && !device.paused && device.available?.[cap] ? "ready" : ""}`}
                      title={
                        preview.connection.status !== "active"
                          ? "连接未生效"
                          : device.paused
                            ? "本机已暂停"
                            : device.status !== "online"
                              ? "设备离线"
                              : device.available?.[cap]
                                ? "可用"
                                : "本机能力未就绪"
                      }
                    >
                      <CapabilityIcon capability={cap} />
                      {capabilityLabels[cap]}
                    </span>
                  ))}
                </div>
              ) : (
                <span class="muted">—</span>
              )}
              <span class={`access-state ${device.access}`}>
                {device.access === "allowed"
                  ? "已授权"
                  : device.access === "not_granted"
                    ? "未授权"
                    : "能力未开放"}
              </span>
            </article>
          ))}
          {!preview.devices.length && (
            <div class="compact-empty">
              此账户尚未添加设备。<a href="#devices/new">添加设备</a>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
