import { createHash, randomBytes } from "node:crypto";
import {
  CAPABILITIES,
  PROTOCOL_VERSION,
  OPERATION_START_SECONDS,
  SESSION_IDLE_SECONDS,
  deviceCapabilities,
  deviceMetadataSchema,
  deviceSummaryDetailsSchema,
  requiredCapabilities,
  supportedDeviceTools,
  operationFrameSchema,
  deviceCancelSchema,
  parseDeviceToolRequest,
  operationIdPattern,
  deviceErrorSchema,
  type OperationError,
  type DeviceView,
  type ConnectionPreview,
  type SessionInfo,
  type ConnectionLoss,
  type Capability,
  type DeviceKind,
  type DeviceTool,
} from "@abridge/protocol";
import { BrowserExecutions } from "./browser-execution.js";
import { deviceAccess, agentConnectionExpired, sessionDeadline } from "./policy.js";
import { Store } from "./store.js";
import {
  BridgeError,
  monotonicSeconds,
  nowSeconds,
  object,
  type DeviceConnection,
  type ControlSession,
  type Device,
  type DeviceTransport,
  type AgentConnection,
  type JsonObject,
  type Operation,
  type OperationResponse,
  type OperationState,
  type SessionState,
} from "./types.js";

const FINAL_STATES = new Set<OperationState>([
  "executed",
  "failed",
  "refused",
  "outcome_unknown",
  "cancelled",
]);
const safeId = /^[A-Za-z0-9_-]{1,100}$/;
interface Pending {
  operation: Operation;
  cancelledByCaller?: boolean;
  required: Capability[];
  promise: Promise<OperationResponse>;
  resolve(response: OperationResponse): void;
  output: { stdout: string; stderr: string };
  starts: { stdout: number; stderr: number };
  parentId?: string;
}
interface Cached {
  response: OperationResponse;
  required: Capability[];
  bytes: number;
  finished: number;
}

function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(sortedJson).join(",") + "]";
  if (object(value))
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + sortedJson(value[key]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}

/** The only owner of connection/session/operation transitions and result publication. */
export class ControlService {
  private readonly browserExecutions = new BrowserExecutions();
  private readonly deviceConnections = new Map<string, DeviceConnection>();
  private readonly pending = new Map<string, Pending>();
  private readonly lastDisconnect = new Map<string, ConnectionLoss>();
  // Retain the last local policy across disconnects; offline status does not revoke completed results.
  private readonly localAccess = new Map<string, Pick<DeviceConnection, "capabilities" | "paused">>();
  private readonly cache = new Map<string, Cached>();
  private readonly attachQueues = new Map<string, Promise<unknown>>();
  private readonly stopping = new Map<string, number>();
  private readonly maintaining = new Set<string>();
  private cacheBytes = 0;
  private monitor: ReturnType<typeof setInterval> | undefined;
  private shuttingDown = false;
  constructor(
    readonly store: Store,
    private readonly now = nowSeconds,
    private readonly mono = monotonicSeconds,
  ) {}

