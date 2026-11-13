import { z } from "zod";
import { api } from "./api.js";
import type { Device, Grant } from "./api.js";
import { Form, Modal } from "./components.js";
import type { Mutate, RunAction } from "./pages.js";
import { ConnectionEditor } from "./connection-editor.js";
import { ConnectionPreviewDialog } from "./connection-preview.js";

export type ManagementDialog =
  | { kind: "add-device" }
  | { kind: "add-browser" }
  | { kind: "add-grant" }
  | { kind: "edit-grant"; grant: Grant }
  | { kind: "preview-grant"; grant: Grant }
  | { kind: "rotate-grant"; grant: Grant }
  | { kind: "secret"; title: string; value: string }
  | { kind: "config"; grant: Grant }
  | { kind: "confirm"; title: string; path: string };
const keyResult = z.object({ key: z.string() });
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
    case "add-browser": {
      const computer = dialog.kind === "add-device";
      return (
        <Modal title={computer ? "添加电脑" : "添加浏览器"} close={close}>
          <ol class="device-setup-steps">
            <li>
              {computer
                ? "安装并打开 aBridge Mac App，进入设置。"
                : "在要连接的浏览器中安装 aBridge for Browser，打开扩展设置。"}
            </li>
            <li>
              {computer ? "填写此服务地址：" : "填写此服务地址和浏览器名称："}
              <p class="endpoint">{location.origin}</p>
            </li>
            <li>点击“在浏览器授权”，登录后确认绑定。</li>
          </ol>
          <div class="dialog-actions">
            <button onClick={close}>完成</button>
            <button class="primary" onClick={() => run(() => navigator.clipboard.writeText(location.origin))}>
              复制服务地址
            </button>
          </div>
        </Modal>
      );
    }
    case "add-grant":
      return (
        <ConnectionEditor
          devices={devices}
          close={close}
          submit={(input) => secret("/api/client-grants", input, "Agent Key")}
        />
      );
    case "edit-grant":
      return (
        <ConnectionEditor
          grant={dialog.grant}
          devices={devices}
          close={close}
          submit={async (input) => {
            await mutate(`/api/client-grants/${dialog.grant.id}`, input, "PATCH");
            notify("连接已保存");
            close();
          }}
        />
      );
    case "preview-grant":
      return (
        <ConnectionPreviewDialog
          grant={dialog.grant}
          close={close}
          edit={() => open({ kind: "edit-grant", grant: dialog.grant })}
        />
      );
    case "rotate-grant":
      return (
        <Modal title="轮换 Agent Key" close={close}>
          <Form
            label="确认轮换"
            onSubmit={() => secret(`/api/client-grants/${dialog.grant.id}/rotate`, {}, "新 Agent Key")}
          >
            <p class="small muted">{dialog.grant.name} · 旧 Key 将立即失效</p>
          </Form>
        </Modal>
      );
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
  }
}
