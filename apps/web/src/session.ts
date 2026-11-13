import { useCallback, useEffect, useState } from "preact/hooks";
import { z } from "zod";
import { api, objectResultSchema, ApiError, loadData, userSchema, type User } from "./api.js";

export type AdminData = Awaited<ReturnType<typeof loadData>>;
export const emptyData: AdminData = { devices: [], grants: [], operations: [] };
export type AuthPhase = "loading" | "login" | "setup" | "ready";
function takeSetupToken(): string {
  const token = new URLSearchParams(location.hash.slice(1)).get("setup") ?? "";
  if (token) history.replaceState(null, "", location.pathname + location.search);
  return token;
}
export function useAdminSession(notify: (message: string) => void) {
  const [user, setUser] = useState<User | null>(null);
  const [phase, setPhase] = useState<AuthPhase>("loading");
  const [data, setData] = useState<AdminData>(emptyData);
  const [setupToken] = useState(takeSetupToken);
  const refresh = useCallback(async () => {
    setData(await loadData());
  }, []);
  const signedOut = useCallback(() => {
    setUser(null);
    setData(emptyData);
    setPhase("login");
  }, []);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const setup = await api("/api/setup", z.object({ required: z.boolean() }));
        if (setup.required) {
          if (active) setPhase("setup");
          return;
        }
        const [me, loaded] = await Promise.all([api("/api/me", userSchema), loadData()]);
        if (active) {
          setUser(me);
          setData(loaded);
          setPhase("ready");
        }
      } catch (error) {
        if (!active) return;
        signedOut();
        if (!(error instanceof ApiError && error.status === 401))
          notify(error instanceof Error ? error.message : "连接失败");
      }
    })();
    return () => {
      active = false;
    };
  }, [notify, signedOut]);
  useEffect(() => {
    if (phase !== "ready") return;
    let active = true,
      busy = false;
    const timer = setInterval(() => {
      if (busy || document.hidden) return;
      busy = true;
      void loadData()
        .then((loaded) => {
          if (active) setData(loaded);
        })
        .catch((error) => {
          if (!active) return;
          if (error instanceof ApiError && error.status === 401) signedOut();
          else notify(error instanceof Error ? error.message : "刷新失败");
        })
        .finally(() => {
          busy = false;
        });
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [phase, notify, signedOut]);
  const authenticate = async (form: FormData) => {
    if (phase === "setup" && !setupToken) throw new Error("请使用 --web 打开首次配置，或在终端创建管理账户");
    const me = await api(
      phase === "setup" ? "/api/setup" : "/api/login",
      userSchema,
      {
        username: form.get("username"),
        password: form.get("password"),
      },
      "POST",
      phase === "setup" ? setupToken : undefined,
    );
    const loaded = await loadData();
    setUser(me);
    setData(loaded);
    setPhase("ready");
  };
  const logout = async () => {
    await api("/api/logout", objectResultSchema, {});
    signedOut();
  };
  return { user, phase, data, refresh, authenticate, logout };
}
