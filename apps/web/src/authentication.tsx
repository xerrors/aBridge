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
  const setup = phase === "setup";
  return (
    <main class="login-wrap" id="main">
      <div class="login-panel">
        <Brand />
        <h1>{setup ? "创建管理账户" : "登录管理台"}</h1>
        <Form label={setup ? "创建并登录" : "登录"} onSubmit={authenticate}>
          <Field name="username" label="账户" />
          <Field
            name="password"
            label={setup ? "密码（至少12位）" : "密码"}
            type="password"
            minLength={setup ? 12 : 1}
            passwordPurpose={setup ? "new" : "current"}
          />
        </Form>
        {notice && <p role="alert">{notice}</p>}
      </div>
    </main>
  );
}
