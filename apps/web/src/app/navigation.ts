export type Tab = "overview" | "devices" | "grants" | "activity" | "admin";
export type Route = { tab: Tab; id?: string; section?: string };
export function parseRoute(hash: string): Route {
  const [tab, encodedId, section] = hash.replace(/^#/, "").split("/");
  if (!tab) return { tab: "overview" };
  if (!["overview", "devices", "grants", "activity", "admin"].includes(tab)) return { tab: "overview" };
  let id: string | undefined;
  try {
    id = encodedId ? decodeURIComponent(encodedId) : undefined;
  } catch {
    id = encodedId;
  }
  return { tab: tab as Tab, id, section };
}
