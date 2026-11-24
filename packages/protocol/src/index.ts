import { portable } from "./portable.js";
/** Shared wire contract. Product implementations consume these definitions. */
import { z } from "zod";
import packageInfo from "../../../package.json" with { type: "json" };
import { observationIdSchema, snapshotIdSchema } from "./reference-id.js";
export {
  observationIdSchema,
  snapshotIdSchema,
  createReferenceIdGenerator,
  referenceId,
  operationIdPattern,
} from "./reference-id.js";

import {
  deviceCapabilities,
  capabilitySchema,
  deviceKindSchema,
  connectionLossSchema,
  deviceInteractionStateSchema,
  deviceMetadataSchema,
  deviceRecoverySchema,
  policyCapabilities,
  type Capability,
  type DeviceKind,
} from "./common.js";
export * from "./common.js";

export const VERSION = packageInfo.version;
export const deviceRenameSchema = z
  .object({ name: z.string().trim().min(1).max(120).meta({ "x-trim": true }) })
  .strict();
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
export const DEVICE_KEY_REJECTION = {
  header: "abridge-device-auth",
  value: "invalid_device_key",
} as const;
export const OBSERVATION_SECONDS = 60;
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
export const ANDROID_TOOLS = [
  "computer_observe",
  "computer_act",
  "files_list",
  "file_read",
  "file_write",
] as const satisfies readonly DeviceTool[];
const linuxTools: readonly DeviceTool[] = ["command_execute", "files_list", "file_read", "file_write"];
const deviceTools = Object.keys(TOOL_CAPABILITIES) as DeviceTool[];

export function supportedDeviceTools(kind: DeviceKind, platform?: string | null): readonly DeviceTool[] {
  if (kind === "computer" && platform === "android") return ANDROID_TOOLS;
  if (kind === "computer" && platform === "linux") return linuxTools;
  return deviceTools.filter((tool) => (TOOL_CAPABILITIES[tool] === "browser") === (kind === "browser"));
}
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

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
const clickSchema = portable(
  z
    .object({
      type: z.enum(["click", "double_click"]),
      element_ref: elementRefSchema.optional(),
      x: coordinateSchema.optional(),
      y: coordinateSchema.optional(),
      button: z.enum(["left", "right", "middle"]).default("left"),
      modifiers: z.array(modifierSchema).default([]),
      delivery_mode: z
        .enum(["background", "foreground"])
        .default("background")
        .describe(
          "Use background for element references or window screenshot clicks. Foreground requires screenshot coordinates and verified focus. Modified clicks require foreground.",
        ),
    })
    .strict(),
  [
    "or",
    ["and", ["exists", "element_ref"], ["not", ["exists", "x"]], ["not", ["exists", "y"]]],
    ["and", ["not", ["exists", "element_ref"]], ["exists", "x"], ["exists", "y"]],
  ],
  "Use element_ref or both screenshot coordinates",
);
const longPressSchema = portable(
  z
    .object({
      type: z.literal("long_press"),
      element_ref: elementRefSchema.optional(),
      x: coordinateSchema.optional(),
      y: coordinateSchema.optional(),
    })
    .strict(),
  [
    "or",
    ["and", ["exists", "element_ref"], ["not", ["exists", "x"]], ["not", ["exists", "y"]]],
    ["and", ["not", ["exists", "element_ref"]], ["exists", "x"], ["exists", "y"]],
  ],
  "Use element_ref or both screenshot coordinates",
);
const clickRefsSchema = z
  .object({
    type: z.literal("click_refs"),
    element_refs: portable(
      z.array(elementRefSchema).min(2).max(12),
      ["unique"],
      "Each element must be distinct",
    ),
  })
  .strict();
