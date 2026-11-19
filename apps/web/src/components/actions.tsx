import { ChevronDown, Copy } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

export function ActionButton({
  action,
  run,
  children,
  busyLabel = "处理中…",
  successLabel,
  className,
  label,
  disabled = false,
  icon,
}: {
  action: () => Promise<void>;
  run: (action: () => Promise<void>) => void;
  children: ComponentChildren;
  busyLabel?: string;
  successLabel?: string;
  className?: string;
  label?: string;
  disabled?: boolean;
  icon?: ComponentChildren;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const pending = useRef(false);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(false), 2500);
    return () => clearTimeout(timer);
  }, [done]);
  return (
    <button
      type="button"
      class={className}
      aria-label={label}
      aria-busy={busy}
      disabled={busy || disabled}
      onClick={() => {
        if (pending.current) return;
        pending.current = true;
        run(async () => {
          setBusy(true);
          setDone(false);
          try {
            await action();
            setDone(true);
          } finally {
            pending.current = false;
            setBusy(false);
          }
        });
      }}
    >
      {icon}
      <span aria-live="polite">{busy ? busyLabel : done && successLabel ? successLabel : children}</span>
    </button>
  );
}
export function CopyButton({
  value,
  run,
  children = "复制",
  className = "primary",
}: {
  value: string;
  run: (action: () => Promise<void>) => void;
  children?: ComponentChildren;
  className?: string;
}) {
  return (
    <ActionButton
      className={className}
      icon={<Copy aria-hidden="true" />}
      run={run}
      action={async () => {
        try {
          if (navigator.clipboard) {
            await navigator.clipboard.writeText(value);
            return;
          }
          // Insecure LAN origins do not expose the Clipboard API.
          const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          const field = document.createElement("textarea");
          field.value = value;
          field.readOnly = true;
          field.style.cssText = "position: fixed; left: 0; top: 0; opacity: 0; pointer-events: none;";
          (previous?.closest("dialog[open]") ?? document.body).append(field);
          try {
            field.select();
            if (!document.execCommand("copy")) throw new Error();
          } finally {
            field.remove();
            previous?.focus({ preventScroll: true });
          }
        } catch {
          throw new Error("复制失败，请选中文本后手动复制。");
        }
      }}
      busyLabel="复制中…"
      successLabel="已复制"
    >
      {children}
    </ActionButton>
  );
}
export function ActionMenu({ label, children }: { label: string; children: ComponentChildren }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target))
        ref.current?.removeAttribute("open");
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !ref.current?.open) return;
      event.preventDefault();
      ref.current.removeAttribute("open");
      ref.current.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  return (
    <details
      ref={ref}
      class="connection-menu"
      onClickCapture={(event) => {
        if (!(event.target instanceof Element) || !event.target.closest("button")) return;
        ref.current?.removeAttribute("open");
        ref.current?.querySelector("summary")?.focus();
      }}
    >
      <summary aria-label={label}>
        <ChevronDown aria-hidden="true" />
      </summary>
      <div>{children}</div>
    </details>
  );
}
