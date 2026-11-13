import { useEffect, useState } from "preact/hooks";
import { Brand, Field, Form } from "./components.js";
import type { AuthPhase } from "./session.js";
/** 保留设备绑定入口，不转发其他查询中的凭据或外部返回地址。 */
export function oidcLoginPath(search: string, hash: string): string {
  const returnTo = /^\?authorize=[A-Za-z0-9_-]{1,160}$/.test(search) ? "/" + search : "/" + hash;
  return "/api/auth/oidc/login?return_to=" + encodeURIComponent(returnTo);
}
export function Authentication({
  phase,
  notice,
  authenticate,
}: {
  phase: AuthPhase;
  notice: string;
  authenticate: (data: FormData) => Promise<void>;
}) {
  const [oidcEnabled, setOidcEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    void fetch("/api/auth/oidc/config")
      .then((response) => (response.ok ? response.json() : null))
      .then((value: unknown) => {
        if (active && value && typeof value === "object" && "enabled" in value && value.enabled === true)
          setOidcEnabled(true);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  if (phase === "loading")
    return (
      <main class="login-wrap">
        <Brand />
      </main>
    );
  return (
    <main class="login-wrap" id="main">
      <div class="login-panel">
        <Brand />
        <h1>登录管理台</h1>
        {oidcEnabled && (
          <a class="button" href={oidcLoginPath(window.location.search, window.location.hash)}>
            使用统一账户登录
          </a>
        )}
        <Form label="登录" onSubmit={authenticate}>
          <Field name="username" label="账户" />
          <Field name="password" label="密码" type="password" minLength={1} passwordPurpose="current" />
        </Form>
        {notice && <p role="alert">{notice}</p>}
      </div>
    </main>
  );
}
