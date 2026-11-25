import { AdminIcon } from "./icon.js";

export function RefreshButton({ loading, refresh }: { loading: boolean; refresh: () => Promise<void> }) {
  const label = loading ? "刷新中…" : "刷新";
  return (
    <button
      type="button"
      class="admin-refresh"
      aria-label={label}
      aria-busy={loading}
      title={label}
      disabled={loading}
      onClick={() => void refresh()}
    >
      <AdminIcon name="refresh" />
    </button>
  );
}
