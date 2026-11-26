import { AdminIcon } from "./icon.js";
import { RefreshButton } from "./refresh-button.js";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  adminOverviewSchema,
  taskListSchema,
  taskDetailSchema,
  taskAuditListSchema,
  type AdminOverview,
  type TaskView,
  type TaskEvent,
  type TaskAuditEntry,
} from "@abridge/protocol";
import { api, ApiError } from "../../lib/api.js";
import { z } from "zod";
import { Field, Form, Modal, Select } from "../../components/forms.js";
import { executionSteps } from "../tasks/trace.js";
import { UserAdminPage } from "./page.js";

const sections = {
  overview: "运行概览",
  tasks: "任务",
  devices: "设备",
  users: "用户",
  groups: "小组",
  audit: "审计",
} as const;
export type AdminSection = keyof typeof sections;
export function AdminNavigation({ section, sidebar = false }: { section: AdminSection; sidebar?: boolean }) {
  return (
    <nav class={sidebar ? "admin-sidebar-nav" : "subnav admin-subnav"} aria-label="实例管理导航">
      {(Object.keys(sections) as AdminSection[]).map((key) => (
        <a key={key} href={`#admin/${key}`} aria-current={section === key ? "page" : undefined}>
          {sidebar && <AdminIcon name={key} />}
          {sections[key]}
        </a>
      ))}
    </nav>
  );
}
export const taskLabels: Record<string, string> = {
  approval: "待接收方确认",
  queued: "排队中",
  running: "执行中",
  waiting: "等待恢复",
  stopping: "停止中",
  done: "已完成",
  rejected: "已拒绝",
  cancelled: "已取消",
  stopped: "已停止",
  failed: "失败",
  unknown: "状态未知",
};
const activeStates = ["running", "waiting", "stopping", "unknown"];
const dateTime = (value: number) => new Date(value * 1000).toLocaleString("zh-CN");
function Status({ status }: { status: string }) {
  return <span class={`task-status status-${status}`}>{taskLabels[status] ?? status}</span>;
}

