import { Brand, Field, Form } from "./components.js";
import type { AuthPhase } from "./session.js";
export function Authentication({
  phase,
  notice,
  authenticate,
}: {
  phase: AuthPhase;
  notice: string;
  authenticate: (data: FormData) => Promise<void>;
}) {
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
        <Form label="登录" onSubmit={authenticate}>
          <Field name="username" label="账户" />
          <Field name="password" label="密码" type="password" minLength={1} passwordPurpose="current" />
        </Form>
        {notice && <p role="alert">{notice}</p>}
      </div>
    </main>
  );
}
