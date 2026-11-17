/** Shared wire contract. Product implementations consume these definitions. */
import { z } from "zod";
import packageInfo from "../../../package.json" with { type: "json" };

export const VERSION = packageInfo.version;
export const deviceRenameSchema = z.object({ name: z.string().trim().min(1).max(120) }).strict();
export const deviceRenameResultSchema = deviceRenameSchema.extend({ id: z.string().min(1) }).strict();
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
export type DesktopFocusStatus = "confirmed" | "unconfirmed";
export const COMPUTER_WINDOW_PID_REQUIRED =
  "pid is required when window_id is provided; call computer_apps to find the application PID";
const invalidComputerPid = "Provide a valid pid from computer_apps or computer_windows";
export const computerPidSchema = z
  .number({ error: invalidComputerPid })
  .int({ error: invalidComputerPid })
  .min(1, { error: invalidComputerPid })
  .max(2147483647, { error: invalidComputerPid });
const invalidComputerWindowId = "Provide a valid window_id returned by computer_windows(pid=...)";
export const computerWindowIdSchema = z
  .number({ error: invalidComputerWindowId })
  .int({ error: invalidComputerWindowId })
  .min(1, { error: invalidComputerWindowId })
  .max(Number.MAX_SAFE_INTEGER, { error: invalidComputerWindowId });
export const DEFAULT_ACT_WAIT_AFTER_MS = 2000;
export const MAX_ACT_WAIT_AFTER_MS = 10000;
export const actWaitAfterSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_ACT_WAIT_AFTER_MS)
  .default(DEFAULT_ACT_WAIT_AFTER_MS);
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
export interface SessionErrorDetails {
  session?: SessionInfo;
  sessions?: SessionInfo[];
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
  browser_read: "browser",
  browser_wait: "browser",
  browser_evaluate: "browser",
  browser_exec: "browser",
  browser_locate_act: "browser",
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
/** Normalize an explicitly selected Server; plaintext consent is bound to its exact origin. */
export function normalizeDeviceServer(value: string, confirmedHttpOrigin?: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("请填写完整的 Server 地址");
  }
  if (url.username || url.password || url.search || url.hash || !["https:", "http:"].includes(url.protocol))
    throw new Error("Server 地址仅支持 HTTP 或 HTTPS，不能包含凭据、查询或片段");
  if (isInsecureDeviceServer(url.href) && confirmedHttpOrigin !== url.origin)
    throw new Error("请先确认此 Server 使用未加密的 HTTP 连接");
  return url.href.replace(/\/$/, "");
}
export function isInsecureDeviceServer(value: string): boolean {
  const url = new URL(value);
  return url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}
