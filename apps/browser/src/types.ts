/// <reference types="chrome" />
import { z } from "zod";
/** Values cross the extension's storage, UI message, and CDP boundaries. */
export interface BridgeError extends Error {
  code?: string;
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
  revoked?: boolean;
  paused?: boolean;
  instance_id?: string;
  server?: string;
  device_id?: string;
  label?: string;
}
export interface BrowserStatus {
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
}
export type ControlType = "pause" | "resume" | "stop" | "unbind";
export type UiMessage =
  | { type: "status" }
  | { type: ControlType }
  | {
      type: "register";
      server: string;
      username: string;
      password: string;
      label: string;
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
  z.object({ type: z.enum(["pause", "resume", "stop", "unbind"]) }),
  z.object({
    type: z.literal("register"),
    server: z.string(),
    username: z.string(),
    password: z.string(),
    label: z.string(),
  }),
]);
