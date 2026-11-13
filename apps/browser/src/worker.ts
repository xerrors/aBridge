import { authorizeBrowser } from "./authorization.js";
import { BrowserBridge } from "./bridge.js";
import {
  BROWSER_AUTH_CALLBACK_PATH,
  PROTOCOL_VERSION,
  CONNECTION_LEASE_SECONDS,
  OPERATION_START_SECONDS,
  deviceDispatchEnvelopeSchema,
  browserHelloSchema,
  deviceWelcomeSchema,
  deviceRenameSchema,
  deviceRenameResultSchema,
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
let renaming = false;
let nameRevision = 0;
let authorization:
  { controller: AbortController; server: string; label: string; expiresAt?: number } | undefined;
let authorizationError: string | undefined;
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
    device_name: deviceRenameSchema.shape.name.optional(),
  })
  .passthrough();
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
const notify = async () => {
  try {
    await chrome.runtime.sendMessage({ type: "status_changed" });
  } catch {}
};
function receiveName(name: string | undefined, connection: WebSocket) {
  if (name === undefined || renaming) return;
  const revision = nameRevision;
  configuration = configuration
    .catch(() => {})
    .then(async () => {
      if (connection !== socket || revision !== nameRevision || name === profile.label) return;
      const next = { ...profile, label: name };
      await chrome.storage.local.set({ device: next });
      profile = next;
      notify();
    })
    .catch(() => {}); // Retry the authoritative name on the next heartbeat if storage is unavailable.
}
async function renameDevice(name: string) {
  await ready;
  await configuration.catch(() => {});
  if (renaming) throw fail("rename_pending", "名称正在保存，请稍候");
  if (!profile.key || profile.revoked || !profile.server || !profile.device_id)
    throw fail("not_registered", "请先绑定当前浏览器");
  if (!authenticated || socket?.readyState !== WebSocket.OPEN)
    throw fail("offline", "请连接 Server 后修改名称");
  const key = profile.key,
    server = profile.server,
    deviceId = profile.device_id;
  renaming = true;
  nameRevision++;
  try {
    // Keep the network wait outside the control queue: pause and stop stay responsive.
    const response = await fetch(server + "/api/device", {
      method: "PATCH",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(deviceRenameSchema.parse({ name })),
    });
    const value: unknown = await response.json();
    if (!response.ok) {
      const error = z.object({ error: z.object({ message: z.string() }) }).safeParse(value);
      throw fail("rename_failed", error.success ? error.data.error.message : "名称保存失败，请重试");
    }
    const result = deviceRenameResultSchema.parse(value);
    if (result.id !== deviceId) throw fail("device_mismatch", "Server 返回的设备不匹配");
    configuration = configuration
      .catch(() => {})
      .then(async () => {
        if (profile.key !== key || profile.server !== server || profile.revoked)
          throw fail("device_changed", "设备绑定已更换，请重新检查名称");
        const next = { ...profile, label: result.name };
        await chrome.storage.local.set({ device: next });
        profile = next;
        notify();
      });
    await configuration;
    return { ok: true };
  } finally {
    nameRevision++;
    renaming = false;
  }
}
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
  notify();
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
    notify();
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
      notify();
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
          receiveName(message.device_name, connection);
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
          receiveName(message.device_name, connection);
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
  if (sender.id !== chrome.runtime.id || source.href !== chrome.runtime.getURL("popup.html")) return false;
  const parsed = uiMessageSchema.safeParse(raw);
  if (!parsed.success) {
    respond({ ok: false, error: { code: "unsupported_message", message: "不支持的配置请求" } });
    return false;
  }
  const message = parsed.data;
  if (message.type === "rename") {
    void renameDevice(message.name).then(respond, (caught: unknown) => {
      const error = errorDetails(caught);
      respond({ ok: false, error: { code: error.code || "rename_failed", message: error.message } });
    });
    return true;
  }
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
          label: authorization?.label ?? profile.label,
          server: authorization?.server ?? profile.server,
          device_id: profile.device_id,
          active_operations: active.size,
          active_sessions: bridge.sessions.size,
          connection_history: { ...connectionHistory },
          authorizing: !!authorization,
          authorization_expires_at: authorization?.expiresAt,
          authorization_error: authorizationError,
        };
      if (message.type === "authorize_cancel") {
        authorization?.controller.abort();
        authorization = undefined;
        authorizationError = undefined;
        notify();
        return { ok: true };
      }
      if (message.type === "authorize") {
        if (profile.key && !profile.revoked)
          throw fail("already_registered", "当前浏览器已绑定，请先解除绑定");
        if (authorization) throw fail("authorization_pending", "请先完成或取消当前授权");
        const server = serverURL(message.server);
        const label = message.label.trim();
        if (!label || label.length > 80) throw fail("invalid_name", "请填写浏览器名称");
        const pending = {
          controller: new AbortController(),
          server,
          label,
          expiresAt: undefined as number | undefined,
        };
        authorization = pending;
        authorizationError = undefined;
        // Browser-managed authorization keeps the MV3 worker alive on Chrome 116+.
        // Its wait stays outside the configuration queue so controls remain responsive.
        void authorizeBrowser({
          server,
          name: label,
          redirectUri: chrome.identity.getRedirectURL(BROWSER_AUTH_CALLBACK_PATH.slice(1)),
          open: (url) => chrome.identity.launchWebAuthFlow({ url, interactive: true }),
          signal: pending.controller.signal,
          started: (expiresAt) => {
            pending.expiresAt = expiresAt;
            notify();
          },
        })
          .then((token) => {
            configuration = configuration
              .catch(() => {})
              .then(async () => {
                if (authorization !== pending || pending.controller.signal.aborted) return;
                const next = {
                  instance_id: crypto.randomUUID(),
                  server,
                  key: token.key,
                  device_id: token.device_id,
                  label: token.name,
                  paused: !!profile.paused,
                };
                await chrome.storage.local.set({ device: next, operation_journal: {} });
                profile = next;
                journal = {};
                authorization = undefined;
                authorizationError = undefined;
                await syncRecoveryAlarm();
                void connect().catch(() => {});
                notify();
              });
            return configuration;
          })
          .catch((caught: unknown) => {
            if (authorization !== pending) return;
            authorization = undefined;
            authorizationError = errorDetails(caught).message;
            notify();
          });
        notify();
        return { ok: true };
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