const typeSchema = z
  .object({
    type: z.literal("type"),
    text: portable(z.string().max(10000), ["noNul"], "Text contains NUL"),
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
const scrollSchema = portable(
  z
    .object({
      type: z.literal("scroll"),
      delta_y: z.number().finite().min(-10000).max(10000),
      delta_x: z.number().finite().min(-10000).max(10000).default(0),
    })
    .strict(),
  [
    "or",
    ["and", ["truthy", "delta_x"], ["not", ["truthy", "delta_y"]]],
    ["and", ["truthy", "delta_y"], ["not", ["truthy", "delta_x"]]],
  ],
  "Scroll requires one nonzero axis",
);
export const computerActionSchema = z.discriminatedUnion("type", [
  clickSchema,
  longPressSchema,
  clickRefsSchema,
  typeSchema,
  keySchema,
  moveSchema,
  dragSchema,
  scrollSchema,
]);
// Operation diagnostics stay bounded across clients, server and script receipts.
const operationErrorDetailSchema = z.object({ code: z.string().max(100), message: z.string().max(2000) });
const desktopWindowDiagnosticSchema = z.object({
  pid: z.number().int().positive(),
  window_id: z.number().int().positive(),
  app_name: z.string().max(120).optional(),
  title: z.string().max(120).optional(),
});
const browserOperationRecoverySchema = z.object({
  action: z.enum(["browser_open", "stop"]),
  task_tab: z.enum(["missing", "closed", "cleanup_failed", "cleanup_unconfirmed"]),
});
export const operationErrorSchema = operationErrorDetailSchema.extend({
  hint: z.string().max(240).optional(),
  desktop: z
    .object({
      target: desktopWindowDiagnosticSchema,
      blocker: desktopWindowDiagnosticSchema.optional(),
      recovery: z.enum(["observe_blocker", "clear_occlusion"]),
    })
    .optional(),
  cause: operationErrorDetailSchema.optional(),
  connection: connectionLossSchema.optional(),
  cleanup_error: operationErrorDetailSchema.optional(),
  recovery: z.union([browserOperationRecoverySchema, deviceRecoverySchema]).optional(),
});
// Disconnect diagnostics and advice to retry device input are generated by the Server.
export const deviceErrorSchema = operationErrorSchema.omit({ connection: true }).extend({
  recovery: browserOperationRecoverySchema.optional(),
});
export type OperationError = z.infer<typeof operationErrorSchema>;
export const browserStepFailureSchema = z.object({
  operation_id: z.string().min(1).max(100),
  method: z.string().min(1).max(32),
  status: z.enum(["refused", "failed", "outcome_unknown", "cancelled"]),
  error: operationErrorSchema,
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
const browserClickSchema = z
  .object({
    type: z.literal("click"),
    element_ref: elementRefSchema,
    hold_ms: z.number().int().min(0).max(10000).optional(),
  })
  .strict();
const browserFillSchema = z
  .object({ type: z.literal("fill"), element_ref: elementRefSchema, text: z.string().max(60000) })
  .strict();
const browserHoverSchema = z.object({ type: z.literal("hover"), element_ref: elementRefSchema }).strict();
const browserPressSchema = z
  .object({ type: z.literal("press"), element_ref: elementRefSchema, key: z.string().min(1).max(32) })
  .strict();
const browserSelectSchema = z
  .object({
    type: z.literal("select"),
    element_ref: elementRefSchema,
    values: z.array(z.string().max(60000)).min(1).max(100),
  })
  .strict();
const browserScrollSchema = z
  .object({
    type: z.literal("scroll"),
    element_ref: elementRefSchema,
    delta_x: z.number().finite().min(-10000).max(10000).default(0),
    delta_y: z.number().finite().min(-10000).max(10000),
  })
  .strict();
export const browserActionSchema = z.discriminatedUnion("type", [
  browserClickSchema,
  browserFillSchema,
  browserHoverSchema,
  browserPressSchema,
  browserSelectSchema,
  browserScrollSchema,
]);
export const browserReadSchema = z
  .object({
    frame_selector: z.string().min(1).max(2000).optional(),
    mode: z
      .enum(["text", "tables"])
      .optional()
      .describe("Defaults to text on a new read, or the saved format when continuing a snapshot."),
    snapshot_id: snapshotIdSchema.optional(),
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
    value: z
      .string()
      .max(60000)
      .optional()
      .describe("Exact field value; requires state=value and a unique selector target."),
    timeout_ms: z.number().int().min(0).max(20000).default(10000),
  })
  .strict()
  .refine((a) => Boolean(a.selector) || Boolean(a.text), "Use selector or text")
  .refine(
    (a) => a.state !== "value" || (a.selector !== undefined && a.value !== undefined),
    "Value wait requires selector and value",
  )
  .refine((a) => a.value === undefined || a.state === "value", "value requires state=value");
export const browserLocateActSchema = z
  .object({
    frame_selector: z.string().min(1).max(2000).optional(),
    selector: z.union([
      z.string().min(1).max(2000),
      z
        .object({
          within: z.string().min(1).max(2000).optional(),
          role: z.string().min(1).max(100),
          name: z.string().max(2000),
        })
        .strict(),
    ]),
    verify: browserWaitSchema.optional(),
    action: z.discriminatedUnion("type", [
      browserClickSchema.omit({ element_ref: true }),
      browserFillSchema.omit({ element_ref: true }),
      browserHoverSchema.omit({ element_ref: true }),
      browserPressSchema.omit({ element_ref: true }),
      browserSelectSchema.omit({ element_ref: true }),
      browserScrollSchema.omit({ element_ref: true }),
    ]),
  })
  .strict();
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

/** Tool arguments are parsed at every untrusted entry using this single contract. */
export const computerAppsSchema = z.object({ query: z.string().max(200).optional() }).strict();
export const computerWindowsSchema = z.object({ pid: computerPidSchema }).strict();
export const computerOpenSchema = z
  .object({
    bundle_id: z
      .string()
      .min(3)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9.-]+$/),
    screenshot: z.boolean().default(false),
  })
  .strict();
export const computerObserveSchema = portable(
  portable(
    z
      .object({
        pid: computerPidSchema
          .optional()
          .describe(
            "macOS application PID. Omit window_id to refresh this session's selected window for that PID or select the application's only window. For a new selection among multiple windows, use computer_windows.",
          ),
        window_id: computerWindowIdSchema
          .optional()
          .describe(
            "Specific window returned by computer_windows; requires pid. Omit to select by pid alone.",
          ),
        screenshot: z.boolean().default(true),
        query: z.string().max(200).optional(),
        desktop: z
          .boolean()
          .default(false)
          .describe(
            "Select the whole desktop instead of a window; cannot be combined with pid or window_id. Capture proceeds even when focus cannot be verified. Desktop actions require confirmed focus; otherwise observe again or select a window using computer_windows.",
          ),
      })
      .strict(),
    [
      "or",
      ["not", ["truthy", "desktop"]],
      ["and", ["not", ["exists", "pid"]], ["not", ["exists", "window_id"]]],
    ],
    "Desktop observation cannot select a window",
  ),
  ["or", ["not", ["exists", "window_id"]], ["exists", "pid"]],
  COMPUTER_WINDOW_PID_REQUIRED,
);
export const actionObservationShape = {
  observe_after: z.boolean().default(true),
  screenshot: z.boolean().default(false),
  wait_after_ms: actWaitAfterSchema.describe(
    "Wait after the action completes before its follow-up observation or screenshot, in milliseconds (default 2000; 0 skips). Ignored when observe_after=false. This is a delay, not an operation timeout.",
  ),
};
const screenshotRequiresObservation = (a: { screenshot: boolean; observe_after: boolean }) =>
  !a.screenshot || a.observe_after;
export const computerActSchema = portable(
  z
    .object({
      observation_id: observationIdSchema,
      action: computerActionSchema,
      ...actionObservationShape,
    })
    .strict(),
  ["or", ["not", ["truthy", "screenshot"]], ["truthy", "observe_after"]],
  "Screenshot requires observe_after=true",
);
export const browserOpenSchema = z
  .object({ url: z.string().min(1).max(8192), screenshot: z.boolean().default(false) })
  .strict();
export const browserObserveSchema = z
  .object({
    screenshot: z.boolean().default(false),
    query: browserQuerySchema.optional(),
    element_offset: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .describe(
        "Skip this many matching controls in a fresh scan, using the same query as the previous page.",
      ),
  })
  .strict();
export const browserActSchema = z
  .object({
    observation_id: observationIdSchema,
    action: browserActionSchema,
    verify: browserWaitSchema
      .optional()
      .describe("After input, wait for this expected page condition and report whether it matched."),
    ...actionObservationShape,
  })
  .strict()
  .refine(screenshotRequiresObservation, "Screenshot requires observe_after=true");
const filePathSchema = portable(
  z.string().min(1).max(4096),
  ["and", ["noNul"], ["unicode"]],
  "Path must be well-formed Unicode without NUL",
);
export const commandExecuteSchema = z
  .object({
    command: portable(
      z.string().min(1).max(65536),
      ["and", ["noNul"], ["nonblank"], ["unicode"]],
      "Command must be nonblank, well-formed Unicode without NUL",
    ),
    cwd: filePathSchema.optional(),
    env: z
      .record(
        portable(
          z.string().regex(/^[^=\u0000]+$/),
          ["unicode"],
          "Environment names must be well-formed Unicode",
        ),
        portable(
          z.string(),
          ["and", ["noNul"], ["unicode"]],
          "Environment values must be well-formed Unicode without NUL",
        ),
      )
      .optional(),
    timeout: z.number().finite().min(1).max(120).default(30),
  })
  .strict();
export const filesListSchema = z
  .object({ path: filePathSchema, limit: z.number().int().min(1).max(500).default(200) })
  .strict();
export const fileReadSchema = z
  .object({ path: filePathSchema, max_bytes: z.number().int().min(1).max(1048576).default(1048576) })
  .strict();
export const fileWriteSchema = z
  .object({
    path: filePathSchema,
    content: portable(
      z.string(),
      ["and", ["unicode"], ["utf8Max", 1048576]],
      "Content must be well-formed Unicode within one MiB",
    ),
    overwrite: z.boolean().default(false),
  })
  .strict();
export const toolArgumentSchemas = {
  computer_apps: computerAppsSchema,
  computer_windows: computerWindowsSchema,
  computer_open: computerOpenSchema,
  computer_observe: computerObserveSchema,
  computer_act: computerActSchema,
  browser_open: browserOpenSchema,
  browser_observe: browserObserveSchema,
  browser_act: browserActSchema,
  browser_read: browserReadSchema,
  browser_wait: browserWaitSchema,
  browser_evaluate: browserEvaluateSchema,
  browser_exec: browserExecSchema,
  browser_locate_act: browserLocateActSchema,
  command_execute: commandExecuteSchema,
  files_list: filesListSchema,
  file_read: fileReadSchema,
  file_write: fileWriteSchema,
} satisfies Record<DeviceTool, z.ZodType>;
export type DeviceToolArguments<T extends DeviceTool> = z.output<(typeof toolArgumentSchemas)[T]>;
export type DeviceToolInput<T extends DeviceTool> = z.input<(typeof toolArgumentSchemas)[T]>;
const toolRequest = <T extends DeviceTool>(tool: T) =>
  z.object({ tool: z.literal(tool), arguments: toolArgumentSchemas[tool] }).strict();
export const deviceToolRequestSchema = z.discriminatedUnion("tool", [
  toolRequest("computer_apps"),
  toolRequest("computer_windows"),
  toolRequest("computer_open"),
  toolRequest("computer_observe"),
  toolRequest("computer_act"),
  toolRequest("browser_open"),
  toolRequest("browser_observe"),
  toolRequest("browser_act"),
  toolRequest("browser_read"),
  toolRequest("browser_wait"),
  toolRequest("browser_evaluate"),
  toolRequest("browser_exec"),
  toolRequest("browser_locate_act"),
  toolRequest("command_execute"),
  toolRequest("files_list"),
  toolRequest("file_read"),
  toolRequest("file_write"),
]);
export type DeviceToolRequest = z.infer<typeof deviceToolRequestSchema>;
export function parseDeviceToolRequest(value: unknown): DeviceToolRequest {
  return deviceToolRequestSchema.parse(value);
}

export const deviceDispatchEnvelopeSchema = z
  .object({
    type: z.literal("dispatch"),
    protocol: z.literal(PROTOCOL_VERSION),
    device_id: z.string().min(1),
    connection_epoch: z.number().int().positive(),
    sequence: z.number().int().positive(),
    device_credential_version: z.number().int().positive(),
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
export const deviceCancelSchema = z.object({
  type: z.literal("cancel"),
  connection_epoch: z.number().int().positive(),
  operation_ids: z.array(z.string().min(1)),
  caller_operation_id: z.string().min(1).optional(),
  reason: z.string().optional(),
});
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
    interaction_state: deviceInteractionStateSchema.optional(),
    ...deviceMetadataSchema.shape,
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
    server_time: z.number().positive().optional(),
  })
  .passthrough();

export * from "./management.js";

export { windowsShellRequestSchema, type WindowsShellRequest } from "./windows-shell.js";
export type DesktopAccessibilityLimit = "time_budget";

export { windowsComputerActionSchema, type WindowsComputerAction } from "./windows-computer.js";
