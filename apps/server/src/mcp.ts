import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  VERSION,
  MAX_IMAGE_BYTES,
  capabilitySchema,
  computerAppsSchema,
  computerWindowsSchema,
  computerOpenSchema,
  computerObserveSchema,
  computerActSchema,
  browserOpenSchema,
  browserObserveSchema,
  browserActSchema,
  browserReadSchema,
  browserWaitSchema,
  browserExecSchema,
  commandExecuteSchema,
  filesListSchema,
  fileReadSchema,
  fileWriteSchema,
  type DeviceTool,
} from "@abridge/protocol";
import { ControlService } from "./control.js";
import { commandOutputPage } from "./command-output.js";
import { BridgeError, object, type AgentConnection, type JsonObject } from "./types.js";

const id = z.string().min(1).max(100);
const base = {
  session_id: id.describe("Copy the session ID exactly from session_open or device_get.sessions."),
  operation_id: id
    .optional()
    .describe(
      "Usually omit for a new operation. Returned IDs are op_ plus 8 Base64URL characters; reserve this format for server IDs. For retrying the same request in the same session, reuse the original key or returned operation_id. Keys are scoped to the session; query/cancel with the returned operation_id. Never replay an unknown side effect in a new session.",
    ),
};
const wait = z.number().finite().min(0).max(30).default(15);
const outputLimit = z.number().int().min(1024).max(12000).default(6000);
const offset = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0);
interface TextContent {
  type: "text";
  text: string;
}
interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}
function prioritize(container: JsonObject, keys: readonly string[]): JsonObject {
  const ordered: JsonObject = {};
  for (const key of keys) {
    if (Object.hasOwn(container, key)) ordered[key] = container[key];
  }
  return { ...ordered, ...container };
}

const desktopObservationFields = [
  "observation_id",
  "available_actions",
  "keyboard_focus",
  "hint",
  "window",
  "app_name",
  "window_title",
  "desktop",
  "focus_status",
  "pixel_actions",
  "coordinate_space",
  "geometry",
] as const;

/** Native MCP images are separate content blocks, never duplicated in JSON text. */
export function contentResponse(
  value: unknown,
  desktop = false,
): { content: (TextContent | ImageContent)[] } {
  let copy = structuredClone(value);
  const images: ImageContent[] = [];
  const extract = (container: JsonObject): void => {
    if (typeof container.image_base64 !== "string") return;
    const data = container.image_base64;
    delete container.image_base64;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || Buffer.byteLength(data, "base64") > MAX_IMAGE_BYTES)
      throw new BridgeError("invalid_image", "Device image is invalid or exceeds the limit", 422);
    images.push({
      type: "image",
      data,
      mimeType: typeof container.mime_type === "string" ? container.mime_type : "image/png",
    });
  };
  if (object(copy) && object(copy.result)) {
    extract(copy.result);
    if (object(copy.result.observation)) extract(copy.result.observation);
    desktop ||=
      Array.isArray(copy.result.available_actions) ||
      (object(copy.result.observation) && Array.isArray(copy.result.observation.available_actions));
  }
  if (desktop && object(copy)) {
    if (object(copy.result)) {
      if (object(copy.result.observation))
        copy.result.observation = prioritize(copy.result.observation, desktopObservationFields);
      copy.result = prioritize(copy.result, [
        ...desktopObservationFields,
        "observation_error",
        "window_candidates",
        "effect",
        "delivery",
        "observation",
      ]);
    }
    if (object(copy.error)) copy.error = prioritize(copy.error, ["code", "hint", "desktop", "message"]);
    copy = prioritize(copy, ["status", "error", "operation_id", "result"]);
  }
  return { content: [{ type: "text", text: JSON.stringify(copy) }, ...images] };
}

