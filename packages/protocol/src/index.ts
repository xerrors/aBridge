/** Shared wire contract. Product implementations consume these definitions. */
import { z } from "zod";
import packageInfo from "../../../package.json" with { type: "json" };

export const VERSION = packageInfo.version;
export const adminSessionSchema = z.object({ admin: z.literal(true) }).strict();
export const adminCreateUserSchema = z
  .object({ username: z.string().trim().min(1).max(80), password: z.string().min(12).max(1024) })
  .strict();
export const adminOverviewSchema = z.object({
  totals: z.object({
    users: z.number().int().nonnegative(),
    devices: z.number().int().nonnegative(),
    online_devices: z.number().int().nonnegative(),
    computers: z.number().int().nonnegative(),
    browsers: z.number().int().nonnegative(),
  }),
  users: z.array(
    z.object({
      id: z.string(),
      username: z.string(),
      created_at: z.number(),
      computer_count: z.number().int().nonnegative(),
      browser_count: z.number().int().nonnegative(),
      online_count: z.number().int().nonnegative(),
      devices: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          kind: z.enum(["computer", "browser"]),
          status: z.enum(["online", "offline"]),
          paused: z.boolean(),
          last_seen: z.number().nullable(),
          created_at: z.number(),
        }),
      ),
    }),
  ),
});
export type AdminOverview = z.infer<typeof adminOverviewSchema>;
export const PROTOCOL_VERSION = "abridge/1";
export const CAPABILITIES = ["screen", "input", "shell", "files", "browser"] as const;
export type Capability = (typeof CAPABILITIES)[number];
export type DeviceKind = "computer" | "browser";
export const DESKTOP_CAPABILITIES = ["screen", "input", "shell", "files"] as const;
export const OBSERVATION_SECONDS = 10;
export const DESKTOP_OBSERVATION_SECONDS = 120;
export const DEFAULT_ACT_WAIT_AFTER_MS = 2000;
export const MAX_ACT_WAIT_AFTER_MS = 10000;
export const actWaitAfterSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_ACT_WAIT_AFTER_MS)
  .default(DEFAULT_ACT_WAIT_AFTER_MS);
export const SESSION_IDLE_SECONDS = 300;
export const DEVICE_LEASE_SECONDS = 30;
export const CONNECTION_LEASE_SECONDS = DEVICE_LEASE_SECONDS;
export const OPERATION_START_SECONDS = 30;
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
export const WS_MESSAGE_BYTES = MAX_MESSAGE_BYTES;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_DEVICE_OPERATIONS = 8;
export const RESULT_RETENTION_SECONDS = 600;
export const TOOL_CAPABILITIES = {
  computer_apps: "screen",
  computer_windows: "screen",
  computer_observe: "screen",
  computer_open: "input",
  computer_act: "input",
  browser_open: "browser",
  browser_observe: "browser",
  browser_act: "browser",
  command_execute: "shell",
  files_list: "files",
  file_read: "files",
  file_write: "files",
} as const satisfies Record<string, Capability>;
export type DeviceTool = keyof typeof TOOL_CAPABILITIES;
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export function deviceCapabilities(kind: DeviceKind): readonly Capability[] {
  return kind === "browser" ? ["browser"] : DESKTOP_CAPABILITIES;
}
export function requiredCapabilities(tool: DeviceTool, args: Record<string, unknown>): Set<Capability> {
  const required = new Set<Capability>([TOOL_CAPABILITIES[tool]]);
  if (
    tool === "computer_open" ||
    (tool === "computer_act" && (args.observe_after !== false || args.screenshot === true))
  ) {
    required.add("screen");
  }
  return required;
}
export const capabilitySchema = z.enum(CAPABILITIES);
const policyCapabilities = z
  .array(capabilitySchema)
  .max(5)
  .refine((value) => new Set(value).size === value.length, "Capabilities must be unique");
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
        .min(1)
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

export const DESKTOP_AUTH_CALLBACK_PATH = "/abridge/callback";
export const BROWSER_AUTH_CALLBACK_PATH = "/abridge-authorize";
const authorizationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);
const authorizationVerifierSchema = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/);
const authorizationRedirectSchema = z.string().max(2048).url();
export const deviceAuthorizationRequestSchema = z
  .object({
    kind: deviceKindSchema,
    name: z.string().trim().min(1).max(80),
    capabilities: policyCapabilities.min(1),
    redirect_uri: authorizationRedirectSchema,
    code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    code_challenge_method: z.literal("S256"),
    state: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/),
  })
  .strict()
  .refine(
    (value) => value.capabilities.every((cap) => deviceCapabilities(value.kind).includes(cap)),
    "Capabilities do not match device kind",
  );
export type DeviceAuthorizationRequest = z.infer<typeof deviceAuthorizationRequestSchema>;
export const deviceAuthorizationStartSchema = z
  .object({
    id: authorizationIdSchema,
    authorization_url: authorizationRedirectSchema,
    expires_at: z.number(),
  })
  .strict();
export const deviceAuthorizationViewSchema = z
  .object({
    id: authorizationIdSchema,
    kind: deviceKindSchema,
    name: z.string(),
    capabilities: policyCapabilities.min(1),
    expires_at: z.number(),
    status: z.enum(["pending", "approved", "denied", "consumed", "cancelled"]),
  })
  .strict();
export const deviceAuthorizationDecisionSchema = z
  .object({ approve: z.boolean(), expected_user_id: z.string().min(1).max(100) })
  .strict();