  start(): void {
    if (!this.monitor) {
      this.monitor = setInterval(() => {
        void this.tick();
      }, 1000);
      this.monitor.unref();
    }
  }
  private currentAgentConnection(agentConnection: AgentConnection): AgentConnection {
    const current = this.store.agentConnection(agentConnection.id);
    if (
      !current ||
      current.token_digest !== agentConnection.token_digest ||
      current.revoked_at !== null ||
      agentConnectionExpired(current, this.now())
    )
      throw new BridgeError("unauthorized", "Agent connection is expired or revoked", 401);
    return current;
  }
  authorizedDevice(agentConnection: AgentConnection, deviceId: string): Device {
    const current = this.currentAgentConnection(agentConnection),
      device = this.store.device(deviceId);
    if (!device || device.owner_id !== current.owner_id || deviceAccess(current, device).access !== "allowed")
      throw new BridgeError("not_found", "Device does not exist or is not granted", 404);
    return device;
  }
  devices(agentConnection: AgentConnection): DeviceView[] {
    const current = this.currentAgentConnection(agentConnection);
    return this.store
      .devices(current.owner_id)
      .filter((device) => deviceAccess(current, device).access === "allowed")
      .map((device) => this.deviceView(device, current));
  }
  deviceView(
    device: Device,
    agentConnection?: AgentConnection,
    includeDetails = !agentConnection,
  ): DeviceView {
    const connection = this.deviceConnections.get(device.id),
      now = this.mono();
    const current = agentConnection ? this.currentAgentConnection(agentConnection) : undefined;
    const online = !!connection && now - connection.heartbeatAt <= 30;
    const capabilities = current
      ? deviceAccess(current, device).capabilities
      : device.capabilities.filter((cap) => deviceCapabilities(device.kind).includes(cap)).sort();
    const available = Object.fromEntries(
      capabilities.map((cap) => [cap, !!(online && connection?.capabilities[cap] && !connection.paused)]),
    );
    return {
      id: device.id,
      name: device.name,
      kind: device.kind,
      status: device.revoked_at !== null ? "revoked" : online ? "online" : "offline",
      paused: !!connection?.paused,
      capabilities,
      available,
      available_tools: supportedDeviceTools(device.kind, device.platform).filter((tool) =>
        [...requiredCapabilities(tool, {})].every((cap) => available[cap]),
      ),
      platform: device.platform,
      version: device.version,
      ...(device.details
        ? { details: includeDetails ? device.details : deviceSummaryDetailsSchema.parse(device.details) }
        : {}),
      ...(includeDetails ? { owner_name: this.store.user(device.owner_id)?.username } : {}),
      last_seen: device.last_seen,
      created_at: device.created_at,
      ...(current ? { sessions: this.activeSessions(current, device.id) } : {}),
      ...(this.lastDisconnect.has(device.id) ? { last_disconnect: this.lastDisconnect.get(device.id) } : {}),
      active_operations: [...this.pending.values()]
        .filter(
          (p) =>
            p.operation.device_id === device.id &&
            (!agentConnection || p.operation.agent_connection_id === agentConnection.id),
        )
        .map((p) => p.operation.id),
    };
  }
  private readyConnection(deviceId: string): DeviceConnection {
    if (this.shuttingDown) throw new BridgeError("server_stopping", "Server is stopping", 503);
    if (this.stopping.has(deviceId))
      throw new BridgeError("device_busy", "Device is stopping existing operations", 409);
    const connection = this.deviceConnections.get(deviceId),
      device = this.store.device(deviceId);
    if (
      !connection ||
      this.mono() - connection.heartbeatAt > 30 ||
      !device ||
      device.revoked_at !== null ||
      device.credential_version !== connection.credentialVersion ||
      device.epoch !== connection.epoch
    )
      throw new BridgeError("device_offline", "Device is offline; no other device will be selected");
    if (connection.paused) throw new BridgeError("device_paused", "Resume access locally before continuing");
    return connection;
  }
  openSession(
    agentConnection: AgentConnection,
    deviceId: string,
    capabilities: Capability[],
  ): ControlSession {
    const current = this.currentAgentConnection(agentConnection),
      device = this.authorizedDevice(current, deviceId);
    if (
      !capabilities.length ||
      new Set(capabilities).size !== capabilities.length ||
      capabilities.some((cap) => !CAPABILITIES.includes(cap))
    )
      throw new BridgeError("invalid_capabilities", "Select valid, unique capabilities", 422);
    if (capabilities.some((cap) => !deviceAccess(current, device).capabilities.includes(cap)))
      throw new BridgeError("forbidden", "Requested capability is not granted", 403);
    const connection = this.readyConnection(deviceId);
    if (capabilities.some((cap) => !connection.capabilities[cap]))
      throw new BridgeError("capability_unavailable", "Local capability is disabled or unavailable");
    const occupied = this.store
      .sessions(deviceId)
      .filter((session) => session.lease_until > this.now() && session.capabilities.includes("input"));
    if (capabilities.includes("input") && occupied.length)
      throw new BridgeError(
        "desktop_busy",
        "Desktop input is occupied; reuse your active session or close it before opening another",
        409,
        {
          sessions: occupied
            .filter((session) => session.agent_connection_id === current.id)
            .map((session) => this.sessionInfo(session)),
        },
      );
    return this.store.createSession(
      current,
      deviceId,
      capabilities,
      sessionDeadline(current, this.now() + SESSION_IDLE_SECONDS),
    );
  }
  sessionInfo(session: ControlSession): SessionInfo {
    return {
      id: session.id,
      device_id: session.device_id,
      capabilities: session.capabilities,
      status: session.status === "active" && session.lease_until <= this.now() ? "expired" : session.status,
      lease_until: session.lease_until,
      server_time: this.now(),
    };
  }
  private activeSessions(agentConnection: AgentConnection, deviceId: string): SessionInfo[] {
    return this.store
      .sessions(deviceId)
      .filter(
        (session) => session.agent_connection_id === agentConnection.id && session.lease_until > this.now(),
      )
      .map((session) => this.sessionInfo(session));
  }
  /** Only authorized activity renews a live session; retained results never revive ended sessions. */
  private renewSession(agentConnection: AgentConnection, sessionId: string): void {
    const session = this.store.session(sessionId),
      device = session && this.store.device(session.device_id),
      connection = device && this.deviceConnections.get(device.id);
    if (
      !session ||
      session.agent_connection_id !== agentConnection.id ||
      session.status !== "active" ||
      (session.lease_until <= this.now() &&
        ![...this.pending.values()].some((p) => p.operation.session_id === sessionId)) ||
      agentConnection.revoked_at !== null ||
      agentConnectionExpired(agentConnection, this.now()) ||
      !device ||
      !connection ||
      connection.paused ||
      this.mono() - connection.heartbeatAt > 30 ||
      session.capabilities.some(
        (cap) =>
          !deviceAccess(agentConnection, device).capabilities.includes(cap) || !connection.capabilities[cap],
      )
    )
      return;
    this.store.renewSession(sessionId, sessionDeadline(agentConnection, this.now() + SESSION_IDLE_SECONDS));
  }
  private operationResponse(
    agentConnection: AgentConnection,
    operation: Operation,
    response: OperationResponse,
  ): OperationResponse {
    this.renewSession(this.currentAgentConnection(agentConnection), operation.session_id);
    const session = this.store.session(operation.session_id)!;
    return { ...response, session: this.sessionInfo(session) };
  }
  private operationKey(agentConnection: AgentConnection, sessionId: string, requested: string): string {
    return createHash("sha256")
      .update(JSON.stringify([agentConnection.id, sessionId, requested]))
      .digest("base64url");
  }
  private executionId(agentConnection: AgentConnection, sessionId: string, requested?: string): string {
    if (requested === undefined) {
      let id: string;
      do id = "op_" + randomBytes(6).toString("base64url");
      while (this.store.operation(id));
      return id;
    }
    if (!safeId.test(requested))
      throw new BridgeError("invalid_operation_id", "Invalid operation identifier", 422);
    if (operationIdPattern.test(requested)) {
      if (!this.store.operation(requested))
        throw new BridgeError(
          "invalid_operation_id",
          "Unknown operation_id; this format is reserved for returned IDs and cannot start or replay work",
          422,
        );
      const previous = this.authorizedOperation(agentConnection, requested);
      if (previous.session_id !== sessionId)
        throw new BridgeError(
          "operation_conflict",
          "A returned operation_id belongs to its original session; query its status before continuing",
        );
      return requested;
    }
    // Keep public IDs short. The full scoped key remains durable, so truncation
    // collisions cannot merge distinct writes or change an established retry ID.
    const keyHash = this.operationKey(agentConnection, sessionId, requested);
    const previous = this.store.operationForKey(keyHash);
    if (previous) return previous.id;
    let candidate = keyHash;
    let probe = 0;
    while (this.store.operation("op_" + candidate.slice(0, 8)))
      candidate = createHash("sha256")
        .update(keyHash + ":" + ++probe)
        .digest("base64url");
    return "op_" + candidate.slice(0, 8);
  }
  private authorizedSession(agentConnection: AgentConnection, id: string): ControlSession {
    this.currentAgentConnection(agentConnection);
    const session = this.store.session(id);
    if (!session || session.agent_connection_id !== agentConnection.id)
      throw new BridgeError("not_found", "Session does not exist or is not granted", 404);
    if (session.status === "expired" || (session.status === "active" && session.lease_until <= this.now()))
      throw new BridgeError("session_expired", "Idle session expired; open a new session", 409, {
        session: this.sessionInfo(session),
      });
    if (session.status !== "active") {
      if (this.deviceConnections.get(session.device_id)?.paused)
        throw new BridgeError("device_paused", "Resume access locally and open a new session");
      const reasons: Partial<Record<SessionState, string>> = {
        connection_lost: "session_connection_lost",
        connection_replaced: "session_connection_replaced",
        server_restarted: "session_server_restarted",
        revoked: "session_revoked",
      };
      throw new BridgeError(
        reasons[session.status] ?? "session_stopped",
        "Session ended; open a new session and observe before continuing. Never replay an unknown side effect",
        409,
        { session: this.sessionInfo(session) },
      );
    }
    return session;
  }
  async closeSession(agentConnection: AgentConnection, id: string): Promise<JsonObject> {
    const session = this.authorizedSession(agentConnection, id);
    await this.endSession(session, "Session closed");
    return { session_id: id, status: "stopped" };
  }
  private async endSession(
    session: ControlSession,
    reason: string,
    status: SessionState = "stopped",
  ): Promise<void> {
    this.browserExecutions.closeSession(session.id);
    this.store.closeSession(session.id, status);
    await this.cancelMatching(session.device_id, reason, { sessionId: session.id });
    const connection = this.deviceConnections.get(session.device_id);
    if (connection)
      await this.safeSend(connection, {
        type: "session_close",
        session_id: session.id,
        connection_epoch: connection.epoch,
        reason,
      });
  }
  private authorizedOperation(agentConnection: AgentConnection, id: string): Operation {
    const current = this.currentAgentConnection(agentConnection);
    const operation = this.store.operation(id);
    if (
      !operation ||
      operation.owner_id !== agentConnection.owner_id ||
      operation.agent_connection_id !== agentConnection.id
    )
      throw new BridgeError("not_found", "Operation does not exist or is not granted", 404);
    this.authorizedDevice(current, operation.device_id);
    return operation;
  }
  private authorizeResultAccess(
    agentConnection: AgentConnection,
    operation: Operation,
    required: Capability[],
  ): void {
    const current = this.currentAgentConnection(agentConnection);
    const device = this.authorizedDevice(current, operation.device_id);
    if (required.some((cap) => !deviceAccess(current, device).capabilities.includes(cap)))
      throw new BridgeError("forbidden", "Result is outside the current capability intersection", 403);
    const local = this.localAccess.get(device.id);
    if (local?.paused) throw new BridgeError("device_paused", "Resume access locally before reading results");
    if (local && required.some((cap) => !local.capabilities[cap]))
      throw new BridgeError("capability_unavailable", "Local capability is disabled or unavailable");
  }
  operationStatus(agentConnection: AgentConnection, id: string): OperationResponse {
    const operation = this.authorizedOperation(agentConnection, id),
      cached = this.cache.get(id);
    if (cached) {
      this.authorizeResultAccess(agentConnection, operation, cached.required);
      return this.operationResponse(agentConnection, operation, cached.response);
    }
    const response: OperationResponse = { operation_id: id, status: operation.status },
      pending = this.pending.get(id);
    if (pending) {
      this.authorizeResultAccess(agentConnection, operation, pending.required);
      response.output = { ...pending.output };
      if (pending.starts.stdout || pending.starts.stderr)
        response.output_start_offsets = { ...pending.starts };
    } else if (operation.status === "executed") {
      response.result_available = false;
      response.message = "Temporary result expired; the operation will not be executed again";
    }
    return this.operationResponse(agentConnection, operation, response);
  }
  async waitOperation(
    agentConnection: AgentConnection,
    id: string,
    waitSeconds = 15,
  ): Promise<OperationResponse> {
    if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 30)
      throw new BridgeError("invalid_wait", "wait_seconds must be 0–30", 422);
    return this.awaitReceipt(agentConnection, id, waitSeconds);
  }
  private async awaitReceipt(
    agentConnection: AgentConnection,
    id: string,
    waitSeconds: number,
  ): Promise<OperationResponse> {
    const operation = this.authorizedOperation(agentConnection, id);
    const pending = this.pending.get(id),
      required = pending?.required ?? this.cache.get(id)?.required;
    if (required) this.authorizeResultAccess(agentConnection, operation, required);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result =
        pending && waitSeconds > 0
          ? await Promise.race([
              pending.promise,
              new Promise<undefined>((resolve) => {
                timer = setTimeout(() => resolve(undefined), waitSeconds * 1000);
              }),
            ])
          : undefined;
      // This is the single access seam for both synchronous and yielding tools.
      const currentOperation = this.authorizedOperation(agentConnection, id);
      if (required) this.authorizeResultAccess(agentConnection, currentOperation, required);
      return result
        ? this.operationResponse(agentConnection, currentOperation, result)
        : this.operationStatus(agentConnection, id);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async execute(
    agentConnection: AgentConnection,
    sessionId: string,
    requestedTool: DeviceTool,
    input: unknown,
    operationId?: string,
    wait = true,
    parentId?: string,
  ): Promise<OperationResponse> {
    const { tool, arguments: args } = parseDeviceToolRequest({ tool: requestedTool, arguments: input });
    // Input preparation, transport and the bounded follow-up observation share the usual 30s.
    // A native hold and an explicit verification run sequentially before that observation.
    const extraMilliseconds =
      tool === "browser_act" || tool === "browser_locate_act"
        ? (args.action.type === "click" ? (args.action.hold_ms ?? 0) : 0) + (args.verify?.timeout_ms ?? 0)
        : 0;
    const deadline = this.mono() + 30 + extraMilliseconds / 1000,
      current = this.currentAgentConnection(agentConnection),
      session = this.authorizedSession(current, sessionId),
      device = this.authorizedDevice(current, session.device_id);
    const required = [...requiredCapabilities(tool, args)];
    if (
      required.some(
        (cap) =>
          !session.capabilities.includes(cap) || !deviceAccess(current, device).capabilities.includes(cap),
      )
    )
      throw new BridgeError("forbidden", "Operation is outside the current capability intersection", 403);
    const requestHash = createHash("sha256")
        .update(sortedJson({ tool, arguments: args, session_id: sessionId }))
        .digest("hex"),
      id = this.executionId(current, sessionId, operationId);
    const previous = this.store.operation(id);
    if (previous) {
      this.authorizedOperation(current, id);
      if (previous.request_hash !== requestHash)
        throw new BridgeError(
          "operation_conflict",
          "An operation identifier cannot be reused with different arguments",
        );
      return this.operationStatus(current, id);
    }
    if (!supportedDeviceTools(device.kind, device.platform).includes(tool))
      throw new BridgeError(
        "unsupported_tool",
        "Select a tool from the device or session's available_tools",
        422,
        {
          recovery: { action: "select_supported_tool" },
        },
      );
    if (
      tool === "browser_exec" &&
      [...this.pending.values()].some((pending) => pending.operation.session_id === sessionId)
    )
      throw new BridgeError("session_busy", "Session already has an operation in progress", 409);
    const activeCode = this.browserExecutions.owner(sessionId);
    if (activeCode && activeCode !== parentId)
      throw new BridgeError("session_busy", "Browser code owns this session until it finishes", 409);
    if (parentId && (!this.pending.has(parentId) || activeCode !== parentId))
      throw new BridgeError("operation_cancelled", "Parent browser execution ended", 409);
    const connection = this.readyConnection(device.id);
    if (required.some((cap) => !connection.capabilities[cap]))
      throw new BridgeError("capability_unavailable", "Local capability is disabled or unavailable");
    if (
      this.pending.size >= 64 ||
      [...this.pending.values()].filter((p) => p.operation.device_id === device.id).length >= 8
    )
      throw new BridgeError("busy", "Device execution queue is full", 429);
    this.store.createOperation({
      id,
      owner_id: current.owner_id,
      agent_connection_id: current.id,
      device_id: device.id,
      session_id: sessionId,
      tool,
      request_hash: requestHash,
      key_hash:
        operationId !== undefined && !operationIdPattern.test(operationId)
          ? this.operationKey(current, sessionId, operationId)
          : null,
      epoch: connection.epoch,
    });
    let resolve!: (value: OperationResponse) => void;
    const promise = new Promise<OperationResponse>((done) => {
      resolve = done;
    });
    this.pending.set(id, {
      operation: this.store.operation(id)!,
      required,
      promise,
      resolve,
      output: { stdout: "", stderr: "" },
      starts: { stdout: 0, stderr: 0 },
      parentId,
    });
    this.renewSession(current, sessionId);
    if (tool === "browser_exec") {
      this.browserExecutions.start(id, sessionId, args, {
        identifyStep: (key) => this.executionId(current, sessionId, key),
        executeStep: (stepTool, stepArgs, key) =>
          this.execute(current, sessionId, stepTool, stepArgs, key, true, id),
        exists: (stepId) => this.store.operation(stepId) !== undefined,
        receipt: (stepId) => this.cache.get(stepId)?.response,
        complete: (status, result, error) => this.finish(id, status, result, error),
      });
      if (!wait) return this.operationStatus(current, id);
      return this.waitOperation(current, id, 15);
    }
    const sent = await this.safeSend(
      connection,
      operationFrameSchema.parse({
        type: "dispatch",
        protocol: PROTOCOL_VERSION,
        operation_id: id,
        session_id: sessionId,
        session_capabilities: session.capabilities,
        device_id: device.id,
        client_name: current.name,
        connection_epoch: connection.epoch,
        device_credential_version: device.credential_version,
        sequence: ++connection.sequence,
        expires_at: this.now() + OPERATION_START_SECONDS,
        tool,
        arguments: args,
      }),
    );
    if (!sent)
      this.finish(id, "outcome_unknown", undefined, {
        code: "connection_lost",
        message: "Connection lost during delivery; execution will not be replayed",
      });
    if (!wait) return this.operationStatus(current, id);
    const response = await this.awaitReceipt(current, id, Math.max(0, deadline - this.mono()));
    if (this.pending.has(id)) {
      // Request cancellation without adding an unbounded send to the response deadline.
      void this.cancelMatching(device.id, "Result deadline exceeded", { operationId: id });
      const screenRead = required.length === 1 && required[0] === "screen";
      this.finish(id, screenRead ? "failed" : "outcome_unknown", undefined, {
        code: "result_timeout",
        message: screenRead
          ? "No desktop read result arrived before the deadline. Request a fresh read in this session."
          : "No terminal receipt; observe the target before continuing",
      });
      return this.operationStatus(current, id);
    }
    return response;
  }
  async cancelOperation(agentConnection: AgentConnection, id: string): Promise<OperationResponse> {
    const operation = this.authorizedOperation(agentConnection, id);
    const active = this.store.session(operation.session_id)?.status === "active";
    const pending = this.pending.get(id);
    if (active && pending) pending.cancelledByCaller = true;
    await this.cancelMatching(operation.device_id, "Cancelled by caller", {
      operationId: id,
      callerRequested: active,
    });
    const response = await this.waitOperation(agentConnection, id, 15);
    return this.pending.has(id) ? { ...response, status: "cancel_requested" } : response;
  }
  private async cancelMatching(
    deviceId: string,
    reason: string,
    scope: {
      operationId?: string;
      sessionId?: string;
      agentConnectionId?: string;
      callerRequested?: boolean;
    } = {},
  ): Promise<void> {
    const ids = [...this.pending.values()]
      .filter(
        ({ operation: o }) =>
          o.device_id === deviceId &&
          (!scope.operationId || o.id === scope.operationId) &&
          (!scope.sessionId || o.session_id === scope.sessionId) &&
          (!scope.agentConnectionId || o.agent_connection_id === scope.agentConnectionId),
      )
      .map((p) => p.operation.id);
    const parents = new Set(ids);
    for (const pending of this.pending.values()) {
      if (pending.parentId && parents.has(pending.parentId) && !ids.includes(pending.operation.id))
        ids.push(pending.operation.id);
    }
    for (const id of ids) this.browserExecutions.cancel(id, reason);
    const connection = this.deviceConnections.get(deviceId);
    if (ids.length && connection)
      await this.safeSend(
        connection,
        deviceCancelSchema.parse({
          type: "cancel",
          operation_ids: ids,
          connection_epoch: connection.epoch,
          ...(scope.callerRequested && { caller_operation_id: scope.operationId }),
          reason,
        }),
      );
  }
  async stopDevice(
    deviceId: string,
    reason = "Device owner stopped execution",
    status: SessionState = "stopped",
  ): Promise<void> {
    this.stopping.set(deviceId, (this.stopping.get(deviceId) ?? 0) + 1);
    try {
      for (const session of this.store.sessions(deviceId)) {
        this.browserExecutions.closeSession(session.id);
        this.store.closeSession(session.id, status);
      }
      const connection = this.deviceConnections.get(deviceId);
      await this.cancelMatching(deviceId, reason);
      if (connection)
        await this.safeSend(connection, { type: "stop", connection_epoch: connection.epoch, reason });
    } finally {
      const count = (this.stopping.get(deviceId) ?? 1) - 1;
      if (count) this.stopping.set(deviceId, count);
      else this.stopping.delete(deviceId);
    }
  }
  async disableCapabilities(deviceId: string, capabilities: Capability[]): Promise<void> {
    await Promise.allSettled(
      this.store
        .sessions(deviceId)
        .filter((session) => session.capabilities.some((cap) => capabilities.includes(cap)))
        .map((session) => this.endSession(session, "Local capability disabled")),
    );
  }
  connectionInfo(agentConnection: AgentConnection): { id: string; name: string } {
    const current = this.currentAgentConnection(agentConnection);
    return { id: current.id, name: current.name };
  }
  previewAgentConnection(agentConnection: AgentConnection): ConnectionPreview {
    return {
      connection: {
        id: agentConnection.id,
        name: agentConnection.name,
        expires_at: agentConnection.expires_at,
        status:
          agentConnection.revoked_at !== null
            ? "revoked"
            : agentConnectionExpired(agentConnection, this.now())
              ? "expired"
              : "active",
      },
      devices: this.store
        .devices(agentConnection.owner_id)
        .filter((device) => device.revoked_at === null)
        .map((device) => {
          const access = deviceAccess(agentConnection, device),
            view = this.deviceView(device);
          return {
            ...view,
            available: Object.fromEntries(
              device.capabilities.map((cap) => [
                cap,
                access.capabilities.includes(cap) &&
                  !agentConnectionExpired(agentConnection, this.now()) &&
                  agentConnection.revoked_at === null &&
                  !!view.available[cap],
              ]),
            ),
            access: access.access,
            granted_capabilities: access.capabilities,
          };
        }),
    };
  }
  private async endAgentConnectionSession(session: ControlSession, reason: string): Promise<void> {
    await this.endSession(session, reason, "revoked");
    for (const { operation } of [...this.pending.values()])
      if (operation.session_id === session.id)
        this.finish(operation.id, "outcome_unknown", undefined, {
          code: "authorization_changed",
          message: "Authorization changed while execution was in progress; observe before retrying",
        });
  }
  async updateAgentConnection(
    agentConnection: AgentConnection,
    name: string,
    policy: AgentConnection["policy"],
    expiresAt: number | null,
  ): Promise<AgentConnection> {
    const updated = this.store.updateAgentConnection(agentConnection.id, name, policy, expiresAt);
    await Promise.allSettled(
      this.store.agentConnectionSessions(agentConnection.id).map(async (session) => {
        const device = this.store.device(session.device_id);
        const capabilities = device ? deviceAccess(updated, device).capabilities : [];
        if (
          agentConnectionExpired(updated, this.now()) ||
          session.capabilities.some((cap) => !capabilities.includes(cap))
        )
          await this.endAgentConnectionSession(session, "Connection permissions changed");
        else this.store.renewSession(session.id, sessionDeadline(updated, session.lease_until));
      }),
    );
    return updated;
  }
  async rotateAgentConnection(
    agentConnection: AgentConnection,
  ): Promise<{ agentConnection: AgentConnection; key: string }> {
    const result = this.store.rotateAgentConnection(agentConnection.id);
    await Promise.allSettled(
      this.store
        .agentConnectionSessions(agentConnection.id)
        .map((session) => this.endAgentConnectionSession(session, "Connection key rotated")),
    );
    return result;
  }
  async revokeAgentConnection(agentConnection: AgentConnection): Promise<void> {
    this.store.revokeAgentConnection(agentConnection.id);
    await Promise.allSettled(
      this.store
        .agentConnectionSessions(agentConnection.id)
        .map((session) => this.endAgentConnectionSession(session, "Agent connection revoked")),
    );
    this.store.audit(
      agentConnection.owner_id,
      null,
      agentConnection.id,
      null,
      "agent_connection_revoke",
      "revoked",
    );
  }
  async invalidateDevice(deviceId: string): Promise<void> {
    const connection = this.deviceConnections.get(deviceId);
    await this.stopDevice(deviceId, "Device credentials revoked", "revoked");
    if (connection) {
      await this.safeSend(connection, {
        type: "revoke",
        connection_epoch: connection.epoch,
        reason: "Device credentials revoked",
      });
      await connection.transport.close(4403, "Device credentials revoked").catch(() => {});
      this.dropConnection(connection, "revoked");
    }
  }
  async attachConnection(
    key: string,
    kind: DeviceKind,
    hello: JsonObject,
    transport: DeviceTransport,
  ): Promise<DeviceConnection> {
    const initial = this.store.authenticateDevice(key);
    if (!initial || initial.kind !== kind)
      throw new BridgeError("unauthorized", "Device key is invalid or has the wrong kind", 401);
    const metadata = deviceMetadataSchema.parse(hello);
    const previous = this.attachQueues.get(initial.id) ?? Promise.resolve();
    const attaching = previous
      .catch(() => {})
      .then(async () => {
        let device = this.store.authenticateDevice(key);
        if (!device || device.kind !== kind)
          throw new BridgeError("unauthorized", "Device key was revoked", 401);
        const old = this.deviceConnections.get(device.id);
        if (old) {
          await this.stopDevice(device.id, "Device connection replaced", "connection_replaced");
          await old.transport.close(4409, "Connection replaced").catch(() => {});
          this.dropConnection(old, "connection_replaced");
          device = this.store.authenticateDevice(key);
          if (!device || device.kind !== kind)
            throw new BridgeError("unauthorized", "Device key was revoked", 401);
        }
        const capabilities = object(hello.capabilities) ? hello.capabilities : {};
        const ticket: DeviceConnection = {
          deviceId: device.id,
          epoch: this.store.nextEpoch(device.id),
          credentialVersion: device.credential_version,
          kind,
          capabilities: Object.fromEntries(
            CAPABILITIES.map((cap) => [
              cap,
              capabilities[cap] === true && deviceCapabilities(kind).includes(cap),
            ]),
          ),
          paused: hello.paused === true,
          heartbeatAt: this.mono(),
          sequence: 0,
          transport,
        };
        this.deviceConnections.set(device.id, ticket);
        this.localAccess.set(device.id, { capabilities: ticket.capabilities, paused: ticket.paused });
        try {
          await transport.send({
            type: "welcome",
            protocol: PROTOCOL_VERSION,
            device_id: device.id,
            device_name: device.name,
            owner_name: this.store.user(device.owner_id)?.username ?? "",
            connection_epoch: ticket.epoch,
            capabilities: device.capabilities,
            heartbeat_interval: 10,
            lease_seconds: 30,
            server_time: this.now(),
          });
          if (this.deviceConnections.get(device.id) === ticket)
            this.store.updateDeviceMetadata(device.id, ticket.credentialVersion, ticket.epoch, metadata);
        } catch (error) {
          this.dropConnection(ticket);
          throw error;
        }
        return ticket;
      });
    this.attachQueues.set(initial.id, attaching);
    try {
      return await attaching;
    } finally {
      if (this.attachQueues.get(initial.id) === attaching) this.attachQueues.delete(initial.id);
    }
  }
  dropConnection(
    ticket: DeviceConnection,
    reason: ConnectionLoss["reason"] = "connection_lost",
    closeCode?: number,
  ): void {
    const diagnostic: ConnectionLoss = {
      reason,
      at: this.now(),
      connection_epoch: ticket.epoch,
      heartbeat_age_seconds: Math.max(0, this.mono() - ticket.heartbeatAt),
      ...(closeCode === undefined ? {} : { close_code: closeCode }),
    };
    const current = this.deviceConnections.get(ticket.deviceId) === ticket;
    if (current) {
      this.deviceConnections.delete(ticket.deviceId);
      this.lastDisconnect.set(ticket.deviceId, diagnostic);
    }
    for (const { operation: o } of [...this.pending.values()])
      if (o.device_id === ticket.deviceId && o.epoch === ticket.epoch)
        this.finish(o.id, "outcome_unknown", undefined, {
          code: "connection_lost",
          message: "Connection ended; operation will not be replayed",
          connection: diagnostic,
        });
    if (current)
      for (const session of this.store.sessions(ticket.deviceId)) {
        this.browserExecutions.closeSession(session.id);
        this.store.closeSession(
          session.id,
          reason === "server_restarted"
            ? "server_restarted"
            : reason === "connection_replaced"
              ? "connection_replaced"
              : reason === "revoked"
                ? "revoked"
                : "connection_lost",
        );
      }
  }
  async receive(ticket: DeviceConnection, message: JsonObject): Promise<void> {
    const device = this.store.device(ticket.deviceId);
    if (this.deviceConnections.get(ticket.deviceId) !== ticket || message.connection_epoch !== ticket.epoch)
      throw new BridgeError("stale_connection", "Connection epoch is no longer current");
    if (!device || device.revoked_at !== null || device.credential_version !== ticket.credentialVersion)
      throw new BridgeError("revoked", "Device credentials revoked");
    if (message.type === "unbind") {
      this.store.revokeDevice(device.id);
      await this.invalidateDevice(device.id);
      this.store.audit(device.owner_id, device.id, null, null, "device_unbind_local", "revoked");
      return;
    }
    if (message.type === "local_stop") {
      await this.stopDevice(device.id, "Stopped locally");
      return;
    }
    if (message.type === "heartbeat" || message.type === "capabilities") {
      const wasPaused = ticket.paused,
        old = { ...ticket.capabilities };
      if (message.capabilities !== undefined && !object(message.capabilities))
        throw new BridgeError("invalid_message", "Invalid capability state", 422);
      const values = object(message.capabilities) ? message.capabilities : ticket.capabilities;
      ticket.capabilities = Object.fromEntries(
        CAPABILITIES.map((cap) => [
          cap,
          values[cap] === true && deviceCapabilities(device.kind).includes(cap),
        ]),
      );
      ticket.paused = message.paused === undefined ? ticket.paused : message.paused === true;
      this.localAccess.set(device.id, { capabilities: ticket.capabilities, paused: ticket.paused });
      ticket.heartbeatAt = this.mono();
      this.store.touchDevice(device.id);
      if (ticket.paused && !wasPaused) await this.stopDevice(device.id, "Access paused locally");
      else
        await this.disableCapabilities(
          device.id,
          CAPABILITIES.filter((cap) => old[cap] && !ticket.capabilities[cap]),
        );
      await this.safeSend(ticket, {
        type: "heartbeat_ack",
        device_name: device.name,
        connection_epoch: ticket.epoch,
        lease_seconds: 30,
        server_time: this.now(),
      });
      return;
    }
    if (typeof message.operation_id !== "string") return;
    const pending = this.pending.get(message.operation_id);
    if (!pending || pending.operation.device_id !== device.id || pending.operation.epoch !== ticket.epoch)
      return;
    // browser_exec is owned and completed by the server runtime, never by a device receipt.
    if (pending.operation.tool === "browser_exec") return;
    if (message.type === "output") {
      if ((message.stream === "stdout" || message.stream === "stderr") && typeof message.data === "string") {
        const stream = message.stream,
          combined = Array.from(pending.output[stream] + message.data),
          removed = Math.max(0, combined.length - 65536);
        pending.starts[stream] += removed;
        pending.output[stream] = combined.slice(removed).join("");
      }
    } else if (message.type === "result") {
      if (typeof message.status !== "string" || !FINAL_STATES.has(message.status as OperationState))
        throw new BridgeError("invalid_result", "Invalid terminal operation state", 422);
      if (
        pending.cancelledByCaller &&
        pending.operation.tool === "computer_act" &&
        message.status === "executed" &&
        this.store.session(pending.operation.session_id)?.status !== "active"
      ) {
        this.finish(message.operation_id, "outcome_unknown", undefined, {
          code: "operation_cancelled",
          message: "Session ended before the action receipt arrived; the operation will not be replayed",
        });
        return;
      }
      const baseError =
        object(message.error) &&
        typeof message.error.code === "string" &&
        typeof message.error.message === "string"
          ? { code: message.error.code, message: message.error.message }
          : undefined;
      const boundedError = baseError
        ? { code: baseError.code.slice(0, 100), message: baseError.message.slice(0, 2000) }
        : undefined;
      const parsedError = deviceErrorSchema.safeParse(
        boundedError ? { ...(message.error as JsonObject), ...boundedError } : undefined,
      );
      const error: OperationError | undefined = parsedError.success ? parsedError.data : boundedError;
      if (error && message.status === "refused" && pending.operation.tool === "computer_act") {
        if (["stale_observation", "focus_changed", "focus_unavailable"].includes(error.code))
          error.recovery ??= { action: "observe_again" };
        else if (error.code === "protected_surface") error.recovery ??= { action: "user_handoff" };
      }
      this.finish(message.operation_id, message.status as OperationState, message.result, error);
    }
  }
  private finish(id: string, status: OperationState, result?: unknown, error?: OperationError): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    const scriptProgress = this.browserExecutions.end(id);
    if (result === undefined && scriptProgress !== undefined) result = scriptProgress;
    for (const child of this.pending.values())
      if (child.parentId === id)
        void this.cancelMatching(child.operation.device_id, "Parent browser execution ended", {
          operationId: child.operation.id,
        });
    const agentConnection = this.store.agentConnection(pending.operation.agent_connection_id);
    if (agentConnection) this.renewSession(agentConnection, pending.operation.session_id);
    this.store.finishOperation(id, status);
    const response: OperationResponse = { operation_id: id, status };
    if (result !== undefined) response.result = result;
    if (error) response.error = error;
    const bytes = Buffer.byteLength(JSON.stringify(response));
    this.cache.set(id, { response, required: pending.required, bytes, finished: this.now() });
    this.cacheBytes += bytes;
    this.pending.delete(id);
    while (this.cache.size > 128 || this.cacheBytes > 32 * 1024 * 1024) {
      const first = this.cache.keys().next().value as string | undefined;
      if (!first) break;
      this.cacheBytes -= this.cache.get(first)!.bytes;
      this.cache.delete(first);
    }
    pending.resolve(response);
  }
  private async safeSend(ticket: DeviceConnection, frame: JsonObject): Promise<boolean> {
    if (this.deviceConnections.get(ticket.deviceId) !== ticket) return false;
    try {
      await ticket.transport.send(frame);
      return true;
    } catch {
      this.dropConnection(ticket, "send_failed");
      await ticket.transport.close(1011, "Device transport failed").catch(() => {});
      return false;
    }
  }
  async tick(): Promise<void> {
    const work: Promise<void>[] = [];
    for (const ticket of this.deviceConnections.values()) {
      if (this.maintaining.has(ticket.deviceId)) continue;
      this.maintaining.add(ticket.deviceId);
      work.push(
        this.maintain(ticket)
          .catch(() => {
            this.dropConnection(ticket, "maintenance_failed");
          })
          .finally(() => this.maintaining.delete(ticket.deviceId)),
      );
    }
    for (const [id, cached] of this.cache)
      if (cached.finished < this.now() - 600) {
        this.cacheBytes -= cached.bytes;
        this.cache.delete(id);
      }
    await Promise.allSettled(work);
  }
  private async maintain(ticket: DeviceConnection): Promise<void> {
    if (this.deviceConnections.get(ticket.deviceId) !== ticket) return;
    if (this.mono() - ticket.heartbeatAt > 30) {
      this.dropConnection(ticket, "heartbeat_expired", 4408);
      await ticket.transport.close(4408, "Heartbeat expired").catch(() => {});
      return;
    }
    const device = this.store.device(ticket.deviceId);
    if (!device || device.revoked_at !== null || device.credential_version !== ticket.credentialVersion) {
      await this.invalidateDevice(ticket.deviceId);
      return;
    }
    await Promise.allSettled(
      this.store.sessions(ticket.deviceId).map(async (session) => {
        const agentConnection = this.store.agentConnection(session.agent_connection_id);
        if (
          !agentConnection ||
          agentConnection.revoked_at !== null ||
          agentConnectionExpired(agentConnection, this.now())
        )
          await this.endAgentConnectionSession(session, "Agent connection expired or revoked");
        else if ([...this.pending.values()].some((p) => p.operation.session_id === session.id))
          this.store.renewSession(
            session.id,
            sessionDeadline(agentConnection, this.now() + SESSION_IDLE_SECONDS),
          );
        else if (session.lease_until <= this.now())
          await this.endSession(session, "Idle session expired", "expired");
      }),
    );
  }
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.browserExecutions.closeAll();
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = undefined;
    const tickets = [...this.deviceConnections.values()];
    await Promise.allSettled(
      tickets.map(async (ticket) => {
        this.dropConnection(ticket, "server_restarted");
        await ticket.transport.close(1012, "Server is restarting").catch(() => {});
      }),
    );
  }
}
