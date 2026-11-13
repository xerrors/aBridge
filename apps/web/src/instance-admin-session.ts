import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { adminSessionSchema } from "@abridge/protocol";
import { api, ApiError, objectResultSchema } from "./api.js";

/** Cookie-changing responses must finish in request order, including an overlapping logout. */
export class AdminSessionRequests {
  private pending: Promise<unknown> = Promise.resolve();
  private send(action: () => Promise<unknown>): Promise<unknown> {
    const result = this.pending.then(action);
    this.pending = result.catch(() => undefined);
    return result;
  }
  exchange(token: string): Promise<unknown> {
    return this.send(() => api("/api/admin/session", adminSessionSchema, {}, "POST", token));
  }
  logout(): Promise<unknown> {
    return this.send(() => api("/api/admin/session", objectResultSchema, {}, "DELETE"));
  }
}

/** Consume the bootstrap secret before making any network request. */
export function takeAdminToken(
  address: Pick<Location, "hash" | "pathname" | "search">,
  replace: (url: string) => void,
): string {
  const parameters = new URLSearchParams(address.hash.slice(1));
  if (!parameters.has("admin_token")) return "";
  const tokens = parameters.getAll("admin_token");
  const valid = tokens.length === 1 && Boolean(tokens[0]);
  replace(address.pathname + address.search + (valid ? "#admin" : ""));
  if (tokens.length !== 1 || !tokens[0]) throw new Error("管理员链接无效，请使用终端输出的完整链接。");
  return tokens[0];
}

export function useInstanceAdminSession(notify: (message: string) => void) {
  const [requests] = useState(() => new AdminSessionRequests());
  const [phase, setPhase] = useState<"loading" | "ready" | "none">("loading");
  const bootstrap = useRef<{ token: string; error?: string } | null>(null);
  if (!bootstrap.current) {
    try {
      bootstrap.current = { token: takeAdminToken(location, (url) => history.replaceState(null, "", url)) };
    } catch (error) {
      bootstrap.current = { token: "", error: error instanceof Error ? error.message : "管理员链接无效" };
    }
  }
  const revision = useRef(0);
  const requireLogin = useCallback(() => {
    revision.current++;
    setPhase("none");
  }, []);
  useEffect(() => {
    let active = true;
    const verify = async ({ token, error }: { token: string; error?: string }) => {
      const current = ++revision.current;
      if (error) notify(error);
      if (token) setPhase("loading");
      try {
        if (token) await requests.exchange(token);
        else await api("/api/admin/session", adminSessionSchema);
        if (active && current === revision.current) setPhase("ready");
      } catch (caught) {
        if (!active || current !== revision.current) return;
        setPhase("none");
        if (token || !(caught instanceof ApiError && caught.status === 401))
          notify(
            caught instanceof ApiError && caught.status === 401
              ? "管理员链接无效或已失效，请使用终端输出的管理链接。"
              : caught instanceof Error
                ? caught.message
                : "无法验证管理员身份",
          );
      }
    };
    const initial = bootstrap.current!;
    bootstrap.current = { token: "" };
    void verify(initial);
    const navigate = () => {
      if (!new URLSearchParams(location.hash.slice(1)).has("admin_token")) return;
      try {
        const token = takeAdminToken(location, (url) => history.replaceState(null, "", url));
        void verify({ token });
      } catch (error) {
        notify(error instanceof Error ? error.message : "管理员链接无效");
      }
    };
    window.addEventListener("hashchange", navigate);
    return () => {
      active = false;
      revision.current++;
      window.removeEventListener("hashchange", navigate);
    };
  }, [notify, requests]);
  const logout = useCallback(async () => {
    revision.current++;
    await requests.logout();
    setPhase("none");
  }, [requests]);
  return { phase, logout, requireLogin };
}
