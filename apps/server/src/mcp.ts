import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  VERSION,
  MAX_IMAGE_BYTES,
  capabilitySchema,
  computerActionSchema,
  browserActionSchema,
  actWaitAfterSchema,
  type DeviceTool,
} from "@abridge/protocol";
import { ControlService } from "./control.js";
import { commandOutputPage } from "./command-output.js";
import { BridgeError, object, type Grant, type JsonObject } from "./types.js";

const id = z.string().min(1).max(100);
const base = { session_id: id, operation_id: id.optional() };
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"), "Path contains NUL");
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
/** Native MCP images are separate content blocks, never duplicated in JSON text. */
export function contentResponse(value: unknown): { content: (TextContent | ImageContent)[] } {
  const copy = structuredClone(value),
    images: ImageContent[] = [];
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
  }
  return { content: [{ type: "text", text: JSON.stringify(copy) }, ...images] };
}

/** Stateless HTTP requests get isolated MCP transport state; control sessions remain domain state. */
export function createMcpServer(control: ControlService, grant: Grant): McpServer {
  const server = new McpServer({ name: "aBridge", version: VERSION });
  function register<S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown> | unknown,
  ): void {
    server.registerTool(
      name,
      { description: "aBridge: " + description, inputSchema: z.object(shape).strict() },
      async (args) => {
        try {
          return contentResponse(await run(args));
        } catch (error) {
          if (error instanceof BridgeError)
            return {
              ...contentResponse({ error: { code: error.code, message: error.message } }),
              isError: true,
            };
          throw error;
        }
      },
    );
  }
  const exec = (tool: DeviceTool, args: JsonObject): Promise<unknown> => {
    const { session_id, operation_id, ...arguments_ } = args;
    return control.execute(grant, session_id as string, tool, arguments_, operation_id as string | undefined);
  };
  register("devices_list", "List granted devices and currently available capabilities.", {}, () => ({
    connection: control.connectionInfo(grant),
    devices: control.devices(grant),
  }));
  register(
    "device_get",
    "Read one granted device. Offline devices are never substituted.",
    { device_id: id },
    (a) => control.deviceView(control.authorizedDevice(grant, a.device_id), grant),
  );
  register(
    "session_open",
    "Open a capability-scoped session on an explicit online device. Returns the session and device details including name, kind and platform. Close it when finished.",
    { device_id: id, capabilities: z.array(capabilitySchema).min(1).max(5) },
    (a) => {
      const session = control.openSession(grant, a.device_id, a.capabilities);
      return {
        ...session,
        device: control.deviceView(control.authorizedDevice(grant, session.device_id), grant),
      };
    },
  );
  register(
    "session_close",
    "Close a session and its task tab, retaining Profile authorization and personal tabs.",
    { session_id: id },
    (a) => control.closeSession(grant, a.session_id),
  );
  register(
    "computer_apps",
    "Find running apps; query also finds installed apps. Pass a returned bundle_id to computer_open.",
    { ...base, query: z.string().max(200).optional() },
    (a) => exec("computer_apps", a),
  );
  register(
    "computer_windows",
    "List windows for an explicit PID. Observe the returned window before acting.",
    { ...base, pid: z.number().int().positive() },
    (a) => exec("computer_windows", a),
  );
  register(
    "computer_open",
    "Launch or activate an app by exact bundle_id and return its observation. Continue from result.observation; never relaunch to refresh.",
    {
      ...base,
      bundle_id: z
        .string()
        .min(3)
        .max(200)
        .regex(/^[A-Za-z0-9][A-Za-z0-9.-]+$/),
      screenshot: z.boolean().default(false),
    },
    (a) => exec("computer_open", a),
  );
  register(
    "computer_observe",
    "Observe the selected window with native image by default. Observation references last 120s until an action. desktop=true selects the whole desktop.",
    {
      ...base,
      pid: z.number().int().positive().optional(),
      window_id: z.number().int().nonnegative().optional(),
      screenshot: z.boolean().default(true),
      query: z.string().max(200).optional(),
      desktop: z.boolean().default(false),
    },
    (a) => {
      if (a.desktop && (a.pid !== undefined || a.window_id !== undefined))
        throw new BridgeError("invalid_arguments", "Desktop observation cannot select a window", 422);
      return exec("computer_observe", a);
    },
  );
  const after = {
    observe_after: z.boolean().default(true),
    screenshot: z.boolean().default(false),
    wait_after_ms: actWaitAfterSchema.describe(
      "Wait after the action completes before its follow-up observation or screenshot, in milliseconds (default 2000; 0 skips). Ignored when observe_after=false. This is a delay, not an operation timeout.",
    ),
  };
  register(
    "computer_act",
    "Act once on a current desktop observation. Waits 2000ms by default before returning a fresh observation; configure wait_after_ms for the expected UI response time. Unknown or executed actions must never be blindly repeated.",
    {
      ...base,
      observation_id: z.string().regex(/^obs_[a-f0-9]{32}$/),
      action: computerActionSchema,
      ...after,
    },
    (a) => {
      if (a.screenshot && !a.observe_after)
        throw new BridgeError("invalid_arguments", "Screenshot requires observe_after=true", 422);
      return exec("computer_act", a);
    },
  );
  register(
    "browser_open",
    "Navigate this session task tab using the existing Chrome Profile/login and return its observation. Do not reopen to wait for loading.",
    { ...base, url: z.string().min(1).max(8192), screenshot: z.boolean().default(false) },
    (a) => exec("browser_open", { ...a, observe_after: true }),
  );
  register(
    "browser_observe",
    "Refresh the existing task tab. Open and act already return observations; query narrows truncated text. References expire after 10s and actions/navigation.",
    { ...base, screenshot: z.boolean().default(false), query: z.string().max(200).optional() },
    (a) => exec("browser_observe", a),
  );
  register(
    "browser_act",
    "Click or fill a reference from the current DOM observation. Waits 2000ms by default before the follow-up observation; configure wait_after_ms for the expected UI response time. Continue from the returned observation. Observation errors never justify repeating an executed action.",
    { ...base, observation_id: id, action: browserActionSchema, ...after },
    (a) => {
      if (a.screenshot && !a.observe_after)
        throw new BridgeError("invalid_arguments", "Screenshot requires observe_after=true", 422);
      return exec("browser_act", a);
    },
  );
  register(
    "command_execute",
    "Run a user shell command. Short commands return output and exit code directly; wait_seconds defaults to 15s. Yielding does not cancel. Page retained output using next_output_offsets and command_status, never rerun.",
    {
      ...base,
      command: z
        .string()
        .min(1)
        .max(65536)
        .refine((v) => v.trim().length > 0 && !v.includes("\0")),
      cwd: path.optional(),
      env: z
        .record(
          z.string().regex(/^[^=\0]+$/),
          z.string().refine((v) => !v.includes("\0")),
        )
        .optional(),
      timeout: z.number().finite().min(1).max(120).default(30),
      wait_seconds: wait,
      output_limit_chars: outputLimit,
    },
    async (a) => {
      const { wait_seconds, output_limit_chars, session_id, operation_id, ...args } = a;
      const started = await control.execute(grant, session_id, "command_execute", args, operation_id, false);
      return commandOutputPage(
        await control.waitOperation(grant, started.operation_id, wait_seconds),
        output_limit_chars,
      );
    },
  );
  register(
    "command_status",
    "Wait for an existing operation or page retained stdout/stderr, without executing it again. Copy next_output_offsets. Offsets count Unicode characters. Results expire after ten minutes.",
    {
      operation_id: id,
      wait_seconds: wait,
      output_limit_chars: outputLimit,
      stdout_offset: offset,
      stderr_offset: offset,
    },
    async (a) =>
      commandOutputPage(
        await control.waitOperation(grant, a.operation_id, a.wait_seconds),
        a.output_limit_chars,
        a.stdout_offset,
        a.stderr_offset,
      ),
  );
  register(
    "command_cancel",
    "Request cancellation and wait for the terminal receipt. An unknown outcome must be inspected before retrying.",
    { operation_id: id },
    (a) => control.cancelOperation(grant, a.operation_id),
  );
  register(
    "files_list",
    "List directory entries at an explicit path.",
    { ...base, path, limit: z.number().int().min(1).max(500).default(200) },
    (a) => exec("files_list", a),
  );
  register(
    "file_read",
    "Read a UTF-8 file, bounded to one MiB.",
    { ...base, path, max_bytes: z.number().int().min(1).max(1048576).default(1048576) },
    (a) => exec("file_read", a),
  );
  register(
    "file_write",
    "Write a UTF-8 file. Content is bounded to one MiB.",
    {
      ...base,
      path,
      content: z.string().refine((v) => Buffer.byteLength(v, "utf8") <= 1048576, "Content exceeds one MiB"),
      overwrite: z.boolean().default(false),
    },
    (a) => exec("file_write", a),
  );
  return server;
}
