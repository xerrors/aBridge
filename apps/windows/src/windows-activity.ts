/** Only a fresh, admitted desktop operation can light the control indicator. */
export function desktopActivity(status: Record<string, unknown>, now = Date.now() / 1000): boolean {
  return (
    status.connection === "online" &&
    status.paused === false &&
    typeof status.active_operations === "number" &&
    status.active_operations > 0 &&
    typeof status.desktop_active_until === "number" &&
    status.desktop_active_until > now &&
    typeof status.updated_at === "number" &&
    status.updated_at <= now + 1 &&
    now - status.updated_at < 2
  );
}
