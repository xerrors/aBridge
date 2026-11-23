/** Shared identities, capabilities and lifecycle metadata. */
import { z } from "zod";
import { portable } from "./portable.js";

export const CAPABILITIES = ["screen", "input", "shell", "files", "browser"] as const;
export type Capability = (typeof CAPABILITIES)[number];
export type DeviceKind = "computer" | "browser";
export const deviceInteractionStateSchema = z.enum(["ready", "screen_off", "locked"]);
export type DeviceInteractionState = z.infer<typeof deviceInteractionStateSchema>;
export const DESKTOP_CAPABILITIES = ["screen", "input", "shell", "files"] as const;
export const sessionStateSchema = z.enum([
  "active",
  "stopped",
  "expired",
  "revoked",
  "connection_lost",
  "connection_replaced",
  "server_restarted",
]);
export type SessionState = z.infer<typeof sessionStateSchema>;
export const sessionInfoSchema = z.object({
  id: z.string(),
  device_id: z.string(),
  capabilities: z.array(z.enum(CAPABILITIES)),
  status: sessionStateSchema,
  lease_until: z.number(),
  server_time: z.number(),
});
export type SessionInfo = z.infer<typeof sessionInfoSchema>;
export const deviceRecoverySchema = z.object({
  action: z.enum(["observe_again", "user_handoff", "select_supported_tool"]),
});
export interface SessionErrorDetails {
  session?: SessionInfo;
  sessions?: SessionInfo[];
  recovery?: z.infer<typeof deviceRecoverySchema>;
}
export const connectionLossSchema = z.object({
  reason: z.enum([
    "connection_lost",
    "connection_replaced",
    "server_restarted",
    "revoked",
    "heartbeat_expired",
    "send_failed",
    "receive_queue_exceeded",
    "invalid_message",
    "maintenance_failed",
  ]),
  at: z.number(),
  connection_epoch: z.number(),
  heartbeat_age_seconds: z.number(),
  close_code: z.number().int().optional(),
});
export type ConnectionLoss = z.infer<typeof connectionLossSchema>;
export function deviceCapabilities(kind: DeviceKind): readonly Capability[] {
  return kind === "browser" ? ["browser"] : DESKTOP_CAPABILITIES;
}
export const capabilitySchema = z.enum(CAPABILITIES);
export const policyCapabilities = portable(
  z.array(capabilitySchema).max(5),
  ["unique"],
  "Capabilities must be unique",
);
export const devicePermissionSchema = z
  .object({ device_id: z.string().min(1).max(100), capabilities: policyCapabilities })
  .strict();
const uniqueDevices = (value: { device_id: string }[]) =>
  new Set(value.map((item) => item.device_id)).size === value.length;
export const connectionPolicySchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("selected"),
      devices: z
        .array(devicePermissionSchema.extend({ capabilities: policyCapabilities.min(1) }))
        .min(0)
        .max(100)
        .refine(uniqueDevices, "Devices must be unique"),
    })
    .strict(),
  z
    .object({
      mode: z.literal("all"),
      capabilities: policyCapabilities.min(1),
      overrides: z.array(devicePermissionSchema).max(100).refine(uniqueDevices, "Devices must be unique"),
    })
    .strict(),
]);
export type DevicePermission = z.infer<typeof devicePermissionSchema>;
export type ConnectionPolicy = z.infer<typeof connectionPolicySchema>;

export const deviceKindSchema = z.enum(["computer", "browser"]);

const reportedText = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[^\p{Cc}]+$/u)
  .refine((value) => value.isWellFormed())
  .optional();
export const deviceSummaryDetailsSchema = z.object({
  os: z.enum(["macos", "linux", "windows", "chromeos", "android", "openbsd", "fuchsia"]).optional(),
  os_version: reportedText,
  distribution: reportedText,
  architecture: reportedText,
  browser_name: reportedText,
  browser_version: z
    .string()
    .regex(/^\d{1,8}$/)
    .optional(),
});
export const deviceDetailsSchema = deviceSummaryDetailsSchema
  .extend({
    hostname: reportedText,
    model: reportedText,
    runtime_user: reportedText,
    kernel_version: reportedText,
  })
  .strict();
export type DeviceDetails = z.infer<typeof deviceDetailsSchema>;

/** Last successfully reported client metadata; unknown values never imply an operating system. */
export const deviceMetadataSchema = z.object({
  platform: z
    .string()
    .trim()
    .max(80)
    .nullish()
    .transform((value) => value || null),
  version: z
    .string()
    .trim()
    .max(30)
    .nullish()
    .transform((value) => value || null),
  details: deviceDetailsSchema.optional(),
});
export type DeviceMetadata = z.infer<typeof deviceMetadataSchema>;
export const operationStateSchema = z.enum([
  "accepted",
  "dispatched",
  "executed",
  "failed",
  "refused",
  "outcome_unknown",
  "cancelled",
]);
export type OperationState = z.infer<typeof operationStateSchema>;