export function InstanceAdminPage({
  requireLogin,
  notify,
  section = "overview",
  groups,
  sidebar = false,
}: {
  requireLogin: () => void;
  notify: (message: string) => void;
  section?: AdminSection;
  groups?: preact.ComponentChildren;
  sidebar?: boolean;
}) {
  const [addingDevice, setAddingDevice] = useState(false);
  const [deviceKey, setDeviceKey] = useState("");
  useEffect(() => {
    if (section !== "devices") {
      setAddingDevice(false);
      setDeviceKey("");
    }
  }, [section]);
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [audit, setAudit] = useState<TaskAuditEntry[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [recipient, setRecipient] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);
  const alive = useRef(true);
  const pending = useRef(false);
  const refresh = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    setLoading(true);
    try {
      const [o, t, a] = await Promise.all([
        api("/api/admin/overview", adminOverviewSchema),
        api("/api/admin/tasks", taskListSchema),
        api("/api/admin/task-audit", taskAuditListSchema),
      ]);
      if (!alive.current) return;
      setOverview(o);
      setTasks(t.tasks);
      setAudit(a.entries);
      setError("");
    } catch (e) {
      if (!alive.current) return;
      setError(e instanceof Error ? e.message : "读取管理数据失败");
      if (e instanceof ApiError && e.status === 401) requireLogin();
    } finally {
      pending.current = false;
      if (alive.current) setLoading(false);
    }
  }, [requireLogin]);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 5000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [refresh]);
  const person = (id: string) => overview?.users.find((u) => u.id === id)?.username ?? id;
  const devices = overview?.users.flatMap((u) => u.devices.map((d) => ({ ...d, owner: u.username }))) ?? [];
  const device = (id: string) => devices.find((d) => d.id === id)?.name ?? id;
  const active = tasks.filter((t) => activeStates.includes(t.status));
  const recipients = [...new Set(tasks.map((t) => t.recipient_id))];
  const showTasks = (status = "all", owner = "all") => {
    setFilter(status);
    setRecipient(owner);
    setQuery("");
    location.hash = "admin/tasks";
  };
  const found = tasks.filter(
    (t) =>
      (filter === "all" || (filter === "active" && activeStates.includes(t.status)) || t.status === filter) &&
      (recipient === "all" || t.recipient_id === recipient) &&
      `${t.id} ${t.prompt ?? ""} ${person(t.actor_id)} ${person(t.recipient_id)}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const taskTable = (rows: TaskView[]) => (
    <div class="table-wrap">
      <table class="record-list admin-table">
        <thead>
          <tr>
            {["任务", "发起人", "接收人", "执行设备", "状态", "提交时间"].map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id}>
              <td>
                <button class="text-button admin-task-link" onClick={() => setSelected(t.id)}>
                  {t.prompt || "设备协助任务"}
                  <small>{t.id}</small>
                </button>
              </td>
              <td>{person(t.actor_id)}</td>
              <td>{person(t.recipient_id)}</td>
              <td>{device(t.device_id)}</td>
              <td>
                <Status status={t.status} />
                {t.queue_position !== null && <small>第 {t.queue_position} 位</small>}
              </td>
              <td>{dateTime(t.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <p class="admin-empty">没有符合条件的任务</p>}
    </div>
  );
  if (section === "users" || section === "groups")
    return (
      <>
        {!sidebar && <AdminNavigation section={section} />}
        {section === "users" ? <UserAdminPage requireLogin={requireLogin} notify={notify} /> : groups}
      </>
    );
  return (
    <>
      <div class="page-title">
        <h1>{sections[section]}</h1>
        <div class="actions">
          <RefreshButton loading={loading} refresh={refresh} />
          {section === "devices" && sidebar && (
            <button class="primary" disabled={!overview?.users.length} onClick={() => setAddingDevice(true)}>
              添加 Android 设备
            </button>
          )}
        </div>
      </div>
      {!sidebar && <AdminNavigation section={section} />}
      {error && (
        <p class="error" role="alert">
          {error} <button onClick={() => void refresh()}>重试</button>
        </p>
      )}
      {loading && !overview && !error && <p role="status">正在读取管理数据…</p>}
      {section === "overview" && overview && (
        <>
          <div class="admin-metrics">
            {(
              [
                ["在线设备", overview.totals.online_devices, "devices"],
                ["正在处理", active.length, "active"],
                ["已排队", tasks.filter((t) => t.status === "queued").length, "queued"],
                ["待接收方确认", tasks.filter((t) => t.status === "approval").length, "approval"],
              ] as const
            ).map(([label, count, target]) => (
              <button
                key={label}
                class="surface admin-metric"
                onClick={() =>
                  target === "devices" ? (location.hash = "admin/devices") : showTasks(String(target))
                }
              >
                <span>{label}</span>
                <strong>{count}</strong>
                <span class="admin-metric-icon">
                  <AdminIcon name={target} />
                </span>
                <small>{target === "queued" ? "按接收人依序执行" : "查看详情 →"}</small>
              </button>
            ))}
          </div>
          <div class="admin-featured">
            <section class="surface">
              <div class="instance-list-heading">
                <h2>接收人队列</h2>
              </div>
              {recipients.map((id) => (
                <button class="admin-queue-row" key={id} onClick={() => showTasks("all", id)}>
                  <strong>{person(id)}</strong>
                  <span>{active.filter((t) => t.recipient_id === id).length} 项处理中</span>
                  <span>
                    排队 {tasks.filter((t) => t.recipient_id === id && t.status === "queued").length} 条
                  </span>
                </button>
              ))}
              {!recipients.length && <p class="admin-empty">暂无任务队列</p>}
            </section>
            <section class="surface">
              <div class="instance-list-heading">
                <h2>需要关注</h2>
              </div>
              {["waiting", "unknown", "failed"].map((status) => (
                <button class="admin-queue-row" key={status} onClick={() => showTasks(status)}>
                  <Status status={status} />
                  <strong>{tasks.filter((t) => t.status === status).length}</strong>
                </button>
              ))}
            </section>
          </div>
          <section class="surface">
            <div class="instance-list-heading">
              <h2>近期任务</h2>
              <a href="#admin/tasks">全部任务</a>
            </div>
            {taskTable(tasks.slice(0, 6))}
          </section>
        </>
      )}
      {section === "tasks" && (
        <section class="surface">
          <div class="admin-filters">
            <label>
              搜索任务
              <input
                type="search"
                value={query}
                onInput={(e) => setQuery(e.currentTarget.value)}
                placeholder="任务、发起人或接收人"
              />
            </label>
            <label>
              任务状态
              <Select value={filter} onChange={(e) => setFilter(e.currentTarget.value)}>
                <option value="all">全部状态</option>
                <option value="active">正在处理</option>
                {Object.entries(taskLabels).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              接收人
              <Select value={recipient} onChange={(e) => setRecipient(e.currentTarget.value)}>
                <option value="all">全部接收人</option>
                {recipients.map((id) => (
                  <option key={id} value={id}>
                    {person(id)}
                  </option>
                ))}
              </Select>
            </label>
          </div>
          {taskTable(found)}
        </section>
      )}
      {section === "devices" && (
        <section class="surface">
          <div class="table-wrap">
            <table class="record-list admin-table">
              <thead>
                <tr>
                  {["设备", "所有人", "类型", "状态", "最后连接", "当前任务"].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={d.id}>
                    <td>
                      {d.name}
                      <small>{d.id}</small>
                    </td>
                    <td>{d.owner}</td>
                    <td>{d.kind === "browser" ? "浏览器" : "电脑"}</td>
                    <td>
                      <span class={`dot ${d.status}`} /> {d.status === "online" ? "在线" : "离线"}
                      {d.paused ? " · 已暂停" : ""}
                    </td>
                    <td>{d.last_seen === null ? "尚未连接" : dateTime(d.last_seen)}</td>
                    <td>
                      {active
                        .filter((t) => t.device_id === d.id)
                        .map((t) => (
                          <button key={t.id} class="text-button" onClick={() => setSelected(t.id)}>
                            {t.id}
                          </button>
                        ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!devices.length && <p class="admin-empty">暂无已绑定设备</p>}
          </div>
        </section>
      )}
      {section === "devices" && addingDevice && (
        <Modal
          title="添加 Android 设备"
          close={() => {
            setAddingDevice(false);
            setDeviceKey("");
          }}
        >
          {deviceKey ? (
            <>
              <p>在 aBridge App 填写服务器地址和 Device Key，然后点击「绑定设备」。请保存凭证。</p>
              <label class="field">
                <span>服务器地址</span>
                <input readOnly value={location.origin} />
              </label>
              <label class="field">
                <span>Device Key</span>
                <input readOnly value={deviceKey} onFocus={(event) => event.currentTarget.select()} />
              </label>
            </>
          ) : (
            <Form
              label="生成 Device Key"
              onSubmit={async (data) => {
                const result = await api(
                  "/api/admin/devices",
                  z.object({ id: z.string(), key: z.string() }),
                  {
                    owner_id: data.get("owner_id"),
                    name: data.get("name"),
                  },
                );
                setDeviceKey(result.key);
                void refresh();
              }}
            >
              <Field name="name" label="设备名称" />
              <label class="field">
                <span>设备所有人</span>
                <Select name="owner_id" required>
                  {(overview?.users ?? []).map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.username}
                    </option>
                  ))}
                </Select>
              </label>
            </Form>
          )}
        </Modal>
      )}
      {section === "audit" && (
        <section class="surface">
          <div class="instance-list-heading">
            <h2>任务审计</h2>
            <span class="muted small">确认、停止和调度变更</span>
          </div>
          <div class="table-wrap">
            <table class="record-list admin-table">
              <thead>
                <tr>
                  {["时间", "操作者", "动作", "任务", "结果"].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {audit.map((a) => (
                  <tr key={a.id}>
                    <td>{dateTime(a.created_at)}</td>
                    <td>{a.actor_id ? person(a.actor_id) : "系统"}</td>
                    <td>{a.action}</td>
                    <td>
                      <button class="text-button" onClick={() => setSelected(a.task_id)}>
                        {a.task_id}
                      </button>
                    </td>
                    <td>{a.outcome}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!audit.length && <p class="admin-empty">暂无审计记录</p>}
          </div>
        </section>
      )}
      {selected && (
        <TaskDetail
          key={selected}
          id={selected}
          tasks={tasks}
          person={person}
          device={device}
          close={() => setSelected(null)}
          changed={refresh}
          notify={notify}
        />
      )}
    </>
  );
}
function TaskDetail({
  id,
  tasks,
  person,
  device,
  close,
  changed,
  notify,
}: {
  id: string;
  tasks: TaskView[];
  person: (id: string) => string;
  device: (id: string) => string;
  close: () => void;
  changed: () => Promise<void>;
  notify: (message: string) => void;
}) {
  const base = "/api/admin/tasks";
  const [task, setTask] = useState<TaskView | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [visible, setVisible] = useState(true);
  const refresh = useCallback(async () => {
    const detail = await api(`${base}/${encodeURIComponent(id)}`, taskDetailSchema);
    return detail;
  }, [id, base]);
  useEffect(() => {
    let alive = true;
    const load = () => {
      void refresh()
        .then((d) => {
          if (alive) {
            setVisible(d.details_visible);
            setTask(d.task);
            setEvents(d.events);
            setError("");
          }
        })
        .catch((e) => {
          if (alive) setError(e instanceof Error ? e.message : "读取任务失败");
        });
    };
    load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [refresh]);
  const stop = async () => {
    const detail = await api(
      `${base}/${encodeURIComponent(id)}/stop`,
      taskDetailSchema.pick({ task: true }),
      {},
    );
    setTask(detail.task);
    setConfirm(false);
    notify("停止请求已提交；清理结束后队列才能接续。");
    await changed();
  };
  return (
    <Modal title="任务详情" close={close} className="admin-detail">
      <span class="muted small">{id}</span>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      {!task && !error && <p role="status">正在读取任务…</p>}
      {task && (
        <>
          <div class="admin-detail-title">
            <h2>{task.prompt || "设备协助任务"}</h2>
            <Status status={task.status} />
          </div>
          <dl class="admin-detail-grid">
            <div>
              <dt>发起人</dt>
              <dd>{person(task.actor_id)}</dd>
            </div>
            <div>
              <dt>接收人</dt>
              <dd>{person(task.recipient_id)}</dd>
            </div>
            <div>
              <dt>执行设备</dt>
              <dd>{device(task.device_id)}</dd>
            </div>
            <div>
              <dt>提交时间</dt>
              <dd>{dateTime(task.created_at)}</dd>
            </div>
          </dl>
          <h3>接收人的队列</h3>
          <p class="muted small">同一接收人的设备共用队列；待确认任务尚未入队。</p>
          {tasks
            .filter(
              (t) =>
                t.recipient_id === task.recipient_id &&
                (activeStates.includes(t.status) || t.status === "queued"),
            )
            .sort((a, b) => (a.queue_position ?? 0) - (b.queue_position ?? 0))
            .map((t) => (
              <div class="admin-queue-row" key={t.id}>
                <span>{t.id}</span>
                <Status status={t.status} />
                {t.queue_position !== null && <span>第 {t.queue_position} 位</span>}
              </div>
            ))}
          {task.queue_blocked && <p class="status-banner">正在等待设备确认清理</p>}
          <h3>执行步骤</h3>
          {!events.length && <p class="muted">{visible ? "暂无执行记录" : "执行内容仅任务参与者可见。"}</p>}
          {executionSteps(events).map((e, index) => (
            <details class="admin-step" key={e.sequence}>
              <summary>
                <strong>
                  {index + 1}. {e.tool || (e.status === "decision" ? "决策摘要" : "执行进度")}
                </strong>
                <span>{e.status}</span>
              </summary>
              {e.summary && (
                <p>
                  <strong>决策摘要</strong>
                  <br />
                  {e.summary}
                </p>
              )}
              {e.tool && (
                <p>
                  <strong>工具</strong>
                  <br />
                  <code>{e.tool}</code>
                </p>
              )}
              {e.arguments && (
                <div>
                  <strong>工具参数</strong>
                  <pre>{e.arguments}</pre>
                </div>
              )}
              {e.receipt && (
                <div>
                  <strong>执行结果</strong>
                  <pre>{typeof e.receipt === "string" ? e.receipt : JSON.stringify(e.receipt, null, 2)}</pre>
                </div>
              )}
              {e.image && <img class="admin-step-image" src={e.image} alt={`第 ${e.sequence} 步执行截图`} />}
              <small class="muted">{dateTime(e.created_at)}</small>
            </details>
          ))}
          {task.result && (
            <p>
              <strong>任务结果</strong>
              <br />
              {task.result}
            </p>
          )}
          {task.error && <p class="error">{task.error}</p>}
          {task.status === "stopping" && <p class="status-banner">等待设备清理确认。后续任务继续排队。</p>}
          {((activeStates.includes(task.status) && task.status !== "stopping") ||
            ["queued", "approval"].includes(task.status)) &&
            (confirm ? (
              <Form label="确认停止" tone="danger" cancel={() => setConfirm(false)} onSubmit={stop}>
                <p>停止「{task.id}」？已开始的操作将请求取消，队列等待清理回执后接续。</p>
              </Form>
            ) : (
              <button class="danger" onClick={() => setConfirm(true)}>
                停止任务
              </button>
            ))}
        </>
      )}
    </Modal>
  );
}
