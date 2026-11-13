import { useCallback, useEffect, useState } from "preact/hooks";
import { api, objectResultSchema, ApiError, loadData, userSchema, type User } from "./api.js";

export type ManagementData = Awaited<ReturnType<typeof loadData>>;
export const emptyData: ManagementData = { devices: [], grants: [] };
export type AuthPhase = "loading" | "login" | "ready";
export function useUserSession(notify: (message: string) => void, management = true) {
  const [user, setUser] = useState<User | null>(null);
  const [phase, setPhase] = useState<AuthPhase>("loading");
  const [data, setData] = useState<ManagementData>(emptyData);
  const [identityRevision, setIdentityRevision] = useState(0);
  const reloadIdentity = useCallback(() => {
    setUser(null);
    setData(emptyData);
    setPhase("loading");
    setIdentityRevision((value) => value + 1);
  }, []);
  const refresh = useCallback(async () => {
    if (management) setData(await loadData());
  }, [management]);
  const signedOut = useCallback(() => {
    setUser(null);
    setData(emptyData);
    setPhase("login");
  }, []);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [me, loaded] = await Promise.all([
          api("/api/me", userSchema),
          management ? loadData() : Promise.resolve(emptyData),
        ]);
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
  }, [management, identityRevision, notify, signedOut]);
  useEffect(() => {
    if (!management || phase !== "ready") return;
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
  }, [management, phase, notify, signedOut]);
  const authenticate = async (form: FormData) => {
    const me = await api("/api/login", userSchema, {
      username: form.get("username"),
      password: form.get("password"),
    });
    const loaded = management ? await loadData() : emptyData;
    setUser(me);
    setData(loaded);
    setPhase("ready");
  };
  const logout = async () => {
    await api("/api/logout", objectResultSchema, {});
    signedOut();
  };
  return { user, phase, data, refresh, authenticate, logout, requireLogin: signedOut, reloadIdentity };
}
