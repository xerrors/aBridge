import { useLayoutEffect } from "preact/hooks";

let currentGuard: { message: string } | undefined;

/** Called by the router before it replaces the mounted page. */
export function confirmCredentialNavigation(): boolean {
  return !currentGuard || window.confirm(currentGuard.message);
}

/** Keep one-time credentials in the mounted page until navigation is confirmed. */
export function useCredentialGuard(
  enabled: boolean,
  message = "Agent Key 尚未确认保存。离开后无法再次查看，仍要离开吗？",
) {
  useLayoutEffect(() => {
    if (!enabled) return;
    const guard = { message };
    currentGuard = guard;
    const preventLoss = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventLoss);
    return () => {
      if (currentGuard === guard) currentGuard = undefined;
      window.removeEventListener("beforeunload", preventLoss);
    };
  }, [enabled, message]);
}
