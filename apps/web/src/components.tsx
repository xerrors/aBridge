import type { ComponentChildren, TargetedSubmitEvent } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { CAPABILITIES, type Capability } from "@abridge/protocol";

export const capabilityLabels: Record<Capability, string> = {
  screen: "屏幕",
  input: "键鼠",
  shell: "Shell",
  files: "文件",
  browser: "浏览器",
};
export const stateLabels: Record<string, string> = {
  online: "在线",
  offline: "离线",
  revoked: "已解绑",
  accepted: "已接受",
  dispatched: "执行中",
  executed: "已执行",
  failed: "失败",
  refused: "已拒绝",
  outcome_unknown: "结果未知",
  cancelled: "已取消",
};
export function Brand() {
  return (
    <div class="brand">
      <img class="brand-symbol" src="/static/brand.svg" alt="" />
      <img class="brand-wordmark" src="/static/wordmark.svg" alt="aBridge" />
    </div>
  );
}
export function Scope({
  selected = ["screen", "input"],
  allowed = CAPABILITIES,
}: {
  selected?: readonly Capability[];
  allowed?: readonly Capability[];
}) {
  return (
    <div class="checks">
      {allowed.map((cap) => (
        <label class="check" key={cap}>
          <input type="checkbox" name="capabilities" value={cap} defaultChecked={selected.includes(cap)} />
          {capabilityLabels[cap]}
        </label>
      ))}
    </div>
  );
}
export function Form({
  children,
  onSubmit,
  label = "保存",
}: {
  children: ComponentChildren;
  onSubmit: (data: FormData) => Promise<void>;
  label?: string;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: TargetedSubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await onSubmit(data);
    } catch (error) {
      setError(error instanceof Error ? error.message : "请求失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit}>
      {children}
      <div class="error" role="alert">
        {error}
      </div>
      <div class="dialog-actions">
        <button class="primary" type="submit" disabled={busy}>
          {busy ? "处理中…" : label}
        </button>
      </div>
    </form>
  );
}
export function Field({
  name,
  label,
  type = "text",
  value,
  required = true,
  minLength,
  passwordPurpose = "current",
}: {
  name: string;
  label: string;
  type?: "text" | "password" | "date";
  value?: string;
  required?: boolean;
  minLength?: number;
  passwordPurpose?: "new" | "current";
}) {
  const props = { name, defaultValue: value, required, minLength };
  return (
    <div class="field">
      <label>
        {label}
        {type === "password" ? (
          <input
            {...props}
            type="password"
            autoComplete={passwordPurpose === "new" ? "new-password" : "current-password"}
          />
        ) : type === "date" ? (
          <input {...props} type="date" />
        ) : (
          <input {...props} type="text" />
        )}
      </label>
    </div>
  );
}
export function Modal({
  title,
  children,
  close,
  className,
}: {
  title: string;
  children: ComponentChildren;
  close: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      class={className}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div class="dialog-head">
        <h2>{title}</h2>
        <button class="text-button" onClick={close} aria-label="关闭">
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}
