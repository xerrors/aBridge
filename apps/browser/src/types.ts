/// <reference types="chrome" />
import { z } from "zod";
import { deviceRenameSchema, type OperationError, type BrowserStepFailure } from "@abridge/protocol";
export const CONNECTION_PAGE = "connection.html";
/** Values cross the extension's storage, UI message, and CDP boundaries. */
export interface BridgeError extends Error {
  code?: string;
  status?: BrowserStepFailure["status"];
  cleanup_error?: OperationError["cleanup_error"];
  recovery?: OperationError["recovery"];
}
export function errorDetails(value: unknown): BridgeError {
  if (value instanceof Error) return value;
  if (value && typeof value === "object") {
    const details = value as { code?: unknown; message?: unknown };
    return Object.assign(
      new Error(typeof details.message === "string" ? details.message : String(value)),
      typeof details.code === "string" ? { code: details.code } : {},
    );
  }
  return new Error(String(value));
}
export const fail = (code: string, message: string): BridgeError =>
  Object.assign(new Error(message), { code });
export interface ConnectionHistory {
  worker_started_at?: number;
  last_connected_at?: number;
  last_ack_at?: number;
  last_recovery_at?: number;
  last_disconnected_at?: number;
  last_close_code?: number;
  last_disconnect_reason?: string;
}
export interface BrowserProfile {
  key?: string;
  http_confirmed_origin?: string;
  revoked?: boolean;
  paused?: boolean;
  instance_id?: string;
  server?: string;
  device_id?: string;
  label?: string;
  platform_revision?: number;
}
export interface BrowserStatus {
  http_confirmed_origin?: string;
  ok: true;
  configured: boolean;
  revoked: boolean;
  paused: boolean;
  connected: boolean;
  label?: string;
  server?: string;
  device_id?: string;
  active_operations: number;
  active_sessions: number;
  connection_history: ConnectionHistory;
  authorizing?: boolean;
  binding_method?: "browser" | "token";
  authorization_expires_at?: number;
  authorization_error?: string;
  platform_revision?: number;
  replacement_pending?: boolean;
}
export type ControlType = "pause" | "resume" | "stop" | "unbind";
export type UiMessage =
  | { type: "status" }
  | { type: ControlType }
  | { type: "authorize_cancel" }
  | { type: "rename"; name: string }
  | {
      type: "authorize" | "bind_token";
      device_key?: string;
      http_confirmed_origin?: string;
      server: string;
      label?: string;
    };
export interface UiResponse {
  ok: boolean;
  error?: { code?: string; message: string };
}
export function element<T extends HTMLElement>(id: string, constructor: { new (...args: never[]): T }): T {
  const value = document.getElementById(id);
  if (!(value instanceof constructor)) throw new Error(`Missing ${id}`);
  return value;
}

export const uiMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status") }),
  z.object({ type: z.literal("authorize_cancel") }),
  deviceRenameSchema.extend({ type: z.literal("rename") }).strict(),
  z.object({ type: z.enum(["pause", "resume", "stop", "unbind"]) }),
  z.strictObject({
    type: z.literal("platform_binding"),
    action: z.enum(["resume", "confirm", "abort"]),
    revision: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("authorize"),
    server: z.string(),
    label: z.string(),
    http_confirmed_origin: z.string().optional(),
  }),
  z
    .object({
      type: z.literal("bind_token"),
      server: z.string(),
      device_key: z.string().startsWith("abr_device_").max(4096),
      http_confirmed_origin: z.string().optional(),
      platform_revision: z.number().int().positive().optional(),
    })
    .strict(),
]);
