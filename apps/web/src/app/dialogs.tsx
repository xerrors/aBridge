import { useCredentialGuard } from "../lib/credential-guard.js";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { z } from "zod";
import { api } from "../lib/api.js";
import type { Device, Grant } from "../lib/api.js";
import { CopyButton } from "../components/actions.js";
import { Form, Modal } from "../components/forms.js";
import type { Mutate, RunAction } from "../lib/types.js";
import { ConnectionEditor } from "../features/connections/editor.js";

export type ManagementDialog =
  | { kind: "rotate-device"; device: Device }
  | { kind: "edit-grant"; grant: Grant }
  | { kind: "rotate-grant"; grant: Grant }
  | { kind: "secret"; title: string; value: string }
  | { kind: "confirm"; title: string; description: string; path: string; tone?: "primary" | "danger" };
function CredentialDialog({
  title,
  value,
  close,
  run,
}: {
  title: string;
  value: string;
  close: () => void;
  run: RunAction;
}) {
  const [saved, setSaved] = useState(false);
  useCredentialGuard(!saved, "凭据尚未保存，离开后无法再次查看，仍要离开吗？");
  const dismiss = () => {
    if (saved || window.confirm("凭据尚未保存，关闭后无法再次查看，仍要关闭吗？")) close();
  };
  return (
    <Modal title={title} close={dismiss}>
      <p class="secret-notice">仅此一次显示，请保存到对应客户端。</p>
      <textarea class="key-area" aria-label="Key" value={value} readOnly />
      <label class="inline-check credential-saved">
        <input type="checkbox" checked={saved} onChange={(event) => setSaved(event.currentTarget.checked)} />
        我已保存凭据
      </label>
      <div class="dialog-actions">
        <button onClick={dismiss}>完成</button>
        <CopyButton value={value} run={run} />
      </div>
    </Modal>
  );
}
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
  const [rotating, setRotating] = useState(false);
  useCredentialGuard(rotating, "正在生成新凭据。离开后可能无法保存新凭据，仍要离开吗？");
  const alive = useRef(true);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const secret = async (path: string, body: unknown, title: string) => {
    setRotating(true);
    try {
      const result = await api(path, keyResult, body);
      if (!alive.current) return;
      open({ kind: "secret", title, value: result.key });
      await refresh().catch((error) => notify(error instanceof Error ? error.message : "列表刷新失败"));
    } finally {
      if (alive.current) setRotating(false);
    }
  };
  switch (dialog.kind) {
    case "rotate-device":
      return (
        <Modal title="重新生成设备凭据" close={close} dismissible={!rotating}>
          <Form
            cancel={close}
            label="重新生成"
            onSubmit={() => secret(`/api/devices/${dialog.device.id}/credentials`, {}, "新 Device Token")}
          >
            <p class="small muted">
              {dialog.device.name} · 旧 Token 将立即失效，当前连接会断开，需要重新绑定客户端。
            </p>
          </Form>
        </Modal>
      );
    case "edit-grant":
      return (
        <ConnectionEditor
          grant={dialog.grant}
          devices={devices}
          close={close}
          submit={async (input) => {
            await mutate(`/api/client-grants/${dialog.grant.id}`, input, "PATCH");
            if (!alive.current) return;
            notify("连接已保存");
            close();
          }}
        />
      );
    case "rotate-grant":
      return (
        <Modal title="重新生成 Agent Key" close={close} dismissible={!rotating}>
          <Form
            cancel={close}
            label="重新生成 Key"
            onSubmit={() => secret(`/api/client-grants/${dialog.grant.id}/rotate`, {}, "新 Agent Key")}
          >
            <p class="small muted">{dialog.grant.name} · 旧 Key 将立即失效</p>
          </Form>
        </Modal>
      );
    case "secret":
      return <CredentialDialog title={dialog.title} value={dialog.value} close={close} run={run} />;
    case "confirm":
      return (
        <Modal title={dialog.title} close={close}>
          <Form
            label={dialog.title}
            cancel={close}
            tone={dialog.tone ?? "danger"}
            onSubmit={async () => {
              await mutate(dialog.path);
              if (!alive.current) return;
              notify(`${dialog.title}成功`);
              close();
            }}
          >
            <p class="confirm-description">{dialog.description}</p>
          </Form>
        </Modal>
      );
  }
}
