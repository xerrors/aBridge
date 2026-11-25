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
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M20 7v5h-5M4 17v-5h5M6.1 8a7 7 0 0 1 11.5-2L20 9M4 15l2.4 3A7 7 0 0 0 17.9 16" />
      </svg>
    </button>
  );
}
