import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { adminCreateUserSchema, adminOverviewSchema, type AdminOverview } from "@abridge/protocol";
import { api, ApiError, userSchema } from "./api.js";
import { Field, Form, Modal } from "./components.js";

function dateTime(value: number | null): string {
  return value === null ? "尚未连接" : new Date(value * 1000).toLocaleString("zh-CN");
}

export function InstanceAdminPage({
  requireLogin,
  notify,
}: {
  requireLogin: () => void;
  notify: (message: string) => void;
}) {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const alive = useRef(true);
  const revision = useRef(0);
  const refreshing = useRef(false);
  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    const current = ++revision.current;
    setLoading(true);
    try {
      const loaded = await api("/api/admin/overview", adminOverviewSchema);
      if (!alive.current || revision.current !== current) return;
      setOverview(loaded);
      setError("");
    } catch (caught) {
      if (!alive.current || revision.current !== current) return;
      setOverview(null);
      if (caught instanceof ApiError && caught.status === 401) {
        setCreating(false);
        requireLogin();
        notify("管理员授权已失效，请重新打开管理链接。");
      } else setError(caught instanceof Error ? caught.message : "无法读取实例统计");
    } finally {
      refreshing.current = false;
      if (alive.current && revision.current === current) setLoading(false);
    }
  }, [notify, requireLogin]);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 5000);
    return () => {
      alive.current = false;
      revision.current++;
      clearInterval(timer);
    };
  }, [refresh]);
  const create = async (form: FormData) => {
    const input = adminCreateUserSchema.safeParse({
      username: form.get("username"),
      password: form.get("password"),
    });
    if (!input.success) throw new Error("请填写用户名和至少12位的初始密码。");
    try {
      const user = await api("/api/admin/users", userSchema, input.data);
      if (!alive.current) return;
      setCreating(false);
      notify(`已创建用户 ${user.username}`);
      await refresh();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        setCreating(false);
        requireLogin();
        notify("管理员授权已失效，请重新打开管理链接。");
      }
      throw caught;
    }
  };
  const stats =
    overview &&
    ([
      ["用户", overview.totals.users],
      ["已绑定设备", overview.totals.devices],
      ["在线设备", overview.totals.online_devices],
      ["电脑", overview.totals.computers],
      ["浏览器", overview.totals.browsers],
    ] as const);
  return (
    <>
      <div class="page-title">
        <h1>实例管理</h1>
        <div class="actions">
          <button disabled={loading} onClick={() => void refresh()}>
            {loading ? "刷新中…" : "刷新"}
          </button>
          <button class="primary" onClick={() => setCreating(true)}>
            创建用户
          </button>
        </div>
      </div>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      {stats ? (
        <dl class="instance-stats">
          {stats.map(([label, count]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{count}</dd>
            </div>
          ))}
        </dl>
      ) : (
        !error && (
          <p class="muted instance-loading" role="status">
            正在读取实例统计…
          </p>
        )
      )}
      {overview && (
        <section class="surface" aria-label="用户列表">
          <div class="instance-list-heading">
            <h2>
              用户<span class="count">{overview.users.length}</span>
            </h2>
            <span class="muted small">设备统计不包含已解绑设备</span>
          </div>
          {overview.users.length ? (
            overview.users.map((user) => (
              <details class="instance-user" key={user.id}>
                <summary>
                  <div>
                    <span class="name">{user.username}</span>
                    <span class="instance-created">创建于 {dateTime(user.created_at)}</span>
                  </div>
                  <div class="instance-user-counts">
                    <span>
                      电脑 <strong>{user.computer_count}</strong>
                    </span>
                    <span>
                      浏览器 <strong>{user.browser_count}</strong>
                    </span>
                    <span class={user.online_count ? "instance-online" : ""}>
                      在线 <strong>{user.online_count}</strong>
                    </span>
                  </div>
                </summary>
                {user.devices.length ? (
                  <div class="table-wrap">
                    <table class="record-list instance-devices">
                      <thead>
                        <tr>
                          <th scope="col">设备名称</th>
                          <th scope="col">类型</th>
                          <th scope="col">状态</th>
                          <th scope="col">最后连接</th>
                        </tr>
                      </thead>
                      <tbody>
                        {user.devices.map((device) => (
                          <tr key={device.id}>
                            <td>{device.name}</td>
                            <td>{device.kind === "computer" ? "电脑" : "浏览器"}</td>
                            <td>
                              <span class={`dot ${device.status}`} />{" "}
                              {device.status === "online" ? "在线" : "离线"}
                              {device.paused ? " · 已暂停" : ""}
                            </td>
                            <td>{dateTime(device.last_seen)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p class="instance-no-devices muted small">暂无已绑定设备</p>
                )}
              </details>
            ))
          ) : (
            <div class="empty">
              <p>还没有用户</p>
              <span class="small">创建账户后，用户即可登录并绑定自己的设备。</span>
            </div>
          )}
        </section>
      )}
      {creating && (
        <Modal title="创建用户" close={() => setCreating(false)}>
          <Form label="创建用户" onSubmit={create}>
            <Field name="username" label="用户名" />
            <Field
              name="password"
              label="初始密码（至少12位）"
              type="password"
              minLength={12}
              passwordPurpose="new"
            />
          </Form>
        </Modal>
      )}
    </>
  );
}