export const deviceIdentitySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  kind: deviceKindSchema,
  capabilities: z.array(capabilitySchema),
});
export const deviceBindingInputSchema = z
  .object({
    url: z.string().min(1),
    device_key: z.string().startsWith("abr_device_").max(4096).optional(),
    http_confirmed_origin: z.string().optional(),
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
// Browser diagnostics stay bounded across extension, server and script receipts.
const browserErrorDetailSchema = z.object({ code: z.string().max(100), message: z.string().max(2000) });
export const browserErrorSchema = browserErrorDetailSchema.extend({
  cause: browserErrorDetailSchema.optional(),
  connection: connectionLossSchema.optional(),
  cleanup_error: browserErrorDetailSchema.optional(),
  recovery: z
    .object({
      action: z.enum(["browser_open", "stop"]),
      task_tab: z.enum(["missing", "closed", "cleanup_failed", "cleanup_unconfirmed"]),
    })
    .optional(),
});
// Disconnect diagnostics are server-owned, never accepted from device receipts.
export const deviceErrorSchema = browserErrorSchema.omit({ connection: true });
export type BrowserError = z.infer<typeof browserErrorSchema>;
export const browserStepFailureSchema = z.object({
  operation_id: z.string().min(1).max(100),
  method: z.string().min(1).max(32),
  status: z.enum(["refused", "failed", "outcome_unknown", "cancelled"]),
  error: browserErrorSchema,
});
export type BrowserStepFailure = z.infer<typeof browserStepFailureSchema>;
export const browserQuerySchema = z.union([
  z.string().trim().min(1).max(200),
  z
    .array(z.string().trim().min(1).max(200))
    .min(1)
    .max(20)
    .refine(
      (terms) => terms.reduce((length, term) => length + term.length, 0) <= 2000,
      "Query terms exceed 2000 characters",
    ),
]);
export const browserActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("click"),
      element_ref: elementRefSchema,
      hold_ms: z.number().int().min(0).max(10000).optional(),
    })
    .strict(),
  z.object({ type: z.literal("fill"), element_ref: elementRefSchema, text: z.string().max(60000) }).strict(),
  z.object({ type: z.literal("hover"), element_ref: elementRefSchema }).strict(),
  z
    .object({ type: z.literal("press"), element_ref: elementRefSchema, key: z.string().min(1).max(100) })
    .strict(),
  z
    .object({
      type: z.literal("select"),
      element_ref: elementRefSchema,
      values: z.array(z.string().max(60000)).min(1).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("scroll"),
      element_ref: elementRefSchema,
      delta_x: z.number().finite().min(-10000).max(10000).default(0),
      delta_y: z.number().finite().min(-10000).max(10000),
    })
    .strict(),
]);
export const browserLocateActSchema = z
  .object({
    frame_selector: z.string().min(1).max(2000).optional(),
    selector: z.string().min(1).max(2000),
    action: z.discriminatedUnion("type", [
      browserActionSchema.options[0].omit({ element_ref: true }),
      browserActionSchema.options[1].omit({ element_ref: true }),
      browserActionSchema.options[2].omit({ element_ref: true }),
      browserActionSchema.options[3].omit({ element_ref: true }),
      browserActionSchema.options[4].omit({ element_ref: true }),
      browserActionSchema.options[5].omit({ element_ref: true }),
    ]),
  })
  .strict();
export const browserReadSchema = z
  .object({
    frame_selector: z.string().min(1).max(2000).optional(),
    mode: z.enum(["text", "tables"]).default("text"),
    snapshot_id: z.string().min(1).max(100).optional(),
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
    limit: z.number().int().min(1).max(24000).default(12000),
    selector: z.string().min(1).max(2000).optional(),
  })
  .strict();
export const browserWaitSchema = z
  .object({
    frame_selector: z.string().min(1).max(2000).optional(),
    selector: z.string().min(1).max(2000).optional(),
    text: z.string().min(1).max(2000).optional(),
    state: z.enum(["visible", "hidden", "attached", "detached", "value"]).default("visible"),
    value: z.string().max(60000).optional(),
    timeout_ms: z.number().int().min(0).max(20000).default(10000),
  })
  .strict()
  .refine((a) => Boolean(a.selector) || Boolean(a.text), "Use selector or text")
  .refine(
    (a) => a.state !== "value" || (a.selector !== undefined && a.value !== undefined),
    "Value wait requires selector and value",
  );
export const browserEvaluateSchema = z
  .object({
    frame_selector: z.string().min(1).max(2000).optional(),
    expression: z.string().min(1).max(65536),
    timeout_ms: z.number().int().min(1).max(20000).default(10000),
  })
  .strict();
export const browserExecSchema = z
  .object({
    code: z.string().min(1).max(65536),
    timeout_ms: z.number().int().min(1).max(120000).default(20000),
  })
  .strict();
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
    device_name: deviceRenameSchema.shape.name.optional(),
    connection_epoch: z.number().int().positive(),
    capabilities: z.array(capabilitySchema),
    owner_name: z.string(),
    lease_seconds: z.number().positive(),
    heartbeat_interval: z.number().positive(),
  })
  .passthrough();
