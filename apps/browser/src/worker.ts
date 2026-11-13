import { BrowserBridge } from "./bridge.js";
import {
  PROTOCOL_VERSION,
  CONNECTION_LEASE_SECONDS,
  OPERATION_START_SECONDS,
  deviceDispatchEnvelopeSchema,
  browserHelloSchema,
  deviceWelcomeSchema,
  HEARTBEAT_SECONDS,
  OPERATION_JOURNAL_LIMIT,
  OPERATION_START_GRACE_SECONDS,
  type DeviceDispatchEnvelope,
} from "@abridge/protocol";
import { z } from "zod";
import {
  fail,
  errorDetails,
  type BrowserProfile,
  type BridgeError,
  type ConnectionHistory,
  uiMessageSchema,
} from "./types.js";
interface JournalEntry {
  status: string;
  request_hash: string;
}
let bridge: BrowserBridge;
let socket: WebSocket | undefined;
let profile: BrowserProfile = {};
let connecting: Promise<void> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let authenticated = false;
let epoch: number | undefined;
let lastAck = 0;
let leaseSeconds = CONNECTION_LEASE_SECONDS;
let sequence = 0;
let generation = 0;
let configuration: Promise<unknown> = Promise.resolve();
let cleanup: Promise<void> = Promise.resolve();
let cleanupError: BridgeError | undefined;
let journal: Record<string, JournalEntry> = {};
let connectionHistory: ConnectionHistory = {};
let closed = new Set<string>();
const active = new Map<string, string>();
const cancelledOperations = new Set<string>();
const executingOperations = new Map<string, string>();
const incomingSchema = z
  .object({
    type: z.string(),
    connection_epoch: z.number().int().optional(),
    session_id: z.string().optional(),
    operation_ids: z.array(z.string()).optional(),
  })
  .passthrough();
