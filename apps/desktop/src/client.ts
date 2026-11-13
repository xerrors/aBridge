import { listenLocalControl, type LocalControlServer } from "./local-control.js";
import { WebSocket } from "ws";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  CAPABILITIES,
  DESKTOP_CAPABILITIES,
  TOOL_CAPABILITIES,
  requiredCapabilities,
  operationFrameSchema,
  deviceWelcomeSchema,
  HEARTBEAT_SECONDS,
  OPERATION_START_SECONDS,
  OPERATION_START_GRACE_SECONDS,
  PROTOCOL_VERSION,
  VERSION,
  MAX_MESSAGE_BYTES,
  MAX_DEVICE_OPERATIONS,
  DEVICE_LEASE_SECONDS,
  type OperationFrame,
} from "@abridge/protocol";
import { LocalExecutor } from "./executor.js";
import { DesktopError, record } from "./errors.js";
import {
  type ClientConfig,
  OperationJournal,
  writePrivateJson,
  saveConfig,
  deleteCredential,
} from "./storage.js";
type Running = {
  controller: AbortController;
  capabilities: Set<string>;
  session: string;
  client: string;
  task: Promise<void>;
};
export type ClientOptions = {
  stateDir: string;
  config: ClientConfig;
  deviceKey: string;
  executor?: LocalExecutor;
  parentPid?: number;
  now?: () => number;
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export class DeviceClient {
  readonly executor: LocalExecutor;
  private journal?: OperationJournal;
  private socket?: WebSocket;
  private controlServer?: LocalControlServer;
  private epoch = 0;
  private deviceId = "";
  private owner = "";
  private sequence = 0;
  private lastAck = 0;
  private lease = DEVICE_LEASE_SECONDS;
  private readonly operations = new Map<string, Running>();
  private readonly closedSessions = new Set<string>();
  private serverCapabilities = new Set<string>();
  private status = "offline";
  private error = "";
  private stopping = false;
  private unbindAcknowledged?: () => void;
  private wake?: () => void;
  private reconnectAbort = new AbortController();
  private readonly now: () => number;
  private key: string;
  constructor(readonly options: ClientOptions) {
    this.now = options.now ?? (() => performance.now());
    this.key = options.deviceKey;
    this.executor =
      options.executor ??
      new LocalExecutor(undefined, async (id, stream, data) => {
        await this.send({
          type: "output",
          operation_id: id,
          connection_epoch: this.epoch,
          stream,
          data,
        });
      });
  }
  private async send(value: Record<string, unknown>): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN)
      throw new DesktopError("device_offline", "Device connection is closed");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new DesktopError("send_timeout", "Device connection stopped responding"));
      }, 5000);
      socket.send(JSON.stringify(value), (error) => {
        clearTimeout(timer);
        error ? reject(error) : resolve();
      });
    });
  }
  private async capabilities(): Promise<Record<string, boolean>> {
    const configured = this.options.config.capabilities;
    const result = Object.fromEntries(
      CAPABILITIES.map((cap) => [
        cap,
        DESKTOP_CAPABILITIES.includes(cap as (typeof DESKTOP_CAPABILITIES)[number]) &&
          configured[cap] === true,
      ]),
    );
    if (result.screen || result.input) {
      const diagnostics = await this.executor.diagnostics();
      const permissions = record(diagnostics.permissions) ? diagnostics.permissions : {};
      const driver = record(diagnostics.driver) ? diagnostics.driver : {};
      result.screen &&= driver.ready === true && permissions.screen === true;
      result.input &&= driver.ready === true && permissions.input === true;
    }
    return result;
  }
  async run(): Promise<void> {
    this.controlServer = await listenLocalControl(this.options.stateDir, (request) => this.control(request));
    let parentTimer: NodeJS.Timeout | undefined;
    let backoff = 1000;
    try {
      this.journal = new OperationJournal(join(this.options.stateDir, "operations.sqlite3"));
      await chmod(join(this.options.stateDir, "operations.sqlite3"), 0o600);
      if (this.options.parentPid)
        parentTimer = setInterval(() => {
          if (process.ppid !== this.options.parentPid) void this.stop();
        }, 500);
      while (!this.stopping) {
        if (this.options.config.revoked) {
          await new Promise<void>((resolve) => {
            this.wake = resolve;
          });
          continue;
        }
        try {
          await this.connect();
          backoff = 1000;
        } catch (error) {
          if (this.stopping) break;
          if (error instanceof DesktopError && error.code === "device_revoked") {
            this.options.config.revoked = true;
            await saveConfig(this.options.stateDir, this.options.config);
            this.status = "revoked";
            this.error = "Device credential revoked; bind this device again";
          } else {
            this.status = "offline";
            this.error = "Server connection unavailable";
          }
        } finally {
          await this.stopOperations();
          await this.executor.stop();
          await this.writeStatus();
        }
        if (!this.stopping && !this.options.config.revoked) {
          await delay(backoff, undefined, { signal: this.reconnectAbort.signal }).catch(() => {});
          backoff = Math.min(backoff * 2, 15000);
        }
      }
    } finally {
      if (parentTimer) clearInterval(parentTimer);
      try {
        await this.stopOperations();
        this.status = "offline";
        await this.writeStatus();
      } finally {
        try {
          await this.executor.shutdown();
        } finally {
          try {
            await this.controlServer?.close();
          } finally {
            this.journal?.close();
          }
        }
      }
    }
  }
  private async connect(): Promise<void> {
    const url = new URL(this.options.config.url);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = url.pathname.replace(/\/$/, "") + "/ws/device";
    this.status = "connecting";
    await this.writeStatus();
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.key}` },
      maxPayload: MAX_MESSAGE_BYTES,
      handshakeTimeout: 10000,
    });
    this.socket = socket;
    const frames: unknown[] = [];
    let notify: (() => void) | undefined,
      closed = false,
      failure: Error | undefined;
    socket.on("message", (data) => {
      try {
        frames.push(JSON.parse(data.toString()));
        if (frames.length > 64) {
          failure = new DesktopError("message_overflow", "Too many device messages");
          socket.terminate();
        }
        notify?.();
      } catch {
        failure = new DesktopError("protocol_error", "Invalid server message");
        socket.terminate();
      }
    });
    socket.on("close", () => {
      closed = true;
      notify?.();
    });
    socket.on("error", () => {
      failure ??= new DesktopError("connection_failed", "Server connection failed");
      notify?.();
    });
    socket.on("unexpected-response", (_request, response) => {
      failure = new DesktopError(
        response.statusCode === 401 || response.statusCode === 403 ? "device_revoked" : "connection_failed",
        "Device connection rejected",
      );
      response.resume();
      socket.terminate();
      notify?.();
    });
    const next = async (timeout: number): Promise<unknown> => {
      if (frames.length) return frames.shift();
      if (closed || failure) throw failure ?? new DesktopError("device_offline", "Device connection closed");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          notify = undefined;
          reject(new DesktopError("connection_timeout", "Server response timed out"));
        }, timeout);
        notify = () => {
          clearTimeout(timer);
          notify = undefined;
          resolve();
        };
      });
      if (frames.length) return frames.shift();
      throw failure ?? new DesktopError("device_offline", "Device connection closed");
    };
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new DesktopError("connection_timeout", "Connection timed out")),
          10000,
        );
        socket.once("open", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once("error", () => {
          clearTimeout(timer);
          reject(failure ?? new DesktopError("connection_failed", "Connection failed"));
        });
        socket.once("close", () => {
          clearTimeout(timer);
          reject(failure ?? new DesktopError("device_offline", "Connection closed"));
        });
      });
    } catch (error) {
      socket.terminate();
      if (this.socket === socket) this.socket = undefined;
      throw error;
    }
    try {
      await this.send({
        type: "hello",
        protocol: PROTOCOL_VERSION,
        platform: process.platform,
        version: VERSION,
        capabilities: await this.capabilities(),
        paused: this.options.config.paused,
      });
      const parsedWelcome = deviceWelcomeSchema.safeParse(await next(10000));
      if (!parsedWelcome.success) throw new DesktopError("protocol_error", "Invalid device welcome");
      const welcome = parsedWelcome.data;
      this.epoch = welcome.connection_epoch;
      this.deviceId = welcome.device_id;
      this.owner = welcome.owner_name;
      this.sequence = 0;
      this.closedSessions.clear();
      this.lastAck = this.now();
      this.lease = Math.min(DEVICE_LEASE_SECONDS, Math.max(1, welcome.lease_seconds));
      this.serverCapabilities = new Set(welcome.capabilities);
      this.status = "online";
      this.error = "";
      await this.writeStatus();
      const heartbeat = setInterval(() => {
        void this.heartbeat().catch(() => socket.terminate());
      }, HEARTBEAT_SECONDS * 1000);
      const lease = setInterval(() => {
        if (this.now() - this.lastAck > this.lease * 1000) socket.terminate();
      }, 500);
      try {
        while (!this.stopping && socket.readyState === WebSocket.OPEN) {
          const frame = await next(this.lease * 1000);
          if (!record(frame)) continue;
          await this.receive(frame);
        }
      } finally {
        clearInterval(heartbeat);
        clearInterval(lease);
      }
    } finally {
      socket.terminate();
      if (this.socket === socket) this.socket = undefined;
    }
  }
  private async heartbeat(): Promise<void> {
    await this.send({
      type: "heartbeat",
      connection_epoch: this.epoch,
      capabilities: await this.capabilities(),
      paused: this.options.config.paused,
    });
  }
  private async receive(frame: Record<string, unknown>): Promise<void> {
    if (frame.connection_epoch !== this.epoch) return;
    if (frame.type === "heartbeat_ack") {
      this.lastAck = this.now();
      return;
    }
    if (frame.type === "dispatch") {
      await this.dispatch(frame);
      return;
    }
    if (frame.type === "cancel" && Array.isArray(frame.operation_ids)) {
      await this.stopOperations(
        new Set(frame.operation_ids.filter((id): id is string => typeof id === "string")),
      );
      return;
    }
    if (frame.type === "session_close" && typeof frame.session_id === "string") {
      this.closedSessions.add(frame.session_id);
      await this.stopOperations(
        new Set([...this.operations].filter(([, op]) => op.session === frame.session_id).map(([id]) => id)),
      );
      await this.executor.closeSession(frame.session_id);
      return;
    }
    if (frame.type === "stop") {
      await this.stopOperations();
      await this.executor.stop();
      return;
    }
    if (frame.type === "revoke") {
      this.options.config.revoked = true;
      await saveConfig(this.options.stateDir, this.options.config);
      this.status = "revoked";
      await this.stopOperations();
      this.unbindAcknowledged?.();
      this.socket?.terminate();
    }
  }
  async dispatch(value: unknown): Promise<void> {
    const parsed = operationFrameSchema.safeParse(value);
    if (!parsed.success) {
      if (record(value) && typeof value.operation_id === "string")
        await this.refuse(value.operation_id, "invalid_dispatch", "Invalid operation frame");
      return;
    }
    const frame = parsed.data,
      id = frame.operation_id;
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !/^[A-Za-z0-9_-]{1,100}$/.test(frame.session_id)) {
      await this.refuse(id, "invalid_dispatch", "Invalid operation identity");
      return;
    }
    if (frame.connection_epoch !== this.epoch || frame.device_id !== this.deviceId) return;
    if (this.now() - this.lastAck >= this.lease * 1000 || this.socket?.readyState !== WebSocket.OPEN) {
      this.socket?.terminate();
      return;
    }
    if (
      frame.expires_at < Date.now() / 1000 ||
      frame.expires_at > Date.now() / 1000 + OPERATION_START_SECONDS + OPERATION_START_GRACE_SECONDS
    ) {
      await this.refuse(id, "dispatch_expired", "Operation start deadline expired");
      return;
    }
    if (TOOL_CAPABILITIES[frame.tool] === "browser") {
      await this.refuse(id, "capability_unavailable", "Use an independent browser device");
      return;
    }
    const hash = createHash("sha256")
      .update(canonical({ tool: frame.tool, arguments: frame.arguments, session_id: frame.session_id }))
      .digest("hex");
    const prior = this.journal!.get(id);
    if (prior) {
      await this.send({
        type: "result",
        operation_id: id,
        connection_epoch: this.epoch,
        status:
          prior.request_hash !== hash
            ? "refused"
            : prior.status === "executing"
              ? "outcome_unknown"
              : prior.status,
        result: { deduplicated: true, prior_status: prior.status },
        error: {
          code: prior.request_hash !== hash ? "idempotency_conflict" : "duplicate_operation",
          message:
            prior.request_hash !== hash
              ? "Operation identity reused with different arguments"
              : "Operation was already accepted; its effect will not be replayed",
        },
      });
      return;
    }
    if (frame.sequence <= this.sequence) {
      await this.refuse(id, "stale_sequence", "Operation sequence is stale");
      return;
    }
    this.sequence = frame.sequence;
    if (this.options.config.paused || this.options.config.revoked) {
      await this.refuse(id, "device_paused", "Local access is paused");
      return;
    }
    if (this.closedSessions.has(frame.session_id)) {
      await this.refuse(id, "session_closed", "This session is closed");
      return;
    }
    const required = requiredCapabilities(frame.tool, frame.arguments),
      capabilities = await this.capabilities();
    if (
      [...required].some(
        (cap) =>
          !capabilities[cap] ||
          !this.serverCapabilities.has(cap) ||
          !frame.session_capabilities.includes(cap),
      )
    ) {
      await this.refuse(id, "capability_unavailable", "Required capability is unavailable");
      return;
    }
    if (this.operations.size >= MAX_DEVICE_OPERATIONS) {
      await this.refuse(id, "device_busy", "Device operation limit reached");
      return;
    }
    if (
      this.options.config.paused ||
      this.options.config.revoked ||
      this.closedSessions.has(frame.session_id) ||
      this.now() - this.lastAck >= this.lease * 1000 ||
      this.socket?.readyState !== WebSocket.OPEN
    ) {
      await this.refuse(id, "device_paused", "Local access stopped during admission");
      return;
    }
    if ([...required].some((cap) => !this.options.config.capabilities[cap])) {
      await this.refuse(id, "capability_unavailable", "Capability disabled during admission");
      return;
    }
    if (frame.expires_at <= Date.now() / 1000) {
      await this.refuse(id, "dispatch_expired", "Operation start deadline expired during admission");
      return;
    }
    const controller = new AbortController();
    this.journal!.start(id, hash);
    const operation: Running = {
      controller,
      capabilities: required,
      session: frame.session_id,
      client: frame.client_name ?? "MCP Agent",
      task: Promise.resolve(),
    };
    this.operations.set(id, operation);
    operation.task = this.execute(frame, operation);
    void operation.task.catch(() => {});
    await this.writeStatus();
  }
  private async execute(frame: OperationFrame, operation: Running): Promise<void> {
    let status = "executed",
      result: Record<string, unknown> = {},
      error: Record<string, unknown> | undefined;
    try {
      operation.controller.signal.throwIfAborted();
      result = await this.executor.execute(
        frame.operation_id,
        frame.tool,
        frame.arguments,
        frame.session_id,
        operation.controller.signal,
      );
      operation.controller.signal.throwIfAborted();
      if (this.options.config.paused || this.options.config.revoked)
        throw new DesktopError("operation_cancelled", "Local access was stopped");
    } catch (cause) {
      if (
        operation.controller.signal.aborted ||
        !(cause instanceof DesktopError) ||
        ["outcome_unknown", "operation_cancelled"].includes(cause.code)
      ) {
        status = "outcome_unknown";
        error = {
          code: operation.controller.signal.aborted ? "operation_cancelled" : "outcome_unknown",
          message: "Execution result is unknown; the operation will not be replayed",
        };
      } else {
        status = cause.outcome;
        error = { code: cause.code, message: cause.message };
      }
      result = {};
    } finally {
      this.journal!.finish(frame.operation_id, status);
      this.operations.delete(frame.operation_id);
      await this.writeStatus();
    }
    if (this.epoch !== frame.connection_epoch) return;
    await this.send({
      type: "result",
      operation_id: frame.operation_id,
      connection_epoch: frame.connection_epoch,
      status,
      result,
      ...(error ? { error } : {}),
    });
  }
  private async refuse(id: string, code: string, message: string): Promise<void> {
    await this.send({
      type: "result",
      operation_id: id,
      connection_epoch: this.epoch,
      status: "refused",
      result: {},
      error: { code, message },
    });
  }
  async stopOperations(ids?: Set<string>): Promise<void> {
    const selected = [...this.operations].filter(([id]) => !ids || ids.has(id));
    for (const [, op] of selected) {
      op.controller.abort();
    }
    await Promise.allSettled(selected.map(([, op]) => op.task));
    for (const [, op] of selected)
      if (op.capabilities.has("input") || op.capabilities.has("screen"))
        this.executor.computer.invalidate(op.session);
  }
  async control(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const command = request.command;
    if (command === "status") return this.snapshot();
    if (command === "pause") {
      if (
        request.if_desktop_active === true &&
        ![...this.operations.values()].some((op) => op.capabilities.has("input"))
      )
        return { ignored: true };
      this.options.config.paused = true;
      this.options.config.pause_reason =
        request.reason === "desktop_input" || request.if_desktop_active === true ? "desktop_input" : "manual";
      await saveConfig(this.options.stateDir, this.options.config);
      await this.stopOperations();
      await this.executor.stop();
    } else if (command === "resume") {
      this.options.config.paused = false;
      delete this.options.config.pause_reason;
      await saveConfig(this.options.stateDir, this.options.config);
    } else if (command === "stop") {
      await this.stopOperations();
      await this.executor.stop();
      await this.send({ type: "local_stop", connection_epoch: this.epoch }).catch(() => {});
    } else if (command === "capability") {
      if (
        !DESKTOP_CAPABILITIES.includes(request.capability as (typeof DESKTOP_CAPABILITIES)[number]) ||
        typeof request.enabled !== "boolean"
      )
        throw new DesktopError("invalid_arguments", "Unknown desktop capability");
      this.options.config.capabilities[request.capability as string] = request.enabled;
      await saveConfig(this.options.stateDir, this.options.config);
      if (!request.enabled) {
        await this.stopOperations(
          new Set(
            [...this.operations]
              .filter(([, op]) => op.capabilities.has(request.capability as string))
              .map(([id]) => id),
          ),
        );
        if (request.capability === "screen" || request.capability === "input")
          await this.executor.computer.stop();
      }
    } else if (command === "unbind") {
      this.options.config.paused = true;
      this.options.config.revoked = true;
      await saveConfig(this.options.stateDir, this.options.config);
      await deleteCredential(this.options.stateDir);
      await this.stopOperations();
      let cloudRevoked = false;
      if (this.socket?.readyState === WebSocket.OPEN) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const acknowledged = new Promise<boolean>((resolve) => {
          this.unbindAcknowledged = () => resolve(true);
          timer = setTimeout(() => resolve(false), 5000);
        });
        try {
          await this.send({ type: "unbind", connection_epoch: this.epoch });
          cloudRevoked = await acknowledged;
        } catch {
        } finally {
          if (timer) clearTimeout(timer);
          this.unbindAcknowledged = undefined;
        }
      }
      this.key = "";
      await this.stop();
      return { unbound: true, cloud_revoked: cloudRevoked };
    } else throw new DesktopError("invalid_arguments", "Unknown local command");
    await this.writeStatus();
    if (this.socket?.readyState === WebSocket.OPEN) await this.heartbeat().catch(() => {});
    return this.snapshot();
  }
  async snapshot(): Promise<Record<string, unknown>> {
    const active = [...this.operations.values()];
    return {
      connection: this.status,
      paused: this.options.config.paused,
      pause_reason: this.options.config.pause_reason ?? "",
      capabilities: await this.capabilities(),
      requested_capabilities: this.options.config.capabilities,
      active_operations: this.operations.size,
      active_controllers: [...new Set(active.map((op) => op.client))],
      desktop_active_until: active.some((op) => op.capabilities.has("input")) ? Date.now() / 1000 + 30 : 0,
      url: this.options.config.url,
      error: this.error,
      device_id: this.deviceId,
      owner_name: this.owner,
      updated_at: Date.now() / 1000,
      ...(await this.executor.diagnostics(false)),
    };
  }
  private async writeStatus(): Promise<void> {
    await writePrivateJson(join(this.options.stateDir, "status.json"), await this.snapshot());
  }
  async stop(): Promise<void> {
    this.stopping = true;
    this.reconnectAbort.abort();
    this.wake?.();
    this.socket?.terminate();
  }
}
