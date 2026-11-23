import type {
  OperationError,
  OperationState,
  DeviceInteractionState,
  SessionInfo,
  SessionErrorDetails,
  SessionState,
} from "@abridge/protocol";
import type { Capability, DeviceKind, DeviceMetadata, ConnectionPolicy } from "@abridge/protocol";

export type JsonObject = Record<string, unknown>;

export interface User {
  id: string;
  username: string;
}
export interface Device extends DeviceMetadata {
  id: string;
  owner_id: string;
  name: string;
  capabilities: Capability[];
  token_digest: string;
  credential_version: number;
  epoch: number;
  revoked_at: number | null;
  created_at: number;
  last_seen: number | null;
  kind: DeviceKind;
}
export interface AgentConnection {
  id: string;
  owner_id: string;
  name: string;
  policy: ConnectionPolicy;
  expires_at: number | null;
  token_digest: string | null;
  revoked_at: number | null;
  created_at: number;
  last_used: number | null;
}
export type { OperationState, SessionState } from "@abridge/protocol";
export interface ControlSession {
  id: string;
  agent_connection_id: string;
  device_id: string;
  capabilities: Capability[];
  lease_until: number;
  status: SessionState;
  created_at: number;
}
export interface Operation {
  id: string;
  owner_id: string;
  agent_connection_id: string;
  device_id: string;
  session_id: string;
  tool: string;
  request_hash: string;
  key_hash: string | null;
  status: OperationState;
  epoch: number;
  created_at: number;
  finished_at: number | null;
}
export interface OperationResponse extends JsonObject {
  operation_id: string;
  status: OperationState | "cancel_requested";
  result?: unknown;
  error?: OperationError;
  session?: SessionInfo;
  output?: { stdout: string; stderr: string };
}

/** Transport owns bounded I/O. Domain state never imports a WebSocket framework. */
export interface DeviceTransport {
  send(frame: JsonObject): Promise<void>;
  close(code: number, reason: string): Promise<void>;
}
export interface DeviceConnection {
  deviceId: string;
  epoch: number;
  credentialVersion: number;
  kind: DeviceKind;
  capabilities: Partial<Record<Capability, boolean>>;
  paused: boolean;
  interactionState?: DeviceInteractionState;
  heartbeatAt: number;
  sequence: number;
  transport: DeviceTransport;
}

export class BridgeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409,
    public readonly details: SessionErrorDetails = {},
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

export function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function nowSeconds(): number {
  return Date.now() / 1000;
}
export function monotonicSeconds(): number {
  return performance.now() / 1000;
}
