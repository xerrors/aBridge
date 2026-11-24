import { normalizeDeviceServer, deviceIdentitySchema } from "@abridge/protocol";
import { authorizeBrowser } from "./authorization.js";
import { requestBinding } from "./binding-request.js";
import { BrowserBridge } from "./bridge.js";
import { collectBrowserDetails, browserPlatform, type BrowserIdentity } from "./browser-brand.js";
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
  operationErrorSchema,
  HEARTBEAT_SECONDS,
  OPERATION_JOURNAL_LIMIT,
  OPERATION_START_GRACE_SECONDS,
  type DeviceDetails,
  type DeviceDispatchEnvelope,
  type OperationError,
} from "@abridge/protocol";
import { z } from "zod";
import {
  fail,
  errorDetails,
  CONNECTION_PAGE,
  type BrowserProfile,
  type BridgeError,
  type ConnectionHistory,
  uiMessageSchema,
} from "./types.js";
interface JournalEntry {
  status: string;
  request_hash: string;
}
const incomingSchema = z
  .object({
    type: z.string(),
    connection_epoch: z.number().int().optional(),
    session_id: z.string().optional(),
    operation_ids: z.array(z.string()).optional(),
    device_name: deviceRenameSchema.shape.name.optional(),
  })
  .passthrough();