/** Stateless HTTP requests get isolated MCP transport state; control sessions remain domain state. */
export function createMcpServer(control: ControlService, agentConnection: AgentConnection): McpServer {
  const server = new McpServer({ name: "aBridge", version: VERSION });
  function register<S extends z.ZodRawShape>(
    name: string,
    description: string,
    schema: z.ZodObject<S>,
    run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown> | unknown,
  ): void {
    const desktop = name.startsWith("computer_");
    server.registerTool(
      name,
      { description: "aBridge: " + description, inputSchema: z.object(schema.shape).strict() },
      async (args) => {
        try {
          // Cross-field contract errors use the same structured result as domain refusals.
          // MCP still exposes the shared fields, defaults and scalar bounds.
          const parsed = schema.safeParse(args);
          if (!parsed.success)
            throw new BridgeError("invalid_arguments", parsed.error.issues[0]!.message, 422);
          const value = await run(parsed.data),
            response = contentResponse(value, desktop);
          if (
            object(value) &&
            (value.status === "failed" || value.status === "refused" || value.status === "outcome_unknown")
          )
            return { ...response, isError: true };
          return response;
        } catch (error) {
          if (error instanceof BridgeError)
            return {
              ...contentResponse(
                { error: { code: error.code, message: error.message, ...error.details } },
                desktop,
              ),
              isError: true,
            };
          throw error;
        }
      },
    );
  }
  const exec = (
    tool: DeviceTool,
    args: { session_id: string; operation_id?: string } & JsonObject,
  ): Promise<unknown> => {
    const { session_id, operation_id, ...arguments_ } = args;
    return control.execute(agentConnection, session_id, tool, arguments_, operation_id);
  };
  register(
    "devices_list",
    "List granted devices, available capabilities and your active sessions. Discovery does not renew sessions.",
    z.object({}).strict(),
    () => ({
      connection: control.connectionInfo(agentConnection),
      devices: control.devices(agentConnection),
    }),
  );
  register(
    "device_get",
    "Read one granted device, its reported system details, and your active sessions. Reuse a listed session or explicitly close it to release input; discovery does not renew leases.",
    z.object({ device_id: id }).strict(),
    (a) => control.deviceView(control.authorizedDevice(agentConnection, a.device_id), agentConnection, true),
  );
  register(
    "session_open",
    "Open a capability-scoped session on an explicit online device. Returns the session and device details including name, kind and platform. Idle lease is 300 seconds, renewed by authorized operations and result queries. Read current session metadata in responses, not the initial deadline. On desktop_busy inspect device_get.sessions. Close it when finished.",
    z.object({ device_id: id, capabilities: z.array(capabilitySchema).min(1).max(5) }).strict(),
    (a) => {
      const session = control.openSession(agentConnection, a.device_id, a.capabilities);
      return {
        ...session,
        server_time: control.sessionInfo(session).server_time,
        device: control.deviceView(
          control.authorizedDevice(agentConnection, session.device_id),
          agentConnection,
        ),
      };
    },
  );
  register(
    "session_close",
    "Close a session and its task tab, retaining Profile authorization and personal tabs.",
    z.object({ session_id: id }).strict(),
    (a) => control.closeSession(agentConnection, a.session_id),
  );
  register(
    "computer_apps",
    "Find running apps; query also finds installed apps. Pass a returned bundle_id to computer_open.",
    computerAppsSchema.safeExtend(base),
    (a) => exec("computer_apps", a),
  );
  register(
    "computer_windows",
    "List windows for an explicit PID. Observe the returned window before acting.",
    computerWindowsSchema.safeExtend(base),
    (a) => exec("computer_windows", a),
  );
  register(
    "computer_open",
    "Launch or activate an app by exact bundle_id. Continue from result.observation, or select a returned window_candidate with computer_observe. Never relaunch to refresh.",
    computerOpenSchema.safeExtend(base),
    (a) => exec("computer_open", a),
  );
  register(
    "computer_observe",
    "On macOS, omit pid and window_id or pass the selected window's pid alone to refresh it. For a new target, pass pid for an app with one window or choose pid and window_id from computer_windows. Android observes the screen with desktop=true. Read observation_id, available_actions, keyboard_focus, and hint first. References expire after 120 seconds or an action. Use desktop=true only for an explicit whole-desktop task; without confirmed focus it returns a read-only observation.",
    computerObserveSchema.safeExtend(base),
    (a) => exec("computer_observe", a),
  );
  register(
    "computer_act",
    "Act once using the current observation_id and available_actions. After a delay, refresh the target first: observations last at most 120 seconds and screenshot captures can expire sooner. Prefer a supported element_ref action. Window screenshot clicks default to background. Use explicit action.delivery_mode=foreground for a screenshot click only when the intended target has verified focus; whole-desktop and modified clicks require it. A covering window can be reported in error.desktop. If the action returns unverifiable or unknown, verify the expected change before continuing. Use result.observation directly, including any new window target. Set screenshot=true for visual follow-up. wait_after_ms defaults to 2000.",
    computerActSchema.safeExtend(base),
    (a) => exec("computer_act", a),
  );
  register(
    "browser_open",
    "Navigate the current task tab using the existing Profile/login and return its observation. To visit a link whose URL was observed, navigate to that URL here. Do not reopen to wait for loading.",
    browserOpenSchema.safeExtend(base),
    (a) => exec("browser_open", a),
  );
  register(
    "browser_observe",
    "Refresh the current task tab. query is one case-insensitive substring or an array matching any substring in scanned loaded text/controls; zero matches do not establish that the page has no content. Link target is the declared attribute, not evidence of an opened tab. References expire after 60s and actions/navigation.",
    browserObserveSchema.safeExtend(base),
    (a) => exec("browser_observe", a),
  );
  register(
    "browser_act",
    "Click, fill, press, select, hover or scroll a reference from the current task page observation. Native pointer actions already scroll and check the target. Scroll changes DOM offsets and reports actual delta; it does not dispatch wheel events. A successful click is not navigation confirmation; links may open another tab, which is not automatically adopted. For a native long press use click with hold_ms (0-10000); omitted means a normal click. Waits 2000ms by default before the follow-up observation; configure wait_after_ms for the expected UI response time. Continue from the returned observation. Observation errors never justify repeating an executed action.",
    browserActSchema.safeExtend(base),
    (a) => exec("browser_act", a),
  );
  register(
    "browser_read",
    "Read current page text or loaded table rows, or page a saved snapshot without capturing again. Offsets count text characters or table rows. Read coverage and truncation before drawing conclusions.",
    browserReadSchema.safeExtend(base),
    (a) => exec("browser_read", a),
  );
  register(
    "browser_wait",
    "Wait for a selector or page text condition in the existing task tab. This is read-only; a timeout never justifies repeating an executed action.",
    browserWaitSchema.safeExtend(base),
    (a) => exec("browser_wait", a),
  );
  register(
    "browser_exec",
    "Run an async JavaScript function body for batch actions or custom extraction; use await and return a JSON value. page always addresses the current task tab; a clicked link's new tab is not automatically adopted. Native locator actions already scroll and check their target. Available: page.goto(url), page.observe(options), page.locator(css).click({hold_ms:1500})/fill(text)/press(key)/select(values)/hover()/scroll(deltaY,deltaX), page.read({selector,mode: text or tables,snapshot_id,offset,limit}), page.wait({selector,text,state,timeout_ms}), page.evaluate(functionOrExpression,arg), and page.frameLocator(css) for a single same-origin iframe. IMPORTANT: window/document exist ONLY inside page.evaluate, e.g. return await page.evaluate(() => document.title). This code runs in isolated QuickJS, not in the page or Node. No setTimeout/setInterval in this outer runtime: prefer page.wait or locator.waitFor for conditions; use await page.sleep(ms) for a cancellable 0-10000 ms delay. click() is a normal native click; click({hold_ms:1500}) holds the native mouse button before release. DOM dispatchEvent is synthetic input, not a native gesture. An unsupported tool gesture does not prove the website lacks that gesture. Only JSON state persists across calls; local variables/functions do not. Await every browser call. Stable operation_id recovers without replay. After yielding use operation_status for that same operation; operation_cancel stops it. Failed code may have completed steps: inspect the page and steps_completed before continuing, never replay the whole batch blindly. Session close clears state.",
    browserExecSchema.safeExtend({ ...base, wait_seconds: wait }),
    async (a) => {
      const { session_id, operation_id, wait_seconds, ...args } = a;
      const started = await control.execute(
        agentConnection,
        session_id,
        "browser_exec",
        args,
        operation_id,
        false,
      );
      return control.waitOperation(agentConnection, started.operation_id, wait_seconds);
    },
  );
  register(
    "command_execute",
    "Run a user shell command. Short commands return output and exit code directly; wait_seconds defaults to 15s. Yielding does not cancel. Page retained output using next_output_offsets and operation_status, never rerun.",
    commandExecuteSchema.safeExtend({ ...base, wait_seconds: wait, output_limit_chars: outputLimit }),
    async (a) => {
      const { wait_seconds, output_limit_chars, session_id, operation_id, ...args } = a;
      const started = await control.execute(
        agentConnection,
        session_id,
        "command_execute",
        args,
        operation_id,
        false,
      );
      return commandOutputPage(
        await control.waitOperation(agentConnection, started.operation_id, wait_seconds),
        output_limit_chars,
      );
    },
  );
  register(
    "operation_status",
    "Wait for an existing operation or page retained stdout/stderr, without executing it again. Copy next_output_offsets. Offsets count Unicode characters. Results expire after ten minutes.",
    z
      .object({
        operation_id: id,
        wait_seconds: wait,
        output_limit_chars: outputLimit,
        stdout_offset: offset,
        stderr_offset: offset,
      })
      .strict(),
    async (a) =>
      commandOutputPage(
        await control.waitOperation(agentConnection, a.operation_id, a.wait_seconds),
        a.output_limit_chars,
        a.stdout_offset,
        a.stderr_offset,
      ),
  );
  register(
    "operation_cancel",
    "Request cancellation and wait for the terminal receipt. An unknown outcome must be inspected before retrying.",
    z.object({ operation_id: id }).strict(),
    (a) => control.cancelOperation(agentConnection, a.operation_id),
  );
  register(
    "files_list",
    "List directory entries on the device. macOS and Linux expand ~/ to the device user's home (e.g. ~/Downloads). Android uses /workspace for its granted directory.",
    filesListSchema.safeExtend(base),
    (a) => exec("files_list", a),
  );
  register("file_read", "Read a UTF-8 file, bounded to one MiB.", fileReadSchema.safeExtend(base), (a) =>
    exec("file_read", a),
  );
  register(
    "file_write",
    "Write a UTF-8 file. Content is bounded to one MiB.",
    fileWriteSchema.safeExtend(base),
    (a) => exec("file_write", a),
  );
  return server;
}
