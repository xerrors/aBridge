import { z } from "zod";
import { DESKTOP_CAPABILITIES } from "@abridge/protocol";
import { api } from "./api.js";
import type { Device, Grant } from "./api.js";
import { Field, Form, Modal, Scope } from "./components.js";
import type { Mutate, RunAction } from "./pages.js";

export type ManagementDialog =
  | { kind: "add-device" }
  | { kind: "add-browser" }
  | { kind: "add-grant" }
  | { kind: "secret"; title: string; value: string }
  | { kind: "config"; grant: Grant }
  | { kind: "confirm"; title: string; path: string }
  | { kind: "rotate"; device: Device };
const keyResult = z.object({ key: z.string() });
function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function ManagementModal({
  dialog,
  devices,
  close,
  open,
  refresh,
  mutate,
  run,
  notify,
}: {
  dialog: ManagementDialog;
  devices: Device[];
  close: () => void;
  open: (dialog: ManagementDialog) => void;
  refresh: () => Promise<void>;
  mutate: Mutate;
  run: RunAction;
  notify: (message: string) => void;
}) {
  const secret = async (path: string, body: unknown, title: string) => {
    const result = await api(path, keyResult, body);
    open({ kind: "secret", title, value: result.key });
    await refresh().catch((error) => notify(error instanceof Error ? error.message : "列表刷新失败"));
  };
  switch (dialog.kind) {
    case "add-device":
      return (
        <Modal title="添加电脑" close={close}>
          <Form
            label="创建设备 Key"
            onSubmit={(form) =>
              secret(
                "/api/devices",
                {
                  name: form.get("name"),
                  kind: "computer",
                  capabilities: form.getAll("capabilities"),
                },
                "设备 Key",
              )
            }
          >
            <Field name="name" label="设备名称" />
            <Scope allowed={DESKTOP_CAPABILITIES} />
          </Form>
        </Modal>
      );
    case "add-browser":
      return (
        <Modal title="添加浏览器" close={close}>
          <p>在浏览器中安装 aBridge for Browser，打开扩展设置后连接此 Server。</p>
          <p class="endpoint">{location.origin}</p>
        </Modal>
      );
    case "add-grant": {
      const available = devices.filter((device) => device.status !== "revoked");
      return (
        <Modal title="创建 Agent 授权" close={close}>
          <Form
            label="创建 Agent Key"
            onSubmit={(form) =>
              secret(
                "/api/client-grants",
                {
                  name: form.get("name"),
                  device_ids: form.getAll("devices"),
                  capabilities: form.getAll("capabilities"),
                  expires_at: new Date(`${String(form.get("expiry"))}T23:59:59`).getTime() / 1000,
                },
                "Agent Key",
              )
            }
          >
            <Field name="name" label="授权名称" />
            <div class="scope-label">设备</div>
            <div class="device-checks">
              {available.map((device, index) => (
                <label class="check" key={device.id}>
                  <input type="checkbox" name="devices" value={device.id} defaultChecked={index === 0} />
                  {device.name}
                </label>
              ))}
            </div>
            <Scope selected={available[0]?.capabilities ?? []} />
            <Field
              name="expiry"
              label="到期日期"
              type="date"
              value={localDate(new Date(Date.now() + 30 * 86400000))}
            />
          </Form>
        </Modal>
      );
    }
    case "secret":
      return (
        <Modal title={dialog.title} close={close}>
          <p class="secret-notice">仅此一次显示</p>
          <textarea class="key-area" aria-label="Key" value={dialog.value} readOnly />
          <div class="dialog-actions">
            <button onClick={close}>完成</button>
            <button class="primary" onClick={() => run(() => navigator.clipboard.writeText(dialog.value))}>
              复制
            </button>
          </div>
        </Modal>
      );
    case "config":
      return (
        <Modal title={dialog.grant.name} close={close}>
          <textarea
            class="key-area"
            aria-label="MCP 接入参数"
            readOnly
            value={JSON.stringify(
              {
                url: `${location.origin}/mcp`,
                headers: { Authorization: "Bearer <AGENT_KEY>" },
              },
              null,
              2,
            )}
          />
        </Modal>
      );
    case "confirm":
      return (
        <Modal title={dialog.title} close={close}>
          <div class="dialog-actions">
            <button onClick={close}>取消</button>
            <button
              class="danger"
              onClick={() =>
                run(async () => {
                  await mutate(dialog.path);
                  close();
                })
              }
            >
              确认
            </button>
          </div>
        </Modal>
      );
    case "rotate":
      return (
        <Modal title="轮换设备 Key" close={close}>
          <div class="dialog-actions">
            <button onClick={close}>取消</button>
            <button
              class="danger"
              onClick={() =>
                run(() => secret(`/api/devices/${dialog.device.id}/credentials`, {}, "新设备 Key"))
              }
            >
              确认轮换
            </button>
          </div>
        </Modal>
      );
  }
}
