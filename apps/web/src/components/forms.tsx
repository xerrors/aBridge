import { ChevronDown, X } from "lucide-preact";
import { createContext, type ComponentChildren, type JSX, type TargetedSubmitEvent } from "preact";
import { useContext, useId, useLayoutEffect, useRef, useState } from "preact/hooks";

const ModalPending = createContext<((pending: boolean) => void) | null>(null);

export function Form({
  children,
  onSubmit,
  label = "保存",
  cancel,
  tone = "primary",
}: {
  children: ComponentChildren;
  onSubmit: (data: FormData) => Promise<void>;
  label?: string;
  cancel?: () => void;
  tone?: "primary" | "danger";
}) {
  const setModalPending = useContext(ModalPending);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  useLayoutEffect(() => {
    setModalPending?.(busy);
    return () => setModalPending?.(false);
  }, [busy, setModalPending]);
  const submit = async (event: TargetedSubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await onSubmit(data);
    } catch (error) {
      setError(error instanceof Error ? error.message : "请求失败");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} aria-busy={busy}>
      <fieldset class="form-fields" disabled={busy}>
        {children}
      </fieldset>
      <div class="error" role="alert">
        {error}
      </div>
      <div class="dialog-actions">
        {cancel && (
          <button type="button" onClick={cancel} disabled={busy}>
            取消
          </button>
        )}
        <button class={tone} type="submit" disabled={busy}>
          {busy ? "处理中…" : label}
        </button>
      </div>
    </form>
  );
}
export function Select({ children, ...props }: JSX.IntrinsicElements["select"]) {
  return (
    <span class="select-control">
      <select {...props}>{children}</select>
      <ChevronDown aria-hidden="true" />
    </span>
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
          <input {...props} type="text" autoComplete={name === "username" ? "username" : undefined} />
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
  dismissible = true,
}: {
  title: string;
  children: ComponentChildren;
  close: () => void;
  className?: string;
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);
  const canDismiss = dismissible && !pending;
  const titleId = useId();
  useLayoutEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <ModalPending.Provider value={setPending}>
      <dialog
        ref={ref}
        class={className}
        aria-labelledby={titleId}
        onCancel={(event) => {
          event.preventDefault();
          if (canDismiss) close();
        }}
      >
        <div class="dialog-head">
          <h2 id={titleId}>{title}</h2>
          <button class="text-button" onClick={close} disabled={!canDismiss} aria-label="关闭">
            <X aria-hidden="true" />
          </button>
        </div>
        {children}
      </dialog>
    </ModalPending.Provider>
  );
}