export const deviceAuthorizationDecisionResultSchema = z
  .object({ redirect_url: authorizationRedirectSchema })
  .strict();
export const deviceAuthorizationTokenRequestSchema = z
  .object({
    code: authorizationIdSchema,
    code_verifier: authorizationVerifierSchema,
    redirect_uri: authorizationRedirectSchema,
  })
  .strict();
export const deviceAuthorizationCancelSchema = z
  .object({ code_verifier: authorizationVerifierSchema })
  .strict();
export const deviceAuthorizationTokenSchema = z
  .object({
    device_id: z.string().min(1),
    key: z.string().startsWith("abr_device_").max(4096),
    name: z.string(),
    kind: deviceKindSchema,
    capabilities: policyCapabilities.min(1),
  })
  .strict();
const modifierSchema = z.enum(["cmd", "command", "ctrl", "control", "alt", "option", "shift", "fn"]);
const coordinateSchema = z.number().finite().nonnegative();
const elementRefSchema = z.string().min(1).max(100);
const clickSchema = z
  .object({
    type: z.enum(["click", "double_click"]),
    element_ref: elementRefSchema.optional(),
    x: coordinateSchema.optional(),
    y: coordinateSchema.optional(),
    button: z.enum(["left", "right", "middle"]).default("left"),
    modifiers: z.array(modifierSchema).default([]),
  })
  .strict()
  .refine(
    (a) =>
      a.element_ref !== undefined
        ? a.x === undefined && a.y === undefined
        : a.x !== undefined && a.y !== undefined,
    "Use element_ref or both screenshot coordinates",
  );
const typeSchema = z
  .object({
    type: z.literal("type"),
    text: z.string().max(10000),
    element_ref: elementRefSchema.optional(),
  })
  .strict();
const keySchema = z
  .object({
    type: z.literal("key"),
    key: z.string().min(1).max(100),
    modifiers: z.array(modifierSchema).default([]),
  })
  .strict();
const moveSchema = z.object({ type: z.literal("move"), x: coordinateSchema, y: coordinateSchema }).strict();
const dragSchema = z
  .object({
    type: z.literal("drag"),
    x: coordinateSchema,
    y: coordinateSchema,
    to_x: coordinateSchema,
    to_y: coordinateSchema,
  })
  .strict();
const scrollSchema = z
  .object({
    type: z.literal("scroll"),
    delta_y: z.number().finite().min(-10000).max(10000),
    delta_x: z.number().finite().min(-10000).max(10000).default(0),
  })
  .strict()
  .refine((a) => Boolean(a.delta_x) !== Boolean(a.delta_y), "Scroll requires one nonzero axis");
export const computerActionSchema = z.discriminatedUnion("type", [
  clickSchema,
  typeSchema,
  keySchema,
  moveSchema,
  dragSchema,
  scrollSchema,
]);
export const browserActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), element_ref: elementRefSchema }).strict(),
  z.object({ type: z.literal("fill"), element_ref: elementRefSchema, text: z.string().max(60000) }).strict(),
]);
export type ComputerAction = z.infer<typeof computerActionSchema>;
export type BrowserAction = z.infer<typeof browserActionSchema>;

export const deviceDispatchEnvelopeSchema = z
  .object({
    type: z.literal("dispatch"),
    protocol: z.literal(PROTOCOL_VERSION),
    device_id: z.string().min(1),
    connection_epoch: z.number().int().positive(),
    sequence: z.number().int().positive(),
    grant_version: z.number().int().positive(),
    session_capabilities: z.array(capabilitySchema),
    client_name: z.string().optional(),
    operation_id: z.string().min(1),
    session_id: z.string().min(1),
    tool: z.string(),
    arguments: z.record(z.string(), z.unknown()),
    expires_at: z.number().finite(),
  })
  .passthrough();
export type DeviceDispatchEnvelope = z.infer<typeof deviceDispatchEnvelopeSchema>;
export const operationFrameSchema = deviceDispatchEnvelopeSchema.extend({
  tool: z.enum(Object.keys(TOOL_CAPABILITIES) as [DeviceTool, ...DeviceTool[]]),
});
export type OperationFrame = z.infer<typeof operationFrameSchema>;
export const epochSchema = z.number().int().nonnegative();

/** Shared device envelopes; consumers validate capability-specific tool admission. */
export const HEARTBEAT_SECONDS = 10;
export const OPERATION_START_GRACE_SECONDS = 5;
export const OPERATION_JOURNAL_LIMIT = 10000;
export const BROWSER_MAX_ELEMENTS = 200;
export const BROWSER_MAX_TEXT = 60000;
export const deviceHelloSchema = z
  .object({
    type: z.literal("hello"),
    protocol: z.literal(PROTOCOL_VERSION),
    capabilities: z.record(z.string(), z.boolean()),
    paused: z.boolean(),
    platform: z.string(),
    version: z.string(),
  })
  .passthrough();
export const browserHelloSchema = deviceHelloSchema.extend({
  device_key: z.string().min(1),
  instance_id: z.string().min(1),
});
export const deviceWelcomeSchema = z
  .object({
    type: z.literal("welcome"),
    protocol: z.literal(PROTOCOL_VERSION),
    device_id: z.string().min(1),
    connection_epoch: z.number().int().positive(),
    capabilities: z.array(capabilitySchema),
    owner_name: z.string(),
    lease_seconds: z.number().positive(),
    heartbeat_interval: z.number().positive(),
  })
  .passthrough();
