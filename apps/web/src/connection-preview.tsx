import { useEffect, useState } from "preact/hooks";
import { api, connectionPreviewSchema, type ConnectionPreview, type Grant } from "./api.js";
import { capabilityLabels, Modal, stateLabels } from "./components.js";

export function ConnectionPreviewDialog({
  grant,
  close,
  edit,
}: {
  grant: Grant;
  close: () => void;
  edit: () => void;
}) {
  const [preview, setPreview] = useState<ConnectionPreview | null>(null);
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
  }, [grant.id]);
  const allowed = preview?.devices.filter((device) => device.access === "allowed").length ?? 0;
  return (
    <Modal title={grant.name} close={close} className="connection-dialog">
      <div class="preview-heading">
        <div>
          <span>{preview ? `已授权 ${allowed} / ${preview.devices.length} 台` : "设备权限"}</span>
          {preview && preview.connection.status !== "active" && (
            <span class="connection-invalid">
              {preview.connection.status === "expired" ? "连接已到期" : "连接已撤销"}
            </span>
          )}
        </div>
        {!grant.revoked_at && <button onClick={edit}>编辑权限</button>}
      </div>
      {error ? (
        <div class="error" role="alert">
          {error}
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
                <div>
                  <div class="name">{device.name}</div>
                  <div class="device-meta">
                    <span class={`dot ${device.paused ? "paused" : device.status}`} />
                    {device.paused ? "已暂停" : (stateLabels[device.status] ?? device.status)}
                    <span>/</span>
                    {device.kind === "browser" ? "浏览器" : "电脑"}
                  </div>
                </div>
                <span class={`access-state ${device.access}`}>
                  {device.access === "allowed"
                    ? "已授权"
                    : device.access === "not_granted"
                      ? "未授权"
                      : "能力未开放"}
                </span>
              </div>
              {device.access === "allowed" && (
                <div class="caps" aria-label={`${device.name}授权能力`}>
                  {device.granted_capabilities.map((cap) => (
                    <span
                      key={cap}
                      class={`cap ${device.available?.[cap] ? "ready" : ""}`}
                      title={
                        device.available?.[cap]
                          ? "可用"
                          : device.paused
                            ? "本机已暂停"
                            : device.status !== "online"
                              ? "设备离线"
                              : preview.connection.status !== "active"
                                ? "连接未生效"
                                : "本机能力未就绪"
                      }
                    >
                      {capabilityLabels[cap]}
                    </span>
                  ))}
                </div>
              )}
            </article>
          ))}
          {!preview.devices.length && <div class="compact-empty">尚未添加设备</div>}
        </div>
      )}
    </Modal>
  );
}
