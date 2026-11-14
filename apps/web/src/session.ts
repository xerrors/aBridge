import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { api, objectResultSchema, ApiError, loadData, userSchema, type User } from "./api.js";

export type ManagementData = Awaited<ReturnType<typeof loadData>>;
export const emptyData: ManagementData = { devices: [], grants: [] };
export type AuthPhase = "loading" | "login" | "ready";
export function useUserSession(notify: (message: string) => void, management = true) {
  const [user, setUser] = useState<User | null>(null);
  const [phase, setPhase] = useState<AuthPhase>("loading");
  const [data, setData] = useState<ManagementData>(emptyData);
  const [identityRevision, setIdentityRevision] = useState(0);
  const [reloadRevision, setReloadRevision] = useState(0);
  const identity = useRef<User | null>(null);
  const revision = useRef(0);
  const alive = useRef(false);
  const changingCookie = useRef(0);
  const cookieRequests = useRef<Promise<unknown>>(Promise.resolve());
  const updateIdentity = useCallback((me: User | null) => {
    if (identity.current?.id !== me?.id) {
      setData(emptyData);
      setIdentityRevision((value) => value + 1);
    }
    identity.current = me;
    setUser(me);
  }, []);
  const signedOut = useCallback(() => {
    revision.current++;
    updateIdentity(null);
    setData(emptyData);
    setPhase("login");
  }, [updateIdentity]);
  const reloadIdentity = useCallback(() => {
    revision.current++;
    updateIdentity(null);
    setData(emptyData);
    setPhase("loading");
    setReloadRevision((value) => value + 1);
  }, [updateIdentity]);
  const refresh = useCallback(async () => {
    if (changingCookie.current) return;
    const current = ++revision.current;
    const valid = () => alive.current && revision.current === current;
    try {
      // A cookie can change in another tab. Never publish data under an older displayed identity.
      for (let attempt = 0; attempt < 2; attempt++) {
        const me = await api("/api/me", userSchema);
        if (!valid()) return;
        updateIdentity(me);
        const loaded = management ? await loadData() : emptyData;
        const confirmed = management ? await api("/api/me", userSchema) : me;
        if (!valid()) return;
        if (confirmed.id !== me.id) {
          updateIdentity(confirmed);
          continue;
        }
        setData(loaded);
        setPhase("ready");
        return;
      }
      throw new Error("当前登录账户已更换，请重新刷新。");
    } catch (error) {
      if (!valid()) return;
      if (error instanceof ApiError && error.status === 401) signedOut();
      else {
        setData((previous) => ({
          ...previous,
          devices: previous.devices.map((device) =>
            device.status === "revoked"
              ? device
              : { ...device, status: "unknown", paused: undefined, available: undefined },
          ),
        }));
        setPhase(identity.current ? "ready" : "login");
        notify(error instanceof Error ? error.message : "刷新失败");
        throw error;
      }
    }
  }, [management, notify, signedOut, updateIdentity]);
  useEffect(() => {
    alive.current = true;
    void refresh().catch(() => {});
    return () => {
      alive.current = false;
      revision.current++;
    };
  }, [refresh, reloadRevision]);
  useEffect(() => {
    if (!management || phase !== "ready") return;
    let busy = false;
    const timer = setInterval(() => {
      if (busy || document.hidden) return;
      busy = true;
      void refresh()
        .catch(() => {})
        .finally(() => {
          busy = false;
        });
    }, 5000);
    return () => clearInterval(timer);
  }, [management, phase, refresh]);
  const authenticate = async (form: FormData) => {
    const current = ++revision.current;
    changingCookie.current++;
    // Serialize Set-Cookie responses, so an earlier login cannot undo a later logout.
    const pending = cookieRequests.current.then(() =>
      api("/api/login", userSchema, {
        username: form.get("username"),
        password: form.get("password"),
      }),
    );
    cookieRequests.current = pending.catch(() => undefined);
    try {
      await pending;
    } finally {
      changingCookie.current--;
    }
    if (alive.current && revision.current === current) await refresh();
  };
  const logout = async () => {
    signedOut();
    changingCookie.current++;
    const pending = cookieRequests.current.then(() => api("/api/logout", objectResultSchema, {}));
    cookieRequests.current = pending.catch(() => undefined);
    try {
      await pending;
    } finally {
      changingCookie.current--;
    }
  };
  return {
    user,
    phase,
    data,
    identityRevision,
    refresh,
    authenticate,
    logout,
    requireLogin: signedOut,
    reloadIdentity,
  };
}
