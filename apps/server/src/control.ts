import { createHash } from "node:crypto";
import {
  CAPABILITIES,
  PROTOCOL_VERSION,
  SESSION_IDLE_SECONDS,
  deviceCapabilities,
  requiredCapabilities,
  operationFrameSchema,
  type Capability,
  type DeviceKind,
  type DeviceTool,
} from "@abridge/protocol";
import { deviceAccess, grantExpired, sessionDeadline } from "./policy.js";
import { Store, identifier } from "./store.js";
import {
  BridgeError,
  monotonicSeconds,
  nowSeconds,
  object,
  type AttachedDevice,
  type ControlSession,
  type Device,
  type DeviceTransport,
  type Grant,
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
  required: Capability[];
  promise: Promise<OperationResponse>;
  resolve(response: OperationResponse): void;
  output: { stdout: string; stderr: string };
  starts: { stdout: number; stderr: number };
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
  private readonly connections = new Map<string, AttachedDevice>();
  private readonly pending = new Map<string, Pending>();
  // Retain the last local policy across disconnects; offline status does not revoke completed results.
  private readonly localAccess = new Map<string, Pick<AttachedDevice, "capabilities" | "paused">>();
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
  private currentGrant(grant: Grant): Grant {
    const current = this.store.grant(grant.id);
    if (
      !current ||
      current.token_digest !== grant.token_digest ||
      current.revoked_at !== null ||
      grantExpired(current, this.now())
    )
      throw new BridgeError("unauthorized", "Agent grant is expired or revoked", 401);
    return current;
  }
  authorizedDevice(grant: Grant, deviceId: string): Device {
    const current = this.currentGrant(grant),
      device = this.store.device(deviceId);
    if (!device || device.owner_id !== current.owner_id || deviceAccess(current, device).access !== "allowed")
      throw new BridgeError("not_found", "Device does not exist or is not granted", 404);
    return device;
  }
  devices(grant: Grant): JsonObject[] {
    const current = this.currentGrant(grant);
    return this.store
      .devices(current.owner_id)
      .filter((device) => deviceAccess(current, device).access === "allowed")
      .map((device) => this.deviceView(device, current));
  }
  deviceView(device: Device, grant?: Grant): JsonObject {
    const connection = this.connections.get(device.id),
      now = this.mono();
    const current = grant ? this.currentGrant(grant) : undefined;
    const online = !!connection && now - connection.heartbeatAt <= 30;
    const capabilities = current
      ? deviceAccess(current, device).capabilities
      : device.capabilities.filter((cap) => deviceCapabilities(device.kind).includes(cap)).sort();
    return {
      id: device.id,
      name: device.name,
      kind: device.kind,
      status: device.revoked_at !== null ? "revoked" : online ? "online" : "offline",
      paused: !!connection?.paused,
      capabilities,
      available: Object.fromEntries(
        capabilities.map((cap) => [cap, !!(online && connection?.capabilities[cap] && !connection.paused)]),
      ),
      platform: connection?.platform ?? (device.kind === "browser" ? "Browser" : "macOS"),
      version: connection?.version ?? null,
      last_seen: device.last_seen,
      created_at: device.created_at,
      active_operations: [...this.pending.values()]
        .filter((p) => p.operation.device_id === device.id && (!grant || p.operation.grant_id === grant.id))
        .map((p) => p.operation.id),
    };
  }
  private readyConnection(deviceId: string): AttachedDevice {
    if (this.shuttingDown) throw new BridgeError("server_stopping", "Server is stopping", 503);
    if (this.stopping.has(deviceId))
      throw new BridgeError("device_busy", "Device is stopping existing operations", 409);
    const connection = this.connections.get(deviceId),
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
  openSession(grant: Grant, deviceId: string, capabilities: Capability[]): ControlSession {
    const current = this.currentGrant(grant),
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
    if (
      capabilities.includes("input") &&
      this.store
        .sessions(deviceId)
        .some((session) => session.lease_until > this.now() && session.capabilities.includes("input"))
    )
      throw new BridgeError("desktop_busy", "Desktop input belongs to another session");
    return this.store.createSession(
      current,
      deviceId,
      capabilities,
      sessionDeadline(current, this.now() + SESSION_IDLE_SECONDS),
    );
  }
  private authorizedSession(grant: Grant, id: string): ControlSession {
    this.currentGrant(grant);
    const session = this.store.session(id);
    if (!session || session.grant_id !== grant.id)
      throw new BridgeError("not_found", "Session does not exist or is not granted", 404);
    if (session.status === "expired" || (session.status === "active" && session.lease_until <= this.now()))
      throw new BridgeError("session_expired", "Idle session expired; open a new session");
    if (session.status !== "active") {
      if (this.connections.get(session.device_id)?.paused)
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
      );
    }
    return session;
  }
  async closeSession(grant: Grant, id: string): Promise<JsonObject> {
    const session = this.authorizedSession(grant, id);
    await this.endSession(session, "Session closed");
    return { session_id: id, status: "stopped" };
  }
  private async endSession(
    session: ControlSession,
    reason: string,
    status: SessionState = "stopped",
  ): Promise<void> {
    this.store.closeSession(session.id, status);
    await this.cancelMatching(session.device_id, reason, { sessionId: session.id });
    const connection = this.connections.get(session.device_id);
    if (connection)
      await this.safeSend(connection, {
        type: "session_close",
        session_id: session.id,
        connection_epoch: connection.epoch,
        reason,
      });
  }
  private authorizedOperation(grant: Grant, id: string): Operation {
    const current = this.currentGrant(grant);
    const operation = this.store.operation(id);
    if (!operation || operation.owner_id !== grant.owner_id || operation.grant_id !== grant.id)
      throw new BridgeError("not_found", "Operation does not exist or is not granted", 404);
    this.authorizedDevice(current, operation.device_id);
    return operation;
  }
  private authorizeResultAccess(grant: Grant, operation: Operation, required: Capability[]): void {
    const current = this.currentGrant(grant);
    const device = this.authorizedDevice(current, operation.device_id);
    if (required.some((cap) => !deviceAccess(current, device).capabilities.includes(cap)))
      throw new BridgeError("forbidden", "Result is outside the current capability intersection", 403);
    const local = this.localAccess.get(device.id);
    if (local?.paused) throw new BridgeError("device_paused", "Resume access locally before reading results");
    if (local && required.some((cap) => !local.capabilities[cap]))
      throw new BridgeError("capability_unavailable", "Local capability is disabled or unavailable");
  }
  operationStatus(grant: Grant, id: string): OperationResponse {
    const operation = this.authorizedOperation(grant, id),
      cached = this.cache.get(id);
    if (cached) {
      this.authorizeResultAccess(grant, operation, cached.required);
      return cached.response;
    }
    const response: OperationResponse = { operation_id: id, status: operation.status },
      pending = this.pending.get(id);
    if (pending) {
      this.authorizeResultAccess(grant, operation, pending.required);
      response.output = { ...pending.output };
      if (pending.starts.stdout || pending.starts.stderr)
        response.output_start_offsets = { ...pending.starts };
    } else if (operation.status === "executed") {
      response.result_available = false;
      response.message = "Temporary result expired; the operation will not be executed again";
    }
    return response;
  }
  async waitOperation(grant: Grant, id: string, waitSeconds = 15): Promise<OperationResponse> {
    if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 30)
      throw new BridgeError("invalid_wait", "wait_seconds must be 0–30", 422);
    const operation = this.authorizedOperation(grant, id);
    const pending = this.pending.get(id),
      required = pending?.required ?? this.cache.get(id)?.required;
    if (required) this.authorizeResultAccess(grant, operation, required);
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
      const currentOperation = this.authorizedOperation(grant, id);
      if (required) this.authorizeResultAccess(grant, currentOperation, required);
      return result ?? this.operationStatus(grant, id);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async execute(
    grant: Grant,
    sessionId: string,
    tool: DeviceTool,
    args: JsonObject,
    operationId?: string,
    wait = true,
  ): Promise<OperationResponse> {
    const deadline = this.mono() + 30,
      current = this.currentGrant(grant),
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
      id = operationId ?? identifier("op");
    if (!safeId.test(id)) throw new BridgeError("invalid_operation_id", "Invalid operation identifier", 422);
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
      grant_id: current.id,
      device_id: device.id,
      session_id: sessionId,
      tool,
      request_hash: requestHash,
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
    });
    this.store.renewSession(sessionId, sessionDeadline(current, this.now() + SESSION_IDLE_SECONDS));
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
        grant_version: device.credential_version,
        sequence: ++connection.sequence,
        expires_at: this.now() + 30,
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
    const response = await this.waitOperation(current, id, Math.max(0, Math.min(30, deadline - this.mono())));
    if (this.pending.has(id)) {
      // Request cancellation without adding an unbounded send to the response deadline.
      void this.cancelMatching(device.id, "Result deadline exceeded", { operationId: id });
      this.finish(id, "outcome_unknown", undefined, {
        code: "result_timeout",
        message: "No terminal receipt; observe the target before continuing",
      });
      return this.operationStatus(current, id);
    }
    return response;
  }
  async cancelOperation(grant: Grant, id: string): Promise<OperationResponse> {
    const operation = this.authorizedOperation(grant, id);
    await this.cancelMatching(operation.device_id, "Cancelled by caller", { operationId: id });
    const response = await this.waitOperation(grant, id, 15);
    return this.pending.has(id) ? { ...response, status: "cancel_requested" } : response;
  }
  private async cancelMatching(
    deviceId: string,
    reason: string,
    scope: { operationId?: string; sessionId?: string; grantId?: string } = {},
  ): Promise<void> {
    const ids = [...this.pending.values()]
      .filter(
        ({ operation: o }) =>
          o.device_id === deviceId &&
          (!scope.operationId || o.id === scope.operationId) &&
          (!scope.sessionId || o.session_id === scope.sessionId) &&
          (!scope.grantId || o.grant_id === scope.grantId),
      )
      .map((p) => p.operation.id);
    const connection = this.connections.get(deviceId);
    if (ids.length && connection)
      await this.safeSend(connection, {
        type: "cancel",
        operation_ids: ids,
        connection_epoch: connection.epoch,
        reason,
      });
  }
  async stopDevice(
    deviceId: string,
    reason = "Device owner stopped execution",
    status: SessionState = "stopped",
  ): Promise<void> {
    this.stopping.set(deviceId, (this.stopping.get(deviceId) ?? 0) + 1);
    try {
      for (const session of this.store.sessions(deviceId)) this.store.closeSession(session.id, status);
      const connection = this.connections.get(deviceId);
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
  connectionInfo(grant: Grant): { id: string; name: string } {
    const current = this.currentGrant(grant);
    return { id: current.id, name: current.name };
  }
  previewGrant(grant: Grant): JsonObject {
    return {
      connection: {
        id: grant.id,
        name: grant.name,
        expires_at: grant.expires_at,
        status:
          grant.revoked_at !== null ? "revoked" : grantExpired(grant, this.now()) ? "expired" : "active",
      },
      devices: this.store
        .devices(grant.owner_id)
        .filter((device) => device.revoked_at === null)
        .map((device) => {
          const access = deviceAccess(grant, device),
            view = this.deviceView(device);
          return {
            ...view,
            available: Object.fromEntries(
              device.capabilities.map((cap) => [
                cap,
                access.capabilities.includes(cap) &&
                  !grantExpired(grant, this.now()) &&
                  grant.revoked_at === null &&
                  !!(view.available as Record<string, boolean>)[cap],
              ]),
            ),
            access: access.access,
            granted_capabilities: access.capabilities,
          };
        }),
    };
  }
  private async endGrantSession(session: ControlSession, reason: string): Promise<void> {
    await this.endSession(session, reason, "revoked");
    for (const { operation } of [...this.pending.values()])
      if (operation.session_id === session.id)
        this.finish(operation.id, "outcome_unknown", undefined, {
          code: "authorization_changed",
          message: "Authorization changed while execution was in progress; observe before retrying",
        });
  }
  async updateGrant(
    grant: Grant,
    name: string,
    policy: Grant["policy"],
    expiresAt: number | null,
  ): Promise<Grant> {
    const updated = this.store.updateGrant(grant.id, name, policy, expiresAt);
    await Promise.allSettled(
      this.store.grantSessions(grant.id).map(async (session) => {
        const device = this.store.device(session.device_id);
        const capabilities = device ? deviceAccess(updated, device).capabilities : [];
        if (
          grantExpired(updated, this.now()) ||
          session.capabilities.some((cap) => !capabilities.includes(cap))
        )
          await this.endGrantSession(session, "Connection permissions changed");
        else this.store.renewSession(session.id, sessionDeadline(updated, session.lease_until));
      }),
    );
    return updated;
  }
  async rotateGrant(grant: Grant): Promise<{ grant: Grant; key: string }> {
    const result = this.store.rotateGrant(grant.id);
    await Promise.allSettled(
      this.store
        .grantSessions(grant.id)
        .map((session) => this.endGrantSession(session, "Connection key rotated")),
    );
    return result;
  }
  async revokeGrant(grant: Grant): Promise<void> {
    this.store.revokeGrant(grant.id);
    await Promise.allSettled(
      this.store
        .grantSessions(grant.id)
        .map((session) => this.endGrantSession(session, "Agent connection revoked")),
    );
    this.store.audit(grant.owner_id, null, grant.id, null, "client_grant_revoke", "revoked");
  }
  async invalidateDevice(deviceId: string): Promise<void> {
    const connection = this.connections.get(deviceId);
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
  ): Promise<AttachedDevice> {
    const initial = this.store.authenticateDevice(key);
    if (!initial || initial.kind !== kind)
      throw new BridgeError("unauthorized", "Device key is invalid or has the wrong kind", 401);
    const previous = this.attachQueues.get(initial.id) ?? Promise.resolve();
    const attaching = previous
      .catch(() => {})
      .then(async () => {
        const device = this.store.authenticateDevice(key);
        if (!device || device.kind !== kind)
          throw new BridgeError("unauthorized", "Device key was revoked", 401);
        const old = this.connections.get(device.id);
        if (old) {
          await this.stopDevice(device.id, "Device connection replaced", "connection_replaced");
          await old.transport.close(4409, "Connection replaced").catch(() => {});
          this.dropConnection(old, "connection_replaced");
        }
        const capabilities = object(hello.capabilities) ? hello.capabilities : {};
        const ticket: AttachedDevice = {
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
          platform: String(hello.platform ?? (kind === "browser" ? "Browser extension" : "macOS")).slice(
            0,
            80,
          ),
          version: String(hello.version ?? "unknown").slice(0, 30),
          heartbeatAt: this.mono(),
          sequence: 0,
          transport,
        };
        this.connections.set(device.id, ticket);
        this.localAccess.set(device.id, { capabilities: ticket.capabilities, paused: ticket.paused });
        try {
          await transport.send({
            type: "welcome",
            protocol: PROTOCOL_VERSION,
            device_id: device.id,
            owner_name: this.store.user(device.owner_id)?.username ?? "",
            connection_epoch: ticket.epoch,
            capabilities: device.capabilities,
            heartbeat_interval: 10,
            lease_seconds: 30,
          });
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
  dropConnection(ticket: AttachedDevice, reason = "connection_lost"): void {
    const current = this.connections.get(ticket.deviceId) === ticket;
    if (current) this.connections.delete(ticket.deviceId);
    for (const { operation: o } of [...this.pending.values()])
      if (o.device_id === ticket.deviceId && o.epoch === ticket.epoch)
        this.finish(o.id, "outcome_unknown", undefined, {
          code: "connection_lost",
          message: "Connection ended; operation will not be replayed",
        });
    if (current)
      for (const session of this.store.sessions(ticket.deviceId))
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
  async receive(ticket: AttachedDevice, message: JsonObject): Promise<void> {
    const device = this.store.device(ticket.deviceId);
    if (this.connections.get(ticket.deviceId) !== ticket || message.connection_epoch !== ticket.epoch)
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
        connection_epoch: ticket.epoch,
        lease_seconds: 30,
      });
      return;
    }
    if (typeof message.operation_id !== "string") return;
    const pending = this.pending.get(message.operation_id);
    if (!pending || pending.operation.device_id !== device.id || pending.operation.epoch !== ticket.epoch)
      return;
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
      const error =
        object(message.error) &&
        typeof message.error.code === "string" &&
        typeof message.error.message === "string"
          ? { code: message.error.code, message: message.error.message }
          : undefined;
      this.finish(message.operation_id, message.status as OperationState, message.result, error);
    }
  }
  private finish(
    id: string,
    status: OperationState,
    result?: unknown,
    error?: { code: string; message: string },
  ): void {
    const pending = this.pending.get(id);
    if (!pending) return;
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
  private async safeSend(ticket: AttachedDevice, frame: JsonObject): Promise<boolean> {
    if (this.connections.get(ticket.deviceId) !== ticket) return false;
    try {
      await ticket.transport.send(frame);
      return true;
    } catch {
      this.dropConnection(ticket);
      await ticket.transport.close(1011, "Device transport failed").catch(() => {});
      return false;
    }
  }
  async tick(): Promise<void> {
    const work: Promise<void>[] = [];
    for (const ticket of this.connections.values()) {
      if (this.maintaining.has(ticket.deviceId)) continue;
      this.maintaining.add(ticket.deviceId);
      work.push(
        this.maintain(ticket)
          .catch(() => {
            this.dropConnection(ticket);
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
  private async maintain(ticket: AttachedDevice): Promise<void> {
    if (this.connections.get(ticket.deviceId) !== ticket) return;
    if (this.mono() - ticket.heartbeatAt > 30) {
      this.dropConnection(ticket);
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
        const grant = this.store.grant(session.grant_id);
        if (!grant || grant.revoked_at !== null || grantExpired(grant, this.now()))
          await this.endGrantSession(session, "Agent connection expired or revoked");
        else if ([...this.pending.values()].some((p) => p.operation.session_id === session.id))
          this.store.renewSession(session.id, sessionDeadline(grant, this.now() + SESSION_IDLE_SECONDS));
        else if (session.lease_until <= this.now())
          await this.endSession(session, "Idle session expired", "expired");
      }),
    );
  }
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = undefined;
    const tickets = [...this.connections.values()];
    await Promise.allSettled(
      tickets.map(async (ticket) => {
        this.dropConnection(ticket, "server_restarted");
        await ticket.transport.close(1012, "Server is restarting").catch(() => {});
      }),
    );
  }
}