const profileSchema = z.object({
  key: z.string().optional(),
  http_confirmed_origin: z.string().optional(),
  revoked: z.boolean().optional(),
  paused: z.boolean().optional(),
  instance_id: z.string().optional(),
  server: z.string().optional(),
  device_id: z.string().optional(),
  label: z.string().optional(),
  platform_revision: z.number().int().positive().optional(),
});
const journalSchema = z.record(z.string(), z.object({ status: z.string(), request_hash: z.string() }));
const replacementSchema = z.object({ device: profileSchema, operation_journal: journalSchema });
const bindingIdentitySchema = deviceIdentitySchema.extend({
  pending: z.literal(true).optional(),
  revision: z.number().int().positive().optional(),
});
const storedLocalSchema = z.object({
  device: profileSchema.optional(),
  operation_journal: journalSchema.optional(),
  binding_replacement: replacementSchema.nullish(),
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
async function settleControls(operations: Promise<unknown>[]): Promise<void> {
  const outcomes = await Promise.allSettled(operations);
  const errors = outcomes.filter((outcome) => outcome.status === "rejected").map((outcome) => outcome.reason);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, errors.map((error) => errorDetails(error).message).join("；"), {
      cause: errors[0],
    });
}
export function serverURL(value: string, confirmedHttpOrigin?: string) {
  try {
    return normalizeDeviceServer(value, confirmedHttpOrigin);
  } catch (error) {
    throw fail("invalid_server", error instanceof Error ? error.message : "服务地址无效");
  }
}

export interface BrowserDeviceClientOptions {
  navigator?: BrowserIdentity;
  chrome: typeof chrome;
  WebSocket: typeof WebSocket;
  fetch?: typeof fetch;
  now?: () => number;
  crypto?: Pick<Crypto, "subtle" | "randomUUID">;
  timers?: Pick<typeof globalThis, "setTimeout" | "clearTimeout" | "setInterval" | "clearInterval">;
}

/** Owns one extension worker lifetime, independently of binding and task lifetimes. */
export class BrowserDeviceClient {
  private readonly identity: BrowserIdentity;
  private readonly chrome: typeof chrome;
  private readonly WebSocket: typeof WebSocket;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly crypto: Pick<Crypto, "subtle" | "randomUUID">;
  private readonly timers: NonNullable<BrowserDeviceClientOptions["timers"]>;
  private readonly lifetime = new AbortController();
  private readonly operations = new Set<Promise<unknown>>();
  private disposed = false;
  private ready?: Promise<void>;
  private closing?: Promise<void>;
  private readonly details: DeviceDetails = {};
  private detailsReady?: Promise<void>;
  constructor(options: BrowserDeviceClientOptions) {
    this.identity = options.navigator ?? globalThis.navigator ?? {};
    this.chrome = options.chrome;
    this.WebSocket = options.WebSocket;
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.crypto = options.crypto ?? globalThis.crypto;
    this.timers = options.timers ?? {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
    };
  }
  start(): Promise<void> {
    if (this.disposed) return Promise.reject(fail("client_closed", "浏览器客户端已关闭"));
    if (this.ready) return this.ready;
    // MV3 event listeners must register synchronously before storage initialization yields.
    this.chrome.runtime.onMessage.addListener(this.onMessage);
    this.chrome.alarms.onAlarm.addListener(this.onAlarm);
    this.chrome.runtime.onStartup.addListener(this.onStartup);
    this.ready = this.initialize();
    this.detailsReady = this.readDetails();
    void this.connect().catch(() => {});
    return this.ready;
  }
  private assertRunning(): void {
    if (this.disposed) throw fail("client_closed", "浏览器客户端已关闭");
  }
  private async readDetails(): Promise<void> {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        collectBrowserDetails(this.chrome.runtime, this.identity, this.details),
        new Promise<void>((resolve) => {
          deadline = this.timers.setTimeout(resolve, 350);
        }),
      ]);
    } finally {
      this.timers.clearTimeout(deadline);
    }
  }
  private track<T>(task: Promise<T>): Promise<T> {
    this.operations.add(task);
    void task.finally(() => this.operations.delete(task)).catch(() => {});
    return task;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.disposed = true;
    this.generation++;
    this.nameRevision++;
    this.lifetime.abort();
    this.authorization?.controller.abort();
    this.authorization = undefined;
    this.chrome.runtime.onMessage.removeListener(this.onMessage);
    this.chrome.alarms.onAlarm.removeListener(this.onAlarm);
    this.chrome.runtime.onStartup.removeListener(this.onStartup);
    this.timers.clearTimeout(this.timer);
    this.timers.clearInterval(this.heartbeat);
    const retired = this.socket;
    this.socket = undefined;
    this.authenticated = false;
    retired?.close();
    this.closing = (async () => {
      await this.ready?.catch(() => {});
      await this.connecting?.catch(() => {});
      await this.configuration.catch(() => {});
      await this.cleanup.catch(() => {});
      try {
        if (this.bridge) await this.bridge.dispose();
      } finally {
        await Promise.allSettled([...this.operations]);
      }
    })();
    return this.closing;
  }

  private bridge!: BrowserBridge;
  private socket: WebSocket | undefined;
  private profile: BrowserProfile = {};
  private replacement: z.infer<typeof replacementSchema> | undefined;
  private replacementConnecting = false;
  private connecting: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private authenticated = false;
  private epoch: number | undefined;
  private lastAck = 0;
  private leaseSeconds = CONNECTION_LEASE_SECONDS;
  private sequence = 0;
  private generation = 0;
  private configuration: Promise<unknown> = Promise.resolve();
  private renaming = false;
  private nameRevision = 0;
  private authorization:
    | {
        method: "browser" | "token";
        controller: AbortController;
        server: string;
        label: string;
        expiresAt?: number;
      }
    | undefined;
  private authorizationError: string | undefined;
  private cleanup: Promise<void> = Promise.resolve();
  private cleanupError: BridgeError | undefined;
  private journal: Record<string, JournalEntry> = {};
  private connectionHistory: ConnectionHistory = {};
  private closed = new Set<string>();
  private active = new Map<string, string>();
  private cancelledOperations = new Set<string>();
  private executingOperations = new Map<string, string>();
  private notify = async () => {
    if (this.disposed) return;
    try {
      await this.chrome.runtime.sendMessage({ type: "status_changed" });
    } catch {}
  };
  private receiveName(name: string | undefined, connection: WebSocket) {
    if (this.disposed || name === undefined || this.renaming) return;
    const revision = this.nameRevision;
    this.configuration = this.configuration
      .catch(() => {})
      .then(async () => {
        if (connection !== this.socket || revision !== this.nameRevision || name === this.profile.label)
          return;
        const next = { ...this.profile, label: name };
        await this.chrome.storage.local.set({ device: next });
        this.profile = next;
        this.notify();
      })
      .catch(() => {}); // Retry the authoritative name on the next heartbeat if storage is unavailable.
  }
  private async renameDevice(name: string) {
    await this.ready;
    await this.configuration.catch(() => {});
    this.assertRunning();
    if (this.renaming) throw fail("rename_pending", "名称正在保存，请稍候");
    if (!this.profile.key || this.profile.revoked || !this.profile.server || !this.profile.device_id)
      throw fail("not_registered", "请先绑定当前浏览器");
    if (!this.authenticated || this.socket?.readyState !== this.WebSocket.OPEN)
      throw fail("offline", "请连接 Server 后修改名称");
    const key = this.profile.key,
      server = this.profile.server,
      deviceId = this.profile.device_id;
    this.renaming = true;
    this.nameRevision++;
    try {
      // Keep the network wait outside the control queue: pause and stop stay responsive.
      const response = await this.fetch(server + "/api/device", {
        method: "PATCH",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(10000)]),
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(deviceRenameSchema.parse({ name })),
      });
      const value: unknown = await response.json();
      if (!response.ok) {
        const error = z.object({ error: z.object({ message: z.string() }) }).safeParse(value);
        throw fail("rename_failed", error.success ? error.data.error.message : "名称保存失败，请重试");
      }
      this.assertRunning();
      const result = deviceRenameResultSchema.parse(value);
      if (result.id !== deviceId) throw fail("device_mismatch", "Server 返回的设备不匹配");
      this.configuration = this.configuration
        .catch(() => {})
        .then(async () => {
          if (
            this.disposed ||
            this.profile.key !== key ||
            this.profile.server !== server ||
            this.profile.revoked
          )
            throw fail("device_changed", "设备绑定已更换，请重新检查名称");
          const next = { ...this.profile, label: result.name };
          await this.chrome.storage.local.set({ device: next });
          this.profile = next;
          this.notify();
        });
      await this.configuration;
      return { ok: true };
    } finally {
      this.nameRevision++;
      this.renaming = false;
    }
  }
  private send(connection: WebSocket | undefined, message: object) {
    if (!connection || connection !== this.socket || connection.readyState !== this.WebSocket.OPEN)
      throw fail("disconnected", "Server 已断开");
    connection.send(JSON.stringify(message));
  }
  private recordConnection(change: Partial<ConnectionHistory>) {
    if (this.disposed) return;
    Object.assign(this.connectionHistory, change);
    void this.track(
      this.chrome.storage.local.set({ connection_history: { ...this.connectionHistory } }),
    ).catch(() => {});
  }
  private async syncRecoveryAlarm() {
    if (this.disposed) return;
    if (!this.canConnect()) {
      await this.chrome.alarms.clear(RECOVERY_ALARM);
      return;
    }
    // Browser-managed events can revive a terminated MV3 worker; JS timers cannot.
    // One minute also works on Chrome 116–119, before 30-second alarms existed.
    if (!(await this.chrome.alarms.get(RECOVERY_ALARM)) && !this.disposed)
      await this.chrome.alarms.create(RECOVERY_ALARM, { periodInMinutes: 1 });
  }
  private async saveJournal() {
    await this.chrome.storage.local.set({ operation_journal: this.journal });
  }
  private async saveTerminalJournal(error?: OperationError): Promise<OperationError | undefined> {
    try {
      await this.saveJournal();
      return error;
    } catch {
      // Persistence cannot undo an observed result or make a submitted operation safe to replay.
      return {
        ...error,
        code: error?.code ?? "journal_persistence_failed",
        message: ["操作终态日志保存失败；不要重放已提交的操作", error?.message]
          .filter(Boolean)
          .join("；")
          .slice(0, 2000),
      };
    }
  }
  private scheduleReconnect() {
    this.timers.clearTimeout(this.timer);
    if (!this.disposed && this.canConnect() && !this.cleanupError)
      this.timer = this.timers.setTimeout(() => {
        void this.connect().catch(() => {});
      }, 2000);
  }
  private canConnect(): boolean {
    return !!this.profile.key && !this.profile.revoked && (!this.replacement || this.replacementConnecting);
  }
  private result(
    connection: WebSocket,
    operationId: string,
    status: string,
    value: object = {},
    error?: { code?: string; message: string },
  ) {
    try {
      this.send(connection, {
        type: "result",
        connection_epoch: this.epoch,
        operation_id: operationId,
        status,
        result: value,
        ...(error
          ? { error: { ...error, code: error.code || "browser_error", message: error.message } }
          : {}),
      });
    } catch {}
  }
  private async stop(sessionId?: string) {
    let cleanup: Promise<void>;
    if (sessionId) {
      this.closed.add(sessionId);
      cleanup = this.bridge.close(sessionId);
    } else {
      this.generation++;
      for (const id of this.bridge.sessionIds) this.closed.add(id);
      cleanup = this.bridge.stop();
    }
    try {
      // Retire task resources before storage can yield or fail; await both outcomes.
      await settleControls([
        cleanup,
        Promise.resolve().then(() => this.chrome.storage.session.set({ closed_sessions: [...this.closed] })),
      ]);
    } finally {
      this.notify();
    }
  }
  private async cancelOperation(id: string): Promise<void> {
    const sessionId = this.active.get(id);
    if (!sessionId) return;
    this.cancelledOperations.add(id);
    // Discard only the task page owned by this executing operation. The control
    // session remains usable; a caller must observe/open again after an unknown result.
    if (this.executingOperations.get(sessionId) === id) await this.bridge.close(sessionId);
  }
  private async dispatch(connection: WebSocket, message: DeviceDispatchEnvelope) {
    const id = message.operation_id,
      startedGeneration = this.generation,
      journal = this.journal;
    let tracked = false,
      intentWritten = false;
    try {
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(id))
        throw fail("invalid_operation", "操作标识无效");
      if (
        !this.authenticated ||
        this.profile.paused ||
        this.profile.revoked ||
        connection.readyState !== this.WebSocket.OPEN ||
        this.now() - this.lastAck >= this.leaseSeconds * 1000 ||
        message.protocol !== PROTOCOL_VERSION ||
        message.device_id !== this.profile.device_id ||
        message.connection_epoch !== this.epoch
      )
        throw fail("connection_mismatch", "操作与当前设备连接不匹配，或已暂停");
      if (!(
        message.expires_at > this.now() / 1000 &&
        message.expires_at <= this.now() / 1000 + OPERATION_START_SECONDS + OPERATION_START_GRACE_SECONDS
      ))
        throw fail("operation_expired", "操作开始期限已过");
      if (!Number.isInteger(message.sequence) || message.sequence <= this.sequence)
        throw fail("stale_operation", "操作序号已失效");
      this.sequence = message.sequence;
      if (
        ![
          "browser_open",
          "browser_observe",
          "browser_act",
          "browser_read",
          "browser_wait",
          "browser_evaluate",
          "browser_locate_act",
        ].includes(message.tool) ||
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
        this.closed.has(message.session_id)
      )
        throw fail("session_closed", "任务会话无效或已结束");
      if (this.active.has(id)) throw fail("duplicate_request", "操作正在处理，不会重放");
      this.active.set(id, message.session_id);
      tracked = true;
      this.notify();
      const digest = await this.crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify([message.tool, message.arguments, message.session_id])),
      );
      const requestHash = [...new Uint8Array(digest)]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
      if (journal !== this.journal || startedGeneration !== this.generation || connection !== this.socket)
        throw fail("session_closed", "任务已停止");
      if (journal[id]) {
        if (journal[id].request_hash !== requestHash)
          throw fail("operation_conflict", "相同操作标识的参数不能改变");
        this.result(
          connection,
          id,
          journal[id].status === "executing" ? "outcome_unknown" : journal[id].status,
          {
            deduplicated: true,
          },
        );
        return;
      }
      if (Object.keys(journal).length >= OPERATION_JOURNAL_LIMIT)
        throw fail("journal_full", "操作记录已满，请重新绑定浏览器设备");
      journal[id] = { status: "executing", request_hash: requestHash };
      intentWritten = true;
      await this.saveJournal(); // Persist intent before any page side effect.
      if (
        startedGeneration !== this.generation ||
        connection !== this.socket ||
        !this.authenticated ||
        this.profile.paused ||
        this.profile.revoked ||
        connection.readyState !== this.WebSocket.OPEN ||
        this.now() - this.lastAck >= this.leaseSeconds * 1000 ||
        this.closed.has(message.session_id) ||
        this.cancelledOperations.has(id)
      )
        throw fail("session_closed", "任务已停止");
      if (message.expires_at <= this.now() / 1000) throw fail("operation_expired", "操作开始期限已过");
      if (!this.executingOperations.has(message.session_id))
        this.executingOperations.set(message.session_id, id);
      const response = await this.bridge.dispatch({
        id,
        method: message.tool.slice(8),
        session_id: message.session_id,
        params: message.arguments,
        isCancelled: () => this.cancelledOperations.has(id),
        onExecutionStart: () => this.executingOperations.set(message.session_id, id),
      });
      if (this.cancelledOperations.has(id) && !response.error && response.result?.executed !== true)
        throw fail("operation_cancelled", "操作已取消，结果未知；不会重放");
      if (journal !== this.journal) return;
      const status = response.status;
      journal[id].status = status;
      const receiptError = await this.saveTerminalJournal(response.error);
      if (this.cancelledOperations.has(id) && !response.error && response.result?.executed !== true)
        throw fail("operation_cancelled", "操作已取消，结果未知；不会重放");
      this.result(connection, id, status, response.result || {}, receiptError);
    } catch (caught) {
      const error = errorDetails(caught);
      if (
        intentWritten &&
        journal === this.journal &&
        (journal[id]?.status === "executing" || this.cancelledOperations.has(id))
      ) {
        journal[id].status = "outcome_unknown";
        const cause = operationErrorSchema.shape.cause.safeParse(error.cause);
        const receiptError = await this.saveTerminalJournal({
          ...error,
          code: error.code || "browser_error",
          message: error.message,
          cause: cause.success ? cause.data : undefined,
        });
        this.result(connection, id, "outcome_unknown", {}, receiptError);
      } else this.result(connection, id, "refused", {}, error);
    } finally {
      if (tracked) {
        this.active.delete(id);
        this.cancelledOperations.delete(id);
        if (this.executingOperations.get(message.session_id) === id)
          this.executingOperations.delete(message.session_id);
        this.notify();
      }
    }
  }
  private async connect(): Promise<void> {
    if (this.disposed) return;
    await this.ready;
    await this.detailsReady;
    await this.cleanup;
    if (this.disposed) return;
    if (this.cleanupError) throw this.cleanupError;
    if (!this.canConnect() || this.authorization) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      if (this.socket) {
        if (
          this.socket.readyState === this.WebSocket.OPEN &&
          this.authenticated &&
          this.now() - this.lastAck <= this.leaseSeconds * 1000
        )
          return;
        // Retire explicitly: WebSocket.close() delivers its close event asynchronously.
        // Cleanup must finish before replacing socket, even if that event arrives late.
        const retired = this.socket;
        this.socket = undefined;
        this.authenticated = false;
        this.timers.clearInterval(this.heartbeat);
        this.recordConnection({
          last_disconnected_at: this.now(),
          last_disconnect_reason: "connection_unhealthy",
        });
        retired.close();
        this.cleanup = this.stop()
          .then(() => {
            this.bridge.resetRequests();
          })
          .catch(() => {
            this.cleanupError = fail(
              "cleanup_failed",
              "任务标签清理失败，已保留记录；请关闭残留任务标签后重新加载扩展",
            );
            this.notify();
            throw this.cleanupError;
          });
        await this.cleanup;
      }
      // Binding may have started while retiring the previous connection.
      if (this.disposed || this.authorization || !this.canConnect()) return;
      const server = serverURL(this.profile.server!, this.profile.http_confirmed_origin);
      const url = new URL(server + "/ws/browser");
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const connection = new this.WebSocket(url.href);
      this.socket = connection;
      await new Promise<void>((resolve, reject) => {
        const timeout = this.timers.setTimeout(() => {
          connection.close();
          reject(fail("connection_timeout", "Server 连接超时"));
        }, 10000);
        const aborted = () => done(fail("client_closed", "浏览器客户端已关闭"));
        const done = (error?: Error) => {
          this.lifetime.signal.removeEventListener("abort", aborted);
          this.timers.clearTimeout(timeout);
          error ? reject(error) : resolve();
        };
        this.lifetime.signal.addEventListener("abort", aborted, { once: true });
        connection.addEventListener(
          "open",
          () => {
            if (this.disposed || connection !== this.socket) return;
            this.send(
              connection,
              browserHelloSchema.parse({
                type: "hello",
                protocol: PROTOCOL_VERSION,
                device_key: this.profile.key,
                instance_id: this.profile.instance_id,
                capabilities: { browser: true },
                paused: !!this.profile.paused,
                platform: browserPlatform(this.identity),
                version: this.chrome.runtime.getManifest().version,
                details: Object.keys(this.details).length ? this.details : undefined,
              }),
            );
          },
          { once: true, signal: this.lifetime.signal },
        );
        connection.addEventListener(
          "message",
          (event) => {
            if (connection !== this.socket) return;
            let raw: unknown;
            try {
              raw = JSON.parse(event.data as string);
            } catch {
              connection.close();
              return;
            }
            if (!this.authenticated) {
              const parsed = deviceWelcomeSchema.safeParse(raw);
              if (!parsed.success) {
                connection.close();
                done(fail("invalid_welcome", "设备连接响应无效"));
                return;
              }
              const message = parsed.data;
              if (message.device_id !== this.profile.device_id) {
                connection.close();
                done(fail("invalid_welcome", "设备连接响应无效"));
                return;
              }
              this.authenticated = true;
              this.receiveName(message.device_name, connection);
              this.epoch = message.connection_epoch;
              this.sequence = 0;
              this.lastAck = this.now();
              this.leaseSeconds = Math.min(message.lease_seconds, CONNECTION_LEASE_SECONDS);
              this.recordConnection({ last_connected_at: this.lastAck });
              this.heartbeat = this.timers.setInterval(
                () => {
                  if (this.now() - this.lastAck > this.leaseSeconds * 1000) {
                    connection.close();
                    return;
                  }
                  try {
                    this.send(connection, {
                      type: "heartbeat",
                      connection_epoch: this.epoch,
                      capabilities: { browser: true },
                      paused: !!this.profile.paused,
                    });
                  } catch {
                    connection.close();
                  }
                },
                Math.min(HEARTBEAT_SECONDS, Math.max(1, message.heartbeat_interval || HEARTBEAT_SECONDS)) *
                  1000,
              );
              this.notify();
              done();
              return;
            }
            const parsed = incomingSchema.safeParse(raw);
            if (!parsed.success) {
              connection.close();
              return;
            }
            const message = parsed.data;
            if (message.type === "heartbeat_ack" && message.connection_epoch === this.epoch) {
              this.lastAck = this.now();
              this.recordConnection({ last_ack_at: this.lastAck });
              this.receiveName(message.device_name, connection);
            } else if (message.type === "dispatch") {
              const operation = deviceDispatchEnvelopeSchema.safeParse(raw);
              if (operation.success) void this.track(this.dispatch(connection, operation.data));
              else if (typeof message.operation_id === "string")
                this.result(
                  connection,
                  message.operation_id,
                  "refused",
                  {},
                  fail("invalid_operation", "操作消息无效"),
                );
              else connection.close();
            } else if (message.type === "session_close" && message.connection_epoch === this.epoch)
              void this.track(this.stop(message.session_id)).catch(() => connection.close());
            else if (message.type === "cancel") {
              for (const id of message.operation_ids || [])
                if (this.active.has(id))
                  void this.track(this.cancelOperation(id)).catch(() => connection.close());
            } else if (message.type === "stop") void this.track(this.stop()).catch(() => connection.close());
            else if (message.type === "revoke") {
              this.profile.revoked = true;
              void this.track(this.chrome.storage.local.set({ device: this.profile }));
              void this.track(this.syncRecoveryAlarm());
              connection.close();
            }
          },
          { signal: this.lifetime.signal },
        );
        connection.addEventListener(
          "error",
          () => done(fail("connection_error", "无法连接 Server，请检查服务地址和网络")),
          { once: true, signal: this.lifetime.signal },
        );
        connection.addEventListener(
          "close",
          (event) => {
            if (connection !== this.socket) {
              done(fail("disconnected", "旧设备连接已结束"));
              return;
            }
            this.socket = undefined;
            this.authenticated = false;
            this.timers.clearInterval(this.heartbeat);
            this.recordConnection({ last_disconnected_at: this.now(), last_close_code: event.code || 0 });
            if (this.replacement) {
              // A staged credential is retried deliberately by the launcher.
              this.replacementConnecting = false;
              void this.track(this.syncRecoveryAlarm());
            }
            if ([4401, 4403].includes(event.code)) {
              this.profile.revoked = true;
              void this.track(this.chrome.storage.local.set({ device: this.profile }));
              void this.track(this.syncRecoveryAlarm());
            }
            this.cleanup = this.stop()
              .then(() => {
                this.bridge.resetRequests();
                this.scheduleReconnect();
              })
              .catch(() => {
                this.cleanupError = fail(
                  "cleanup_failed",
                  "任务标签清理失败，已保留记录；请关闭残留任务标签后重新加载扩展",
                );
                this.notify();
              });
            this.notify();
            done(fail("disconnected", "Server 已断开，已授权设备会自动重连"));
          },
          { signal: this.lifetime.signal },
        );
      });
    })();
    try {
      await this.connecting;
    } catch (caught) {
      const error = errorDetails(caught);
      this.scheduleReconnect();
      throw error;
    } finally {
      this.connecting = undefined;
    }
  }
  private async initialize(): Promise<void> {
    const saved = storedLocalSchema.parse(
      await this.chrome.storage.local.get([
        "device",
        "operation_journal",
        "binding_replacement",
        "connection_history",
      ]),
    );
    this.assertRunning();
    this.profile = saved.device || {};
    this.replacement = saved.binding_replacement ?? undefined;
    this.journal = saved.operation_journal || {};
    this.connectionHistory = saved.connection_history || {};
    for (const id in this.journal)
      if (this.journal[id].status === "executing") this.journal[id].status = "outcome_unknown";
    this.recordConnection({ worker_started_at: this.now() });
    await this.saveJournal();
    this.assertRunning();
    const session = storedSessionSchema.parse(
      await this.chrome.storage.session.get(["owned_task_tabs", "closed_sessions"]),
    );
    this.assertRunning();
    this.closed = new Set(session.closed_sessions || []);
    this.bridge = new BrowserBridge(this.chrome, { ownedTabs: session.owned_task_tabs });
    await this.bridge.stop();
    this.assertRunning();
    await this.syncRecoveryAlarm();
  }

  private verifyDevice(server: string, key: string, signal: AbortSignal) {
    return requestBinding(
      this.fetch,
      server + "/api/device",
      {
        headers: { Authorization: `Bearer ${key}` },
        signal,
      },
      bindingIdentitySchema,
      true,
    );
  }

  private async retireBindingConnection() {
    // Retire callbacks first so asynchronous close/revoke cannot alter the restored binding.
    const retired = this.socket;
    this.socket = undefined;
    this.authenticated = false;
    this.timers.clearInterval(this.heartbeat);
    this.timers.clearTimeout(this.timer);
    retired?.close();
    await this.connecting?.catch(() => {});
    await this.stop();
    this.bridge.resetRequests();
  }

  private async resolvePlatformBinding(action: "resume" | "confirm" | "abort", revision: number) {
    const { key, server, device_id, http_confirmed_origin, platform_revision } = this.profile;
    if (this.authorization || !key || !server) throw fail("binding_changed", "当前登记版本与请求不符");
    const origin = serverURL(server, http_confirmed_origin);
    const original = this.replacement;
    if (!original && action === "resume" && platform_revision === undefined) {
      const device = await this.verifyDevice(origin, key, this.lifetime.signal);
      if (
        device.pending ||
        device.kind !== "browser" ||
        device.id !== device_id ||
        device.revision !== revision
      )
        throw fail("binding_changed", "当前登记版本与请求不符");
      const next = { ...this.profile, platform_revision: revision };
      await this.chrome.storage.local.set({ device: next });
      this.profile = next;
      return { ok: true, state: "active" };
    }
    if (platform_revision !== revision) throw fail("binding_changed", "当前登记版本与请求不符");
    if (!original) return { ok: true, state: "active" };
    if (action !== "abort") {
      let device: z.infer<typeof bindingIdentitySchema>;
      if (this.profile.revoked) return { ok: true, state: "invalid" };
      try {
        device = await this.verifyDevice(origin, key, this.lifetime.signal);
      } catch (error) {
        if (errorDetails(error).code === "invalid_token") return { ok: true, state: "invalid" };
        throw error;
      }
      if (device.kind !== "browser" || device.id !== device_id || device.revision !== revision)
        throw fail("device_mismatch", "Server 返回的设备不匹配");
      if (device.pending) {
        if (action === "resume") {
          this.replacementConnecting = true;
          void this.connect().catch(() => {});
        }
        return { ok: true, state: "pending" };
      }
    } else {
      this.replacementConnecting = false;
      let status: "abandoned" | "invalid" | "active";
      try {
        ({ status } = await requestBinding(
          this.fetch,
          origin + "/api/managed-browsers/abandon",
          {
            method: "POST",
            headers: { Authorization: `Bearer ${key}` },
            signal: this.lifetime.signal,
          },
          z.object({ status: z.enum(["abandoned", "invalid", "active"]) }),
        ));
      } catch (error) {
        await this.retireBindingConnection();
        throw error;
      }
      if (status !== "active") {
        await this.retireBindingConnection();
        // Only the device WS can distinguish explicit revocation from a proxy's HTTP denial.
        const previous = { ...original.device, paused: !!(this.profile.paused || original.device.paused) };
        await this.chrome.storage.local.set({
          device: previous,
          operation_journal: original.operation_journal,
          binding_replacement: null,
        });
        this.profile = previous;
        this.journal = original.operation_journal;
        this.replacement = undefined;
        await this.syncRecoveryAlarm();
        void this.connect().catch(() => {});
        this.notify();
        return { ok: true, state: "restored" };
      }
    }
    // A response lost after cutover can be reconciled without republishing the prior key.
    await this.chrome.storage.local.set({ binding_replacement: null });
    this.replacement = undefined;
    this.replacementConnecting = false;
    await this.syncRecoveryAlarm();
    void this.connect().catch(() => {});
    this.notify();
    return { ok: true, state: "active" };
  }
  private onMessage: Parameters<typeof chrome.runtime.onMessage.addListener>[0] = (
    raw: unknown,
    sender,
    respond,
  ) => {
    if (this.disposed) return false;
    let source;
    try {
      source = new URL(sender.url || "");
    } catch {
      return false;
    }
    const connectionPage = source.href === this.chrome.runtime.getURL(CONNECTION_PAGE);
    if (
      sender.id !== this.chrome.runtime.id ||
      (!connectionPage && source.href !== this.chrome.runtime.getURL("popup.html"))
    )
      return false;
    const parsed = uiMessageSchema.safeParse(raw);
    if (!parsed.success) {
      respond({ ok: false, error: { code: "unsupported_message", message: "不支持的配置请求" } });
      return false;
    }
    const message = parsed.data;
    if (
      (message.type === "platform_binding" ||
        (message.type === "bind_token" && message.platform_revision !== undefined)) &&
      !connectionPage
    )
      return false;
    if (
      connectionPage &&
      ![
        "status",
        "authorize",
        "bind_token",
        "platform_binding",
        "authorize_cancel",
        "rename",
        "unbind",
      ].includes(message.type)
    )
      return false;
    if (message.type === "rename") {
      void this.renameDevice(message.name).then(respond, (caught: unknown) => {
        const error = errorDetails(caught);
        respond({ ok: false, error: { code: error.code || "rename_failed", message: error.message } });
      });
      return true;
    }
    this.configuration = this.configuration
      .catch(() => {})
      .then(async () => {
        await this.ready;
        this.assertRunning();
        if (this.cleanupError) throw this.cleanupError;
        if (message.type === "status")
          return {
            ok: true,
            connected:
              this.authenticated &&
              this.socket?.readyState === this.WebSocket.OPEN &&
              this.now() - this.lastAck <= this.leaseSeconds * 1000,
            configured: !!this.profile.key,
            revoked: !!this.profile.revoked,
            paused: !!this.profile.paused,
            label: this.authorization?.label ?? this.profile.label,
            server: this.authorization?.server ?? this.profile.server,
            device_id: this.profile.device_id,
            http_confirmed_origin: this.profile.http_confirmed_origin,
            active_operations: this.active.size,
            active_sessions: this.bridge.sessionCount,
            connection_history: { ...this.connectionHistory },
            authorizing: !!this.authorization,
            binding_method: this.authorization?.method,
            authorization_expires_at: this.authorization?.expiresAt,
            authorization_error: this.authorizationError,
            platform_revision: this.profile.platform_revision,
            replacement_pending: !!this.replacement,
          };
        if (message.type === "platform_binding")
          return this.resolvePlatformBinding(message.action, message.revision);
        if (message.type === "authorize_cancel") {
          this.authorization?.controller.abort();
          this.authorization = undefined;
          this.authorizationError = undefined;
          this.notify();
          return { ok: true };
        }
        if (message.type === "bind_token") {
          if (this.authorization || this.replacement)
            throw fail("authorization_pending", "请先完成或取消当前授权");
          const server = serverURL(message.server, message.http_confirmed_origin);
          const pending = {
            method: "token" as const,
            controller: new AbortController(),
            server,
            label: this.profile.label || "",
            expiresAt: undefined as number | undefined,
          };
          this.authorization = pending;
          this.authorizationError = undefined;
          let reconnectPrevious: BrowserProfile | undefined;
          void (async () => {
            const device = await this.verifyDevice(server, message.device_key, pending.controller.signal);
            if (this.disposed || this.authorization !== pending || pending.controller.signal.aborted) return;
            if (device.kind !== "browser")
              throw fail("wrong_device_kind", "请使用浏览器设备的 Token，不能使用电脑、Agent 或管理员 Token");
            if (
              device.pending &&
              (message.platform_revision === undefined ||
                (this.profile.key &&
                  (this.profile.server !== server || this.profile.device_id !== device.id)))
            )
              throw fail("device_mismatch", "候选凭据只能用于同一设备的平台代理换绑");
            if (message.platform_revision !== undefined && device.revision !== message.platform_revision)
              throw fail("binding_changed", "当前登记版本与请求不符");
            this.configuration = this.configuration
              .catch(() => {})
              .then(async () => {
                if (this.disposed || this.authorization !== pending || pending.controller.signal.aborted)
                  return;
                const next: BrowserProfile = {
                  instance_id: this.crypto.randomUUID(),
                  server,
                  key: message.device_key,
                  device_id: device.id,
                  label: device.name,
                  paused: !!this.profile.paused,
                  http_confirmed_origin: message.http_confirmed_origin,
                  ...(message.platform_revision !== undefined && {
                    platform_revision: message.platform_revision,
                  }),
                };
                await this.retireBindingConnection();
                reconnectPrevious = this.profile;
                if (this.disposed || this.authorization !== pending || pending.controller.signal.aborted)
                  return;
                const original = device.pending
                  ? {
                      device: { ...this.profile },
                      operation_journal: Object.fromEntries(
                        Object.entries(this.journal).map(([id, entry]) => [
                          id,
                          entry.status === "executing" ? { ...entry, status: "outcome_unknown" } : entry,
                        ]),
                      ),
                    }
                  : undefined;
                await this.chrome.storage.local.set({
                  device: next,
                  operation_journal: {},
                  binding_replacement: original ?? null,
                });
                this.profile = next;
                this.journal = {};
                this.replacement = original;
                this.replacementConnecting = !!original;
                this.authorization = undefined;
                this.authorizationError = undefined;
                await this.syncRecoveryAlarm();
                void this.connect().catch(() => {});
                this.notify();
              });
            await this.configuration;
          })()
            .catch((caught: unknown) => {
              if (this.authorization !== pending) return;
              this.authorization = undefined;
              this.authorizationError = errorDetails(caught).message;
              this.notify();
            })
            .finally(() => {
              if (reconnectPrevious && this.profile === reconnectPrevious)
                void this.connect().catch(() => {});
            });
          this.notify();
          return { ok: true };
        }
        if (message.type === "authorize") {
          if (this.replacement) throw fail("authorization_pending", "请先完成或取消当前授权");
          if (this.profile.key && !this.profile.revoked)
            throw fail("already_registered", "当前浏览器已绑定，请先解除绑定");
          if (this.authorization) throw fail("authorization_pending", "请先完成或取消当前授权");
          const server = serverURL(message.server, message.http_confirmed_origin);
          const label = message.label.trim();
          if (!label || label.length > 80) throw fail("invalid_name", "请填写浏览器名称");
          const pending = {
            method: "browser" as const,
            controller: new AbortController(),
            server,
            label,
            expiresAt: undefined as number | undefined,
          };
          this.authorization = pending;
          this.authorizationError = undefined;
          // Browser-managed authorization keeps the MV3 worker alive on Chrome 116+.
          // Its wait stays outside the configuration queue so controls remain responsive.
          void authorizeBrowser({
            fetch: this.fetch,
            server,
            name: label,
            redirectUri: this.chrome.identity.getRedirectURL(BROWSER_AUTH_CALLBACK_PATH.slice(1)),
            open: (url) => this.chrome.identity.launchWebAuthFlow({ url, interactive: true }),
            signal: pending.controller.signal,
            started: (expiresAt) => {
              pending.expiresAt = expiresAt;
              this.notify();
            },
          })
            .then((token) => {
              if (this.disposed || this.authorization !== pending || pending.controller.signal.aborted)
                return;
              this.configuration = this.configuration
                .catch(() => {})
                .then(async () => {
                  if (this.disposed || this.authorization !== pending || pending.controller.signal.aborted)
                    return;
                  const next = {
                    instance_id: this.crypto.randomUUID(),
                    server,
                    key: token.key,
                    http_confirmed_origin: message.http_confirmed_origin,
                    device_id: token.device_id,
                    label: token.name,
                    paused: !!this.profile.paused,
                  };
                  await this.chrome.storage.local.set({ device: next, operation_journal: {} });
                  this.profile = next;
                  this.journal = {};
                  this.authorization = undefined;
                  this.authorizationError = undefined;
                  await this.syncRecoveryAlarm();
                  void this.connect().catch(() => {});
                  this.notify();
                });
              return this.configuration;
            })
            .catch((caught: unknown) => {
              if (this.authorization !== pending) return;
              this.authorization = undefined;
              this.authorizationError = errorDetails(caught).message;
              this.notify();
            });
          this.notify();
          return { ok: true };
        }
        if (message.type === "pause" || message.type === "resume") {
          try {
            if (message.type === "pause") {
              this.profile.paused = true;
              const stopping = this.stop();
              await settleControls([
                stopping,
                Promise.resolve().then(() => this.chrome.storage.local.set({ device: this.profile })),
              ]);
            } else {
              await this.chrome.storage.local.set({ device: { ...this.profile, paused: false } });
              this.assertRunning();
              this.profile.paused = false;
            }
            if (this.authenticated)
              this.send(this.socket, {
                type: "heartbeat",
                connection_epoch: this.epoch,
                capabilities: { browser: true },
                paused: this.profile.paused,
              });
          } finally {
            this.notify();
          }
          return { ok: true };
        }
        if (message.type === "stop") {
          if (this.authenticated)
            this.send(this.socket, { type: "local_stop", connection_epoch: this.epoch });
          await this.stop();
          this.notify();
          return { ok: true };
        }
        if (message.type === "unbind") {
          if (!this.authenticated) throw fail("offline", "请联网后解除绑定，或在 Server 管理台撤销设备");
          this.send(this.socket, { type: "unbind", connection_epoch: this.epoch });
          this.profile.revoked = true;
          await this.chrome.storage.local.set({ device: this.profile });
          await this.syncRecoveryAlarm();
          await this.stop();
          this.socket?.close();
          this.notify();
          return { ok: true };
        }
        throw fail("unsupported_message", "不支持的配置请求");
      });
    this.configuration.then(respond, (caught: unknown) => {
      const error = errorDetails(caught);
      respond({ ok: false, error: { code: error.code || "connection_error", message: error.message } });
    });
    return true;
  };
  private onAlarm: Parameters<typeof chrome.alarms.onAlarm.addListener>[0] = (alarm) => {
    if (!this.disposed && alarm.name === RECOVERY_ALARM)
      void this.ready
        ?.then(() => {
          this.recordConnection({ last_recovery_at: this.now() });
          return this.connect();
        })
        .catch(() => {});
  };
  private onStartup: Parameters<typeof chrome.runtime.onStartup.addListener>[0] = () => {
    void this.connect().catch(() => {});
  };
}
