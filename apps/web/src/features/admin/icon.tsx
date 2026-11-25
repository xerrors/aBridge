const paths = {
  overview: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  tasks: "M9 5H5v16h14V5h-4M9 3h6v4H9zM9 11h6m-6 4h6",
  devices: "M3 4h18v12H3zM12 16v4m-4 0h8",
  users:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  groups:
    "M2 21v-2a4 4 0 0 1 4-4h2m8 0h2a4 4 0 0 1 4 4v2M9 21v-2a3 3 0 0 1 6 0v2M8 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0m14 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0m-7 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  audit: "M12 22s7-3 7-10V5l-7-3-7 3v7c0 7 7 10 7 10zM9 12l2 2 4-4",
  active: "M2 12h5l3-8 4 16 3-8h5",
  queued: "M4 6h16M4 12h16M4 18h10",
  approval: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0zM12 6v6l4 2",
  refresh:
    "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8m0-5v5h-5m5 4a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16m5 0H3v5",
} as const;

export function AdminIcon({ name }: { name: keyof typeof paths }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  );
}
