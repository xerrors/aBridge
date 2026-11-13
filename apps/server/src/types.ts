import type { Capability, DeviceKind, ConnectionPolicy } from "@abridge/protocol";

export type JsonObject = Record<string, unknown>;

export interface User {
  id: string;
  username: string;
}
export interface Device {
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
export interface Grant {
  id: string;
  owner_id: string;
  name: string;
  policy: ConnectionPolicy;
  expires_at: number | null;
  token_digest: string;
  revoked_at: number | null;
  created_at: number;
  last_used: number | null;
}
export type SessionState =
  | "active"
  | "stopped"
  | "expired"
  | "revoked"
  | "connection_lost"
  | "connection_replaced"
  | "server_restarted";
export interface ControlSession {
  id: string;
  grant_id: string;
  device_id: string;
  capabilities: Capability[];
  lease_until: number;
  status: SessionState;
  created_at: number;
}
export type OperationState =
  "accepted" | "dispatched" | "executed" | "failed" | "refused" | "outcome_unknown" | "cancelled";
export interface Operation {
  id: string;
  owner_id: string;
  grant_id: string;
  device_id: string;
  session_id: string;
  tool: string;
  request_hash: string;
  status: OperationState;
  epoch: number;
  created_at: number;
  finished_at: number | null;
}
export interface OperationResponse extends JsonObject {
  operation_id: string;
  status: OperationState | "cancel_requested";
  result?: unknown;
  error?: { code: string; message: string };
  output?: { stdout: string; stderr: string };
}

/** Transport owns bounded I/O. Domain state never imports a WebSocket framework. */
export interface DeviceTransport {
  send(frame: JsonObject): Promise<void>;
  close(code: number, reason: string): Promise<void>;
}
export interface AttachedDevice {
  deviceId: string;
  epoch: number;
  credentialVersion: number;
  kind: DeviceKind;
  capabilities: Partial<Record<Capability, boolean>>;
  paused: boolean;
  platform: string;
  version: string;
  heartbeatAt: number;
  sequence: number;
  transport: DeviceTransport;
}

export class BridgeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409,
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
