import { MAX_IMAGE_BYTES } from "@abridge/protocol";
import { spawn } from "node:child_process";
import type * as SDK from "@trycua/cua-driver";
import { DesktopError, checkAbort } from "./errors.js";
export type AppInfo = { pid: number; name: string; bundle_id?: string; running: boolean; active: boolean };
export type WindowInfo = {
  pid: number;
  window_id: number;
  app_name: string;
  title: string;
  bounds: { x: number; y: number; width: number; height: number };
  is_on_screen: boolean;
  layer?: number;
  z_index?: number;
};
export type Target = { pid: number; window_id: number } | { desktop: true };
export type NativeElement = {
  token?: string;
  role: string;
  label?: string;
  value?: string;
  enabled?: boolean;
  selected?: boolean;
  depth: number;
  actions?: string[];
};
export type NativeObservation = {
  app_name?: string;
  window_title?: string;
  elements: NativeElement[];
  image_base64?: string;
  mime_type?: string;
  width?: number;
  height?: number;
  capture_id?: string;
  truncated?: boolean;
  frame_valid?: boolean;
};
export type NativeAction = {
  action: string;
  target: Target;
  native_ref?: string;
  x?: number;
  y?: number;
  to_x?: number;
  to_y?: number;
  text?: string;
  key?: string;
  modifiers?: string[];
  button?: string;
  delta_x?: number;
  delta_y?: number;
  capture_id?: string;
};
export interface NativeDriver {
  diagnostics(initialize?: boolean): Promise<Record<string, unknown>>;
  apps(signal?: AbortSignal): Promise<AppInfo[]>;
  windows(pid?: number, signal?: AbortSignal): Promise<WindowInfo[]>;
  open(bundleId: string, signal?: AbortSignal): Promise<void>;
  observe(
    sessionId: string,
    target: Target,
    screenshot: boolean,
    signal?: AbortSignal,
  ): Promise<NativeObservation>;
  act(sessionId: string, action: NativeAction, signal?: AbortSignal): Promise<Record<string, unknown>>;
  release(sessionId: string): Promise<void>;
  shutdown(): Promise<void>;
}
function enumName(values: Record<number, string>, value: number): string {
  return values[value].replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
}
function safeId(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new DesktopError("native_contract", "Native identifier exceeds safe integer range");
  return result;
}
function pngSize(data: string | undefined): { width?: number; height?: number } {
  if (!data || data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) return {};
  const bytes = Buffer.from(data, "base64");
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return {};
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : {};
}
export class CuaNativeDriver implements NativeDriver {
  private closed = false;
  private lastDiagnostics: Record<string, unknown> = {
    driver: { loaded: false, ready: false },
    permissions: { checked: false, screen: false, input: false },
  };
  private sdk?: typeof SDK;
  private driver?: SDK.CuaDriverLike;
  private loading?: Promise<void>;
  private sessions = new Map<string, Promise<void>>();
  private async loadSdk(): Promise<typeof SDK> {
    if (process.platform !== "darwin" || process.arch !== "arm64")
      throw new DesktopError("driver_unavailable", "Desktop control requires Apple Silicon macOS");
    return import("@trycua/cua-driver");
  }
  private async ready(): Promise<void> {
    if (this.closed) throw new DesktopError("driver_closed", "Desktop driver has shut down");
    if (this.driver) return;
    if (!this.loading)
      this.loading = (async () => {
        const sdk = await this.loadSdk();
        // Import may finish after shutdown; never construct a new native host then.
        if (this.closed) throw new DesktopError("driver_closed", "Desktop driver has shut down");
        const driver = sdk.CuaDriver.createConfiguredWithAuthorizationHost(
          sdk.ConfiguredDriverOptions.new({
            claudeCodeCompatibility: false,
            authorization: sdk.RuntimeAuthorizationOptions.new({
              allowedModes: [sdk.SessionPermissionMode.Standard],
              compatibilityMode: sdk.SessionPermissionMode.Standard,
              unrestrictedAcknowledged: false,
              maxSessionTtlSeconds: 28800n,
              maxIdleTtlSeconds: 1800n,
            }),
          }),
          {
            async authorize(r) {
              return sdk.DriverAuthorizationDecision.new({
                action: sdk.DriverAuthorizationAction.Deny,
                requestDigest: r.requestDigest,
              });
            },
          },
        );
        if (driver.executionMode() !== sdk.DriverExecutionMode.Embedded || driver.socketPath() !== "") {
          await driver.shutdown();
          throw new DesktopError("driver_mode_invalid", "Desktop driver must run in-process");
        }
        this.sdk = sdk;
        this.driver = driver;
      })().catch((error) => {
        this.loading = undefined;
        throw error;
      });
    await this.loading;
  }
  private async session(id: string, signal?: AbortSignal): Promise<void> {
    await this.ready();
    checkAbort(signal);
    let session = this.sessions.get(id);
    if (!session) {
      session = this.driver!.startSession(this.sdk!.StartSessionInput.new({ session: id }), {
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
      }).then(() => {});
      this.sessions.set(id, session);
      session.catch(() => this.sessions.delete(id));
    }
    await session;
    checkAbort(signal);
  }
  async diagnostics(initialize = true): Promise<Record<string, unknown>> {
    if (!initialize || this.closed) return this.lastDiagnostics;
    try {
      await this.ready();
      const permissions = this.sdk!.currentMacOsPermissionStatus();
      this.lastDiagnostics = {
        driver: {
          installed: true,
          version: "0.47.8",
          loaded: true,
          ready: this.driver!.isAvailable(),
        },
        permissions: {
          checked: true,
          screen: permissions.screenRecording,
          input: permissions.accessibility,
        },
      };
      return this.lastDiagnostics;
    } catch {
      this.lastDiagnostics = {
        driver: { installed: false, ready: false, error: "Desktop driver unavailable" },
        permissions: { checked: false, screen: false, input: false },
      };
      return this.lastDiagnostics;
    }
  }
  async apps(signal?: AbortSignal): Promise<AppInfo[]> {
    await this.ready();
    const result = await this.driver!.listApps(this.sdk!.ListAppsInput.new({}), {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
    });
    return result.apps.map((a) => ({
      pid: a.pid,
      name: a.name,
      bundle_id: a.bundleId,
      running: a.running,
      active: a.active,
    }));
  }
  async windows(pid?: number, signal?: AbortSignal): Promise<WindowInfo[]> {
    await this.ready();
    const result = await this.driver!.listWindows(
      this.sdk!.ListWindowsInput.new({ pid, onScreenOnly: false }),
      {
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
      },
    );
    return result.windows.map((w) => ({
      pid: w.pid ?? 0,
      window_id: safeId(w.windowId),
      app_name: w.appName,
      title: w.title,
      bounds: w.bounds,
      is_on_screen: w.isOnScreen,
      layer: w.layer,
      z_index: w.zIndex === undefined ? undefined : safeId(w.zIndex),
    }));
  }
  async open(bundleId: string, signal?: AbortSignal): Promise<void> {
    checkAbort(signal);
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/open", ["-b", bundleId], {
        stdio: "ignore",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
      });
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new DesktopError("app_launch_failed", "Application launch failed")),
      );
    });
  }
  private target(target: Target): SDK.ActionTarget {
    const sdk = this.sdk!;
    return "desktop" in target
      ? new sdk.ActionTarget.Desktop({ displayId: "primary" })
      : new sdk.ActionTarget.Window({ pid: target.pid, windowId: BigInt(target.window_id) });
  }
  async observe(
    id: string,
    target: Target,
    screenshot: boolean,
    signal?: AbortSignal,
  ): Promise<NativeObservation> {
    await this.session(id, signal);
    const sdk = this.sdk!;
    if ("desktop" in target) {
      if (!screenshot) return { elements: [] };
      const result = await this.driver!.getDesktopState(
        sdk.GetDesktopStateInput.new({ session: id, maxImageDimension: 1920 }),
        {
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
        },
      );
      if (result.isError)
        throw new DesktopError(result.errorCode ?? "observation_failed", "Desktop observation failed");
      const image = result.images[0];
      const data = result.structuredJson ? JSON.parse(result.structuredJson) : {};
      const dimensions = pngSize(image?.dataBase64);
      return {
        elements: [],
        image_base64: image?.dataBase64,
        mime_type: image?.mimeType,
        width: dimensions.width ?? data.screenshot_width ?? data.width,
        height: dimensions.height ?? data.screenshot_height ?? data.height,
        capture_id: typeof data.capture_id === "string" ? data.capture_id : undefined,
      };
    }
    const r = await this.driver!.getWindowState(
      sdk.GetWindowStateInput.new({
        pid: target.pid,
        windowId: BigInt(target.window_id),
        session: id,
        includeScreenshot: screenshot,
        includeAccessibilityTree: true,
        treeFormat: "elements",
        maxElements: 500,
        maxDepth: 12,
        maxImageDimension: 1920,
      }),
      {
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
      },
    );
    return {
      app_name: r.appName,
      window_title: r.windowTitle,
      elements: (r.elements ?? []).map((e) => ({
        token: e.elementToken,
        role: e.role,
        label: e.label,
        value: e.value ?? e.valueDescription,
        depth: e.depth,
        enabled: e.enabled,
        selected: e.selected,
        actions: e.actions,
      })),
      image_base64: r.images[0]?.dataBase64,
      mime_type: r.images[0]?.mimeType,
      width: r.screenshotWidth ?? pngSize(r.images[0]?.dataBase64).width,
      height: r.screenshotHeight ?? pngSize(r.images[0]?.dataBase64).height,

      truncated: r.truncated,
      frame_valid: r.screenshotFrameValid,
    };
  }
  async act(id: string, a: NativeAction, signal?: AbortSignal): Promise<Record<string, unknown>> {
    await this.session(id, signal);
    const sdk = this.sdk!,
      driver = this.driver!,
      target = this.target(a.target),
      opts = {
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
      };
    try {
      return await this.actNative(id, a, sdk, driver, target, opts);
    } catch (error) {
      if (
        sdk.DriverError.Tool.instanceOf(error) &&
        [
          "action_refused",
          "permission_denied",
          "permission_required",
          "accessibility_permission_required",
          "screen_recording_permission_required",
          "invalid_arguments",
          "stale_element",
          "stale_capture",
          "target_not_found",
          "window_not_found",
          "session_not_found",
          "session_closed",
          "unsupported",
        ].includes(error.inner.errorCode)
      )
        throw new DesktopError(error.inner.errorCode, "Desktop driver refused the requested action");
      if (sdk.DriverError.InvalidArguments.instanceOf(error))
        throw new DesktopError("invalid_arguments", "Desktop driver rejected the action arguments");
      throw error;
    }
  }
  private async actNative(
    id: string,
    a: NativeAction,
    sdk: typeof SDK,
    driver: SDK.CuaDriverLike,
    target: SDK.ActionTarget,
    opts: { signal: AbortSignal },
  ): Promise<Record<string, unknown>> {
    let action: SDK.ActionResult | undefined;
    if (
      (a.action === "type" && a.native_ref) ||
      ((a.action === "click" || a.action === "double_click") && a.modifiers?.length)
    ) {
      const tool = a.action === "type" ? "type_text" : "click";
      const shared = {
        session: id,
        target:
          "desktop" in a.target
            ? { kind: "desktop", display_id: "primary" }
            : { kind: "window", pid: a.target.pid, window_id: a.target.window_id },
      };
      const wire =
        a.action === "type"
          ? { ...shared, element_token: a.native_ref, text: a.text }
          : {
              ...shared,
              element_token: a.native_ref,
              x: a.x,
              y: a.y,
              capture_id: a.capture_id,
              modifier: a.modifiers,
              button: a.button,
              count: a.action === "double_click" ? 2 : 1,
              delivery_mode: "foreground",
            };
      const r = await driver.callTool(tool, JSON.stringify(wire), opts);
      if (r.isError)
        throw new DesktopError(r.errorCode ?? "outcome_unknown", "Desktop action could not be confirmed");
      action = r.action;
    } else if (a.action === "click" || a.action === "double_click") {
      const position = a.native_ref
        ? new sdk.ClickPosition.Element({ elementToken: a.native_ref })
        : a.capture_id
          ? new sdk.ClickPosition.CapturedCoordinates({ x: a.x!, y: a.y!, captureId: a.capture_id })
          : new sdk.ClickPosition.Coordinates({ x: a.x!, y: a.y! });
      action = await driver.click(
        sdk.ClickInput.new({
          session: id,
          target,
          position,
          deliveryMode: a.native_ref ? sdk.InputDeliveryMode.Background : sdk.InputDeliveryMode.Foreground,
          button:
            a.button === "right"
              ? sdk.ClickButton.Right
              : a.button === "middle"
                ? sdk.ClickButton.Middle
                : sdk.ClickButton.Left,
          count: a.action === "double_click" ? 2 : 1,
        }),
        opts,
      );
    } else {
      let r: SDK.ToolResult;
      if (a.action === "type")
        r = await driver.typeText(sdk.TypeTextInput.new({ session: id, target, text: a.text! }), opts);
      else if (a.action === "key")
        r = await driver.pressKey(
          sdk.PressKeyInput.new({ session: id, target, key: a.key!, modifiers: a.modifiers }),
          opts,
        );
      else if (a.action === "move")
        r = await driver.moveCursor(sdk.MoveCursorInput.new({ session: id, target, x: a.x!, y: a.y! }), opts);
      else if (a.action === "drag")
        r = await driver.drag(
          sdk.DragInput.new({
            session: id,
            target,
            fromX: a.x!,
            fromY: a.y!,
            toX: a.to_x!,
            toY: a.to_y!,
            modifier: a.modifiers,
          }),
          opts,
        );
      else if (a.action === "scroll") {
        const d = a.delta_y || a.delta_x!;
        r = await driver.scroll(
          sdk.ScrollInput.new({
            session: id,
            target,
            x: a.x!,
            y: a.y!,
            direction: a.delta_y
              ? d < 0
                ? sdk.ScrollDirection.Up
                : sdk.ScrollDirection.Down
              : d < 0
                ? sdk.ScrollDirection.Left
                : sdk.ScrollDirection.Right,
            amount: BigInt(Math.max(1, Math.min(50, Math.round(Math.abs(d) / 40)))),
          }),
          opts,
        );
      } else throw new DesktopError("invalid_arguments", "Unsupported desktop action");
      if (r.isError)
        throw new DesktopError(r.errorCode ?? "outcome_unknown", "Desktop action could not be confirmed");
      action = r.action;
    }
    if (action?.error || action?.effect === sdk.ActionEffect.Refused)
      throw new DesktopError("action_refused", "Desktop action was refused");
    return {
      action_executed: true,
      business_verified: false,
      effect: action ? enumName(sdk.ActionEffect, action.effect) : undefined,
      route: action ? enumName(sdk.ActionRoute, action.route) : undefined,
      delivery: action?.delivery
        ? {
            mode: enumName(sdk.ActionDeliveryMode, action.delivery.mode),
            delivered_count: action.delivery.deliveredCount,
          }
        : undefined,
      summary: action?.summary?.slice(0, 500),
    };
  }
  async release(id: string): Promise<void> {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    if (session) {
      await session.catch(() => {});
      await this.driver?.endSession(this.sdk!.EndSessionInput.new({ session: id }), {
        signal: AbortSignal.timeout(5000),
      });
    }
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    this.lastDiagnostics = {
      ...this.lastDiagnostics,
      driver: { ...(this.lastDiagnostics.driver as Record<string, unknown>), ready: false },
    };
    this.sessions.clear();
    const driver = this.driver;
    this.driver = undefined;
    this.sdk = undefined;
    this.loading = undefined;
    if (driver) {
      try {
        await driver.shutdown({ signal: AbortSignal.timeout(10000) });
      } finally {
        if ("uniffiDestroy" in driver && typeof driver.uniffiDestroy === "function") driver.uniffiDestroy();
      }
    }
  }
}
