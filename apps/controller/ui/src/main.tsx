import { requestId } from "./webview-compat";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Conversation, ConversationList, Message, MessageList } from "@chatscope/chat-ui-kit-react";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  ListTodo,
  LogOut,
  MessageCircle,
  Mic,
  RefreshCw,
  Send,
  Smartphone,
  Square,
  Users,
  X,
} from "lucide-react";
import {
  devicesListSchema,
  groupsListSchema,
  groupViewSchema,
  groupInviteIssuedSchema,
  managementUserSchema,
  taskDetailSchema,
  taskListSchema,
  controllerChatSchema,
  controllerMessageSchema,
  type DeviceView,
  type GroupView,
  type TaskView,
  type TaskEvent,
} from "@abridge/protocol";
import "@chatscope/chat-ui-kit-styles/dist/default/styles.min.css";
import "./style.css";
import { executionSteps } from "./trace";
import QRCode from "qrcode";
import jsQR from "jsqr";

type ChatMessage = ReturnType<typeof controllerMessageSchema.parse>;
type User = ReturnType<typeof managementUserSchema.parse>;
type Page = "chat" | "tasks" | "groups";
declare global {
  interface Window {
    aBridgeController?: { startVoiceInput(): void; cancelVoiceInput(): void };
  }
}
const active = new Set(["approval", "queued", "running", "waiting", "stopping"]);
const labels: Record<string, string> = {
  approval: "待接收人批准",
  queued: "排队中",
  running: "执行中",
  waiting: "等待设备",
  stopping: "正在停止",
  done: "已完成",
  rejected: "已拒绝",
  cancelled: "已取消",
  stopped: "已停止",
  failed: "执行失败",
  unknown: "结果待核实",
};
class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
async function request(path: string, body?: unknown, method = "POST"): Promise<unknown> {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    ...(body === undefined
      ? {}
      : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const value: unknown = await response.json();
  if (!response.ok) {
    const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const nested =
      record.error && typeof record.error === "object" ? (record.error as Record<string, unknown>) : {};
    throw new ApiError(
      String(
        record.message ??
          nested.message ??
          (response.status === 401 ? "登录已过期，请重新登录" : `请求失败（${response.status}）`),
      ),
      response.status,
    );
  }
  return value;
}
const time = (n: number) =>
  new Date(n * 1000).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
function App() {
  const [user, setUser] = useState<User | null>(null),
    [loading, setLoading] = useState(true);
  const [page, setPage] = useState<Page>("chat"),
    [error, setError] = useState("");
  const [busy, setBusy] = useState(false),
    [text, setText] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]),
    [devices, setDevices] = useState<DeviceView[]>([]),
    [tasks, setTasks] = useState<TaskView[]>([]),
    [groups, setGroups] = useState<GroupView[]>([]);
  const [selectedTask, setSelectedTask] = useState<string | null>(null),
    [detail, setDetail] = useState<{ task: TaskView; events: TaskEvent[] } | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const sessionVersion = useRef(0);
  const loadedOlder = useRef(false);
  const [voice, setVoice] = useState("idle"),
    [notice, setNotice] = useState("");
  const submitting = useRef(false),
    retryRequest = useRef<{ text: string; id: string } | null>(null);
  const clearAccount = useCallback(() => {
    sessionVersion.current++;
    loadedOlder.current = false;
    retryRequest.current = null;
    window.aBridgeController?.cancelVoiceInput();
    setMessages([]);
    setTasks([]);
    setGroups([]);
    setDevices([]);
    setText("");
    setSelectedTask(null);
    setDetail(null);
    setHasMore(false);
    setVoice("idle");
    setNotice("");
    setUser(null);
  }, []);
  const refresh = useCallback(async () => {
    const version = sessionVersion.current;
    const [chat, deviceList, taskList, groupList] = await Promise.all([
      request("/api/controller/chat"),
      request("/api/devices"),
      request("/api/tasks"),
      request("/api/groups"),
    ]);
    if (version !== sessionVersion.current) return;
    const parsed = controllerChatSchema.parse(chat);
    if (!loadedOlder.current) setHasMore(parsed.has_more);
    setMessages((previous) =>
      [...new Map([...previous, ...parsed.messages].map((message) => [message.id, message])).values()].sort(
        (a, b) => a.created_at - b.created_at,
      ),
    );
    setDevices(devicesListSchema.parse(deviceList).devices);
    setTasks(taskListSchema.parse(taskList).tasks);
    setGroups(groupsListSchema.parse(groupList).groups);
  }, []);
  useEffect(() => {
    let alive = true;
    void request("/api/me")
      .then((value) => {
        if (alive) setUser(managementUserSchema.parse(value));
      })
      .catch((e) => {
        if (alive && !(e instanceof ApiError && e.status === 401)) setError(String(e.message));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!user) return;
    let alive = true,
      pending = false;
    const poll = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try {
        await refresh();
        if (selectedTask) {
          const result = taskDetailSchema.parse(
            await request(`/api/tasks/${encodeURIComponent(selectedTask)}`),
          );
          if (alive) setDetail(result);
        }
      } catch (e) {
        if (alive) {
          setError(e instanceof Error ? e.message : "刷新失败");
          if (e instanceof ApiError && e.status === 401) clearAccount();
        }
      } finally {
        pending = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 4000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [user, refresh, selectedTask, clearAccount]);
  useEffect(() => {
    const result = (event: Event) => {
      const value = (event as CustomEvent<{ text: string }>).detail;
      if (typeof value?.text === "string") {
        setText((old) => (old ? `${old}\n${value.text}` : value.text));
        setNotice("语音已转为文字，编辑后发送。");
      }
      setVoice("idle");
    };
    const failed = (event: Event) => {
      setVoice("idle");
      setError((event as CustomEvent<{ message: string }>).detail?.message || "语音识别失败，请输入文字。");
    };
    const state = (event: Event) =>
      setVoice((event as CustomEvent<{ state: string }>).detail?.state ?? "idle");
    window.addEventListener("abridge:voice-result", result);
    window.addEventListener("abridge:voice-error", failed);
    window.addEventListener("abridge:voice-state", state);
    return () => {
      window.removeEventListener("abridge:voice-result", result);
      window.removeEventListener("abridge:voice-error", failed);
      window.removeEventListener("abridge:voice-state", state);
    };
  }, []);
  async function perform(action: () => Promise<void>) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败，请重试");
      if (e instanceof ApiError && e.status === 401) clearAccount();
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  async function send() {
    const value = text.trim();
    if (!value || busy) return;
    await perform(async () => {
      if (retryRequest.current?.text !== value) retryRequest.current = { text: value, id: requestId() };
      await request("/api/controller/chat", { request_id: retryRequest.current.id, text: value });
      retryRequest.current = null;
      setText("");
      await refresh();
    });
  }
  const openTask = (id: string) => {
    setDetail(null);
    setSelectedTask(id);
    setPage("tasks");
  };
  const taskAction = (id: string, action: "stop" | "approve" | "reject") =>
    perform(async () => {
      await request(
        `/api/tasks/${encodeURIComponent(id)}/${action === "stop" ? "stop" : "decision"}`,
        action === "stop" ? {} : { approve: action === "approve" },
      );
      await refresh();
      if (selectedTask === id)
        setDetail(taskDetailSchema.parse(await request(`/api/tasks/${encodeURIComponent(id)}`)));
    });
  if (loading)
    return (
      <main className="login">
        <p role="status">正在连接 AI 家…</p>
      </main>
    );
  if (!user)
    return (
      <main className="login">
        <div className="brand">
          AI 家 <span>AI Home</span>
        </div>
        <h1>登录你的账户</h1>
        <p className="muted">连接真实设备，提交和管理任务。</p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void perform(async () => {
              setUser(
                managementUserSchema.parse(
                  await request("/api/login", {
                    username: form.get("username"),
                    password: form.get("password"),
                  }),
                ),
              );
            });
          }}
        >
          <label>
            用户名
            <input name="username" autoComplete="username" required maxLength={120} />
          </label>
          <label>
            密码
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          <button className="primary" disabled={busy}>
            登录
          </button>
        </form>
      </main>
    );
  return (
    <div className="app">
      <header>
        <div>
          <span className="brand">AI 家</span>
          <span className="header-title">
            {page === "chat" ? "Chat" : page === "tasks" ? "任务" : "小组"}
          </span>
        </div>
        <div className="header-actions">
          <span className="username">{user.username}</span>
          <button className="icon" aria-label="刷新" disabled={busy} onClick={() => void perform(refresh)}>
            <RefreshCw size={18} />
          </button>
          <button
            className="icon"
            aria-label="退出登录"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                await request("/api/logout", {});
                clearAccount();
              })
            }
          >
            <LogOut size={18} />
          </button>
        </div>
      </header>
      {error && (
        <div className="error banner" role="alert">
          {error}
          <button aria-label="关闭错误" className="icon" onClick={() => setError("")}>
            <X size={16} />
          </button>
        </div>
      )}
      {page === "chat" && (
        <>
          <section className="chat" aria-label="聊天记录">
            <MessageList>
              <MessageList.Content>
                {hasMore && (
                  <div className="history-more">
                    <button
                      disabled={busy}
                      onClick={() =>
                        void perform(async () => {
                          const parsed = controllerChatSchema.parse(
                            await request(
                              `/api/controller/chat?before=${encodeURIComponent(messages[0].id)}`,
                            ),
                          );
                          loadedOlder.current = true;
                          setHasMore(parsed.has_more);
                          setMessages((previous) => [
                            ...new Map(
                              [...parsed.messages, ...previous].map((message) => [message.id, message]),
                            ).values(),
                          ]);
                        })
                      }
                    >
                      加载更早的记录
                    </button>
                  </div>
                )}
                {messages.length === 0 && (
                  <Message model={{ direction: "incoming", position: "single" }}>
                    <Message.CustomContent>
                      <strong>想让设备做什么？</strong>
                      <p>说出或输入任务，选择目标设备，确认后才会提交执行。</p>
                    </Message.CustomContent>
                  </Message>
                )}
                {messages.map((message) => (
                  <React.Fragment key={message.id}>
                    <Message model={{ direction: "outgoing", position: "single" }}>
                      <Message.CustomContent>
                        <div className="message-text">{message.text}</div>
                        <small>{time(message.created_at)}</small>
                      </Message.CustomContent>
                    </Message>
                    <Message model={{ direction: "incoming", position: "single" }}>
                      <Message.CustomContent>
                        {message.status === "draft" ? (
                          <Draft
                            message={message}
                            user={user}
                            devices={devices}
                            groups={groups}
                            busy={busy}
                            save={(recipient_id, device_id) =>
                              perform(async () => {
                                await request(
                                  `/api/controller/chat/${message.id}`,
                                  { recipient_id, device_id },
                                  "PATCH",
                                );
                                await refresh();
                              })
                            }
                            confirm={() =>
                              perform(async () => {
                                await request(`/api/controller/chat/${message.id}/confirm`, {});
                                await refresh();
                              })
                            }
                            cancel={() =>
                              perform(async () => {
                                await request(`/api/controller/chat/${message.id}/cancel`, {});
                                await refresh();
                              })
                            }
                          />
                        ) : message.status === "cancelled" ? (
                          <span className="muted">已取消，未执行。</span>
                        ) : (
                          <>
                            <strong>任务已提交</strong>
                            <p>
                              {labels[tasks.find((t) => t.id === message.task_id)?.status ?? ""] ??
                                "正在读取状态"}
                            </p>
                            {message.task_id && (
                              <button onClick={() => openTask(message.task_id!)}>
                                查看任务 <ChevronRight size={14} />
                              </button>
                            )}
                          </>
                        )}
                      </Message.CustomContent>
                    </Message>
                  </React.Fragment>
                ))}
              </MessageList.Content>
            </MessageList>
          </section>
          <section className="composer">
            <p className="composer-hint" role="status">
              {voice === "listening"
                ? "正在聆听…"
                : voice === "processing"
                  ? "正在识别…"
                  : notice || "先编辑任务，再确认执行"}
            </p>
            <div className="compose-row">
              <button
                className={`voice icon ${voice !== "idle" ? "recording" : ""}`}
                aria-label={voice === "idle" ? "语音输入" : "取消语音输入"}
                onClick={() => {
                  if (!window.aBridgeController) {
                    setNotice("语音输入需要 Android 控制端，请在下方输入文字。");
                    return;
                  }
                  if (voice !== "idle") {
                    window.aBridgeController.cancelVoiceInput();
                    setVoice("idle");
                  } else {
                    setError("");
                    window.aBridgeController.startVoiceInput();
                  }
                }}
              >
                {voice === "idle" ? <Mic size={22} /> : <Square size={20} />}
              </button>
              <textarea
                aria-label="任务内容"
                value={text}
                maxLength={4000}
                rows={2}
                placeholder="输入你想让设备完成的任务…"
                onChange={(event) => setText(event.target.value)}
              />
              <button
                className="icon send"
                aria-label="发送任务草稿"
                disabled={busy || !text.trim()}
                onClick={() => void send()}
              >
                <Send size={20} />
              </button>
            </div>
          </section>
        </>
      )}
      {page === "tasks" && (
        <section className="scroll-page">
          {selectedTask ? (
            <>
              <button
                className="back"
                onClick={() => {
                  setSelectedTask(null);
                  setDetail(null);
                }}
              >
                <ArrowLeft size={16} />
                全部任务
              </button>
              {!detail ? (
                <p role="status">正在读取任务详情…</p>
              ) : (
                <>
                  <div className="card">
                    <div className="eyebrow">{labels[detail.task.status]}</div>
                    <h2>{detail.task.prompt ?? "任务内容不可见"}</h2>
                    <p className="muted">
                      {time(detail.task.created_at)} ·{" "}
                      {devices.find((d) => d.id === detail.task.device_id)?.name ?? detail.task.device_id}
                    </p>
                    <code>{detail.task.id}</code>
                    {detail.task.queue_position && <p>队列位置：{detail.task.queue_position}</p>}
                    {detail.task.queue_blocked && <p className="error">队列被阻塞，等待设备清理确认。</p>}
                    <TaskActions task={detail.task} user={user} busy={busy} action={taskAction} />
                  </div>
                  {executionSteps(detail.events).map((event) => (
                    <details className="event" key={event.sequence}>
                      <summary>
                        <span className="event-dot" />
                        <strong>{event.tool ?? event.status}</strong>
                        <small>
                          {time(event.created_at)} · {event.status}
                        </small>
                      </summary>
                      <div>
                        {event.summary && <p>{event.summary}</p>}
                        {event.arguments && (
                          <>
                            <h3>工具参数</h3>
                            <pre>{event.arguments}</pre>
                          </>
                        )}
                        {event.receipt && (
                          <>
                            <h3>执行回执</h3>
                            <pre>{event.receipt}</pre>
                          </>
                        )}
                        {event.image && (
                          <img src={event.image} alt={`步骤 ${event.sequence} 的设备截图`} loading="lazy" />
                        )}
                      </div>
                    </details>
                  ))}
                  {detail.task.result && (
                    <div className="card">
                      <h3>执行结果</h3>
                      <p className="message-text">{detail.task.result}</p>
                    </div>
                  )}
                  {detail.task.error && <div className="card error">{detail.task.error}</div>}
                  {!detail.events.length && <p className="muted">暂无执行记录。等待真实执行端回传。</p>}
                </>
              )}
            </>
          ) : (
            <>
              <div className="section-heading">
                <h1>全部任务</h1>
                <span className="muted">{tasks.length} 项</span>
              </div>
              {!tasks.length ? (
                <p className="empty">暂无任务。在 Chat 中输入并确认第一个任务。</p>
              ) : (
                <ConversationList>
                  {tasks.map((task) => (
                    <Conversation
                      key={task.id}
                      name={task.prompt ?? "任务"}
                      info={`${labels[task.status]} · ${time(task.created_at)}`}
                      onClick={() => openTask(task.id)}
                    >
                      <Conversation.Content>
                        <div className="task-row">
                          <div>
                            <strong>{task.prompt ?? "任务"}</strong>
                            <small>
                              {devices.find((d) => d.id === task.device_id)?.name ?? task.device_id} ·{" "}
                              {time(task.created_at)}
                            </small>
                          </div>
                          <span className={`badge ${task.status}`}>{labels[task.status]}</span>
                        </div>
                      </Conversation.Content>
                    </Conversation>
                  ))}
                </ConversationList>
              )}
            </>
          )}
        </section>
      )}
      {page === "groups" && (
        <Groups groups={groups} user={user} busy={busy} perform={perform} refresh={refresh} />
      )}
      <nav aria-label="主导航">
        {(
          [
            { id: "chat", label: "Chat", Icon: MessageCircle },
            { id: "tasks", label: "任务", Icon: ListTodo },
            { id: "groups", label: "小组", Icon: Users },
          ] as const
        ).map(({ id, label, Icon }) => (
          <button
            key={id}
            aria-current={page === id ? "page" : undefined}
            className={page === id ? "selected" : ""}
            onClick={() => {
              setPage(id);
              if (id !== "tasks") {
                setSelectedTask(null);
                setDetail(null);
              }
            }}
          >
            <Icon size={21} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
function Draft({
  message,
  user,
  devices,
  groups,
  busy,
  save,
  confirm,
  cancel,
}: {
  message: ChatMessage;
  user: User;
  devices: DeviceView[];
  groups: GroupView[];
  busy: boolean;
  save: (recipient: string, device: string) => Promise<void>;
  confirm: () => Promise<void>;
  cancel: () => Promise<void>;
}) {
  const [recipient, setRecipient] = useState(message.recipient_id ?? user.id),
    [device, setDevice] = useState(message.device_id ?? "");
  useEffect(() => {
    setRecipient(message.recipient_id ?? user.id);
    setDevice(message.device_id ?? "");
  }, [message.recipient_id, message.device_id, user.id]);
  const members = [
    ...new Map(groups.flatMap((group) => group.members).map((member) => [member.id, member])).values(),
  ].filter((member) => member.id !== user.id);
  const own = recipient === user.id,
    selected = devices.find((d) => d.id === device);
  const changed = recipient !== message.recipient_id || device !== message.device_id;
  return (
    <div className="draft">
      <div className="eyebrow">
        <Smartphone size={15} />
        确认任务
      </div>
      <p className="muted">选择目标并保存，确认后将提交到真实执行队列。</p>
      <label>
        接收人
        <select
          value={recipient}
          disabled={busy}
          onChange={(event) => {
            setRecipient(event.target.value);
            setDevice("");
          }}
        >
          <option value={user.id}>我自己</option>
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.username}
            </option>
          ))}
        </select>
      </label>
      {own ? (
        <label>
          执行设备
          <select value={device} disabled={busy} onChange={(event) => setDevice(event.target.value)}>
            <option value="">选择 Android 设备</option>
            {devices
              .filter((d) => d.platform === "android" && d.status !== "revoked")
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} · {d.status === "online" ? (d.paused ? "已暂停" : "在线") : "离线"}
                </option>
              ))}
          </select>
        </label>
      ) : (
        <label>
          接收人的设备 ID
          <input
            value={device}
            disabled={busy}
            onChange={(event) => setDevice(event.target.value)}
            placeholder="请输入接收人提供的设备 ID"
            maxLength={128}
          />
        </label>
      )}
      {selected && selected.status !== "online" && (
        <p className="muted">设备当前离线，任务需要等待设备恢复连接。</p>
      )}
      {!own && <p className="muted">小组成员关系不授予设备操作权限；对方批准后才会排队执行。</p>}
      <div className="actions">
        {changed ? (
          <button
            className="primary"
            disabled={busy || !recipient || !device.trim()}
            onClick={() => void save(recipient, device.trim())}
          >
            <Check size={15} />
            保存目标
          </button>
        ) : (
          <button
            className="primary"
            disabled={busy || !message.device_id || !message.recipient_id}
            onClick={() => void confirm()}
          >
            <Check size={15} />
            确认执行
          </button>
        )}
        <button disabled={busy} onClick={() => void cancel()}>
          取消
        </button>
      </div>
    </div>
  );
}
function TaskActions({
  task,
  user,
  busy,
  action,
}: {
  task: TaskView;
  user: User;
  busy: boolean;
  action: (id: string, action: "approve" | "reject" | "stop") => Promise<void>;
}) {
  return (
    <div className="actions">
      {task.status === "approval" && task.recipient_id === user.id && (
        <>
          <button className="primary" disabled={busy} onClick={() => void action(task.id, "approve")}>
            批准执行
          </button>
          <button disabled={busy} onClick={() => void action(task.id, "reject")}>
            拒绝
          </button>
        </>
      )}
      {active.has(task.status) && task.status !== "stopping" && (
        <button className="danger" disabled={busy} onClick={() => void action(task.id, "stop")}>
          <Square size={14} />
          停止任务
        </button>
      )}
    </div>
  );
}
function Groups({
  groups,
  user,
  busy,
  perform,
  refresh,
}: {
  groups: GroupView[];
  user: User;
  busy: boolean;
  perform: (action: () => Promise<void>) => Promise<void>;
  refresh: () => Promise<void>;
}) {
  const [issued, setIssued] = useState<{ group: string; code: string; expires: number } | null>(null);
  const [qrImage, setQrImage] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  useEffect(() => {
    let alive = true;
    setQrImage("");
    if (issued)
      void QRCode.toDataURL(issued.code, { width: 220, margin: 2 }).then((image) => {
        if (alive) setQrImage(image);
      });
    return () => {
      alive = false;
    };
  }, [issued]);
  const readQr = (file?: File) =>
    perform(async () => {
      if (!file) return;
      if (file.size > 15_000_000) throw Error("图片过大，请选择小于 15 MB 的二维码图片");
      const image = await createImageBitmap(file);
      try {
        const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw Error("无法读取图片，请手动输入邀请码");
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const data = context.getImageData(0, 0, canvas.width, canvas.height);
        const decoded = jsQR(data.data, data.width, data.height);
        if (!decoded?.data || decoded.data.length > 128) throw Error("未找到有效的邀请码二维码，请手动输入");
        setInviteCode(decoded.data);
      } finally {
        image.close();
      }
    });
  return (
    <section className="scroll-page">
      <h1>我的小组</h1>
      <form
        className="card"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget,
            values = new FormData(form);
          void perform(async () => {
            groupViewSchema.parse(await request("/api/groups/join", { code: values.get("code") }));
            setInviteCode("");
            form.reset();
            await refresh();
          });
        }}
      >
        <label>
          使用邀请码加入
          <input
            name="code"
            value={inviteCode}
            onChange={(event) => setInviteCode(event.target.value)}
            placeholder="粘贴接收人的入组邀请码"
            required
            maxLength={128}
          />
        </label>
        <div className="actions">
          <button disabled={busy}>加入小组</button>
          <label className="file-button">
            识别二维码图片
            <input
              type="file"
              accept="image/*"
              disabled={busy}
              onChange={(event) => {
                void readQr(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
          </label>
        </div>
        <small>识别后会填入邀请码，请核对后加入。</small>
      </form>
      {groups.map((group) => (
        <article className="card" key={group.id}>
          <div className="section-heading">
            <h2>{group.name}</h2>
            <span className="badge">{group.members.length} 人</span>
          </div>
          {group.members.map((member) => (
            <div className="member" key={member.id}>
              <span className="avatar">{member.username.slice(0, 1)}</span>
              <div>
                <strong>{member.username}</strong>
                <small>
                  {member.role === "owner" ? "组长" : "成员"}
                  {member.id === user.id ? " · 我" : ""}
                </small>
                <code>{member.id}</code>
              </div>
            </div>
          ))}
          {group.owner_id === user.id && (
            <button
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const result = groupInviteIssuedSchema.parse(
                    await request(`/api/groups/${group.id}/invites`, {}),
                  );
                  setIssued({ group: group.id, code: result.code, expires: result.invite.expires_at });
                })
              }
            >
              生成入组邀请
            </button>
          )}
          {issued?.group === group.id && (
            <div className="invitation">
              <p>邀请码（仅生成时显示）</p>
              {qrImage && <img className="qr-image" src={qrImage} alt="入组邀请码二维码" />}
              <code>{issued.code}</code>
              <small>有效至 {time(issued.expires)}</small>
              <button
                onClick={() =>
                  void perform(async () => {
                    await navigator.clipboard.writeText(issued.code);
                  })
                }
              >
                复制邀请码
              </button>
            </div>
          )}
        </article>
      ))}
      {!groups.length && <p className="empty">尚未加入小组。使用邀请码加入，或创建一个小组。</p>}
      <form
        className="card"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget,
            values = new FormData(form);
          void perform(async () => {
            groupViewSchema.parse(await request("/api/groups", { name: values.get("name") }));
            form.reset();
            await refresh();
          });
        }}
      >
        <label>
          创建小组
          <input name="name" placeholder="小组名称" required maxLength={120} />
        </label>
        <button disabled={busy}>创建小组</button>
      </form>
    </section>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