const registrationSchema = z.object({ key: z.string(), device_id: z.string() });
const registrationErrorSchema = z.object({
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).optional(),
  detail: z.string().optional(),
});
const storedLocalSchema = z.object({
  device: z
    .object({
      key: z.string().optional(),
      revoked: z.boolean().optional(),
      paused: z.boolean().optional(),
      instance_id: z.string().optional(),
      server: z.string().optional(),
      device_id: z.string().optional(),
      label: z.string().optional(),
    })
    .optional(),
  operation_journal: z
    .record(z.string(), z.object({ status: z.string(), request_hash: z.string() }))
    .optional(),
  connection_history: z
    .object({
      worker_started_at: z.number().optional(),
      last_connected_at: z.number().optional(),
      last_ack_at: z.number().optional(),
      last_recovery_at: z.number().optional(),
      last_disconnected_at: z.number().optional(),
      last_close_code: z.number().optional(),
      last_disconnect_reason: z.string().optional(),
    })
    .optional(),
});
const storedSessionSchema = z.object({
  owned_task_tabs: z.array(z.number().int()).optional(),
  closed_sessions: z.array(z.string()).optional(),
});
const RECOVERY_ALARM = "abridge-connection-recovery";
const notify = () => chrome.runtime.sendMessage({ type: "status_changed" }).catch(() => {});
export function serverURL(value: string) {
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw fail("invalid_server", "请填写完整的 Server 地址");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw fail("invalid_server", "请使用 HTTPS，或本机 HTTP 地址");
  return url.href.replace(/\/$/, "");
}
function send(connection: WebSocket | undefined, message: object) {
  if (!connection || connection !== socket || connection.readyState !== WebSocket.OPEN)
    throw fail("disconnected", "Server 已断开");
  connection.send(JSON.stringify(message));
}
function recordConnection(change: Partial<ConnectionHistory>) {
  Object.assign(connectionHistory, change);
  void chrome.storage.local.set({ connection_history: { ...connectionHistory } }).catch(() => {});
}
async function syncRecoveryAlarm() {
  if (!profile?.key || profile.revoked) {
    await chrome.alarms.clear(RECOVERY_ALARM);
    return;
  }
  // Browser-managed events can revive a terminated MV3 worker; JS timers cannot.
  // One minute also works on Chrome 116–119, before 30-second alarms existed.
  if (!(await chrome.alarms.get(RECOVERY_ALARM)))
    await chrome.alarms.create(RECOVERY_ALARM, { periodInMinutes: 1 });
}
async function saveJournal() {
  await chrome.storage.local.set({ operation_journal: journal });
}
function scheduleReconnect() {
  clearTimeout(timer);
  if (profile?.key && !profile.revoked && !cleanupError)
    timer = setTimeout(() => {
      void connect().catch(() => {});
    }, 2000);
}
function result(
  connection: WebSocket,
  operationId: string,
  status: string,
  value: object = {},
  error?: { code?: string; message: string },
) {
  try {
    send(connection, {
      type: "result",
      connection_epoch: epoch,
      operation_id: operationId,
      status,
      result: value,
      ...(error ? { error: { code: error.code || "browser_error", message: error.message } } : {}),
    });
  } catch {}
}
async function stop(sessionId?: string) {
  if (sessionId) {
    closed.add(sessionId);
    await chrome.storage.session.set({ closed_sessions: [...closed] });
    await bridge.close(sessionId);
  } else {
    generation++;
    for (const id of bridge.sessions.keys()) closed.add(id);
    await chrome.storage.session.set({ closed_sessions: [...closed] });
    await bridge.stop();
  }
}
async function cancelOperation(id: string): Promise<void> {
  const sessionId = active.get(id);
  if (!sessionId) return;
  cancelledOperations.add(id);
  // Discard only the task page owned by this executing operation. The control
  // session remains usable; a caller must observe/open again after an unknown result.
  if (executingOperations.get(sessionId) === id) await bridge.close(sessionId);
}
async function dispatch(connection: WebSocket, message: DeviceDispatchEnvelope) {
  const id = message.operation_id,
    startedGeneration = generation;
  let tracked = false,
    intentWritten = false;
  try {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(id))
      throw fail("invalid_operation", "操作标识无效");
    if (
      !authenticated ||
      profile.paused ||
      profile.revoked ||
      connection.readyState !== WebSocket.OPEN ||
      Date.now() - lastAck >= leaseSeconds * 1000 ||
      message.protocol !== PROTOCOL_VERSION ||
      message.device_id !== profile.device_id ||
      message.connection_epoch !== epoch
    )
      throw fail("connection_mismatch", "操作与当前设备连接不匹配，或已暂停");
    if (!(
      message.expires_at > Date.now() / 1000 &&
      message.expires_at <= Date.now() / 1000 + OPERATION_START_SECONDS + OPERATION_START_GRACE_SECONDS
    ))
      throw fail("operation_expired", "操作开始期限已过");
    if (!Number.isInteger(message.sequence) || message.sequence <= sequence)
      throw fail("stale_operation", "操作序号已失效");
    sequence = message.sequence;
    if (
      !["browser_open", "browser_observe", "browser_act"].includes(message.tool) ||
      !message.arguments ||
      typeof message.arguments !== "object" ||
      Array.isArray(message.arguments)
    )
      throw fail("unsupported_tool", "浏览器设备仅支持浏览器工具");
    if (
      !Array.isArray(message.session_capabilities) ||
      message.session_capabilities.length !== 1 ||
      message.session_capabilities[0] !== "browser"
    )
      throw fail("invalid_session", "浏览器会话能力无效");
    if (
      typeof message.session_id !== "string" ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(message.session_id) ||
      closed.has(message.session_id)
    )
      throw fail("session_closed", "任务会话无效或已结束");
    if (active.has(id)) throw fail("duplicate_request", "操作正在处理，不会重放");
    active.set(id, message.session_id);
    tracked = true;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify([message.tool, message.arguments, message.session_id])),
    );
    const requestHash = [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    if (journal[id]) {
      if (journal[id].request_hash !== requestHash)
        throw fail("operation_conflict", "相同操作标识的参数不能改变");
      result(connection, id, journal[id].status === "executing" ? "outcome_unknown" : journal[id].status, {
        deduplicated: true,
      });
      return;
    }
    if (Object.keys(journal).length >= OPERATION_JOURNAL_LIMIT)
      throw fail("journal_full", "操作记录已满，请重新绑定浏览器设备");
    journal[id] = { status: "executing", request_hash: requestHash };
    intentWritten = true;
    await saveJournal(); // Persist intent before any page side effect.
    if (
      startedGeneration !== generation ||
      connection !== socket ||
      !authenticated ||
      profile.paused ||
      profile.revoked ||
      connection.readyState !== WebSocket.OPEN ||
      Date.now() - lastAck >= leaseSeconds * 1000 ||
      closed.has(message.session_id) ||
      cancelledOperations.has(id)
    )
      throw fail("session_closed", "任务已停止");
    if (message.expires_at <= Date.now() / 1000) throw fail("operation_expired", "操作开始期限已过");
    if (!executingOperations.has(message.session_id)) executingOperations.set(message.session_id, id);
    const response = await bridge.dispatch({
      id,
      method: message.tool.slice(8),
      session_id: message.session_id,
      params: message.arguments,
    });
    if (cancelledOperations.has(id)) throw fail("operation_cancelled", "操作已取消，结果未知；不会重放");
    const status = response.error
      ? response.error.code === "outcome_unknown"
        ? "outcome_unknown"
        : "refused"
      : "executed";
    journal[id].status = status;
    await saveJournal();
    if (cancelledOperations.has(id)) throw fail("operation_cancelled", "操作已取消，结果未知；不会重放");
    result(connection, id, status, response.result || {}, response.error);
  } catch (caught) {
    const error = errorDetails(caught);
    if (intentWritten && (journal[id]?.status === "executing" || cancelledOperations.has(id))) {
      journal[id].status = "outcome_unknown";
      await saveJournal();
      result(connection, id, "outcome_unknown", {}, error);
    } else result(connection, id, "refused", {}, error);
  } finally {
    if (tracked) {
      active.delete(id);
      cancelledOperations.delete(id);
      if (executingOperations.get(message.session_id) === id) executingOperations.delete(message.session_id);
    }
  }
}
async function connect(): Promise<void> {
  await ready;
  await cleanup;
  if (cleanupError) throw cleanupError;
  if (!profile.key || profile.revoked) return;
  if (connecting) return connecting;
  connecting = (async () => {
    if (socket) {
      if (
        socket.readyState === WebSocket.OPEN &&
        authenticated &&
        Date.now() - lastAck <= leaseSeconds * 1000
      )
        return;
      // Retire explicitly: WebSocket.close() delivers its close event asynchronously.
      // Cleanup must finish before replacing socket, even if that event arrives late.
      const retired = socket;
      socket = undefined;
      authenticated = false;
      clearInterval(heartbeat);
      recordConnection({
        last_disconnected_at: Date.now(),
        last_disconnect_reason: "connection_unhealthy",
      });
      retired.close();
      cleanup = stop()
        .then(() => {
          bridge.seen.clear();
        })
        .catch(() => {
          cleanupError = fail(
            "cleanup_failed",
            "任务标签清理失败，已保留记录；请关闭残留任务标签后重新加载扩展",
          );
          notify();
          throw cleanupError;
        });
      await cleanup;
    }
    const url = new URL(profile.server + "/ws/browser");
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const connection = new WebSocket(url.href);
    socket = connection;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        connection.close();
        reject(fail("connection_timeout", "Server 连接超时"));
      }, 10000);
      const done = (error?: Error) => {
        clearTimeout(timeout);
        error ? reject(error) : resolve();
      };
      connection.addEventListener(
        "open",
        () =>
          send(
            connection,
            browserHelloSchema.parse({
              type: "hello",
              protocol: PROTOCOL_VERSION,
              device_key: profile.key,
              instance_id: profile.instance_id,
              capabilities: { browser: true },
              paused: !!profile.paused,
              platform: "Browser extension",
              version: chrome.runtime.getManifest().version,
            }),
          ),
        { once: true },
      );
      connection.addEventListener("message", (event) => {
        if (connection !== socket) return;
        let raw: unknown;
        try {
          raw = JSON.parse(event.data as string);
        } catch {
          connection.close();
          return;
        }
        if (!authenticated) {
          const parsed = deviceWelcomeSchema.safeParse(raw);
          if (!parsed.success) {
            connection.close();
            done(fail("invalid_welcome", "设备连接响应无效"));
            return;
          }
          const message = parsed.data;
          if (message.device_id !== profile.device_id) {
            connection.close();
            done(fail("invalid_welcome", "设备连接响应无效"));
            return;
          }
          authenticated = true;
          epoch = message.connection_epoch;
          sequence = 0;
          lastAck = Date.now();
          leaseSeconds = Math.min(message.lease_seconds, CONNECTION_LEASE_SECONDS);
          recordConnection({ last_connected_at: lastAck });
          heartbeat = setInterval(
            () => {
              if (Date.now() - lastAck > leaseSeconds * 1000) {
                connection.close();
                return;
              }
              try {
                send(connection, {
                  type: "heartbeat",
                  connection_epoch: epoch,
                  capabilities: { browser: true },
                  paused: !!profile.paused,
                });
              } catch {
                connection.close();
              }
            },
            Math.min(HEARTBEAT_SECONDS, Math.max(1, message.heartbeat_interval || HEARTBEAT_SECONDS)) * 1000,
          );
          notify();
          done();
          return;
        }
        const parsed = incomingSchema.safeParse(raw);
        if (!parsed.success) {
          connection.close();
          return;
        }
        const message = parsed.data;
        if (message.type === "heartbeat_ack" && message.connection_epoch === epoch) {
          lastAck = Date.now();
          recordConnection({ last_ack_at: lastAck });
        } else if (message.type === "dispatch") {
          const operation = deviceDispatchEnvelopeSchema.safeParse(raw);
          if (operation.success) void dispatch(connection, operation.data);
          else if (typeof message.operation_id === "string")
            result(
              connection,
              message.operation_id,
              "refused",
              {},
              fail("invalid_operation", "操作消息无效"),
            );
          else connection.close();
        } else if (message.type === "session_close" && message.connection_epoch === epoch)
          void stop(message.session_id).catch(() => connection.close());
        else if (message.type === "cancel") {
          for (const id of message.operation_ids || [])
            if (active.has(id)) void cancelOperation(id).catch(() => connection.close());
        } else if (message.type === "stop") void stop().catch(() => connection.close());
        else if (message.type === "revoke") {
          profile.revoked = true;
          void chrome.storage.local.set({ device: profile });
          void syncRecoveryAlarm();
          connection.close();
        }
      });
      connection.addEventListener(
        "error",
        () => done(fail("connection_error", "无法连接 Server，请检查服务地址和网络")),
        { once: true },
      );
      connection.addEventListener("close", (event) => {
        if (connection !== socket) return;
        socket = undefined;
        authenticated = false;
        clearInterval(heartbeat);
        recordConnection({ last_disconnected_at: Date.now(), last_close_code: event.code || 0 });
        if ([4401, 4403].includes(event.code)) {
          profile.revoked = true;
          void chrome.storage.local.set({ device: profile });
          void syncRecoveryAlarm();
        }
        cleanup = stop()
          .then(() => {
            bridge.seen.clear();
            scheduleReconnect();
          })
          .catch(() => {
            cleanupError = fail(
              "cleanup_failed",
              "任务标签清理失败，已保留记录；请关闭残留任务标签后重新加载扩展",
            );
            notify();
          });
        notify();
        done(fail("disconnected", "Server 已断开，已授权设备会自动重连"));
      });
    });
  })();
  try {
    await connecting;
  } catch (caught) {
    const error = errorDetails(caught);
    scheduleReconnect();
    throw error;
  } finally {
    connecting = undefined;
  }
}
chrome.runtime.onMessage.addListener((raw: unknown, sender, respond) => {
  let source;
  try {
    source = new URL(sender.url || "");
  } catch {
    return false;
  }
  const allowedPages = ["options.html", "popup.html"].map((path) => chrome.runtime.getURL(path));
  if (sender.id !== chrome.runtime.id || !allowedPages.includes(source.href)) return false;
  const parsed = uiMessageSchema.safeParse(raw);
  if (!parsed.success) {
    respond({ ok: false, error: { code: "unsupported_message", message: "不支持的配置请求" } });
    return false;
  }
  const message = parsed.data;
  configuration = configuration
    .catch(() => {})
    .then(async () => {
      await ready;
      if (cleanupError) throw cleanupError;
      if (message.type === "status")
        return {
          ok: true,
          connected:
            authenticated &&
            socket?.readyState === WebSocket.OPEN &&
            Date.now() - lastAck <= leaseSeconds * 1000,
          configured: !!profile.key,
          revoked: !!profile.revoked,
          paused: !!profile.paused,
          label: profile.label,
          server: profile.server,
          device_id: profile.device_id,
          active_operations: active.size,
          active_sessions: bridge.sessions.size,
          connection_history: { ...connectionHistory },
        };
      if (message.type === "register") {
        if (profile.key && !profile.revoked)
          throw fail("already_registered", "当前浏览器已绑定，请先解除绑定");
        const server = serverURL(message.server);
        if (typeof message.label !== "string" || !message.label.trim() || message.label.length > 80)
          throw fail("invalid_name", "请填写浏览器名称");
        const response = await fetch(server + "/api/browser/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "omit",
          body: JSON.stringify({
            username: message.username,
            password: message.password,
            name: message.label.trim(),
          }),
        });
        const raw: unknown = await response.json();
        const data = registrationErrorSchema.parse(raw);
        if (!response.ok)
          throw fail(
            data.error?.code || "registration_failed",
            data.error?.message || data.detail || "注册失败，请检查账户",
          );
        const registration = registrationSchema.safeParse(raw);
        if (!registration.success) throw fail("invalid_registration", "Server 未返回设备凭据");
        profile = {
          instance_id: crypto.randomUUID(),
          server,
          key: registration.data.key,
          device_id: registration.data.device_id,
          label: message.label.trim(),
          paused: !!profile.paused,
        };
        journal = {};
        await chrome.storage.local.set({ device: profile, operation_journal: journal });
        await syncRecoveryAlarm();
        try {
          await connect();
        } catch {}
        notify();
        return { ok: true, registered: true };
      }
      if (message.type === "pause" || message.type === "resume") {
        profile.paused = message.type === "pause";
        await chrome.storage.local.set({ device: profile });
        if (profile.paused) await stop();
        if (authenticated)
          send(socket, {
            type: "heartbeat",
            connection_epoch: epoch,
            capabilities: { browser: true },
            paused: profile.paused,
          });
        notify();
        return { ok: true };
      }
      if (message.type === "stop") {
        if (authenticated) send(socket, { type: "local_stop", connection_epoch: epoch });
        await stop();
        notify();
        return { ok: true };
      }
      if (message.type === "unbind") {
        if (!authenticated) throw fail("offline", "请联网后解除绑定，或在 Server 管理台撤销设备");
        send(socket, { type: "unbind", connection_epoch: epoch });
        profile.revoked = true;
        await chrome.storage.local.set({ device: profile });
        await syncRecoveryAlarm();
        await stop();
        socket?.close();
        notify();
        return { ok: true };
      }
      throw fail("unsupported_message", "不支持的配置请求");
    });
  configuration.then(respond, (caught: unknown) => {
    const error = errorDetails(caught);
    respond({ ok: false, error: { code: error.code || "connection_error", message: error.message } });
  });
  return true;
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECOVERY_ALARM)
    void ready
      .then(() => {
        recordConnection({ last_recovery_at: Date.now() });
        return connect();
      })
      .catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  void connect().catch(() => {});
});
const ready = (async () => {
  const saved = storedLocalSchema.parse(
    await chrome.storage.local.get(["device", "operation_journal", "connection_history"]),
  );
  profile = saved.device || {};
  journal = saved.operation_journal || {};
  connectionHistory = saved.connection_history || {};
  for (const id in journal) if (journal[id].status === "executing") journal[id].status = "outcome_unknown";
  recordConnection({ worker_started_at: Date.now() });
  await saveJournal();
  const session = storedSessionSchema.parse(
    await chrome.storage.session.get(["owned_task_tabs", "closed_sessions"]),
  );
  closed = new Set(session.closed_sessions || []);
  const remaining = [];
  for (const id of session.owned_task_tabs || []) {
    try {
      await chrome.tabs.remove(id);
    } catch {
      try {
        await chrome.tabs.get(id);
        remaining.push(id);
      } catch {}
    }
  }
  await chrome.storage.session.set({ owned_task_tabs: remaining });
  if (remaining.length)
    throw fail("cleanup_failed", "上次任务标签未能关闭，请关闭这些任务标签后重新加载扩展");
  bridge = new BrowserBridge(chrome);
  await syncRecoveryAlarm();
})();
void connect().catch(() => {});
