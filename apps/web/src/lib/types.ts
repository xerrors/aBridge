import type { loadData } from "./api.js";

export type ManagementData = Awaited<ReturnType<typeof loadData>>;
export type RunAction = (action: () => Promise<void>) => void;
export type Mutate = (path: string, body?: unknown, method?: string) => Promise<void>;
